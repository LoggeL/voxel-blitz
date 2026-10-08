import { WEAPONS } from '../../../shared/combatmath.js';
import { ballisticProfile, holdoverMils } from '../../../shared/bullet-ballistics.js';
import { rocketSightMarks, rocketReachM } from '../../../shared/rocket-rules.js';
import { el } from './hud-support.js';

/** Ranges (m) that get a holdover mark on the drop ladder; hundreds carry a numeral. */
export const SCOPE_BDC_RANGES = Object.freeze([150, 200, 250, 300, 350, 400, 500]);
/** Lead dots along the horizontal wire, in milliradians either side of centre. */
export const SCOPE_LEAD_MILS = Object.freeze([5, 10, 15, 20]);

/** The drop ladder for a ballistic profile: one mark per range, `mil` below the centre. */
export function scopeHoldoverMarks(profile) {
  if (!profile) return [];
  return SCOPE_BDC_RANGES.map(range => ({ range, mil: holdoverMils(profile, range), label: range % 100 === 0 ? String(range / 100) : '' }));
}

/** RX-8 drop ladder: one bar per reachable range (shared rocket ballistics). */
export const LAUNCHER_SIGHT_MARKS = Object.freeze(rocketSightMarks().map(mark => Object.freeze(mark)));
/** Farthest level-line range the RX-8 rocket flies before it self-destructs (m). */
export const LAUNCHER_REACH_M = Math.round(rocketReachM());
/**
 * Ladder bars span a tank hull's width (VEHICLE_DEFS.tank.collider, 2 x 1.95 m)
 * at their range, a stadia check on the readout. A literal keeps the vehicle
 * registry off the menu's module graph; tools/rocket-sight-test.mjs pins it.
 */
export const LAUNCHER_STADIA_WIDTH_M = 3.9;

/** Rangefinder readout text: whole metres, "---" with no return. */
export function rangefinderText(reading) {
  return reading && Number.isFinite(reading.distance) ? String(Math.round(reading.distance)) : '---';
}

/** Which reticle a scoped weapon definition gets: the launcher sight or the rifle scope. */
export function scopeReticleKind(def) {
  return def?.projectile === 'rocket' ? 'launcher' : 'sniper';
}

/** Viewport-height percent covered by one milliradian at a vertical field of view. */
export function scopeMilVh(fovDeg) {
  const half = (Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : 75) * Math.PI / 360;
  return 50 * Math.tan(0.001) / Math.tan(half);
}

/** Build the canonical sniper overlay inside a HUD root. */
export function createSniperScope(hud, prefix = '') {
  const scope = el('div', 'sniper-scope', hud, prefix + 'sniper-scope');
  scope.style.pointerEvents = 'none';

  el('div', 'scope-vignette', scope, prefix + 'scope-vignette');
  const window = el('div', 'scope-reticle-window', scope, prefix + 'scope-reticle-window');
  const reticle = el('div', 'scope-reticle', window, prefix + 'scope-reticle');
  el('div', 'scope-line h', reticle);
  el('div', 'scope-line v', reticle);
  el('div', 'scope-duplex scope-duplex-left', reticle);
  el('div', 'scope-duplex scope-duplex-right', reticle);
  el('div', 'scope-duplex scope-duplex-top', reticle);
  el('div', 'scope-duplex scope-duplex-bottom', reticle);

  const rings = el('div', 'scope-rings', reticle);
  rings.style.position = 'absolute';
  rings.style.inset = '0';
  rings.style.pointerEvents = 'none';

  for (const vmin of [22, 44]) {
    const ring = el('div', '', rings);
    ring.style.position = 'absolute';
    ring.style.left = '50%';
    ring.style.top = '50%';
    ring.style.width = `${vmin}vmin`;
    ring.style.height = `${vmin}vmin`;
    ring.style.margin = `-${vmin / 2}vmin 0 0 -${vmin / 2}vmin`;
    ring.style.borderRadius = '50%';
    ring.style.border = '1px solid rgba(160, 185, 210, 0.18)';
  }

  // First-focal-plane marks: every offset is a mil count times --scope-mil, which
  // `updateScopeOptics` keeps equal to one milliradian of the live view, so the
  // marks hold their true angle at 5×, 2.5× or any attachment optic.
  for (const mil of SCOPE_LEAD_MILS) {
    for (const side of [-1, 1]) {
      const dot = el('div', `scope-lead-dot${mil % 10 === 0 ? ' major' : ''}`, rings);
      dot.style.left = `calc(50% + ${side * mil} * var(--scope-mil, 0.33vh))`;
    }
  }
  const ladder = el('div', 'scope-bdc', rings);
  let labels = 0;
  for (const mark of scopeHoldoverMarks(ballisticProfile(WEAPONS.sniper))) {
    const tick = el('div', `scope-bdc-tick${mark.label ? ' major' : ''}`, ladder);
    tick.dataset.range = String(mark.range);
    tick.style.top = `calc(50% + ${mark.mil.toFixed(3)} * var(--scope-mil, 0.33vh))`;
    // Numerals alternate sides so neighbouring hundreds never crowd at 2.5×.
    if (mark.label) el('span', `scope-bdc-label ${labels++ % 2 ? 'left' : 'right'}`, tick).textContent = mark.label;
  }

  createLauncherReticle(scope, reticle);

  const zoomVal = Number(WEAPONS.sniper && WEAPONS.sniper.zoom) || 5;
  el('div', 'scope-zoom-label', scope, prefix + 'scope-zoom-label').textContent = `${zoomVal.toFixed(1)}×`;
  el('div', 'scope-model-label', scope).textContent = 'FACTORY OPTIC';
  const zero = el('div', 'scope-zero-label', scope);
  zero.textContent = `ZERO ${ballisticProfile(WEAPONS.sniper)?.zeroM ?? 100} M`;
  return scope;
}

/**
 * RX-8 launcher sight (shown while the scope carries `launcher-sight`): an
 * illuminated aim chevron on the line of sight, a centre stem and one ladder bar
 * per range the rocket reaches, offset by its holdover in mils. Every offset is a
 * mil count times --scope-mil, so the marks keep their true angle at 2.5x, 1.5x
 * or a bolt-on 2x tube. The rangefinder readout sits upper-left of the chevron
 * (centred above it in portrait); the impact diamond is placed in screen space by updateLauncherSight.
 */
function createLauncherReticle(scope, reticle) {
  const sight = el('div', 'launcher-reticle', reticle);
  sight.setAttribute('aria-hidden', 'true');
  const chevron = el('div', 'launcher-chevron', sight);
  chevron.innerHTML = '<svg viewBox="0 0 26 14" width="26" height="14"><polyline points="2,13 13,2 24,13" /></svg>';
  el('div', 'launcher-wing left', sight);
  el('div', 'launcher-wing right', sight);
  const deepest = LAUNCHER_SIGHT_MARKS.at(-1)?.mil ?? 100;
  const stem = el('div', 'launcher-stem', sight);
  stem.style.height = `calc(${(deepest + 6).toFixed(2)} * var(--scope-mil, 0.33vh) - 9px)`;
  for (const mark of LAUNCHER_SIGHT_MARKS) {
    const bar = el('div', 'launcher-bar', sight);
    bar.dataset.range = String(mark.range);
    bar.style.top = `calc(50% + ${mark.mil.toFixed(3)} * var(--scope-mil, 0.33vh))`;
    const width = Math.max(14, LAUNCHER_STADIA_WIDTH_M / mark.range * 1000);
    bar.style.width = `calc(${width.toFixed(2)} * var(--scope-mil, 0.33vh))`;
    el('span', 'launcher-bar-label', bar).textContent = String(mark.range);
  }
  const readout = el('div', 'launcher-readout', reticle);
  const tag = el('span', 'launcher-readout-tag', readout);
  tag.textContent = 'RANGE';
  const value = el('span', 'launcher-readout-value', readout);
  value.textContent = '---';
  el('span', 'launcher-readout-unit', readout).textContent = 'M';
  const note = el('span', 'launcher-readout-note', readout);
  note.textContent = `REACH ${LAUNCHER_REACH_M} M`;
  const impact = el('div', 'launcher-impact', scope);
  impact.hidden = true;
  scope._launcher = { readout, tag, value, note, impact, text: '---', state: '', impactKey: '' };
}

/**
 * Paint the rangefinder readout and the impact diamond. `sample` is the
 * LauncherRangefinder output ({reading, impact}) or null, optionally with the
 * impact already projected as `screen`; otherwise `project` maps a world point
 * to viewport fractions ({x, y, behind}). Idle frames write nothing.
 */
export function updateLauncherSight(scope, sample, project = null) {
  const parts = scope?._launcher;
  if (!parts) return;
  const reading = sample?.reading ?? null;
  const text = rangefinderText(reading);
  if (parts.text !== text) { parts.text = text; parts.value.textContent = text; }
  const range = !reading ? 'none' : reading.distance > LAUNCHER_REACH_M ? 'beyond' : 'in-reach';
  const held = !!reading?.held;
  const state = `${range}/${held}`;
  if (parts.state !== state) {
    parts.state = state;
    parts.readout.dataset.state = range;
    parts.readout.dataset.held = String(held);
    parts.tag.textContent = held ? 'RANGE · HELD' : 'RANGE';
    parts.note.textContent = range === 'beyond' ? 'OUT OF REACH' : `REACH ${LAUNCHER_REACH_M} M`;
  }
  const impact = sample?.impact ?? null;
  const at = !impact ? null : sample.screen ?? (typeof project === 'function' ? project(impact.point) : null);
  // Only inside the tube (radius 33.4vmin, as the reticle window's clip); the mask stays black.
  const w = globalThis.innerWidth, h = globalThis.innerHeight;
  const inTube = !at || !(w > 0 && h > 0)
    || Math.hypot((at.x - 0.5) * w, (at.y - 0.5) * h) <= 0.334 * Math.min(w, h);
  const visible = !!at && !at.behind && at.x >= 0 && at.x <= 1 && at.y >= 0 && at.y <= 1 && inTube;
  const key = visible ? `${(at.x * 100).toFixed(2)}/${(at.y * 100).toFixed(2)}/${impact.airburst ? 1 : 0}` : '';
  if (parts.impactKey === key) return;
  parts.impactKey = key;
  parts.impact.hidden = !visible;
  if (!visible) return;
  parts.impact.style.left = `${(at.x * 100).toFixed(2)}%`;
  parts.impact.style.top = `${(at.y * 100).toFixed(2)}%`;
  parts.impact.classList.toggle('airburst', !!impact.airburst);
}

/**
 * Scale the mil marks to the live vertical field of view and show the drop
 * ladder only for a weapon whose round actually drops (`ballistic`). `kind`
 * ('sniper' | 'launcher', see scopeReticleKind) picks the reticle.
 */
export function updateScopeOptics(scope, fovDeg, ballistic, viewportHeight = globalThis.innerHeight, kind = 'sniper') {
  if (!scope) return;
  const launcher = kind === 'launcher';
  if (scope.classList.contains('launcher-sight') !== launcher) {
    scope.classList.toggle('launcher-sight', launcher);
    if (!launcher) updateLauncherSight(scope, null);
  }
  const milVh = scopeMilVh(fovDeg);
  const mil = `${milVh.toFixed(4)}vh`;
  if (scope.style.getPropertyValue('--scope-mil') !== mil) scope.style.setProperty('--scope-mil', mil);
  const on = !!ballistic;
  if (scope.classList.contains('has-ballistics') !== on) scope.classList.toggle('has-ballistics', on);
  // Under ~2.2 px per mil (short phone screens, 2.5×) numerals and minor marks
  // would merge: keep only the hundreds.
  const compact = Number.isFinite(viewportHeight) && milVh * viewportHeight / 100 < 2.2;
  if (scope.classList.contains('scope-compact') !== compact) scope.classList.toggle('scope-compact', compact);
}
