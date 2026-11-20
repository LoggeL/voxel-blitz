#!/usr/bin/env python3
"""Generate the SL-2 shuttle sound with Python and an Opus-enabled ffmpeg."""
from array import array
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public/assets/audio/weapons/selvedge"
RATE = 48000
DURATION = 0.57
SEED = 26581
TAU = math.tau


def resonances(audio, start, modes, rise=0.0007):
    """Strike a bank of modes. Each entry holds Hz, amplitude and decay time."""
    offset = round(start * RATE)
    for frequency, amplitude, decay in modes:
        for i in range(offset, len(audio)):
            t = (i - offset) / RATE
            envelope = -math.expm1(-t / rise) * math.exp(-t / decay)
            audio[i] += amplitude * envelope * math.sin(TAU * frequency * t)


def contact(audio, rng, start, level, low, high, decay):
    """Brief, damped rough contact, band-limited by two one-pole filters."""
    low_gain = -math.expm1(-TAU * low / RATE)
    high_gain = -math.expm1(-TAU * high / RATE)
    low_state = high_state = 0.0
    offset = round(start * RATE)
    end = min(len(audio), offset + round(decay * 7 * RATE))
    for i in range(offset, end):
        t = (i - offset) / RATE
        excitation = rng.uniform(-1, 1)
        low_state += low_gain * (excitation - low_state)
        high_state += high_gain * (excitation - high_state)
        envelope = -math.expm1(-t / 0.00045) * math.exp(-t / decay)
        audio[i] += level * (high_state - low_state) * envelope


def pluck(audio, start):
    """Modal response of a string plucked off-center and heard near its bridge."""
    offset = round(start * RATE)
    for harmonic in range(1, 19):
        pluck_weight = math.sin(math.pi * 0.21 * harmonic)
        bridge_weight = math.sin(math.pi * 0.16 * harmonic)
        amplitude = 0.95 * pluck_weight * bridge_weight / harmonic ** 1.45
        # Stiffness stretches upper partials, and short waves damp more quickly.
        hz = 236 * harmonic * math.sqrt(1 + 0.00016 * harmonic * harmonic)
        decay = 0.135 / (1 + 0.085 * harmonic ** 1.35)
        for i in range(offset, len(audio)):
            t = (i - offset) / RATE
            # Extra tension at release settles over the first few oscillations.
            cycles = hz * (t - 0.018 * 0.031 * math.expm1(-t / 0.018))
            envelope = -math.expm1(-t / 0.0015) * math.exp(-t / decay)
            audio[i] += amplitude * envelope * math.sin(TAU * cycles)


def synthesize():
    audio = array("d", [0]) * round(RATE * DURATION)
    rng = random.Random(SEED)
    # The blunt shuttle strike travels through the frame first.
    contact(audio, rng, 0, 0.97, 310, 4150, 0.009)
    resonances(audio, 0, [(167, 0.47, 0.027), (447, 0.29, 0.021),
                          (1249, 0.12, 0.013)])
    # The textile brushes the guide teeth, then the stretched strand releases.
    for at, strength in [(0.004, 0.37), (0.0085, 0.25), (0.014, 0.19)]:
        contact(audio, rng, at, strength, 780, 2700, 0.0035)
    pluck(audio, 0.0115)
    resonances(audio, 0.014, [(884, 0.21, 0.099), (891, 0.15, 0.114),
                              (2334, 0.062, 0.042), (3481, 0.029, 0.025)], 0.003)
    # Spring return has a dry detent and a smaller rebound in the housing.
    contact(audio, rng, 0.130, 0.59, 650, 3850, 0.004)
    resonances(audio, 0.130, [(584, 0.21, 0.013), (1637, 0.13, 0.008)])
    contact(audio, rng, 0.139, 0.20, 520, 2210, 0.003)
    peak = max(map(abs, audio))
    fade = round(0.027 * RATE)
    pcm = array("f", (x * 0.79 / peak * min(1, (len(audio) - 1 - i) / fade)
                       for i, x in enumerate(audio)))
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    output = DEST / "fire.ogg"
    ffmpeg = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    subprocess.run([*ffmpeg, "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "1",
                    "-i", "-", "-map_metadata", "-1", "-c:a", "libopus", "-b:a", "96k",
                    "-fflags", "+bitexact", str(output)], input=synthesize(), check=True)
    decoded = array("f")
    decoded.frombytes(subprocess.check_output([*ffmpeg, "-i", str(output),
                                               "-f", "f32le", "-ac", "1", "-"]))
    if sys.byteorder != "little":
        decoded.byteswap()
    peak = max(map(abs, decoded))
    rms = math.sqrt(sum(x * x for x in decoded) / len(decoded))
    if peak >= 0.85 or not 0.07 < rms < 0.16 or len(decoded) != round(RATE * DURATION):
        raise ValueError(f"Unexpected decoded levels or duration: {peak=}, {rms=}, {len(decoded)=}")
    record = {
        "weapon": "selvedge",
        "source": "Original procedural synthesis using damped resonators and a plucked-string modal model.",
        "generator": "tools/generate-selvedge-audio.py",
        "seed": SEED,
        "layers": {
            "shuttle": "Frame contact and guide chatter at 0, 4, 8.5 and 14 ms",
            "filament": "236 Hz strand, 18 damped partials, released at 11.5 ms",
            "tines": "Paired 884 and 891 Hz resonances with two short upper modes",
            "detent": "Bobbin catch at 130 ms, housing rebound at 139 ms",
        },
        "encoding": "Ogg Opus, mono 48 kHz, 96 kbit/s",
        "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "metrics": {
            "decoded_duration_seconds": len(decoded) / RATE,
            "sample_peak": round(peak, 6),
            "rms": round(rms, 6),
            "clipped_samples": sum(abs(x) >= 1 for x in decoded),
        },
    }
    (DEST / "sources.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record["metrics"]))


if __name__ == "__main__":
    main()
