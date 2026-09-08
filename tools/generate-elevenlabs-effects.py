#!/usr/bin/env python3
"""Generate game sound effects through ElevenLabs without browser downloads.

Dry runs neither read credentials nor contact the service. Live requests spend
credits and are never retried automatically. The API key stays in memory after
reading macOS Keychain, with ELEVENLABS_API_KEY as a fallback.

API reference: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / '.artifacts/elevenlabs-effects-2026-09-07'
ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation'
OUTPUT_FORMAT = 'mp3_44100_128'
MODEL = 'eleven_text_to_sound_v2'
KEYCHAIN_SERVICE = 'voxel-blitz.elevenlabs'
KEYCHAIN_ACCOUNT = 'sound-effects'

CUES = {
    'hitbody': {
        'duration_seconds': 0.5,
        'text': ('One subtle dry FPS hit-confirmation tick, immediate onset: a soft tight '
                 'woody tack with a small low-mid punch, tactile and clean, fast natural '
                 'decay under 0.09 seconds. Quiet close game UI feedback for rapid repeats. '
                 'No beep, no pitched note, no chime, no ringing, no metallic clang, '
                 'no wet gore, no gunshot, no voice, no reverb, no music, one event only.'),
    },
    'hithead': {
        'duration_seconds': 0.5,
        'text': ('One compact satisfying FPS precision-hit confirmation: a dry rounded '
                 'wooden knock with a fine crisp papery snap, slightly brighter than a '
                 'soft body-hit tick, immediate attack and short decay under 0.12 seconds. '
                 'Restrained clean game UI feedback. No beep, no musical pitch, no chime, '
                 'no ringing, no metallic clang, no gunshot, no gore, no voices or reverb.'),
    },
    'pin': {
        'duration_seconds': 0.5,
        'text': ('One close, dry grenade safety pin pull: a tiny metallic ring scrape '
                 'and one crisp short spring click, immediate onset, quick natural decay. '
                 'Isolated first-person game handling sound, restrained and precise. '
                 'No explosion, no voices, no music, no ambience, no repeated actions.'),
    },
    'throw': {
        'duration_seconds': 0.5,
        'text': ('One quick arm swing releasing a hand grenade: close cloth movement '
                 'with a compact airy whoosh, immediate onset, a light hand-release flick '
                 'and fast decay. Isolated first-person game action. No impact or landing, '
                 'no explosion, no voices, no music, no ambience, no repeated swings.'),
    },
    'minigun': {
        'duration_seconds': 0.5,
        'text': ('Single shot from a brutal industrial rotary cannon. A fast dense percussive '
                 'attack, thick growling low-mid concussion and coarse mechanical clack. '
                 'Deep compact CHUG with textured powder roar, strong body on small speakers, '
                 'short dry 160 ms decay. One self-contained gunshot starting immediately. '
                 'No other shots, no motor, no shell ping, no ricochet, no laser, no squeak, '
                 'no sci-fi pew, no voice, no music, no long echo.'),
    },
    'knife': {
        'duration_seconds': 0.5,
        'text': ('One close heavy pickaxe swing through air, a fast broad rushing swoosh '
                 'with wooden handle creak and cloth friction. A strong downward chop, '
                 'dry and compact. No impact, no ringing, no voice, no music.'),
    },
    'pickaxeimpact': {
        'duration_seconds': 1.0,
        'text': ('A single loud pickaxe strike against solid rock: a sharp steel-on-stone '
                 'clack over a chunky deep thud, followed by dry gritty stone chips. '
                 'Close isolated foley, short natural decay. No swing, no second strike, '
                 'no ringing, no voice, no music.'),
    },
    'flame': {
        'duration_seconds': 2.0,
        'loop': True,
        'text': ('A steady close pressurized flamethrower jet: dense rushing fire, warm '
                 'low roar, fine fast crackling and a controlled gas hiss. Continuous '
                 'stationary game weapon texture, seamless loop, consistent energy from '
                 'start to finish. No ignition, no fade, no shutdown, no explosions, '
                 'no separate impacts, no voices, no music, no ambience.'),
    },
}


class GenerationError(Exception):
    """An operator-safe message that never contains request credentials."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_receipt(path, receipt):
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def read_api_key():
    security = shutil.which('security')
    if security:
        try:
            result = subprocess.run(
                [security, 'find-generic-password', '-s', KEYCHAIN_SERVICE,
                 '-a', KEYCHAIN_ACCOUNT, '-w'],
                capture_output=True, text=True, timeout=30, check=False,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
    key = os.environ.get('ELEVENLABS_API_KEY', '').strip()
    if key:
        return key
    raise GenerationError('No API key found in the configured Keychain item or ELEVENLABS_API_KEY.')


def body_for(cue, prompt=None):
    preset = CUES[cue]
    body = {
        'text': prompt or preset['text'],
        'duration_seconds': preset['duration_seconds'],
        'prompt_influence': 0.3,
        'model_id': MODEL,
    }
    if preset.get('loop'):
        body['loop'] = True
    return body


def response_metadata(headers):
    # Retain only these documented/public response fields, never a header dump.
    headers = headers or {}
    return {
        'content_type': headers.get('content-type'),
        'request_id': headers.get('request-id') or headers.get('x-request-id'),
        'character_cost': headers.get('character-cost'),
    }


def decode_source(ffmpeg, raw_path, wav_path, receipt_path, receipt):
    if receipt.get('raw_sha256') != sha256(raw_path):
        raise GenerationError(f'{raw_path.name}: saved source hash differs from its receipt.')
    result = subprocess.run(
        [ffmpeg, '-v', 'error', '-nostdin', '-n', '-i', str(raw_path),
         '-map', '0:a:0', '-ar', '48000', '-c:a', 'pcm_s24le', str(wav_path)],
        capture_output=True, check=False,
    )
    if result.returncode:
        receipt['status'] = 'decode_failed'
        write_receipt(receipt_path, receipt)
        raise GenerationError(f'{raw_path.name}: WAV decoding failed; original preserved, no POST retry.')
    receipt.update(status='complete', decoded_path=str(wav_path),
                   decoded_sha256=sha256(wav_path), decoded_sample_rate=48000,
                   decoded_channels='preserved from source', completed_at=utc_now())
    write_receipt(receipt_path, receipt)


def candidate_paths(output, cue, variant):
    stem = f'{cue}-{variant}'
    return (output / 'api-source' / f'{stem}.mp3',
            output / 'source' / f'{stem}.wav',
            output / 'api-source' / f'{stem}.json')


def resume_saved(raw_path, wav_path, receipt_path, body, ffmpeg):
    if not any(path.exists() for path in (raw_path, wav_path, receipt_path)):
        return False
    if not receipt_path.exists():
        raise GenerationError(f'{raw_path.stem}: existing files have no API receipt; refusing to overwrite.')
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    if receipt.get('request_body') != body:
        raise GenerationError(f'{raw_path.stem}: existing receipt uses another prompt or settings.')
    if receipt.get('status') == 'complete':
        if not raw_path.exists() or not wav_path.exists():
            raise GenerationError(f'{raw_path.stem}: completed receipt is missing an audio file.')
        if receipt.get('raw_sha256') != sha256(raw_path) or receipt.get('decoded_sha256') != sha256(wav_path):
            raise GenerationError(f'{raw_path.stem}: saved audio hash differs from its receipt.')
        print(f'{raw_path.stem}: already complete, skipped', flush=True)
        return True
    if receipt.get('status') in ('audio_received', 'decode_failed') and raw_path.exists() and not wav_path.exists():
        decode_source(ffmpeg, raw_path, wav_path, receipt_path, receipt)
        print(f'{raw_path.stem}: decoded saved original, no API request', flush=True)
        return True
    raise GenerationError(f'{raw_path.stem}: previous attempt needs review; refusing an automatic paid retry.')


def generate(cue, variant, output, body, key, ffmpeg):
    raw_path, wav_path, receipt_path = candidate_paths(output, cue, variant)
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    receipt = {
        'service': 'ElevenLabs Sound Effects', 'cue': cue, 'variant': variant,
        'created_at': utc_now(), 'endpoint': ENDPOINT, 'output_format': OUTPUT_FORMAT,
        'source_codec': 'mp3', 'request_body': body, 'raw_path': str(raw_path),
        'status': 'request_started',
    }
    # Leave evidence before a paid request so interruption cannot silently repeat it.
    write_receipt(receipt_path, receipt)
    request = Request(
        f'{ENDPOINT}?output_format={OUTPUT_FORMAT}',
        data=json.dumps(body).encode('utf-8'), method='POST',
        headers={'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg'},
    )
    try:
        with build_opener(NoRedirect()).open(request, timeout=120) as response:
            receipt.update(response_metadata(response.headers), http_status=response.status)
            raw = response.read()
    except HTTPError as error:
        receipt.update(response_metadata(error.headers), status='http_error', http_status=error.code)
        write_receipt(receipt_path, receipt)
        raise GenerationError(f'{raw_path.stem}: API returned HTTP {error.code}; no retry performed.') from None
    except Exception:
        receipt['status'] = 'request_outcome_unknown'
        write_receipt(receipt_path, receipt)
        raise GenerationError(f'{raw_path.stem}: request outcome is uncertain; no retry performed.') from None
    content_type = (receipt.get('content_type') or '').split(';')[0].strip().lower()
    if not raw or content_type not in ('audio/mpeg', 'audio/mp3', 'application/octet-stream'):
        receipt['status'] = 'unexpected_response'
        write_receipt(receipt_path, receipt)
        raise GenerationError(f'{raw_path.stem}: response was not nonempty MP3 audio; no retry performed.')
    with raw_path.open('xb') as handle:
        handle.write(raw)
    receipt.update(status='audio_received', raw_bytes=len(raw), raw_sha256=sha256(raw_path))
    write_receipt(receipt_path, receipt)
    decode_source(ffmpeg, raw_path, wav_path, receipt_path, receipt)
    print(f'{raw_path.stem}: saved MP3, WAV and receipt (character cost: {receipt.get("character_cost") or "unavailable"})',
          flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cue', action='append', choices=CUES, help='Select a cue; repeat for several (default: all).')
    parser.add_argument('--variants', type=int, default=4, help='Candidates per selected cue (default: 4).')
    parser.add_argument('--prompt', help='Override the prompt when exactly one cue is selected (maximum 450 characters).')
    parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--dry-run', action='store_true', help='Print requests without reading a key, writing files or using the network.')
    args = parser.parse_args()
    cues = list(dict.fromkeys(args.cue or CUES))
    if args.variants < 1:
        parser.error('--variants must be at least 1')
    if args.prompt is not None and (len(cues) != 1 or not 1 <= len(args.prompt.strip()) <= 450):
        parser.error('--prompt requires exactly one selected cue and 1 to 450 nonblank characters')
    plan = [{'cue': cue, 'variants': args.variants, 'request_body': body_for(cue, args.prompt)} for cue in cues]
    if args.dry_run:
        print(json.dumps({'dry_run': True, 'endpoint': ENDPOINT, 'output_format': OUTPUT_FORMAT,
                          'request_count': len(cues) * args.variants,
                          'output_dir': str(args.output_dir.resolve()), 'plan': plan}, indent=2))
        return
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise GenerationError('ffmpeg is required before generating audio; no request was made.')
    output = args.output_dir.resolve()
    key = None
    for entry in plan:
        for variant in range(1, args.variants + 1):
            paths = candidate_paths(output, entry['cue'], variant)
            if resume_saved(*paths, entry['request_body'], ffmpeg):
                continue
            if key is None:
                key = read_api_key()
            print(f'{entry["cue"]}-{variant}: generating', flush=True)
            generate(entry['cue'], variant, output, entry['request_body'], key, ffmpeg)


if __name__ == '__main__':
    try:
        main()
    except GenerationError as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Error: local file or process operation failed; inspect saved receipts before another live run.', file=sys.stderr)
        sys.exit(1)
