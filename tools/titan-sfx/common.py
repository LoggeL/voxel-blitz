"""Paths and decode helpers for the titan weapon SFX build (docs/audio/titan-sfx.md).
TITAN_SFX_WORK: work root (built files, parts); TITAN_SFX_DL: source downloads (default <work>/downloads).
Defaults keep downloaded data outside the repository. Nothing from DL is executed."""
import os, subprocess, numpy as np, json, hashlib, pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
ROOT = pathlib.Path(os.environ.get('TITAN_SFX_WORK') or pathlib.Path.home() / 'voxel-blitz-sfx-handoff' / 'sfx-work-20261013')
DL = pathlib.Path(os.environ.get('TITAN_SFX_DL') or ROOT / 'downloads')
if DL.resolve().is_relative_to(REPO): raise ValueError('TITAN_SFX_DL must be outside the repository')
SR = 48000
def decode(path, start=None, dur=None, channels=1, sr=SR):
    cmd = ['ffmpeg', '-v', 'error', '-nostdin']
    if start is not None: cmd += ['-ss', f'{start:.4f}']
    if dur is not None: cmd += ['-t', f'{dur:.4f}']
    cmd += ['-i', str(path), '-ac', str(channels), '-ar', str(sr), '-f', 'f32le', '-']
    x = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype=np.float32).astype(np.float64)
    return x.reshape(-1, channels) if channels > 1 else x
def src(name):
    d = DL / name
    for f in sorted(d.iterdir()):
        if f.name.startswith('source.') and not f.name.endswith('.json'): return f
def meta(name):
    d = DL / name
    if (d / 'meta.json').exists(): return json.loads((d / 'meta.json').read_text())
    m = json.loads((d / 'source.info.json').read_text())
    return dict(source='youtube', id=m['id'], url=m['webpage_url'], title=m['title'], author=m['channel'], license=m['license'],
                description=(m.get('description') or '')[:400], upload_date=m.get('upload_date'))
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
