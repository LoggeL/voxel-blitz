import os, subprocess, numpy as np, json, hashlib, pathlib
ROOT = pathlib.Path(os.environ.get('CONQUEST_SFX_WORK') or pathlib.Path(__file__).resolve().parents[3] / '.conquest-work' / 'wip' / 'sfx')
DL = ROOT / 'downloads'
SR = 48000
def decode(path, start=None, dur=None, channels=1, sr=SR):
    cmd = ['ffmpeg', '-v', 'error', '-nostdin']
    if start is not None: cmd += ['-ss', f'{start:.4f}']
    if dur is not None: cmd += ['-t', f'{dur:.4f}']
    cmd += ['-i', str(path), '-ac', str(channels), '-ar', str(sr), '-f', 'f32le', '-']
    x = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype=np.float32).copy()
    return x.reshape(-1, channels) if channels > 1 else x
def src(name):
    d = DL / name
    for f in d.iterdir():
        if f.name.startswith('source.') and not f.name.endswith('.json'): return f
def meta(name):
    d = DL / name
    if (d / 'meta.json').exists(): return json.loads((d / 'meta.json').read_text())
    m = json.loads((d / 'source.info.json').read_text())
    return dict(source='youtube', id=m['id'], url=m['webpage_url'], title=m['title'], author=m['channel'], license=m['license'], channel_id=m.get('channel_id'),
                description=(m.get('description') or '')[:400], upload_date=m.get('upload_date'))
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
