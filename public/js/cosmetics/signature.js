import { CAREER_CATALOG } from '../../../shared/career.js';

const EMBLEMS = {
  ignition: 'M32 5 16 30h13L22 59l29-35H36l9-19Z',
  circuit: 'M32 5 55 18v28L32 59 9 46V18Zm0 11L19 24v16l13 8 13-8V24Zm0 8 7 8-7 8-7-8Z',
  sovereign: 'M7 18 21 29 32 8 43 29 57 18 50 47H14Zm9 35h32v5H16Z',
};

export function signatureItem(id) {
  return CAREER_CATALOG.find(item => item.kind === 'signature' && item.id === id) || null;
}

export function signatureEmblem(id, doc = document) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', EMBLEMS[id] || EMBLEMS.ignition);
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);
  return svg;
}

export function createDeathSignature(id, doc = document) {
  const item = signatureItem(id);
  if (!item) return null;
  const card = doc.createElement('div');
  card.className = 'vb-death-signature'; card.dataset.signature = id;
  card.style.setProperty('--signature-color', item.color || '#ffb347');
  card.append(signatureEmblem(id, doc));
  const words = doc.createElement('div');
  const label = doc.createElement('small'); label.textContent = `${item.rarity || 'rare'} SIGNATURE`.toUpperCase();
  const title = doc.createElement('strong'); title.textContent = item.name;
  words.append(label, title); card.append(words);
  return card;
}
