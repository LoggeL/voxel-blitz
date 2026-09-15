#!/usr/bin/env python3
"""Analyze sources, then rebuild manually selected ElevenLabs footfalls.

Requires ffmpeg, numpy, scipy and matplotlib. `analyze` is read-only for audio;
`process` uses reviewed cuts from docs/audio/footstep-recipes.json. Measurements
and plots always inspect the decoded final Opus, including codec overshoot.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-footsteps-2026-09-16'
DOCS = ROOT / 'docs/audio/footsteps'
spec = importlib.util.spec_from_file_location('effects', ROOT / 'tools/prepare-elevenlabs-effects.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
np, plt, RATE = fx.np, fx.plt, fx.RATE
SURFACES = ['stone', 'wood', 'metal', 'grass', 'gravel', 'sand', 'cloth']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plot_group(entries, output):
    fig, axes = plt.subplots(len(entries), 2, figsize=(14, 3 * len(entries)), squeeze=False)
    for row, (title, pcm, metrics) in enumerate(entries):
        fx.plot_pair(*axes[row], pcm, title, metrics)
        # Auto-scale quiet originals so their attack shape remains visible.
        peak = max(metrics['peak'] * 1.15, .001)
        axes[row, 0].set_ylim(-peak, peak)
    fig.tight_layout()
    fig.savefig(output, dpi=110)
    plt.close(fig)


def analyze():
    analysis = WORK / 'analysis'
    analysis.mkdir(parents=True, exist_ok=True)
    records = {}
    for surface in SURFACES:
        entries = []
        for path in sorted((WORK / 'source').glob(f'step-{surface}-*.wav')):
            pcm = fx.decode(path)
            metrics = fx.measure(pcm)
            records[path.stem] = metrics
            entries.append((path.stem, pcm, metrics))
        if entries:
            plot_group(entries, analysis / f'raw-{surface}.png')
    (analysis / 'raw-metrics.json').write_text(json.dumps(records, indent=2) + '\n')
    print(f'Analyzed {len(records)} originals in {analysis}')


def process():
    recipes = json.loads((DOCS / 'recipes.json').read_text())
    output_dir = ROOT / 'public/assets/audio/movement'
    output_dir.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)
    records = []
    plots = {surface: [] for surface in SURFACES}
    for surface in SURFACES:
        selections = recipes['surfaces'][surface]
        assert len(selections) == 3, f'{surface}: exactly three reviewed variants required'
        for variant, recipe in enumerate(selections, 1):
            stem = recipe['source']
            source = WORK / 'source' / f'{stem}.wav'
            raw = WORK / 'api-source' / f'{stem}.mp3'
            receipt = json.loads((WORK / 'api-source' / f'{stem}.json').read_text())
            assert receipt['status'] == 'complete'
            assert digest(source) == receipt['decoded_sha256']
            assert digest(raw) == receipt['raw_sha256']
            original = fx.decode(source)
            start, end = recipe['trim_seconds']
            assert 0 <= start < end <= len(original) / RATE
            pcm = original[round(start * RATE):round(end * RATE)]
            # Remove infrasonic generated drift, retain shoe body and texture.
            filtered = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'f32le',
                '-ar', str(RATE), '-ac', '1', '-i', '-', '-af', 'highpass=f=85,lowpass=f=8500',
                '-f', 'f32le', '-'], input=pcm.astype('<f4').tobytes())
            pcm = np.frombuffer(filtered, dtype='<f4').astype(np.float64)
            if 'decay_after_seconds' in recipe:
                elapsed = np.maximum(0, np.arange(len(pcm)) / RATE - recipe['decay_after_seconds'])
                pcm *= np.exp(-elapsed / recipe['decay_tau_seconds'])
            pcm[:round(.003 * RATE)] *= np.linspace(0, 1, round(.003 * RATE))
            pcm[-round(.045 * RATE):] *= np.linspace(1, 0, round(.045 * RATE)) ** 2
            # Match the body of the step, not only a single transient sample.
            window = round(.04 * RATE)
            cumulative = np.concatenate(([0.], np.cumsum(pcm * pcm)))
            body_rms = np.sqrt(np.max(cumulative[window:] - cumulative[:-window]) / window)
            target = recipes['body_rms'][surface]
            gain = min(target / max(body_rms, 1e-9), .55 / np.max(np.abs(pcm)))
            output = output_dir / f'footstep-{surface}-{variant}.ogg'
            for _ in range(4):
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE),
                    '-ac', '1', '-i', '-', '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on',
                    '-metadata', 'comment=Original ElevenLabs Sound Effects footfall', str(output)],
                    input=(pcm * gain).astype('<f4').tobytes(), check=True)
                final = fx.decode(output)
                if np.max(np.abs(final)) <= .56:
                    break
                gain *= .55 / np.max(np.abs(final))
            metrics = fx.measure(final)
            assert metrics['clipping_samples_at_0_999'] == 0, stem
            assert metrics['peak'] <= .56, stem
            assert .08 <= metrics['duration_seconds'] <= .36, stem
            assert metrics['onset_seconds_2pct_peak'] <= .018, (stem, metrics)
            assert metrics['rms_5ms_peak_at_seconds'] <= .075, (stem, metrics)
            assert metrics['energy_seconds']['90'] <= .235, (stem, metrics)
            assert abs(metrics['dc_mean']) < .002, (stem, metrics)
            assert metrics['last_20ms_rms'] < .004, (stem, metrics)
            record = dict(surface=surface, variant=variant,
                slot=f'movement.footstep.{surface}.{variant}',
                output=str(output.relative_to(ROOT)), output_sha256=digest(output),
                source=str(source.relative_to(ROOT)), source_sha256=digest(source),
                raw_source=str(raw.relative_to(ROOT)), raw_sha256=digest(raw),
                trim_seconds=[start, end], fade_in_seconds=.003, fade_out_seconds=.045, fade_out_curve='quadratic',
                highpass_hz=85, lowpass_hz=8500, normalization_gain=float(gain),
                decay_after_seconds=recipe.get('decay_after_seconds'), decay_tau_seconds=recipe.get('decay_tau_seconds'),
                target_body_rms_40ms=target, sample_rate_hz=RATE, channels=1, codec='Opus', bitrate='64k',
                selection_reason=recipe['reason'], original_metrics=fx.measure(original), final_metrics=metrics,
                generation={key: receipt.get(key) for key in ['created_at', 'request_body', 'character_cost', 'request_id']})
            records.append(record)
            plots[surface].append((f'{surface} {variant} ({stem})', final, metrics))
            print(f'{surface} {variant}: {metrics["duration_seconds"]:.3f}s, peak {metrics["peak"]:.3f}, '
                  f'attack {metrics["rms_5ms_peak_at_seconds"] * 1000:.0f}ms', flush=True)
    for surface, entries in plots.items():
        plot_group(entries, DOCS / f'{surface}-waveforms.png')
    receipts = [json.loads(path.read_text()) for path in (WORK / 'api-source').glob('*.json')]
    completed = [receipt for receipt in receipts if receipt['status'] == 'complete']
    manifest = dict(service='ElevenLabs Sound Effects', model='eleven_text_to_sound_v2',
        generated='2026-09-16', candidates=len(completed), selected=len(records),
        credits=sum(int(receipt.get('character_cost') or 0) for receipt in completed),
        review_basis='Visual waveform and spectrogram inspection, explicit single-footfall cuts, '
            'decoded Opus timing, DC, clipping and tail checks. No subjective listening approval is asserted.',
        api_reference='https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert',
        source_note='Original generated Foley; no third-party recordings supplied. Generating account terms apply.',
        rebuild='python3 tools/prepare-footstep-audio.py process',
        rejected=recipes['rejected'], selections=records)
    (ROOT / 'public/assets/audio/elevenlabs-footstep-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['analyze', 'process'])
    args = parser.parse_args()
    (analyze if args.action == 'analyze' else process)()
