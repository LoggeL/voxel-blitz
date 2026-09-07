#!/usr/bin/env python3
"""Generate a menu-music candidate using Google Lyria 3.5.

Dry runs do not read credentials or contact Google. Each live invocation makes
at most one POST, and an interrupted or failed attempt requires manual review.
API reference: https://ai.google.dev/gemini-api/docs/music-generation
"""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
MODEL = 'lyria-3.5'
IMAGE_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
               '.webp': 'image/webp'}
AUDIO_TYPES = {'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav',
               'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/ogg': '.ogg',
               'audio/mp4': '.m4a'}


class GenerationError(Exception):
    """An operator-safe error without response bodies or credentials."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_receipt(path, receipt, create=False):
    serialized = json.dumps(receipt, indent=2, ensure_ascii=False) + '\n'
    if create:
        # Exclusive creation also prevents two processes from paying for the
        # same candidate when both passed the initial existence check.
        with path.open('x', encoding='utf-8') as handle:
            handle.write(serialized)
        return
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(serialized, encoding='utf-8')
    temporary.replace(path)


def read_key(args):
    if args.key_file:
        key = args.key_file.read_text(encoding='utf-8').strip()
    elif args.keychain_service:
        command = ['security', 'find-generic-password', '-s', args.keychain_service]
        if args.keychain_account:
            command += ['-a', args.keychain_account]
        result = subprocess.run(command + ['-w'], capture_output=True, text=True,
                                timeout=30, check=False)
        if result.returncode:
            raise GenerationError('Could not read the configured Keychain item.')
        key = result.stdout.strip()
    else:
        key = (os.environ.get('GEMINI_API_KEY', '').strip()
               or os.environ.get('GOOGLE_API_KEY', '').strip())
    if not key:
        raise GenerationError('No API key found in the selected source or supported environment variables.')
    if '\n' in key or '\r' in key:
        raise GenerationError('The selected credential contains multiple lines.')
    return key


def request_data(args):
    prompt = args.prompt_file.read_text(encoding='utf-8').strip()
    if not prompt:
        raise GenerationError('The prompt file is empty.')
    metadata = {'endpoint': ENDPOINT, 'model': MODEL, 'prompt': prompt}
    body = {'model': MODEL, 'input': prompt}
    if args.image:
        image_path = args.image.resolve()
        mime_type = IMAGE_TYPES.get(image_path.suffix.lower())
        if not mime_type:
            raise GenerationError('The image must be PNG, JPEG, or WebP.')
        image_data = image_path.read_bytes()
        if not image_data:
            raise GenerationError('The image file is empty.')
        metadata['image'] = {'path': str(image_path), 'sha256': digest(image_data),
                             'mime_type': mime_type}
        body['input'] = [{'type': 'text', 'text': prompt},
                         {'type': 'image', 'mime_type': mime_type,
                          'data': base64.b64encode(image_data).decode('ascii')}]
    return metadata, body


def already_complete(output, receipt_path, metadata):
    if not receipt_path.exists():
        if output.exists() and (list(output.glob('audio-*')) or (output / 'composition.txt').exists()):
            raise GenerationError('Existing output files have no receipt; refusing to overwrite them.')
        return False
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    if receipt.get('request') != metadata:
        raise GenerationError('The existing receipt has different inputs; choose a new output directory.')
    if receipt.get('status') != 'complete':
        raise GenerationError('The previous attempt needs manual review; refusing an automatic API retry.')
    sources = receipt.get('sources', [])
    if not sources or not any(source.get('path', '').startswith('audio-') for source in sources):
        raise GenerationError('The completed receipt has no audio sources.')
    for source in sources:
        name = source.get('path', '')
        if not name or Path(name).name != name:
            raise GenerationError('The receipt has an invalid source path.')
        path = output / name
        if not path.is_file() or digest(path.read_bytes()) != source.get('sha256'):
            raise GenerationError('A saved source is missing or differs from its receipt.')
    print(f'Already complete; verified source hashes and skipped: {output}')
    return True


def parse_response(raw):
    response = json.loads(raw)
    audio, text = [], []
    for step in response.get('steps', []):
        if step.get('type') != 'model_output':
            continue
        for block in step.get('content', []):
            if block.get('type') == 'text':
                text.append(block['text'])
            elif block.get('type') == 'audio':
                mime_type = block.get('mime_type', '').split(';')[0].strip().lower()
                extension = AUDIO_TYPES.get(mime_type)
                if not extension:
                    raise GenerationError('The API returned an unsupported audio media type.')
                data = base64.b64decode(block['data'], validate=True)
                if not data:
                    raise GenerationError('The API returned empty audio.')
                audio.append((extension, mime_type, data))
    if not audio:
        raise GenerationError('The API response contained no generated audio.')
    return audio, '\n\n'.join(text).strip() + '\n'


def generate(output, receipt_path, metadata, body, key):
    # Construct and encode locally before recording an attempt.
    request = Request(ENDPOINT, data=json.dumps(body).encode('utf-8'), method='POST',
                      headers={'x-goog-api-key': key, 'Content-Type': 'application/json',
                               'Accept': 'application/json'})
    receipt = {'service': 'Google Lyria', 'request': metadata, 'created_at': now(),
               'status': 'request_pending', 'sources': []}
    output.mkdir(parents=True, exist_ok=True)
    write_receipt(receipt_path, receipt, create=True)
    try:
        with build_opener(NoRedirect()).open(request, timeout=180) as response:
            receipt['http_status'] = response.status
            raw = response.read()
    except HTTPError as error:
        receipt.update(status='http_error', http_status=error.code, finished_at=now())
        write_receipt(receipt_path, receipt)
        raise GenerationError(f'Google returned HTTP {error.code}; no retry performed.') from None
    except Exception:
        receipt.update(status='request_outcome_unknown', finished_at=now())
        write_receipt(receipt_path, receipt)
        raise GenerationError('The request outcome is uncertain; no retry performed.') from None
    try:
        audio, composition = parse_response(raw)
    except Exception:
        receipt.update(status='invalid_response', finished_at=now())
        write_receipt(receipt_path, receipt)
        raise GenerationError('The response did not contain usable audio; no retry performed.') from None
    try:
        for index, (extension, mime_type, data) in enumerate(audio, 1):
            path = output / f'audio-{index:02d}{extension}'
            with path.open('xb') as handle:
                handle.write(data)
            receipt['sources'].append({'path': path.name, 'mime_type': mime_type,
                                       'bytes': len(data), 'sha256': digest(data)})
        composition_path = output / 'composition.txt'
        composition_bytes = composition.encode('utf-8')
        with composition_path.open('xb') as handle:
            handle.write(composition_bytes)
        receipt['sources'].append({'path': composition_path.name, 'mime_type': 'text/plain',
                                   'bytes': len(composition_bytes),
                                   'sha256': digest(composition_bytes)})
    except Exception:
        receipt.update(status='save_error', finished_at=now())
        write_receipt(receipt_path, receipt)
        raise GenerationError('Saving the received output failed; no retry performed.') from None
    receipt.update(status='complete', finished_at=now())
    write_receipt(receipt_path, receipt)
    print(f'Saved {len(audio)} audio candidate(s) and composition text: {output}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prompt-file', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, default=ROOT / '.artifacts/lyria-menu')
    parser.add_argument('--image', type=Path, help='Optional PNG, JPEG, or WebP reference image.')
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument('--key-file', type=Path, help='File containing only the API key.')
    credentials.add_argument('--keychain-service', help='macOS Keychain generic-password service.')
    parser.add_argument('--keychain-account', help='Optional account within the Keychain service.')
    parser.add_argument('--generate', action='store_true', help='Make one live API request. Default is dry run.')
    args = parser.parse_args()
    if args.keychain_account and not args.keychain_service:
        parser.error('--keychain-account requires --keychain-service')
    metadata, body = request_data(args)
    output = args.output_dir.resolve()
    receipt_path = output / 'receipt.json'
    if already_complete(output, receipt_path, metadata):
        return
    if not args.generate:
        print(json.dumps({'mode': 'dry_run', 'request': metadata, 'output_dir': str(output)},
                         indent=2, ensure_ascii=False))
        print('No credentials read or API call made. Add --generate to execute once.')
        return
    generate(output, receipt_path, metadata, body, read_key(args))


if __name__ == '__main__':
    try:
        main()
    except GenerationError as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('Interrupted; inspect any pending receipt before another attempt.', file=sys.stderr)
        sys.exit(130)
    except Exception:
        # Do not print exception details: external libraries or HTTP handlers
        # can attach credentials or response bodies to their errors.
        print('Error: local input, credential lookup, or output handling failed. No automatic retry.',
              file=sys.stderr)
        sys.exit(1)
