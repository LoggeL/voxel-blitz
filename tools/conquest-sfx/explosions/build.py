"""Explosion/impact SFX build: python3 build.py [prefix ...]. Writes ../explosions/<file>.ogg and parts/<file>.json."""
import sys, json, numpy as np, pathlib, datetime
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dsp import *
OUT = ROOT / 'explosions'; PARTS = ROOT / 'work-explosions' / 'parts'; PARTS.mkdir(exist_ok=True)
from recipes import *  # noqa
from dsp import R
def finalize(file, spec):
    ctx = Ctx(); r = spec['fn'](ctx); info = {}
    if isinstance(r, tuple): r, info = r
    x = np.asarray(r, dtype=np.float64)
    x = x - np.mean(x)  # DC
    if not spec['loop']:  # drop trailing near-silence, then a short cosine fade
        n0 = len(x); x = trim_tail(x, -62, 0.04); x = fade(x, 0.0, min(0.04, len(x)/SR/4))
        if len(x) < n0: info['trimmed_tail_s'] = round((n0 - len(x))/SR, 3)
    x = hp(x, 18, 2, zero=True)
    cap = 10 ** (spec['peak_db'] / 20)
    g_l = 10 ** ((spec['lufs_target'] - lufs(x, loop=spec['loop'])) / 20); g_p = cap / np.abs(x).max()
    max_gr = spec.get('max_gr', 6.0); gr = 0.0
    if g_l > g_p and max_gr > 0:
        g = min(g_l, g_p * 10 ** (max_gr / 20)); gr = 20 * np.log10(g / g_p)
        x = limiter(x * g, cap * 0.97)
        info['limiter_gain_reduction_db'] = round(float(gr), 2)
        spec = dict(spec, processing=spec['processing'] + f'; look-ahead peak limiter (2 ms, 80 ms release, up to {gr:.1f} dB GR)')
    else:
        x = x * min(g_l, g_p)
    path = OUT / file
    for _ in range(5):
        y = encode(x, path)
        pk = np.abs(y).max()
        if pk <= 10 ** ((spec['peak_db'] + 0.3) / 20): break
        x *= 10 ** ((spec['peak_db'] - 0.1) / 20) / pk
    y = decode(path)
    srcs = []
    for u in ctx.uses:
        m = meta(u['name'])
        e = dict(url=m['url'], title=m['title'], author=m['author'], license=m['license'],
                 retrieved=m.get('retrieved') or '2026-10-08', cut=u['cut'],
                 processing=spec['processing'] + (('; layer: ' + u['note']) if u['note'] else ''),
                 download_sha256=sha(src(u['name'])), download=f"downloads/{u['name']}/{src(u['name']).name}")
        if m.get('source') == 'youtube':
            e['license_verified'] = 'yt-dlp metadata license field on 2026-10-08'; e['license_url'] = 'https://creativecommons.org/licenses/by/3.0/legalcode'
            e['channel_id'] = m.get('channel_id')
        if m.get('source') == 'freesound': e['license_url'] = m['license_url']; e['file_url'] = m['file_url']
        srcs.append(e)
    if info.get('synth'):
        srcs.append(dict(url=None, title='Original procedural layer (this project build script)', author='VOXEL BLITZ build script',
                         license='Project original (no third-party audio)', retrieved='2026-10-08', cut=None, processing=info.pop('synth')))
    entry = dict(id=spec['target'], file=file, durationS=round(len(y) / SR, 3), loop=spec['loop'],
                 loudnessLUFS=round(lufs(y, loop=spec['loop']), 2), peakDb=round(db(np.abs(y).max()), 2),
                 format='Ogg Opus mono 48 kHz 96 kbit/s (libopus, bitexact)', output_sha256=sha(path), sizeBytes=path.stat().st_size,
                 sources=srcs)
    if spec.get('variant'): entry['variant'] = spec['variant']
    entry['normalization'] = dict(lufs_target=spec['lufs_target'], peak_cap_db=spec['peak_db'], limiter_max_gr_db=spec.get('max_gr', 6.0))
    if info: entry['notes'] = info
    (PARTS / (file.replace('/', '__') + '.json')).write_text(json.dumps(entry, indent=1, ensure_ascii=False))
    print(f"{file:40s} {entry['durationS']:6.2f}s  {entry['loudnessLUFS']:6.1f} LUFS  pk {entry['peakDb']:5.1f}")
if __name__ == '__main__':
    pre = sys.argv[1:]
    for f, s in R.items():
        if not pre or any(f.startswith(p) or s['target'].startswith(p) for p in pre): finalize(f, s)
