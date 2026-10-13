"""Titan weapon recipes (public/js/audio/titan-bank.js TITAN_SAMPLE_GROUPS). Each returns mono float64 at 48 kHz
(optionally with an info dict); build.py normalizes (LUFS target with a peak cap), encodes and records provenance.
Only CC0 / CC BY / U.S.-government (YouTube CC BY) sources; craigsmith, zapsplat re-uploads, game/film rips and
sources with unclear provenance are excluded (docs/audio/titan-sfx.md). Every cut is recorded via Ctx.seg."""
import numpy as np
from dsp import *

# ---------------------------------------------------------------- helpers
def thump(dur=0.4, f0=80, f1=40, decay=0.1, drive=1.0):
    """Original synthesized sub thump: pitch-dropping sine with exponential decay (optional soft saturation)."""
    t = np.arange(int(dur*SR)) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.05)
    y = np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-t/decay) * (1 - np.exp(-t/0.0015))
    return soft(y, drive) if drive > 1 else y
def ev(c, name, t, dur, note='', pre=0.004):
    return fade(c.seg(name, max(0.0, t - pre), t + dur, note), 0.0005, 0.008)
def nrm(x, p=1.0): return x / (np.abs(x).max() + 1e-12) * p
def decay_after(x, t0, tau):
    t = np.arange(len(x)) / SR; g = np.ones(len(x)); m = t > t0
    g[m] = np.exp(-(t[m] - t0) / tau); return x * g
def frontload(x, window=0.25, pre=0.004):
    """Move a swelling body layer's strongest early 2 ms to the shot onset, retaining a short pre-roll."""
    env = env_follow(x, 2)
    peak = int(np.argmax(env[:min(len(env), int(window*SR))]))
    return fade(x[max(0, peak-int(pre*SR)):], 0.0007, 0.02)
def mix(dur, items):
    """items: (offset_s, signal, gain_db). Signals are peak-normalized first."""
    return place(int(dur*SR), [(o, nrm(x), 10**(g/20)) for o, x, g in items])
def clean(x, lo=30, hi=16000):
    x = hp(x, lo)
    return lp(x, hi) if hi < SR/2 - 100 else x
def shot(c, name, t, dur, note, r=1.0, lo=30, hi=16000):
    """A transient-led cut: declip, band-limit, optional pitch-down, onset at t=0."""
    x = trim_onset(declip(clean(ev(c, name, t, dur, note), lo, hi)), 0.05, 0.0015)
    return rate(x, r) if r != 1.0 else x
def tailcut(c, name, t, dur, note, hi=4000, fin=0.03, fout=0.4):
    """A cut that starts after the transient: no attack of its own, long fade."""
    return fade(lp(hp(c.seg(name, t, t + dur, note), 40), hi), fin, fout)
SYN_THUMP = 'synthesized sub thump (pitch-dropping sine, exponential decay)'

# ================================================================ ION Splitter Rifle
SPL_P = ('declip (cubic spline); HP 30 Hz; onset trimmed to 1.5 ms pre-roll; plasma rifle shot up front (+3 dB at 300 Hz, soft '
         'saturation) + synthesized ion chirp (3 kHz -> 750 Hz in ~40 ms) + real rifle crack under it (LP 3 kHz) + electric zap + '
         'plasma peak aligned within 4 ms; low-mid pulse 210->95 Hz; high shelf -5 dB at 8 kHz; decay from 80 ms; 0.28 s; soft clipper')
def splitter_fire(c, rifle, plasma, zp_, r=0.92, dur=0.28, chirp=(3000, 750)):
    crack = lp(shot(c, *rifle, r=r), 3000)
    pl = frontload(soft(nrm(peq(hp(shot(c, *plasma, r=0.85), 150), 300, 3, 0.9)) * 1.3, 1.0), 0.09)
    zp = hp(shot(c, *zp_), 1800)
    ion = zap(0.08, chirp[0], chirp[1], 0.03)
    y = mix(dur, [(0, pl, 0), (0, ion, -5), (0, decay_after(crack, 0.04, 0.05), -4), (0.004, fade(zp, 0.001, 0.06), -11),
                  (0, thump(0.2, 210, 95, 0.035, 1.4), -5)])
    y = hp(shelf(y, 8000, -5, 'high'), 65)
    return fade(decay_after(y, 0.08, 0.06), 0.0008, 0.08), dict(synth=SYN_THUMP + '; synthesized ion chirp (sine sweep with 3rd harmonic)')

@recipe('splitter/fire-1.ogg', 'tf.splitter.fire', processing=SPL_P, peak_db=-2.0, lufs_target=-14, max_gr=4, clip=True,
        variant='punchy automatic rifle + plasma rifle shot 2 + electric zap')
def _(c): return splitter_fire(c, ('fs-855654', 0.04, 0.5, 'rifle crack and body'), ('fs-331240', 1.61, 0.35, 'plasma shot 2'),
                               ('fs-512471', 0.0, 0.2, 'electric zap, HP 1.8 kHz'))
@recipe('splitter/fire-2.ogg', 'tf.splitter.fire', processing=SPL_P, peak_db=-2.0, lufs_target=-14, max_gr=4, clip=True,
        variant='rifle shot 01 + plasma rifle shot 4 + electric zap 001')
def _(c): return splitter_fire(c, ('fs-433858', 0.015, 0.5, 'rifle crack and body'), ('fs-331240', 4.81, 0.35, 'plasma shot 4'),
                               ('fs-136542', 0.0, 0.3, 'electric zap, HP 1.8 kHz'), r=0.9, chirp=(3300, 820))
@recipe('splitter/fire-3.ogg', 'tf.splitter.fire', processing=SPL_P, peak_db=-2.0, lufs_target=-14, max_gr=4, clip=True,
        variant='rifle shot 02 + plasma rifle shot 6 + tesla zap')
def _(c): return splitter_fire(c, ('fs-484036', 0.015, 0.5, 'rifle crack and body'), ('fs-331240', 8.01, 0.35, 'plasma shot 6'),
                               ('fs-853286', 0.795, 0.2, 'tesla zap, HP 1.8 kHz'), r=0.94, chirp=(2800, 700))
@recipe('splitter/fire-4.ogg', 'tf.splitter.fire', processing=SPL_P, peak_db=-2.0, lufs_target=-14, max_gr=4, clip=True,
        variant='M2010 sniper crack (DVIDS) + plasma rifle shot 8 + electric zap')
def _(c): return splitter_fire(c, ('fs-855608', 0.015, 0.2, 'sniper crack (cut before its echo)'), ('fs-331240', 11.21, 0.35, 'plasma shot 8'),
                               ('fs-512471', 0.0, 0.2, 'electric zap, HP 1.8 kHz'), r=0.88, chirp=(2600, 650))

SPLIT_P = ('declip; onset trimmed; heavy blaster / laser blast up front (+3 dB at 300 Hz) + three staggered synthesized ion chirps '
           '(2.4 kHz -> 500 Hz, 0/12/24 ms: the three beams) + rifle pitched down ~0.72x under them (LP 3 kHz) + saturated sub thump; '
           'three frontloaded plasma discharges staggered 0/12/24 ms lead; HP 65 Hz; high shelf -4 dB at 8 kHz; decay from 0.2 s; soft clipper')
def splitter_split(c, blaster, laser, rifle, chirp=(2400, 500)):
    bl = hp(frontload(peq(shot(c, *blaster, r=0.85), 300, 3, 0.9)), 150)
    la = hp(shot(c, *laser), 400)
    rf = lp(shot(c, *rifle, r=0.72), 3000)
    ion = place(int(0.13*SR), [(d, zap(0.1, chirp[0] * (1 + 0.06*i), chirp[1], 0.04), 1.0) for i, d in enumerate((0, 0.012, 0.024))])
    pl = frontload(hp(shot(c, 'fs-331240', 1.61, 0.35, 'triple ION plasma discharge identity', r=0.7), 180), 0.12)
    triple = place(int(0.4*SR), [(0, nrm(pl), 1), (0.012, rate(nrm(pl), 0.95), 0.7), (0.024, rate(nrm(pl), 1.05), 0.7)])
    y = mix(0.62, [(0, triple, 0), (0, bl, -4), (0.01, la, -8), (0, decay_after(rf, 0.05, 0.08), -9), (0, ion, -6), (0, thump(0.45, 125, 65, 0.08, 1.4), -8)])
    y = hp(shelf(y, 8000, -4, 'high'), 65)
    return fade(decay_after(y, 0.2, 0.12), 0.0015, 0.12), dict(synth=SYN_THUMP + '; three synthesized ion chirps (sine sweeps with 3rd harmonic)')
@recipe('splitter/split-1.ogg', 'tf.splitter.split', processing=SPLIT_P, peak_db=-2.0, lufs_target=-13, max_gr=4, clip=True,
        variant='heavy blaster + LASR blast 2 + rifle pitched down + triple ion chirp')
def _(c): return splitter_split(c, ('fs-702000', 0.015, 0.6, 'heavy blaster shot'), ('fs-660270', 1.0, 0.5, 'laser blast 2, HP 400 Hz'),
                                ('fs-710084', 0.835, 0.5, 'rifle crack pitched down 0.72x, LP 3 kHz'))
@recipe('splitter/split-2.ogg', 'tf.splitter.split', processing=SPLIT_P, peak_db=-2.0, lufs_target=-13, max_gr=4, clip=True,
        variant='LASR blast 5 + warp rifle blast + rifle pitched down + triple ion chirp')
def _(c): return splitter_split(c, ('fs-660270', 5.69, 0.5, 'laser blast 5'), ('fs-705494', 0.19, 0.5, 'warp rifle blast, HP 400 Hz'),
                                ('fs-484036', 0.015, 0.5, 'rifle crack pitched down 0.72x, LP 3 kHz'), chirp=(2100, 450))

def flanger(x, depth_ms=2.5, base_ms=1.0, rate_hz=0.7, mix_=0.5):
    """Mono flanger: x plus a copy read through a slowly swept 1-3.5 ms delay (original processing code)."""
    n = np.arange(len(x)); d = (base_ms + depth_ms * (0.5 + 0.5*np.sin(2*np.pi*rate_hz*n/SR))) * SR / 1000
    return x + mix_ * np.interp(n - d, n, x, left=0.0)
SPL_T = ('cut after the transient (no attack): rifle forest-reverb tail pitched down 0.6x (LP 4.5 kHz) + plasma shot decay (HP 450 Hz) '
         '+ thunder rumble LP 180 Hz; mono flanger (1-3.5 ms sweep) for an ionized shimmer; bell -3 dB at 3 kHz; 30 ms fade-in, '
         'long cosine fade-out')
def splitter_tail(c, rifle, plasma, rumble, dur):
    a = rate(tailcut(c, *rifle, 4500, 0.03, 0.6), 0.6)
    b = hp(tailcut(c, *plasma, 9000, 0.02, 0.4), 450)
    r = lp(tailcut(c, *rumble, 1000, 0.05, 0.6), 180)
    y = mix(dur, [(0, a, -6), (0, b, -1), (0, r, -16)])
    return fade(hp(peq(flanger(y), 3000, -3, 1.0), 100), 0.03, 0.5)
@recipe('splitter/tail-1.ogg', 'tf.splitter.tail', processing=SPL_T, peak_db=-3.0, lufs_target=-22,
        variant='rifle forest reverb tail pitched down + plasma decay + thunder rumble, flanged')
def _(c): return splitter_tail(c, ('fs-723532', 0.69, 0.75, 'forest reverb tail after shot 1'), ('fs-331240', 1.75, 0.6, 'plasma shot 2 decay'),
                               ('fs-567945', 3.8, 1.3, 'thunder rumble, LP 180 Hz'), 1.25)
@recipe('splitter/tail-2.ogg', 'tf.splitter.tail', processing=SPL_T, peak_db=-3.0, lufs_target=-22,
        variant='rifle forest reverb tail (later shot) pitched down + plasma decay + thunder rumble, flanged')
def _(c): return splitter_tail(c, ('fs-723532', 9.53, 0.75, 'forest reverb tail after shot 8'), ('fs-331240', 8.15, 0.6, 'plasma shot 6 decay'),
                               ('fs-840628', 2.0, 1.3, 'thunder rumble, LP 180 Hz'), 1.25)

SPL_I = ('onset trimmed; HV discharge crack at 0 ms (HP 3 kHz, high shelf +3 dB at 6 kHz) + energy/bullet hit + sparks with an '
         'exponential decay + metal body pitched down (notched at 1.05 kHz) + sub dive 150->45 Hz; bell -3.5 dB at 270 Hz; '
         'plasma impact body and short 3.8->1.2 kHz ion chirp lead over the kinetic hit; exponential decay from 80 ms; soft clipper')
def splitter_impact(c, hit, sparks, body, crack, dur=0.45):
    h = shot(c, *hit)
    sp = decay_after(hp(shot(c, *sparks), 2000), 0.05, 0.12)
    m = peq(lp(shot(c, *body, r=0.8), 1200), 1050, -8, 5)
    k = shelf(hp(shot(c, *crack), 3000), 6000, 3, 'high')
    energy = hp(shot(c, 'fs-440668', 0.27, 0.32, 'ion energy impact identity', r=1.15), 500)
    y = mix(dur, [(0, decay_after(energy, 0.04, 0.08), 0), (0, h, -5), (0, fade(k, 0.0005, 0.04), -5), (0.004, sp, -9),
                  (0, m, -8), (0, zap(0.06, 3800, 1200, 0.022), -6), (0, thump(0.25, 150, 65, 0.05, 1.4), -9)])
    y = peq(y, 270, -3.5, 1.0)
    return fade(decay_after(y, 0.08, 0.12), 0.001, 0.12), dict(synth=SYN_THUMP + '; synthesized impact ion chirp (3.8->1.2 kHz, 22 ms decay)')
@recipe('splitter/impact-1.ogg', 'tf.splitter.impact', processing=SPL_I, peak_db=-2.0, lufs_target=-15, max_gr=4, clip=True,
        variant='laser impact + HV crack + welding sparks + heavy metal body')
def _(c): return splitter_impact(c, ('fs-440668', 0.27, 0.4, 'laser impact hit', ), ('fs-396240', 0.785, 0.4, 'welding sparks'),
                                 ('fs-614062', 0.0, 0.4, 'heavy metal impact body, pitched 0.8x, LP 1.2 kHz'), ('fs-415962', 7.35, 0.05, 'HV discharge crack'))
@recipe('splitter/impact-2.ogg', 'tf.splitter.impact', processing=SPL_I, peak_db=-2.0, lufs_target=-15, max_gr=4, clip=True,
        variant='bullet-on-metal hit + HV crack + tesla zap sparks + sheet-metal body')
def _(c): return splitter_impact(c, ('fs-182263', 0.105, 0.35, 'bullet hit metal'), ('fs-853286', 0.795, 0.35, 'tesla zap as sparks'),
                                 ('fs-492177', 4.335, 0.4, 'metal sheet hit body, pitched 0.8x, LP 1.2 kHz'), ('fs-415962', 9.41, 0.05, 'HV discharge crack'))
@recipe('splitter/impact-3.ogg', 'tf.splitter.impact', processing=SPL_I, peak_db=-2.0, lufs_target=-15, max_gr=4, clip=True,
        variant='visceral bullet impact + HV crack + welding spark burst + metal collision body')
def _(c): return splitter_impact(c, ('fs-423301', 1.215, 0.35, 'bullet impact'), ('fs-396240', 1.615, 0.45, 'welding spark burst'),
                                 ('fs-386798', 0.515, 0.4, 'metal collision body, pitched 0.8x, LP 1.2 kHz'), ('fs-415962', 10.695, 0.05, 'HV discharge crack'))

@recipe('splitter/reload-1.ogg', 'tf.splitter.reload', peak_db=-3.0, lufs_target=-20, max_gr=4, clip=True,
        processing=('latch clunks pitched down 0.65x (cell out) + pitched-down metal clank + charge-up whine (cell spins up) + '
                    'shell-load click pitched 0.6x with a heavy clank and sub thump (cell lock); EQ +4 dB at 200 Hz, high shelf '
                    '-5 dB at 5 kHz; cosine fades'),
        variant='RPG-7 latch (cell out) + sci-fi charge up whine + shell-load click and metal clank (lock)')
def _(c):
    out = rate(ev(c, 'fs-725401', 3.33, 0.42, 'launcher latch clunks = cell out'), 0.65)
    k1 = clank(c, 'fs-492177', 4.14, 'metal sheet hit = cell release clank, pitched 0.5x')
    wh = rate(ev(c, 'fs-558679', 0.0, 1.2, 'sci-fi charge up = cell whine'), 0.85)
    lock = rate(ev(c, 'fs-108793', 0.2, 0.3, 'shell load click = cell lock'), 0.6)
    k2 = clank(c, 'fs-406197', 0.31, 'heavy metal door slam = cell lock clank, pitched 0.6x', r=0.6, hi=2000, tau=0.09)
    y = mix(1.5, [(0, out, 0), (0.0, k1, -8), (0.42, fade(lp(wh, 6000), 0.08, 0.25), -9), (1.0, lock, -2), (1.0, k2, -5),
                  (1.0, thump(0.25, 120, 45, 0.06, 1.6), -9)])
    return fade(titan_eq(y), 0.002, 0.15), dict(synth=SYN_THUMP)

# ================================================================ Scorch T-203 Thermite Launcher
T_P = ('declip; HP 30 Hz; onset trimmed; grenade-launcher round pitched down ~0.7x + mortar launch body (LP 1.2 kHz) + breech '
       'body peak frontloaded within 5 ms; clank at 5 ms + sub thump 110->50 Hz (0.1 s) + fire whoosh, flare hiss and fizzle '
       '(thermite); fire-3 body notched at 1.4 kHz; bell -3 dB at 500 Hz and 180 Hz; exponential decay from 0.3 s; soft clipper')
def t203_fire(c, launch, body, whoosh, clank_, pops, r=0.7, br=0.8, notch=None):
    a = shot(c, *launch, r=r)
    b = frontload(lp(shot(c, *body, r=br), 1200))
    if notch: b = peq(b, notch, -14, 8)
    w = hp(ev(c, *whoosh), 600)
    f = hp(c.seg('fs-348767', 0.0, 0.35, 'road flare ignition hiss, HP 2.5 kHz'), 2500)
    p = bp(c.seg(*pops), 2000, 6000)
    k = clank(c, *clank_, r=0.6, hi=2500, tau=0.04)
    y = mix(0.7, [(0, a, 0), (0, b, -3), (0.005, k, -12), (0.04, fade(w, 0.03, 0.2), -11), (0.05, fade(f, 0.03, 0.2), -17),
                  (0.06, fade(p, 0.02, 0.25), -14), (0, thump(0.5, 110, 50, 0.1, 1.8), -5)])
    y = peq(peq(y, 500, -3, 1.0), 180, -3, 1.0)
    return fade(decay_after(y, 0.3, 0.2), 0.0015, 0.15), dict(synth=SYN_THUMP)
@recipe('t203/fire-1.ogg', 'tf.t203.fire', processing=T_P, peak_db=-2.0, lufs_target=-14, max_gr=5, clip=True,
        variant='M203 (U.S. gov. video) + 120 mm mortar body + breech clank + fire whoosh + flare hiss')
def _(c): return t203_fire(c, ('fs-162402', 0.015, 0.45, 'M203 launch'), ('fs-854478', 0.0, 0.7, '120 mm mortar launch body, LP 1.2 kHz'),
                           ('fs-244926', 0.95, 0.45, 'fire whoosh, HP 600 Hz'), ('fs-614062', 0.0, 'heavy metal impact = breech clank'),
                           ('fs-404999', 0.2, 0.6, 'firecracker fizzle = thermite crackle, band 2-6 kHz'))
@recipe('t203/fire-2.ogg', 'tf.t203.fire', processing=T_P, peak_db=-2.0, lufs_target=-14, max_gr=5, clip=True,
        variant='grenade launcher + M-327 mortar shot 1 + breech clank + fire whoosh + flare hiss')
def _(c): return t203_fire(c, ('fs-163458', 0.015, 0.4, 'grenade launcher launch'), ('fs-187542', 0.015, 0.7, 'M-327 mortar launch body, LP 1.2 kHz'),
                           ('fs-260555', 0.4, 0.5, 'fire whoosh, HP 600 Hz'), ('fs-492177', 4.14, 'metal sheet hit = breech clank'),
                           ('fs-404999', 9.0, 9.6, 'firecracker fizzle = thermite crackle, band 2-6 kHz'), r=0.68, br=0.78)
@recipe('t203/fire-3.ogg', 'tf.t203.fire', processing=T_P, peak_db=-2.0, lufs_target=-14, max_gr=5, clip=True,
        variant='Mk 19 single round (U.S. gov.) + M-327 mortar shot 2 + breech clank + fire whoosh + flare hiss')
def _(c): return t203_fire(c, ('fs-182792', 2.72, 0.14, 'Mk 19 single round (cut before the next)'), ('fs-187542', 2.005, 0.7, 'M-327 mortar launch body, LP 1.2 kHz'),
                           ('fs-244926', 2.26, 0.4, 'fire whoosh, HP 600 Hz'), ('fs-547979', 1.785, 'sheet metal bang = breech clank'),
                           ('fs-404999', 6.0, 6.6, 'firecracker fizzle = thermite crackle, band 2-6 kHz'), r=0.72, br=0.76, notch=1400)

@recipe('t203/tail-1.ogg', 'tf.t203.tail',
        processing=('cuts after the transient; HP 40 Hz, LP 1.6-2 kHz; notch -12 dB at 1.57 kHz (source whistle); bell -3 dB at 480 Hz; '
                    '+ faint fire roar (HP 600 Hz) for the incendiary trail; 40 ms fade-in, long cosine fade-out'),
        peak_db=-3.0, lufs_target=-22, variant='mortar shot tails (M-327 + 120 mm) + fire roar')
def _(c):
    a = rate(tailcut(c, 'fs-187542', 0.2, 1.4, 'M-327 tail after shot 1', 2000, 0.04, 0.7), 0.9)
    b = rate(tailcut(c, 'fs-854478', 0.35, 1.35, '120 mm mortar tail', 1600, 0.04, 0.7), 0.9)
    f = hp(tailcut(c, 'fs-260555', 0.6, 1.2, 'fire whoosh roar, HP 600 Hz', 6000, 0.05, 0.6), 600)
    y = mix(1.5, [(0, a, 0), (0, b, -3), (0.02, f, -14)])
    return peq(peq(y, 1570, -12, 8), 480, -3, 1.0)

T_M = ('shotgun rack / launcher latch pitched down 0.65x (titan breech) + pitched-down heavy metal clank and sub thump on the '
       'breech close + short servo whine; EQ +4 dB at 200 Hz, high shelf -5 dB at 5 kHz; cosine fades')
@recipe('t203/mech-1.ogg', 'tf.t203.mech', processing=T_M, peak_db=-3.0, lufs_target=-19, max_gr=4, clip=True,
        variant='shotgun rack pitched down + door-slam clank + servo')
def _(c):
    a = hp(rate(ev(c, 'fs-436074', 2.31, 0.5, 'shotgun rack clank-clank (2.33 / 2.65 s)'), 0.65), 50)
    k = clank(c, 'fs-406197', 0.31, 'heavy metal door slam = breech close, pitched 0.6x', r=0.6, hi=2000, tau=0.1)
    sv = servo(c, 19.0, 0.3, 0.3, 0.5, 'electric motor whir = breech servo')
    y = mix(0.78, [(0, a, 0), (0.07, sv, -18), (0.52, k, -4), (0.52, thump(0.25, 100, 40, 0.07, 1.6), -7)])
    return fade(titan_eq(y), 0.002, 0.12), dict(synth=SYN_THUMP)
@recipe('t203/mech-2.ogg', 'tf.t203.mech', processing=T_M, peak_db=-3.0, lufs_target=-19, max_gr=4, clip=True,
        variant='RPG-7 loading latch pitched down + shell load + heavy metal clank + servo')
def _(c):
    a = hp(rate(ev(c, 'fs-725401', 3.34, 0.36, 'launcher latch clunks'), 0.65), 50)
    b = rate(ev(c, 'fs-108793', 0.05, 0.3, 'shell load click'), 0.55)
    k = clank(c, 'fs-614062', 0.0, 'heavy metal impact = breech close, pitched 0.55x', r=0.55, hi=2000, tau=0.1)
    y = mix(0.75, [(0, a, 0), (0.18, b, -5), (0.5, k, -4), (0.5, thump(0.25, 100, 40, 0.07, 1.6), -7)])
    return fade(titan_eq(y), 0.002, 0.12), dict(synth=SYN_THUMP)

T_I = ('declip; onset trimmed; explosion body HP 70 Hz + flare crack slap at 0 ms (HP 2 kHz) + spattering fizzle/pops and fire crackle '
       '+ road-flare sizzle forward (high shelf -3 dB at 8 kHz, exponential decay from 0.3 s) + saturated sub thump (0.12 s decay); '
       'bell -3.5 dB at 250 Hz; exponential decay from 0.4 s; soft clipper')
def t203_impact(c, blast, pops, crackle, flare, extra=None):
    b = hp(shot(c, *blast, lo=25), 70)
    k = hp(shot(c, 'fs-450837', 0.055, 0.25, 'flare crack slap, HP 2 kHz'), 2000)
    p = hp(c.seg(*pops), 1500)
    cr = hp(c.seg(*crackle), 1000)
    f = shelf(hp(c.seg(*flare), 1500), 8000, -3, 'high')
    f = fade(decay_after(f, 0.3, 0.45), 0.05, 0.3)
    items = [(0, b, 0), (0, k, -4), (0.08, fade(p, 0.03, 0.4), -10), (0.1, fade(cr, 0.05, 0.4), -12), (0.06, f, -6),
             (0, thump(0.6, 80, 32, 0.12, 2.0), -5)]
    if extra: items.append(extra)
    y = peq(mix(1.6, items), 250, -3.5, 0.8)
    return fade(decay_after(y, 0.4, 0.4), 0.0015, 0.3), dict(synth=SYN_THUMP)
@recipe('t203/impact-1.ogg', 'tf.t203.impact', processing=T_I, peak_db=-2.0, lufs_target=-14, max_gr=3, clip=True,
        variant='medium blast + flare crack + firecracker fizzle + fire crackle + road flare burn')
def _(c): return t203_impact(c, ('fs-516914', 0.325, 1.2, 'medium blast'), ('fs-404999', 0.2, 1.5, 'firecracker fizzle and pops, HP 1.5 kHz'),
                             ('fs-363093', 5.0, 6.4, 'fire crackle, HP 1 kHz'), ('fs-348767', 2.0, 3.4, 'road flare burning, HP 1.5 kHz'))
@recipe('t203/impact-2.ogg', 'tf.t203.impact', processing=T_I, peak_db=-2.0, lufs_target=-14, max_gr=3, clip=True,
        variant='DoD explosive (U.S. gov.) + flare crack + firecracker pops + fire crackle + sizzle')
def _(c): return t203_impact(c, ('fs-182432', 0.61, 1.1, 'explosive blast (DoD video audio)'), ('fs-404999', 9.0, 10.3, 'firecracker fizzle and pops, HP 1.5 kHz'),
                             ('fs-363093', 12.0, 13.4, 'fire crackle, HP 1 kHz'), ('fs-569609', 2.21, 3.6, 'sizzle, HP 1.5 kHz'))
@recipe('t203/impact-3.ogg', 'tf.t203.impact', processing=T_I, peak_db=-2.0, lufs_target=-14, max_gr=3, clip=True,
        variant='explosion + M406 HE on gravel + flare crack + pops + crackle + road flare ignite')
def _(c):
    h = hp(shot(c, 'fs-151076', 0.0, 0.7, 'M406 HE round on gravel (normalized; quiet source)', lo=25), 70)
    return t203_impact(c, ('fs-220062', 0.075, 1.0, 'explosion'), ('fs-404999', 19.5, 20.8, 'firecracker fizzle and pops, HP 1.5 kHz'),
                       ('fs-363093', 20.0, 21.4, 'fire crackle, HP 1 kHz'), ('fs-348767', 0.0, 1.4, 'road flare ignition, HP 1.5 kHz'), (0, h, -4))

@recipe('t203/burn-1.ogg', 'tf.t203.burn',
        processing=('road flare burn (HP 1.5 kHz, -5 dB) + fire roar pitched 0.6x (LP 900 Hz: combustion body) + fire crackle and '
                    'firecracker pops (spitting) + sizzle; 150 ms fade-in, exponential decay from 0.8 s, cosine fade-out'),
        peak_db=-3.0, lufs_target=-22, variant='road flare + low fire roar + crackle and pops + sizzle')
def _(c):
    f = hp(c.seg('fs-348767', 1.25, 4.15, 'road flare steady burn, HP 1.5 kHz'), 1500)
    r = lp(rate(c.seg('fs-260555', 0.3, 2.1, 'fire whoosh roar, pitched 0.6x, LP 900 Hz'), 0.6), 900)
    cr = hp(c.seg('fs-363093', 7.0, 9.9, 'fire crackle, HP 800 Hz'), 800)
    p = hp(c.seg('fs-404999', 19.4, 22.3, 'firecracker fizzle and pops = spitting, HP 1.2 kHz'), 1200)
    s_ = hp(c.seg('fs-569609', 1.84, 4.74, 'sizzle, HP 2 kHz'), 2000)
    y = mix(2.9, [(0, f, -5), (0, fade(r, 0.1, 0.8), -3), (0, cr, -6), (0, p, -10), (0, s_, -12)])
    t = np.arange(len(y)) / SR
    return fade(y * np.where(t < 0.8, 1, np.exp(-(t - 0.8) / 0.9)), 0.15, 0.6)

# ================================================================ Northstar Plasma Railgun
@recipe('railgun/charge-1.ogg', 'tf.railgun.charge', peak_db=-2.5, lufs_target=-18,
        processing=('real Tesla-coil buzz under tape varispeed 0.55x->1.25x (rising pitch) + laser charge-ups time-compressed + servo/'
                    'transformer whine (motor under varispeed) + synthesized sub power sweep 40->120 Hz; bell -3.5 dB at 4 kHz; '
                    'exponential crescendo (slow for 1 s, swelling over the last 0.6 s) with an 18 Hz tremolo in the last 0.3 s; '
                    'ends at its peak (10 ms end fade)'),
        variant='Tesla coil (varispeed rising) + laser charges + servo whine + sub sweep')
def _(c):
    t = c.seg('fs-145506', 4.0, 7.0, 'Tesla coil buzz (varispeed rising)')
    tv = lp(hp(varispeed(t, 0.55, 1.25, 1.6, 1.3), 80), 9000)
    a = rate(c.seg('fs-701702', 0.0, 1.78, 'laser charge rising whine'), 1.11)
    b = c.seg('fs-592573', 0.0, 1.05, 'laser charge up (stronger)')
    sv = servo(c, 17.0, 1.6, 0.35, 1.1, 'electric motor whir = transformer/servo whine')
    n = int(1.6*SR); k = np.linspace(0, 1, n); tt = np.arange(n) / SR
    fr = 40 + 80 * k ** 1.5; sub = soft(np.sin(2*np.pi*np.cumsum(fr)/SR), 1.8)
    y = mix(1.6, [(0, tv, 0), (0, a, -3), (0.55, fade(b, 0.2, 0.01), -6), (0, sv, -12), (0, sub, -6)])
    env = 0.12 + 0.88 * (np.exp(3.2 * k) - 1) / (np.exp(3.2) - 1)
    trem = np.where(tt > 1.3, 1 - 0.25 * (0.5 + 0.5 * np.sin(2*np.pi*18*(tt - 1.3))), 1.0)
    y = peq(y, 4000, -3.5, 1.0) * env * trem
    return fade(y, 0.02, 0.01), dict(synth='synthesized sub power sweep (sine 40 -> 120 Hz, soft-saturated)')
@recipe('railgun/hold-1.ogg', 'tf.railgun.hold', loop=True, peak_db=-4.0, lufs_target=-18,
        processing=('Tesla buzz at 1.25x (the charge end pitch) + railgun charge loop tiled; LP 5.5 kHz (24 dB/oct), bell -5 dB at '
                    '3.2 kHz; seamless loop via equal-power overlap, rotated to a quiet upward zero crossing; + synthesized 58 Hz sub and '
                    '160 Hz body hum and a 5 Hz tremolo (12 %), all with whole cycles over the loop'),
        variant='Tesla buzz + railgun charge loop + sub/body hum with a slow tremolo')
def _(c):
    t = rate(c.seg('fs-145506', 12.0, 14.4, 'Tesla coil buzz at 1.25x'), 1.25)
    lp_ = c.seg('fs-785400', 0.0, 0.8, 'railgun charge loop (tiled 3x)')
    tl = np.tile(lp_, 3)[:len(t)]
    y = peq(lp(lp(hp(nrm(t) + 0.55*nrm(tl), 80), 5500), 5500), 3200, -5, 1.2)
    loop, info = make_loop(y, 1.6, X=0.2, search=0.06)
    n = len(loop); L = n / SR; tt = np.arange(n) / SR
    f_sub, f_body, f_trem = round(58*L)/L, round(160*L)/L, round(5*L)/L
    hum = soft(0.8*np.sin(2*np.pi*f_sub*tt) + 0.35*np.sin(2*np.pi*f_body*tt), 1.5)
    loop = nrm(loop) * (1 - 0.12*(0.5 + 0.5*np.cos(2*np.pi*f_trem*tt))) + 0.45*hum
    info['synth'] = f'synthesized sub and body hum ({f_sub:.2f} Hz + {f_body:.2f} Hz sines, soft-saturated) and {f_trem:.2f} Hz tremolo'
    return loop, info

@recipe('railgun/ready-1.ogg', 'tf.railgun.ready', peak_db=-3.0, lufs_target=-20,
        processing=('clang transient HP 1.2 kHz (decays within 40 ms) + gong crash pitched 1.4x (HP 500 Hz, LP 7 kHz, 0.25 s decay) + '
                    'synthesized rising energy chirp (300->1500 Hz, 45 ms) and two-step chime (880/1320/1980 Hz then 1175/1760 Hz, '
                    'smooth 3 ms attacks, exponential decay 120 ms); cosine fade-out'),
        variant='clang tick + gong shimmer + synthesized chirp and chime')
def _(c):
    k = hp(decay_after(shot(c, 'fs-812592', 0.0, 0.2, 'clang transient, HP 1.2 kHz'), 0.01, 0.03), 1200)
    g = lp(hp(rate(shot(c, 'fs-799184', 0.015, 0.5, 'gong crash, pitched 1.4x, HP 500 Hz, LP 7 kHz'), 1.4), 500), 7000)
    n = int(0.42*SR); tt = np.arange(n) / SR
    def chime(t0, fs, tau=0.12):
        u = np.clip(tt - t0, 0, None); on = (1 - np.exp(-u/0.003)) * (tt >= t0)
        return sum(a * np.sin(2*np.pi*f*u) for f, a in fs) * np.exp(-u/tau) * on
    ch = chime(0.0, [(880, 1.0), (1320, 0.5), (1980, 0.25)]) + 0.8*chime(0.075, [(1175, 1.0), (1760, 0.45)])
    m = int(0.045*SR); fr = 300 + 1200*np.linspace(0, 1, m)**2
    chirp = np.r_[np.sin(2*np.pi*np.cumsum(fr)/SR) * np.sin(np.linspace(0, np.pi, m)), np.zeros(n - m)]
    y = mix(0.42, [(0, k, -6), (0, decay_after(g, 0.02, 0.25), -10), (0, chirp, -12), (0.02, ch, 0)])
    return fade(y, 0.001, 0.12), dict(synth='synthesized rising chirp (300->1500 Hz) and two-step chime (sines 880/1320/1980 Hz, then 1175/1760 Hz)')

def zap(dur=0.06, f0=6000, f1=200, tau=0.035):
    """Original synthesized plasma zap: exponential pitch sweep (sine + 3rd harmonic), fast decay."""
    t = np.arange(int(dur*SR)) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.012)
    ph = 2*np.pi*np.cumsum(f)/SR
    return (np.sin(ph) + 0.35*np.sin(3*ph)) * np.exp(-t/tau) * (1 - np.exp(-t/0.0005))
SYN_ZAP = 'synthesized plasma zap (sine sweep 6 kHz -> 200 Hz in ~35 ms, with 3rd harmonic)'
R_F = ('declip; HP 45 Hz; frontloaded CC0 Doomsday plasma cannon discharge + real railgun/cannon blast body + supersonic crack (rifle, HP) + high-voltage arc + crackle '
       'tail + synthesized plasma zap + close thunder crack shaped to a fast attack (exp decay from 30 ms, 0.4 s) + saturated sub thump; '
       'plasma/crack/arc up front, blast -7 dB and thunder -12 dB under them; crack +3 dB at 4.5 kHz; bell -4 dB at 330 Hz; '
       'exponential decay from 0.6 s; soft clipper')
def railgun_fire(c, blast, crack, arc, crackle, thunder, zr=1.0, dur=1.3):
    rg = decay_after(frontload(shot(c, *blast, lo=45)), 0.04, 0.25)
    plasma = decay_after(frontload(shot(c, 'oga-doomsday', 2.005, 1.1, 'CC0 plasma cannon discharge (after the charge)', r=0.85)), 0.03, 0.23)
    cr = hp(shot(c, *crack), 1800)
    ar = hp(shot(c, *arc), 1500)
    ck = hp(c.seg(*crackle), 2000)
    th = decay_after(lp(shot(c, *thunder), 2200), 0.03, 0.4)
    y = mix(dur, [(0, plasma, -1), (0, rg, -7), (0, peq(cr, 4500, 3, 0.8), -3), (0.002, fade(ar, 0.001, 0.2), -5), (0.06, fade(ck, 0.03, 0.3), -12),
                  (0, rate(zap(), zr), -10), (0, th, -12), (0, thump(0.6, 110, 45, 0.12, 1.7), -7)])
    y = peq(y, 330, -4, 0.8)
    return fade(decay_after(y, 0.6, 0.3), 0.0015, 0.3), dict(synth=SYN_THUMP + '; ' + SYN_ZAP)
@recipe('railgun/fire-1.ogg', 'tf.railgun.fire', processing=R_F, peak_db=-1.5, lufs_target=-12, max_gr=5, clip=True,
        variant='Navy railgun shot 1 (U.S. gov.) + .50 BMG crack + Jacob\'s ladder arc + HV crackle + plasma zap + close thunder')
def _(c): return railgun_fire(c, ('fs-162260', 0.025, 1.4, 'railgun test shot 1 (U.S. gov. video audio)'), ('fs-668071', 0.02, 0.3, '.50 BMG crack, HP 1.8 kHz'),
                              ('fs-19487', 0.09, 0.5, "Jacob's ladder arc, HP 1.5 kHz"), ('fs-415962', 9.40, 9.9, 'HV discharge crackle tail, HP 2 kHz'),
                              ('fs-840628', 0.655, 1.2, 'close thunder strike, LP 2.2 kHz, fast decay'))
@recipe('railgun/fire-2.ogg', 'tf.railgun.fire', processing=R_F, peak_db=-1.5, lufs_target=-12, max_gr=5, clip=True,
        variant='Navy railgun shot 2 (U.S. gov.) + sniper crack + HV discharge + crackle + plasma zap + thunder crack')
def _(c): return railgun_fire(c, ('fs-162260', 2.98, 1.4, 'railgun test shot 2 (U.S. gov. video audio)'), ('fs-855608', 0.015, 0.2, 'sniper crack, HP 1.8 kHz'),
                              ('fs-415962', 7.35, 0.4, 'high-voltage discharge, HP 1.5 kHz'), ('fs-415962', 11.54, 12.04, 'HV discharge crackle tail, HP 2 kHz'),
                              ('fs-567945', 1.855, 1.1, 'close thunder crack, LP 2.2 kHz, fast decay'), zr=0.85)
@recipe('railgun/fire-3.ogg', 'tf.railgun.fire', processing=R_F, peak_db=-1.5, lufs_target=-12, max_gr=5, clip=True,
        variant='ultra-heavy cannon + .50 BMG crack + HV discharge + crackle + plasma zap + very close thunder')
def _(c): return railgun_fire(c, ('fs-807664', 0.015, 0.3, 'ultra-heavy cannon shot (cut before its second event)'), ('fs-668071', 0.77, 0.25, '.50 BMG second report, HP 1.8 kHz'),
                              ('fs-19487', 0.09, 0.5, "Jacob's ladder arc, HP 1.5 kHz"), ('fs-415962', 10.69, 11.19, 'HV discharge crackle tail, HP 2 kHz'),
                              ('fs-321654', 0.72, 1.2, 'very close thunder crack, LP 2.2 kHz, fast decay'), zr=1.15)

R_T = ('plasma-cannon decay cut after the discharge (HP 350 Hz, LP 8 kHz) leads; thunder and acoustic tail HP 90/120 Hz '
       'at -9/-12 dB, welding crackle at -5 dB and descending 1.8 kHz->550 Hz resonance at -12 dB; '
       '60 ms fade-in, no fresh transient; bell -3.5 dB at 250 Hz; long cosine fade-out')
def rail_tail(c, a, b, k, dur):
    plasma = hp(tailcut(c, 'oga-doomsday', 2.25, 1.15, 'plasma-cannon decay, no discharge attack', 8000, 0.06, 0.65), 350)
    resonance = fade(zap(0.9, 1800, 550, 0.3), 0.08, 0.35)
    x = mix(dur, [(0, plasma, 0), (0, hp(tailcut(c, *a[:3], 5000, 0.06, 1.2), 90), -9),
                  (0, hp(tailcut(c, *b[:3], 4000, 0.06, 1.0), 120), -12),
                  (0, hp(tailcut(c, *k, 14000, 0.04, 0.7), 3000), -5), (0, resonance, -12)])
    return fade(peq(x, 250, -3.5, 0.8), 0.06, 0.7), dict(synth='synthesized falling plasma resonance (1.8 kHz->550 Hz, sine and 3rd harmonic)')
@recipe('railgun/tail-1.ogg', 'tf.railgun.tail', processing=R_T, peak_db=-3.0, lufs_target=-21, variant='close thunder roll + railgun test tail + crackle')
def _(c): return rail_tail(c, ('fs-840628', 1.0, 2.7, 'thunder roll after the strike', 2500), ('fs-162260', 0.55, 2.4, 'railgun test shot 1 tail', 1500, -4),
                           ('fs-396240', 1.65, 1.4, 'welding spark crackle, HP 3 kHz'), 2.7)
@recipe('railgun/tail-2.ogg', 'tf.railgun.tail', processing=R_T, peak_db=-3.0, lufs_target=-21, variant='very close thunder roll + thunder rumble + crackle')
def _(c): return rail_tail(c, ('fs-321654', 1.05, 2.8, 'thunder roll after the crack', 3000), ('fs-567945', 2.35, 2.6, 'thunder rumble', 2000, -5),
                           ('fs-396240', 2.0, 1.5, 'welding spark crackle, HP 3 kHz'), 2.8)

R_I = ('onset trimmed; heavy metal hit pitched down ~0.7x (notches on its ring) + supersonic crack + short pitched-down discharge + '
       'plasma sizzle tail (HP 2 kHz, 0.4 s) + mid crunch (band 300-800 Hz) + sub thump; layers glued by a soft saturation; '
       'exponential decay, cosine fade-out')
@recipe('railgun/impact-1.ogg', 'tf.railgun.impact', processing=R_I, peak_db=-2.0, lufs_target=-14, max_gr=4, clip=True,
        variant='heavy metal impact + bullet hit metal + HV discharge + plasma sizzle')
def _(c):
    m = peq(peq(shot(c, 'fs-614062', 0.0, 0.9, 'heavy metal impact, pitched 0.7x, notched at 1.05/2.6 kHz', r=0.7), 1050, -6, 6), 2600, -5, 6)
    b = shot(c, 'fs-182263', 0.105, 0.5, 'bullet hit metal (kinetic crack)')
    a = hp(shot(c, 'fs-415962', 10.695, 0.3, 'HV discharge, pitched 0.8x, HP 1 kHz', r=0.8), 1000)
    z = hp(c.seg('fs-569609', 2.56, 3.2, 'sizzle = plasma dispersion, HP 2 kHz'), 2000)
    y = mix(0.9, [(0, m, 0), (0, b, -4), (0.003, fade(a, 0.001, 0.15), -6), (0.03, fade(z, 0.02, 0.35), -13),
                  (0, thump(0.8, 85, 36, 0.16, 2.0), -4)])
    y = soft(nrm(y) * 1.4, 1.0)
    return fade(decay_after(y, 0.25, 0.22), 0.0015, 0.25), dict(synth=SYN_THUMP)
@recipe('railgun/impact-2.ogg', 'tf.railgun.impact', processing=R_I, peak_db=-2.0, lufs_target=-14, max_gr=4, clip=True,
        variant='.50 BMG crack + metal smash + short pitched-down arc + crunch + laser impact thump')
def _(c):
    k = hp(shot(c, 'fs-668071', 0.02, 0.15, '.50 BMG crack (kinetic transient), HP 1.2 kHz'), 1200)
    m = peq(shot(c, 'fs-562198', 0.075, 0.8, 'metal smash, pitched 0.75x, notched at 1.9 kHz', r=0.75), 1900, -5, 3)
    a = hp(fade(rate(shot(c, 'fs-19487', 0.09, 0.12, "Jacob's ladder burst, pitched 0.6x"), 0.6), 0.001, 0.08), 400)
    cr = bp(shot(c, 'fs-813054', 0.0, 0.5, 'big robot footstep = crunch, band 300-800 Hz', r=0.8), 300, 800)
    l = lp(shot(c, 'fs-440668', 0.52, 0.4, 'laser impact low thump, LP 600 Hz'), 600)
    y = mix(0.85, [(0, m, 0), (0, k, -4), (0.004, a, -7), (0.01, cr, -7), (0, l, -6), (0, thump(0.8, 80, 34, 0.18, 2.0), -4)])
    y = soft(nrm(y) * 1.4, 1.0)
    return fade(decay_after(y, 0.25, 0.22), 0.0015, 0.25), dict(synth=SYN_THUMP)

# ================================================================ Ronin Leadwall
L_F = ('declip; HP 45 Hz; onset trimmed; 12-gauge shot pitched down ~0.72x + second shotgun layer + frontloaded heavy blast '
       'body (LP 900 Hz) + metal strike at 0-10 ms + faint HV crack (HP 2.5 kHz) + saturated sub thump 110->38 Hz; '
       'body peak aligned within 4 ms; EQ -3 dB at 260 Hz, -3.5 dB at 500 Hz, +2 dB at 3.2 kHz; decay from 0.45 s; soft clipper')
def leadwall_fire(c, main, second, body, strike, crack):
    a = shot(c, *main, r=0.72)
    b = shot(c, *second, r=0.7)
    bd = frontload(lp(shot(c, *body, r=0.65, lo=45), 1200))
    k = hp(shot(c, *strike, r=0.6), 250)
    e = hp(shot(c, *crack), 2500)
    y = mix(0.78, [(0, a, 0), (0, b, -4), (0, decay_after(bd, 0.12, 0.15), -3), (0.003, decay_after(k, 0.03, 0.04), -10),
                   (0, fade(e, 0.001, 0.05), -15), (0, thump(0.6, 110, 48, 0.12, 1.8), -7)])
    y = peq(peq(peq(hp(y, 45), 500, -3.5, 1.0), 260, -3, 0.9), 3200, 2, 0.8)
    return fade(decay_after(y, 0.45, 0.2), 0.001, 0.14), dict(synth=SYN_THUMP)
@recipe('leadwall/fire-1.ogg', 'tf.leadwall.fire', processing=L_F, peak_db=-1.5, lufs_target=-12, max_gr=6, clip=True,
        variant='UTS-15 take 1 + SM57 shotgun + tank cannon body + sheet-metal strike + HV crack')
def _(c): return leadwall_fire(c, ('fs-233044', 0.025, 0.95, 'UTS-15 shot 1 (cut before the pump)'), ('fs-724945', 0.035, 0.9, 'shotgun with tail, SM57'),
                               ('fs-127845', 0.015, 0.9, 'tank cannon fire, pitched 0.65x, LP 900 Hz (body)'),
                               ('fs-492177', 4.14, 0.15, 'metal sheet hit, pitched 0.6x, HP 250 Hz (strike)'), ('fs-415962', 2.945, 0.08, 'HV discharge crack, HP 2.5 kHz'))
@recipe('leadwall/fire-2.ogg', 'tf.leadwall.fire', processing=L_F, peak_db=-1.5, lufs_target=-12, max_gr=6, clip=True,
        variant='UTS-15 take 2 + LilMati shotgun 01 + dynamite blast body + heavy metal strike + HV crack')
def _(c): return leadwall_fire(c, ('fs-233044', 2.075, 0.95, 'UTS-15 shot 2 (cut before the pump)'), ('fs-405504', 0.06, 0.8, 'shotgun shot 01'),
                               ('fs-475780', 0.155, 0.9, 'open-mine dynamite blast, pitched 0.65x, LP 900 Hz (body)'),
                               ('fs-614062', 0.0, 0.15, 'heavy metal impact, pitched 0.6x, HP 250 Hz (strike)'), ('fs-415962', 7.35, 0.08, 'HV discharge crack, HP 2.5 kHz'))
@recipe('leadwall/fire-3.ogg', 'tf.leadwall.fire', processing=L_F, peak_db=-1.5, lufs_target=-12, max_gr=6, clip=True,
        variant='Mossberg 500A + LilMati shotgun 03 + massive explosion body + sheet-metal bang + HV crack')
def _(c): return leadwall_fire(c, ('fs-159710', 0.075, 0.95, 'Mossberg 500A shot (cut before the pump)'), ('fs-473846', 0.015, 0.8, 'shotgun shot 03'),
                               ('fs-177556', 7.545, 0.9, 'massive explosion, pitched 0.65x, LP 900 Hz (body)'),
                               ('fs-547979', 1.785, 0.15, 'sheet metal bang, pitched 0.6x, HP 250 Hz (strike)'), ('fs-415962', 9.56, 0.08, 'HV discharge crack, HP 2.5 kHz'))

L_T = ('cut after the transient; pitched down 0.85x; HP 40 Hz, LP 7 kHz; + pitched-down thunder roll (LP 1.5 kHz) for weight; '
       'low shelf +4 dB at 150 Hz, bell -3 dB at 1.8 kHz; 30 ms fade-in, long cosine fade-out')
def lw_tail(c, a, th, dur):
    x = rate(tailcut(c, *a, 7000, 0.03, 0.6), 0.85)
    t = rate(tailcut(c, *th, 1500, 0.05, 0.6), 0.8)
    y = mix(dur, [(0, x, 0), (0, t, -6)])
    return fade(shelf(peq(y, 1800, -3, 1.2), 150, 4, 'low'), 0.03, 0.5)
@recipe('leadwall/tail-1.ogg', 'tf.leadwall.tail', processing=L_T, peak_db=-3.0, lufs_target=-22, variant='SM57 shotgun tail + thunder roll')
def _(c): return lw_tail(c, ('fs-724945', 0.16, 1.15, 'shotgun tail after the shot'), ('fs-840628', 1.6, 1.1, 'thunder roll, pitched 0.8x, LP 1.5 kHz'), 1.35)
@recipe('leadwall/tail-2.ogg', 'tf.leadwall.tail', processing=L_T, peak_db=-3.0, lufs_target=-22, variant='LilMati shotgun 02 tail + thunder rumble')
def _(c): return lw_tail(c, ('fs-408099', 0.22, 1.2, 'shotgun 02 tail after the shot'), ('fs-567945', 3.2, 1.1, 'thunder rumble, pitched 0.8x, LP 1.5 kHz'), 1.4)

def servo(c, t0, dur, r0, r1, note):
    """Motor whir under varispeed = servo/actuator whine (HP 300 Hz, LP 6 kHz, swell envelope)."""
    m = c.seg('fs-125401', t0, t0 + 2.0, note)
    v = lp(hp(varispeed(m, r0, r1, dur, 1.0), 300), 6000)
    return v * np.sin(np.linspace(0, np.pi, len(v))) ** 0.7
def clank(c, name, t, note, r=0.5, hi=1500, tau=0.06):
    """A metal hit pitched down (titan-size steel), band-limited to the low mids, fast decay."""
    return decay_after(lp(shot(c, name, t, 0.35, note, r=r), hi), 0.02, tau)
def titan_eq(y, lowmid=4.0, shelf_db=-5.0, shelf_f=5000):
    """Low-mid weight (+lowmid dB at 200 Hz) and a high shelf cut: steel instead of foley rattle."""
    return shelf(peq(y, 200, lowmid, 1.0), shelf_f, shelf_db, 'high')
L_P = ('pump-action rack pitched down ~0.65-0.7x + pitched-down metal clanks on the pull and lock strokes + servo whine '
       '(motor under varispeed) + sub thump on the lock; EQ +4 dB at 200 Hz, high shelf -5 dB at 5 kHz; '
       'pitch-preserving atempo compresses the cycle to ~0.5 s so it finishes before the next 0.65 s shot')
@recipe('leadwall/pump-1.ogg', 'tf.leadwall.pump', processing=L_P, peak_db=-3.0, lufs_target=-18, max_gr=4, clip=True,
        variant='Remington 870 rack + sheet-metal clanks + servo whine')
def _(c):
    a = hp(rate(ev(c, 'fs-755495', 0.10, 0.48, 'pump rack (pull at 0.02 s, lock at 0.225 s)'), 0.65), 60)
    k1 = clank(c, 'fs-492177', 4.14, 'metal sheet hit = pull clank, pitched 0.5x, LP 1.5 kHz')
    k2 = clank(c, 'fs-406197', 0.31, 'heavy metal door slam = lock clank, pitched 0.6x, LP 1.5 kHz', r=0.6, tau=0.08)
    sv = servo(c, 3.0, 0.3, 0.25, 0.45, 'electric motor whir = servo whine')
    y = mix(0.62, [(0, a, 0), (0.008, peq(k1, 400, 4, 0.9), -2), (0.30, peq(k2, 430, 3, 0.9), -3),
                   (0.04, sv, -12), (0.30, thump(0.25, 130, 55, 0.05, 1.4), -10)])
    return tempo(fade(titan_eq(y), 0.001, 0.1), 1.25), dict(synth=SYN_THUMP)
@recipe('leadwall/pump-2.ogg', 'tf.leadwall.pump', processing=L_P, peak_db=-3.0, lufs_target=-18, max_gr=4, clip=True,
        variant='pump action shotgun cycle + metal clanks + servo whine')
def _(c):
    a = hp(rate(ev(c, 'fs-370344', 1.51, 0.46, 'pump cycle (back at 0.015/0.12 s, forward at 0.335/0.44 s)'), 0.7), 60)
    k1 = clank(c, 'fs-547979', 1.785, 'sheet metal bang = pull clank, pitched 0.5x, LP 1.5 kHz')
    k2 = clank(c, 'fs-614062', 0.0, 'heavy metal impact = lock clank, pitched 0.55x, LP 1.5 kHz', r=0.55, tau=0.08)
    sv = servo(c, 9.0, 0.3, 0.45, 0.25, 'electric motor whir = servo whine')
    y = mix(0.7, [(0, a, 0), (0.02, k1, -7), (0.475, k2, -5), (0.2, sv, -18), (0.48, thump(0.22, 105, 40, 0.07, 1.6), -8)])
    return tempo(fade(titan_eq(y), 0.002, 0.1), 1.4), dict(synth=SYN_THUMP)

L_R = ('clean CC0 ricochet variation pitched down 0.55-0.62x; HP 100 Hz; heavy armour clank at 0 ms '
       '(pitched 0.55x, LP 2 kHz) followed by the deflection whizz at 5 ms; bell -3 dB at 950 Hz; cosine fade-out')
def rico(c, name, t, dur, note, hit, r=0.7, total=0.5):
    x = hp(shot(c, name, t, dur, note, r=r, hi=12000), 80)
    k = frontload(clank(c, *hit, r=0.55, hi=2000, tau=0.055))
    y = mix(total, [(0.005, x, 0), (0, peq(k, 380, 3, 0.9), -2)])
    return fade(peq(y, 950, -3, 2.5), 0.001, 0.15)
@recipe('leadwall/ricochet-1.ogg', 'tf.leadwall.ricochet', processing=L_R, peak_db=-3.0, lufs_target=-19, max_gr=6, clip=True,
        variant='clean ricochet variation 1 + armour clank')
def _(c): return rico(c, 'fs-30932', 0.02, 0.26, 'ricochet variation 1', ('fs-492177', 4.335, 'armour deflection clank'), r=0.58, total=0.48)
@recipe('leadwall/ricochet-2.ogg', 'tf.leadwall.ricochet', processing=L_R, peak_db=-3.0, lufs_target=-19, max_gr=6, clip=True,
        variant='clean ricochet variation 2 + armour clank')
def _(c): return rico(c, 'fs-30932', 0.545, 0.29, 'ricochet variation 2', ('fs-386798', 0.515, 'armour deflection clank'), r=0.6, total=0.55)
@recipe('leadwall/ricochet-3.ogg', 'tf.leadwall.ricochet', processing=L_R, peak_db=-3.0, lufs_target=-19, max_gr=6, clip=True,
        variant='bullet ricochet variation 4 + metal clank')
def _(c): return rico(c, 'fs-30932', 1.625, 0.33, 'ricochet variation 4', ('fs-614062', 0.0, 'heavy metal impact = deflection clank'), r=0.62, total=0.55)
@recipe('leadwall/ricochet-4.ogg', 'tf.leadwall.ricochet', processing=L_R, peak_db=-3.0, lufs_target=-19, max_gr=6, clip=True,
        variant='clean ricochet variation 3 + armour clank')
def _(c): return rico(c, 'fs-30932', 0.99, 0.35, 'ricochet variation 3', ('fs-547979', 3.77, 'armour deflection clank'), r=0.55, total=0.65)

L_I = ('bullet transient pitched 0.6x + frontloaded metal thud pitched 0.55x (LP 1.2 kHz) + short 340->170 Hz body pulse; '
       'notch -6 dB at 5.6 kHz, high shelf -5 dB at 7.5 kHz; exponential decay from 35 ms; 0.22 s')
def pellet(c, hit, thud):
    h = hp(shot(c, *hit, r=0.6), 180)
    t = frontload(lp(shot(c, *thud, r=0.55), 1200), 0.12)
    y = mix(0.22, [(0, h, -3), (0, decay_after(t, 0.02, 0.04), 0), (0, thump(0.2, 340, 170, 0.04, 1.4), -6)])
    y = shelf(peq(y, 5600, -6, 2.5), 7500, -5, 'high')
    return fade(decay_after(y, 0.035, 0.055), 0.001, 0.045), dict(synth=SYN_THUMP)
@recipe('leadwall/impact-1.ogg', 'tf.leadwall.impact', processing=L_I, peak_db=-3.0, lufs_target=-17, max_gr=6, clip=True, variant='bullet impact 1 + metal thud')
def _(c): return pellet(c, ('fs-144444', 0.025, 0.055, 'bullet impact at 0.025 s (cut before its bounce)'), ('fs-492177', 5.40, 0.1, 'metal sheet thud'))
@recipe('leadwall/impact-2.ogg', 'tf.leadwall.impact', processing=L_I, peak_db=-3.0, lufs_target=-17, max_gr=6, clip=True, variant='bullet impact 7 + metal thud')
def _(c): return pellet(c, ('fs-144444', 1.185, 0.1, 'bullet impact at 1.185 s'), ('fs-492177', 4.335, 0.1, 'metal sheet thud'))
@recipe('leadwall/impact-3.ogg', 'tf.leadwall.impact', processing=L_I, peak_db=-3.0, lufs_target=-17, max_gr=6, clip=True, variant='metal against rock + metal thud')
def _(c): return pellet(c, ('fs-489924', 0.46, 0.1, 'metal impact against rock'), ('fs-386798', 0.515, 0.1, 'metal collision thud'))

@recipe('leadwall/reload-1.ogg', 'tf.leadwall.reload', peak_db=-3.0, lufs_target=-20, max_gr=4, clip=True,
        processing=('shell load and slow chambering pitched down 0.7-0.75x + servo whine under the chambering + pitched-down heavy '
                    'metal clang and sub thump on the final lock; EQ +4 dB at 200 Hz, high shelf -6 dB at 6.5 kHz; cosine fades'),
        variant='shell load + 12-gauge chamber round slowly + servo whine + heavy lock clang')
def _(c):
    s_ = rate(ev(c, 'fs-108793', 0.05, 0.35, 'shell load'), 0.7)
    a = rate(ev(c, 'fs-513351', 6.85, 1.3, 'chambering a round slowly (last lock at 8.0 s)'), 0.75)
    sv = servo(c, 12.0, 0.55, 0.3, 0.5, 'electric motor whir = servo whine')
    k = clank(c, 'fs-614062', 0.0, 'heavy metal impact = lock clang, pitched 0.55x', r=0.55, hi=2500, tau=0.12)
    release = clank(c, 'fs-386798', 0.515, 'heavy shell carrier release', r=0.65, hi=4000, tau=0.07)
    y = mix(2.15, [(0, s_, 0), (0, release, -4), (0.35, a, 0), (0.8, sv, -9), (1.88, k, -4), (1.88, thump(0.3, 130, 60, 0.06, 1.4), -10)])
    return fade(titan_eq(y, 4.0, -6.0, 6500), 0.002, 0.15), dict(synth=SYN_THUMP)

# ================================================================ Legion Predator Cannon
P_F = ('declip; early 2 ms peak aligned at 4 ms; one autocannon round pitched down, HP 65 Hz; '
       'dense 180-600 Hz body copy, 25 ms body pulse and steel feeder tick at 4 ms; +4 dB at 260 Hz; '
       '30 ms attack-body window then 22 ms decay, 0.16 s total; soft clipper')
def pred(c, a, b=None, r=0.85, dur=0.2, bolt=('fs-812592', 0.0, 'clang = bolt/breech tick')):
    x = frontload(hp(shot(c, *a, r=r), 65), 0.08)
    body = bp(rate(x, 0.75), 180, 600)
    k = hp(decay_after(shot(c, bolt[0], bolt[1], 0.08, bolt[2], r=0.8), 0.01, 0.015), 1000)
    items = [(0, x, 0), (0, decay_after(body, 0.012, 0.025), -1), (0, thump(0.13, 190, 85, 0.025, 1.5), -8), (0.004, k, -12)]
    if b: items.append((0.002, decay_after(shot(c, *b, r=0.8), 0.04, 0.03), -5))
    y = hp(peq(mix(0.16, items), 260, 4, 0.9), 65)
    return fade(decay_after(y, 0.03, 0.022), 0.0007, 0.035), dict(synth=SYN_THUMP)
@recipe('predator/fire-1.ogg', 'tf.predator.fire', processing=P_F, peak_db=-2.0, lufs_target=-13, max_gr=3, clip=True, variant='M242 autocannon round 1 (DVIDS)')
def _(c): return pred(c, ('fs-854186', 0.28, 0.26, 'autocannon round 1 (cut before round 2)'))
@recipe('predator/fire-2.ogg', 'tf.predator.fire', processing=P_F, peak_db=-2.0, lufs_target=-13, max_gr=3, clip=True, variant='M242 autocannon round 2 (DVIDS)')
def _(c): return pred(c, ('fs-854186', 0.555, 0.3, 'autocannon round 2'), r=0.82)
@recipe('predator/fire-3.ogg', 'tf.predator.fire', processing=P_F, peak_db=-2.0, lufs_target=-13, max_gr=3, clip=True, variant='M242 autocannon round 3 (CC0 DVIDS extract)')
def _(c): return pred(c, ('fs-854186', 0.84, 0.23, 'autocannon round 3 (cut before next round)'), r=0.88)
@recipe('predator/fire-4.ogg', 'tf.predator.fire', processing=P_F, peak_db=-2.0, lufs_target=-13, max_gr=3, clip=True, variant='M240 single shot (DVIDS) + DShK single')
def _(c): return pred(c, ('fs-854641', 0.075, 0.3, 'M240 single shot'), ('fs-122103', 0.03, 0.25, 'DShK single shot layer'), r=0.75)

SPIN_R = 0.3  # playback rate of the motor at full spin (spin-up ends here, spin-down starts here)
def spin_eq(x):
    """Keep motor torque in the low mids, with no drill-like high whine."""
    return lp(peq(hp(x, 100), 350, 3, 0.8), 950)
def barrel_ticks(c, n, start_hz, end_hz=None, loop=False):
    """Recorded steel tooth clicks at the barrel rotation rate, never gunfire."""
    tick = fade(bp(shot(c, 'fs-386798', 0.515, 0.06, 'steel tooth click = barrel bearing', r=0.7), 700, 3200), 0.0005, 0.008)[:int(0.025*SR)]
    hz = np.linspace(start_hz, end_hz if end_hz is not None else start_hz, n)
    if loop: hz[:] = round(start_hz*n/SR) / (n/SR)
    phase = np.cumsum(hz)/SR
    onsets = np.flatnonzero(np.diff(np.floor(phase), prepend=-1))
    y = place(n, [(i/SR, nrm(tick), 1) for i in onsets])
    if loop:
        # Wrap the final tooth decay into the beginning of the loop.
        for i in onsets:
            spill = len(tick) - (n-i)
            if spill > 0: y[:spill] += nrm(tick)[-spill:]
    return y
def spin_hum(n, f0=55.0, am=12.0, depth=0.3, loop=True):
    """Original synthesized turbine hum (f0 + saturated harmonics) with a rotation pulse at `am` Hz. For a loop the
    frequencies are rounded to whole cycles over n samples, so the hum and pulse wrap seamlessly."""
    L = n / SR
    if loop: f0, am = round(f0 * L) / L, round(am * L) / L
    t = np.arange(n) / SR
    h = soft(np.sin(2*np.pi*f0*t) + 0.4*np.sin(2*np.pi*2*f0*t), 2.0)
    return h, 1 - depth * (0.5 + 0.5*np.cos(2*np.pi*am*t)), (f0, am)
SYN_HUM = 'synthesized turbine hum (55 Hz + 110 Hz sines, soft-saturated) with a 12 Hz rotation pulse'
@recipe('predator/spin-up-1.ogg', 'tf.predator.spinUp', peak_db=-3.0, lufs_target=-18,
        processing=('motor varispeed 0.08x->0.3x, band 100-950 Hz; steel bearing ticks accelerating 4->18 Hz + torque hum '
                    '35->65 Hz; rising envelope, 10 ms end fade; no fan or drill layer'),
        variant='low motor torque + accelerating steel bearing ticks + rising hum')
def _(c):
    m = c.seg('fs-125401', 2.0, 4.0, 'electric motor whir (varispeed rising)')
    v = spin_eq(varispeed(m, 0.08, SPIN_R, 0.6, 0.8))
    n = len(v); k = np.linspace(0, 1, n); t = np.arange(n) / SR
    fr = 35 + 30 * k ** 0.8; ph = 2*np.pi*np.cumsum(fr)/SR
    hum = soft(np.sin(ph) + 0.4*np.sin(2*ph), 2.0) * (1 - 0.3*(0.5 + 0.5*np.cos(2*np.pi*np.cumsum(4 + 8*k)/SR)))
    y = mix(0.6, [(0, v * (0.1 + 0.9 * k ** 0.8), 0), (0, barrel_ticks(c, n, 4, 18) * (0.3+0.7*k), -9), (0, hum * k ** 0.6, -9)])
    return fade(hp(y, 45), 0.004, 0.01), dict(synth=SYN_HUM + ' (rising 35->65 Hz, pulse 4->12 Hz)')
@recipe('predator/spin-1.ogg', 'tf.predator.spin', loop=True, peak_db=-4.0, lufs_target=-18,
        processing=('motor whir at 0.3x, band 100-950 Hz; equal-power loop overlap; 65 Hz torque hum, '
                    '12 Hz pulse and 18 Hz recorded steel bearing ticks (whole cycles, decay wrapped into loop start)'),
        variant='low motor torque + steel bearing ticks + turbine hum with rotation pulse')
def _(c):
    m = rate(c.seg('fs-125401', 5.0, 5.75, 'electric motor whir at 0.3x'), SPIN_R)
    y = spin_eq(nrm(m))
    loop, info = make_loop(y, 1.2, X=0.2, search=0.06)
    hum, pulse, (f0, am) = spin_hum(len(loop), f0=65)
    loop = nrm(loop) * pulse + 0.35 * hum + 0.3 * barrel_ticks(c, len(loop), 18, loop=True)
    info.update(synth=SYN_HUM + f' (hum {f0:.2f} Hz, pulse {am:.2f} Hz: whole cycles over the loop)')
    return loop, info
@recipe('predator/spin-down-1.ogg', 'tf.predator.spinDown', peak_db=-3.0, lufs_target=-19,
        processing=('motor whir under varispeed 0.3x->0.08x, band 100-950 Hz; falling 65->20 Hz torque hum; '
                    'steel bearing ticks slowing 18->3 Hz + chain-gun brake rattle pitched 0.7x; falling envelope'),
        variant='motor varispeed falling + falling hum + chain gun wind down')
def _(c):
    m = c.seg('fs-125401', 7.0, 8.5, 'electric motor whir (varispeed falling)')
    v = spin_eq(varispeed(m, SPIN_R, 0.08, 1.2, 0.7))
    w = rate(c.seg('fs-94101', 1.0, 1.9, 'chain gun wind down'), 0.7)
    n = len(v); k = np.linspace(0, 1, n)
    fr = 65 - 45 * k ** 0.7; ph = 2*np.pi*np.cumsum(fr)/SR
    hum = soft(np.sin(ph) + 0.4*np.sin(2*ph), 2.0) * (1 - 0.3*(0.5 + 0.5*np.cos(2*np.pi*np.cumsum(12 - 10*k)/SR)))
    y = mix(1.2, [(0, v * (1 - k) ** 1.5, 0), (0, hum * (1 - k) ** 1.2, -9), (0, fade(bp(w, 250, 3500), 0.005, 0.5), -10),
                   (0, barrel_ticks(c, n, 18, 3) * (1-k), -9)])
    return fade(hp(y, 45), 0.004, 0.3), dict(synth=SYN_HUM + ' (falling 65->20 Hz, pulse 12->2 Hz)')

P_C = ('real brass bounce pitched 0.75x with quieter copies at 125/225/330 ms; HP 240 Hz; '
       'light metal body on first strike and +3 dB at 4.8 kHz; natural bright scatter over 0.65 s')
def casing(c, a, k, r=0.5):
    x = hp(rate(ev(c, *a), 0.75), 240)
    kk = clank(c, *k, r=0.7, hi=3000, tau=0.03)
    y = mix(0.65, [(0, x, 0), (0, kk, -16), (0.125, rate(x, 1.06), -6),
                   (0.225, rate(x, 0.94), -10), (0.33, rate(x, 1.12), -15)])
    return fade(hp(peq(y, 4800, 3, 0.9), 240), 0.001, 0.1)
@recipe('predator/casings-1.ogg', 'tf.predator.casings', processing=P_C, peak_db=-4.0, lufs_target=-23, max_gr=6, clip=True, variant='bouncing shell casings A + pipe clank')
def _(c): return casing(c, ('fs-318964', 2.49, 0.2, 'casing bounce (first two hits)'), ('fs-386798', 0.515, 'metal collision = casing body'))
@recipe('predator/casings-2.ogg', 'tf.predator.casings', processing=P_C, peak_db=-4.0, lufs_target=-23, max_gr=6, clip=True, variant='brass casing on concrete + sheet clank')
def _(c): return casing(c, ('fs-210102', 1.84, 0.2, 'brass casing drop on concrete'), ('fs-492177', 4.54, 'metal sheet hit = casing body'))
@recipe('predator/casings-3.ogg', 'tf.predator.casings', processing=P_C, peak_db=-4.0, lufs_target=-23, max_gr=6, clip=True, variant='.30 shell bouncing + metal clank')
def _(c): return casing(c, ('fs-205126', 0.465, 0.2, '.30 shell bouncing (first hits)'), ('fs-547979', 5.59, 'sheet metal bang = casing body'))

P_T = ('cut after the last round of a burst (no shots inside); pitched 0.9x; HP 60 Hz, LP 8 kHz, high shelf -4 dB at 4 kHz, '
       'bell -3.5 dB at 200 Hz; 20 ms fade-in, long cosine fade-out')
def pred_tail(c, name, t, dur, note):
    x = rate(fade(hp(lp(c.seg(name, t, t + dur, note), 8000), 60), 0.02, 0.5), 0.9)
    return fade(peq(shelf(x, 4000, -4, 'high'), 200, -3.5, 1.5), 0.02, 0.5)
@recipe('predator/tail-1.ogg', 'tf.predator.tail', processing=P_T, peak_db=-3.0, lufs_target=-21, variant='.50 cal MG tail after burst 2')
def _(c): return pred_tail(c, 'fs-183656', 3.0, 1.32, '.50 cal tail after the second burst')
@recipe('predator/tail-2.ogg', 'tf.predator.tail', processing=P_T, peak_db=-3.0, lufs_target=-21, variant='heavy machine gun burst tail')
def _(c): return pred_tail(c, 'fs-165394', 1.70, 1.25, 'heavy MG tail after the burst')

@recipe('predator/reload-1.ogg', 'tf.predator.reload', peak_db=-3.0, lufs_target=-20, max_gr=4, clip=True,
        processing=('frontloaded launcher latches pitched 0.65x at 0/0.5/1.65 s, dense metal release clank; servo whine at 0.35 s; '
                    'drum lock door slam LP 6 kHz + tight 130->60 Hz body; EQ +3 dB at 300 Hz, high shelf -2 dB at 7 kHz; 2.2 s'),
        variant='three drum latches + powered feed motor + heavy metal drum lock')
def _(c):
    latches = [frontload(rate(ev(c, 'fs-725401', t, 0.28, 'individual drum latch'), 0.65)) for t in (1.825, 2.30, 3.0)]
    release = clank(c, 'fs-386798', 0.515, 'drum release clank', r=0.6, hi=4000, tau=0.08)
    d = frontload(lp(ev(c, 'fs-406197', 0.3, 0.5, 'heavy door slam = drum lock, LP 6 kHz'), 6000))
    sv = servo(c, 15.0, 0.85, 0.25, 0.5, 'electric motor whir = powered drum feed')
    y = mix(2.2, [(0, latches[0], 0), (0, release, -5), (0.5, latches[1], 0), (0.35, sv, -9),
                  (1.65, latches[2], -3), (1.65, d, -3), (1.65, thump(0.3, 130, 60, 0.06, 1.4), -10)])
    return fade(titan_eq(y, 3.0, -2.0, 7000), 0.001, 0.18), dict(synth=SYN_THUMP)

# ================================================================ common
H_P = ('dry metal transient (HP 900 Hz) + short 1.68/2.52 kHz confirmation partials, 18 ms decay; '
       'high shelf -4 dB at 7 kHz; 0.12 s total, no bass; smooth 0.8 ms attack')
def tick(c, name, t, note, hpf=900):
    x = hp(shot(c, name, t, 0.09, note), hpf)
    x = decay_after(shelf(x, 7000, -4, 'high'), 0.01, 0.02)
    t_ = np.arange(int(0.12*SR)) / SR
    ping = (np.sin(2*np.pi*1680*t_) + 0.2*np.sin(2*np.pi*2520*t_)) * np.exp(-t_/0.018) * (1-np.exp(-t_/0.0008))
    return fade(mix(0.12, [(0, x, -3), (0, ping, -5)]), 0.0008, 0.03), dict(synth='synthesized armour-confirm partials (1.68/2.52 kHz sines, 18 ms decay)')
@recipe('common/hit-confirm-1.ogg', 'tf.hit.confirm', processing=H_P, peak_db=-3.0, lufs_target=-18, max_gr=6, clip=True, variant='metal collision tick')
def _(c): return tick(c, 'fs-386798', 0.625, 'metal collision transient')
@recipe('common/hit-confirm-2.ogg', 'tf.hit.confirm', processing=H_P, peak_db=-3.0, lufs_target=-18, max_gr=6, clip=True, variant='metal against rock tick')
def _(c): return tick(c, 'fs-489924', 0.46, 'metal tick', 1200)
@recipe('common/hit-confirm-3.ogg', 'tf.hit.confirm', processing=H_P, peak_db=-3.0, lufs_target=-18, max_gr=6, clip=True, variant='bullet-on-metal tick')
def _(c): return tick(c, 'fs-182263', 0.4, 'bullet hit metal tick', 1500)

P_I = ('onset-trimmed ballistic crack + armour clank pitched 0.6x, HP 110 Hz; short body pulse at 170->75 Hz; '
       'bell -5 dB at 1.1 kHz, high shelf -4 dB at 6 kHz; 45 ms exponential decay, 0.23 s total')
def predator_impact(c, hit, metal):
    h = hp(shot(c, *hit, r=0.85), 900)
    m = peq(lp(shot(c, *metal, r=0.6), 2400), 1100, -5, 3)
    y = mix(0.23, [(0, decay_after(h, 0.008, 0.028), 0), (0, decay_after(m, 0.018, 0.045), -2),
                   (0, thump(0.18, 170, 75, 0.035, 1.4), -9)])
    return fade(hp(shelf(y, 6000, -4, 'high'), 110), 0.001, 0.045), dict(synth=SYN_THUMP)
@recipe('predator/impact-1.ogg', 'tf.predator.impact', processing=P_I, peak_db=-3, lufs_target=-17, max_gr=2, clip=True, variant='bullet on metal + armour sheet')
def _(c): return predator_impact(c, ('fs-182263', 0.105, 0.12, 'ballistic metal hit'), ('fs-492177', 4.335, 0.18, 'armour sheet body'))
@recipe('predator/impact-2.ogg', 'tf.predator.impact', processing=P_I, peak_db=-3, lufs_target=-17, max_gr=2, clip=True, variant='bullet hit + dense metal collision')
def _(c): return predator_impact(c, ('fs-144444', 1.185, 0.1, 'ballistic hit'), ('fs-386798', 0.515, 0.18, 'dense metal collision body'))
@recipe('predator/impact-3.ogg', 'tf.predator.impact', processing=P_I, peak_db=-3, lufs_target=-17, max_gr=2, clip=True, variant='bullet on metal + heavy armour knock')
def _(c): return predator_impact(c, ('fs-182263', 0.105, 0.12, 'ballistic metal hit'), ('fs-614062', 0.0, 0.18, 'heavy armour knock'))

@recipe('common/kill-confirm-1.ogg', 'tf.hit.kill', peak_db=-3, lufs_target=-18, max_gr=2,
        processing='two dry metal strikes 90 ms apart + falling 1100/825 Hz chime, HP 100 Hz; smooth 2 ms attacks and 130 ms decay; 0.65 s',
        variant='double armour strike and falling confirmation chime')
def _(c):
    m = clank(c, 'fs-386798', 0.515, 'first destruction strike', r=0.65, hi=4000, tau=0.08)
    k = clank(c, 'fs-614062', 0.0, 'second destruction strike', r=0.75, hi=3500, tau=0.08)
    t = np.arange(int(0.4*SR)) / SR
    chime = (np.sin(2*np.pi*1100*t) + 0.45*np.sin(2*np.pi*825*t)) * (1-np.exp(-t/0.002)) * np.exp(-t/0.13)
    y = mix(0.65, [(0, m, -3), (0.09, k, 0), (0.09, chime, -7), (0.09, thump(0.3, 100, 45, 0.07), -10)])
    return fade(hp(y, 100), 0.001, 0.14), dict(synth=SYN_THUMP + '; synthesized falling confirmation chime (1100/825 Hz sines)')

@recipe('common/doom-confirm-1.ogg', 'tf.hit.doom', peak_db=-2.0, lufs_target=-15, max_gr=4,
        processing='heavy metal impact pitched down 0.7x + big robot footstep crunch + metal smash + gong crash pitched down 0.6x + sub thump; cosine fade-out',
        variant='deep clang + crunch')
def _(c):
    m = shot(c, 'fs-614062', 0.0, 0.7, 'heavy metal impact pitched down 0.7x', r=0.7)
    f = shot(c, 'fs-813054', 0.0, 0.6, 'big robot footstep (crunch)')
    s = hp(shot(c, 'fs-562198', 0.075, 0.5, 'metal smash, HP 800 Hz'), 800)
    g = lp(shot(c, 'fs-799184', 0.015, 0.8, 'gong crash pitched down 0.6x, LP 3 kHz', r=0.6), 3000)
    y = mix(0.72, [(0, m, 0), (0.004, f, -3), (0.008, s, -8), (0, g, -7), (0, thump(0.5, 70, 35, 0.12, 1.8), -6)])
    return fade(y, 0.0015, 0.28), dict(synth=SYN_THUMP)
