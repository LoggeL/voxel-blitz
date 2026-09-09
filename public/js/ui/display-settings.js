/** Shared local display preferences. Debug views are deliberately opt-in. */
export const DISPLAY_OPTIONS = Object.freeze([
  { key: 'reducedMotion', label: 'REDUCED MOTION', section: 'ACCESSIBILITY' },
  { key: 'showPing', label: 'PING', section: 'HUD & NETWORK' },
  { key: 'showPainMeter', label: 'PAIN METER' },
  { key: 'showPanicMeter', label: 'PANIC METER' },
  { key: 'showFps', label: 'FPS' },
  { key: 'showNetwork', label: 'NETWORK GRAPH · JITTER · BUFFER' },
  { key: 'showHitboxes', label: 'HITBOXES', section: 'DEBUG VIEWS' },
  { key: 'showWireframes', label: 'PLAYER MODEL WIREFRAMES' },
]);
const values = {};
let motionOverridden = false;
const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
for (const { key } of DISPLAY_OPTIONS) {
  let stored = null;
  try { stored = localStorage.getItem(`vb-display-${key}`); } catch {}
  values[key] = stored === '1' || (stored == null && key === 'reducedMotion' && !!motionQuery?.matches);
  if (key === 'reducedMotion') motionOverridden = stored != null;
}
function syncMotionAttribute() {
  if (typeof document !== 'undefined') document.documentElement?.setAttribute('data-reduced-motion', String(values.reducedMotion));
}
motionQuery?.addEventListener?.('change', event => {
  if (!motionOverridden) { values.reducedMotion = event.matches; syncMotionAttribute(); }
});
syncMotionAttribute();
export function displaySettings() { return values; }
export function setDisplaySetting(key, enabled) {
  if (!DISPLAY_OPTIONS.some(option => option.key === key)) return;
  values[key] = enabled === true;
  if (key === 'reducedMotion') { motionOverridden = true; syncMotionAttribute(); }
  try { localStorage.setItem(`vb-display-${key}`, values[key] ? '1' : '0'); } catch {}
}
