import { TTT_SHOP } from '../../../shared/ttt.js';
import { el } from './hud-support.js';
import { matchesBinding } from '../keybindings.js';

const ICONS = {
  c4: '<rect x="6" y="14" width="36" height="27" rx="3"/><path d="M15 14V8h19v6M13 30h22M24 22v16"/><rect x="15" y="18" width="18" height="7"/>',
  radar: '<circle cx="24" cy="24" r="19"/><circle cx="24" cy="24" r="11"/><path d="M24 5v19l14-12M24 21v6m-3-3h6"/><circle cx="12" cy="30" r="2"/><circle cx="34" cy="31" r="2"/>',
  disguiser: '<path d="M8 10q16-8 32 0v13c0 10-9 17-16 21C17 40 8 33 8 23Z"/><path d="M13 20q5-5 10 0-5 6-10 0Zm12 0q5-5 10 0-5 6-10 0Z"/>',
  teleporter: '<ellipse cx="24" cy="37" rx="19" ry="7"/><path d="M18 31V5m-7 7 7-7 7 7M30 8v26m-7-7 7 7 7-7"/>',
  armor: '<path d="m24 4 17 7v11c0 11-10 18-17 22C17 40 7 33 7 22V11Z"/><path d="m15 23 6 6 12-14"/>',
  health: '<path d="M18 5h12v13h13v12H30v13H18V30H5V18h13Z"/>',
  ammo: '<path d="M8 42V15l4-10 4 10v27Zm16 0V15l4-10 4 10v27Zm16 0V15l4-10 4 10v27M8 31h8m8 0h8m8 0h8"/>',
};
function icon(parent, id) {
  const span = el('span', 'vb-ttt-icon', parent);
  span.innerHTML = `<svg viewBox="0 0 52 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[id]}</svg>`;
  return span;
}
export function buildTttShop(root, purchase, close) {
  const panel = el('div', 'vb-buy-panel vb-ttt-shop', root);
  const header = el('div', 'vb-buy-header', panel);
  const titles = el('div', 'vb-ttt-titles', header);
  el('p', 'vb-ttt-eyebrow', titles).textContent = 'VERDECKTE AUSRÜSTUNG';
  el('h2', 'vb-title', titles, 'buy-title').textContent = 'TRAITOR-SHOP';
  const credVal = el('p', 'vb-ttt-credit', header);
  const closeBtn = el('button', 'vb-buy-close-btn', header); closeBtn.textContent = 'SCHLIESSEN'; closeBtn.onclick = close;
  const body = el('div', 'vb-ttt-catalog', panel);
  const grid = el('div', 'vb-ttt-grid', body), cards = {};
  const detail = el('div', 'vb-ttt-detail', body);
  const category = el('p', 'vb-ttt-eyebrow', detail);
  const detailTitle = el('h3', '', detail);
  const illustration = el('div', 'vb-ttt-illustration', detail);
  const description = el('p', 'vb-ttt-description', detail);
  const status = el('p', 'vb-ttt-status', detail); status.setAttribute('aria-live', 'polite');
  const buyButton = el('button', 'vb-buy-btn', detail, 'ttt-buy');
  const equipment = el('div', 'vb-ttt-equipment', panel);
  const equipmentTitle = el('p', 'vb-ttt-eyebrow', equipment); equipmentTitle.textContent = 'DEINE GADGETS';
  const gearStatus = el('p', 'vb-ttt-gear-status', equipment);
  const actionBar = el('div', 'vb-ttt-actions', equipment);
  const disguise = el('button', 'vb-ttt-action', actionBar, 'ttt-disguise');
  const c4 = el('button','vb-ttt-action',actionBar,'ttt-c4');c4.textContent='C4 PLATZIEREN · 45 S';c4.onclick=()=>purchase('c4-place');
  const mark = el('button', 'vb-ttt-action', actionBar, 'ttt-mark'); mark.textContent = 'PUNKT MERKEN';
  const recall = el('button', 'vb-ttt-action', actionBar, 'ttt-recall');
  const trapSection = el('div', 'vb-ttt-traps', panel, 'ttt-shop-traps');
  el('p', 'vb-ttt-eyebrow', trapSection).textContent = 'FALLEN DER KARTE · NUR FÜR TRAITOR';
  const trapRows = el('div', 'vb-ttt-trap-rows', trapSection);
  const dom = { trapSection, trapRows, root, mode: 'ttt', closeBtn, credVal, cards: {}, itemOrder: [], tttCards: cards,
    selected: 'radar', category, detailTitle, illustration, description, status, buyButton,
    gearStatus, disguise, mark, recall, c4, state: {} };
  for (const [id, item] of Object.entries(TTT_SHOP)) {
    const card = el('button', 'vb-ttt-item', grid); card.dataset.tttItem = id;
    icon(card, id);
    el('span', 'vb-ttt-item-name', card).textContent = item.name;
    el('span', 'vb-ttt-item-type', card).textContent = item.category;
    const stock = el('span', 'vb-ttt-stock', card);
    card.onclick = () => { dom.selected = id; syncTttShop(dom, dom.state); };
    cards[id] = { card, stock };
  }
  buyButton.onclick = () => purchase(dom.selected);
  disguise.onclick = () => purchase(dom.state.ttt?.disguised ? 'disguise-off' : 'disguise-on');
  mark.onclick = () => purchase('teleport-mark');
  recall.onclick = () => purchase('teleport-return');
  root.onkeydown = event => {
    if (event.key === 'Escape' || matchesBinding(event, 'buy')) {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) close();
    }
    if (event.key === 'Tab') {
      const list = [...root.querySelectorAll('button:not(:disabled)')].filter(b => !b.hidden);
      const i = list.indexOf(document.activeElement); event.preventDefault();
      list[(i + (event.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
    }
  };
  syncTttShop(dom, {});
  return dom;
}
export function syncTttShop(dom, state) {
  dom.state = state;
  const ttt = state.ttt || {}, owned = ttt.equipment || [], item = TTT_SHOP[dom.selected];
  const hasItem = !!item.permanent && owned.includes(dom.selected);
  dom.credVal.textContent = `${ttt.credits ?? 0} ${ttt.credits === 1 ? 'CREDIT' : 'CREDITS'}`;
  for (const [id, { card, stock }] of Object.entries(dom.tttCards)) {
    const selected = id === dom.selected;
    card.setAttribute('aria-pressed', String(selected));
    stock.textContent = owned.includes(id) ? 'IM BESITZ' : `${TTT_SHOP[id].price} CREDIT`;
  }
  dom.category.textContent = item.category;
  dom.detailTitle.textContent = item.name;
  if (dom.illustration.dataset.item !== dom.selected) {
    dom.illustration.replaceChildren(); icon(dom.illustration, dom.selected);
    dom.illustration.dataset.item = dom.selected;
  }
  dom.description.textContent = item.description;
  dom.status.textContent = hasItem ? 'Für diese Runde ausgerüstet.' : item.permanent ? 'Einmal kaufen · Bis zum Rundenende' : 'Sofort nutzbar · Bei Bedarf nachkaufen';
  dom.buyButton.textContent = hasItem ? 'AUSGERÜSTET' : `KAUFEN · ${item.price} CREDIT`;
  dom.buyButton.disabled = hasItem || (ttt.credits ?? 0) < item.price;
  dom.c4.hidden=!owned.includes('c4');dom.c4.disabled=!ttt.c4;
  dom.c4.textContent=ttt.c4?'C4 PLATZIEREN · 45 S':'C4 BEREITS PLATZIERT';
  dom.disguise.hidden = !owned.includes('disguiser');
  dom.disguise.textContent = ttt.disguised ? 'TARNUNG AUSSCHALTEN' : 'TARNUNG EINSCHALTEN';
  dom.disguise.setAttribute('aria-pressed', String(!!ttt.disguised));
  const tele = ttt.teleporter;
  dom.mark.hidden = dom.recall.hidden = !tele;
  dom.mark.disabled = !!tele && tele.uses <= 0;
  dom.recall.textContent = !tele?.mark ? 'ZUERST PUNKT MERKEN' : tele.cooldown > 0 ? `BEREIT IN ${tele.cooldown} S` : `ZURÜCK · ${tele.uses} LADUNGEN`;
  dom.recall.disabled = !tele?.mark || tele.uses <= 0 || tele.cooldown > 0;
  const info = [];
  if (owned.includes('radar')) info.push('Radar scannt automatisch');
  if (owned.includes('disguiser')) info.push(ttt.disguised ? 'Identität verborgen' : 'Identität sichtbar');
  if(owned.includes('c4'))info.push(ttt.c4?'C4: bereit zum Platzieren':'C4: Ladung verbraucht');
  if (tele) info.push(tele.mark ? 'Rückkehrpunkt gespeichert' : 'Teleporter: Bodenpunkt merken');
  dom.gearStatus.textContent = info.join(' · ') || 'Wähle deine Ausrüstung. Zwei Credits pro Runde.';
  const traps = ttt.traps || [];
  dom.trapSection.hidden = !traps.length;
  const rows = traps.map(t => `${t.id}:${t.state}:${t.cooldown}`).join('|');
  if (dom.trapRowsKey !== rows) {
    dom.trapRowsKey = rows;
    dom.trapRows.replaceChildren(...traps.map(t => {
      const row = el('p', 'vb-ttt-trap-row'); row.dataset.state = t.state;
      row.textContent = `${t.name} — ${t.detail} · ${t.state === 'ready' ? 'BEREIT' : t.state === 'cooldown' ? `BEREIT IN ${t.cooldown} S` : 'VERBRAUCHT'} · Taste am Schalter`;
      return row;
    }));
  }
}
