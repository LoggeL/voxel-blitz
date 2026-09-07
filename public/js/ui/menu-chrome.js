import { el } from './hud-support.js';

const MENU_BACKDROPS = Object.freeze({
  foundry: '/assets/ui/menu-foundry-dusk.webp',
  depot: '/assets/maps/depot-concept.webp',
  citadel: '/assets/maps/citadel-concept.webp',
  solstice: '/assets/maps/solstice-concept.webp',
  caldera: '/assets/maps/caldera-concept.webp',
  nuketown: '/assets/maps/nuketown.webp',
  dust2: '/assets/maps/dust2.webp',
  killhouse: '/assets/maps/killhouse-range.webp',
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

  el('span', 'vb-brand-context', rail).textContent = context;
  return rail;
}

export function buildMenuShell(root, options = {}) {
  const shell = el('div', 'vb-menu-shell', root);
  const rail = buildBrandRail(shell, options);
  const stage = el('main', 'vb-menu-stage', shell);
  return { shell, rail, stage };
}
