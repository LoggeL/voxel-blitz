// Bastion client UI without a browser: HUD labels and repair prompt, armory budgets,
// the shared shop window and armory keyboard focus across shop-mode rebuilds.
import assert from 'node:assert/strict';
import { BASTION_RULES as R, BASTION_ENEMIES } from '../shared/bastion.js';
import { BASTION_STRUCTURES } from '../shared/bastion-build.js';
import { MODE_IDS, buyWindowOpen } from '../shared/modes.js';

// Just enough DOM for the Bastion HUD and the buy dialog: capture listeners on
// document, `onkeydown` plus bubbling listeners on elements, and a selector
// matcher for `tag`, `.class`, `#id` and `:not(:disabled)`.
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase(); this.children = []; this.parentNode = null;
    this.classes = new Set(); this.style = {}; this.dataset = {}; this.attrs = new Map(); this.listeners = [];
    this.id = ''; this.value = ''; this.disabled = false; this.hidden = false; this.onkeydown = null; this._text = '';
    this.classList = {
      add: (...n) => n.forEach(c => this.classes.add(c)), remove: (...n) => n.forEach(c => this.classes.delete(c)),
      contains: c => this.classes.has(c),
      toggle: (c, on = !this.classes.has(c)) => { if (on) this.classes.add(c); else this.classes.delete(c); return on; },
    };
  }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v ?? ''); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { this.textContent = ''; this.markup = String(v); }   // icons only; never parsed
  appendChild(c) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  replaceChildren(...nodes) { this.textContent = ''; nodes.forEach(n => this.appendChild(n)); }
  remove() { this.parentNode?.removeChild(this); }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) { this.listeners.push({ type, fn }); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter(l => l.type !== type || l.fn !== fn); }
  focus() { document.activeElement = this; }
  matches(selector) {
    return selector.split(',').some(part => {
      const s = part.trim(), enabledOnly = s.includes(':not(:disabled)'), base = s.replace(':not(:disabled)', '');
      const tag = base.match(/^[a-z]+/i)?.[0], id = base.match(/#([\w-]+)/)?.[1];
      const classes = [...base.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
      return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id)
        && classes.every(c => this.classes.has(c)) && !(enabledOnly && this.disabled);
    });
  }
  querySelectorAll(selector) {
    const out = [], visit = n => n.children.forEach(c => { if (c.matches(selector)) out.push(c); visit(c); });
    visit(this); return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const document = {
  body: new FakeElement('body'), activeElement: null, listeners: [],
  createElement: tag => new FakeElement(tag),
  getElementById(id) { return this.body.id === id ? this.body : this.body.querySelectorAll(`#${id}`)[0] ?? null; },
  addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: !!capture }); },
  removeEventListener(type, fn, capture) { this.listeners = this.listeners.filter(l => l.type !== type || l.fn !== fn || l.capture !== !!capture); },
};
globalThis.document = document;
globalThis.window = { addEventListener() {}, removeEventListener() {} };
// Capture on document, then target and ancestors (property handler, then listeners), then document bubble.
function press(key, extra = {}) {
  const target = document.activeElement ?? document.body;
  const ev = { type: 'keydown', key, code: key, repeat: false, shiftKey: false, target, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
  for (const l of document.listeners) if (l.type === 'keydown' && l.capture && !ev.stopped) l.fn(ev);
  for (let n = target; n && !ev.stopped; n = n.parentNode) {
    n.onkeydown?.(ev);
    for (const l of n.listeners) if (l.type === 'keydown' && !ev.stopped) l.fn(ev);
  }
  for (const l of document.listeners) if (l.type === 'keydown' && !l.capture && !ev.stopped) l.fn(ev);
  return ev;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const { bindingLabel } = await import('../public/js/keybindings.js');
const { updateBastionHud, bastionVehicleSummary, bastionLaneName } = await import('../public/js/ui/bastion-hud.js');
const { structureBudget } = await import('../public/js/ui/bastion-armory.js');
const { BuyMenuController } = await import('../public/js/ui/buy-menu.js');

{
  // One shop window for every mode; liveness stays with each caller.
  const open = MODE_IDS.flatMap(mode => ['prep', 'live', 'supply', 'post'].flatMap(phase =>
    [null, 'traitor'].filter(role => buyWindowOpen(mode, phase, role)).map(role => `${mode}:${phase}${role ? ':' + role : ''}`)));
  assert.deepEqual(open.sort(), ['ttt:live:traitor', 'chaos:live', 'chaos:live:traitor', 'snd:prep', 'snd:prep:traitor',
    'bastion:prep', 'bastion:prep:traitor', 'bastion:supply', 'bastion:supply:traitor'].sort());
  assert.equal(buyWindowOpen(undefined, 'prep'), false);
  console.log('ok: shared shop window matrix');
}
{
  const budget = { barricadeVoxels: { used: 0, max: R.build.barricadeVoxels }, turrets: { used: 1, max: 2 }, crates: { used: 1, max: 1 } };
  const wall = BASTION_STRUCTURES.wall, cells = wall.width * wall.height;
  assert.deepEqual(structureBudget(budget, 'wall'), { used: 0, max: R.build.barricadeVoxels, full: false, text: `0/${R.build.barricadeVoxels} VOXELS` });
  const atEdge = { ...budget, barricadeVoxels: { used: R.build.barricadeVoxels - cells, max: R.build.barricadeVoxels } };
  assert.equal(structureBudget(atEdge, 'wall').full, false, 'a wall that exactly fills the budget is still allowed');
  const over = { ...budget, barricadeVoxels: { used: R.build.barricadeVoxels - cells + 1, max: R.build.barricadeVoxels } };
  assert.equal(structureBudget(over, 'wall').full, true, 'one voxel short blocks the wall');
  assert.equal(structureBudget(over, 'sandbag').full, false, 'the smaller sandbag line still fits');
  assert.deepEqual(structureBudget(budget, 'turret'), { used: 1, max: 2, full: false, text: '1/2 BUILT' });
  assert.equal(structureBudget(budget, 'crate').full, true);
  assert.deepEqual(structureBudget(null, 'turret'), { used: 0, max: Infinity, full: false, text: '' }, 'missing budget reads as open');
  assert.equal(structureBudget(budget, 'bogus').full, false);
  assert.equal(bastionVehicleSummary([{ kind: 'buggy' }, { kind: 'apc' }, { kind: 'buggy' }]),
    `${BASTION_ENEMIES.buggy.name} ×2 · ${BASTION_ENEMIES.apc.name} ×1`);
  assert.equal(bastionVehicleSummary([]), '');assert.equal(bastionVehicleSummary(null), '');
  assert.equal(bastionVehicleSummary([{ kind: 'hover-tank' }]), 'HOVER-TANK ×1');
  assert.equal(bastionLaneName({ north: 'NORTH GATE' }, 'north'), 'NORTH GATE');
  assert.equal(bastionLaneName({}, 'east-dock'), 'EAST DOCK');assert.equal(bastionLaneName(null, null), '');
  console.log('ok: armory budgets, vehicle summary and lane names');
}
{
  const bag = () => Object.fromEntries(['alphaBlock', 'bravoBlock', 'alphaName', 'alphaRole', 'alphaScore', 'bravoName', 'bravoRole',
    'bravoScore', 'phaseLabel', 'clock', 'bombBanner', 'creditsBox', 'creditsVal', 'interactBar', 'interactLabel', 'interactFill']
    .map(k => [k, new FakeElement('div')]).concat([['buyPrompt', document.body.appendChild(new FakeElement('div'))]]));
  const core = { name: 'REACTOR', x: 64, y: 10, z: 40, hp: 500, maxHp: 1000 };
  const match = (phase, extra = {}) => ({ mode: 'bastion', phase, phaseEndsAt: 20000,
    bastion: { core, credits: 400, repairs: 0, ready: 1, defenders: 2, alive: 3, remaining: 5, lanes: ['north'],
      stage: { index: 0, count: 3, name: 'REACTOR', kind: 'hold', wave: 1, waves: 3, lane: 'north' },
      budget: { barricadeVoxels: { used: 6, max: 48 }, turrets: { used: 0, max: 2 }, crates: { used: 0, max: 1 } }, ...extra } });
  const self = (dx, extra = {}) => ({ state: 'alive', x: core.x + dx, y: core.y, z: core.z, bastion: {}, ...extra });
  const hud = (mt, s, ctx = {}) => { const m = bag(); updateBastionHud(m, mt, s, 10000, { localNow: 0, laneNames: { north: 'NORTH GATE' }, ...ctx }); return m; };
  const interact = bindingLabel('interact'), ready = `1/2 READY · [${bindingLabel('buy')}] SUPPLY · [${bindingLabel('build')}] BUILD`;

  let m = hud(match('prep'), self(2));
  assert.equal(m.phaseLabel.textContent, 'STAGE 1 / 3 · REACTOR · PREPARE');
  assert.equal(m.bombBanner.textContent, `HOLD ${interact} TO REPAIR ($${R.repairPrice})`);
  assert.equal(m.buyPrompt.style.display, 'block');assert.equal(m.buildPrompt.textContent, 'WALLS 6/48 · TURRETS 0/2 · CRATE 0/1');
  // The prompt follows the server's 3D repair radius, not a looser flat circle.
  assert.equal(hud(match('prep'), self(R.repairRadius + 0.5)).bombBanner.textContent, ready, 'outside the repair radius');
  assert.equal(hud(match('prep'), self(1, { y: core.y + 5 })).bombBanner.textContent, ready, 'no repair prompt from the roof');
  assert.equal(hud(match('prep'), self(1, { state: 'dead' })).bombBanner.textContent, ready, 'no repair prompt while dead');
  assert.equal(hud(match('supply', { repairs: R.repairLimit }), self(1)).bombBanner.textContent, `REPAIRS USED · ${R.repairLimit} PER BREAK`);
  assert.equal(hud(match('supply', { credits: R.repairPrice - 1 }), self(1)).bombBanner.textContent, `REPAIR NEEDS $${R.repairPrice}`);
  m = hud(match('supply', { credits: 0 }), self(1, { interaction: { kind: 'repair', progress: 0.5 } }));
  assert.equal(m.bombBanner.textContent, `HOLD ${interact} TO REPAIR ($${R.repairPrice})`, 'own running repair keeps its prompt');
  assert.equal(m.interactBar.style.display, 'block');assert.equal(m.interactFill.style.width, '50%');
  assert.equal(m.phaseLabel.textContent, 'STAGE 1 / 3 · WAVE 2 / 3 · SUPPLY');

  m = hud(match('live', { vehicles: [{ kind: 'buggy' }] }), self(1));
  assert.equal(m.bombBanner.textContent, 'NORTH GATE BREACH');assert.equal(m.buyPrompt.style.display, 'none');
  assert.equal(m.bravoRole.textContent, `3 ACTIVE / 2 INBOUND · ${BASTION_ENEMIES.buggy.name} ×1`);
  const extract = { index: 2, count: 3, name: 'BEACON', kind: 'extract', wave: 0, waves: 1, holdEndsAt: 20000 };
  m = hud(match('live', { stage: extract }), self(1));
  assert.equal(m.phaseLabel.textContent, 'EXTRACTION · 0:10');assert(m.phaseLabel.classList.contains('vb-bastion-urgent'));
  assert.equal(hud(match('live', { stage: { ...extract, holdEndsAt: 5000 } }), self(1)).phaseLabel.textContent, 'SHUTTLE HERE · GET TO THE BEACON');
  m = hud(match('post'), self(1));
  assert.equal(m.phaseLabel.textContent, 'RUN COMPLETE');assert.equal(m.bombBanner.textContent, 'REACTOR');
  assert.equal(hud(match('prep'), self(2), { banner: { text: 'STRUCTURE LOST', until: 1 } }).bombBanner.textContent, 'STRUCTURE LOST');
  console.log('ok: Bastion HUD phase labels and authoritative repair prompt');
}
{
  // Tab moves focus exactly one control, selects included, however often the
  // shared #buy-menu root was rebuilt for other shop modes.
  const snapshot = { run: 'r', prep: 1, wave: 0, waves: 7, credits: 900, ready: 0, defenders: 1, upgrades: {}, core: { name: 'CORE', hp: 500, maxHp: 1000 },
    stage: { index: 0, count: 3, wave: 0, waves: 3 }, budget: { barricadeVoxels: { used: 0, max: 48 }, turrets: { used: 0, max: 2 }, crates: { used: 0, max: 1 } } };
  const cycle = async (menu, host) => {
    host.current = 'bastion';
    menu.setBuyMenuState({ open: true, phase: 'prep', bastion: snapshot, bastionSelf: { request: 0 } });
    await settle();
    assert(menu.isBuyMenuOpen() && menu.buyDom.mode === 'bastion');
    const order = menu.buyDom.root.querySelectorAll('button:not(:disabled),select:not(:disabled)');
    assert(order.filter(n => n.tagName === 'SELECT').length === 2, 'both loadout selects are focusable');
    assert.equal(document.activeElement, menu.buyDom.closeBtn);
    for (let i = 1; i <= order.length; i++) {
      const ev = press('Tab');
      assert(ev.defaultPrevented);
      assert.equal(document.activeElement, order[i % order.length], `Tab ${i} lands on control ${i % order.length}`);
    }
    press('Tab', { shiftKey: true });assert.equal(document.activeElement, order.at(-1), 'Shift+Tab wraps back once');
    const esc = press('Escape');assert(esc.defaultPrevented && !menu.isBuyMenuOpen(), 'Escape closes the armory');
  };
  const leave = async (menu, host, mode, state) => { host.current = mode; menu.setBuyMenuState(state); await settle();
    assert.equal(menu.buyDom.mode, mode); menu.toggleBuyMenu(false); };
  for (const startMode of [null, 'bastion']) {
    const host = { current: startMode, mode: () => host.current, isAlive: () => true, settingsOpen: () => false, isLobbyOpen: () => false };
    const menu = new BuyMenuController(host);
    menu.setupBuyMenu({ onBuy: () => true, onClose() {} });
    await cycle(menu, host);
    await leave(menu, host, 'ttt', { open: true, phase: 'live', ttt: { role: 'traitor', credits: 1 } });
    await cycle(menu, host);
    await cycle(menu, host);   // same-mode reopen without a rebuild
    await leave(menu, host, 'snd', { open: true, phase: 'prep', credits: 800, owned: [] });
    assert.equal(menu.buyDom.root.onkeydown, null, 'the S&D armory does not inherit a Bastion key handler');
    await cycle(menu, host);
    menu.dispose();
    assert.equal(document.listeners.length, 0);document.body.textContent = '';document.activeElement = null;
  }
  console.log('ok: armory Tab order across snd/ttt/bastion rebuilds');
}
console.log('Bastion UI tests passed');
