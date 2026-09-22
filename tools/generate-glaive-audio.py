#!/usr/bin/env python3
"""Synthesize the GV-4 RIPTIDE throw report (weapons.glaive.fire) from scratch.

python3 tools/generate-glaive-audio.py

No recording, library or paid service is involved: every layer below is
generated with numpy/scipy from a fixed seed, so the output is reproducible.
The local ffmpeg has no libvorbis, so the .ogg is Ogg Opus (like every other
shipped sample). The record next to the asset holds the recipe and hashes.
"""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public/assets/audio/weapons/glaive/fire.ogg'
RECORD = ROOT / 'public/assets/audio/weapons/glaive/sources.json'
RATE = 48000
DURATION = 0.62
SEED = 4104
PEAK = 0.70

RECIPE = {
    'thunk': 'pneumatic launch: 118 Hz -> 46 Hz sine body, 2nd harmonic, 900 Hz lowpassed air burst',
    'whine': 'blade spin-up: 620 Hz -> 2050 Hz exponential saw sweep, 0.9 kHz..3 kHz bandpass, swell then release',
    'shing': 'steel tail: 7 inharmonic partials 2.87..9.6 kHz with 0.6..3 Hz beating, 5.5 kHz highpassed scrape',
}


def env(t, attack, decay, start=0.0):
    """Linear attack, exponential decay; silent before `start`."""
    local = t - start
    rise = np.clip(local / max(attack, 1e-6), 0, 1)
    fall = np.exp(-np.clip(local - attack, 0, None) / decay)
    return np.where(local < 0, 0.0, rise * fall)


def band(noise, low, high, order=2):
    sos = signal.butter(order, [low, high], btype='bandpass', fs=RATE, output='sos')
    return signal.sosfilt(sos, noise)


def synthesize():
    rng = np.random.default_rng(SEED)
    t = np.arange(int(DURATION * RATE)) / RATE

    # Pneumatic thunk: a falling sine body with a short choked air burst.
    body_hz = 46 + (118 - 46) * np.exp(-t / 0.035)
    body_phase = 2 * np.pi * np.cumsum(body_hz) / RATE
    thunk = (np.sin(body_phase) + 0.35 * np.sin(2 * body_phase)) * env(t, 0.0015, 0.055)
    air_sos = signal.butter(2, 900, btype='lowpass', fs=RATE, output='sos')
    air = signal.sosfilt(air_sos, rng.standard_normal(t.size)) * env(t, 0.0008, 0.022)
    thunk = 0.9 * thunk + 1.6 * air

    # Rising blade whine to about 2 kHz as the flywheel releases the disc.
    whine_hz = 620 * (2050 / 620) ** np.clip(t / 0.30, 0, 1)
    whine_phase = 2 * np.pi * np.cumsum(whine_hz) / RATE
    saw = signal.sawtooth(whine_phase) + 0.4 * np.sin(2 * whine_phase + 0.3)
    whine = band(saw, 900, 3000) * env(t, 0.12, 0.09, start=0.02)

    # Steel shing: inharmonic ring with slow beating, plus a bright scrape.
    partials = [(2870, 1.0, 0.6), (3410, 0.55, 1.3), (4380, 0.8, 0.9), (5210, 0.45, 2.1),
                (6130, 0.6, 1.7), (7740, 0.35, 2.6), (9600, 0.2, 3.0)]
    ring = np.zeros_like(t)
    for index, (hz, level, beat) in enumerate(partials):
        detuned = np.sin(2 * np.pi * (hz + beat) * t + index)
        ring += level * (np.sin(2 * np.pi * hz * t + 0.7 * index) + 0.6 * detuned)
    ring *= env(t, 0.004, 0.14, start=0.16)
    scrape_sos = signal.butter(2, 5500, btype='highpass', fs=RATE, output='sos')
    scrape = signal.sosfilt(scrape_sos, rng.standard_normal(t.size)) * env(t, 0.01, 0.05, start=0.15)

    mix = 1.0 * thunk + 0.8 * whine + 0.09 * ring + 0.22 * scrape
    # Short entrance and exit fades keep the edit boundary clean.
    mix *= np.clip(t / 0.001, 0, 1) * np.clip((DURATION - t) / 0.05, 0, 1)
    gain = PEAK / np.max(np.abs(mix))
    return (mix * gain).astype(np.float32), float(gain)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decoded_metrics(ffmpeg):
    raw = subprocess.check_output([ffmpeg, '-v', 'error', '-nostdin', '-i', str(OUTPUT),
                                   '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'])
    pcm = np.frombuffer(raw, dtype='<f4')
    peak = float(np.max(np.abs(pcm)))
    rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))
    return {'decoded_duration_seconds': round(pcm.size / RATE, 6),
            'sample_peak': round(peak, 6),
            'sample_peak_dbfs': round(20 * np.log10(max(peak, 1e-12)), 3),
            'rms_dbfs': round(20 * np.log10(max(rms, 1e-12)), 3),
            'clipped_samples': int(np.sum(np.abs(pcm) >= 1))}


def main():
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise SystemExit('ffmpeg required')
    mix, gain = synthesize()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([ffmpeg, '-v', 'error', '-nostdin', '-y', '-f', 'f32le', '-ar', str(RATE),
                    '-ac', '1', '-i', '-', '-c:a', 'libopus', '-b:a', '96k',
                    '-map_metadata', '-1', '-fflags', '+bitexact', str(OUTPUT)],
                   input=mix.tobytes(), check=True)
    metrics = decoded_metrics(ffmpeg)
    if metrics['sample_peak'] > 0.8 or metrics['clipped_samples']:
        raise SystemExit('encoded glaive report exceeded its peak budget')
    record = {
        'weapon': 'glaive',
        'source': 'Original procedural synthesis (numpy/scipy); no recordings or generated-audio services.',
        'generator': 'tools/generate-glaive-audio.py',
        'seed': SEED,
        'layers': RECIPE,
        'duration_seconds': DURATION,
        'fade_in_seconds': 0.001,
        'fade_out_seconds': 0.05,
        'peak_target': PEAK,
        'normalization_gain': gain,
        'encoding': 'Ogg Opus, mono 48 kHz, 96 kbit/s (local ffmpeg has no libvorbis)',
        'output': OUTPUT.relative_to(ROOT).as_posix(),
        'output_sha256': sha256(OUTPUT),
        'metrics': metrics,
        'qa': {'listening_audition': False,
               'note': 'Signal metrics and tools/analyze-weapon-audio.mjs checked; not auditioned.'},
    }
    RECORD.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
