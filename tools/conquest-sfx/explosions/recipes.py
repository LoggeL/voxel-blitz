"""Explosion / impact recipes. Each returns mono float64 at 48 kHz (optionally with an info dict);
build.py normalizes (LUFS target with a peak cap), encodes and records provenance.
Only CC0 / CC-BY / US-government public-domain (CC-BY on YouTube) sources; craigsmith (vintage TV library),
zapsplat re-uploads and re-licensed derivative mixes are deliberately excluded."""
import numpy as np
from dsp import *
from scipy import signal

# ---------------------------------------------------------------- helpers
def thump(dur=0.5, f0=70, f1=38, decay=0.12):
    """Original synthesized sub thump: pitch-dropping sine with exponential decay."""
    t = np.arange(int(dur*SR)) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.06)
    return np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-t/decay) * (1 - np.exp(-t/0.002))
def ev(c, name, t, dur, note='', pre=0.004):
    return fade(c.seg(name, max(0.0, t - pre), t + dur, note), 0.0005, 0.008)
def duck(x, t0, t1, g_db):
    """Smoothly lower everything after t0 (reaching g_db at t1): keeps the blast, tames a loud debris section."""
    t = np.arange(len(x)) / SR; g = np.ones(len(x)); k = np.clip((t - t0) / (t1 - t0), 0, 1)
    return x * (1 + (10**(g_db/20) - 1) * (0.5 - 0.5*np.cos(np.pi*k)))
def nrm(x, p=1.0): return x / (np.abs(x).max() + 1e-12) * p
def decay_after(x, t0, tau):
    """Exponential decay envelope from t0 on (shortens tails for rapid-fire use)."""
    t = np.arange(len(x)) / SR; g = np.ones(len(x)); m = t > t0
    g[m] = np.exp(-(t[m] - t0) / tau); return x * g
def fit(x, dur, fout):
    n = int(dur*SR); x = x[:n] if len(x) >= n else np.r_[x, np.zeros(n - len(x))]
    return fade(x, 0.0015, fout)
def mix(dur, items):
    """items: (offset_s, signal, gain_db). Signals are peak-normalized first."""
    return place(int(dur*SR), [(o, nrm(x), 10**(g/20)) for o, x, g in items])
def clean(x, lo=25, hi=16000):
    x = hp(x, lo)
    return lp(x, hi) if hi < SR/2 - 100 else x
SYN_THUMP = 'synthesized sub thump (pitch-dropping sine, exponential decay)'

# ================================================================ frag grenade
FRAG_P = ('declip (cubic spline over clipped runs); HP 30 Hz; onset trimmed to 2 ms pre-roll; layered crack/dirt/tail; '
          '1.5 ms fade-in, cosine fade-out')
@recipe('frag-1.ogg', 'frag_grenade_explosion', processing=FRAG_P, variant='DoD blast + firework crack + stone spray + open-field tail')
def _(c):
    body = trim_onset(declip(clean(ev(c, 'fs-182429', 0.0, 1.75, 'main blast (US gov. video audio)'))), 0.05)
    crack = hp(ev(c, 'fs-336011', 0.0, 0.35, 'sharp firework crack transient, HP 900 Hz'), 900)
    dirt = hp(lp(ev(c, 'fs-567251', 1.0, 0.7, 'falling stones = dirt/debris spray, band 1.2-9 kHz'), 9000), 1200)
    tail = lp(ev(c, 'fs-752629', 0.45, 1.9, 'open-field tail portion (after its own transient), LP 3 kHz'), 3000)
    y = mix(2.1, [(0, body, 0), (0, trim_onset(crack, .05), -5), (0.07, fade(dirt, 0.04, 0.3), -15),
                   (0.28, fade(tail, 0.25, 0.6), -11), (0, thump(0.5, 95, 48, 0.09), -9)])
    return fade(y, 0.0015, 0.5), dict(synth=SYN_THUMP)

@recipe('frag-2.ogg', 'frag_grenade_explosion', processing=FRAG_P, variant='open-field grenade recording + crack + stone spray')
def _(c):
    body = trim_onset(declip(clean(ev(c, 'fs-752629', 0.0, 2.2, 'grenade in open field incl. natural valley tail'))), 0.08)
    meat = trim_onset(ev(c, 'fs-609587', 0.0, 1.8, 'meaty synthesized grenade body'), .05)
    crack = hp(ev(c, 'fs-462363', 0.37, 0.3, 'firecracker crack transient, HP 1 kHz'), 1000)
    dirt = hp(lp(ev(c, 'fs-567251', 2.0, 0.6, 'falling stones = dirt spray, band 1.5-8 kHz'), 8000), 1500)
    y = mix(2.0, [(0, body, -2), (0.003, meat, -2), (0, trim_onset(crack, .05), -9), (0.06, fade(dirt, 0.03, 0.3), -14),
                   (0, thump(0.45, 100, 50, 0.08), -7)])
    return fade(y, 0.0015, 0.45), dict(synth=SYN_THUMP)

@recipe('frag-3.ogg', 'frag_grenade_explosion', processing=FRAG_P, variant='Marines demolition-range blast + extended tail')
def _(c):
    body = trim_onset(declip(clean(ev(c, 'yt-gGsJk41G5_A', 21.30, 1.15, 'real demolition-range blast, cut before speech'))), 0.05)
    body = fade(body, 0.0, 0.25)
    tail = lp(ev(c, 'fs-609587', 0.35, 1.5, 'synth grenade tail extension, LP 2.5 kHz'), 2500)
    crack = hp(ev(c, 'fs-336011', 0.0, 0.3, 'firework crack transient, HP 900 Hz'), 900)
    dirt = hp(lp(ev(c, 'fs-567249', 0.8, 0.6, 'bricks/stones falling = dirt spray, band 1.2-9 kHz'), 9000), 1200)
    y = mix(1.9, [(0, body, 0), (0, trim_onset(crack, .05), -8), (0.5, fade(tail, 0.35, 0.5), -12),
                   (0.08, fade(dirt, 0.03, 0.3), -16), (0, thump(0.45, 90, 45, 0.09), -9)])
    return fade(y, 0.0015, 0.45), dict(synth=SYN_THUMP)

# ================================================================ tank HE
HE_P = ('declip; HP 25 Hz; onset trimmed; + synthesized sub thump; debris/rubble layer for fall-back; long cosine fade-out')
@recipe('tank-he-1.ogg', 'tank_he_shell_impact', processing=HE_P, variant='Tannerite blast in woods, debris and tree fall-back')
def _(c):
    x = trim_onset(declip(clean(ev(c, 'fs-530163', 0.0, 4.6, 'blast + falling debris/wood'))), 0.05)
    x = duck(x, 0.5, 1.3, -9)
    rub = lp(ev(c, 'fs-567249', 0.2, 2.6, 'rubble falling back, LP 7 kHz'), 7000)
    y = mix(4.4, [(0, x, 0), (0, thump(0.9, 70, 32, 0.22), -5), (0.45, fade(rub, 0.15, 0.8), -17)])
    return fade(y, 0.001, 1.0), dict(synth=SYN_THUMP)

@recipe('tank-he-2.ogg', 'tank_he_shell_impact', processing=HE_P, variant='explosion with debris rain (Nox_Sound #2)')
def _(c):
    x = trim_onset(declip(clean(ev(c, 'fs-560510', 3.0, 4.4, 'explosion #2 with debris tail'))), 0.05)
    y = mix(4.2, [(0, x, 0), (0, thump(0.9, 65, 30, 0.25), -5)])
    return fade(y, 0.001, 0.9), dict(synth=SYN_THUMP)

@recipe('tank-he-3.ogg', 'tank_he_shell_impact', processing=HE_P, variant='Army live claymore range blast + rubble fall-back')
def _(c):
    x = trim_onset(declip(clean(ev(c, 'yt-KJiqP8hurLU', 34.30, 3.2, 'real claymore detonation with range tail, cut before speech'))), 0.05)
    x = fade(x, 0, 0.5)
    rub = lp(ev(c, 'fs-567249', 0.3, 2.6, 'rubble/dirt falling back, LP 6 kHz'), 6000)
    y = mix(3.8, [(0, x, 0), (0, thump(1.0, 68, 30, 0.28), -4), (0.35, fade(rub, 0.2, 0.8), -15)])
    return fade(y, 0.001, 0.9), dict(synth=SYN_THUMP)

# ================================================================ tank AP
AP_P = 'HP 30 Hz; onset trimmed; short fast-decaying blast core; kinetic crack + slam layers; resampled (pitch) where noted; cosine fade-out'
@recipe('tank-ap-1.ogg', 'tank_ap_shell_impact', processing=AP_P, variant='ground: kinetic crack + dirt slam, little fireball')
def _(c):
    core = decay_after(trim_onset(clean(ev(c, 'fs-182432', 1.13, 0.26, 'short blast core (US gov. video audio)')), .05), 0.05, 0.08)
    crack = hp(ev(c, 'fs-336011', 0.0, 0.35, 'crack, HP 700 Hz'), 700)
    slam = lp(rate(ev(c, 'fs-319222', 0.265, 0.3, 'rock-into-dirt hit, pitched down x0.55 = heavy slam'), 0.55), 4000)
    tail = lp(ev(c, 'fs-752629', 0.6, 1.2, 'open-field tail, LP 2 kHz'), 2000)
    y = mix(1.3, [(0, trim_onset(crack, .05), 0), (0.002, core, -3), (0.004, trim_onset(slam, .1), -4),
                   (0, thump(0.35, 120, 50, 0.07), -6), (0.15, fade(tail, 0.15, 0.4), -16)])
    return fade(y, 0.001, 0.35), dict(synth=SYN_THUMP)

@recipe('tank-ap-2.ogg', 'tank_ap_shell_impact', processing=AP_P, variant='metal: crack + penetrating clang/crunch')
def _(c):
    crack = hp(ev(c, 'fs-336011', 0.0, 0.3, 'crack, HP 700 Hz'), 700)
    clang = rate(ev(c, 'fs-547979', 13.43, 1.2, 'heavy sheet-metal bang pitched down x0.55'), 0.55)
    smash = ev(c, 'fs-562198', 0.0, 1.2, 'metal smash/crunch')
    ring = lp(rate(ev(c, 'fs-386798', 0.9, 1.6, 'metal collision ringing tail pitched down x0.6'), 0.6), 3000)
    y = mix(1.6, [(0, trim_onset(crack, .05), -1), (0.003, trim_onset(clang, .05), -2), (0.006, trim_onset(smash, .05), -4),
                   (0.08, fade(ring, 0.05, 0.5), -14), (0, thump(0.3, 140, 60, 0.06), -8)])
    return fade(y, 0.001, 0.4), dict(synth=SYN_THUMP)

# ================================================================ rocket / missile
RK_P = 'declip; HP 30 Hz; onset trimmed; crack transient layer; cosine fade-out'
@recipe('rocket-1.ogg', 'rocket_missile_explosion', processing=RK_P, variant='AT warhead: medium blast with long reverb')
def _(c):
    x = trim_onset(declip(clean(ev(c, 'fs-516914', 0.25, 3.3, 'medium blast, long reverb'))), 0.05)
    crack = hp(ev(c, 'fs-336011', 0.0, 0.3, 'crack, HP 900 Hz'), 900)
    y = mix(3.2, [(0, x, 0), (0, trim_onset(crack, .05), -6), (0, thump(0.6, 85, 40, 0.12), -7)])
    return fade(y, 0.001, 0.8), dict(synth=SYN_THUMP)

@recipe('rocket-2.ogg', 'rocket_missile_explosion', processing=RK_P, variant='AT warhead: Marines EOD post-blast detonation')
def _(c):
    x = trim_onset(declip(clean(ev(c, 'yt-nMwFtsxM__Q', 0.30, 3.6, 'real EOD test detonation with decay'))), 0.05)
    crack = hp(ev(c, 'fs-462363', 0.37, 0.3, 'firecracker crack, HP 1 kHz'), 1000)
    y = mix(3.3, [(0, x, 0), (0, trim_onset(crack, .05), -8), (0, thump(0.6, 85, 40, 0.12), -7)])
    return fade(y, 0.001, 0.8), dict(synth=SYN_THUMP)

AIR_P = 'HP 110 Hz (thin, no ground body); onset trimmed; open airy tail kept; cosine fade-out'
@recipe('rocket-airburst-1.ogg', 'rocket_missile_explosion', processing=AIR_P, max_gr=10, variant='airburst (AA missile hit on aircraft)')
def _(c):
    x = trim_onset(declip(hp(ev(c, 'fs-613673', 12.48, 2.9, 'clean outdoor aerial shell burst'), 110)), 0.05)
    return fade(fit(x, 2.8, 0.7), 0.001, 0.7)

@recipe('rocket-airburst-2.ogg', 'rocket_missile_explosion', processing=AIR_P, max_gr=10, variant='airburst (AA missile hit on aircraft)')
def _(c):
    x = trim_onset(declip(hp(ev(c, 'fs-613673', 42.74, 2.9, 'clean outdoor aerial shell burst with echo'), 110)), 0.05)
    crack = hp(ev(c, 'fs-336011', 0.0, 0.3, 'crack, HP 900 Hz'), 900)
    y = mix(2.8, [(0, x, 0), (0, trim_onset(crack, .05), -9)])
    return fade(y, 0.001, 0.7)

# ================================================================ autocannon 25 mm HE
AC_P = 'HP 40 Hz; onset trimmed; dry: exponential decay after 60 ms (tau 90 ms); dirt-spray layer; ~0.5 s for rapid repetition'
def ac(c, name, t, d, note):
    core = trim_onset(declip(clean(ev(c, name, t, d, note), 40)), .05)
    core = fade(decay_after(core, 0.06, 0.09), 0, 0.06)
    dirt = hp(lp(ev(c, 'fs-319229', 0.33, 0.25, 'rock-hits-dirt spray, band 600 Hz-8 kHz'), 8000), 600)
    return core, trim_onset(dirt, .1)
@recipe('autocannon-impact-1.ogg', 'autocannon_round_impact', processing=AC_P, lufs_target=-21, peak_db=-4)
def _(c):
    core, dirt = ac(c, 'fs-182432', 1.13, 0.26, 'small blast (US gov. video audio)')
    return fade(mix(0.5, [(0, core, 0), (0.005, dirt, -9), (0, thump(0.2, 140, 70, 0.04), -10)]), 0.001, 0.15), dict(synth=SYN_THUMP)
@recipe('autocannon-impact-2.ogg', 'autocannon_round_impact', processing=AC_P, lufs_target=-21, peak_db=-4)
def _(c):
    core, dirt = ac(c, 'fs-182432', 1.395, 0.55, 'small blast (US gov. video audio)')
    return fade(mix(0.5, [(0, core, 0), (0.005, dirt, -9), (0, thump(0.2, 130, 65, 0.04), -10)]), 0.001, 0.15), dict(synth=SYN_THUMP)
@recipe('autocannon-impact-3.ogg', 'autocannon_round_impact', processing=AC_P, lufs_target=-21, peak_db=-4)
def _(c):
    core, dirt = ac(c, 'fs-843247', 0.0, 0.6, 'real small explosion from a burning car')
    crack = hp(ev(c, 'fs-462363', 0.37, 0.2, 'firecracker crack, HP 1.2 kHz'), 1200)
    return fade(mix(0.5, [(0, core, 0), (0, trim_onset(crack, .05), -6), (0.005, dirt, -10)]), 0.001, 0.15)

# ================================================================ limpet / C4
LP_P = 'declip; HP 25 Hz; onset trimmed; + synthesized sub thump; metal shrapnel ring layer (hull); cosine fade-out'
@recipe('limpet-1.ogg', 'limpet_c4_explosion', processing=LP_P, variant='demolition charge + shrapnel ring')
def _(c):
    x = trim_onset(declip(clean(ev(c, 'yt-gGsJk41G5_A', 74.20, 3.4, 'real demolition-range charge with tail'))), 0.05)
    ring = rate(ev(c, 'fs-262516', 0.0, 1.2, 'steel sheet hit, pitched down x0.8 = shrapnel ring'), 0.8)
    ping = rate(ev(c, 'fs-351371', 0.02, 0.4, 'metal ping pitched down x0.7'), 0.7)
    y = mix(3.4, [(0, x, 0), (0, thump(1.0, 60, 28, 0.3), -3), (0.02, ring, -13), (0.05, ping, -16)])
    return fade(y, 0.001, 0.9), dict(synth=SYN_THUMP)

@recipe('limpet-2.ogg', 'limpet_c4_explosion', processing=LP_P, variant='deep demolition boom + metal crunch/ring (on hull)')
def _(c):
    x = trim_onset(declip(clean(ev(c, 'fs-220062', 0.0, 3.6, 'deep synthesized explosion with long tail'))), 0.05)
    smash = ev(c, 'fs-562198', 0.0, 1.3, 'metal smash')
    ring = lp(rate(ev(c, 'fs-547979', 17.41, 1.4, 'sheet-metal bang pitched down x0.7 = hull ring'), 0.7), 6000)
    y = mix(3.4, [(0, x, 0), (0, thump(1.0, 58, 26, 0.32), -3), (0.004, trim_onset(smash, .05), -9), (0.01, trim_onset(ring, .05), -12)])
    return fade(y, 0.001, 0.9), dict(synth=SYN_THUMP)

# ================================================================ vehicle destruction
VD_P = 'declip; HP 25 Hz; layered boom + metal tear/crash + fire whoosh + debris/metal rain; pitch via resampling where noted; cosine fade-out'
@recipe('vehicle-destruction-tank.ogg', 'vehicle_destruction', processing=VD_P, variant='tank: heavy fuel/ammo explosion')
def _(c):
    boom = fade(trim_onset(declip(clean(ev(c, 'fs-560510', 8.0, 4.8, 'explosion #3 with long debris tail'))), 0.05), 0, 1.2)
    crash = rate(ev(c, 'fs-587443', 0.04, 2.2, 'scrap metal crash pitched down x0.75 = metal tearing'), 0.75)
    whoosh = lp(ev(c, 'fs-244926', 0.15, 3.4, 'diesel fire whoosh = fireball, LP 4 kHz'), 4000)
    rain = hp(ev(c, 'fs-378670', 0.0, 3.0, 'falling scrap metal = metal rain, HP 400 Hz'), 400)
    deb = ev(c, 'fs-703248', 0.0, 3.0, 'tile/stone/metal debris crash')
    y = mix(5.2, [(0, boom, 0), (0, thump(1.4, 55, 26, 0.4), -2), (0.03, trim_onset(crash, .05), -7),
                   (0.1, fade(whoosh, 0.15, 1.0), -9), (1.0, fade(rain, 0.05, 0.8), -13), (0.7, fade(deb, 0.05, 0.9), -14)])
    return fade(y, 0.001, 1.2), dict(synth=SYN_THUMP)

@recipe('vehicle-destruction-jeep.ogg', 'vehicle_destruction', processing=VD_P, variant='jeep: lighter car fuel explosion + glass')
def _(c):
    car = trim_onset(clean(ev(c, 'fs-843247', 0.0, 0.7, 'real burning-car explosion')), .05)
    boom = trim_onset(declip(clean(rate(ev(c, 'fs-182429', 0.0, 1.75, 'blast body (US gov. video audio), x0.9'), 0.9))), .05)
    smash = ev(c, 'fs-562198', 0.0, 1.6, 'metal smash')
    glass = hp(ev(c, 'fs-336425', 0.0, 2.6, 'glass shattering and falling, HP 1 kHz'), 1000)
    whoosh = ev(c, 'fs-260555', 0.0, 3.0, 'fire whoosh')
    deb = ev(c, 'fs-703248', 0.0, 2.4, 'debris crash')
    y = mix(3.6, [(0, car, 0), (0.005, boom, -3), (0.01, trim_onset(smash, .05), -8), (0.06, glass, -15),
                   (0.03, fade(whoosh, 0.1, 0.8), -9), (0.5, fade(deb, 0.05, 0.7), -16), (0, thump(0.8, 70, 34, 0.2), -6)])
    return fade(y, 0.001, 0.9), dict(synth=SYN_THUMP)

@recipe('vehicle-destruction-heli.ogg', 'vehicle_destruction', processing=VD_P, variant='helicopter: airborne breakup + falling-wreck crash at ~2.3 s')
def _(c):
    air = trim_onset(declip(hp(ev(c, 'fs-613673', 12.48, 2.4, 'open-air burst'), 60)), .05)
    tear = ev(c, 'fs-178202', 0.0, 2.6, 'crashing metal objects = airframe breakup')
    whoosh = lp(ev(c, 'fs-244926', 0.15, 2.4, 'fire whoosh, LP 4 kHz'), 4000)
    crash = rate(ev(c, 'fs-587443', 8.09, 2.4, 'scrap metal crash pitched x0.7 = wreck hits ground'), 0.7)
    thud = rate(ev(c, 'fs-319222', 0.265, 0.3, 'rock-into-dirt hit pitched x0.4 = heavy ground impact'), 0.4)
    deb = ev(c, 'fs-703248', 0.0, 2.6, 'debris crash')
    y = mix(5.2, [(0, air, 0), (0, thump(0.8, 70, 34, 0.18), -6), (0.04, trim_onset(tear, .05), -8), (0.1, fade(whoosh, 0.1, 0.8), -10),
                   (2.3, trim_onset(crash, .05), -3), (2.3, trim_onset(thud, .1), -4), (2.3, thump(1.0, 60, 28, 0.3), -4),
                   (2.45, fade(deb, 0.05, 0.9), -11)])
    return fade(y, 0.001, 1.0), dict(synth=SYN_THUMP)

@recipe('vehicle-destruction-jet.ogg', 'vehicle_destruction', processing=VD_P, variant='jet: mid-air fireball + distant ground crash at ~2.5 s')
def _(c):
    air = trim_onset(declip(clean(ev(c, 'fs-516914', 0.25, 2.8, 'medium blast, long reverb'), 50)), .05)
    tear = ev(c, 'fs-471192', 0.0, 1.4, 'metal crash')
    whoosh = ev(c, 'fs-244926', 0.15, 3.0, 'fire whoosh = fuel fireball')
    impact = lp(trim_onset(ev(c, 'fs-182432', 0.46, 0.65, 'blast (US gov. video audio), LP 2.5 kHz = distant ground impact'), .05), 2500)
    crash = lp(rate(ev(c, 'fs-587443', 10.82, 2.0, 'scrap metal crash x0.65, LP 3.5 kHz'), 0.65), 3500)
    y = mix(5.0, [(0, air, 0), (0.02, trim_onset(tear, .05), -9), (0.05, fade(whoosh, 0.1, 0.9), -7),
                   (2.5, impact, -5), (2.52, trim_onset(crash, .05), -9), (2.5, thump(1.0, 55, 26, 0.3), -6)])
    return fade(y, 0.001, 1.0), dict(synth=SYN_THUMP)

# ================================================================ cook-off secondaries
CK_P = 'HP 40 Hz; bursts pitched down via resampling for weight; hissing propellant/flare layer; cosine fade-in/out'
@recipe('cookoff-1.ogg', 'vehicle_cookoff_secondary', processing=CK_P, lufs_target=-21, peak_db=-4)
def _(c):
    pops = fade(lp(declip(rate(ev(c, 'fs-121557', 0.6, 1.9, 'rapid firecracker string pitched x0.75 = ammo cook-off pops'), 0.75)), 7000), 0, 0.3)
    hiss = ev(c, 'fs-674378', 0.0, 2.1, 'flare sizzle = burning propellant hiss')
    crack = ev(c, 'fs-450837', 0.0, 0.8, 'flare fire dull crack')
    y = mix(2.8, [(0, trim_onset(crack, .05), -3), (0.05, pops, 0), (0.0, fade(hiss, 0.25, 0.8), -12)])
    return fade(y, 0.002, 0.5)

@recipe('cookoff-2.ogg', 'vehicle_cookoff_secondary', processing=CK_P, lufs_target=-21, peak_db=-4)
def _(c):
    pops = fade(declip(rate(ev(c, 'fs-404999', 9.32, 1.4, 'firecracker pops/fizzle pitched x0.8'), 0.8)), 0, 0.4)
    burst = trim_onset(clean(ev(c, 'fs-843250', 0.0, 0.4, 'small burning-car burst')), .05)
    flare = lp(ev(c, 'fs-244926', 0.1, 2.0, 'fire whoosh = propellant flare, LP 6 kHz'), 6000)
    y = mix(2.5, [(0, burst, 0), (0.15, pops, -2), (0.02, fade(flare, 0.2, 0.8), -9)])
    return fade(y, 0.002, 0.5)

@recipe('cookoff-3.ogg', 'vehicle_cookoff_secondary', processing=CK_P, lufs_target=-21, peak_db=-4)
def _(c):
    pops = fade(declip(rate(ev(c, 'fs-404999', 31.38, 1.9, 'firecracker crackle string pitched x0.8'), 0.8)), 0, 0.4)
    burst = trim_onset(clean(ev(c, 'fs-843249', 0.0, 0.55, 'small burning-car burst')), .05)
    hiss = ev(c, 'fs-412558', 0.0, 2.4, 'fire consuming cardboard = combustion hiss')
    y = mix(2.8, [(0, pops, 0), (1.15, burst, -2), (0.0, fade(hiss, 0.3, 0.8), -11)])
    return fade(y, 0.002, 0.5)

# ================================================================ distant tail
DT_P = 'LP (distance air absorption) 4th order; low shelf where noted; onset trimmed with 20 ms soft attack; long cosine fade-out'
@recipe('distant-boom-1.ogg', 'distant_explosion_tail', processing=DT_P, lufs_target=-24, peak_db=-6, max_gr=3)
def _(c):
    x = lp(ev(c, 'fs-320788', 29.0, 5.6, 'one distant explosion with rolling tail'), 1400)
    return fade(trim_onset(x, 0.08, 0.02), 0.02, 1.5)
@recipe('distant-boom-2.ogg', 'distant_explosion_tail', processing=DT_P, lufs_target=-24, peak_db=-6, max_gr=3)
def _(c):
    x = lp(declip(ev(c, 'fs-108640', 0.1, 3.9, 'real distant explosion')), 1800)
    roll = lp(ev(c, 'fs-475780', 2.0, 6.0, 'rolling valley echo of a mine blast, LP 600 Hz'), 600)
    y = mix(5.5, [(0, trim_onset(x, .08, .02), 0), (0.9, fade(roll, 0.6, 2.0), -11)])
    return fade(y, 0.02, 1.6)
@recipe('distant-boom-3.ogg', 'distant_explosion_tail', processing=DT_P + '; heavy clipping in the source hidden by LP 900 Hz', lufs_target=-24, peak_db=-6, max_gr=3)
def _(c):
    x = ev(c, 'fs-475780', 0.0, 6.6, 'real 70 t mine blast heard from distance with rolling thunder')
    x = shelf(lp(x, 900), 120, 3)
    return fade(trim_onset(x, 0.08, 0.02), 0.02, 2.0)
@recipe('distant-boom-4.ogg', 'distant_explosion_tail', processing=DT_P, lufs_target=-24, peak_db=-6, max_gr=3)
def _(c):
    x = lp(ev(c, 'fs-86291', 0.0, 6.5, 'simulated faraway explosion'), 1500)
    return fade(trim_onset(x, 0.08, 0.02), 0.02, 2.0)

# ================================================================ debris / block break
DB_P = 'HP 60 Hz; onset trimmed; tail faded; short (<1 s) for stacking'
def deb(c, name, t, d, note, fo=0.2, hi=16000, lo=60):
    return fit(trim_onset(declip(clean(ev(c, name, t, d, note), lo, hi)), 0.05), d, fo)
@recipe('debris-stone-1.ogg', 'debris_rubble_block_break', processing=DB_P, lufs_target=-23, peak_db=-6, max_gr=4, variant='stone')
def _(c):
    a = deb(c, 'fs-843339', 3.20, 0.7, 'concrete chunks dropped on asphalt')
    g = hp(ev(c, 'fs-567251', 1.0, 0.6, 'stones falling grit, HP 800 Hz'), 800)
    return fade(mix(0.75, [(0, a, 0), (0.04, fade(g, 0.03, 0.3), -12)]), 0.0015, 0.2)
@recipe('debris-stone-2.ogg', 'debris_rubble_block_break', processing=DB_P, lufs_target=-23, peak_db=-6, max_gr=4, variant='stone')
def _(c):
    a = deb(c, 'fs-843339', 6.16, 0.7, 'concrete chunks dropped on asphalt')
    g = hp(ev(c, 'fs-567249', 2.0, 0.6, 'bricks falling grit, HP 600 Hz'), 600)
    return fade(mix(0.75, [(0, a, 0), (0.03, fade(g, 0.03, 0.3), -11)]), 0.0015, 0.2)
@recipe('debris-wood-1.ogg', 'debris_rubble_block_break', processing=DB_P, lufs_target=-23, peak_db=-6, max_gr=4, variant='wood')
def _(c):
    a = deb(c, 'fs-109359', 1.03, 0.55, 'dry branch splinter-crack')
    k = rate(ev(c, 'fs-742356', 0.02, 0.18, 'wood knock pitched x0.7 = hollow body'), 0.7)
    return fade(mix(0.6, [(0, a, 0), (0.0, trim_onset(k, .05), -6)]), 0.0015, 0.2)
@recipe('debris-wood-2.ogg', 'debris_rubble_block_break', processing=DB_P, lufs_target=-23, peak_db=-6, max_gr=4, variant='wood')
def _(c): return deb(c, 'fs-536777', 0.0, 0.85, 'wooden furniture/door smash', 0.25)
@recipe('debris-metal-1.ogg', 'debris_rubble_block_break', processing=DB_P, lufs_target=-23, peak_db=-6, max_gr=4, variant='metal')
def _(c): return deb(c, 'fs-547979', 5.585, 0.8, 'sheet metal bang', 0.35)
@recipe('debris-metal-2.ogg', 'debris_rubble_block_break', processing=DB_P, lufs_target=-23, peak_db=-6, max_gr=4, variant='metal')
def _(c): return deb(c, 'fs-587443', 4.78, 0.75, 'scrap metal dropped on concrete', 0.3)
@recipe('debris-glass-1.ogg', 'debris_rubble_block_break', processing=DB_P + '; HP 300 Hz', lufs_target=-23, peak_db=-6, max_gr=4, variant='glass')
def _(c): return deb(c, 'fs-221528', 0.32, 0.85, 'glass sheet shattered with a rock', 0.3, lo=300)
@recipe('debris-glass-2.ogg', 'debris_rubble_block_break', processing=DB_P + '; HP 300 Hz', lufs_target=-23, peak_db=-6, max_gr=4, variant='glass')
def _(c): return deb(c, 'fs-371092', 0.06, 0.8, 'glass bottle shattering', 0.3, lo=300)

# ================================================================ bullet impacts
BI_P = 'onset trimmed (1 ms pre-roll); band-limited; noise floor faded via short cosine tail; 1 ms fade-in'
def hit(c, name, t, d, note, lo=80, hi=14000, fo=0.08, pre=0.004):
    x = clean(ev(c, name, t, d, note, pre), lo, hi)
    return fit(trim_onset(declip(x), 0.08, 0.001), d, fo)
def grit(c, t=1.0):
    return hp(lp(ev(c, 'fs-567251', t, 0.2, 'stones falling grit = dirt spray, band 1.5-9 kHz'), 9000), 1500)
DIRT = [(0.265, 'fs-319222'), (0.815, 'fs-319222'), (0.33, 'fs-319229'), (0.64, 'fs-319229')]
for i, (t, n) in enumerate(DIRT, 1):
    def _mk(t=t, n=n, i=i):
        @recipe(f'bullet-dirt-{i}.ogg', 'bullet_impact_dirt', processing=BI_P + '; +3 dB peak at 160 Hz (thud); grit spray layer', lufs_target=-26, peak_db=-7, max_gr=4)
        def _(c):
            x = peq(hit(c, n, t, 0.28, 'rock hitting dirt (made for bullet hits)', 60, 7000), 160, 3, 0.8)
            return fade(mix(0.3, [(0, x, 0), (0.008, fade(grit(c, 0.8 + 0.4*i), 0.01, 0.12), -14)]), 0.001, 0.08)
    _mk()
STONE = [0.085, 1.56, 4.115, 6.415]
for i, t in enumerate(STONE, 1):
    def _mk(t=t, i=i):
        @recipe(f'bullet-stone-{i}.ogg', 'bullet_impact_stone', processing=BI_P + '; HP 250 Hz, +3 dB high shelf 3 kHz (crack/chips)' + ('; ricochet whine layer' if i == 4 else ''), lufs_target=-26, peak_db=-7, max_gr=4)
        def _(c):
            x = shelf(hit(c, 'fs-567701', t, 0.3, 'rock thrown onto rock pile = crack + chips', 250, 15000), 3000, 3, 'high')
            x = fit(decay_after(x, 0.025, 0.03), 0.16, 0.04)  # single hit: suppress the following rock-pile clatter
            if i < 4: return x
            w = hp(ev(c, 'fs-30932', 0.99, 0.6, 'ricochet whine (simulated)'), 1500)
            return fade(mix(0.62, [(0, x, 0), (0.03, fade(trim_onset(w, .05), 0.02, 0.3), -6)]), 0.001, 0.15)
    _mk()
METAL = [(2.68, 'fs-182263', 'foley bullet hit metal'), (4.46, 'fs-182263', 'foley bullet hit metal'), (7.285, 'fs-182263', 'foley bullet hit metal'),
         (0.02, 'fs-351371', 'pot/pan hit made as bullet ping off armour')]
for i, (t, n, note) in enumerate(METAL, 1):
    def _mk(t=t, n=n, note=note, i=i):
        @recipe(f'bullet-metal-{i}.ogg', 'bullet_impact_metal', processing=BI_P + '; HP 300 Hz', lufs_target=-26, peak_db=-7, max_gr=4)
        def _(c): return hit(c, n, t, 0.38, note, 300, 16000, 0.15)
    _mk()
@recipe('bullet-wood-1.ogg', 'bullet_impact_wood', processing=BI_P + '; knock + splinter layer', lufs_target=-26, peak_db=-7, max_gr=4)
def _(c):
    k = hit(c, 'fs-742356', 0.03, 0.17, 'single wood knock = hollow thunk', 70, 9000)
    s = hit(c, 'fs-669457', 1.57, 0.15, 'wood cracking = splinters', 800, 14000)
    return fade(mix(0.25, [(0, k, 0), (0.002, s, -6)]), 0.001, 0.06)
@recipe('bullet-wood-2.ogg', 'bullet_impact_wood', processing=BI_P + '; knock + splinter layer', lufs_target=-26, peak_db=-7, max_gr=4)
def _(c):
    k = hit(c, 'fs-584941', 1.0, 0.22, 'knock on wood = hollow thunk', 70, 9000)
    s = hit(c, 'fs-669457', 1.31, 0.15, 'wood cracking = splinters', 800, 14000)
    return fade(mix(0.25, [(0, k, 0), (0.002, s, -5)]), 0.001, 0.06)
@recipe('bullet-wood-3.ogg', 'bullet_impact_wood', processing=BI_P + '; knock + splinter layer', lufs_target=-26, peak_db=-7, max_gr=4)
def _(c):
    k = rate(hit(c, 'fs-742356', 0.03, 0.17, 'single wood knock pitched x0.85', 70, 9000), 0.85)
    s = hit(c, 'fs-109359', 0.335, 0.18, 'dry branch snap = splinters', 600, 14000)
    return fade(mix(0.25, [(0, k, 0), (0.002, s, -7)]), 0.001, 0.06)
WATER = [1.07, 2.935, 4.88]
for i, t in enumerate(WATER, 1):
    def _mk(t=t, i=i):
        @recipe(f'bullet-water-{i}.ogg', 'bullet_impact_water', processing=BI_P + '; resampled x1.2 (smaller, zippier splash); HP 150 Hz', lufs_target=-26, peak_db=-7, max_gr=4)
        def _(c):
            x = rate(hit(c, 'fs-854496', t, 0.55, 'pebble thrown into a water stream', 150, 15000, 0.15, 0.03), 1.2)
            return fade(x, 0.001, 0.12)
    _mk()
RIC = [(1.855, 'fs-148827', 0.8, '.22 ricochet recorded outdoors'), (2.93, 'fs-148827', 0.8, '.22 ricochet recorded outdoors'),
       (0.99, 'fs-30932', 0.6, 'simulated ricochet whine')]
for i, (t, n, d, note) in enumerate(RIC, 1):
    def _mk(t=t, n=n, d=d, note=note, i=i):
        @recipe(f'ricochet-{i}.ogg', 'bullet_ricochet', processing=BI_P + '; HP 400 Hz', lufs_target=-26, peak_db=-7, max_gr=4)
        def _(c): return hit(c, n, t, d, note, 400, 16000, 0.25)
    _mk()

# ================================================================ hull hits
HH_P = 'HP 25 Hz; onset trimmed; crack + deep clang (resampled down) + crunch + stress groan (resampled ring) + sub thump'
def hull_heavy(c, k):
    crack = hp(ev(c, 'fs-336011', 0.0, 0.3, 'crack, HP 700 Hz'), 700)
    if k == 1:
        clang = rate(ev(c, 'fs-547979', 13.43, 1.4, 'sheet-metal bang pitched x0.5 = armour clang'), 0.5)
        crunch = ev(c, 'fs-562198', 0.0, 1.3, 'metal smash = crunch')
        blast = decay_after(trim_onset(clean(ev(c, 'fs-182432', 1.13, 0.26, 'blast core (US gov. video audio)')), .05), 0.05, 0.1)
    else:
        clang = rate(ev(c, 'fs-406197', 0.28, 1.8, 'heavy metal door slam pitched x0.7 = armour clang'), 0.7)
        crunch = rate(ev(c, 'fs-587443', 0.04, 1.2, 'scrap metal crash x0.7 = crunch'), 0.7)
        blast = decay_after(trim_onset(clean(ev(c, 'fs-843248', 0.0, 0.5, 'small explosion (burning car)')), .05), 0.05, 0.1)
    groan = lp(rate(ev(c, 'fs-386798', 0.95, 1.7, 'metal collision ringing tail pitched x0.45 = stress groan'), 0.45), 2000)
    return [(0, trim_onset(crack, .05), -3), (0.002, trim_onset(clang, .05), 0), (0.004, trim_onset(crunch, .05), -5),
            (0, blast, -6), (0.12, fade(groan, 0.15, 0.6), -11), (0, thump(0.4, 110, 45, 0.09), -5)]
@recipe('hull-hit-heavy-1.ogg', 'hull_hit_heavy', processing=HH_P, variant='exterior')
def _(c): return fade(mix(1.9, hull_heavy(c, 1)), 0.001, 0.5), dict(synth=SYN_THUMP)
@recipe('hull-hit-heavy-2.ogg', 'hull_hit_heavy', processing=HH_P, variant='exterior')
def _(c): return fade(mix(1.9, hull_heavy(c, 2)), 0.001, 0.5), dict(synth=SYN_THUMP)
def hull_int(c, k):
    y = fade(lp(mix(1.9, hull_heavy(c, k)), 900), 0, 0.45); y = shelf(y, 90, 4)
    if k == 1: r = ev(c, 'fs-378670', 0.0, 1.5, 'falling scrap = interior rattle')
    else: r = ev(c, 'fs-587443', 2.54, 1.5, 'scrap metal clatter = interior rattle')
    r = lp(hp(r, 900), 6000)
    return fade(mix(2.0, [(0, y, 0), (0.07, fade(r, 0.02, 0.6), -12)]), 0.001, 0.5)
@recipe('hull-hit-heavy-int-1.ogg', 'hull_hit_heavy', processing=HH_P + '; interior: LP 900 Hz + low shelf +4 dB @90 Hz (muffled bang); rattle layer band 0.9-6 kHz', variant='interior (self)')
def _(c): return hull_int(c, 1), dict(synth=SYN_THUMP)
@recipe('hull-hit-heavy-int-2.ogg', 'hull_hit_heavy', processing=HH_P + '; interior: LP 900 Hz + low shelf +4 dB @90 Hz (muffled bang); rattle layer band 0.9-6 kHz', variant='interior (self)')
def _(c): return hull_int(c, 2), dict(synth=SYN_THUMP)

SA_P = 'onset trimmed; HP 250 Hz; short cosine tail'
@recipe('hull-hit-small-1.ogg', 'hull_hit_small_arms', processing=SA_P, lufs_target=-25, peak_db=-6, max_gr=4, variant='armour ping')
def _(c): return hit(c, 'fs-351371', 0.02, 0.4, 'metal ping made as bullet off armour', 250, 16000, 0.15)
@recipe('hull-hit-small-2.ogg', 'hull_hit_small_arms', processing=SA_P, lufs_target=-25, peak_db=-6, max_gr=4, variant='armour ping')
def _(c): return hit(c, 'fs-182263', 0.11, 0.26, 'foley bullet hit metal', 250, 16000, 0.1)
@recipe('hull-hit-small-3.ogg', 'hull_hit_small_arms', processing=SA_P + '; ricochet whine layer', lufs_target=-25, peak_db=-6, max_gr=4, variant='armour ricochet')
def _(c):
    a = hit(c, 'fs-182263', 7.285, 0.3, 'foley bullet hit metal', 250, 16000, 0.1)
    w = hp(ev(c, 'fs-30932', 1.625, 0.6, 'ricochet whine (simulated)'), 1500)
    return fade(mix(0.7, [(0, a, 0), (0.02, fade(trim_onset(w, .05), 0.02, 0.3), -5)]), 0.001, 0.15)
@recipe('hull-hit-small-4.ogg', 'hull_hit_small_arms', processing=SA_P + '; declip', lufs_target=-25, peak_db=-6, max_gr=4, variant='jeep sheet metal')
def _(c): return hit(c, 'fs-399550', 0.12, 0.6, 'bullet hits a car body', 150, 16000, 0.25)
@recipe('hull-hit-small-5.ogg', 'hull_hit_small_arms', processing=SA_P + '; declip', lufs_target=-25, peak_db=-6, max_gr=4, variant='jeep sheet metal')
def _(c): return hit(c, 'fs-399550', 1.75, 0.6, 'bullet hits a car body', 150, 16000, 0.25)

# ================================================================ explosion on water
WS_P = 'HP 30 Hz; onset trimmed; boom + geyser whoosh + splash-down layers; cosine fade-out'
@recipe('explosion-water-1.ogg', 'explosion_water_splash', processing=WS_P, variant='Navy sea-mine detonation + splash-down')
def _(c):
    x = fade(trim_onset(declip(clean(ev(c, 'yt-27Ia83p6rA4', 0.2, 3.4, 'real underwater mine detonation, water column'))), 0.05), 0, 0.8)
    spl = ev(c, 'fs-442773', 0.0, 2.2, 'big water splash = column falling back')
    rain = ev(c, 'fs-682165', 2.0, 3.0, 'pebbles plopping into a pond = droplet rain')
    y = mix(4.2, [(0, x, 0), (0, thump(0.9, 60, 30, 0.25), -6), (1.0, fade(spl, 0.15, 0.6), -7), (1.8, fade(rain, 0.3, 1.0), -16)])
    return fade(y, 0.001, 0.9), dict(synth=SYN_THUMP)
@recipe('explosion-water-2.ogg', 'explosion_water_splash', processing=WS_P + '; boom LP 1.2 kHz (water-damped)', variant='muffled boom + geyser whoosh + splash rain')
def _(c):
    boom = lp(trim_onset(declip(clean(ev(c, 'fs-182429', 0.0, 1.75, 'blast (US gov. video audio)'))), .05), 1200)
    gey = ev(c, 'fs-442773', 0.0, 2.2, 'big water splash = geyser')
    s1 = ev(c, 'fs-637974', 0.50, 1.2, 'big hand-slap splash')
    s2 = ev(c, 'fs-637974', 5.76, 1.2, 'big hand-slap splash')
    rain = ev(c, 'fs-682165', 5.0, 3.0, 'pebbles into pond = droplet rain')
    y = mix(4.0, [(0, boom, 0), (0, thump(0.9, 62, 30, 0.22), -4), (0.02, fade(gey, 0.04, 0.6), -3),
                   (0.9, s1, -9), (1.25, s2, -11), (1.4, fade(rain, 0.3, 1.0), -15)])
    return fade(y, 0.001, 0.9), dict(synth=SYN_THUMP)
