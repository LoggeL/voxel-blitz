#!/usr/bin/env python3
"""Rebuild soft hit confirmations from retained ElevenLabs API candidates.

Requires ffmpeg plus NumPy, SciPy and Matplotlib. Raw MP3 responses, decoded WAVs
and API receipts live in .artifacts/elevenlabs-hit-audio-2026-09-08/.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-hit-audio-2026-09-08'
spec = importlib.util.spec_from_file_location('effects', ROOT / 'tools/prepare-elevenlabs-effects.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
fx.WORK = WORK
np, plt, RATE = fx.np, fx.plt, fx.RATE

RECIPES = [
    dict(id='hit-body', source='hitbody-2.wav', trim=[0, .080], highpass=160, lowpass=2400,
         peak=.24, fade_out=.012, output='ui/hitmark-body.ogg',
         reason='Candidate 2 has an immediate contained tick and short decay. Candidates 1 and 3 have later main impacts; candidate 4 contains weaker separated pulses. Remove sub-bass and bright ringing so rapid hits stay soft.'),
    dict(id='hit-head', source='hithead-3.wav', trim=[0, .075], highpass=220, lowpass=3800,
         peak=.28, fade_out=.012, output='ui/hitmark-head.ogg',
         reason='Candidate 3 is the clean immediate snap. Candidate 1 reaches full scale with a 284 ms delay; candidates 2 and 4 are nearly silent low-frequency artifacts. A broader midrange and slightly higher level distinguish precision hits without pitched tones.'),
    dict(id='kill-body', source='hitbody-3.wav', trim=[.051, .195], highpass=110, lowpass=2500,
         peak=.32, fade_out=.025, output='ui/kill-body.ogg',
         reason='The isolated delayed knock from body candidate 3 has a weightier body and longer decay than the per-hit tick. Trimming to that knock makes a clear short kill confirmation without a melodic flourish.'),
    dict(id='kill-head', source='hitbody-1.wav', trim=[.051, .190], highpass=160, lowpass=3400,
         peak=.35, fade_out=.025, output='ui/kill-head.ogg',
         reason='The second stronger knock from body candidate 1 is isolated and retains slightly more upper mids than body kills. Its short rounded tail adds distinction while leaving headshot hit and kill overlap well below full scale.'),
    dict(id='flesh', source='hitbody-3.wav', trim=[.051, .175], highpass=80, lowpass=1250,
         peak=.32, fade_out=.025, output='impacts/flesh.ogg',
         reason='Use the rounded knock as a muted incoming body impact. Low-pass filtering removes the UI snap, and the existing damage gain and flesh cap keep it secondary to the victim pain cue.'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analyze', action='store_true')
    args = parser.parse_args()
    (WORK / 'analysis').mkdir(parents=True, exist_ok=True)
    if args.analyze:
        fx.analyze(['hitbody', 'hithead'])
    records, plots = [], []
    for recipe in RECIPES:
        source = WORK / 'source' / recipe['source']
        receipt = json.loads((WORK / 'api-source' / (source.stem + '.json')).read_text())
        assert receipt['status'] == 'complete'
        assert hashlib.sha256(source.read_bytes()).hexdigest() == receipt['decoded_sha256']
        raw_path = WORK / 'api-source' / (source.stem + '.mp3')
        assert hashlib.sha256(raw_path.read_bytes()).hexdigest() == receipt['raw_sha256']
        x = fx.decode(source)
        start, end = recipe['trim']
        x = x[round(start * RATE):round(end * RATE)]
        filtered = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE),
            '-ac', '1', '-i', '-', '-af', f'highpass=f={recipe["highpass"]},lowpass=f={recipe["lowpass"]}',
            '-f', 'f32le', '-'], input=x.astype('<f4').tobytes())
        x = np.frombuffer(filtered, dtype='<f4').astype(np.float64)
        x[:48] *= np.linspace(0, 1, 48)
        fade = round(recipe['fade_out'] * RATE)
        x[-fade:] *= np.linspace(1, 0, fade)
        gain = recipe['peak'] / np.max(np.abs(x))
        output = ROOT / 'public/assets/audio' / recipe['output']
        for _ in range(5):
            fx.encode(x * gain, output)
            decoded = fx.decode(output)
            peak = np.max(np.abs(decoded))
            if recipe['peak'] * .97 <= peak <= recipe['peak']:
                break
            gain *= recipe['peak'] * .99 / peak
        metrics = fx.measure(decoded)
        assert metrics['clipping_samples_at_0_999'] == 0
        assert metrics['peak'] <= recipe['peak'] + .005
        assert metrics['onset_seconds_2pct_peak'] < .005
        record = dict(recipe, mono='0.5L + 0.5R', sample_rate_hz=RATE, codec='Opus', bitrate='96k',
            fade_in_seconds=.001, normalization_gain=float(gain), final_metrics=metrics,
            output='public/assets/audio/' + recipe['output'],
            output_sha256=hashlib.sha256(output.read_bytes()).hexdigest(),
            generation={key: receipt[key] for key in ['created_at', 'output_format', 'source_codec',
                'request_body', 'raw_sha256', 'decoded_sha256']})
        records.append(record)
        plots.append((recipe['id'], decoded, metrics))
    manifest = dict(service='ElevenLabs Sound Effects', generated='2026-09-08',
        candidates=8, selections=records, review_basis='Waveform, 5 ms RMS, spectrogram and decoded-output '
        'analysis. Listening is not asserted.', rebuild='python tools/prepare-hit-audio.py',
        source_note='Original API MP3 responses and receipts are retained; analysis WAVs are decoded PCM.')
    (ROOT / 'public/assets/audio/elevenlabs-hit-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (WORK / 'analysis/final-metrics.json').write_text(json.dumps(manifest, indent=2) + '\n')
    fig, axes = plt.subplots(5, 2, figsize=(15, 12))
    for row, (name, x, metrics) in enumerate(plots):
        fx.plot_pair(*axes[row], x, name, metrics)
    fig.suptitle('Soft game hit feedback: actual decoded Opus waveform and spectrum', fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, .975))
    fig.savefig(WORK / 'analysis/final-contact-sheet.png', dpi=135)
    plt.close(fig)
    rows = ['# Hit feedback audio', '', '| Cue | Duration | Onset | Peak | RMS | Clips |',
            '|---|---:|---:|---:|---:|---:|']
    for item in records:
        m = item['final_metrics']
        rows.append(f'| {item["id"]} | {m["duration_seconds"]:.3f} s | '
                    f'{m["onset_seconds_2pct_peak"] * 1000:.2f} ms | {m["peak"]:.3f} | '
                    f'{m["rms"]:.3f} | {m["clipping_samples_at_0_999"]} |')
        print(item['id'], json.dumps({k: m[k] for k in ['duration_seconds', 'peak', 'rms', 'onset_seconds_2pct_peak']}))
    rows += ['', 'Eight candidates were visually reviewed. Original API receipts record 40 credits in total.',
             'Body/head confirmations have no synthetic layer when the sample loads. Kill cues remain distinct '
             'and short. The procedural fallback uses compact bandpass noise and low triangles; no square-wave '
             'chirps or delayed musical notes remain.', '', '## Selections', '']
    for item in records:
        rows.extend([f'### {item["id"]}', '', item['reason'], ''])
    (WORK / 'analysis/report.md').write_text('\n'.join(rows) + '\n')


if __name__ == '__main__':
    main()
