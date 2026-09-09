#!/usr/bin/env python3
"""Trim, level and audit retained ElevenLabs pain vocals for game playback.

Requires ffmpeg, NumPy, SciPy and Matplotlib. Originals and API receipts remain
in .artifacts/elevenlabs-pain-2026-09-09; generated sources are never overwritten.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/elevenlabs-pain-2026-09-09'
spec = importlib.util.spec_from_file_location('effects', ROOT / 'tools/prepare-elevenlabs-effects.py')
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
np, plt, RATE = fx.np, fx.plt, fx.RATE


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    analysis = WORK / 'analysis'
    analysis.mkdir(parents=True, exist_ok=True)
    output_dir = ROOT / 'public/assets/audio/human'
    output_dir.mkdir(parents=True, exist_ok=True)
    records, originals, finals = [], [], []
    for tier, target in [('light', .35), ('medium', .48), ('heavy', .64)]:
        for variant in range(1, 4):
            stem = f'pain-{tier}-{variant}'
            source = WORK / 'source' / f'{stem}.wav'
            raw = WORK / 'api-source' / f'{stem}.mp3'
            receipt = json.loads((WORK / 'api-source' / f'{stem}.json').read_text())
            assert receipt['status'] == 'complete'
            assert digest(source) == receipt['decoded_sha256']
            assert digest(raw) == receipt['raw_sha256']
            original = fx.decode(source)
            original_metrics = fx.measure(original)
            originals.append((stem, original, original_metrics))
            envelope = fx.rms_frames(original)
            active = np.flatnonzero(envelope > max(.001, envelope.max() * .04))
            assert len(active), f'{stem}: no audible vocal'
            start = max(0, int((active[0] * .005 - .015) * RATE))
            end = min(len(original), int(((active[-1] + 1) * .005 + .07) * RATE))
            pcm = original[start:end]
            filtered = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'f32le',
                '-ar', str(RATE), '-ac', '1', '-i', '-', '-af', 'highpass=f=75,lowpass=f=8000',
                '-f', 'f32le', '-'], input=pcm.astype('<f4').tobytes())
            pcm = np.frombuffer(filtered, dtype='<f4').astype(np.float64)
            pcm[:round(.006 * RATE)] *= np.linspace(0, 1, round(.006 * RATE))
            pcm[-round(.04 * RATE):] *= np.linspace(1, 0, round(.04 * RATE))
            gain = target / np.max(np.abs(pcm))
            filename = f'pain-{tier}{"" if variant == 1 else "-" + str(variant)}.ogg'
            output = output_dir / filename
            for _ in range(4):
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE),
                    '-ac', '1', '-i', '-', '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on',
                    '-metadata', 'comment=Original ElevenLabs Sound Effects generation', str(output)],
                    input=(pcm * gain).astype('<f4').tobytes(), check=True)
                final = fx.decode(output)
                peak = np.max(np.abs(final))
                if target * .97 <= peak <= target:
                    break
                gain *= target * .99 / peak
            metrics = fx.measure(final)
            assert metrics['clipping_samples_at_0_999'] == 0
            assert .15 < metrics['duration_seconds'] < 2
            assert metrics['peak'] <= target + .005
            assert metrics['onset_seconds_2pct_peak'] < .06
            record = dict(tier=tier, variant=variant,
                slot=f'human.pain.{tier}{"" if variant == 1 else "." + str(variant)}',
                output=str(output.relative_to(ROOT)), output_sha256=digest(output),
                source=str(source.relative_to(ROOT)), source_sha256=digest(source),
                raw_source=str(raw.relative_to(ROOT)), raw_sha256=digest(raw),
                trim_seconds=[start / RATE, end / RATE], fade_in_seconds=.006, fade_out_seconds=.04,
                highpass_hz=75, lowpass_hz=8000, normalization_gain=float(gain),
                target_peak=target, sample_rate_hz=RATE, channels=1, codec='Opus', bitrate='64k',
                original_metrics=original_metrics, final_metrics=metrics,
                generation={key: receipt[key] for key in ['created_at', 'request_body', 'character_cost', 'request_id']})
            records.append(record)
            finals.append((stem, final, metrics))
            print(stem, json.dumps({key: metrics[key] for key in
                ['duration_seconds', 'peak', 'rms', 'onset_seconds_2pct_peak']}))
    manifest = dict(service='ElevenLabs Sound Effects', model='eleven_text_to_sound_v2',
        generated='2026-09-09', candidates=len(records),
        credits=sum(int(item['generation']['character_cost']) for item in records),
        review_basis='Decoded waveform, 5 ms RMS, spectrogram, source hashes, clipping and runtime mix checks. '
            'No listening approval is asserted.',
        source_note='Original generated vocal effects; no third-party recordings or reference voices supplied. '
            'Use governed by the generating ElevenLabs account terms.',
        rebuild='python3 tools/prepare-pain-audio.py', selections=records)
    (ROOT / 'public/assets/audio/elevenlabs-pain-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for name, plots in [('originals', originals), ('processed', finals)]:
        fig, axes = plt.subplots(len(plots), 2, figsize=(14, 23))
        for row, (title, pcm, metrics) in enumerate(plots):
            fx.plot_pair(*axes[row], pcm, title, metrics)
        fig.tight_layout()
        fig.savefig(analysis / f'{name}.png', dpi=100)
        plt.close(fig)
    (analysis / 'metrics.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
