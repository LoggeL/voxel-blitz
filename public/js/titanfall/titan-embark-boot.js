// The titan hatch close and cockpit boot on embark, and the hatch opening on exit (docs/titanfall.md
// §7.2, Embark and disembark; references docs/design/titanfall/embark/, chosen: A). Presentation only:
// a pure timeline over the seconds since the authoritative `titan_embark` / `titan_disembark` event,
// read by titan-cockpit-fx.js (plates, glass screen, power, banner) and titan-transit.js (clunks, shake).
//
// Embark: once the camera drops into the seat, three armour plates close the viewport: two from the
// left (upper, then lower) and one from the right whose pointed edge meets them in a Y seam. They lock
// as the server's embark lock ends (the seams flash, sparks, one shake), the cabin goes dark for a
// moment, then the closed hatch's inside comes on as a screen: a bright line across the middle opens
// into the outside camera feed (tinted, scanlines, settling), and the MFDs, the strut pods and the glass
// HUD come up one after another while the glass reads NEURAL LINK, then LINK ESTABLISHED / PILOT ONLINE.
// Exit: the screen cuts out and the plates part in reverse order before the camera leaves.
// Reduced motion: no plates, no line, no flicker; the glass dims and fades back in.
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';

const LOCK = TITAN_RULES.embark.animMs / 1000 + 0.06;   // the server's embark lock plus the presentation delay

/** Seconds since the embark (or exit) event. */
export const EMBARK_BOOT = Object.freeze({
  lock: LOCK,
  // [start, home] per plate: upper left, lower left (both from the left), right (from the right).
  plates: Object.freeze([Object.freeze([LOCK - 0.3, LOCK - 0.12]), Object.freeze([LOCK - 0.24, LOCK - 0.06]), Object.freeze([LOCK - 0.18, LOCK])]),
  settle: 0.09,                                     // s the plates rock after they hit home
  seams: Object.freeze([LOCK, LOCK + 0.3]),        // seam flash
  screen: Object.freeze([LOCK + 0.14, LOCK + 0.5]), // locked and dark until the start, then the power-on
  keys: Object.freeze([LOCK + 0.14, LOCK + 0.26]),
  screens: Object.freeze([LOCK + 0.26, LOCK + 0.44]),
  pods: Object.freeze([LOCK + 0.36, LOCK + 0.56]),
  glassHud: Object.freeze([LOCK + 0.5, LOCK + 0.74]),
  band: Object.freeze([LOCK + 0.42, LOCK + 0.74]),   // the scan band down the glass
  banner: Object.freeze([LOCK + 0.06, LOCK + 0.5, LOCK + 0.92, LOCK + 1.12]),
  end: LOCK + 1.12,
  reduced: Object.freeze({ dim: Object.freeze([LOCK - 0.3, LOCK - 0.1]), fade: Object.freeze([LOCK + 0.14, LOCK + 0.44]) }),
  // Exit: the screen cuts, the plates show closed for a beat and part (right, lower left, upper left).
  // The camera reaches the glass about 0.21 s in (titan-transit.js), so they are clear by 0.17 s.
  exit: Object.freeze({ cut: 0.04, plates: Object.freeze([Object.freeze([0.08, 0.17]), Object.freeze([0.06, 0.15]), Object.freeze([0.04, 0.13])]),
    glass: Object.freeze([0.1, 0.24]), banner: 0.38, dark: 0.12 }),
});

const clamp01 = k => Math.max(0, Math.min(1, k));
const smooth = k => { const t = clamp01(k); return t * t * (3 - 2 * t); };
const ramp = (t, [a, b]) => smooth((t - a) / (b - a));
/** A heavy plate: accelerates in, stops hard. */
const slam = (t, [a, b]) => { const k = clamp01((t - a) / (b - a)); return k * k * (2 - k); };
/** Deterministic flicker (no Math.random, so captures and tests repeat). */
const flicker = (t, seed) => { const s = Math.sin(Math.floor(t * 40) * 12.9898 + seed * 78.233) * 43758.5453; return s - Math.floor(s); };

/**
 * The plates' closing state at `t` (embark): [upper left, lower left, right], 0 = open (in the hull
 * beside the viewport) .. 1 = home, plus `rock` (a small knock back after each hit, metres in plate
 * travel direction).
 */
function platesAt(t, reduced) {
  if (reduced) return { closed: [0, 0, 0], rock: [0, 0, 0], visible: false };
  const B = EMBARK_BOOT;
  const closed = B.plates.map(window => slam(t, window));
  const rock = B.plates.map(([, home]) => {
    const dt = t - home;
    return dt > 0 && dt < B.settle ? -0.012 * Math.sin(dt / B.settle * Math.PI) * (1 - dt / B.settle) : 0;
  });
  // Hidden again once the screen takes the viewport (the black glass covers them from then on).
  return { closed, rock, visible: t >= B.plates[0][0] && t < B.screen[0] };
}

/**
 * Everything the cockpit shows at `t` seconds into an embark: plates, the glass screen (`screen`
 * -1 = plain glass, 0..1 the power-on from black), `dim` (0..1 glass darkening, reduced motion),
 * `seams` (0..1 flash), the power of shell / keys / screens / pods / glass HUD / accents, the warning
 * lamp colour, the glass scan band (-1 off) and the banner. `reduced` drops motion and flicker.
 */
export function embarkBoot(t, { reduced = false } = {}) {
  const B = EMBARK_BOOT;
  const plates = platesAt(t, reduced);
  const lit = (window, seed) => {
    if (t >= window[1]) return 1;
    if (t < window[0]) return 0.05;
    return reduced ? 0.05 + 0.95 * ramp(t, window) : (flicker(t, seed) < 0.45 ? 0.15 : 0.6 + 0.4 * flicker(t, seed + 1));
  };
  let screen = -1, dim = 0;
  if (reduced) dim = t < B.screen[0] ? ramp(t, B.reduced.dim) : 1 - ramp(t, B.reduced.fade);
  else if (t >= B.screen[0] && t < B.screen[1]) screen = clamp01((t - B.screen[0]) / (B.screen[1] - B.screen[0]));
  const before = t < B.lock, on = B.screen[0];
  // Dim while closing, darker once locked, then the power comes back with the screen.
  const shell = before ? 0.42 : t < on ? 0.28 : reduced || t >= on + 0.1 ? 1 : (flicker(t, 3) < 0.5 ? 0.45 : 1);
  const power = { shell, keys: lit(B.keys, 5), screens: lit(B.screens, 7), pods: lit(B.pods, 11),
    glassHud: ramp(t, B.glassHud), accent: lit([B.keys[0] + 0.08, B.keys[1] + 0.12], 13) };
  // Warning lamps blink red until the lock, then hold cyan for a moment (the seams are sealed).
  const warn = before ? (reduced || Math.floor(t * 8) % 2 ? [1.5, 0.12, 0.08] : [0.25, 0.12, 0.08])
    : t < B.seams[1] ? [0.25, 1.1, 1.5] : null;
  const seams = reduced || t < B.seams[0] ? 0 : 1 - ramp(t, B.seams);
  const band = !reduced && t >= B.band[0] && t <= B.band[1] ? ramp(t, B.band) : -1;
  const [b0, b1, b2, b3] = B.banner;
  let lines = [], bannerAlpha = 0;
  if (t >= b0 && t < b3) {
    lines = t < b1 ? ['NEURAL LINK'] : ['LINK ESTABLISHED', 'PILOT ONLINE'];
    bannerAlpha = (!reduced && t < b0 + 0.06 ? (flicker(t, 17) < 0.5 ? 0.3 : 1) : 1) * (1 - ramp(t, [b2, b3]));
  }
  return { plates, screen, dim, seams, power, warn, band, banner: { lines, alpha: bannerAlpha } };
}

/** The exit at `t` seconds since the disembark: the screen cuts, the plates part, the glass fades. */
export function exitHatch(t, { reduced = false } = {}) {
  const X = EMBARK_BOOT.exit;
  // Closed (1) until each plate's window starts, open (0) at its end.
  const closed = reduced ? [0, 0, 0] : X.plates.map(window => 1 - ramp(t, window));
  const dark = reduced ? 0.03 : t < X.dark ? (flicker(t, 19) < 0.5 ? 0.2 : 0.7) : 0.03;
  return {
    plates: { closed, rock: [0, 0, 0], visible: !reduced && t < Math.max(...X.plates.map(w => w[1])) },
    screen: !reduced && t < X.cut ? 0 : -1,
    open: 1 - ramp(t, X.glass),
    power: { shell: 0.75, keys: 0.12, screens: dark, pods: dark, glassHud: 0, accent: 0.3 },
    banner: t < X.banner ? { lines: ['HATCH OPEN'], alpha: 1 - smooth((t - X.banner + 0.12) / 0.12) } : { lines: [], alpha: 0 },
  };
}

/**
 * The sound and shake beats of an embark between two times (seconds since the event, `from`
 * exclusive): 'plate' (the first two plates home), 'lock' (the last plate home, the hatch locked)
 * and 'screen' (the power-on). Reduced motion keeps the lock and the screen.
 */
export function embarkBeats(from, to, { reduced = false } = {}) {
  const B = EMBARK_BOOT, out = [];
  const crossed = at => from < at && to >= at;
  if (!reduced) for (const [, home] of B.plates.slice(0, 2)) if (crossed(home)) out.push('plate');
  if (crossed(B.lock)) out.push('lock');
  if (crossed(B.screen[0])) out.push('screen');
  return out;
}
