"""Atmosphere build helpers (stereo-aware). Original processing code; no third-party audio here.
Arrays are float64, mono shape (n,) or stereo shape (n, 2)."""
import sys, json, subprocess, pathlib, hashlib
import numpy as np
from scipy import signal
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import decode, src, meta, sha, ROOT, DL, SR

OUT = ROOT / 'atmosphere'
PARTS = ROOT / 'work-atmosphere' / 'parts'


class Ctx:
    """Collects the source cuts used by one output file."""
    def __init__(self): self.uses = []
    def seg(self, name, start, end, ch=1, note=''):
        x = decode(src(name), start, end - start, channels=ch).astype(np.float64)
        self.uses.append(dict(name=name, cut=f'{start:.3f}-{end:.3f} s', note=note))
        return x


def per_ch(fn, x, *a, **k):
    if x.ndim == 1: return fn(x, *a, **k)
    return np.stack([fn(x[:, c], *a, **k) for c in range(x.shape[1])], axis=1)


def _sos(kind, f, order):
    return signal.butter(order, f, kind, fs=SR, output='sos')
def hp(x, f, order=4): return per_ch(lambda s: signal.sosfiltfilt(_sos('highpass', f, order), s), x)
def lp(x, f, order=4): return per_ch(lambda s: signal.sosfiltfilt(_sos('lowpass', f, order), s), x)
def bp(x, lo, hi, order=2): return per_ch(lambda s: signal.sosfiltfilt(_sos('bandpass', [lo, hi], order), s), x)
def lp_causal(x, f, order=2): return per_ch(lambda s: signal.sosfilt(_sos('lowpass', f, order), s), x)


def peq(x, f, gain_db, q=1.0):
    A = 10 ** (gain_db / 40); w = 2 * np.pi * f / SR; al = np.sin(w) / (2 * q); cw = np.cos(w)
    b = np.array([1 + al * A, -2 * cw, 1 - al * A]); a = np.array([1 + al / A, -2 * cw, 1 - al / A])
    return per_ch(lambda s: signal.lfilter(b / a[0], a / a[0], s), x)


def shelf(x, f, gain_db, kind='low'):
    A = 10 ** (gain_db / 40); w = 2 * np.pi * f / SR; cw, sw = np.cos(w), np.sin(w); al = sw / 2 * np.sqrt(2)
    if kind == 'low':
        b = [A*((A+1)-(A-1)*cw+2*np.sqrt(A)*al), 2*A*((A-1)-(A+1)*cw), A*((A+1)-(A-1)*cw-2*np.sqrt(A)*al)]
        a = [(A+1)+(A-1)*cw+2*np.sqrt(A)*al, -2*((A-1)+(A+1)*cw), (A+1)+(A-1)*cw-2*np.sqrt(A)*al]
    else:
        b = [A*((A+1)+(A-1)*cw+2*np.sqrt(A)*al), -2*A*((A-1)+(A+1)*cw), A*((A+1)+(A-1)*cw-2*np.sqrt(A)*al)]
        a = [(A+1)-(A-1)*cw+2*np.sqrt(A)*al, 2*((A-1)-(A+1)*cw), (A+1)-(A-1)*cw-2*np.sqrt(A)*al]
    b, a = np.array(b), np.array(a)
    return per_ch(lambda s: signal.lfilter(b / a[0], a / a[0], s), x)


def to_stereo(x):
    return x if x.ndim == 2 else np.stack([x, x], axis=1)


def mono(x):
    return x if x.ndim == 1 else x.mean(axis=1)


def pan(x, p):
    """Constant-power pan of a mono signal, p in [-1, 1]."""
    th = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(th), x * np.sin(th)], axis=1)


def width(x, w):
    """Mid/side width: w=0 mono, 1 unchanged."""
    m = x.mean(axis=1); s = (x[:, 0] - x[:, 1]) / 2 * w
    return np.stack([m + s, m - s], axis=1)


def fade(x, fin=0.002, fout=0.05):
    x = x.copy(); n1 = int(fin * SR); n2 = int(fout * SR)
    if n1:
        g = np.sin(np.linspace(0, np.pi / 2, n1)) ** 2
        x[:n1] *= g if x.ndim == 1 else g[:, None]
    if n2:
        g = np.cos(np.linspace(0, 1, n2) * np.pi / 2) ** 2
        x[-n2:] *= g if x.ndim == 1 else g[:, None]
    return x


def env(x, ms=10):
    m = mono(x); n = max(1, int(ms * SR / 1000))
    return np.sqrt(np.convolve(m ** 2, np.ones(n) / n, 'same'))


def onset(x, thresh=0.1, pre=0.004):
    e = env(x, 2); i = int(np.argmax(e > thresh * e.max()))
    return max(0, i - int(pre * SR))


def trim_tail(x, floor_db=-55, hold=0.05):
    e = env(x, 10); lim = e.max() * 10 ** (floor_db / 20)
    idx = np.where(e > lim)[0]
    end = min(len(x), idx[-1] + int(hold * SR)) if len(idx) else len(x)
    return x[:end]


def fixed_loop(x, N, X):
    """Seamless loop of exactly N samples from x (len >= N+X): the X-sample continuation after N is
    equal-power crossfaded into the head, so y[N-1] -> y[0] continues the original signal."""
    assert len(x) >= N + X, (len(x), N, X)
    t = np.linspace(0, np.pi / 2, X)
    a, b = np.sin(t), np.cos(t)
    if x.ndim == 2: a, b = a[:, None], b[:, None]
    y = x[:N].copy()
    y[:X] = x[:X] * a + x[N:N + X] * b
    return y


def best_loop(x, L, X, search=0.06, step=24):
    """Loop of ~L s: choose the length within +-search*L whose continuation best correlates with the head."""
    n = int(L * SR); nx = int(X * SR); w = int(search * n)
    m0 = mono(x); head = m0[:nx]
    best, bn = -2, n
    for m in range(n - w, n + w, step):
        if m + nx > len(m0): break
        c = m0[m:m + nx]; r = np.dot(c, head) / (np.linalg.norm(c) * np.linalg.norm(head) + 1e-9)
        if r > best: best, bn = r, m
    return fixed_loop(x, bn, nx), dict(loop_len_s=round(bn / SR, 4), overlap_s=X, head_corr=round(float(best), 3),
                                       seam='equal-power sin/cos overlap of the continuation into the head')


def seam_report(y):
    """Wrap-around continuity: compares the sample step across the loop boundary with typical steps."""
    m = mono(y); d = np.abs(np.diff(m)); jump = abs(m[0] - m[-1])
    e_head = np.sqrt(np.mean(m[:SR // 10] ** 2)); e_tail = np.sqrt(np.mean(m[-SR // 10:] ** 2))
    return dict(boundary_step=round(float(jump), 5), median_step=round(float(np.median(d)), 5),
                p99_step=round(float(np.percentile(d, 99)), 5),
                level_jump_db=round(float(20 * np.log10((e_head + 1e-9) / (e_tail + 1e-9))), 2))


def place(N, items, circular=True, stereo=True):
    """items: (time_s, signal(mono or stereo), gain). Circular wraps tails into the head (for loops)."""
    y = np.zeros((N, 2)) if stereo else np.zeros(N)
    for t, s, g in items:
        s = to_stereo(s) if stereo else mono(s)
        i = int(t * SR) % N if circular else int(t * SR)
        n = len(s)
        if circular:
            idx = (np.arange(n) + i) % N
            np.add.at(y, idx, g * s)
        else:
            k = min(n, N - i)
            if k > 0: y[i:i + k] += g * s[:k]
    return y


def concat_xf(parts, X=0.25):
    """Concatenate segments with equal-power crossfades of X seconds."""
    nx = int(X * SR); t = np.linspace(0, np.pi / 2, nx); a, b = np.sin(t), np.cos(t)
    y = parts[0]
    for p in parts[1:]:
        aa, bb = (a, b) if y.ndim == 1 else (a[:, None], b[:, None])
        mid = y[-nx:] * bb + p[:nx] * aa
        y = np.concatenate([y[:-nx], mid, p[nx:]])
    return y


def echo_tail(x, taps, lp_hz=900):
    """Discrete delayed, low-passed reflections (valley echo): taps = [(delay_s, gain_db, pan)]."""
    out = to_stereo(x).copy() if any(t[2] for t in taps) else x.copy()
    total = len(x) + int(max(t[0] for t in taps) * SR) + 1
    pad = np.zeros((total, 2)) if out.ndim == 2 else np.zeros(total)
    pad[:len(out)] = out
    for d, gdb, p in taps:
        r = lp(mono(x), lp_hz, 2) * 10 ** (gdb / 20)
        r = pan(r, p) if pad.ndim == 2 else r
        i = int(d * SR); pad[i:i + len(r)] += r
    return pad


# BS.1770 loudness (K-weighted, gated); stereo sums channel powers.
def _kw(s):
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, s))


def lufs(x, loop=False):
    xs = x if x.ndim == 2 else x[:, None]
    ys = []
    for c in range(xs.shape[1]):
        s = xs[:, c]
        y = _kw(np.concatenate([s, s]) if loop else s)
        ys.append(y[len(s):] if loop else y)
    blk, hop = int(.4 * SR), int(.1 * SR)
    L = len(ys[0])
    if L < blk:
        return float(-0.691 + 10 * np.log10(sum(np.mean(y ** 2) for y in ys) + 1e-12))
    ms = np.array([sum(np.mean(y[i:i + blk] ** 2) for y in ys) for i in range(0, L - blk + 1, hop)])
    l = -0.691 + 10 * np.log10(ms + 1e-12); ms = ms[l > -70]
    if not len(ms): return -70.0
    rel = -0.691 + 10 * np.log10(ms.mean()) - 10
    ms2 = ms[-0.691 + 10 * np.log10(ms) > rel]
    return float(-0.691 + 10 * np.log10(ms2.mean()))


def db(v): return float(20 * np.log10(max(v, 1e-9)))


def limiter(x, ceiling, look_ms=2.0, rel_ms=80.0):
    """Look-ahead peak limiter (linked across channels)."""
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    a_ = np.abs(x) if x.ndim == 1 else np.abs(x).max(axis=1)
    w = max(1, int(look_ms * SR / 1000))
    req = np.minimum(1.0, ceiling / (a_ + 1e-12))
    g = minimum_filter1d(req, 2 * w + 1, origin=-(w // 2))
    g = uniform_filter1d(g, w)
    g = np.minimum(g, minimum_filter1d(req, 2 * w + 1))
    a = 1 - np.exp(-1 / (rel_ms * SR / 1000)); out = np.empty_like(g); cur = 1.0
    for i in range(len(g)):
        t = g[i]
        cur = t if t < cur else cur + (t - cur) * a
        out[i] = cur
    return x * (out if x.ndim == 1 else out[:, None])


def encode(x, path, kbps):
    path.parent.mkdir(parents=True, exist_ok=True)
    ch = 1 if x.ndim == 1 else 2
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', str(ch), '-i', '-',
                    '-c:a', 'libopus', '-b:a', f'{kbps}k', '-application', 'audio', '-fflags', '+bitexact', '-flags:a', '+bitexact',
                    str(path)], input=x.astype(np.float32).tobytes(), check=True)
    return decode(path, channels=ch).astype(np.float64)


R = {}
def recipe(file, target, loop=False, processing='', peak_db=-3.0, lufs_target=-20.0, variant=None, max_gr=4.0,
           stereo=False, role=None):
    def deco(fn):
        R[file] = dict(fn=fn, target=target, loop=loop, processing=processing, peak_db=peak_db, lufs_target=lufs_target,
                       variant=variant, max_gr=max_gr, stereo=stereo, role=role)
        return fn
    return deco
