import { WEAPONS } from '../../../shared/combatmath.js';
import { el } from './hud-support.js';

/** Build the canonical sniper overlay inside a HUD root. */
export function createSniperScope(hud) {
  const scope = el('div', '', hud, 'sniper-scope');
  scope.style.pointerEvents = 'none';

  el('div', '', scope, 'scope-vignette');
  el('div', 'scope-line h', scope);
  el('div', 'scope-line v', scope);
  el('div', 'scope-duplex scope-duplex-left', scope);
  el('div', 'scope-duplex scope-duplex-right', scope);
  el('div', 'scope-duplex scope-duplex-top', scope);
  el('div', 'scope-duplex scope-duplex-bottom', scope);

  const rings = el('div', '', scope);
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

  for (const pct of [-0.10, -0.075, -0.05, -0.025, 0.025, 0.05, 0.075, 0.10]) {
    const dot = el('div', '', rings);
    dot.style.position = 'absolute';
    dot.style.left = `${50 + pct * 100}%`;
    dot.style.top = '50%';
    dot.style.width = '2px';
    dot.style.height = Math.abs(pct) % 0.05 === 0 ? '6px' : '3px';
    dot.style.marginTop = Math.abs(pct) % 0.05 === 0 ? '-3px' : '-1.5px';
    dot.style.marginLeft = '-1px';
    dot.style.background = 'rgba(160, 185, 210, 0.65)';
  }

  for (const pct of [0.025, 0.05, 0.075, 0.10, 0.13, 0.16]) {
    const tick = el('div', '', rings);
    tick.style.position = 'absolute';
    tick.style.left = '50%';
    tick.style.top = `${50 + pct * 100}%`;
    const widthPx = pct >= 0.10 ? 8 : (pct === 0.05 ? 6 : 4);
    tick.style.width = `${widthPx}px`;
    tick.style.height = '1px';
    tick.style.marginLeft = `-${widthPx / 2}px`;
    tick.style.background = 'rgba(160, 185, 210, 0.65)';
  }

  const zoomVal = Number(WEAPONS.sniper && WEAPONS.sniper.zoom) || 5;
  el('div', '', scope, 'scope-zoom-label').textContent = `${zoomVal.toFixed(1)}×`;
  el('div', 'scope-model-label', scope).textContent = 'LONGSHOT MK-II · OPTIC 5×42';
  return scope;
}
