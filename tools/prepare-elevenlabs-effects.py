#!/usr/bin/env python3
"""Inspect and rebuild ElevenLabs game effects (ffmpeg, numpy, scipy, matplotlib).

Raw candidate WAVs remain in the ignored artifact directory. Run ``analyze``
before authoring recipes.json, then ``process`` to reproduce the selected assets.
All reported final measurements are made after decoding the actual Opus files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / ".artifacts/elevenlabs-effects-2026-09-07"
RATE = 48000
GROUPS = ("frag", "limpet", "pulse", "rocket", "pin", "throw", "minigun", "knife", "flame")


def decode(path):
    """Use arithmetic stereo average, avoiding ffmpeg's louder default downmix."""
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=channels", "-of", "json", str(path)]))
    channels = info["streams"][0]["channels"]
    args = ["ffmpeg", "-v", "error", "-i", str(path)]
    if channels == 2:
        args += ["-af", "pan=mono|c0=0.5*c0+0.5*c1"]
    elif channels != 1:
        raise ValueError(f"Unexpected {channels} channels in {path}")
    raw = subprocess.check_output(args + ["-ar", str(RATE), "-ac", "1", "-f", "f32le", "-"])
    return np.frombuffer(raw, dtype="<f4").astype(np.float64)


def rms_frames(x):
    block = RATE // 200  # 5 ms, non-overlapping
    padded = np.pad(x, (0, (-len(x)) % block))
    return np.sqrt(np.mean(padded.reshape(-1, block) ** 2, axis=1))


def measure(x):
    rms = rms_frames(x)
    peak = np.max(np.abs(x))
    energy = np.cumsum(x * x)
    spectrum = np.abs(np.fft.rfft(x)) ** 2
    frequencies = np.fft.rfftfreq(len(x), 1 / RATE)
    total = float(np.sum(spectrum))
    active = np.flatnonzero(rms > np.max(rms) * .08)
    sample_onset = np.flatnonzero(np.abs(x) > peak * .02)
    bands = ((0, 120), (120, 1000), (1000, 5000), (5000, 24001))
    return {
        "duration_seconds": len(x) / RATE,
        "peak": float(peak),
        "rms": float(np.sqrt(np.mean(x * x))),
        "peak_dbfs": float(20 * np.log10(max(peak, 1e-12))),
        "clipping_samples_at_0_999": int(np.sum(np.abs(x) >= .999)),
        "dc_mean": float(np.mean(x)),
        "onset_seconds_2pct_peak": float(sample_onset[0] / RATE) if len(sample_onset) else None,
        "onset_seconds_8pct_rms": float(active[0] * .005) if len(active) else None,
        "last_active_seconds_8pct_rms": float((active[-1] + 1) * .005) if len(active) else None,
        "rms_5ms_peak": float(np.max(rms)),
        "rms_5ms_peak_at_seconds": float(np.argmax(rms) * .005),
        "energy_seconds": {str(q): float(np.searchsorted(energy, energy[-1] * q / 100) / RATE)
                           for q in (50, 90, 95, 99)},
        "spectral_centroid_hz": float(np.sum(spectrum * frequencies) / max(total, 1e-30)),
        "energy_band_percent": {f"{lo}-{hi}Hz": float(100 * spectrum[(frequencies >= lo) &
            (frequencies < hi)].sum() / max(total, 1e-30)) for lo, hi in bands},
        "boundary_step": float(abs(x[-1] - x[0])),
        "sample_step_99pct": float(np.percentile(np.abs(np.diff(x)), 99)),
        "first_20ms_rms": float(np.sqrt(np.mean(x[:960] ** 2))),
        "last_20ms_rms": float(np.sqrt(np.mean(x[-960:] ** 2))),
        "rms_5ms_coefficient_of_variation": float(np.std(rms) / max(np.mean(rms), 1e-12)),
    }


def plot_pair(wave_ax, spec_ax, x, title, metric, limit=None):
    t = np.arange(len(x)) / RATE
    stride = max(1, len(x) // 7000)
    wave_ax.plot(t[::stride], x[::stride], color="#376eac", linewidth=.45)
    rms = rms_frames(x)
    wave_ax.plot(np.arange(len(rms)) * .005, rms, color="#d86033", linewidth=.8, label="5 ms RMS")
    wave_ax.set_ylim(-1, 1)
    wave_ax.set_xlim(0, len(x) / RATE)
    wave_ax.grid(alpha=.15)
    wave_ax.set_ylabel("amplitude")
    wave_ax.set_title(title, loc="left", fontsize=10, weight="bold")
    wave_ax.text(.985, .97, f'{metric["duration_seconds"]:.3f}s  peak {metric["peak"]:.3f}  '
                 f'RMS {metric["rms"]:.3f}\nonset {metric["onset_seconds_2pct_peak"]:.3f}s  '
                 f'90% energy {metric["energy_seconds"]["90"]:.3f}s',
                 transform=wave_ax.transAxes, ha="right", va="top", fontsize=8)
    if limit:
        wave_ax.axvline(limit, color="#cc3344", linewidth=.8, linestyle="--")
    freqs, times, sxx = signal.spectrogram(x, RATE, nperseg=512, noverlap=400, scaling="spectrum")
    db = 10 * np.log10(np.maximum(sxx, 1e-12))
    spec_ax.pcolormesh(times, freqs, db, shading="auto", cmap="magma", vmin=-90, vmax=-15,
                       rasterized=True)
    spec_ax.set_ylim(40, 20000)
    spec_ax.set_yscale("log")
    spec_ax.set_yticks([100, 1000, 10000], labels=["100", "1k", "10k"])
    spec_ax.set_xlim(0, len(x) / RATE)
    spec_ax.set_ylabel("Hz")
    wave_ax.set_xlabel("seconds")
    spec_ax.set_xlabel("seconds")


def analyze(groups):
    folder = WORK / "analysis"
    folder.mkdir(parents=True, exist_ok=True)
    records = {}
    for group in groups:
        paths = sorted((WORK / "source").glob(f"{group}-*.wav"))
        if not paths:
            continue
        fig, axes = plt.subplots(len(paths), 2, figsize=(15, 2.8 * len(paths)), squeeze=False)
        for row, path in enumerate(paths):
            x = decode(path)
            metrics = measure(x)
            records[path.name] = dict(sha256=hashlib.sha256(path.read_bytes()).hexdigest(), **metrics)
            plot_pair(*axes[row], x, path.name, metrics)
        fig.suptitle(f"ElevenLabs {group}: raw candidate waveform and spectrum\n"
                     "Arithmetic stereo average, 48 kHz; blue waveform, orange 5 ms RMS; spectrum -90 to -15 dB",
                     fontsize=12)
        fig.tight_layout(rect=(0, 0, 1, .95))
        fig.savefig(folder / f"{group}-candidates.png", dpi=135)
        plt.close(fig)
    target = folder / "candidates.json"
    previous = json.loads(target.read_text()) if target.exists() else {}
    previous.update(records)
    target.write_text(json.dumps(previous, indent=2) + "\n")
    print(json.dumps(records, indent=2))


def encode(x, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "1",
        "-i", "-", "-c:a", "libopus", "-b:a", "96k", "-fflags", "+bitexact", str(path)],
        input=x.astype("<f4").tobytes(), check=True)


def process():
    recipes_path = WORK / "recipes.json"
    manifest_path = ROOT / "public/assets/audio/elevenlabs-effects-sources.json"
    recipes = (json.loads(recipes_path.read_text()) if recipes_path.exists()
               else json.loads(manifest_path.read_text())["selections"])
    final = []
    plots = []
    for recipe in recipes:
        # The original 55 ms minigun report has been replaced by three heavier
        # reports. Historical regeneration must not overwrite the active assets.
        if recipe["id"] == "minigun":
            recipe = dict(recipe,
                output=".artifacts/elevenlabs-effects-2026-09-07/legacy-output/minigun-fire.ogg",
                replaced_by="public/assets/audio/elevenlabs-minigun-sources.json")
        source = WORK / "source" / recipe["source"]
        x = decode(source)
        source_energy = float(np.sum(x * x))
        start, end = recipe["trim_seconds"]
        x = x[round(start * RATE):round(end * RATE)]
        retained_energy = float(np.sum(x * x)) / max(source_energy, 1e-30) * 100
        raw = subprocess.check_output(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(RATE),
            "-ac", "1", "-i", "-", "-af",
            f'highpass=f={recipe["highpass_hz"]},lowpass=f={recipe["lowpass_hz"]}',
            "-f", "f32le", "-"], input=x.astype("<f4").tobytes())
        x = np.frombuffer(raw, dtype="<f4").astype(np.float64)
        if recipe.get("loop_crossfade_seconds"):
            count = round(recipe["loop_crossfade_seconds"] * RATE)
            # End reaches the original head smoothly, then wraps into its next
            # natural sample. Equal-power weights preserve the level of the
            # uncorrelated combustion noise during the overlap.
            w = np.linspace(0, 1, count)
            overlap = x[-count:] * np.cos(w * np.pi / 2) + x[:count] * np.sin(w * np.pi / 2)
            x = np.concatenate((x[count:-count], overlap))
        else:
            fade_in = round(recipe["fade_in_seconds"] * RATE)
            fade_out = round(recipe["fade_out_seconds"] * RATE)
            x[:fade_in] *= np.linspace(0, 1, fade_in)
            x[-fade_out:] *= np.linspace(1, 0, fade_out)
        gain = recipe["peak_target"] / np.max(np.abs(x))
        output = ROOT / recipe["output"]
        encode(x * gain, output)
        decoded = decode(output)
        # Opus changes reconstructed peaks. Calibrate from the encoded result
        # to keep the decoded peak close to, and below, the requested ceiling.
        corrections = []
        for _ in range(4):
            peak = np.max(np.abs(decoded))
            if recipe["peak_target"] * .97 <= peak <= recipe["peak_target"]:
                break
            correction = recipe["peak_target"] * .99 / peak
            corrections.append(float(correction))
            gain *= correction
            encode(x * gain, output)
            decoded = decode(output)
        metrics = measure(decoded)
        assert metrics["clipping_samples_at_0_999"] == 0
        assert metrics["peak"] <= recipe["peak_target"] + .005
        if recipe.get("max_duration_seconds"):
            assert metrics["duration_seconds"] <= recipe["max_duration_seconds"] + 1 / RATE
        if recipe.get("loop_crossfade_seconds"):
            # A wrap step below normal in-loop sample variation cannot create
            # an isolated amplitude discontinuity larger than the source noise.
            assert metrics["boundary_step"] <= metrics["sample_step_99pct"]
            fig, axes = plt.subplots(2, 1, figsize=(12, 5))
            repeated = np.tile(decoded, 3)
            times = np.arange(len(repeated)) / RATE
            axes[0].plot(times[::20], repeated[::20], linewidth=.45, color="#376eac")
            envelope = rms_frames(repeated)
            axes[0].plot(np.arange(len(envelope)) * .005, envelope, linewidth=.7, color="#d86033")
            for boundary in (metrics["duration_seconds"], 2 * metrics["duration_seconds"]):
                axes[0].axvline(boundary, color="#c33", linestyle="--", linewidth=.8)
            axes[0].set_title("Decoded flamethrower loop repeated three times; red lines are wraps")
            axes[0].set_xlabel("seconds")
            axes[0].set_ylabel("amplitude / 5 ms RMS")
            seam = np.concatenate((decoded[-240:], decoded[:240]))
            axes[1].plot((np.arange(len(seam)) - 240) / 48, seam, color="#376eac", linewidth=.7)
            axes[1].axvline(0, color="#c33", linestyle="--", linewidth=.8)
            axes[1].set_title(f'Decoded wrap step {metrics["boundary_step"]:.6f}; '
                              f'normal 99th-percentile step {metrics["sample_step_99pct"]:.6f}')
            axes[1].set_xlabel("milliseconds from wrap")
            axes[1].set_ylabel("amplitude")
            for ax in axes:
                ax.grid(alpha=.15)
            fig.tight_layout()
            fig.savefig(WORK / "analysis/flame-loop-seam.png", dpi=150)
            plt.close(fig)
        record = dict(recipe, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
            trim_energy_retained_percent=retained_energy,
            mono="0.5L + 0.5R for stereo; unchanged for mono", sample_rate_hz=RATE,
            codec="Opus", bitrate="96k", normalization_gain=float(gain),
            opus_peak_corrections=corrections, final_metrics=metrics,
            output_sha256=hashlib.sha256(output.read_bytes()).hexdigest())
        receipt_path = WORK / "api-source" / f"{source.stem}.json"
        if receipt_path.exists():
            receipt = json.loads(receipt_path.read_text())
            assert receipt["status"] == "complete"
            assert receipt["decoded_sha256"] == record["source_sha256"]
            raw_source = WORK / "api-source" / f"{source.stem}.mp3"
            assert hashlib.sha256(raw_source.read_bytes()).hexdigest() == receipt["raw_sha256"]
            record["generation"] = {
                key: receipt[key] for key in ("created_at", "endpoint", "output_format", "source_codec",
                    "request_body", "raw_sha256", "decoded_sha256", "decoded_sample_rate")}
            record["generation"]["method"] = "ElevenLabs API"
            record["generation"]["raw_source"] = raw_source.name
            record["generation"]["conversion_note"] = "API MP3 decoded to 48 kHz PCM WAV for analysis; " \
                "the WAV conversion preserves the decoded MP3 signal, not the uncompressed generated original."
        else:
            record.setdefault("generation", {"method": "ElevenLabs browser", "source_codec": "wav"})
        final.append(record)
        plots.append((recipe["id"], decoded, metrics))
    completed = [item["id"] for item in final]
    pending = [group for group in GROUPS if group not in completed]
    manifest = dict(service="ElevenLabs Sound Effects", generated="2026-09-07",
        coverage_status="partial" if pending else "complete",
        completed_effects=completed, pending_effects=pending,
        review_basis="Raw candidate waveforms, 5 ms RMS, spectrograms and decoded final measurements. "
        "No listening claim is made by the automated analysis.",
        rebuild="python tools/prepare-elevenlabs-effects.py process", selections=final)
    (ROOT / "public/assets/audio/elevenlabs-effects-sources.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (WORK / "analysis/final-metrics.json").write_text(json.dumps(manifest, indent=2) + "\n")
    fig, axes = plt.subplots(len(plots), 2, figsize=(15, len(plots) * 2.35), squeeze=False)
    for row, (name, x, metrics) in enumerate(plots):
        plot_pair(*axes[row], x, name, metrics)
    fig.suptitle("Selected game effects: actual decoded Opus waveforms and spectra\n"
                 "Mono 48 kHz, 96 kb/s; blue waveform, orange 5 ms RMS; spectrum -90 to -15 dB",
                 fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, .975))
    fig.savefig(WORK / "analysis/final-contact-sheet.png", dpi=130)
    plt.close(fig)
    rows = ["# ElevenLabs game effects analysis", "",
            "Selected by waveform, spectrum, timing and game playback constraints. "
            "All final numbers measure decoded Opus output. Listening is not asserted.", "",
            f'Completed: {", ".join(completed)}. '
            + (f'Pending generation: {", ".join(pending)}.' if pending else 'All requested effect groups are complete.'), "",
            "| Effect | Candidate | Duration | Onset | Peak | RMS | 90% energy | Clip samples |",
            "|---|---|---:|---:|---:|---:|---:|---:|"]
    for item in final:
        m = item["final_metrics"]
        rows.append(f'| {item["id"]} | {item["source"]} | {m["duration_seconds"]:.3f} s | '
                    f'{m["onset_seconds_2pct_peak"] * 1000:.1f} ms | {m["peak"]:.3f} | '
                    f'{m["rms"]:.3f} | {m["energy_seconds"]["90"]:.3f} s | '
                    f'{m["clipping_samples_at_0_999"]} |')
    rows += ["", "## Selection and preparation", ""]
    for item in final:
        rows += [f'### {item["id"]}', "", item["selection_rationale"], "",
                 f'Trim: {item["trim_seconds"]} seconds; high-pass {item["highpass_hz"]} Hz; '
                 f'low-pass {item["lowpass_hz"]} Hz.', ""]
        if item.get("loop_crossfade_seconds"):
            m = item["final_metrics"]
            rows += [f'Loop overlap: {item["loop_crossfade_seconds"]} s. Decoded boundary step '
                     f'{m["boundary_step"]:.6f}; normal 99th-percentile sample step '
                     f'{m["sample_step_99pct"]:.6f}. First/last 20 ms RMS '
                     f'{m["first_20ms_rms"]:.4f}/{m["last_20ms_rms"]:.4f}.', ""]
    (WORK / "analysis/report.md").write_text("\n".join(rows) + "\n")
    print(json.dumps([{k: item[k] for k in ("id", "source", "output", "final_metrics")}
                      for item in final], indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("analyze", "process"))
    parser.add_argument("--groups", nargs="+", choices=GROUPS, default=GROUPS)
    args = parser.parse_args()
    if args.command == "analyze":
        analyze(args.groups)
    else:
        process()
