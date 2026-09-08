#!/usr/bin/env python3
"""Rebuild the rotary cannon reports from retained ElevenLabs candidates.

Requires ffmpeg, NumPy, SciPy and Matplotlib. This script never calls an API.
Sources and receipts live in .artifacts/elevenlabs-minigun-2026-09-08/.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-minigun-2026-09-08'
spec = importlib.util.spec_from_file_location('effects', ROOT / 'tools/prepare-elevenlabs-effects.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
np, plt, RATE = fx.np, fx.plt, fx.RATE

RECIPES = [
    dict(id='minigun-1', family='cannon', candidate=1, duration=.17, highpass=65,
         body_hz=220, body_db=5, output='fire.ogg',
         reason='The clearest broad attack of the eight candidates, with a natural powder tail. Keep its textured crack and restore low-mid weight instead of extracting a tiny high-frequency click.'),
    dict(id='minigun-2', family='cannon', candidate=3, duration=.18, highpass=85,
         body_hz=250, body_db=3, output='fire-2.ogg',
         reason='A dense coarse report with a stronger lower-mid action texture. A falling envelope contains the broad source swell so the game still supplies every shot at 20 Hz.'),
    dict(id='minigun-3', family='cannon', candidate=4, duration=.16, highpass=115,
         body_hz=300, body_db=6, output='fire-3.ogg',
         reason='A rough, immediate alternate report. Its dominant deep rumble is reduced in favor of audible low mids and the mechanical attack, preserving weight on smaller speakers.'),
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def analyze():
    records = {}
    for family in ['heavy', 'cannon']:
        fig, axes = plt.subplots(4, 2, figsize=(15, 11))
        for i, path in enumerate(sorted((WORK / family / 'source').glob('*.wav'))):
            x = fx.decode(path)
            metrics = fx.measure(x)
            records[f'{family}/{path.name}'] = metrics
            fx.plot_pair(*axes[i], x, f'{family}/{path.name}', metrics)
        fig.suptitle(f'Minigun {family}: raw candidate waveforms and spectra', fontsize=14)
        fig.tight_layout(rect=(0, 0, 1, .975))
        fig.savefig(WORK / 'analysis' / f'{family}-candidates.png', dpi=130)
        plt.close(fig)
    (WORK / 'analysis/candidates.json').write_text(json.dumps(records, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analyze', action='store_true')
    args = parser.parse_args()
    (WORK / 'analysis').mkdir(parents=True, exist_ok=True)
    if args.analyze:
        analyze()
    records, plots = [], []
    shared_attack = None
    for recipe in RECIPES:
        stem = f'minigun-{recipe["candidate"]}'
        source = WORK / recipe['family'] / 'source' / f'{stem}.wav'
        receipt = json.loads((WORK / recipe['family'] / 'api-source' / f'{stem}.json').read_text())
        assert receipt['status'] == 'complete' and digest(source) == receipt['decoded_sha256']
        assert digest(WORK / recipe['family'] / 'api-source' / f'{stem}.mp3') == receipt['raw_sha256']
        x = fx.decode(source)[:round(recipe['duration'] * RATE)]
        filters = (f'highpass=f={recipe["highpass"]},'
                   f'equalizer=f={recipe["body_hz"]}:t=q:w=0.8:g={recipe["body_db"]},'
                   'equalizer=f=2300:t=q:w=0.8:g=-2,lowpass=f=5200')
        data = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE),
            '-ac', '1', '-i', '-', '-af', filters, '-f', 'f32le', '-'], input=x.astype('<f4').tobytes())
        x = np.frombuffer(data, dtype='<f4').astype(np.float64)
        x /= np.sqrt(np.mean(x[:720] * x[:720]))
        if shared_attack is None:
            shared_attack = x.copy()
        anchor = np.pad(shared_attack, (0, max(0, len(x) - len(shared_attack))))[:len(x)]
        # A consistent leading contact prevents three timbres from reading as
        # one slower repeating beat. Keep variation mainly in the quiet tail.
        x = .85 * anchor + .15 * x
        t = np.arange(len(x)) / RATE
        x *= np.exp(-np.maximum(0, t - .012) / .025)
        x[:24] *= np.linspace(0, 1, 24)
        x[-1200:] *= np.linspace(1, 0, 1200)
        x *= .135 / np.sqrt(np.mean(x * x))
        x = np.tanh(x * 1.5) / 1.5
        gain = min(.135 / np.sqrt(np.mean(x * x)), .70 / np.max(np.abs(x)))
        output = ROOT / 'public/assets/audio/weapons/minigun' / recipe['output']
        for _ in range(5):
            fx.encode(x * gain, output)
            decoded = fx.decode(output)
            m = fx.measure(decoded)
            correction = min(.135 / m['rms'], .70 / m['peak'])
            if abs(correction - 1) < .008:
                break
            gain *= correction
        assert m['clipping_samples_at_0_999'] == 0 and m['peak'] <= .705
        assert m['onset_seconds_2pct_peak'] < .005
        assert .07 <= m['rms'] <= .14
        assert m['energy_seconds']['90'] < .05, 'each report must resolve before the next 1200 RPM shot'
        assert m['energy_band_percent']['120-1000Hz'] >= 25
        assert m['energy_band_percent']['5000-24001Hz'] < 2
        record = dict(recipe, output=str(output.relative_to(ROOT)), output_sha256=digest(output),
            final_metrics=m, filters=filters, trim_start_seconds=0, fade_in_seconds=.0005,
            fade_out_seconds=.025, decay_after_seconds=.012, decay_time_constant_seconds=.025,
            shared_attack='85% filtered cannon candidate 1, 15% selected variant; equal first-15ms RMS before mixing',
            saturation='tanh(1.5*x)/1.5 after RMS normalization to 0.135', normalization_gain=float(gain),
            sample_rate_hz=RATE, mono='arithmetic mean of source channels', codec='Opus', bitrate='96k',
            generation={key: receipt[key] for key in ['created_at', 'request_body', 'output_format',
                'source_codec', 'raw_sha256', 'decoded_sha256']})
        records.append(record)
        plots.append((recipe['id'], decoded, m))
        print(recipe['id'], json.dumps({k: m[k] for k in ['duration_seconds', 'peak', 'rms',
            'onset_seconds_2pct_peak', 'energy_band_percent']}))
    previous = WORK / 'before/fire.ogg'
    if previous.exists():
        old = fx.decode(previous)
        plots.insert(0, ('Previous 55 ms sample', old, fx.measure(old)))
    fig, axes = plt.subplots(len(plots), 2, figsize=(15, len(plots) * 2.8))
    for row, (name, x, metrics) in enumerate(plots):
        fx.plot_pair(*axes[row], x, name, metrics)
    fig.suptitle('Minigun reports: actual decoded Opus waveforms and spectra', fontsize=14)
    fig.tight_layout(rect=(0, 0, 1, .975))
    fig.savefig(WORK / 'analysis/final-contact-sheet.png', dpi=140)
    plt.close(fig)
    manifest = dict(service='ElevenLabs Sound Effects', generated='2026-09-08', candidates=8,
        selections=records, rebuild='python tools/prepare-minigun-audio.py',
        source_note='Original API MP3 responses, decoded WAVs and receipts are retained in ignored artifacts.',
        review_basis='Candidate waveforms, spectra, decoded output, equal-level variants and actual game mix at 1200 RPM. Automated analysis does not assert subjective listening quality.',
        rejected='The heavy prompt family produced mostly low-frequency pulses with too little gun-report texture. Cannon candidate 2 was also too dull as a report.')
    (ROOT / 'public/assets/audio/elevenlabs-minigun-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (WORK / 'analysis/final-metrics.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
