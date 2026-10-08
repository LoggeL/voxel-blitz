import { WEAPONS } from '../../../shared/combatmath.js';
import { ballisticProfile, holdoverMils } from '../../../shared/bullet-ballistics.js';
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

  const rings = el('div', '', reticle);
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

  const zoomVal = Number(WEAPONS.sniper && WEAPONS.sniper.zoom) || 5;
  el('div', 'scope-zoom-label', scope, prefix + 'scope-zoom-label').textContent = `${zoomVal.toFixed(1)}×`;
  el('div', 'scope-model-label', scope).textContent = 'FACTORY OPTIC';
  const zero = el('div', 'scope-zero-label', scope);
  zero.textContent = `ZERO ${ballisticProfile(WEAPONS.sniper)?.zeroM ?? 100} M`;
  return scope;
}

/**
 * Scale the mil marks to the live vertical field of view and show the drop
 * ladder only for a weapon whose round actually drops (`ballistic`).
 */
export function updateScopeOptics(scope, fovDeg, ballistic, viewportHeight = globalThis.innerHeight) {
  if (!scope) return;
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
