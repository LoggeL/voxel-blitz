"""Offline render of the synthesized titan shot voices that the sampled bank replaces (baseline for the judging in
docs/audio/titan-weapons-judging.md). A numpy re-implementation of public/js/audio/primitives.js tone()/hiss()
(exponential frequency ramp; linear attack then exponential decay to 0.0001; white noise through a WebAudio-style
biquad whose frequency ramps exponentially) driven by the TitanSynth.shot() recipes in public/js/vehicles/vehicle-audio.js
as of 2026-10-13. Usage: python3 -I render_synth_baseline.py <out-dir>. Writes <voice>.wav (48 kHz float32 mono)."""
import sys, pathlib, subprocess, numpy as np
SR = 48000
rng = np.random.default_rng(7)

def ramp_exp(n, t0, v0, v1, dur):
    t = np.arange(n) / SR - t0
    k = np.clip(t / max(dur, 1e-6), 0, 1)
    return v0 * (v1 / v0) ** k

def env(n, t0, peak, att, dec):
    t = np.arange(n) / SR - t0
    e = np.zeros(n)
    a = (t >= 0) & (t < att)
    e[a] = 0.0001 + (peak - 0.0001) * t[a] / att
    d = t >= att
    k = np.clip((t[d] - att) / dec, 0, None)
    e[d] = peak * (0.0001 / peak) ** k
    e[t > att + dec] = 0
    return e

def tone(n, t0=0, type='sine', f0=440, f1=None, g=0.3, att=0.003, dec=0.1, **_):
    f = ramp_exp(n, t0, f0, f1, dec) if f1 else np.full(n, f0)
    ph = np.cumsum(f) / SR; ph = ph - ph[int(t0 * SR)] if int(t0 * SR) < n else ph
    p = ph % 1.0
    w = {'sine': np.sin(2 * np.pi * p), 'square': np.sign(np.sin(2 * np.pi * p)),
         'sawtooth': 2 * p - 1, 'triangle': 2 * np.abs(2 * p - 1) - 1}[type]
    y = w * env(n, t0, g, att, dec)
    y[np.arange(n) / SR > t0 + att + dec + 0.03] = 0
    return y

def biquad_coefs(kind, f, q):
    w = 2 * np.pi * min(f, SR / 2 - 10) / SR; cw, sw = np.cos(w), np.sin(w)
    if kind in ('lowpass', 'highpass'):
        al = sw / 2 * 10 ** (-q / 20)        # WebAudio: Q in dB for low/highpass
        if kind == 'lowpass': b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2]
        else: b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    else:
        al = sw / (2 * max(q, 1e-4)); b = [al, 0, -al]
    a = [1 + al, -2 * cw, 1 - al]
    return np.array(b) / a[0], np.array(a) / a[0]

def hiss(n, t0=0, filter='bandpass', f=1200, q=1, sweepTo=None, sweepMs=None, g=0.3, att=0.001, dec=0.08, **_):
    x = rng.uniform(-1, 1, n)
    fr = ramp_exp(n, t0, f, sweepTo, sweepMs if sweepMs is not None else dec) if sweepTo else np.full(n, f)
    y = np.zeros(n); x1 = x2 = y1 = y2 = 0.0
    for s in range(0, n, 64):
        b, a = biquad_coefs(filter, fr[s], q)
        for i in range(s, min(n, s + 64)):
            o = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
            x2, x1, y2, y1 = x1, x[i], y1, o; y[i] = o
    y *= env(n, t0, g, att, dec)
    y[np.arange(n) / SR > t0 + att + dec + 0.05] = 0
    return y

VOICES = {
    'splitter': (0.9, [('tone', dict(type='square', f0=940, f1=420, g=0.1, att=0.001, dec=0.08)),
                       ('hiss', dict(filter='bandpass', f=3200, q=1.2, g=0.16, att=0.001, dec=0.06)),
                       ('tone', dict(type='sine', f0=160, f1=80, g=0.18, att=0.001, dec=0.09))]),
    't203': (0.9, [('tone', dict(type='sine', f0=130, f1=55, g=0.42, att=0.002, dec=0.2)),
                   ('hiss', dict(filter='lowpass', f=1600, sweepTo=500, q=1, g=0.3, att=0.002, dec=0.32))]),
    'railgun': (0.9, [('tone', dict(type='sawtooth', f0=1900, f1=180, g=0.14, att=0.002, dec=0.38)),
                      ('hiss', dict(filter='bandpass', f=5200, q=0.9, sweepTo=1400, g=0.26, att=0.001, dec=0.45)),
                      ('tone', dict(type='sine', f0=70, f1=40, g=0.4, att=0.003, dec=0.5))]),
    'leadwall': (0.9, [('hiss', dict(filter='lowpass', f=2400, q=0.6, g=0.55, att=0.001, dec=0.24)),
                       ('tone', dict(type='sine', f0=96, f1=48, g=0.45, att=0.002, dec=0.22)),
                       ('hiss', dict(t0=0.03, filter='bandpass', f=4200, q=2, g=0.08, att=0.001, dec=0.12))]),
    'predator': (0.55, [('tone', dict(type='square', f0=230, f1=110, g=0.12, att=0.001, dec=0.05)),
                        ('hiss', dict(filter='bandpass', f=1900, q=1.1, g=0.2, att=0.001, dec=0.045))]),
}
if __name__ == '__main__':
    out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    n = int(1.0 * SR)
    for name, (gain, layers) in VOICES.items():
        y = sum((tone if k == 'tone' else hiss)(n, **p) for k, p in layers) * gain
        last = np.nonzero(np.abs(y) > 1e-5)[0]; y = y[: (last[-1] + 1 if len(last) else n)]
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', str(out / f'{name}.wav')],
                       input=y.astype(np.float32).tobytes(), check=True)
        print(name, f'{len(y) / SR:.3f} s', f'peak {20 * np.log10(np.abs(y).max()):.1f} dBFS')
