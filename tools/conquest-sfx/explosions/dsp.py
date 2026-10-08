"""DSP + bookkeeping helpers for the explosion SFX build (adapted from the vehicle build). Original processing code, no third-party audio."""
import sys, json, subprocess, numpy as np, pathlib, hashlib, datetime
from scipy import signal
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import decode, src, meta, sha, ROOT, DL, SR

class Ctx:
    """Collects the source cuts used by one output file."""
    def __init__(self): self.uses = []
    def seg(self, name, start, end, note=''):
        x = decode(src(name), start, end - start)
        self.uses.append(dict(name=name, cut=f'{start:.3f}-{end:.3f} s', note=note))
        return x

def hp(x, f, order=4, zero=False):
    sos = signal.butter(order, f, 'highpass', fs=SR, output='sos')
    return signal.sosfiltfilt(sos, x) if zero else signal.sosfilt(sos, x)
def lp(x, f, order=4, zero=False):
    sos = signal.butter(order, f, 'lowpass', fs=SR, output='sos')
    return signal.sosfiltfilt(sos, x) if zero else signal.sosfilt(sos, x)
def bp(x, lo, hi, order=2, zero=False):
    sos = signal.butter(order, [lo, hi], 'bandpass', fs=SR, output='sos')
    return signal.sosfiltfilt(sos, x) if zero else signal.sosfilt(sos, x)
def shelf(x, f, gain_db, kind='low'):
    """RBJ shelf biquad."""
    A = 10 ** (gain_db / 40); w = 2 * np.pi * f / SR; cw, sw = np.cos(w), np.sin(w); al = sw / 2 * np.sqrt(2)
    if kind == 'low':
        b = [A*((A+1)-(A-1)*cw+2*np.sqrt(A)*al), 2*A*((A-1)-(A+1)*cw), A*((A+1)-(A-1)*cw-2*np.sqrt(A)*al)]
        a = [(A+1)+(A-1)*cw+2*np.sqrt(A)*al, -2*((A-1)+(A+1)*cw), (A+1)+(A-1)*cw-2*np.sqrt(A)*al]
    else:
        b = [A*((A+1)+(A-1)*cw+2*np.sqrt(A)*al), -2*A*((A-1)+(A+1)*cw), A*((A+1)+(A-1)*cw-2*np.sqrt(A)*al)]
        a = [(A+1)-(A-1)*cw+2*np.sqrt(A)*al, 2*((A-1)-(A+1)*cw), (A+1)-(A-1)*cw-2*np.sqrt(A)*al]
    return signal.lfilter(np.array(b)/a[0], np.array(a)/a[0], x)
def peq(x, f, gain_db, q=1.0):
    A = 10 ** (gain_db / 40); w = 2*np.pi*f/SR; al = np.sin(w)/(2*q); cw = np.cos(w)
    b = [1+al*A, -2*cw, 1-al*A]; a = [1+al/A, -2*cw, 1-al/A]
    return signal.lfilter(np.array(b)/a[0], np.array(a)/a[0], x)
def rate(x, r):
    """Resample so playback is r times faster (pitch up by r)."""
    from fractions import Fraction
    fr = Fraction(1/r).limit_denominator(200)
    return signal.resample_poly(x, fr.numerator, fr.denominator)
def fade(x, fin=0.002, fout=0.05, curve='cos'):
    x = x.copy(); n1 = int(fin*SR); n2 = int(fout*SR)
    if n1: x[:n1] *= np.sin(np.linspace(0, np.pi/2, n1))**2
    if n2:
        t = np.linspace(0, 1, n2)
        x[-n2:] *= (np.cos(t*np.pi/2)**2) if curve == 'cos' else (1-t)**3
    return x
def trim_onset(x, thresh=0.03, pre=0.002):
    i = np.argmax(np.abs(x) > thresh*np.abs(x).max())
    return x[max(0, i-int(pre*SR)):]
def trim_tail(x, floor_db=-50, hold=0.03):
    env = np.sqrt(np.convolve(x**2, np.ones(480)/480, 'same'))
    lim = np.abs(x).max()*10**(floor_db/20)
    idx = np.where(env > lim)[0]
    end = min(len(x), idx[-1] + int(hold*SR)) if len(idx) else len(x)
    return x[:end]
def env_follow(x, ms=5):
    n = max(1, int(ms*SR/1000)); return np.sqrt(np.convolve(x**2, np.ones(n)/n, 'same'))
def gate_tail(x, floor, t0, tau=0.15):
    """Expander after t0: attenuates content near the noise floor so recording ambience decays."""
    e = env_follow(x, 10); g = np.clip((e/(floor+1e-9) - 1)/3, 0, 1) ** 0.7
    g = signal.filtfilt(*signal.butter(1, 8, fs=SR), g)
    g = np.clip(g, 0, 1); i0 = int(t0*SR); g[:i0] = 1
    return x * g
def place(dst_len, items):
    y = np.zeros(dst_len)
    for off, x, g in items:
        i = int(off*SR); n = min(len(x), dst_len - i)
        if n > 0: y[i:i+n] += g * x[:n]
    return y
def make_loop(x, L, X=0.2, search=0.08):
    """Seamless loop of ~L s from x (needs len >= L+X): equal-power head/tail overlap; picks the loop length
    within +-search*L that best correlates the continuation with the head."""
    n = int(L*SR); nx = int(X*SR); w = int(search*n)
    best, bn = -2, n
    head = x[:nx]
    for m in range(n-w, n+w, 24):
        if m+nx > len(x): break
        c = x[m:m+nx]; r = np.dot(c, head)/(np.linalg.norm(c)*np.linalg.norm(head)+1e-9)
        if r > best: best, bn = r, m
    t = np.linspace(0, np.pi/2, nx)
    y = x[:bn].copy()
    # head blends from the continuation (x[bn:]) into the original head -> y[-1] -> y[0] is continuous
    y[:nx] = x[:nx]*np.sin(t) + x[bn:bn+nx]*np.cos(t)
    y, rot = rotate_quiet(y)
    return y, dict(rotated_s=round(rot/SR, 4), loop_len_s=bn/SR, overlap_s=X, head_corr=round(float(best), 3), seam='equal-power sin/cos overlap')
# BS.1770 loudness
def k_weight(x):
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x))
def lufs(x, loop=False):
    y = k_weight(np.concatenate([x, x]) if loop else x)
    if loop: y = y[len(x):]
    blk, hop = int(.4*SR), int(.1*SR)
    if len(y) < blk: return -0.691 + 10*np.log10(np.mean(y**2)+1e-12)
    ms = np.array([np.mean(y[i:i+blk]**2) for i in range(0, len(y)-blk+1, hop)])
    l = -0.691 + 10*np.log10(ms+1e-12); ms = ms[l > -70]
    if not len(ms): return -70.0
    rel = -0.691 + 10*np.log10(ms.mean()) - 10
    ms2 = ms[-0.691 + 10*np.log10(ms) > rel]
    return float(-0.691 + 10*np.log10(ms2.mean()))
def db(v): return float(20*np.log10(max(v, 1e-9)))
def encode(x, path, kbps=96):
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-',
                    '-c:a', 'libopus', '-b:a', f'{kbps}k', '-fflags', '+bitexact', '-flags:a', '+bitexact', str(path)],
                   input=x.astype(np.float32).tobytes(), check=True)
    return decode(path)

from scipy.interpolate import CubicSpline
R = {}
def recipe(file, target, loop=False, processing='', peak_db=-3.5, lufs_target=-22.0, variant=None, max_gr=None):
    def deco(fn):
        R[file] = dict(fn=fn, target=target, loop=loop, processing=processing, peak_db=peak_db, lufs_target=lufs_target, variant=variant, **({'max_gr': max_gr} if max_gr is not None else {}))
        return fn
    return deco
def declip(x, thr=0.97):
    m = np.abs(x) >= thr * np.abs(x).max()
    if m.sum() < 3: return x
    x = x.copy(); idx = np.where(m)[0]
    runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)
    for r in runs:
        a, b = r[0], r[-1]
        L = np.r_[max(0, a-4):a]; Rr = np.r_[b+1:min(len(x), b+5)]
        k = np.r_[L, Rr]
        if len(k) < 4: continue
        if b - a > 48: continue  # long saturated runs: leave as-is (spline would explode)
        lim = np.abs(x).max() * 1.5
        x[a:b+1] = np.clip(CubicSpline(k, x[k])(np.arange(a, b+1)), -lim, lim)
    return x
def soft(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)
def norm_peak(x, p=1.0): return x / (np.abs(x).max() + 1e-12) * p

def rotate_quiet(y):
    """Rotate a seamless loop so the file boundary sits on an upward zero crossing in a low-energy, low-slope spot."""
    e = env_follow(y, 3); d = np.abs(np.diff(y, append=y[0]))
    zc = np.where((y[:-1] <= 0) & (y[1:] > 0))[0]
    if not len(zc): return y, 0
    score = e[zc] + 4*d[zc]
    i = int(zc[np.argmin(score)]) + 1
    return np.r_[y[i:], y[:i]], i

def limiter(x, ceiling, look_ms=2.0, rel_ms=80.0):
    """Look-ahead peak limiter (original code): sliding-min of required gain over the look-ahead window,
    smoothed by a moving average (attack) and a one-pole release; output never exceeds ceiling."""
    from scipy.ndimage import minimum_filter1d, uniform_filter1d
    w = max(1, int(look_ms * SR / 1000))
    req = np.minimum(1.0, ceiling / (np.abs(x) + 1e-12))
    g = minimum_filter1d(req, 2 * w + 1, origin=-(w // 2))
    g = uniform_filter1d(g, w)
    g = np.minimum(g, minimum_filter1d(req, 2 * w + 1))
    a = 1 - np.exp(-1 / (rel_ms * SR / 1000)); out = np.empty_like(g); cur = 1.0
    for i in range(len(g)):
        t = g[i]
        cur = t if t < cur else cur + (t - cur) * a
        out[i] = cur
    return x * out
