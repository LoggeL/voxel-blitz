"""Atmosphere SFX build: python3 -I build.py [prefix ...]. Writes ../atmosphere/<file> and parts/<file>.json."""
import sys, json, pathlib
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dsp2 import *
import recipes_env, recipes_synth  # noqa: F401  (register recipes)

PARTS.mkdir(parents=True, exist_ok=True)
RETRIEVED_YT = None


def finalize(file, spec):
    ctx = Ctx(); r = spec['fn'](ctx); info = {}
    if isinstance(r, tuple): r, info = r
    x = np.asarray(r, dtype=np.float64)
    if spec['stereo']: x = to_stereo(x)
    elif x.ndim == 2: x = mono(x)
    x = x - x.mean(axis=0)
    loop = spec['loop']
    if not loop:
        n0 = len(x); x = trim_tail(x, -62, 0.05); x = fade(x, 0.0, min(0.05, len(x) / SR / 4))
        x = hp(x, 18, 2)
        if len(x) < n0: info['trimmed_tail_s'] = round((n0 - len(x)) / SR, 3)
    cap = 10 ** (spec['peak_db'] / 20)
    pk = np.abs(x).max()
    g_l = 10 ** ((spec['lufs_target'] - lufs(x, loop=loop)) / 20); g_p = cap / pk
    proc = spec['processing']
    if g_l > g_p and spec['max_gr'] > 0:
        g = min(g_l, g_p * 10 ** (spec['max_gr'] / 20)); gr = 20 * np.log10(g / g_p)
        if loop:  # circular: limit the middle of three copies so the gain curve wraps seamlessly
            N = len(x); x = limiter(np.concatenate([x, x, x]) * g, cap * 0.97)[N:2 * N]
        else:
            x = limiter(x * g, cap * 0.97)
        info['limiter_gain_reduction_db'] = round(float(gr), 2)
        proc += f"; {'circular ' if loop else ''}look-ahead peak limiter (2 ms, 80 ms release, up to {gr:.1f} dB GR)"
    else:
        x = x * min(g_l, g_p)
        if g_l > g_p: info['loudness_limited_by_peak_cap'] = True
    proc += f"; normalized toward {spec['lufs_target']} LUFS with peak cap {spec['peak_db']} dBFS"
    path = OUT / file; kb = 128 if x.ndim == 2 else 96
    for _ in range(5):
        y = encode(x, path, kb)
        pk = np.abs(y).max()
        if pk <= 10 ** ((spec['peak_db'] + 0.3) / 20): break
        x *= 10 ** ((spec['peak_db'] - 0.1) / 20) / pk
    y = decode(path, channels=2 if x.ndim == 2 else 1).astype(np.float64)
    if loop: info['seam_decoded'] = seam_report(y)
    srcs = []
    for u in ctx.uses:
        m = meta(u['name'])
        e = dict(url=m['url'], title=m['title'], author=m['author'], license=m['license'],
                 license_url=m.get('license_url'), retrieved=m.get('retrieved') or '2026-10-08', cut=u['cut'],
                 processing=proc + (('; layer: ' + u['note']) if u['note'] else ''),
                 download_sha256=sha(src(u['name'])), download=f"downloads/{u['name']}/{src(u['name']).name}")
        if m.get('source') == 'freesound': e['file_url'] = m['file_url']; e['source_format'] = 'Freesound HQ preview (Ogg Vorbis); original download requires login'
        srcs.append(e)
    # merge repeated cuts of the same source into one entry
    merged = {}
    for e in srcs:
        k = e['url']
        if k in merged:
            if e['cut'] not in merged[k]['cut']: merged[k]['cut'] += ', ' + e['cut']
        else: merged[k] = e
    srcs = list(merged.values())
    if 'Procedural' in proc or 'procedural' in proc:
        srcs.append(dict(url=None, title='Original procedural synthesis (work-atmosphere/recipes_synth.py)', author='VOXEL BLITZ build script',
                         license='Project original (no third-party audio)', retrieved='2026-10-08', cut=None, processing=proc))
    ch = 2 if y.ndim == 2 else 1
    entry = dict(id=spec['target'], file=file, durationS=round(len(y) / SR, 3), loop=loop,
                 loudnessLUFS=round(lufs(y, loop=loop), 2), peakDb=round(db(np.abs(y).max()), 2),
                 channels=ch, format=f"Ogg Opus {'stereo' if ch == 2 else 'mono'} 48 kHz {kb} kbit/s (libopus, bitexact)",
                 output_sha256=sha(path), sizeBytes=path.stat().st_size, variant=spec['variant'], sources=srcs)
    entry['normalization'] = dict(lufs_target=spec['lufs_target'], peak_cap_db=spec['peak_db'], limiter_max_gr_db=spec['max_gr'])
    if info: entry['notes'] = info
    (PARTS / (file + '.json')).write_text(json.dumps(entry, indent=1, ensure_ascii=False))
    sm = info.get('seam_decoded')
    print(f"{file:36s} {entry['durationS']:7.2f}s ch{ch} {entry['loudnessLUFS']:6.1f} LUFS pk {entry['peakDb']:5.1f}"
          + (f"  seam step {sm['boundary_step']} (med {sm['median_step']}, p99 {sm['p99_step']}) lvl {sm['level_jump_db']} dB" if sm else ''), flush=True)


if __name__ == '__main__':
    pre = sys.argv[1:]
    for f, s in R.items():
        if not pre or any(f.startswith(p) or s['target'].startswith(p) for p in pre):
            try: finalize(f, s)
            except Exception as ex:
                import traceback; traceback.print_exc(); print('FAILED', f, ex, flush=True)
