"""Recipes: battle bed, artillery, wind, river, birds, bell, industrial, fire."""
import numpy as np
from dsp2 import *

RNG = lambda seed: np.random.default_rng(seed)

# ---------------------------------------------------------------- distant battle bed
CANNON_95129 = [7.268, 13.048, 17.931, 22.909, 27.979, 33.017, 38.258, 43.820, 48.856]
BOOM_320788 = [15.034, 21.634, 26.213, 30.095, 34.732, 42.105, 57.149]
HOW_486030 = [8.345, 13.618, 17.266, 38.041]


def _gunfire_stream(ctx, order, seglen=None):
    """Distant WW2 re-enactment gunfire (mono) re-sequenced into a long stream."""
    parts = [ctx.seg('fs-170478', a, b, note='distant gunfire stream') for a, b in order]
    return concat_xf(parts, 0.6)


def _booms(ctx, rng, n, N, lo_gain, hi_gain, lp_hz):
    pool = [('fs-320788', t, 3.6) for t in BOOM_320788] + [('fs-95129', t, 4.6) for t in CANNON_95129]
    items = []
    seen = {}
    picks = rng.choice(len(pool), n, replace=n > len(pool))
    times = np.sort(rng.uniform(0, N / SR, n))
    for t, k in zip(times, picks):
        name, s, d = pool[k]
        key = (name, s)
        if key not in seen:
            seen[key] = ctx.seg(name, s - 0.02, s + d, note='distant boom')
        b = hp(seen[key], 30, 2)
        b = lp(b, lp_hz * rng.uniform(0.7, 1.2), 2)
        b = b / (np.abs(b).max() + 1e-9)
        b = fade(b, 0.004, 0.8)
        items.append((t, pan(b, rng.uniform(-0.85, 0.85)), 10 ** (rng.uniform(lo_gain, hi_gain) / 20)))
    return items


def _mg(ctx, rng, n, N, gain):
    # License fix 2026-10-08: fs-855244 (qubodup) dropped; it is an excerpt of NATO b-roll, not CC0-able.
    pool = [('fs-158979', 0.17, 1.6), ('fs-337242', 0.0, 1.4)]
    cache = {}; items = []
    for t in np.sort(rng.uniform(0, N / SR, n)):
        name, a, b = pool[rng.integers(len(pool))]
        if name not in cache: cache[name] = mono(ctx.seg(name, a, b, ch=2, note='distant MG burst'))
        s = lp(hp(cache[name], 180, 2), rng.uniform(1600, 2600), 2)
        s = fade(s / (np.abs(s).max() + 1e-9), 0.003, 0.25)
        items.append((t, pan(s, rng.uniform(-0.9, 0.9)), 10 ** (rng.uniform(gain - 5, gain) / 20)))
    return items


def _rumble(ctx, a, b):
    r = ctx.seg('fs-823852', a, b, ch=2, note='synthetic low battle rumble (CC0)')
    return lp(hp(r, 28, 2), 220, 4)


PROC_BED = ('stereo bed; distant re-enactment gunfire stream resequenced with 0.6 s equal-power crossfades, decorrelated L/R from '
            'different passages, HP 90 Hz (removes recording wind rumble) / LP 3.2 kHz (distance); synthetic rumble layer LP 220 Hz; sparse distant booms '
            '(LP 0.9-1.6 kHz, constant-power random pan) and MG bursts (LP 1.6-2.6 kHz) placed circularly so tails wrap; '
            'seamless fixed-length loop (1.5 s equal-power continuation overlap); linear gain only after looping')


def _bed(ctx, seed, L, gun_db, rumble_db, n_boom, boom_db, n_mg, mg_db):
    rng = RNG(seed); N = int(L * SR); X = int(1.5 * SR)
    # L/R gunfire streams from different passages of the 68.8 s recording (mono source -> decorrelated stereo)
    o1 = [(14.0, 44.0), (2.0, 30.0), (40.0, 68.5)]
    o2 = [(44.0, 68.5), (16.0, 42.0), (4.0, 36.0)]
    gl = _gunfire_stream(ctx, o1 if seed % 2 else o2); gr = _gunfire_stream(ctx, o2 if seed % 2 else o1)
    n = min(len(gl), len(gr), N + X); g = np.stack([gl[:n], gr[:n]], axis=1)
    g = lp(hp(g, 90, 4), 3200, 2)
    g = width(g, 0.85) / (np.sqrt(np.mean(g ** 2)) + 1e-9) * 0.05
    reps = int(np.ceil((N + X) / len(g)))
    if reps > 1: g = concat_xf([g] * (reps + 1), 0.6)
    g = g[:N + X]
    r = _rumble(ctx, 4.0, 4.0 + (N + X) / SR + 0.1)[:N + X]
    r = r / (np.sqrt(np.mean(r ** 2)) + 1e-9) * 0.05
    bed = fixed_loop(g * 10 ** (gun_db / 20) + r * 10 ** (rumble_db / 20), N, X)
    items = _booms(ctx, rng, n_boom, N, boom_db - 6, boom_db, 1300) + _mg(ctx, rng, n_mg, N, mg_db)
    y = bed + place(N, items, circular=True)
    return y, dict(seam=seam_report(y), booms=n_boom, mg_bursts=n_mg, loop_len_s=L, overlap_s=1.5)


@recipe('battle-bed-low.ogg', 'distant_battle_bed', loop=True, stereo=True, lufs_target=-24, max_gr=6, variant='low intensity (quiet sectors)',
        processing=PROC_BED)
def battle_low(ctx): return _bed(ctx, 11, 96.0, 0, -12, 9, -13, 5, -24)


@recipe('battle-bed-high.ogg', 'distant_battle_bed', loop=True, stereo=True, lufs_target=-22, max_gr=6, variant='high intensity (contested flags, many kills)',
        processing=PROC_BED)
def battle_high(ctx): return _bed(ctx, 22, 84.0, 3, -8, 26, -8, 18, -16)


# ---------------------------------------------------------------- off-map artillery
PROC_ART = ('mono; onset-aligned (4 ms pre-roll; the game adds the distance/343 m/s delay); HP 28 Hz; LP shaping for range; '
            'leading crack limited by 5 dB (1 ms look-ahead, 60 ms release); '
            'valley echo = 2-3 discrete low-passed reflections (0.4-1.6 s, -9 to -18 dB, original code); expander on the '
            'recording ambience after the tail; cosine fade-out')


def _art(ctx, name, t, dur, lp_hz, taps, ch=2):
    x = mono(ctx.seg(name, t - 0.03, t + dur, ch=ch, note='distant gun report with natural valley tail'))
    x = x[onset(x, 0.15):]
    x = lp(hp(x, 28, 2), lp_hz, 2)
    x = limiter(x, np.abs(x).max() * 10 ** (-5 / 20), 1.0, 60.0)  # tame the leading crack (-5 dB) so variants match in loudness
    x = fade(x, 0.0, 0.9)  # let the dry recording decay before the synthetic reflections take over
    x = mono(echo_tail(x, taps, lp_hz=min(lp_hz, 700)))
    # expander: pull the recording's wind/ambience floor down once the tail has decayed
    e = env(x, 30); fl = np.percentile(e[int(len(e) * 0.85):], 50)
    g = np.clip((e / (fl * 2.0 + 1e-9) - 0.3), 0.0, 1.0) ** 0.8
    g = signal.filtfilt(*signal.butter(1, 4, fs=SR), g); g[:int(0.6 * SR)] = 1
    x = x * np.clip(g, 0, 1)
    return fade(trim_tail(x, -58, 0.1), 0.002, 0.6)


for i, (name, t, lpf, taps) in enumerate([
        ('fs-95129', 22.909, 2400, [(0.46, -10, 0), (1.18, -15, 0)]),
        ('fs-95129', 33.017, 1900, [(0.62, -11, 0), (1.45, -16, 0)]),
        ('fs-95129', 48.856, 2800, [(0.38, -9, 0), (0.95, -14, 0), (1.62, -19, 0)]),
        ('fs-95129', 7.268, 1700, [(0.52, -11, 0), (1.30, -17, 0)]),
        ('fs-95129', 38.258, 1500, [(0.70, -12, 0), (1.55, -18, 0)])], 1):
    def _f(ctx, name=name, t=t, lpf=lpf, taps=taps):
        return _art(ctx, name, t, 4.7 if name == 'fs-95129' else 3.6, lpf, taps, ch=2 if name == 'fs-95129' else 1)
    recipe(f'artillery-distant-{i}.ogg', 'offmap_artillery_salvo', lufs_target=-24, peak_db=-3.0, max_gr=6.0,
           variant=f'shot {i}', processing=PROC_ART)(_f)


# ---------------------------------------------------------------- wind
PROC_WIND = 'stereo; HP {hp} Hz (removes mic wind buffeting / rumble){extra}; seamless fixed-length loop ({x} s equal-power continuation overlap); linear gain only after looping'


def _wind_loop(ctx, name, a, L, hp_hz, X=2.0, lp_hz=None, extra=None):
    x = ctx.seg(name, a, a + L + X + 0.1, ch=2, note='wind field recording')
    x = hp(x, hp_hz, 4)
    if lp_hz: x = lp(x, lp_hz, 2)
    if extra: x = extra(x)
    y = fixed_loop(x, int(L * SR), int(X * SR))
    return y, dict(seam=seam_report(y))


@recipe('wind-valley-bed.ogg', 'wind_valley', loop=True, stereo=True, lufs_target=-26, max_gr=0, variant='soft open-valley bed',
        processing=PROC_WIND.format(hp=70, extra='; LP 9 kHz', x=2.0))
def wind_bed(ctx): return _wind_loop(ctx, 'fs-454092', 78.0, 56.0, 70, lp_hz=9000)


@recipe('wind-valley-gusty.ogg', 'wind_valley', loop=True, stereo=True, lufs_target=-24, max_gr=3, variant='gusty layer (scaled by weather wind 0.8/1.6/2.2)',
        processing=PROC_WIND.format(hp=170, extra='; low shelf +3 dB @ 300 Hz', x=2.5))
def wind_gusty(ctx): return _wind_loop(ctx, 'fs-109485', 78.0, 64.0, 170, X=2.5, extra=lambda x: shelf(x, 300, 3, 'low'))


@recipe('wind-ridge-whistle.ogg', 'wind_valley', loop=True, stereo=True, lufs_target=-25, max_gr=0, variant='ridge / bunker exposure layer: moaning, whistling',
        processing=PROC_WIND.format(hp=140, extra='; presence peak +3 dB @ 750 Hz', x=2.0))
def wind_ridge(ctx): return _wind_loop(ctx, 'fs-160469', 30.0, 58.0, 140, extra=lambda x: peq(x, 750, 3, 1.2))


@recipe('wind-gust-swell.ogg', 'wind_valley', stereo=True, lufs_target=-24, max_gr=2.0, variant='one-shot gust swell',
        processing='stereo; HP 170 Hz; 1.2 s sine fade-in, 2.0 s cosine fade-out shaping a single gust')
def wind_swell(ctx):
    x = ctx.seg('fs-109485', 3.0, 13.0, ch=2, note='single wind gust through pines')
    x = shelf(hp(x, 170, 4), 300, 2, 'low')
    return fade(x, 1.2, 2.0)


# ---------------------------------------------------------------- river
@recipe('river-flow.ogg', 'river_flow', loop=True, lufs_target=-24, max_gr=0, variant='gentle river flow (along the bank)',
        processing='mono; HP 60 Hz, LP 7 kHz, gentle 2 kHz dip; seamless fixed-length loop (1.5 s equal-power continuation overlap); linear gain only')
def river_flow(ctx):
    x = ctx.seg('fs-690137', 40.0, 40.0 + 36.0 + 1.6, ch=1, note='river flow')
    x = peq(lp(hp(x, 60, 2), 7000, 2), 2000, -2, 0.8)
    y = fixed_loop(x, int(36 * SR), int(1.5 * SR))
    return y, dict(seam=seam_report(y))


@recipe('river-ford-rapids.ogg', 'river_flow', loop=True, lufs_target=-22, max_gr=0, variant='shallow ford / under-bridge rapids',
        processing='mono; HP 80 Hz, LP 4.2 kHz (tames distant bird calls); seamless fixed-length loop (1.5 s overlap); linear gain only')
def river_ford(ctx):
    x = ctx.seg('fs-520077', 100.0, 100.0 + 30.0 + 1.6, ch=1, note='water running across a road ford')
    x = lp(hp(x, 80, 2), 4200, 4)
    y = fixed_loop(x, int(30 * SR), int(1.5 * SR))
    return y, dict(seam=seam_report(y))


# ---------------------------------------------------------------- birds
@recipe('birds-countryside-bed.ogg', 'birds_farm_village', loop=True, stereo=True, lufs_target=-28, max_gr=0, variant='songbird bed (farm A)',
        processing='stereo; HP 280 Hz (removes traffic/wind rumble), LP 11 kHz; seamless fixed-length loop (2 s overlap); linear gain only')
def birds_bed(ctx):
    x = ctx.seg('fs-566147', 118.0, 118.0 + 60.0 + 2.1, ch=2, note='rural spring morning birdsong')
    x = lp(hp(x, 280, 4), 11000, 2)
    y = fixed_loop(x, int(60 * SR), int(2 * SR))
    return y, dict(seam=seam_report(y))


@recipe('birds-meadow-bed.ogg', 'birds_farm_village', loop=True, stereo=True, lufs_target=-28, max_gr=0, variant='songbird bed (village B / meadows)',
        processing='stereo; HP 380 Hz (removes wind rumble), LP 11 kHz; seamless fixed-length loop (2 s overlap); linear gain only')
def birds_meadow(ctx):
    x = ctx.seg('fs-847380', 140.0, 140.0 + 56.0 + 2.1, ch=2, note='spring meadow birdsong')
    x = lp(hp(x, 380, 4), 11000, 2)
    y = fixed_loop(x, int(56 * SR), int(2 * SR))
    return y, dict(seam=seam_report(y))


@recipe('crow-caw-1.ogg', 'birds_farm_village', lufs_target=-22, variant='hooded crow caws',
        processing='mono; HP 250 Hz; cut to three caws; 5 ms fade-in, 0.3 s fade-out')
def crow1(ctx):
    x = mono(ctx.seg('fs-741366', 0.10, 1.65, ch=1, note='hooded crow cawing'))
    return fade(hp(x, 250, 2), 0.005, 0.3)


@recipe('crow-caw-2.ogg', 'birds_farm_village', lufs_target=-22, variant='crow call flying off',
        processing='mono; HP 300 Hz; 5 ms fade-in, 0.4 s fade-out')
def crow2(ctx):
    x = mono(ctx.seg('fs-75162', 0.06, 2.3, ch=2, note='crow cawing while flying off'))
    return fade(hp(x, 300, 2), 0.005, 0.4)


@recipe('birds-scatter.ogg', 'birds_farm_village', stereo=True, lufs_target=-21, variant='flock takes off after a nearby blast',
        processing='stereo; HP 200 Hz; onset 30 ms pre-roll; 0.8 s fade-out')
def birds_scatter(ctx):
    x = ctx.seg('fs-616623', 1.10, 5.6, ch=2, note='pigeon flock flies away, wing flaps')
    return fade(hp(x, 200, 2), 0.01, 0.8)


# ---------------------------------------------------------------- church bell
@recipe('church-bell-toll.ogg', 'church_bell', lufs_target=-22, peak_db=-3.0, variant='single distant toll',
        processing='mono; HP 90 Hz; onset 10 ms pre-roll; natural decay kept (~13 s); expander on ambience after 9 s; 2.5 s fade-out')
def bell1(ctx):
    x = mono(ctx.seg('fs-852491', 0.40, 14.5, ch=1, note='village church bell strike, night'))
    x = hp(x, 90, 2)
    e = env(x, 40); t = np.arange(len(x)) / SR
    g = np.where(t < 9, 1.0, np.clip(1 - (t - 9) / 6, 0.3, 1))
    return fade(x * g, 0.003, 2.5)


@recipe('church-bell-toll-3x.ogg', 'church_bell', lufs_target=-21, peak_db=-3.0, variant='three slow tolls (match start / end)',
        processing='mono; one strike re-struck at 0/3.2/6.4 s at 0/-1.5/-3 dB (same bell, no detune), '
                   'HP 90 Hz; LP 5 kHz for distance; 3 s fade-out')
def bell3(ctx):
    x = hp(mono(ctx.seg('fs-852491', 0.40, 13.5, ch=1, note='village church bell strike, repeated')), 90, 2)
    from fractions import Fraction
    items = []
    for k, (st, gdb) in enumerate([(0.0, 0), (0.0, -1.5), (0.0, -3)]):
        r = 2 ** (-st / 12)
        fr = Fraction(1 / r).limit_denominator(400)
        s = signal.resample_poly(x, fr.numerator, fr.denominator)
        items.append((k * 3.2, s, 10 ** (gdb / 20)))
    y = place(int(19.0 * SR), items, circular=False, stereo=False)
    return fade(lp(y, 5000, 2), 0.003, 3.0)


# ---------------------------------------------------------------- Kessler Works industrial
@recipe('industrial-drone.ogg', 'kessler_works_industrial', loop=True, lufs_target=-22, max_gr=0, variant='low drone + steam hiss loop',
        processing='mono; factory drone HP 30 Hz, LP 2.4 kHz, low shelf +3 dB @ 120 Hz (heard from outside); steam-pipe hiss layer '
                   'BP 1.5-9 kHz at -16 dB; seamless fixed-length loop (1.5 s overlap); linear gain only')
def industrial(ctx):
    a = mono(ctx.seg('fs-455816', 6.0, 6.0 + 26.0 + 1.6, ch=2, note='industrial factory ambience (drone)'))
    a = shelf(lp(hp(a, 30, 2), 2400, 4), 120, 3, 'low')
    b = mono(ctx.seg('fs-453462', 10.0, 10.0 + 26.0 + 1.6, ch=2, note='industrial steam pipes hiss'))
    b = bp(b, 1500, 9000, 2)
    a = a / np.sqrt(np.mean(a ** 2)); b = b / np.sqrt(np.mean(b ** 2))
    y = fixed_loop(a + b * 10 ** (-16 / 20), int(26 * SR), int(1.5 * SR))
    return y, dict(seam=seam_report(y))


@recipe('industrial-creak-clank.ogg', 'kessler_works_industrial', lufs_target=-22, peak_db=-3.0, variant='occasional metal creak + clank',
        processing='mono; metal creak HP 120 Hz, LP 6 kHz; clang placed 0.9 s after the creak start at -2 dB, LP 5 kHz; '
                   'synthetic 0.35 s / 0.8 s low-passed reflections at -12/-18 dB; 0.8 s fade-out')
def creak_clank(ctx):
    c = mono(ctx.seg('fs-489442', 16.6, 18.9, ch=2, note='creaking metal'))
    c = lp(hp(c, 120, 2), 6000, 2)
    k = mono(ctx.seg('fs-568787', 0.62, 2.9, ch=2, note='metallic clang'))
    k = lp(hp(k, 80, 2), 5000, 2)
    c = c / np.abs(c).max(); k = k / np.abs(k).max()
    y = place(int(3.8 * SR), [(0.0, c, 0.7), (0.9, k, 0.8)], circular=False, stereo=False)
    y = mono(echo_tail(y, [(0.35, -12, 0), (0.8, -18, 0)], lp_hz=1800))
    return fade(trim_tail(y, -55, 0.05), 0.003, 0.8)


@recipe('industrial-steam-release.ogg', 'kessler_works_industrial', lufs_target=-23, peak_db=-3.0, variant='occasional steam release burst',
        processing='mono; factory steam release HP 200 Hz, LP 10 kHz; 0.25 s fade-in, 1.2 s fade-out')
def steam(ctx):
    x = mono(ctx.seg('fs-455816', 33.2, 38.8, ch=2, note='steam release in factory'))
    x = lp(hp(x, 200, 2), 10000, 2)
    return fade(x, 0.25, 1.2)


# ---------------------------------------------------------------- burning wreck props
@recipe('wreck-fire-crackle.ogg', 'burning_wreck_props', loop=True, lufs_target=-26, max_gr=10, variant='quiet positional crackle loop',
        processing='mono; log-fire crackle (HP 120 Hz) + flame body/pops layer (HP 60 Hz, -4 dB); LP 9 kHz; pop tamer (limiter, crest <= 14 dB); '
                   'seamless fixed-length loop (0.8 s overlap); linear gain only')
def wreck_fire(ctx):
    a = mono(ctx.seg('fs-363093', 2.0, 2.0 + 24.0 + 0.9, ch=2, note='fire crackle and flames'))
    b = mono(ctx.seg('fs-508110', 1.0, 1.0 + 24.0 + 0.9, ch=1, note='fire ambience, flames, pops'))
    a = hp(a, 120, 2); b = hp(b, 60, 2)
    a = a / np.sqrt(np.mean(a ** 2)); b = b / np.sqrt(np.mean(b ** 2))
    x = lp(a + b * 10 ** (-4 / 20), 9000, 2)
    x = limiter(x, np.sqrt(np.mean(x ** 2)) * 10 ** (14 / 20), 1.0, 40.0)  # pop tamer: crest factor capped at 14 dB
    y = fixed_loop(x, int(24 * SR), int(0.8 * SR))
    return y, dict(seam=seam_report(y))
