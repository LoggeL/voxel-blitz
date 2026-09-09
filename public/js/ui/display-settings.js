/** Shared local display preferences. Debug views are deliberately opt-in. */
export const DISPLAY_OPTIONS = Object.freeze([
  { key: 'showPing', label: 'PING', section: 'HUD & NETWORK' },
  { key: 'showPainMeter', label: 'PAIN METER' },
  { key: 'showPanicMeter', label: 'PANIC METER' },
  { key: 'showFps', label: 'FPS' },
  { key: 'showNetwork', label: 'NETWORK GRAPH · JITTER · BUFFER' },
  { key: 'showHitboxes', label: 'HITBOXES', section: 'DEBUG VIEWS' },
  { key: 'showWireframes', label: 'PLAYER MODEL WIREFRAMES' },
]);
const values = {};
for (const { key } of DISPLAY_OPTIONS) {
  try { values[key] = localStorage.getItem(`vb-display-${key}`) === '1'; }
  catch { values[key] = false; }
}
export function displaySettings() { return values; }
export function setDisplaySetting(key, enabled) {
  if (!DISPLAY_OPTIONS.some(option => option.key === key)) return;
  values[key] = enabled === true;
  try { localStorage.setItem(`vb-display-${key}`, values[key] ? '1' : '0'); } catch {}
}
