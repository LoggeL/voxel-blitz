"""Per-file recipes. Each returns mono float64 at 48 kHz; build.py normalizes/encodes/records."""
import numpy as np
from dsp import *
from scipy import signal

def thump(dur=0.5, f0=70, f1=38, decay=0.12, seed=0):
    """Original synthesized sub thump: pitch-dropping sine with exponential decay."""
    t = np.arange(int(dur*SR)) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.06)
    return np.sin(2*np.pi*np.cumsum(f)/SR) * np.exp(-t/decay) * (1 - np.exp(-t/0.002))

# ---------------- tank engine ----------------
@recipe('tank-engine-idle.ogg', 'tank_engine_loop', loop=True,
        processing='mono; HP 22 Hz / LP 9 kHz (zero-phase); 7 s loop with 250 ms equal-power overlap; loudness-normalized')
def _(c):
    x = c.seg('fs-161897', 18.0, 26.0, 'steady Leopard 2A4 idle')
    x = lp(hp(x, 22, zero=True), 9000, zero=True)
    return make_loop(x, 7.0, 0.25)

@recipe('tank-engine-rev.ogg', 'tank_engine_loop', loop=True,
        processing='mono; diesel bed HP 22 Hz / LP 9 kHz; turbine whine layer HP 700 Hz at -11 dB; 6 s loop, 250 ms equal-power overlap; loudness-normalized')
def _(c):
    a = c.seg('fs-572294', 28.75, 35.35, 'steadiest high-load tank engine section')
    b = c.seg('fs-542582', 10.0, 16.6, 'M1A1 gas-turbine whine layer, HP 700 Hz, -11 dB')
    x = lp(hp(a, 22, zero=True), 9000, zero=True) / (np.std(a)+1e-9)
    w = hp(b, 700, zero=True); w = w / (np.std(w)+1e-9) * 0.28
    n = min(len(x), len(w)); return make_loop(x[:n] + w[:n], 6.0, 0.25)

# ---------------- tank tracks ----------------
@recipe('tank-tracks.ogg', 'tank_tracks_loop', loop=True,
        processing='mono; HP 160 Hz (removes engine rumble, keeps clank/rattle) / LP 10 kHz zero-phase; level-flattened with 1.5 s RMS; 4.5 s loop, 200 ms overlap')
def _(c):
    x = c.seg('fs-386590', 50.0, 55.0, 'close track pass, link clank ~5 Hz')
    x = lp(hp(x, 160, zero=True), 10000, zero=True)
    e = np.sqrt(np.convolve(x**2, np.ones(SR*3//2)/(SR*3//2), 'same')); x = x / (e/np.median(e))
    return make_loop(x, 4.5, 0.2)

@recipe('tank-tracks-pivot.ogg', 'tank_tracks_loop', loop=True,
        processing='mono; band 500 Hz-6 kHz with +5 dB peak at 2.2 kHz (squeal/creak emphasis), level-flattened; 4 s loop, 200 ms overlap')
def _(c):
    x = c.seg('fs-386661', 66.0, 70.5, 'tracks creaking on terrain')
    x = peq(bp(x, 500, 6000, zero=True), 2200, 5, 0.9)
    e = np.sqrt(np.convolve(x**2, np.ones(SR)/SR, 'same')); x = x / (e/np.median(e))
    return make_loop(x, 4.0, 0.2)

# ---------------- turret ----------------
@recipe('tank-turret-traverse.ogg', 'tank_turret_traverse', loop=True,
        processing='mono; HP 60 Hz / LP 7 kHz; 3 s loop, 150 ms overlap (gate/soft-start in code)')
def _(c):
    x = c.seg('fs-607310', 12.0, 15.5, 'steady pitched-down motor whine')
    return make_loop(lp(hp(x, 60, zero=True), 7000, zero=True), 3.0, 0.15)

@recipe('tank-turret-stop.ogg', 'tank_turret_traverse',
        processing='motor spin-down tail HP 60 Hz; stop clunk = printer mechanism hit pitched down x0.5, LP 3 kHz; 2 ms in / 150 ms out')
def _(c):
    s = c.seg('fs-607310', 49.0, 50.4, 'motor spin-down')
    k = c.seg('fs-418882', 0.27, 0.52, 'mechanical clunk, pitched down an octave')
    s = hp(s, 60); s = s * np.linspace(1, 0.0, len(s))**1.5
    k = lp(rate(k, 0.5), 3000); k = norm_peak(k, 1.0)
    y = place(int(1.25*SR), [(0, s/np.abs(s).max()*0.45, 1), (0.32, k, 1), (0.32, thump(0.25, 120, 60, 0.05), 0.35)])
    return fade(y, 0.002, 0.15)

# ---------------- cannon ----------------
def cannon_near(c, t0, dur=3.2, note=''):
    x = c.seg('fs-189344', t0 - 0.01, t0 + dur, note or 'tank shot, near, with range slapback tail')
    x = declip(x); x = lp(hp(x, 25), 11000)
    x = trim_onset(x, 0.05)
    y = x + 0.55 * np.abs(x).max() * place(len(x), [(0.0, thump(0.6, 75, 40, 0.13), 1)])
    return fade(y, 0.001, 0.6)
@recipe('tank-cannon-near-1.ogg', 'tank_cannon_fire', processing='declipped (cubic spline over clipped runs); HP 25 Hz / LP 11 kHz; onset trimmed; + synthesized 75->40 Hz sub thump at -5 dB; 600 ms fade-out')
def _(c): return cannon_near(c, 21.305, 2.7)
@recipe('tank-cannon-near-2.ogg', 'tank_cannon_fire', processing='declipped; HP 25 Hz / LP 11 kHz; onset trimmed; + synthesized sub thump; 600 ms fade-out')
def _(c): return cannon_near(c, 28.56, 3.0)
@recipe('tank-cannon-near-3.ogg', 'tank_cannon_fire', processing='declipped; HP 25 Hz / LP 11 kHz; onset trimmed; + synthesized sub thump; 600 ms fade-out')
def _(c): return cannon_near(c, 14.665, 3.2)
@recipe('tank-cannon-distant.ogg', 'tank_cannon_fire', processing='declipped; LP 700 Hz 4th order + low shelf +4 dB @120 Hz (no crack); 30 ms soft attack; 3.4 s with 900 ms fade')
def _(c):
    x = c.seg('fs-184275', 9.0, 11.95, 'distant shot with echo tail')
    x = lp(declip(x), 700); x = shelf(x, 120, 4)
    x = trim_onset(x, 0.05, 0.0)
    return fade(x, 0.03, 0.9)
@recipe('tank-cannon-interior.ogg', 'tank_cannon_fire', processing='self/interior: shot LP 600 Hz (hull-muffled) + low shelf +5 dB; breech recoil clank (pitched-down mechanism, LP 4 kHz) at 90 ms; sub thump; 400 ms fade')
def _(c):
    x = c.seg('fs-189344', 3.82, 6.3, 'shot, heavily muffled for interior perspective')
    x = shelf(lp(declip(x), 600), 90, 5); x = trim_onset(x, 0.05); x = norm_peak(x, 1)
    k = c.seg('fs-418882', 0.27, 0.52, 'breech/recoil clank layer, pitched x0.6')
    k = norm_peak(lp(rate(k, 0.6), 4000), 0.55)
    y = place(len(x), [(0, x, 1), (0.09, k, 1), (0.0, thump(0.7, 60, 32, 0.18), 0.8)])
    return fade(y, 0.001, 0.4)

# ---------------- vehicle machine guns (single-shot round robin) ----------------
def mg_shot(c, name, t0, t1, note, hpf=60, lpf=12000, fout=0.12):
    x = c.seg(name, t0 - 0.004, t1, note)
    x = lp(hp(declip(x), hpf), lpf); x = trim_onset(x, 0.08)
    return fade(x, 0.001, fout)
P_MG = 'declipped; HP 60 Hz / LP 12 kHz; onset trimmed to the shot transient; last shot of a burst so the tail is natural; 120 ms fade-out'
@recipe('hmg50-shot-1.ogg', 'vehicle_mg_fire', processing=P_MG)
def _(c): return mg_shot(c, 'fs-239138', 0.515, 1.06, '.50 cal, last shot of burst 1')
@recipe('hmg50-shot-2.ogg', 'vehicle_mg_fire', processing=P_MG)
def _(c): return mg_shot(c, 'fs-239138', 1.795, 2.45, '.50 cal, last shot of burst 2')
@recipe('hmg50-shot-3.ogg', 'vehicle_mg_fire', processing=P_MG)
def _(c): return mg_shot(c, 'fs-239138', 3.295, 3.68, '.50 cal, last shot of burst 3')
P_COAX = 'HP 90 Hz / LP 12 kHz; onset trimmed; tighter 7.62 report; fade-out'
@recipe('coax762-shot-1.ogg', 'vehicle_mg_fire', processing=P_COAX)
def _(c): return mg_shot(c, 'fs-482122', 1.340, 1.56, '7.62 MG, last shot of burst', hpf=90, fout=0.08)
@recipe('coax762-shot-2.ogg', 'vehicle_mg_fire', processing=P_COAX)
def _(c): return mg_shot(c, 'fs-482121', 1.105, 1.188, '7.62 MG, mid-burst dry shot', hpf=90, fout=0.025)
@recipe('coax762-shot-3.ogg', 'vehicle_mg_fire', processing=P_COAX + '; dry mid-burst shot cut before the next round (82 ms)')
def _(c): return mg_shot(c, 'fs-482122', 0.995, 1.077, '7.62 MG, mid-burst dry shot', hpf=90, fout=0.025)

# ---------------- door minigun / jet cannon ----------------
@recipe('door-minigun-loop.ogg', 'door_minigun_and_jet_cannon', loop=True,
        processing='M134 continuous fire; HP 50 Hz / LP 13 kHz zero-phase; 3 s loop, 120 ms equal-power overlap')
def _(c):
    x = c.seg('fs-165042', 10.0, 13.4, 'steady M134 fire 4 ft from gun')
    return make_loop(lp(hp(declip(x), 50, zero=True), 13000, zero=True), 3.0, 0.12)
@recipe('door-minigun-spindown.ogg', 'door_minigun_and_jet_cannon',
        processing='last 250 ms of fire into barrel/motor spin-down; HP 50 Hz; 5 ms fade-in, 200 ms fade-out')
def _(c):
    x = c.seg('fs-165042', 31.05, 32.7, 'end of burst, spin-down')
    return fade(lp(hp(declip(x), 50), 13000), 0.005, 0.2)
@recipe('jet-cannon-burst.ogg', 'door_minigun_and_jet_cannon',
        processing='M61A1 20 mm (Phalanx CIWS, U.S. Navy): 60 ms motor spin-up plus the first 1.35 s of fire spliced (90 ms equal-power) onto the final 0.25 s of fire and the natural 1.3 s tail; HP 35 Hz; low shelf +4 dB below 200 Hz; 500 ms fade-out')
def _(c):
    # License fix 2026-10-08: replaces Freesound 611449 (CC0 label contradicted by the uploader's non-commercial terms).
    x = c.seg('yt-mlB5YtGP5LA', 36.60, 39.90, 'Phalanx 20 mm burst 3 of 4 (fire 36.68-38.58 s); middle 0.6 s of fire removed')
    x = shelf(hp(declip(x), 35), 200, 4.0, 'low')
    a, b = x[:int(1.43*SR)], x[int(1.73*SR):]
    n = int(0.09*SR); t = np.linspace(0, np.pi/2, n)
    y = np.concatenate([a[:-n], a[-n:]*np.cos(t) + b[:n]*np.sin(t), b[n:]])
    return fade(y, 0.002, 0.5)
@recipe('jet-cannon-ground.ogg', 'door_minigun_and_jet_cannon',
        processing='GAU-8 \"brrrt\" heard from the ground (A-10 gun run); declipped; HP 30 Hz / LP 9 kHz; 1.5 s with 10 ms in / 450 ms out')
def _(c):
    x = c.seg('fs-205582', 79.25, 80.75, 'A-10 cannon burst from ground perspective (first 1.5 s)')
    return fade(lp(hp(declip(x), 30), 9000), 0.01, 0.45)

# ---------------- heli chin cannon ----------------
def chin(c, t0, note):
    x = c.seg('yt-hWjXYw9eHRM', t0 - 0.01, t0 + 0.75, note)
    x = hp(declip(x), 45); x = trim_onset(x, 0.08)
    fl = np.median(env_follow(x, 10)) * 0.9
    x = gate_tail(x, fl, 0.15)
    return fade(x, 0.001, 0.25)
P_CHIN = 'US Navy MK 38 25 mm single shot; declipped; HP 45 Hz; ship ambience expanded down after 150 ms; 250 ms fade-out'
@recipe('chin-cannon-1.ogg', 'heli_chin_cannon_fire', processing=P_CHIN)
def _(c): return chin(c, 4.00, '25 mm shot 1')
@recipe('chin-cannon-2.ogg', 'heli_chin_cannon_fire', processing=P_CHIN)
def _(c): return chin(c, 6.77, '25 mm shot 3')
@recipe('chin-cannon-3.ogg', 'heli_chin_cannon_fire', processing=P_CHIN)
def _(c): return chin(c, 9.84, '25 mm shot 5')

# ---------------- synthetic cockpit tones / alarms (original synthesis, seamless by construction) ----------------
def tone(hz, dur, harmonics=((1, 1.0), (3, 0.22), (5, 0.07), (2, 0.08)), fm=None):
    t = np.arange(int(round(dur*SR))) / SR
    ph = 2*np.pi*hz*t if fm is None else 2*np.pi*np.cumsum(hz + fm)/SR
    return sum(a*np.sin(k*ph) for k, a in harmonics)
def gate(dur, rate_hz, duty=0.5, edge=0.004):
    t = np.arange(int(round(dur*SR))) / SR
    ph = (t * rate_hz) % 1.0; on = (ph < duty).astype(float)
    n = max(1, int(edge*SR)); k = np.hanning(2*n); k /= k.sum()
    return np.convolve(np.r_[on[-n:], on, on[:n]], k, 'same')[n:-n]
def periodic_noise(dur, seed, lo, hi):
    """Band-limited noise that is exactly periodic over dur (FFT synthesis)."""
    n = int(round(dur*SR)); rng = np.random.default_rng(seed)
    f = np.fft.rfftfreq(n, 1/SR); S = np.zeros(len(f), complex)
    m = (f >= lo) & (f <= hi); S[m] = np.exp(2j*np.pi*rng.random(m.sum()))
    x = np.fft.irfft(S, n); return x / np.abs(x).max()
P_SYN = 'original synthesis (additive soft-square, raised-cosine gates); loop length is an integer number of carrier and gate periods'
@recipe('lock-seeker-growl.ogg', 'lock_and_warning_tones', loop=True, lufs_target=-20, processing=P_SYN + '; acquire: 880 Hz with periodic 15-45 Hz random FM (seeker growl), 2.5 Hz soft pulse')
def _(c):
    d = 2.0; fm = 38*periodic_noise(d, 11, 15, 45)
    x = tone(880, d, fm=fm) * (0.55 + 0.45*gate(d, 2.5, 0.6, 0.06))
    return x
@recipe('lock-seeker-locked.ogg', 'lock_and_warning_tones', loop=True, lufs_target=-20, processing=P_SYN + '; lock: steady 1320 Hz with slight 6 Hz vibrato-free shimmer (2nd/3rd harmonics)')
def _(c):
    d = 1.0; return tone(1320, d, harmonics=((1, 1), (2, 0.12), (3, 0.18), (5, 0.05)))
@recipe('lock-hull-locking.ogg', 'lock_and_warning_tones', loop=True, lufs_target=-20, processing=P_SYN + '; enemy locking: 980 Hz beeps at 4 Hz, 45 % duty')
def _(c):
    d = 1.0; return tone(980, d) * gate(d, 4, 0.45)
@recipe('lock-hull-locked.ogg', 'lock_and_warning_tones', loop=True, lufs_target=-20, processing=P_SYN + '; enemy locked: steady 1180 Hz with 8 Hz 30 % AM')
def _(c):
    d = 1.0; t = np.arange(SR)/SR; return tone(1180, d) * (0.85 + 0.15*np.cos(2*np.pi*8*t))
@recipe('lock-missile-inbound.ogg', 'lock_and_warning_tones', loop=True, lufs_target=-19, processing=P_SYN + '; missile inbound: fast 1460/1750 Hz alternating beeps at 11 Hz')
def _(c):
    d = 1.0; g = gate(d, 11, 0.5, 0.003); t = np.arange(SR)/SR
    alt = (np.floor(t*5.5) % 2)  # alternate pitch every second beep
    return (tone(1460, d)*(1-alt) + tone(1750, d)*alt) * g
@recipe('alarm-ground-klaxon.ogg', 'vehicle_damage_alarm', loop=True, lufs_target=-19, processing=P_SYN + '; ground klaxon: 310 Hz buzzy horn (odd+even harmonics, BP 300-3000 Hz) gated at 1.6 Hz')
def _(c):
    d = 2.5; h = tuple((k, 1/k**0.8) for k in range(1, 14))
    x = tone(310, d, harmonics=h) * gate(d, 1.6, 0.55, 0.01)
    return bp(np.tile(x, 3), 300, 3000, zero=True)[len(x):2*len(x)]
@recipe('alarm-air-caution.ogg', 'vehicle_damage_alarm', loop=True, lufs_target=-20, processing=P_SYN + '; aircraft master caution: double chime 1000/1250 Hz with 180 ms exponential decays, repeating every 1.25 s')
def _(c):
    d = 2.5; y = np.zeros(int(d*SR))
    for start in (0.0, 1.25):
        for k, (f, off) in enumerate(((1000, 0.0), (1250, 0.16))):
            n = int(0.6*SR); t = np.arange(n)/SR
            s = (np.sin(2*np.pi*f*t) + 0.3*np.sin(2*np.pi*2*f*t) + 0.12*np.sin(2*np.pi*3*f*t)) * np.exp(-t/0.18) * (1-np.exp(-t/0.002))
            i = int((start+off)*SR); y[i:i+n] += s[:len(y)-i]
    return y

def flatten(x, win=1.5):
    n = int(win*SR); e = np.sqrt(np.convolve(np.r_[x[:n][::-1], x, x[-n:][::-1]]**2, np.ones(n)/n, 'same')[n:-n])
    return x / (e / np.median(e))
# ---------------- helicopters ----------------
@recipe('heli-rotor-ext.ogg', 'helicopter_rotor_loop', loop=True,
        processing='AH-64 close pass, steadiest section; HP 25 Hz / LP 11 kHz zero-phase; 1.5 s RMS level-flattening (removes pass-by swell); 6 s loop, 300 ms equal-power overlap')
def _(c):
    x = c.seg('fs-645371', 18.0, 24.6, 'two AH-64 Apaches, close section')
    return make_loop(flatten(lp(hp(x, 25, zero=True), 11000, zero=True)), 6.0, 0.3)
@recipe('heli-rotor-distant.ogg', 'helicopter_rotor_loop', loop=True,
        processing='far AH-64 hovering; LP 500 Hz 4th order (low blade thump only) + HP 25 Hz; level-flattened; 6 s loop, 300 ms overlap')
def _(c):
    x = c.seg('fs-734126', 4.0, 10.6, 'AH-64 at distance, before the close approach')
    return make_loop(flatten(lp(hp(x, 25, zero=True), 500, zero=True)), 6.0, 0.3)
@recipe('heli-cockpit.ogg', 'helicopter_rotor_loop', loop=True,
        processing='helicopter interior; HP 30 Hz / LP 7 kHz zero-phase; +3 dB low shelf at 90 Hz (rotor pressure); 6 s loop, 300 ms overlap')
def _(c):
    x = c.seg('fs-702748', 20.0, 26.6, 'steady interior cruise')
    x = shelf(lp(hp(x, 30, zero=True), 7000, zero=True), 90, 3)
    return make_loop(x, 6.0, 0.3)
@recipe('transport-cabin.ogg', 'transport_rotor_loop', loop=True,
        processing='UH-1Y cabin at the open-door gunner station (turbine whine + door wind); HP 30 Hz / LP 10 kHz; 6 s loop, 300 ms overlap')
def _(c):
    x = c.seg('yt-6tnUDX0WT8Q', 8.0, 14.6, 'UH-1Y cabin before the gun fires (US Navy / USMC footage, public domain)')
    return make_loop(lp(hp(x, 30, zero=True), 10000, zero=True), 6.0, 0.3)

@recipe('transport-rotor-ext.ogg', 'transport_rotor_loop', loop=True,
        processing='UH-1 Huey hover/idle at close range (blade "wop-wop"); HP 25 Hz / LP 10 kHz zero-phase; 1.5 s level-flattening; 6 s loop, 300 ms overlap')
def _(c):
    x = c.seg('fs-157722', 70.0, 76.6, 'UH-1 rotor at speed, close')
    return make_loop(flatten(lp(hp(x, 25, zero=True), 10000, zero=True)), 6.0, 0.3)
def xsplice(a, b, X):
    n = int(X*SR); t = np.linspace(0, np.pi/2, n)
    return np.concatenate([a[:-n], a[-n:]*np.cos(t) + b[:n]*np.sin(t), b[n:]])
@recipe('rotor-spool-up.ogg', 'rotor_spool_up_down',
        processing='UH-1 turbine light-off whine sweep (2.0-4.6 s, gain ramp -10 dB -> matched) spliced with 900 ms equal-power overlap onto the rotor at near full speed (18.0-20.5 s); fits the ~1.2 s in-game rotor ramp; HP 25 Hz; 150 ms in / 800 ms out')
def _(c):
    a = hp(c.seg('fs-157722', 2.0, 4.6, 'ignition, turbine whine sweep'), 25); b = hp(c.seg('fs-157722', 18.0, 20.5, 'rotor near full speed'), 25)
    n = int(0.9*SR); ra = np.sqrt(np.mean(a[-n:]**2)); rb = np.sqrt(np.mean(b[:n]**2))
    a = a * (rb/ra) * np.geomspace(10**(-10/20), 1, len(a))
    return fade(xsplice(a, b, 0.9), 0.15, 0.8)
@recipe('rotor-spool-down.ogg', 'rotor_spool_up_down',
        processing='AB 412 engine shut-down, turbine whine falling and blades slowing (interior perspective); 6.6 s to suit the ~2 s in-game rotor run-down; HP 25 Hz / LP 9 kHz; 200 ms in / 2.2 s out')
def _(c):
    x = c.seg('fs-324971', 191.0, 197.6, 'engine shut-down and rotor run-down')
    return fade(lp(hp(x, 25), 9000), 0.2, 2.2)

# ---------------- jets ----------------
@recipe('jet-engine-ext.ogg', 'jet_engine_loop', loop=True,
        processing='jet engine ground run at high power (low rumble + whine); HP 30 Hz / LP 14 kHz zero-phase; 5 s loop, 250 ms overlap')
def _(c):
    x = c.seg('fs-205581', 20.0, 25.4, 'steady high-power engine run (US government video, public domain)')
    return make_loop(lp(hp(declip(x), 30, zero=True), 14000, zero=True), 5.0, 0.25)
@recipe('jet-engine-ext-low.ogg', 'jet_engine_loop', loop=True,
        processing='same engine after throttling back (lower whine); HP 30 Hz / LP 12 kHz zero-phase; 3.5 s loop, 250 ms overlap')
def _(c):
    x = c.seg('fs-205581', 63.2, 67.0, 'reduced-power engine run')
    return make_loop(lp(hp(declip(x), 30, zero=True), 12000, zero=True), 3.5, 0.25)
@recipe('jet-afterburner-lightoff.ogg', 'jet_afterburner',
        processing='turbojet afterburner light-off: onset thump and first 2 s of roar; HP 30 Hz; 1 ms in / 800 ms out')
def _(c):
    x = c.seg('fs-413312', 0.0, 2.3, 'afterburner ignition')
    return fade(trim_onset(hp(x, 30), 0.05), 0.001, 0.8)
@recipe('jet-afterburner-loop.ogg', 'jet_afterburner', loop=True,
        processing='Eurofighter afterburner climb, crackling peak; HP 60 Hz / LP 12 kHz zero-phase; 1 s level-flattening; 3.5 s loop, 250 ms overlap')
def _(c):
    x = c.seg('fs-162242', 10.3, 14.1, 'afterburner crackle at closest point')
    return make_loop(flatten(lp(hp(declip(x), 60, zero=True), 12000, zero=True), 1.0), 3.5, 0.25)
P_FLY = 'mono; HP 30 Hz / LP 14 kHz; fades shaped so the pass builds and recedes'
@recipe('jet-flyby-1.ogg', 'jet_flyby', processing=P_FLY + '; tanh soft-limit (drive 2.5) on the crackle peak; 9.5 s, 1 s in / 2.5 s out')
def _(c):
    x = c.seg('fs-640505', 1.0, 10.5, 'Eurofighter Typhoon close flyby')
    return fade(soft(norm_peak(lp(hp(x, 30), 14000)), 2.5), 1.0, 2.5)
@recipe('jet-flyby-2.ogg', 'jet_flyby', processing=P_FLY + '; 10 s from the approach build-up through the overhead pass, 1.5 s in / 3 s out')
def _(c):
    x = c.seg('fs-324370', 5.5, 15.5, 'F-15 overhead pass')
    return fade(lp(hp(declip(x), 30), 14000), 1.5, 3.0)
@recipe('jet-flyby-3.ogg', 'jet_flyby', processing=P_FLY + '; 10 s low pass, 1.2 s in / 3 s out')
def _(c):
    x = c.seg('fs-851222', 22.0, 32.0, 'fighter low pass over desert')
    return fade(lp(hp(x, 30), 14000), 1.2, 3.0)

# ---------------- rocket pods / AA missiles ----------------
def rpg(c, t0, note):
    x = c.seg('fs-249298', t0 - 0.01, t0 + 1.7, note)
    x = trim_onset(hp(declip(x), 40), 0.06)
    return fade(x, 0.001, 0.6)
P_POD = 'single rocket: ignition pop + short tearing whoosh; declipped; HP 40 Hz; onset trimmed; 600 ms fade-out (engine fires one per pod rocket)'
@recipe('rocket-pod-1.ogg', 'rocket_pod_launch', processing=P_POD)
def _(c): return rpg(c, 0.105, 'launcher firing 1')
@recipe('rocket-pod-2.ogg', 'rocket_pod_launch', processing=P_POD)
def _(c): return rpg(c, 3.95, 'launcher firing 2')
@recipe('rocket-pod-3.ogg', 'rocket_pod_launch', processing=P_POD + '; pitched x1.08 for variety')
def _(c): return rate(rpg(c, 7.865, 'launcher firing 3'), 1.08)
@recipe('aa-missile-launch-1.ogg', 'aa_missile_launch_and_flight',
        processing='ignition bang and long rocket-motor whoosh (US government video, public domain); declipped; HP 35 Hz / LP 13 kHz; onset trimmed; 1.2 s fade-out')
def _(c):
    x = c.seg('fs-182794', 0.56, 6.6, 'rocket launch 1')
    return fade(trim_onset(lp(hp(declip(x), 35), 13000), 0.06), 0.001, 1.2)
@recipe('aa-missile-launch-2.ogg', 'aa_missile_launch_and_flight',
        processing='second launch take (ignition + motor run); declipped; HP 35 Hz / LP 13 kHz; onset trimmed; 1.5 s fade-out')
def _(c):
    x = c.seg('fs-182794', 7.25, 13.5, 'rocket launch 2')
    return fade(trim_onset(lp(hp(declip(x), 35), 13000), 0.06), 0.001, 1.5)
@recipe('aa-missile-flight.ogg', 'aa_missile_launch_and_flight', loop=True,
        processing='sustained rocket-motor thrust; HP 50 Hz / LP 12 kHz zero-phase; 1 s level-flattening; 3 s loop, 200 ms overlap (Doppler applied by playbackRate in game)')
def _(c):
    x = c.seg('fs-515122', 20.0, 23.4, 'steady thrust section')
    return make_loop(flatten(lp(hp(x, 50, zero=True), 12000, zero=True), 1.0), 3.0, 0.2)

# ---------------- shell flyby ----------------
@recipe('shell-flyby-ap.ogg', 'tank_shell_flyby',
        processing='original synthesis: N-wave sonic crack (+ground reflection 4 ms later) over a Doppler-swept band-noise whoosh (3.2 kHz -> 500 Hz), 0.9 s')
def _(c):
    n = int(0.9*SR); t = np.arange(n)/SR; rng = np.random.default_rng(7)
    w = rng.standard_normal(n)
    fc = 500 + 2700/(1 + np.exp((t - 0.16)/0.035))
    y = np.zeros(n); blk = 256
    for i in range(0, n, blk):  # time-varying bandpass, block-wise
        f = fc[i]; s = signal.butter(2, [f*0.55, min(f*1.6, 20000)], 'bandpass', fs=SR, output='sos')
        y[i:i+blk] = signal.sosfilt(s, w[max(0, i-2048):i+blk])[-len(y[i:i+blk]):]
    env = np.exp(-((t - 0.16)/0.07)**2) * (t < 0.16) + np.exp(-(t - 0.16)/0.18) * (t >= 0.16)
    y = y/np.abs(y).max()*env*0.6
    def nwave(at, amp, dur=0.0035):
        k = np.arange(int(dur*SR)); s = np.linspace(1, -1, len(k)); i = int(at*SR); y[i:i+len(k)] += amp*s
    nwave(0.15, 1.0); nwave(0.154, 0.45)
    y = lp(y, 14000)
    return fade(y, 0.002, 0.3)
@recipe('shell-incoming-he.ogg', 'tank_shell_flyby',
        processing='descending incoming-shell whistle, cut before the explosion; HP 200 Hz; 300 ms in / 120 ms out')
def _(c):
    x = c.seg('fs-170991', 0.3, 2.82, 'incoming whistle only (explosion removed)')
    return fade(hp(x, 200), 0.3, 0.12)

# ---------------- flares / smoke ----------------
def flare_salvo(c, seed, n):
    rng = np.random.default_rng(seed)
    pop = trim_onset(hp(c.seg('fs-450837', 0.04, 0.6, 'flare firing crack (each pop re-pitched)'), 80), 0.08)
    pop2 = lp(pop, 5200)  # alternate pops: same crack, darker
    wh = hp(c.seg('fs-260555', 0.0, 0.8, 'fire whoosh per flare'), 120)
    siz = c.seg('fs-674378', 0.0, 2.1, 'burning flare sizzle loop, tiled')
    L = int(3.0*SR); items = []; t = 0.0
    for k in range(n):
        p = pop if k % 2 == 0 else pop2
        items.append((t, norm_peak(rate(p, rng.uniform(0.9, 1.15))), rng.uniform(0.7, 1.0)))
        items.append((t + 0.03, norm_peak(rate(wh, rng.uniform(0.95, 1.1))), 0.35))
        t += rng.uniform(0.07, 0.12)
    sz = np.tile(norm_peak(hp(siz, 400)), 2)[:L]; sz *= np.exp(-np.arange(L)/SR/0.9) * (1 - np.exp(-np.arange(L)/SR/0.15))
    items.append((0.05, sz, 0.3))
    return fade(place(L, items), 0.001, 0.8)
P_FL = 'composited salvo: re-pitched flare-firing pops (0.9-1.15x, alternate pops LP 5.2 kHz) every 70-120 ms, fire whoosh (HP 120 Hz) per flare at -9 dB, magnesium sizzle (HP 400 Hz) decaying with 0.9 s time constant; 800 ms fade-out'
@recipe('flares-salvo-1.ogg', 'flares_countermeasure', processing=P_FL + '; 6 flares')
def _(c): return flare_salvo(c, 3, 6)
@recipe('flares-salvo-2.ogg', 'flares_countermeasure', processing=P_FL + '; 8 flares')
def _(c): return flare_salvo(c, 9, 8)
def smoke(c, t0, t1, seed):
    th = c.seg('fs-182792', t0, t1, 'grenade-launcher thumps (US government video, public domain)')
    th = lp(trim_onset(hp(declip(th), 40), 0.06), 2500)
    rng = np.random.default_rng(seed + 40); m = int(3.2*SR)
    bl = lp(hp(np.cumsum(rng.standard_normal(m)) * 0.02 + rng.standard_normal(m)*0.3, 90), 1400)  # original synthesized rushing billow
    bl = bl * np.hanning(m)**0.7
    L = len(th) + int(2.6*SR)
    return fade(place(L, [(0, norm_peak(th), 1), (len(th)/SR - 0.25, norm_peak(bl), 0.45)]), 0.001, 0.6)
P_SM = 'Mk 19 thump burst LP 2.5 kHz (mortar-like); billow = original synthesized brown/white noise mix BP 90-1400 Hz with 3.2 s Hann swell at -7 dB; 600 ms fade-out'
@recipe('smoke-launcher-1.ogg', 'tank_smoke_launcher', processing=P_SM + '; 3 thumps')
def _(c): return smoke(c, 0.86, 1.47, 1)
@recipe('smoke-launcher-2.ogg', 'tank_smoke_launcher', processing=P_SM + '; 4 thumps')
def _(c): return smoke(c, 0.64, 1.47, 2)

# ---------------- ejection / parachute ----------------
def eject(c, t0, t1, bang_t):
    bang = trim_onset(hp(declip(c.seg('fs-249298', bang_t - 0.01, bang_t + 0.25, 'explosive-bolt bang (launcher ignition crack)')), 60), 0.06)
    seat = c.seg('fs-182794', t0, t1, 'rocket motor launch whoosh as the seat rocket')
    tear = c.seg('fs-406197', 0.28, 0.9, 'heavy metal slam as canopy jettison/tear, HP 900 Hz')
    tear = hp(tear, 900)
    L = int((t1 - t0 + 0.2)*SR)
    y = place(L, [(0, norm_peak(fade(bang, 0.001, 0.12)), 1), (0.03, norm_peak(tear), 0.5), (0.12, norm_peak(hp(seat, 40)), 0.9)])
    return fade(y, 0.001, 0.6)
P_EJ = 'composite: explosive-bolt bang (launcher crack, 250 ms) + canopy tear (metal slam HP 900 Hz, -6 dB) + rocket-seat whoosh (US gov. rocket launch, first 2.4 s) at +120 ms; 600 ms fade-out'
@recipe('ejection-seat-1.ogg', 'ejection_seat', processing=P_EJ)
def _(c): return eject(c, 0.56, 3.0, 0.105)
@recipe('ejection-seat-2.ogg', 'ejection_seat', processing=P_EJ)
def _(c): return eject(c, 7.25, 9.55, 3.95)
@recipe('parachute-open-1.ogg', 'parachute_deploy_and_descent',
        processing='fabric snap/whoomp (coat foley) + synthesized 90->45 Hz whoomp at -8 dB; HP 40 Hz; 2 ms in / 400 ms out')
def _(c):
    x = trim_onset(hp(c.seg('fs-620310', 0.35, 1.6, 'canopy opening option 1'), 40), 0.05)
    return fade(x + 0.4*np.abs(x).max()*place(len(x), [(0.05, thump(0.5, 90, 45, 0.12), 1)]), 0.002, 0.4)
@recipe('parachute-open-2.ogg', 'parachute_deploy_and_descent',
        processing='fabric snap/whoomp (coat foley, option 2) pitched x0.9 + synthesized 80->40 Hz whoomp at -9 dB; HP 40 Hz; 2 ms in / 400 ms out')
def _(c):
    x = rate(trim_onset(hp(c.seg('fs-620310', 1.95, 3.3, 'canopy opening option 2'), 40), 0.05), 0.9)
    return fade(x + 0.35*np.abs(x).max()*place(len(x), [(0.05, thump(0.5, 80, 40, 0.12), 1)]), 0.002, 0.4)
@recipe('parachute-descent.ogg', 'parachute_deploy_and_descent', loop=True,
        processing='skydiver under canopy: wind + canopy flutter; HP 40 Hz / LP 9 kHz zero-phase; 1.5 s level-flattening; 5 s loop, 300 ms overlap')
def _(c):
    x = c.seg('fs-811077', 120.5, 126.0, 'descent under canopy (camcorder)')
    return make_loop(flatten(lp(hp(x, 40, zero=True), 9000, zero=True)), 5.0, 0.3)

# ---------------- hatches / doors ----------------
P_H = 'HP 40 Hz; onset trimmed; short fades'
@recipe('hatch-tank-open.ogg', 'vehicle_hatch_enter_exit', processing='heavy metal hatch unlatch + swing-open thud; ' + P_H + '; pitched x0.85 (heavier)')
def _(c):
    x = c.seg('fs-407323', 26.25, 28.3, 'heavy hatch unlatch and open')
    return fade(rate(trim_onset(hp(x, 40), 0.1, 0.01), 0.85), 0.003, 0.3)
@recipe('hatch-tank-close.ogg', 'vehicle_hatch_enter_exit', processing='heavy hatch slam (x0.85) + steel lock latch at +380 ms; ' + P_H)
def _(c):
    s = trim_onset(hp(c.seg('fs-407323', 32.35, 33.9, 'heavy hatch slam'), 40), 0.1, 0.005)
    k = trim_onset(hp(c.seg('fs-275441', 4.15, 4.75, 'automatic steel lock latch'), 150), 0.1, 0.003)
    s = norm_peak(rate(s, 0.85)); L = len(s)
    return fade(place(L, [(0, s, 1), (0.38, norm_peak(k), 0.5)]), 0.002, 0.25)
@recipe('hatch-jeep-open.ogg', 'vehicle_hatch_enter_exit', processing='Jeep Wrangler door latch and open; ' + P_H)
def _(c): return fade(trim_onset(hp(c.seg('fs-828775', 0.74, 1.75, 'door open'), 40), 0.1, 0.01), 0.003, 0.2)
@recipe('hatch-jeep-close.ogg', 'vehicle_hatch_enter_exit', processing='Jeep Wrangler door slam; ' + P_H)
def _(c): return fade(trim_onset(hp(c.seg('fs-828775', 5.12, 5.95, 'door close'), 40), 0.1, 0.005), 0.002, 0.2)
@recipe('hatch-heli-door.ogg', 'vehicle_hatch_enter_exit', processing='sliding side door run and slam shut (van door as helicopter cabin door); ' + P_H)
def _(c): return fade(hp(c.seg('fs-332853', 13.4, 16.45, 'sliding door close'), 40), 0.05, 0.2)
@recipe('hatch-canopy-close.ogg', 'vehicle_hatch_enter_exit',
        processing='canopy close: hydraulic actuator run (HP 120 Hz, 1.1 s with fades) then lock latch; 400 ms out')
def _(c):
    h = c.seg('fs-212941', 4.45, 5.75, 'hydraulic actuator run'); h = fade(trim_onset(hp(h, 120), 0.05, 0.0), 0.12, 0.2)
    k = trim_onset(hp(c.seg('fs-275441', 4.15, 4.75, 'lock latch'), 100), 0.1, 0.003)
    L = len(h) + len(k)
    return fade(place(L, [(0, norm_peak(h), 0.55), (len(h)/SR - 0.12, norm_peak(k), 1)]), 0.01, 0.15)

# ---------------- breech / feed ----------------
@recipe('breech-heavy-1.ogg', 'tank_breech_reload',
        processing='shell ram (mortar shell slide) -> breech block slam (heavy hatch slam x0.7, LP 5 kHz) at 380 ms -> lock clank (steel latch) at 700 ms; HP 40 Hz')
def _(c):
    ram = hp(c.seg('fs-854481', 0.0, 0.6, 'shell sliding into tube = ram'), 60)
    slam = lp(rate(trim_onset(hp(c.seg('fs-407323', 32.35, 33.3, 'slam as breech block'), 40), 0.1, 0.003), 0.7), 5000)
    lock = trim_onset(hp(c.seg('fs-275441', 4.15, 4.75, 'lock clank'), 150), 0.1, 0.003)
    y = place(int(1.45*SR), [(0, norm_peak(ram), 0.5), (0.38, norm_peak(slam), 1), (0.38, thump(0.3, 110, 55, 0.06), 0.35), (0.70, norm_peak(lock), 0.6)])
    return fade(y, 0.005, 0.3)
@recipe('breech-heavy-2.ogg', 'tank_breech_reload',
        processing='breech slam (big metal door close, first 0.7 s, LP 6 kHz) + M2 charging-handle clack x0.7 at 250 ms; HP 40 Hz')
def _(c):
    slam = lp(trim_onset(hp(c.seg('fs-406197', 0.28, 1.0, 'big metal door slam as breech'), 40), 0.1, 0.003), 6000)
    clk = trim_onset(hp(c.seg('fs-737219', 0.03, 0.45, 'M2 chamber cock'), 80), 0.1, 0.002)
    y = place(int(1.0*SR), [(0, norm_peak(slam), 1), (0.25, norm_peak(rate(clk, 0.7)), 0.55)])
    return fade(y, 0.003, 0.3)
@recipe('feed-tray-clack.ogg', 'tank_breech_reload',
        processing='light feed-tray / charging clack for coax and HMG: Browning M2 chamber cock; HP 80 Hz; onset trimmed; 120 ms out')
def _(c):
    return fade(trim_onset(hp(c.seg('fs-737219', 0.03, 0.75, 'M2 chamber cock'), 80), 0.1, 0.002), 0.002, 0.12)

# ---------------- burning / water ----------------
@recipe('vehicle-burning-1.ogg', 'vehicle_burning_loop', loop=True,
        processing='car fire roar and crackle; HP 40 Hz / LP 12 kHz zero-phase; 6 s loop, 300 ms overlap')
def _(c):
    x = c.seg('fs-563765', 4.0, 10.6, 'car on fire, steady')
    return make_loop(lp(hp(x, 40, zero=True), 12000, zero=True), 6.0, 0.3)
@recipe('vehicle-burning-2.ogg', 'vehicle_burning_loop', loop=True,
        processing='car fire roar and crackle, later section (variant 2); HP 40 Hz / LP 12 kHz zero-phase; 6 s loop, 300 ms overlap')
def _(c):
    x = c.seg('fs-563765', 10.8, 17.4, 'car on fire, later section')
    return make_loop(lp(hp(x, 40, zero=True), 12000, zero=True), 6.0, 0.3)
@recipe('vehicle-wade-loop.ogg', 'vehicle_water_wade', loop=True,
        processing='car through a ford, peak section; HP 60 Hz / LP 12 kHz zero-phase; 1 s level-flattening; 2.6 s loop, 200 ms overlap')
def _(c):
    x = c.seg('fs-335622', 3.6, 6.4, 'water churn as the car crosses the ford')
    return make_loop(flatten(lp(hp(x, 60, zero=True), 12000, zero=True), 1.0), 2.6, 0.2)
@recipe('vehicle-wade-splash.ogg', 'vehicle_water_wade',
        processing='entry splash/surge of a car through a ford; HP 60 Hz; 150 ms in / 700 ms out')
def _(c):
    x = c.seg('fs-194967', 21.0, 24.4, 'ford crossing splash peak')
    return fade(hp(x, 60), 0.15, 0.7)

# ---------------- jeep ----------------
@recipe('jeep-engine-idle.ogg', 'jeep_engine_loop', loop=True,
        processing='diesel 4x4 idle; HP 25 Hz / LP 10 kHz zero-phase; 4 s loop, 200 ms overlap')
def _(c):
    x = c.seg('fs-840649', 0.3, 4.6, 'Jeep Grand Cherokee diesel idle')
    return make_loop(lp(hp(x, 25, zero=True), 10000, zero=True), 4.0, 0.2)
@recipe('jeep-engine-drive.ogg', 'jeep_engine_loop', loop=True,
        processing='diesel 4x4 (Toyota Hilux) held high rev; HP 30 Hz / LP 10 kHz zero-phase; 1.5 s level-flattening; 6 s loop, 300 ms overlap')
def _(c):
    x = c.seg('fs-379914', 50.0, 56.6, 'Hilux diesel held rev')
    return make_loop(flatten(lp(hp(x, 30, zero=True), 10000, zero=True)), 6.0, 0.3)
@recipe('jeep-tyres-gravel.ogg', 'jeep_tyres_offroad_loop', loop=True,
        processing='tyres rolling on gravel (no engine); HP 120 Hz / LP 11 kHz zero-phase; 1 s level-flattening; 4 s loop, 200 ms overlap')
def _(c):
    x = c.seg('fs-251662', 6.0, 10.4, 'trailer tyres on gravel path')
    return make_loop(flatten(lp(hp(x, 120, zero=True), 11000, zero=True), 1.0), 4.0, 0.2)
@recipe('jeep-suspension-rattle.ogg', 'jeep_tyres_offroad_loop', loop=True,
        processing='onboard rough-terrain rattles; HP 350 Hz (suppresses engine) / LP 9 kHz zero-phase; 1 s level-flattening; 4 s loop, 200 ms overlap')
def _(c):
    x = c.seg('fs-451044', 12.0, 16.4, 'onboard rough dirt/rock terrain')
    return make_loop(flatten(lp(hp(x, 350, zero=True), 9000, zero=True), 1.0), 4.0, 0.2)
@recipe('jeep-skid-gravel.ogg', 'jeep_tyres_offroad_loop',
        processing='optional hard-turn skid one-shot: brake skid on gravel; HP 80 Hz; 20 ms in / 200 ms out')
def _(c): return fade(hp(c.seg('fs-637161', 0.0, 1.1, 'gravel skid'), 80), 0.02, 0.2)
