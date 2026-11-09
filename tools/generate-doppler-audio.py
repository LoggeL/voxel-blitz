#!/usr/bin/env python3
"""Synthesize the SP-2 DOPPLER reports from a fixed seed (numpy only, no recordings).

  python3 tools/generate-doppler-audio.py

fire.ogg         the doublet: two reports 33 ms apart, the recoiling unit meeting
                 its buffer at 47 ms and running home
fire-single.ogg  a magazine's last odd round: one report and a short stroke

The local ffmpeg has no libvorbis, so the .ogg files are Ogg Opus like every
other weapon bank. Timings mirror WEAPONS.doppler.doublet.gapMs and
DOPPLER_BUFFER_S in public/js/guns/doppler-presentation.js.
"""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/assets/audio/weapons/doppler'
RATE = 48000
SEED = 20261109
GAP = 0.033
BUFFER = 0.047
PEAK = 0.78
DURATION = {'fire.ogg': 0.46, 'fire-single.ogg': 0.40}


def band(noise, lo, hi):
    """Zero-phase FFT band-pass (Hz) with raised-cosine edges."""
    spec = np.fft.rfft(noise)
    freq = np.fft.rfftfreq(len(noise), 1 / RATE)
    gain = np.ones_like(freq)
    if lo:
        gain *= np.clip((freq - lo * 0.7) / (lo * 0.3), 0, 1)
    if hi:
        gain *= np.clip((hi * 1.3 - freq) / (hi * 0.3), 0, 1)
    gain = 0.5 - 0.5 * np.cos(np.pi * gain)
    return np.fft.irfft(spec * gain, len(noise))


def report(rng, length, pitch=1.0):
    """One dry rifle report: supersonic crack, powder body, chest thump and a short open-air tail."""
    t = np.arange(length) / RATE
    white = rng.standard_normal(length)
    crack = band(white, 1800 * pitch, 9000) * np.exp(-t / 0.0065)
    body = band(rng.standard_normal(length), 260 * pitch, 1500 * pitch) * np.exp(-t / 0.026)
    sweep = 2 * np.pi * np.cumsum(55 + 105 * pitch * np.exp(-t / 0.018)) / RATE
    thump = np.sin(sweep) * np.exp(-t / 0.038)
    tail = band(rng.standard_normal(length), 320, 2600) * np.exp(-t / 0.085) * (1 - np.exp(-t / 0.006))
    attack = 1 - np.exp(-t / 0.0004)
    return attack * (0.95 * crack + 0.80 * body + 0.72 * thump + 0.16 * tail)


def clack(rng, length, weight=1.0):
    """Steel on a polymer buffer: three damped partials and a short click."""
    t = np.arange(length) / RATE
    ping = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t / d)
               for f, a, d in ((1840, 0.50, 0.011), (2930, 0.34, 0.008), (4410, 0.20, 0.005)))
    click = band(rng.standard_normal(length), 900, 5200) * np.exp(-t / 0.0035)
    return weight * (0.55 * ping + 0.5 * click)


def place(mix, signal, at):
    start = int(round(at * RATE))
    end = min(len(mix), start + len(signal))
    mix[start:end] += signal[:end - start]


def synthesize(rounds, seconds):
    rng = np.random.default_rng(SEED + rounds)
    n = int(seconds * RATE)
    mix = np.zeros(n)
    place(mix, report(rng, n, 1.0), 0.0)
    if rounds == 2:
        # The second round leaves with the unit already moving: a shade lower and softer.
        place(mix, 0.92 * report(rng, n, 0.94), GAP)
        place(mix, clack(rng, int(0.06 * RATE), 0.20), BUFFER)
        place(mix, clack(rng, int(0.05 * RATE), 0.09), BUFFER + 0.118)
    else:
        place(mix, clack(rng, int(0.05 * RATE), 0.11), 0.018)
        place(mix, clack(rng, int(0.05 * RATE), 0.07), 0.118)
    mix = np.tanh(mix * 1.5)
    fade = int(0.06 * RATE)
    mix[-fade:] *= np.linspace(1, 0, fade) ** 2
    gain = PEAK / np.max(np.abs(mix))
    return (mix * gain).astype(np.float32), float(gain)


def decoded(ffmpeg, path):
    raw = subprocess.check_output([ffmpeg, '-v', 'error', '-nostdin', '-i', str(path), '-f', 'f32le', '-ac', '1',
                                   '-ar', str(RATE), '-'])
    data = np.frombuffer(raw, np.float32)
    return {'sample_peak': round(float(np.max(np.abs(data))), 4), 'rms': round(float(np.sqrt(np.mean(data ** 2))), 4),
            'seconds': round(len(data) / RATE, 3), 'clipped_samples': int(np.sum(np.abs(data) >= 0.999))}


def main():
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise SystemExit('ffmpeg required')
    OUT.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, rounds in (('fire.ogg', 2), ('fire-single.ogg', 1)):
        mix, gain = synthesize(rounds, DURATION[name])
        path = OUT / name
        subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', '-',
                        '-c:a', 'libopus', '-b:a', '96k', '-map_metadata', '-1', '-fflags', '+bitexact', str(path)],
                       input=mix.tobytes(), check=True)
        metrics = decoded(ffmpeg, path)
        if metrics['sample_peak'] > 0.9 or metrics['clipped_samples']:
            raise SystemExit(f'{name} exceeded its peak budget: {metrics}')
        files[name] = {'rounds': rounds, 'normalization_gain': round(gain, 5), 'metrics': metrics,
                       'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    record = {
        'weapon': 'doppler',
        'source': 'Original procedural synthesis (numpy); no recordings or generated-audio services.',
        'generator': 'tools/generate-doppler-audio.py', 'seed': SEED,
        'doublet_gap_seconds': GAP, 'buffer_seconds': BUFFER, 'peak_target': PEAK,
        'encoding': 'Ogg Opus, mono 48 kHz, 96 kbit/s (local ffmpeg has no libvorbis)',
        'files': files,
        'qa': {'listening_audition': False, 'note': 'Synthesized and level-checked only; not auditioned by ear.'},
    }
    (OUT / 'sources.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({name: info['metrics'] for name, info in files.items()}))


if __name__ == '__main__':
    main()
