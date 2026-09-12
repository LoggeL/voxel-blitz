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

/** New rewards always use their own artwork. Legacy atlas positions are stable IDs. */
export function cosmeticArtwork(parent, item, className = '') {
  const container = className ? append('div', parent, '', className) : parent;
  const legacy = LEGACY_ART.indexOf(item?.id);
  if (legacy >= 0) {
    const art = append('div', container, '', 'vb-cosmetic-art');
    art.style.backgroundPosition = `${(legacy % 4) * 100 / 3}% ${legacy < 4 ? 0 : 100}%`;
    art.setAttribute('aria-hidden', 'true');
    return className ? container : art;
  }
  const art = append('div', container, '', 'vb-cosmetic-reward-art');
  art.dataset.kind = item?.kind || 'standard';
  art.dataset.design = item?.id || 'standard';
  art.style.setProperty('--item-color', item?.color || '#b0c6d6');
  if (item?.kind === 'weaponSkin' || item?.kind === 'characterSkin') {
    const image = append('img', art, '', 'vb-cosmetic-render');
    image.src = item.preview || `/assets/cosmetics/${item.id}.png`;
    image.alt = `${item.name} ${item.kind === 'weaponSkin' ? 'weapon' : 'character'} skin`;
    image.decoding = 'async';
    image.addEventListener('error', () => {
      image.hidden = true;
      append('span', art, `${item.name} / preview unavailable`, 'vb-cosmetic-art-unavailable');
    }, { once: true });
  } else if (item?.kind === 'signature') {
    const signature = append('div', art, '', 'vb-signature-preview');
    append('span', signature, 'ELIMINATED BY', 'vb-signature-caption');
    append('strong', signature, 'YOUR CALLSIGN');
    append('span', signature, item.name, 'vb-signature-name');
    const emblem = signatureEmblem(item.id);
    emblem.setAttribute('class', 'vb-signature-insignia');
    signature.append(emblem);
  } else if (item?.kind === 'sound') {
    const record = append('div', art, '', 'vb-sound-record');
    record.setAttribute('aria-hidden', 'true');
    append('span', record, 'VB');
    const wave = append('div', art, '', 'vb-sound-wave');
    wave.setAttribute('aria-hidden', 'true');
    for (const height of [22, 38, 64, 43, 82, 55, 94, 62, 38, 70, 48, 29]) {
      append('i', wave).style.setProperty('--bar-height', `${height}%`);
    }
    append('span', art, item.name, 'vb-sound-title');
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
