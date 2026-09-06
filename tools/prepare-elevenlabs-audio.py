"""Rebuild selected ElevenLabs weapon reports from downloaded WAVs (ffmpeg)."""
import argparse
from array import array
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('sources', nargs='?', type=Path,
                    default=ROOT / '.artifacts/elevenlabs-audio/source')
args = parser.parse_args()
selections = [
    ('longarc', 'Single_powerful_sci-_#4-1788693297029.wav', .30, 1.40, 55, 9000),
    ('lance', 'Single_electric_lanc_#3-1788693253125.wav', 0, .55, 180, 9500),
    ('rocket', 'Single_shoulder-fire_#4-1788693253100.wav', .10, .75, 45, 8500),
]
records = []
for weapon, filename, start, end, highpass, lowpass in selections:
    source = args.sources / filename
    duration = end - start
    filters = (f'pan=mono|c0=0.5*c0+0.5*c1,atrim=start={start}:end={end},'
               f'asetpts=PTS-STARTPTS,highpass=f={highpass},lowpass=f={lowpass},'
               f'afade=t=in:d=0.001,afade=t=out:st={duration-.05}:d=0.05')
    raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(source),
                                   '-af', filters, '-ar', '48000', '-f', 'f32le', '-'])
    samples = array('f', raw)
    peak = max(map(abs, samples))
    gain = .70 / peak
    normalized = array('f', (x * gain for x in samples))
    output = ROOT / f'public/assets/audio/weapons/{weapon}/fire.ogg'
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', '48000',
                    '-ac', '1', '-i', '-', '-c:a', 'libopus', '-b:a', '96k', str(output)],
                   input=normalized.tobytes(), check=True)
    records.append(dict(weapon=weapon, source=filename,
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        trim_seconds=[start, end], highpass_hz=highpass, lowpass_hz=lowpass,
        fade_in_seconds=.001, fade_out_seconds=.05, mono='0.5L + 0.5R',
        peak_target=.70, normalization_gain=gain,
        output=str(output.relative_to(ROOT)),
        output_sha256=hashlib.sha256(output.read_bytes()).hexdigest()))
manifest = ROOT / 'public/assets/audio/weapons/elevenlabs-sources.json'
manifest.write_text(json.dumps(dict(service='ElevenLabs Sound Effects',
    generated='2026-09-06', selections=records), indent=2) + '\n')
print(json.dumps(records, indent=2))
