"""Recipes: radio chatter (procedural babble + CC0 static/squelch) and flag capture cues (procedural).
All synthesis below is original code for this project; no voice recordings or game audio are used."""
import numpy as np
from dsp2 import *

T = lambda d: np.arange(int(d * SR)) / SR


def adsr(n, a, d, s, r, sus_len=None):
    a, d, r = int(a * SR), int(d * SR), int(r * SR)
    sl = n - a - d - r if sus_len is None else int(sus_len * SR)
    sl = max(0, sl)
    e = np.concatenate([np.linspace(0, 1, a, endpoint=False), np.linspace(1, s, d, endpoint=False), np.full(sl, s), np.linspace(s, 0, r)])
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def osc(freq, kind='sine', phase0=0.0):
    """freq: array (Hz) per sample. Band-limited-ish saw/square via polyBLEP."""
    f = np.asarray(freq, dtype=np.float64)
    ph = (np.cumsum(f) / SR + phase0) % 1.0
    if kind == 'sine': return np.sin(2 * np.pi * ph)
    dt = f / SR
    def blep(t):
        y = np.zeros_like(t)
        m = t < dt; x = t[m] / dt[m]; y[m] = x + x - x * x - 1
        m2 = t > 1 - dt; x = (t[m2] - 1) / dt[m2]; y[m2] = x * x + x + x + 1
        return y
    if kind == 'saw': return 2 * ph - 1 - blep(ph)
    if kind == 'square':
        sq = np.where(ph < 0.5, 1.0, -1.0)
        return sq + blep(ph) - blep((ph + 0.5) % 1.0)
    raise ValueError(kind)


def noise(n, seed):
    return np.random.default_rng(seed).standard_normal(n)


# ---------------------------------------------------------------- radio chatter
VOWELS = {'a': (730, 1090, 2440), 'e': (530, 1840, 2480), 'i': (300, 2200, 2950), 'o': (570, 840, 2410),
          'u': (330, 950, 2300), 'ə': (500, 1500, 2500), 'æ': (660, 1720, 2410)}


def babble(seed, dur, f0=118, rate=5.6):
    """Formant-synthesized, deliberately unintelligible male 'speech' (random vowel/consonant syllables)."""
    rng = np.random.default_rng(seed)
    n = int(dur * SR); t = 0.0
    f0c = np.full(n, float(f0)); amp = np.zeros(n); F = np.zeros((n, 3)); fric = np.zeros(n)
    keys = list(VOWELS)
    cur = np.array(VOWELS['ə'], dtype=float)
    while t < dur - 0.12:
        sd = rng.uniform(0.07, 0.2) * 5.6 / rate
        if rng.random() < 0.12: t += rng.uniform(0.08, 0.22); continue  # short pause
        i0 = int(t * SR); i1 = min(n, int((t + sd) * SR))
        tgt = np.array(VOWELS[keys[rng.integers(len(keys))]], dtype=float) * rng.uniform(0.92, 1.08)
        k = np.linspace(0, 1, i1 - i0)[:, None] ** 0.5
        F[i0:i1] = cur * (1 - np.minimum(1, k * 3)) + tgt * np.minimum(1, k * 3)
        cur = tgt
        f0c[i0:i1] = f0 * (1 + 0.12 * np.sin(np.linspace(0, np.pi, i1 - i0)) * rng.uniform(-1, 1)) * (1 - 0.15 * t / dur)
        amp[i0:i1] = np.sin(np.linspace(0, np.pi, i1 - i0)) ** 0.6 * rng.uniform(0.6, 1.0)
        if rng.random() < 0.55:  # consonant: fricative or plosive burst at syllable start
            c = int(rng.uniform(0.02, 0.06) * SR); fric[i0:i0 + c] += np.hanning(2 * c)[:c][:len(fric[i0:i0 + c])] * rng.uniform(0.3, 0.8)
        t += sd + rng.uniform(0.0, 0.04)
    F[F[:, 0] == 0] = VOWELS['ə']
    src_ = osc(f0c * (1 + 0.004 * noise(n, seed + 1).cumsum() / np.sqrt(np.arange(1, n + 1))), 'saw')
    out = np.zeros(n); B = 64
    zis = [np.zeros((1, 2)) for _ in range(3)]
    for b0 in range(0, n, B):
        b1 = min(n, b0 + B); seg = src_[b0:b1]; acc = np.zeros(b1 - b0)
        for j, bw in enumerate((90, 120, 170)):
            fc = float(F[b0, j]); lo, hi = max(60, fc - bw), min(SR / 2 - 100, fc + bw)
            sos = signal.butter(1, [lo, hi], 'bandpass', fs=SR, output='sos')
            y, zis[j] = signal.sosfilt(sos, seg, zi=zis[j]); acc += y * (1.0, 0.7, 0.4)[j]
        out[b0:b1] = acc
    hiss = bp(noise(n, seed + 2), 2200, 6000, 2) * 0.25
    v = out * amp / (np.abs(out).max() + 1e-9) + hiss * fric
    return v / (np.abs(v).max() + 1e-9)


def radio_chain(v, drive=3.0):
    v = bp(v, 380, 2700, 3)
    v = np.tanh(v * drive) / np.tanh(drive)
    v = peq(v, 1600, 4, 1.0)
    return bp(v, 350, 3000, 2)


PROC_RADIO = ('mono; procedurally formant-synthesized unintelligible male babble (random vowel/consonant syllables, original code; '
              'no recorded voices), radio chain: BP 380-2700 Hz, tanh saturation, +4 dB @ 1.6 kHz; walkie-talkie static bed '
              '(CC0) under the voice; key-up click + end-of-transmission squelch tail (CC0)')


def _radio(ctx, seed, dur, f0, tail, static_name, static_at, gap=0.0):
    rng = np.random.default_rng(seed)
    st = mono(ctx.seg(static_name, static_at, static_at + dur + 0.6, ch=2, note='radio static bed'))
    st = bp(st, 300, 4000, 2); st = st / (np.sqrt(np.mean(st ** 2)) + 1e-9)
    v = radio_chain(babble(seed, dur, f0))
    if gap:  # two short transmissions/phrases
        g0 = int(dur * SR * 0.45); v[g0:g0 + int(gap * SR)] = 0
    tname, ta, tb, tch = tail
    sq = mono(ctx.seg(tname, ta, tb, ch=tch, note='end-of-transmission squelch'))
    sq = lp(hp(sq, 250, 2), 5000, 2); sq = sq / (np.abs(sq).max() + 1e-9)
    n = int((0.12 + dur + 0.05) * SR) + len(sq)
    y = np.zeros(n)
    # key-up: short click + 60 ms static swell
    y[:int(0.002 * SR)] += np.linspace(0.12, 0, int(0.002 * SR))
    stn = st[:n] if len(st) >= n else np.pad(st, (0, n - len(st)))
    ev = np.zeros(n); ev[:int((0.12 + dur) * SR)] = 1.0
    ev = signal.filtfilt(*signal.butter(1, 30, fs=SR), ev)
    y += stn * 0.06 * ev
    y[int(0.12 * SR):int(0.12 * SR) + len(v)] += v * 0.55
    i = int((0.12 + dur + 0.02) * SR); y[i:i + len(sq)] += sq * 0.32
    return fade(y, 0.001, 0.05)


for k, (seed, dur, f0, tail, stat, at, gap) in enumerate([
        (101, 1.6, 112, ('fs-760245', 0.0, 0.4, 2), 'fs-154654', 1.0, 0),
        (202, 2.4, 124, ('fs-47646', 0.0, 0.4, 1), 'fs-524204', 0.5, 0.22),
        (303, 1.1, 132, ('fs-524205', 0.0, 1.15, 2), 'fs-154654', 4.0, 0),
        (404, 3.0, 106, ('fs-760245', 0.0, 0.4, 2), 'fs-524204', 1.8, 0.3)], 1):
    def _f(ctx, seed=seed, dur=dur, f0=f0, tail=tail, stat=stat, at=at, gap=gap):
        return _radio(ctx, seed, dur, f0, tail, stat, at, gap)
    recipe(f'radio-chatter-{k}.ogg', 'radio_chatter', lufs_target=-22, peak_db=-4.0, max_gr=7.0,
           variant=f'garbled transmission {k} ({dur:.1f} s)', processing=PROC_RADIO)(_f)


@recipe('radio-squelch-1.ogg', 'radio_chatter', lufs_target=-24, peak_db=-4.0, max_gr=3.0, variant='squelch burst (open + static + close)',
        processing='mono; key-up click, 0.45 s band-limited static (BP 300-4 kHz) with fast swell, CC0 squelch tail')
def squelch1(ctx):
    st = mono(ctx.seg('fs-154654', 6.0, 6.6, ch=2, note='walkie-talkie static'))
    st = bp(st, 300, 4000, 2); st = st / np.abs(st).max()
    sq = mono(ctx.seg('fs-522164', 0.0, 0.3, ch=1, note='radio buzz squelch'))
    sq = lp(hp(sq, 200, 2), 5000, 2); sq = sq / np.abs(sq).max()
    y = place(int(1.0 * SR), [(0.0, fade(st[:int(0.45 * SR)], 0.01, 0.04), 0.5), (0.43, sq, 0.6)], circular=False, stereo=False)
    y[:int(0.002 * SR)] += np.linspace(0.5, 0, int(0.002 * SR))
    return fade(trim_tail(y, -55, 0.03), 0.001, 0.05)


@recipe('radio-squelch-2.ogg', 'radio_chatter', lufs_target=-24, peak_db=-4.0, max_gr=3.0, variant='double squelch break (no voice)',
        processing='mono; two short static bursts (0.18 s / 0.3 s) from CC0 radio static, BP 300-4 kHz; CC0 sign-off squelch tail')
def squelch2(ctx):
    st = mono(ctx.seg('fs-524204', 2.0, 3.0, ch=2, note='radio static'))
    st = bp(st, 300, 4000, 2); st = st / np.abs(st).max()
    sq = mono(ctx.seg('fs-524205', 0.0, 1.15, ch=2, note='radio sign-off squelch'))
    sq = lp(hp(sq, 200, 2), 5000, 2); sq = sq / np.abs(sq).max()
    y = place(int(2.0 * SR), [(0.0, fade(st[:int(0.18 * SR)], 0.005, 0.03), 0.45), (0.32, fade(st[int(0.3 * SR):int(0.6 * SR)], 0.005, 0.03), 0.45),
                              (0.6, sq, 0.6)], circular=False, stereo=False)
    return fade(trim_tail(y, -55, 0.03), 0.001, 0.05)


# ---------------------------------------------------------------- flag / objective cues (procedural)
PROC_UI = 'mono; procedural synthesis (original code: polyBLEP oscillators, filtered noise, envelopes); no samples'


def tick(f=1850, dur=0.06, seed=0):
    t = T(dur); e = np.exp(-t / 0.012)
    s = (np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * f * 1.51 * t) + 0.25 * np.sin(2 * np.pi * f * 2.93 * t)) * e
    clk = bp(noise(len(t), seed), 3000, 9000, 2) * np.exp(-t / 0.003) * 0.4
    return s + clk


@recipe('flag-capture-progress-loop.ogg', 'flag_capture_cues', loop=True, lufs_target=-24, max_gr=0,
        variant='capture progress tick loop while in zone (pitch with playbackRate by progress)', processing=PROC_UI + '; exact 2.000 s loop, ticks at 4 Hz, circular placement')
def cap_loop(ctx):
    N = int(2.0 * SR); items = []
    for k in range(8):
        acc = k % 4 == 0
        items.append((k * 0.25, tick(2100 if acc else 1750, 0.07, k), 1.0 if acc else 0.6))
    y = place(N, items, circular=True, stereo=False)
    t = np.arange(N) / SR
    drone = (osc(np.full(N, 110.0), 'saw') * 0.5 + np.sin(2 * np.pi * 55 * t))
    drone = lp(drone, 600, 2) if False else drone
    drone = drone * (0.55 + 0.45 * np.sin(2 * np.pi * 2.0 * t - np.pi / 2) ** 2)  # 2 Hz pulse, periodic in 2 s
    # filter drone circularly (3 copies) so the loop stays seamless
    d3 = lp(np.concatenate([drone] * 3), 520, 2)[N:2 * N]
    y = y + 0.18 * d3 / np.abs(d3).max()
    return y, dict(seam=seam_report(y))


@recipe('flag-captured.ogg', 'flag_capture_cues', lufs_target=-18, peak_db=-2.0, max_gr=3.0, variant='punchy flag captured confirm',
        processing=PROC_UI + '; sub thump 140->48 Hz, two-step rising saw/square chord stab (A3+E4 -> D4+A4+D5), noise shimmer, LP sweep')
def captured(ctx):
    n = int(1.8 * SR); t = np.arange(n) / SR; y = np.zeros(n)
    f = 48 + 92 * np.exp(-t / 0.06); y += np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18) * 1.0
    def stab(freqs, t0, d, g):
        i0 = int(t0 * SR); m = int(d * SR); s = np.zeros(m)
        for fr in freqs: s += osc(np.full(m, fr * 1.0), 'saw') * 0.5 + osc(np.full(m, fr * 1.003), 'square') * 0.25
        s *= adsr(m, 0.004, 0.08, 0.55, d * 0.6)
        s = lp_causal(s, 2600, 2)
        y[i0:i0 + m] += s * g
    stab([220.0, 329.6], 0.0, 0.16, 0.22)
    stab([293.7, 440.0, 587.3], 0.14, 1.4, 0.25)
    sh = hp(noise(n, 7), 5000, 2) * np.exp(-np.maximum(0, t - 0.14) / 0.25) * (t > 0.14) * 0.05
    return fade(y + sh, 0.001, 0.25)


@recipe('flag-lost.ogg', 'flag_capture_cues', lufs_target=-18, peak_db=-2.0, max_gr=3.0, variant='alarming flag lost klaxon alert',
        processing=PROC_UI + '; two-tone descending klaxon (square+saw 660/494 Hz, 3 cycles, 12 Hz tremolo, LP 2.2 kHz), low hit 90->40 Hz')
def lost(ctx):
    n = int(1.9 * SR); t = np.arange(n) / SR
    seq = np.zeros(n); per = 0.22
    for k in range(6):
        i0 = int(k * per * SR); i1 = int((k + 1) * per * SR); seq[i0:i1] = 660.0 if k % 2 == 0 else 494.0
    seq[int(6 * per * SR):] = 494.0
    on = (t < 6 * per + 0.25).astype(float)
    on = signal.filtfilt(*signal.butter(1, 40, fs=SR), on)
    s = (osc(seq, 'square') * 0.6 + osc(seq * 1.005, 'saw') * 0.4) * (0.8 + 0.2 * np.sin(2 * np.pi * 12 * t)) * on
    s = lp_causal(s, 2200, 2) * np.exp(-np.maximum(0, t - 1.0) / 0.3)
    hit = np.sin(2 * np.pi * np.cumsum(40 + 50 * np.exp(-t / 0.05)) / SR) * np.exp(-t / 0.15)
    return fade(0.45 * s + 0.7 * hit, 0.001, 0.2)


@recipe('flag-neutralized.ogg', 'flag_capture_cues', lufs_target=-19, peak_db=-2.0, max_gr=3.0, variant='flag neutralized (power-down drop)',
        processing=PROC_UI + '; descending saw sweep 520->130 Hz through closing LP, mid thump 110->55 Hz, noise swish')
def neutral(ctx):
    n = int(1.1 * SR); t = np.arange(n) / SR
    f = 130 + 390 * np.exp(-t / 0.22)
    s = osc(f, 'saw') * np.exp(-t / 0.35)
    s = lp_causal(s, 1800, 2)
    th = np.sin(2 * np.pi * np.cumsum(55 + 55 * np.exp(-t / 0.05)) / SR) * np.exp(-t / 0.12)
    sw = bp(noise(n, 9), 800, 4000, 2) * np.exp(-t / 0.08) * 0.15
    return fade(0.35 * s + 0.8 * th + sw, 0.001, 0.2)


@recipe('flag-capture-start.ogg', 'flag_capture_cues', lufs_target=-21, peak_db=-3.0, max_gr=3.0, variant='entering zone / capture begins',
        processing=PROC_UI + '; two rising ticks + short sine glide 700->1050 Hz')
def cap_start(ctx):
    n = int(0.6 * SR); t = np.arange(n) / SR
    y = place(n, [(0.0, tick(1600, 0.07, 1), 0.6), (0.11, tick(2100, 0.07, 2), 0.8)], circular=False, stereo=False)
    g = np.sin(2 * np.pi * np.cumsum(700 + 350 * np.minimum(1, t / 0.18)) / SR) * adsr(n, 0.01, 0.1, 0.4, 0.3) * 0.25
    return fade(y + g, 0.001, 0.1)


@recipe('tickets-low-urgency.ogg', 'flag_capture_cues', lufs_target=-19, peak_db=-2.0, max_gr=3.0, variant='low-tickets urgency stinger',
        processing=PROC_UI + '; double heartbeat sub pulses (62 Hz) x2, filtered minor-second alarm swell (A3/Bb3 saw), ticking hi-hat noise')
def tickets(ctx):
    n = int(2.6 * SR); t = np.arange(n) / SR; y = np.zeros(n)
    def beat(t0, g):
        i0 = int(t0 * SR); m = int(0.25 * SR); tt = np.arange(m) / SR
        b = np.sin(2 * np.pi * np.cumsum(62 + 30 * np.exp(-tt / 0.03)) / SR) * np.exp(-tt / 0.07)
        y[i0:i0 + m] += b[:len(y[i0:i0 + m])] * g
    for t0, g in [(0.0, 1.0), (0.22, 0.7), (1.0, 1.0), (1.22, 0.7)]: beat(t0, g)
    sw = (osc(np.full(n, 220.0), 'saw') + osc(np.full(n, 233.1), 'saw')) * 0.5
    sw = lp_causal(sw, 900, 2) * np.clip(t / 1.6, 0, 1) ** 2 * np.exp(-np.maximum(0, t - 1.9) / 0.25)
    hh = np.zeros(n)
    for k in range(10):
        i0 = int(k * 0.25 * SR); m = int(0.03 * SR); hh[i0:i0 + m] += hp(noise(m, 20 + k), 6000, 2) * np.exp(-np.arange(m) / SR / 0.006)
    return fade(0.9 * y + 0.22 * sw + 0.08 * hh, 0.001, 0.3)
