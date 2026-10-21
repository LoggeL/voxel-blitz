import { signatureEmblem } from '../cosmetics/signature.js';

const LEGACY_ART = ['amber', 'arctic', 'orchid', 'mint', 'rookie', 'pathfinder', 'vanguard', 'veteran'];

export const COSMETIC_AUDIO = Object.freeze({
  kill: { label: 'Your kill sound', defaultVolume: 0.5 },
  death: { label: 'Enemy death music', defaultVolume: 0.35 },
  victory: { label: 'Victory music', defaultVolume: 0.5 },
});

export function cosmeticVolume(cue) {
  const fallback = COSMETIC_AUDIO[cue]?.defaultVolume ?? 0.5;
  try {
    const stored = localStorage.getItem(`vb-cosmetic-${cue}-volume`);
    if (stored === null || stored.trim() === '') return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  } catch { return fallback; }
}

const append = (tag, parent, text = '', className = '') => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
};

const KIND_WORDS = Object.freeze({ characterSkin: 'OPERATOR', signature: 'SIGNATURE', sound: 'SOUND KIT', theme: 'HUD THEME',
  title: 'CALLSIGN', reticle: 'RETICLE', nameplate: 'NAMEPLATE', weaponSkin: 'WEAPON SKIN', attachment: 'ATTACHMENT' });
const SLOT_WORDS = Object.freeze({ optic: 'OPTIC', grip: 'GRIP', counter: 'KILL COUNTER' });

/** Generated ARMORY icons (docs/design/armory-v2/icons). Decoration only: the
 * caller always prints the item's name and state next to them. */
export const ARMORY_ICON_ROOT = '/assets/ui/armory/icons/';
export const ARMORY_ICONS = Object.freeze([
  'std-operator', 'std-signature', 'std-sound', 'std-nameplate',
  'sound-arcade', 'sound-high-noon', 'sound-overdrive',
  'title-armorer', 'title-armsmaster', 'title-tactician', 'title-operator', 'title-sentinel', 'title-warden',
  'title-commander', 'title-legend', 'title-immortal', 'title-weapon-master',
  'nameplate-ranger', 'nameplate-aegis', 'nameplate-eclipse', 'nameplate-bulwark', 'nameplate-onyx',
  'nameplate-centurion', 'nameplate-zenith', 'nameplate-arsenal',
  'part-reflex', 'part-angled', 'part-stattrak', 'part-scope2', 'part-vertical', 'part-scope4',
  'part-precision', 'part-scope10', 'part-cyber',
  'tier-initiated', 'tier-specialist', 'tier-elite', 'tier-master',
  'class-pyro', 'class-grenadier', 'class-raider', 'class-marksman',
]);
const ICON_NAMES = new Set(ARMORY_ICONS);
const STANDARD_ICONS = Object.freeze({ characterSkin: 'std-operator', signature: 'std-signature', sound: 'std-sound', nameplate: 'std-nameplate' });
const iconUrl = name => ICON_NAMES.has(name) ? `${ARMORY_ICON_ROOT}${name}.webp` : null;

/** The generated icon for a catalog item, a standard slot or nothing (legacy atlas, renders, mocks). */
export function cosmeticIcon(item) {
  if (!item) return null;
  if (item.id === 'standard') return iconUrl(STANDARD_ICONS[item.kind]);
  if (item.kind === 'title') return iconUrl(item.masteryTier === 'master' && item.weapon ? 'title-weapon-master' : `title-${item.id}`);
  // Weapon mastery nameplates carry their tier's badge; the card around them names the weapon.
  if (item.kind === 'nameplate') return iconUrl(item.masteryTier ? `tier-${item.masteryTier}` : `nameplate-${item.id.replace(/^nameplate-/, '')}`);
  if (item.kind === 'sound') return iconUrl(`sound-${item.id}`);
  if (item.kind === 'attachment') return iconUrl(`part-${item.part}`);
  return null;
}

export const tierIcon = tierId => iconUrl(`tier-${tierId}`);
export const classIcon = kitId => iconUrl(`class-${kitId}`);

/** A decorative `img.vb-armory-icon`; a missing file hides itself and leaves the plate beside it. */
export function iconImage(parent, src, className = 'vb-armory-icon') {
  const image = append('img', parent, '', className);
  image.src = src;
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  image.setAttribute('aria-hidden', 'true');
  image.addEventListener?.('error', () => {
    image.hidden = true;
    image.parentNode?.removeAttribute?.('data-icon');
  }, { once: true });
  return image;
}

/** `div.vb-reticle-preview[data-reticle] > div.vb-reticle-crosshair > span.ch-arm ×4`,
 * styled by the same rules as the in-match `#crosshair`. */
function reticlePreview(parent, reticle) {
  const frame = append('div', parent, '', 'vb-reticle-preview');
  if (reticle) frame.dataset.reticle = reticle;
  frame.setAttribute('aria-hidden', 'true');
  const crosshair = append('div', frame, '', 'vb-reticle-crosshair');
  for (let arm = 0; arm < 4; arm++) append('span', crosshair, '', 'ch-arm');
  return frame;
}

/** A scoreboard row with the real `.vb-sb-nameplate` badge. */
function nameplateRow(parent, item) {
  const row = append('div', parent, '', 'vb-nameplate-mock');
  row.setAttribute('aria-hidden', 'true');
  append('span', row, '1', 'vb-nameplate-mock-rank');
  const name = append('span', row, 'YOUR CALLSIGN', 'vb-nameplate-mock-name');
  if (item?.badge) {
    const badge = append('span', name, item.badge, 'vb-sb-nameplate');
    badge.style.setProperty('--item-color', item.color || '#9fb6cc');
  }
  append('span', row, '24 / 9', 'vb-nameplate-mock-score');
  return row;
}

/** Crosshair, ammo pill and career badge tinted with the theme colour. */
function themeMock(parent) {
  const hud = append('div', parent, '', 'vb-theme-mock');
  hud.setAttribute('aria-hidden', 'true');
  const crosshair = append('span', hud, '', 'vb-theme-mock-crosshair');
  for (let arm = 0; arm < 4; arm++) append('i', crosshair);
  append('span', hud, '30 / 90', 'vb-theme-mock-ammo');
  append('span', hud, 'LV 12 · CALLSIGN', 'vb-theme-mock-badge');
  return hud;
}

/** New rewards always use their own artwork. Legacy atlas positions are stable IDs.
 * `size` is `thumb` (slot and option tiles; the container sets 44 or 132 px) or
 * `stage` (the inspector). Standard targets pass `{ id: 'standard', kind }`. */
export function cosmeticArtwork(parent, item, className = '', { size = 'stage' } = {}) {
  const container = className ? append('div', parent, '', className) : parent;
  const legacy = LEGACY_ART.indexOf(item?.id);
  if (legacy >= 0) {
    const art = append('div', container, '', 'vb-cosmetic-art');
    art.style.backgroundPosition = `${(legacy % 4) * 100 / 3}% ${legacy < 4 ? 0 : 100}%`;
    art.dataset.size = size;
    art.setAttribute('aria-hidden', 'true');
    return className ? container : art;
  }
  const standard = !item || item.id === 'standard';
  const art = append('div', container, '', 'vb-cosmetic-reward-art');
  art.dataset.kind = item?.kind || 'standard';
  art.dataset.design = item?.id || 'standard';
  art.dataset.size = size;
  art.style.setProperty('--item-color', item?.color || '#b0c6d6');
  const icon = cosmeticIcon(standard ? { id: 'standard', kind: item?.kind } : item);
  if (icon && size === 'thumb') {
    // Thumbs show the icon over the plate; the plate stays as the no-image fallback.
    art.dataset.icon = 'true';
    iconImage(art, icon);
  }
  if (standard && item?.kind !== 'reticle' && item?.kind !== 'nameplate') {
    const plate = append('div', art, '', 'vb-standard-plate');
    plate.setAttribute('aria-hidden', 'true');
    if (icon && size !== 'thumb') iconImage(plate, icon, 'vb-plate-icon');
    append('strong', plate, 'STANDARD');
    append('span', plate, KIND_WORDS[item?.kind] || 'ISSUE');
  } else if (item.kind === 'weaponSkin' || item.kind === 'characterSkin') {
    const image = append('img', art, '', 'vb-cosmetic-render');
    image.src = item.preview || `/assets/cosmetics/${item.id}.png`;
    image.alt = `${item.name} ${item.kind === 'weaponSkin' ? 'weapon' : 'character'} skin`;
    image.decoding = 'async';
    image.addEventListener('error', () => {
      image.hidden = true;
      append('span', art, `${item.name} / preview unavailable`, 'vb-cosmetic-art-unavailable');
    }, { once: true });
  } else if (item.kind === 'signature') {
    const signature = append('div', art, '', 'vb-signature-preview');
    append('span', signature, 'ELIMINATED BY', 'vb-signature-caption');
    append('strong', signature, 'YOUR CALLSIGN');
    append('span', signature, item.name, 'vb-signature-name');
    const emblem = signatureEmblem(item.id);
    emblem.setAttribute('class', 'vb-signature-insignia');
    signature.append(emblem);
  } else if (item.kind === 'sound') {
    const record = append('div', art, '', 'vb-sound-record');
    record.setAttribute('aria-hidden', 'true');
    append('span', record, 'VB');
    const wave = append('div', art, '', 'vb-sound-wave');
    wave.setAttribute('aria-hidden', 'true');
    for (const height of [22, 38, 64, 43, 82, 55, 94, 62, 38, 70, 48, 29]) {
      append('i', wave).style.setProperty('--bar-height', `${height}%`);
    }
    append('span', art, item.name, 'vb-sound-title');
  } else if (item.kind === 'reticle') {
    reticlePreview(art, standard ? null : item.reticle);
  } else if (item.kind === 'nameplate') {
    nameplateRow(art, standard ? null : item);
  } else if (item.kind === 'theme') {
    themeMock(art);
  } else if (item.kind === 'title') {
    const plate = append('div', art, '', 'vb-title-plate');
    plate.setAttribute('aria-hidden', 'true');
    if (icon && size !== 'thumb') iconImage(plate, icon, 'vb-plate-icon');
    append('span', plate, 'CALLSIGN', 'vb-title-plate-kicker');
    append('strong', plate, item.name);
  } else if (item.kind === 'attachment') {
    const plate = append('div', art, '', 'vb-part-plate');
    plate.dataset.slot = item.slot || '';
    plate.dataset.part = item.part || '';
    plate.setAttribute('aria-hidden', 'true');
    if (icon && size !== 'thumb') iconImage(plate, icon, 'vb-plate-icon');
    else append('i', plate, '', 'vb-part-glyph');
    append('span', plate, SLOT_WORDS[item.slot] || 'ATTACHMENT', 'vb-part-slot');
    append('strong', plate, item.name);
  } else {
    const plate = append('div', art, '', 'vb-standard-plate');
    plate.setAttribute('aria-hidden', 'true');
    append('strong', plate, item.name || 'REWARD');
    append('span', plate, KIND_WORDS[item.kind] || 'REWARD');
  }
  return className ? container : art;
}

export class CosmeticAudition {
  constructor(onState = () => {}) { this.onState = onState; this.version = 0; }

  stop() {
    this.version++;
    if (this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
    this.audio = null;
    this.active = null;
    this.onState(null);
  }

  async play(item, cue) {
    const key = `${item.id}:${cue}`;
    const toggleOff = this.active === key;
    this.stop();
    if (toggleOff) return;
    const version = this.version;
    const audio = this.audio = new Audio(`${item.audio || `/assets/audio/cosmetics/${item.id}/`}${cue}.ogg`);
    audio.volume = cosmeticVolume(cue);
    this.active = key;
    this.onState(key);
    audio.addEventListener('ended', () => { if (this.audio === audio) this.stop(); }, { once: true });
    try { await audio.play(); }
    catch (error) {
      if (version !== this.version) return;
      this.stop();
      throw new Error('This sound preview is unavailable. Please try again.');
    }
  }
}
