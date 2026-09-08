#!/usr/bin/env python3
"""Rebuild physical hit foley from retained original ElevenLabs API responses.

Requires ffmpeg, NumPy, SciPy and Matplotlib. This recipe uses no Counter-Strike
recordings. Six API responses and receipts live in the ignored WORK directory.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-hits-2026-09-08'
spec = importlib.util.spec_from_file_location('effects', ROOT / 'tools/prepare-elevenlabs-effects.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
fx.WORK = WORK
np, plt, RATE = fx.np, fx.plt, fx.RATE

RECIPES = [
    dict(id='hit-body', source='hitbody-2.wav', trim=[0, .105], highpass=95, lowpass=5500,
         peak=.40, fade_out=.020, output='ui/hitmark-body.ogg',
         reason='Candidate 2 has one immediate dense vest/body thud, followed by fine fabric texture. Candidate 1 has a more pronounced bass oscillation; candidate 3 is dominated by prolonged sub-bass. Preserve the physical low mids and broadband slap instead of reducing the source to a UI tick.'),
    dict(id='hit-head', source='hithead-2.wav', trim=[0, .115], highpass=150, lowpass=8500,
         peak=.58, fade_out=.025, output='ui/hitmark-head.ogg',
         reason='Candidate 2 has a dense early broadband crack and short crunchy decay. Candidate 1 contains separated weak ticks; candidate 3 is almost entirely low-frequency/DC noise. One source sample reaches full scale, with no clipped plateau; filtering and level reduction retain the transient and the final recording has no full-scale samples.'),
    dict(id='flesh', source='hitbody-1.wav', trim=[0, .125], highpass=85, lowpass=2800,
         peak=.38, fade_out=.025, output='impacts/flesh.ogg',
         reason='Candidate 1 supplies a separate rounded incoming body thud with a short physical attack. The narrower upper range and existing damage-scaled flesh cap keep this impact underneath the victim pain voice.'),
]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analyze', action='store_true')
    args = parser.parse_args()
    (WORK / 'analysis').mkdir(parents=True, exist_ok=True)
    if args.analyze:
        fx.analyze(['hitbody', 'hithead'])
    records, plots = [], []
    previous = WORK / 'previous/public/assets/audio'
    for recipe in RECIPES:
        source = WORK / 'source' / recipe['source']
        receipt = json.loads((WORK / 'api-source' / (source.stem + '.json')).read_text())
        assert receipt['status'] == 'complete'
        assert sha256(source) == receipt['decoded_sha256']
        assert sha256(WORK / 'api-source' / (source.stem + '.mp3')) == receipt['raw_sha256']
        original = fx.decode(source)
        start, end = recipe['trim']
        x = original[round(start * RATE):round(end * RATE)]
        filtered = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE),
            '-ac', '1', '-i', '-', '-af', f'highpass=f={recipe["highpass"]},lowpass=f={recipe["lowpass"]}',
            '-f', 'f32le', '-'], input=x.astype('<f4').tobytes())
        x = np.frombuffer(filtered, dtype='<f4').astype(np.float64)
        attack = round(.0006 * RATE)
        x[:attack] *= np.linspace(0, 1, attack)
        release = round(recipe['fade_out'] * RATE)
        x[-release:] *= np.linspace(1, 0, release)
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
        assert metrics['energy_seconds']['99'] < .100
        old_path = previous / recipe['output']
        record = dict(recipe, mono='0.5L + 0.5R', sample_rate_hz=RATE, codec='Opus', bitrate='96k',
            fade_in_seconds=.0006, normalization_gain=float(gain), final_metrics=metrics,
            output=str(output.relative_to(ROOT)), output_sha256=sha256(output),
            source_full_scale_samples=fx.measure(original)['clipping_samples_at_0_999'],
            previous_output_sha256=sha256(old_path), previous_metrics=fx.measure(fx.decode(old_path)),
            generation={key: receipt[key] for key in ['created_at', 'output_format', 'source_codec',
                'request_body', 'raw_sha256', 'decoded_sha256']})
        records.append(record)
        plots.append((recipe['id'], decoded, metrics))
        print(recipe['id'], json.dumps({k: metrics[k] for k in ['duration_seconds', 'peak', 'rms',
            'onset_seconds_2pct_peak', 'spectral_centroid_hz', 'energy_seconds']}))
    body, head = records[:2]
    assert head['final_metrics']['spectral_centroid_hz'] > body['final_metrics']['spectral_centroid_hz'] * 1.4
    assert head['final_metrics']['rms'] > body['final_metrics']['rms']
    manifest = dict(service='ElevenLabs Sound Effects', generated='2026-09-08', candidates=6,
        credits=sum(int(json.loads(p.read_text())['character_cost']) for p in (WORK / 'api-source').glob('*.json')),
        selections=records, review_basis='Candidate waveform, 5 ms RMS and spectrogram review; decoded '
        'Opus level, onset, energy and spectral measurements. Listening is not asserted.',
        rebuild='python tools/prepare-tactical-hit-audio.py',
        source_note='Original generated physical impact foley; no game recordings or third-party samples used. '
        'API MP3 responses, decoded WAV files and request receipts are retained locally.')
    (ROOT / 'public/assets/audio/elevenlabs-tactical-hit-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (WORK / 'analysis/final-metrics.json').write_text(json.dumps(manifest, indent=2) + '\n')
    fig, axes = plt.subplots(len(plots), 2, figsize=(15, 8.5))
    for row, (name, x, metrics) in enumerate(plots):
        fx.plot_pair(*axes[row], x, name, metrics)
    fig.suptitle('Physical hit foley: actual decoded Opus waveform and spectrum', fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, .97))
    fig.savefig(WORK / 'analysis/final-contact-sheet.png', dpi=135)
    plt.close(fig)
    lines = ['# Physical hit foley', '', '| Cue | Duration | Peak | RMS | 99% energy | Centroid |',
             '|---|---:|---:|---:|---:|---:|']
    for item in records:
        m = item['final_metrics']
        lines.append(f'| {item["id"]} | {m["duration_seconds"]:.3f} s | {m["peak"]:.3f} | '
            f'{m["rms"]:.3f} | {m["energy_seconds"]["99"] * 1000:.1f} ms | {m["spectral_centroid_hz"]:.0f} Hz |')
    lines += ['', 'Six candidates, 30 recorded credits. Existing kill confirmation recordings are retained.',
              'Candidate selection uses waveform and spectral evidence; no listening approval is claimed.', '']
    for item in records:
        lines += [f'## {item["id"]}', '', item['reason'], '']
    (WORK / 'analysis/report.md').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
