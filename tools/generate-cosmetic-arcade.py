#!/usr/bin/env python3
"""Original Arcade cosmetic kit. Live requests spend credits; never auto-retry.

python3 tools/generate-cosmetic-arcade.py --generate --cue kill
python3 tools/generate-cosmetic-arcade.py --generate
python3 tools/generate-cosmetic-arcade.py

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
ARTIFACTS = ROOT / '.artifacts/cosmetics/arcade'
RUNTIME = ROOT / 'public/assets/audio/cosmetics/arcade'
SPEC = importlib.util.spec_from_file_location('eleven_effects', ROOT / 'tools/generate-elevenlabs-effects.py')
API = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(API)

CUES = {
    'kill': {
        'duration_seconds': 0.5,
        'maximum_duration': 0.40,
        'fade_out': 0.020,
        'text': ('One original arcade shooter kill-confirmation sound. Bright rounded '
                 '8-bit pulse synth, tiny tactile click then two quick rising notes in a major '
                 'sixth. Compact joyful pip-CHIP, instant attack, all action finished within '
                 '0.30 seconds followed by silence. Warm triangle bass accent, crisp controlled '
                 'treble. Dry clean isolated game UI asset. No voices, gunshots, '
                 'ambience, noise bed, echo, repeated events or recognizable existing melody.'),
    },
    'death': {
        'duration_seconds': 1.0,
        'maximum_duration': 0.95,
        'fade_out': 0.040,
        'text': ('Original arcade player-signature jingle, a cheerful confident four-note '
                 'melody lasting 0.75 seconds then clean decay. '
                 'Rounded bright 8-bit pulse lead jumps up a major sixth then lands on a warm '
                 'resolved major chord; soft triangle bass and one tiny digital sparkle. '
                 'Playful and satisfying, restrained treble. Immediate attack, dry '
                 'game UI audio. No voices, gunshots, ambience, repeats, reverb '
                 'or recognizable melody from an existing game.'),
    },
    'victory': {
        'duration_seconds': 3.5,
        'maximum_duration': 3.60,
        'fade_out': 0.100,
        'text': ('Original 3.5 second arcade victory fanfare. Rounded bright '
                 '8-bit pulse lead opens with a bold rising major sixth, develops into a short '
                 'joyful melody over warm triangle bass, tight electronic snare '
                 'and sparkling arpeggio. Champion mood, playful elegant chiptune '
                 'production. One phrase with satisfying resolved '
                 'major final chord and short clean tail, ends by 3.3 seconds. No voices, '
                 'ambience, repeated loops or recognizable existing game melody.'),
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
    # Give the victory phrase a little breathing room without changing pitch.
    tempo = 0.90 if cue == 'victory' else 1.0
    duration = (end - start) / tempo
    trimmed = source[int(start * 48000):int(end * 48000)]
    rms = math.sqrt(sum(x * x for x in trimmed) / len(trimmed))
    # -20 dBFS RMS avoids masking gameplay; peak headroom accommodates Opus.
    gain = min(0.10 / max(rms, 1e-8), 0.68 / max(abs(x) for x in trimmed))
    fade = min(CUES[cue]['fade_out'], duration / 4)
    filters = (f'atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS,'
               f'atempo={tempo:.2f},volume={gain:.8f},afade=t=in:d=0.003,'
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
    minimum, maximum = {'kill': (0.25, 0.45), 'death': (0.1, 1.0), 'victory': (3.0, 4.0)}[cue]
    if not minimum <= metrics['decoded_duration_seconds'] <= maximum:
        raise API.GenerationError(f'{cue}: encoded duration is outside the cue budget.')
    subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-i', str(destination),
                    '-filter_complex', 'showwavespic=s=1400x240:colors=0x35e1ed',
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
                       'target_rms_dbfs': -20, 'maximum_decoded_peak': 0.75},
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
        # kill-1 was rejected with HTTP 400; retain that receipt for audit.
        variant = args.variant or (2 if cue == 'kill' else 1)
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
    manifest = {'schema_version': 1, 'kit': 'arcade', 'title': 'Arcade',
                'authorship': 'Original commissioned AI-generated sound effects; no supplied recordings or sampled songs.',
                'recipe': 'tools/generate-cosmetic-arcade.py',
                'api_reference': 'https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert',
                'assets': [merged[name] for name in CUES if name in merged]}
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except API.GenerationError as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
