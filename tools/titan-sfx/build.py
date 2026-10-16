"""Titan weapon SFX build: python3 -I build.py [prefix ...]. Writes <work>/titan/<dir>/<name>.ogg and
<work>/parts/<dir>__<name>.ogg.json (provenance per file); make_manifest.py assembles sources.json from the parts."""
import sys, json, numpy as np, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from dsp import *
OUT = ROOT / 'titan'; PARTS = ROOT / 'parts'; PARTS.mkdir(parents=True, exist_ok=True)
from recipes import *  # noqa
from dsp import R
RETRIEVED = '2026-10-13'
LIC_RANK = ['CC0 1.0', 'Public Domain', 'CC BY 3.0', 'CC BY 4.0']
def lic_of(m):
    """Normalized licence string (sources.json allows CC0 1.0 / CC BY 3.0 / CC BY 4.0 / Public Domain)."""
    if m.get('source') == 'youtube': return 'CC BY 3.0'  # YouTube "Creative Commons Attribution license (reuse allowed)" = CC BY 3.0
    return m['license']
def render(file, spec):
    ctx = Ctx(); r = spec['fn'](ctx); info = {}
    if isinstance(r, tuple): r, info = r
    x = np.asarray(r, dtype=np.float64)
    x = x - np.mean(x)
    if not spec['loop']:
        n0 = len(x); x = trim_tail(x, -62, 0.04); x = fade(x, 0.0, min(0.04, len(x)/SR/4))
        if len(x) < n0: info['trimmed_tail_s'] = round((n0 - len(x))/SR, 3)
    x = hp(x, 18, 2, zero=True)
    if not spec['loop']: x = fade(x, 0.0005, 0.005)  # the zero-phase HP can smear a few samples ahead of the onset
    return x, info, ctx
def level(x, spec, target):
    """Gain to the LUFS target under the peak cap; peaks above the cap (up to max_gr dB) go through the soft clipper
    (clip=True) or the look-ahead limiter. Returns (y, gain reduction dB, processing note)."""
    cap = 10 ** (spec['peak_db'] / 20); max_gr = spec.get('max_gr', 3.0)
    g_l = 10 ** ((target - lufs(x, loop=spec['loop'])) / 20); g_p = cap / np.abs(x).max()
    if not (g_l > g_p and max_gr > 0): return x * min(g_l, g_p), 0.0, ''
    g = min(g_l, g_p * 10 ** (max_gr / 20)); gr = 20 * np.log10(g / g_p)
    if spec.get('clip'):  # transient-friendly: soft clipper on the peaks, then a fast limiter catches the rest
        return (limiter(softclip(x * g, cap * 1.12), cap * 0.97, 1.0, 15.0), gr,
                f'; soft clipper (knee at 0.6x) + fast look-ahead limiter (1 ms, 15 ms release) on the peaks ({gr:.1f} dB above the peak cap)')
    return limiter(x * g, cap * 0.97), gr, f'; look-ahead peak limiter (2 ms, 80 ms release, up to {gr:.1f} dB GR)'
def achievable(x, spec):
    """Loudness this take reaches at the peak cap with the allowed peak processing."""
    return lufs(level(x, spec, 0.0)[0], loop=spec['loop'])
def finalize(file, spec, rendered=None, target=None):
    x, info, ctx = rendered or render(file, spec)
    target = spec['lufs_target'] if target is None else target
    if target < spec['lufs_target']: info['group_matched_lufs_target'] = round(target, 2)
    max_gr = spec.get('max_gr', 3.0)
    x, gr, note = level(x, spec, target)
    processing = spec['processing'] + note
    if gr: info['limiter_gain_reduction_db'] = round(float(gr), 2)
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
        e = dict(url=m['url'], title=m['title'], author=m['author'], license=lic_of(m), retrieved=m.get('retrieved', RETRIEVED), cut=u['cut'],
                 layer=u['note'], download_sha256=sha(src(u['name'])), download=f"{u['name']}/{src(u['name']).name}")
        if m.get('source') == 'youtube':
            e['license_detail'] = ('YouTube license field "' + m['license'] + '" (yt-dlp, 2026-10-13); official U.S. military channel, '
                                   'U.S. federal government work (17 U.S.C. 105)')
            e['license_url'] = 'https://creativecommons.org/licenses/by/3.0/legalcode'
        else:
            e['license_url'] = m.get('license_url'); e['file_url'] = m.get('file_url')
        srcs.append(e)
    lic = max((s['license'] for s in srcs), key=LIC_RANK.index, default='CC0 1.0')
    entry = dict(file=file, group=spec['target'], license=lic, durationS=round(len(y) / SR, 3), loop=spec['loop'],
                 loudnessLUFS=round(lufs(y, loop=spec['loop']), 2), peakDb=round(db(np.abs(y).max()), 2),
                 format='Ogg Opus mono 48 kHz 96 kbit/s (libopus, bitexact)', sizeBytes=path.stat().st_size,
                 output_sha256=sha(path), variant=spec.get('variant'), processing=processing, sources=srcs)
    if info.get('synth'):
        entry['synthLayers'] = [dict(description=info.pop('synth'), origin='tools/titan-sfx/recipes.py (original code, no third-party audio)')]
    entry['normalization'] = dict(lufs_target=spec['lufs_target'], peak_cap_db=spec['peak_db'], limiter_max_gr_db=max_gr)
    if info: entry['notes'] = info
    (PARTS / (file.replace('/', '__') + '.json')).write_text(json.dumps(entry, indent=1, ensure_ascii=False))
    print(f"{file:32s} {entry['durationS']:6.2f}s {entry['loudnessLUFS']:6.1f} LUFS pk {entry['peakDb']:5.1f} "
          f"{entry['sizeBytes']/1024:5.1f} KiB {('GR %.1f' % info['limiter_gain_reduction_db']) if 'limiter_gain_reduction_db' in info else ''}")
    return entry
if __name__ == '__main__':
    pre = sys.argv[1:]
    groups = {}
    for f, sp in R.items():
        if not pre or any(f.startswith(p) or sp['target'].startswith(p) for p in pre): groups.setdefault(sp['target'], []).append(f)
    for g, files in groups.items():
        # takes of one group are played at random: level them together (within 1 LU of the quietest achievable take)
        rs = {f: render(f, R[f]) for f in files}
        tgt = min([R[files[0]]['lufs_target']] + [achievable(rs[f][0], R[f]) + 0.5 for f in files])
        entries = {f: finalize(f, R[f], rs[f], tgt) for f in files}
        # Mastering and Opus can change loudness after the initial target estimate.
        # Attenuate louder takes from the original float render, never re-encode a lossy take.
        ceiling = min(e['loudnessLUFS'] for e in entries.values()) + 0.5
        for f, e in entries.items():
            if e['loudnessLUFS'] > ceiling:
                finalize(f, R[f], rs[f], tgt - (e['loudnessLUFS'] - ceiling))
