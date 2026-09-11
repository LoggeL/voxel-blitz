import { bindingLabel, matchesBinding } from '../keybindings.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../../../shared/grenade-rules.js';
import { BASTION_SHOP, bastionPurchaseId } from '../../../shared/bastion.js';
import { el, WEAPON_NAMES, THROWABLE_NAMES } from './hud-support.js';

export function buildBastionArmory(root, purchase, close) {
  const panel = el('div','vb-buy-panel vb-bastion-panel',root);
  const header = el('div','vb-buy-header',panel);
  const titles = el('div','vb-buy-titles',header);
  el('h2','vb-title',titles,'buy-title').textContent = 'BASTION SUPPLY';
  el('div','vb-sub',titles).textContent = 'Prepare together. Every purchase uses the team bank.';
  const credVal = el('span','vb-buy-credits-val',header);
  const closeBtn = el('button','vb-buy-close-btn',header); closeBtn.textContent = `CLOSE [${bindingLabel('buy')} / ESC]`;
  closeBtn.onclick = close;
  const info = el('p','vb-bastion-info',panel);
  const fields = el('div','vb-bastion-loadout',panel);
  const selectors = {};
  for (const [key,label,values,names] of [
    ['loadout','PRIMARY WEAPON',WEAPON_IDS.filter(id=>!['knife','revolver'].includes(id)),WEAPON_NAMES],
    ['throwable','OFFENSIVE THROWABLE',GRENADE_TYPE_IDS.filter(id=>id!=='smoke'),THROWABLE_NAMES],
  ]) {
    const wrap = el('label','vb-menu-field-group',fields);
    el('span','vb-label',wrap).textContent = label;
    const select = el('select','vb-select',wrap); select.setAttribute('aria-label',label);
    for(const id of values) { const option = el('option','',select); option.value=id; option.textContent=names[id]||id; }
    select.onchange = ()=>purchase(key,select.value); selectors[key]=select;
  }
  el('p','vb-bastion-info',panel).textContent = `Revolver + Pixel Pick + one smoke included. Hold ${bindingLabel('interact')} next to the core for 4 seconds to repair 200 HP ($150, twice per break).`;
  const grid = el('div','vb-bastion-upgrades',panel), cards = {};
  for(const [id,item] of Object.entries(BASTION_SHOP)) {
    const card = el('div','vb-buy-card',grid);
    el('h3','vb-buy-wname',card).textContent = item.name;
    el('p','vb-bastion-info',card).textContent = item.description;
    const button = el('button','vb-buy-btn',card); button.onclick=()=>purchase(id);
    cards[id]=button;
  }
  const ready = el('button','vb-bastion-ready',panel); ready.onclick=()=>purchase('ready');
  root.addEventListener('keydown',event=>{
    if (event.key==='Escape' || matchesBinding(event, 'buy')) { event.preventDefault();event.stopPropagation();if(!event.repeat)close(); }
    if(event.key==='Tab') {
      const list=[...root.querySelectorAll('button:not(:disabled),select:not(:disabled)')];
      const i=list.indexOf(document.activeElement); event.preventDefault();
      list[(i+(event.shiftKey?-1:1)+list.length)%list.length]?.focus();
    }
  });
  return {root,mode:'bastion',closeBtn,credVal,info,selectors,bastionCards:cards,ready,cards:{},itemOrder:[]};
}

export function syncBastionArmory(dom,state) {
  const b=state.bastion, self=state.bastionSelf; if(!b) return;
  dom.credVal.textContent = `$ ${b.credits.toLocaleString()}`;
  dom.info.textContent = `WAVE ${Math.min(8,b.wave+1)} / 8 · CORE ${Math.ceil(b.core.hp)} / ${b.core.maxHp} HP · ${b.ready}/${b.defenders} READY`;
  dom.selectors.loadout.value=self?.primary||'rifle'; dom.selectors.throwable.value=self?.throwable||'frag';
  for (const [id,item] of Object.entries(BASTION_SHOP)) {
    const bought=id==='armor'?b.armorBought:b.upgrades[id];
    dom.bastionCards[id].textContent=bought?'PURCHASED':`BUY · $${item.price}`;
    dom.bastionCards[id].disabled=!!bought||b.credits<item.price;
  }
  dom.ready.textContent=self?.ready?'READY · WAITING FOR TEAM':'READY FOR NEXT WAVE';dom.ready.disabled=!!self?.ready;
}
export { bastionPurchaseId };
