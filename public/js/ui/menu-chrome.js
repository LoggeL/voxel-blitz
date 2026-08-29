import { el } from './hud-support.js';

const MENU_BACKDROPS = Object.freeze({
  foundry: '/assets/ui/menu-foundry-dusk.webp',
  depot: '/assets/maps/depot-concept.webp',
  citadel: '/assets/maps/citadel-concept.webp',
});

export function setMenuBackdrop(root, map = 'foundry') {
  if (!root) return;
  const normalized = MENU_BACKDROPS[map] ? map : 'foundry';
  root.dataset.map = normalized;
  root.style.setProperty('--vb-menu-backdrop', `url("${MENU_BACKDROPS[normalized]}")`);
}

function buildBrandRail(parent, { context = 'DEPLOYMENT', titleId = '' } = {}) {
  const rail = el('aside', 'vb-brand-rail', parent);
  rail.setAttribute('aria-label', 'Voxel Blitz');

  const lockup = el('div', 'vb-brand-lockup', rail, titleId || undefined);
  el('span', 'vb-brand-voxel', lockup).textContent = 'VOXEL';
  el('span', 'vb-brand-blitz', lockup).textContent = 'BLITZ';

  const nav = el('div', 'vb-brand-context', rail);
  el('span', 'vb-brand-context-active', nav).textContent = context;
  el('span', '', nav).textContent = 'TACTICAL ARENA';
  el('span', '', nav).textContent = 'SIX WEAPONS';
  el('span', '', nav).textContent = 'VOXEL COMBAT';

  const status = el('div', 'vb-brand-status', rail);
  el('span', 'vb-online-dot', status).setAttribute('aria-hidden', 'true');
  el('span', '', status).textContent = 'ONLINE';

  el('div', 'vb-brand-build', rail).textContent = 'BUILD 0.1';
  return rail;
}

export function buildMenuShell(root, options = {}) {
  const shell = el('div', 'vb-menu-shell', root);
  const rail = buildBrandRail(shell, options);
  const stage = el('main', 'vb-menu-stage', shell);
  return { shell, rail, stage };
}

export function buildTelemetry(parent, { title = 'MISSION TELEMETRY', rows = [] } = {}) {
  const card = el('aside', 'vb-menu-telemetry', parent);
  el('div', 'vb-telemetry-title', card).textContent = title;

  const radar = el('div', 'vb-telemetry-radar', card);
  radar.setAttribute('aria-hidden', 'true');

  const list = el('div', 'vb-telemetry-list', card);
  for (const [label, value] of rows) {
    const row = el('div', 'vb-telemetry-row', list);
    el('span', 'vb-telemetry-label', row).textContent = label;
    el('span', 'vb-telemetry-value', row).textContent = value;
  }
  return card;
}
