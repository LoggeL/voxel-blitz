import { el, MAP_PREVIEWS } from './hud-support.js';
import { mountMusicControl } from './music-control.js';
import { CrossfadeImage } from './crossfade-image.js';

const MENU_BACKDROPS = Object.freeze({
  harbor: '/assets/maps/harbor.png',
  canyon: '/assets/maps/canyon.png',
  foundry: '/assets/ui/menu-foundry-dusk.webp',
  depot: '/assets/maps/depot-concept.webp',
  citadel: '/assets/maps/citadel-concept.webp',
  solstice: '/assets/maps/solstice-concept.webp',
  caldera: '/assets/maps/caldera-concept.webp',
  nuketown: '/assets/maps/nuketown.webp',
  dust2: '/assets/maps/dust2.webp',
  killhouse: '/assets/maps/killhouse-range.webp',
  reactor: MAP_PREVIEWS.reactor,
});

const backdrops = new WeakMap();

export function setMenuBackdrop(root, map = 'foundry') {
  if (!root) return;
  const normalized = MENU_BACKDROPS[map] ? map : 'foundry';
  root.dataset.map = normalized;
  if (root.id === 'lobby') {
    let backdrop = backdrops.get(root);
    if (!backdrop || backdrop.root.parentNode !== root) {
      backdrop?.dispose();
      const layer = el('div', 'vb-lobby-backdrop', root);
      layer.setAttribute('aria-hidden', 'true');
      backdrop = new CrossfadeImage(layer);
      backdrops.set(root, backdrop);
    }
    backdrop.set(MENU_BACKDROPS[normalized]);
    return;
  }
  root.style.setProperty('--vb-menu-backdrop', `url("${MENU_BACKDROPS[normalized]}")`);
}

export function disposeMenuBackdrop(root) {
  backdrops.get(root)?.dispose();
  backdrops.delete(root);
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
  mountMusicControl(rail);
  const stage = el('main', 'vb-menu-stage', shell);
  return { shell, rail, stage };
}
