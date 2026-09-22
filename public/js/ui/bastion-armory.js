import { bindingLabel, matchesBinding } from '../keybindings.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../../../shared/grenade-rules.js';
import { BASTION_SHOP, bastionPurchaseId } from '../../../shared/bastion.js';
import { BASTION_STRUCTURES } from '../../../shared/bastion-build.js';
import { el, WEAPON_NAMES, THROWABLE_NAMES } from './hud-support.js';

const BUDGET_LINE = { sandbag: 'barricadeVoxels', wall: 'barricadeVoxels', turret: 'turrets', crate: 'crates' };

/** Sections in order: LOADOUT · TEAM UPGRADES · FORTIFICATIONS · READY. */
export function buildBastionArmory(root, purchase, close, onSelectStructure = null) {
  const panel = el('div','vb-buy-panel vb-bastion-panel',root);
  const header = el('div','vb-buy-header',panel);
  const titles = el('div','vb-buy-titles',header);
  el('h2','vb-title',titles,'buy-title').textContent = 'BASTION SUPPLY';
  el('div','vb-sub',titles).textContent = 'Prepare together. Every purchase uses the team bank.';
  const credVal = el('span','vb-buy-credits-val',header);
  const closeBtn = el('button','vb-buy-close-btn',header); closeBtn.textContent = `CLOSE [${bindingLabel('buy')} / ESC]`;
  closeBtn.onclick = close;
  const info = el('p','vb-bastion-info',panel);
  el('h3','vb-bastion-section',panel).textContent = 'LOADOUT';
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
  el('p','vb-bastion-info',panel).textContent = `Revolver + Pixel Pick + one smoke included. Hold ${bindingLabel('interact')} next to the objective for 4 seconds to repair 200 HP ($150, twice per break).`;
  el('h3','vb-bastion-section',panel).textContent = 'TEAM UPGRADES';
  const grid = el('div','vb-bastion-upgrades',panel), cards = {};
  for(const [id,item] of Object.entries(BASTION_SHOP)) {
    const card = el('div','vb-buy-card',grid);
    el('h3','vb-buy-wname',card).textContent = item.name;
    el('p','vb-bastion-info',card).textContent = item.description;
    const button = el('button','vb-buy-btn',card); button.onclick=()=>purchase(id);
    cards[id]=button;
  }
  el('h3','vb-bastion-section',panel).textContent = 'FORTIFICATIONS';
  el('p','vb-bastion-info',panel).textContent = `Select a blueprint, then aim at the floor inside the build zone: [${bindingLabel('build')}] cycles blueprints, [${bindingLabel('reload')}] rotates, click places. Budgets reset every stage.`;
  const structures = el('div','vb-bastion-structures',panel), structureCards = {};
  for (const [kind,item] of Object.entries(BASTION_STRUCTURES)) {
    const card = el('div','vb-buy-card',structures); card.dataset.kind = kind;
    el('h3','vb-buy-wname',card).textContent = item.name;
    const budget = el('div','vb-bastion-budget',card);
    el('p','vb-bastion-info',card).textContent = item.description;
    const button = el('button','vb-buy-btn',card);
    button.onclick = () => { if (!button.disabled) onSelectStructure?.(kind); };
    structureCards[kind] = { card, budget, button };
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
  return {root,mode:'bastion',closeBtn,credVal,info,selectors,bastionCards:cards,structureCards,ready,cards:{},itemOrder:[],selectedKind:null};
}

/** `used/max` for one structure kind from `match.bastion.budget`; missing lines read as open. */
export function structureBudget(budget, kind) {
  const line = budget?.[BUDGET_LINE[kind]];
  const def = BASTION_STRUCTURES[kind];
  if (!line || !def) return { used: 0, max: Infinity, full: false, text: '' };
  const cells = def.kind === 'block' ? def.width * def.height : 1;
  const full = def.kind === 'block' ? line.used + cells > line.max : line.used >= line.max;
  const text = def.kind === 'block' ? `${line.used}/${line.max} VOXELS` : `${line.used}/${line.max} BUILT`;
  return { used: line.used, max: line.max, full, text };
}

export function syncBastionArmory(dom,state) {
  const b=state.bastion, self=state.bastionSelf; if(!b) return;
  const stage=b.stage, core=b.core||{};
  dom.credVal.textContent = `$ ${(b.credits|0).toLocaleString()}`;
  const stageText = stage ? `STAGE ${stage.index+1} / ${stage.count} · WAVE ${Math.min(stage.waves,stage.wave+1)} / ${stage.waves}` : `WAVE ${b.wave+1} / ${b.waves||8}`;
  dom.info.textContent = `${stageText} · ${core.name||'OBJECTIVE'} ${Math.ceil(core.hp||0)} / ${core.maxHp||0} HP · ${b.ready}/${b.defenders} READY`;
  dom.selectors.loadout.value=self?.primary||'rifle'; dom.selectors.throwable.value=self?.throwable||'frag';
  for (const [id,item] of Object.entries(BASTION_SHOP)) {
    const bought=id==='armor'?b.armorBought:b.upgrades?.[id];
    dom.bastionCards[id].textContent=bought?'PURCHASED':`BUY · $${item.price}`;
    dom.bastionCards[id].disabled=!!bought||b.credits<item.price;
  }
  for (const [kind,item] of Object.entries(BASTION_STRUCTURES)) {
    const card=dom.structureCards?.[kind]; if(!card) continue;
    const budget=structureBudget(b.budget,kind);
    card.budget.textContent=budget.text;
    const short=b.credits<item.price;
    card.button.disabled=budget.full||short;
    card.button.textContent=budget.full?'BUDGET SPENT':short?`NEED $${item.price}`:`SELECT · $${item.price}`;
    if (dom.selectedKind===kind) card.card.dataset.selected='true'; else delete card.card.dataset.selected;
  }
  dom.ready.textContent=self?.ready?'READY · WAITING FOR TEAM':stage?.transition==='regroup'?'READY TO FALL BACK':'READY FOR NEXT WAVE';
  dom.ready.disabled=!!self?.ready;
}
export { bastionPurchaseId };
