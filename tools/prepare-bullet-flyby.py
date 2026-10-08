"""Cut the three close bullet fly-by variants (combat/bullet-whiz*.ogg) from a CC BY 3.0 Freesound recording.

Source: "Bullet passbys.wav" by Audionautics, https://freesound.org/people/Audionautics/sounds/134024/
(CC BY 3.0, https://creativecommons.org/licenses/by/3.0/). The uploader made it from pitched and
time-shifted layers of their own car pass-bys. It replaced a standard-license YouTube excerpt on 2026-10-08.

Usage: python3 -I tools/prepare-bullet-flyby.py [path/to/source.ogg]
The default source is the retained Freesound HQ preview in
.conquest-work/wip/sfx/downloads/fs-134024/source.ogg (local, git-ignored); its sha256 is checked.
Only ffmpeg is run; nothing from the download folder is executed.
"""
import hashlib, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.conquest-work/wip/sfx/downloads/fs-134024/source.ogg'
OUT = ROOT / 'public/assets/audio/combat'
PROVENANCE = ROOT / 'public/assets/audio/bullet-flyby-sources.json'
# (file, start, end, gain dB): single whizzes, the loudest 50 ms matched to about -20 dBFS RMS
# like the excerpts they replace.
CLIPS = [
    ('bullet-whiz.ogg', 7.12, 7.37, -7.7),
    ('bullet-whiz-2.ogg', 11.59, 11.84, -7.9),
    ('bullet-whiz-3.ogg', 12.62, 12.89, -8.1),
]
PROCESSING = ('Downmixed to mono, 48 kHz; high-pass 120 Hz; fixed gain so the loudest 50 ms sits near -20 dBFS RMS; '
              '2 ms fade-in and 40 ms fade-out; Opus 96 kbit/s (libopus, bitexact).')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    digest = sha(SOURCE)
    if PROVENANCE.exists():
        expected = json.loads(PROVENANCE.read_text()).get('download_sha256')
        if expected and expected != digest:
            sys.exit(f'source hash {digest} differs from the recorded {expected}')
    clips = []
    for name, start, end, gain in CLIPS:
        dur = end - start
        af = f'highpass=f=120,volume={gain}dB,afade=t=in:d=0.002,afade=t=out:st={dur - 0.04:.3f}:d=0.04'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', f'{start:.3f}', '-t', f'{dur:.3f}', '-i', str(SOURCE),
                        '-ac', '1', '-ar', '48000', '-af', af, '-map_metadata', '-1', '-fflags', '+bitexact',
                        '-c:a', 'libopus', '-b:a', '96k', str(OUT / name)], check=True)
        clips.append(dict(file=f'combat/{name}', start_seconds=start, end_seconds=end, gain_db=gain, sha256=sha(OUT / name)))
    manifest = dict(
        source_url='https://freesound.org/people/Audionautics/sounds/134024/',
        title='Bullet passbys.wav', author='Audionautics',
        license='CC BY 3.0', license_url='https://creativecommons.org/licenses/by/3.0/',
        attribution='"Bullet passbys.wav" by Audionautics (https://freesound.org/people/Audionautics/sounds/134024/), '
                    'CC BY 3.0. Cut, filtered, level-adjusted and encoded as Opus.',
        provenance='Uploader description: pitched and time-shifted layers of cars passing, run through a sampler with randomized LFOs.',
        retrieved='2026-10-08',
        file_url='https://cdn.freesound.org/previews/134/134024_2451120-hq.ogg',
        source_format='Freesound HQ preview (Ogg Vorbis); the original download requires a login',
        download_sha256=digest,
        replaces='Excerpts of https://www.youtube.com/watch?v=8hVB1kChbvA (standard YouTube license), removed 2026-10-08.',
        processing=PROCESSING, clips=clips)
    PROVENANCE.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(clips, indent=2))


if __name__ == '__main__':
    main()
