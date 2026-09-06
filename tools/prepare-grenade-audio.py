#!/usr/bin/env python3
"""Rebuild the CC0 grenade samples and spectral evidence (requires ffmpeg)."""
import array
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.artifacts/grenade-audio-source'
OUT = ROOT / 'public/assets/audio/grenades'
URL = 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip'
SHA256 = '119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04'
RATE = 48000
WORK.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
archive = WORK / 'kenney.zip'
if not archive.exists():
    urllib.request.urlretrieve(URL, archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest() == SHA256, 'Source archive changed'
pack = zipfile.ZipFile(io.BytesIO(archive.read_bytes()))


def decode(name):
    source = pack.read('Audio/' + name)
    pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-ac', '1',
                                   '-ar', str(RATE), '-f', 'f32le', 'pipe:1'], input=source)
    data = array.array('f', pcm)
    peak = max(map(abs, data))
    onset = next(i for i, value in enumerate(data) if abs(value) > peak * 0.015)
    start = max(0, onset - 48)
    return data[start:], start / RATE


recipes = {
    'frag': [('explosionCrunch_000.ogg', 1.0), ('lowFrequency_explosion_001.ogg', 0.30)],
    'limpet': [('explosionCrunch_004.ogg', 0.85), ('lowFrequency_explosion_000.ogg', 0.50)],
    'pulse': [('forceField_002.ogg', 1.0), ('lowFrequency_explosion_001.ogg', 0.16)],
}
metadata = {'author': 'Kenney', 'license': 'CC0-1.0',
            'sourcePage': 'https://kenney.nl/assets/sci-fi-sounds',
            'archiveUrl': URL, 'archiveSha256': SHA256, 'samples': {}}
for kind, recipe in recipes.items():
    source_file = WORK / recipe[0][0]
    source_file.write_bytes(pack.read('Audio/' + recipe[0][0]))
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source_file), '-lavfi',
        'showspectrumpic=s=1100x450:legend=1:scale=log:fscale=log', str(WORK / f'{kind}-source.png')], check=True)
    layers = [(name, gain, *decode(name)) for name, gain in recipe]
    length = max(len(data) for _, _, data, _ in layers)
    mixed = array.array('f', [0.0]) * length
    for _, gain, data, _ in layers:
        for i, value in enumerate(data):
            mixed[i] += value * gain
    filtered = subprocess.check_output(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(RATE),
        '-ac', '1', '-i', 'pipe:0', '-af', 'highpass=f=35,lowpass=f=10500',
        '-f', 'f32le', 'pipe:1'], input=mixed.tobytes())
    data = array.array('f', filtered)
    gain = 0.82 / max(map(abs, data))
    for i in range(len(data)):
        # Submillisecond attack and 80 ms tail avoid edit clicks while keeping the transient.
        fade = min(1, i / 24, (len(data) - i - 1) / 3840)
        data[i] *= gain * fade
    target = OUT / f'{kind}.ogg'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '1',
        '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '96k', str(target)], input=data.tobytes(), check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(target), '-lavfi',
        'showspectrumpic=s=1100x450:legend=1:scale=log:fscale=log', str(WORK / f'{kind}-final.png')], check=True)
    metadata['samples'][kind] = {
        'layers': [{'file': name, 'gain': gain, 'trimStartSeconds': start} for name, gain, _, start in layers],
        'durationSeconds': len(data) / RATE,
        'peak': max(map(abs, data)),
        'rms': math.sqrt(sum(x*x for x in data) / len(data)),
        'outputSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
    }
(OUT / 'sources.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata['samples'], indent=2))
