import { WEAPON_IDS } from '../../../shared/combatmath.js';

export const GLYPH = Object.freeze({
  rifle: 'R',
  smg: 'S',
  shotgun: 'SG',
  sniper: 'SN',
  lmg: 'LMG',
  revolver: 'REV',
  longarc: 'LA',
  rocket: 'RKT',
  lance: 'VL',
  knife: 'KN',
  grenade: 'GRN',
});

export const WEAPON_NAMES = Object.freeze({
  revolver: 'IRONCLAD .44',
  smg: 'HORNET SMG',
  shotgun: 'M-DOCK 12',
  rifle: 'VK-77 RAPTOR',
  lmg: 'BASTION LMG',
  sniper: 'LONGSHOT MK-II',
  longarc: 'LN-03 LONGARC',
  rocket: 'RX-8 HAVOC',
  lance: 'CL-9 VOLTLANCE',
  knife: 'K-7 RIPPER',
});

/** Kill-feed / recap names for explosives that are not weapon slots. */
export const THROWABLE_NAMES = Object.freeze({
  grenade: 'GRENADE',
  frag: 'M-4 FRAG',
  limpet: 'LIMPET CHARGE',
  pulse: 'PULSE SHOCK',
});

export const WEAPON_CLASSES = Object.freeze({
  revolver: 'SIDEARM · SEMI-AUTO',
  smg: 'SUBMACHINE GUN · FULL AUTO',
  shotgun: 'TACTICAL SHOTGUN · PUMP',
  rifle: 'ASSAULT RIFLE · FULL AUTO',
  lmg: 'HEAVY MACHINE GUN · AUTO',
  sniper: 'PRECISION SNIPER · 5× OPTIC',
  longarc: 'CHARGE COILGUN · ARC BOLTS ×3 BOUNCE',
  rocket: 'ROCKET LAUNCHER · SPLASH & ROCKET JUMP',
  lance: 'SIEGE LANCE · LINE PIERCE ×6',
  knife: 'COMBAT KNIFE · MELEE',
});

export const WEAPON_BUY_ORDER = Object.freeze([
  'revolver',
  'smg',
  'shotgun',
  'rifle',
  'lmg',
  'sniper',
  'longarc',
  'lance',
  'rocket',
  'knife',
]);

export const MODE_LABELS = Object.freeze({
  fun: 'FUN · FREE FOR ALL',
  tdm: 'TEAM DEATHMATCH',
  snd: 'SEARCH & DESTROY',
  gungame: 'GUN GAME',
  training: 'TRAINING · RANGE & KILLHOUSE',
});

export const MODE_DESCRIPTIONS = Object.freeze({
  fun: 'Shared instant skirmish · 8-gun full loadout · Rapid respawn',
  tdm: 'Alpha vs Bravo · First team to 40 kills wins · Team spawns',
  snd: 'Attackers vs Defenders · Buy phase economy · First to 7 round wins',
  gungame: 'Earn a kill with each weapon · Revolver elimination wins',
  training: 'Test every gun on respawning dummies · Race the 4-stage killhouse for the best time',
});

export const MAP_LABELS = Object.freeze({
  foundry: 'FOUNDRY',
  depot: 'DEPOT',
  citadel: 'CITADEL',
  solstice: 'SOLSTICE',
  caldera: 'CALDERA',
  killhouse: 'KILLHOUSE',
});

export const MAP_DESCRIPTIONS = Object.freeze({
  foundry: 'Industrial foundry with multi-level catwalks and mid-lane cover (All Modes)',
  depot: 'Point-symmetric cargo depot with mirrored containers & central plaza (Fun / TDM / Gun Game)',
  citadel: 'Urban fortress with Courtyard A and Compound B tactical bomb sites (All Modes)',
  solstice: 'Desert solar observatory with a glass biodome, turbine hall, and compact linked lanes (All Modes)',
  caldera: 'Volcanic caldera with a west obsidian gate and elevated east ember refinery (All Modes)',
  killhouse: 'Covered firing bays and four numbered rooms. Practice on respawning targets or race the course.',
});

export const MAP_PREVIEWS = Object.freeze({
  foundry: './assets/maps/foundry-concept.webp',
  depot: './assets/maps/depot-concept.webp',
  citadel: './assets/maps/citadel-concept.webp',
  solstice: './assets/maps/solstice-concept.webp',
  caldera: './assets/maps/caldera-concept.webp',
  killhouse: './assets/maps/killhouse-range.webp',
});

export const CARDINAL = Object.freeze({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' });
export const SCOPE_MS = 120;
export const DMG_MS = 650;
export const DMG_MAX_POOL = 40;

export function el(tag, cls, parent, id) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (id) node.id = id;
  if (parent) parent.appendChild(node);
  return node;
}

export function removeNode(node) {
  if (!node) return;
  if (typeof node.remove === 'function') node.remove();
  else if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
    node.parentNode.removeChild(node);
  }
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

export function resolveInviteBase() {
  try {
    const browserLocation =
      (typeof window !== 'undefined' && window.location)
      || (typeof globalThis !== 'undefined' && globalThis.location)
      || null;
    if (!browserLocation) return '';
    const { origin, pathname } = browserLocation;
    if (typeof origin !== 'string' || typeof pathname !== 'string') return '';
    return `${origin}${pathname}`;
  } catch (_) {
    return '';
  }
}

export function loadName() {
  try { return localStorage.getItem('vb-name') || ''; } catch (_) { return ''; }
}

export function saveName(value) {
  try { localStorage.setItem('vb-name', value); } catch (_) {}
}

export function loadPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}

export function savePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_) {}
}

export function loadPrefNum(key, fallback, minValue, maxValue) {
  try {
    const value = parseFloat(localStorage.getItem(key));
    if (Number.isFinite(value)) {
      if (minValue != null && maxValue != null) {
        return Math.min(maxValue, Math.max(minValue, value));
      }
      return value;
    }
  } catch (_) {}
  return fallback;
}

export function resolveKey(weaponId) {
  if (typeof weaponId === 'number') return WEAPON_IDS[weaponId] || '';
  if (typeof weaponId === 'string') return weaponId;
  return '';
}

export function spreadFromCone(coneDegrees) {
  const cone = Math.max(0, Number(coneDegrees) || 0);
  return 4 + 72 * (1 - Math.exp(-cone / 7));
}

export function cleanCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '').slice(0, 5);
}

export async function copyInviteLink(url) {
  let copied = false;
  if (
    typeof navigator !== 'undefined'
    && navigator.clipboard
    && typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (_) {
      copied = false;
    }
  }

  if (!copied) {
    let textarea = null;
    try {
      textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, 99999);
      copied = document.execCommand('copy');
    } catch (_) {
      copied = false;
    } finally {
      if (textarea?.parentNode) textarea.parentNode.removeChild(textarea);
    }
  }

  return copied;
}

export class HudSupport {
  constructor() {
    this._roots = new Set();
    this._ownedRoots = new Set();
    this._deferredTimers = new Set();
  }

  root(id, { className = '', attributes = null } = {}) {
    let root = document.getElementById(id);
    if (!root) {
      root = el('div', className, document.body, id);
      if (attributes) {
        for (const [name, value] of Object.entries(attributes)) {
          root.setAttribute(name, value);
        }
      }
      this._ownedRoots.add(root);
    }
    this._roots.add(root);
    return root;
  }

  defer(callback) {
    const timer = setTimeout(() => {
      this._deferredTimers.delete(timer);
      callback();
    }, 0);
    this._deferredTimers.add(timer);
    return timer;
  }

  dispose() {
    for (const timer of this._deferredTimers) clearTimeout(timer);
    this._deferredTimers.clear();

    for (const root of this._roots) {
      if (this._ownedRoots.has(root)) root.remove();
      else root.innerHTML = '';
    }
    for (const root of this._ownedRoots) root.remove();

    this._roots.clear();
    this._ownedRoots.clear();
  }
}
