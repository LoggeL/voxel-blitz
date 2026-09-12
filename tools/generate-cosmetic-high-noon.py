#!/usr/bin/env python3
"""Original High Noon cosmetic kit. Live requests spend credits; never auto-retry.

python3 tools/generate-cosmetic-high-noon.py --generate --cue kill
python3 tools/generate-cosmetic-high-noon.py --generate
python3 tools/generate-cosmetic-high-noon.py

Without --generate this only processes already saved originals. Credentials are
read in memory by the existing Keychain helper. Source receipts persist before
each POST; an uncertain outcome requires manual review, never another POST.
"""

import argparse
from array import array
import importlib.util
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / '.artifacts/cosmetics/high-noon'
RUNTIME = ROOT / 'public/assets/audio/cosmetics/high-noon'
SPEC = importlib.util.spec_from_file_location('eleven_effects', ROOT / 'tools/generate-elevenlabs-effects.py')
API = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(API)

CUES = {
    'kill': {
        'duration_seconds': 0.5,
        'maximum_duration': 0.43,
        'fade_out': 0.025,
        'text': ('One original western duel kill confirmation. Immediate dry metallic '
                 'spur tick layered with a warm muted steel guitar harmonic, two tightly '
                 'plucked notes rising a perfect fourth. Confident compact CHINK-ding, '
                 'rounded upper mids, restrained treble. Entire event and natural decay '
                 'finish within 0.35 seconds then silence. Clean isolated game UI sound. '
                 'No voices, gunshots, ambience, loops, echo or existing melody.'),
    },
    'death': {
        'duration_seconds': 1.0,
        'maximum_duration': 0.99,
        'fade_out': 0.050,
        'text': ('Original western gunslinger signature lasting 0.8 seconds with a clean '
                 'short tail. Dry steel guitar harmonic jumps up a perfect fourth, then '
                 'a warm low twang resolves confidently. One delicate metallic spur tick '
                 'marks the attack. Dusty cinematic duel attitude, intimate string texture, '
                 'restrained treble, no long reverb. One compact memorable musical '
                 'gesture. No voices, gunshots, ambience, repeated loop or existing melody.'),
    },
    'victory': {
        'duration_seconds': 4.0,
        'maximum_duration': 4.15,
        'fade_out': 0.120,
        'text': ('A complete original four second WESTERN MUSIC victory phrase, played '
                 'throughout the clip. Four rhythmic baritone guitar plucks in the first '
                 'second, a steel guitar melody answers in seconds two and three, rising '
                 'a perfect fourth then resolving to a warm final chord at 3.4 seconds. '
                 'Quiet galloping brushes and upright bass continue under the melody. '
                 'Confident duel swagger, dry studio recording. No speech or existing tune.'),
    },
}


def body_for(cue):
    return {'text': CUES[cue]['text'], 'duration_seconds': CUES[cue]['duration_seconds'],
            'prompt_influence': 0.3, 'model_id': API.MODEL}


def samples(path, ffmpeg):
    data = subprocess.check_output([ffmpeg, '-v', 'error', '-nostdin', '-i', str(path),
                                    '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'])
    values = array('f')
    values.frombytes(data)
    if sys.byteorder != 'little':
        values.byteswap()
    return values


def statistics(values):
    peak = max((abs(x) for x in values), default=0)
    rms = math.sqrt(sum(x * x for x in values) / max(1, len(values)))
    return {'decoded_duration_seconds': round(len(values) / 48000, 6),
            'sample_peak': round(peak, 6),
            'sample_peak_dbfs': round(20 * math.log10(max(peak, 1e-12)), 3),
            'rms_dbfs': round(20 * math.log10(max(rms, 1e-12)), 3),
            'clipped_samples': sum(abs(x) >= 1 for x in values)}


def relative(path):
    return path.relative_to(ROOT).as_posix()


def process(cue, variant, ffmpeg):
    raw, wav, receipt_path = API.candidate_paths(ARTIFACTS, cue, variant)
    receipt = json.loads(receipt_path.read_text())
    if receipt.get('status') != 'complete' or receipt.get('decoded_sha256') != API.sha256(wav):
        raise API.GenerationError(f'{cue}: verified complete source required before processing.')
    source = samples(wav, ffmpeg)
    peak = max(abs(x) for x in source)
    if peak < 0.001:
        raise API.GenerationError(f'{cue}: source is silent; review saved original.')
    threshold = peak * 0.010
    audible = [i for i, x in enumerate(source) if abs(x) >= threshold]
    start = max(0, audible[0] / 48000 - 0.003)
    end = min(len(source) / 48000, audible[-1] / 48000 + 0.035,
              start + CUES[cue]['maximum_duration'])
    # Preserve the performed pitch and rhythm of the original phrase.
    tempo = 1.0
    duration = (end - start) / tempo
    trimmed = source[int(start * 48000):int(end * 48000)]
    rms = math.sqrt(sum(x * x for x in trimmed) / len(trimmed))
    # Match perceived body across cues; a short transparent limiter catches
    # isolated string transients while retaining headroom for Opus overshoot.
    gain = 0.10 / max(rms, 1e-8)
    fade = min(CUES[cue]['fade_out'], duration / 4)
    filters = (f'aformat=channel_layouts=mono,atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS,'
               f'atempo={tempo:.2f},volume={gain:.8f},'
               'alimiter=limit=0.68:attack=1:release=35:level=0:latency=1,'
               'afade=t=in:d=0.003,'
               f'afade=t=out:st={duration-fade:.6f}:d={fade:.6f}')
    RUNTIME.mkdir(parents=True, exist_ok=True)
    destination = RUNTIME / f'{cue}.ogg'
    subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(wav), '-af', filters,
                    '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '112k',
                    '-vbr', 'on', '-application', 'audio', '-map_metadata', '-1',
                    str(destination)], check=True)
    metrics = statistics(samples(destination, ffmpeg))
    if metrics['sample_peak'] > 0.75 or metrics['clipped_samples']:
        raise API.GenerationError(f'{cue}: encoded audio exceeded peak budget; inspect before shipping.')
    minimum, maximum = {'kill': (0.25, 0.45), 'death': (0.5, 1.0), 'victory': (3.0, 4.5)}[cue]
    if not minimum <= metrics['decoded_duration_seconds'] <= maximum:
        raise API.GenerationError(f'{cue}: encoded duration is outside the cue budget.')
    subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(destination),
                    '-filter_complex', 'showwavespic=s=1400x240:colors=0xdfb666',
                    '-frames:v', '1', str(ARTIFACTS / f'{cue}-waveform.png')], check=True)
    return {
        'cue': cue, 'file': f'{cue}.ogg', 'sha256': API.sha256(destination),
        'bytes': destination.stat().st_size, 'format': 'Ogg Opus',
        'sample_rate': 48000, 'channels': 1, 'bitrate_target': 112000,
        'source': {'provider': 'ElevenLabs Sound Effects', 'model_id': API.MODEL,
                   'request': body_for(cue), 'candidate': variant,
                   'raw_sha256': API.sha256(raw), 'decoded_sha256': API.sha256(wav),
                   'receipt': relative(receipt_path), 'http_status': receipt.get('http_status'),
                   'request_id': receipt.get('request_id'),
                   'character_cost': receipt.get('character_cost'),
                   'created_at': receipt.get('created_at')},
        'processing': {'trim_start_seconds': round(start, 6), 'trim_end_seconds': round(end, 6),
                       'gain': round(gain, 8), 'fade_in_seconds': 0.003,
                       'tempo': tempo, 'pitch_preserved': True,
                       'fade_out_seconds': fade, 'filter': filters,
                       'target_rms_dbfs': -20, 'maximum_decoded_peak': 0.75,
                       'limiter': {'limit': 0.68, 'attack_ms': 1, 'release_ms': 35,
                                   'automatic_makeup_gain': False, 'latency_compensated': True}},
        'metrics': metrics,
        'qa': {'waveform': relative(ARTIFACTS / f'{cue}-waveform.png'),
               'human_or_model_audio_audition': False,
               'note': 'Signal metrics and waveform inspected; no listening capability available.'},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate', action='store_true', help='Authorize missing paid API requests.')
    parser.add_argument('--cue', action='append', choices=CUES)
    parser.add_argument('--variant', type=int, choices=[1, 2])
    args = parser.parse_args()
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise API.GenerationError('ffmpeg required; no request made.')
    entries = []
    key = None
    for cue in dict.fromkeys(args.cue or CUES):
        # The first victory candidate was a decaying hit, not a developed phrase.
        variant = args.variant or (2 if cue == 'victory' else 1)
        body = body_for(cue)
        if len(body['text']) > 450:
            raise API.GenerationError(f'{cue}: prompt exceeds conservative 450-character budget.')
        raw, wav, receipt = API.candidate_paths(ARTIFACTS, cue, variant)
        if args.generate:
            if not API.resume_saved(raw, wav, receipt, body, ffmpeg):
                if key is None:
                    key = API.read_api_key()
                original_opener = API.build_opener

                class DiagnosticOpener:
                    def __init__(self, *handlers):
                        self.opener = original_opener(*handlers)

                    def open(self, *values, **options):
                        try:
                            return self.opener.open(*values, **options)
                        except HTTPError as error:
                            try:
                                detail = json.loads(error.read(4096)).get('detail', {})
                                if isinstance(detail, dict):
                                    safe = {name: str(detail.get(name, ''))[:1000].replace(key, '[redacted]')
                                            for name in ('status', 'message')}
                                    print(json.dumps({'api_error': safe}), flush=True)
                                    (ARTIFACTS / f'{cue}-{variant}-error.json').write_text(json.dumps(safe, indent=2) + '\n')
                            except (ValueError, OSError):
                                pass
                            raise

                API.build_opener = DiagnosticOpener
                try:
                    API.generate(cue, variant, ARTIFACTS, body, key, ffmpeg)
                finally:
                    API.build_opener = original_opener
        entries.append(process(cue, variant, ffmpeg))
        print(json.dumps({'cue': cue, 'metrics': entries[-1]['metrics']}), flush=True)
    manifest_path = RUNTIME / 'sources.json'
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    merged = {entry['cue']: entry for entry in previous.get('assets', [])}
    merged.update({entry['cue']: entry for entry in entries})
    manifest = {'schema_version': 1, 'kit': 'high-noon', 'title': 'High Noon',
                'authorship': 'Original commissioned AI-generated sound effects; no supplied recordings or sampled songs.',
                'recipe': 'tools/generate-cosmetic-high-noon.py',
                'api_reference': 'https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert',
                'assets': [merged[name] for name in CUES if name in merged]}
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    checks = []
    for entry in manifest['assets']:
        rendered = RUNTIME / entry['file']
        decoded = samples(rendered, ffmpeg)
        probe = json.loads(subprocess.check_output([
            shutil.which('ffprobe') or 'ffprobe', '-v', 'error',
            '-select_streams', 'a:0', '-show_entries',
            'stream=codec_name,sample_rate,channels:format=size,duration',
            '-of', 'json', str(rendered)], text=True))
        tail_rms = statistics(decoded[-960:])['rms_dbfs']
        check = {'cue': entry['cue'], 'candidate': entry['source']['candidate'],
                 'file': relative(rendered), 'sha256': API.sha256(rendered),
                 'source_hash_verified': True, 'manifest_hash_matches': API.sha256(rendered) == entry['sha256'],
                 'metrics': statistics(decoded), 'tail_20ms_rms_dbfs': tail_rms,
                 'first_sample': round(decoded[0], 8), 'last_sample': round(decoded[-1], 8),
                 'probe': probe}
        assert check['manifest_hash_matches'] and check['metrics']['clipped_samples'] == 0
        assert probe['streams'][0]['codec_name'] == 'opus'
        assert probe['streams'][0]['channels'] == 1 and probe['streams'][0]['sample_rate'] == '48000'
        checks.append(check)
    attempts = []
    for receipt_file in sorted((ARTIFACTS / 'api-source').glob('*.json')):
        receipt = json.loads(receipt_file.read_text())
        attempts.append({'cue': receipt['cue'], 'candidate': receipt['variant'],
                         'status': receipt['status'], 'http_status': receipt.get('http_status'),
                         'character_cost': receipt.get('character_cost'),
                         'receipt': relative(receipt_file)})
    qa = {'kit': 'high-noon', 'technical_checks_passed': True,
          'audition_performed': False,
          'review_limit': 'Decoded signal metrics, codec, hashes and waveforms inspected. No audio listening capability was available.',
          'candidate_selection': {'kill': 1, 'death': 1, 'victory': 2},
          'discarded_candidates': [{'cue': 'victory', 'candidate': 1,
              'reason': 'Envelope showed one early hit with a continuous decay. Candidate 2 has distinct events throughout the phrase.'}],
          'api_attempt_count': len(attempts),
          'character_cost_total': sum(int(x['character_cost'] or 0) for x in attempts),
          'attempts': attempts, 'assets': checks}
    (ARTIFACTS / 'qa.json').write_text(json.dumps(qa, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except API.GenerationError as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
