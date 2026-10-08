"""Vehicle SFX build: python3 build.py [id-prefix ...]. Writes vehicles/<file>.ogg and parts/<file>.json."""
import sys, json, numpy as np, pathlib, datetime
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dsp import *
from scipy.interpolate import CubicSpline
OUT = ROOT / 'vehicles'; PARTS = ROOT / 'work-vehicles' / 'parts'; PARTS.mkdir(exist_ok=True)
from recipes import *  # noqa
from dsp import R
def finalize(file, spec):
    ctx = Ctx(); r = spec['fn'](ctx); info = {}
    if isinstance(r, tuple): r, info = r
    x = np.asarray(r, dtype=np.float64)
    if spec['loop']:
        g = 10 ** ((spec['lufs_target'] - lufs(x, loop=True)) / 20); x = x * g
        pk = np.abs(x).max()
        if pk > 10 ** (spec['peak_db'] / 20): x *= 10 ** (spec['peak_db'] / 20) / pk
    else:
        x = x / np.abs(x).max() * 10 ** (spec['peak_db'] / 20)
    path = OUT / file
    for _ in range(4):
        y = encode(x, path)
        pk = np.abs(y).max()
        if pk <= 10 ** ((spec['peak_db'] + 0.3) / 20): break
        x *= 10 ** ((spec['peak_db'] - 0.1) / 20) / pk
    y = decode(path)
    srcs = []
    for u in ctx.uses:
        m = meta(u['name'])
        e = dict(url=m['url'], title=m['title'], author=m['author'], license=m['license'],
                 retrieved=m.get('retrieved') or datetime.date.today().isoformat(), cut=u['cut'],
                 processing=spec['processing'] + (('; ' + u['note']) if u['note'] else ''),
                 download_sha256=sha(src(u['name'])), download=f"downloads/{u['name']}/{src(u['name']).name}")
        if m.get('source') == 'youtube': e['license_verified'] = 'yt-dlp metadata license field'
        if m.get('source') == 'freesound': e['license_url'] = m['license_url']; e['file_url'] = m['file_url']
        srcs.append(e)
    if not srcs:
        srcs.append(dict(url=None, title='Original procedural synthesis (this project)', author='VOXEL BLITZ build script',
                         license='Project original (no third-party audio)', retrieved=datetime.date.today().isoformat(),
                         cut=None, processing=spec['processing']))
    seam = None
    if spec['loop']:
        seam = float(np.abs(y[0] - y[-1])); d = np.abs(np.diff(y)); seam = dict(boundary_step=round(seam, 5), step_p99=round(float(np.percentile(d, 99)), 5))
    entry = dict(id=spec['target'], file=file, durationS=round(len(y) / SR, 3), loop=spec['loop'],
                 loudnessLUFS=round(lufs(y, loop=spec['loop']), 2), peakDb=round(db(np.abs(y).max()), 2),
                 format='Ogg Opus mono 48 kHz 96 kbit/s (libopus, bitexact)', output_sha256=sha(path), sources=srcs)
    if seam: entry['loopSeam'] = seam
    if info: entry['notes'] = info
    (PARTS / (file.replace('/', '__') + '.json')).write_text(json.dumps(entry, indent=1))
    print(f"{file:48s} {entry['durationS']:6.2f}s  {entry['loudnessLUFS']:6.1f} LUFS  pk {entry['peakDb']:5.1f}  {seam or ''}")
if __name__ == '__main__':
    pre = sys.argv[1:]
    for f, s in R.items():
        if not pre or any(f.startswith(p) or s['target'].startswith(p) for p in pre): finalize(f, s)
