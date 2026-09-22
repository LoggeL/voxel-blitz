import assert from 'node:assert/strict';
import { CAREER_CATALOG, LOADOUT_SLOTS, careerView, reconcileCareerUnlocks, xpForLevel, treeNode } from '../shared/career.js';
import { emptyProfile } from '../server/persistence/career-profile.js';

// Minimal DOM: enough for cosmeticArtwork and WeaponBench, no browser.
const kebab = key => key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = {};
    this.ownText = ''; this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    this.dataset = new Proxy({}, {
      get: (_, key) => typeof key === 'string' ? this.attributes.get(`data-${kebab(key)}`) : undefined,
      set: (_, key, value) => { this.attributes.set(`data-${kebab(key)}`, String(value)); return true; },
      deleteProperty: (_, key) => this.attributes.delete(`data-${kebab(key)}`),
      has: (_, key) => this.attributes.has(`data-${kebab(key)}`),
    });
  }
  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.attributes.set('class', value); }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', value); }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this.ownText = String(value); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  append(...nodes) { for (const n of nodes) { n.parentNode?.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = this; this.children.push(n); } }
  replaceChildren(...nodes) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (let n = this; n; n = n.parentNode) for (const fn of n.listeners[type] || []) fn(event);
    return event;
  }
  click() { this.dispatch('click'); }
  focus() { const before = document.activeElement; document.activeElement = this; if (before !== this) this.dispatch('focusin'); }
  matches(selector) { return matchChain(this, selector.trim().split(/\s+/)); }
  closest(selector) { for (let n = this; n; n = n.parentNode) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = [], walk = n => { for (const c of n.children) { if (c.matches(selector)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function matchCompound(node, compound) {
  const tokens = compound.match(/^[a-z0-9-]+|\.[\w-]+|#[\w-]+|\[[^\]]+\]/gi) || [];
  return tokens.every(token => {
    if (token[0] === '.') return node.className.split(/\s+/).includes(token.slice(1));
    if (token[0] === '#') return node.id === token.slice(1);
    if (token[0] === '[') {
      const [, key, value] = token.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
      return value === undefined ? node.attributes.has(key) : node.attributes.get(key) === value;
    }
    return node.tagName === token.toUpperCase();
  });
}
function matchChain(node, parts) {
  if (!matchCompound(node, parts.at(-1))) return false;
  if (parts.length === 1) return true;
  for (let n = node.parentNode; n; n = n.parentNode) if (matchChain(n, parts.slice(0, -1))) return true;
  return false;
}
globalThis.document = { activeElement: null, createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag) };

const { cosmeticArtwork } = await import('../public/js/ui/cosmetic-preview.js');
const { WeaponBench, BENCH_SAVE_DELAY, benchLockText } = await import('../public/js/ui/armory/weapon-bench.js');

// ---------- cosmeticArtwork: non-empty art for every item and every kind ----------
const nonEmpty = art => art.children.length > 0 || !!art.style.backgroundPosition;
for (const size of ['thumb', 'stage']) {
  for (const item of CAREER_CATALOG) {
    const host = new Node('div');
    const art = cosmeticArtwork(host, item, '', { size });
    assert.ok(nonEmpty(art), `${item.id} (${item.kind}) renders art at ${size}`);
    assert.equal(art.dataset.size, size);
    assert.equal(host.children.length, 1, `${item.id} adds exactly one tile`);
  }
  for (const slot of LOADOUT_SLOTS) {
    const art = cosmeticArtwork(new Node('div'), slot.standard === 'standard' ? { id: 'standard', kind: slot.id, name: 'Standard' } : treeNode(slot.standard), '', { size });
    assert.ok(nonEmpty(art), `standard ${slot.id} renders art at ${size}`);
  }
  for (const kind of ['weaponSkin', 'attachment']) assert.ok(nonEmpty(cosmeticArtwork(new Node('div'), { id: 'standard', kind }, '', { size })));
}
const kinds = new Set(CAREER_CATALOG.map(item => item.kind));
for (const kind of ['weaponSkin', 'characterSkin', 'attachment', 'theme', 'title', 'reticle', 'nameplate', 'signature', 'sound']) assert.ok(kinds.has(kind), `${kind} is in the catalog`);
assert.ok(nonEmpty(cosmeticArtwork(new Node('div'), null)), 'a missing item still shows a standard plate');

// Wrapped variant keeps its old contract: returns the container.
const wrapper = cosmeticArtwork(new Node('div'), treeNode('ember'), 'vb-slot-thumb', { size: 'thumb' });
assert.equal(wrapper.className, 'vb-slot-thumb');
assert.equal(wrapper.children[0].className, 'vb-cosmetic-reward-art');

// Legacy atlas pins and the weapon-skin fallback are unchanged.
const legacy = ['amber', 'arctic', 'orchid', 'mint', 'rookie', 'pathfinder', 'vanguard', 'veteran'];
legacy.forEach((id, at) => {
  const art = cosmeticArtwork(new Node('div'), treeNode(id));
  assert.equal(art.className, 'vb-cosmetic-art');
  assert.equal(art.style.backgroundPosition, `${(at % 4) * 100 / 3}% ${at < 4 ? 0 : 100}%`);
});
const overdrive = cosmeticArtwork(new Node('div'), treeNode('rifle-overdrive'));
assert.equal(overdrive.children[0].tagName, 'IMG');
assert.equal(overdrive.children[0].src, '/assets/cosmetics/rifle-overdrive.png');
overdrive.children[0].dispatch('error');
assert.equal(overdrive.children[0].hidden, true);
assert.match(overdrive.children[1].textContent, /preview unavailable/);
for (const id of ['ember', 'warden', 'mastery-rifle-master', 'armsmaster']) {
  assert.equal(cosmeticArtwork(new Node('div'), treeNode(id)).style.backgroundPosition, undefined, `${id} never maps onto the atlas`);
}

// Reticles use the shared DOM contract: div.vb-reticle-preview[data-reticle] > div.vb-reticle-crosshair > span.ch-arm x4.
for (const item of CAREER_CATALOG.filter(n => n.kind === 'reticle')) {
  const art = cosmeticArtwork(new Node('div'), item);
  const frame = art.querySelector('div.vb-reticle-preview');
  assert.ok(frame, `${item.id} has a reticle preview`);
  assert.equal(frame.dataset.reticle, item.reticle);
  const crosshair = frame.children[0];
  assert.equal(crosshair.tagName, 'DIV'); assert.equal(crosshair.className, 'vb-reticle-crosshair');
  assert.deepEqual(crosshair.children.map(c => `${c.tagName}.${c.className}`), Array(4).fill('SPAN.ch-arm'));
}
const standardReticle = cosmeticArtwork(new Node('div'), { id: 'standard', kind: 'reticle' }).querySelector('.vb-reticle-preview');
assert.equal(standardReticle.hasAttribute('data-reticle'), false, 'standard reticle carries no data-reticle');
// Nameplates reuse the real scoreboard badge.
for (const item of CAREER_CATALOG.filter(n => n.kind === 'nameplate')) {
  const badge = cosmeticArtwork(new Node('div'), item).querySelector('.vb-sb-nameplate');
  assert.equal(badge?.textContent, item.badge, `${item.id} badge`);
  assert.equal(badge.style.props['--item-color'], item.color);
}
assert.equal(cosmeticArtwork(new Node('div'), treeNode('ember')).querySelector('.vb-theme-mock-ammo')?.textContent, '30 / 90');
assert.equal(cosmeticArtwork(new Node('div'), treeNode('warden')).querySelector('.vb-title-plate strong')?.textContent, 'Warden');
assert.equal(cosmeticArtwork(new Node('div'), treeNode('grip-angled')).querySelector('.vb-part-plate')?.dataset.slot, 'grip');

// ---------- WeaponBench: save-on-select, latest wins, rollback ----------
const timers = new Map(); let clock = 0, timerId = 0;
const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, at: clock + ms }); return timerId; };
globalThis.clearTimeout = id => { timers.delete(id); };
const advance = ms => {
  clock += ms;
  for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= clock && timers.has(id)) { timers.delete(id); timer.fn(); }
};
const settle = () => new Promise(resolve => realTimeout(resolve, 0));

try {
  const raw = emptyProfile();
  raw.xp = xpForLevel(12);
  raw.mastery = { rifle: { kills: 200, headshots: 12, botKills: 199 } };
  reconcileCareerUnlocks(raw);
  const view = careerView(raw);
  assert.deepEqual(view.unlockedParts.optic, ['standard', 'reflex', 'scope2']);

  const inspector = { shown: [], statuses: [], showWeapon(o) { this.shown.push(o); }, setStatus(text, tone = 'info') { this.statuses.push([text, tone]); } };
  const host = {
    profile: view, saves: [], requests: [],
    saveAttachments(weapon, attachments) { return new Promise((resolve, reject) => this.saves.push({ weapon, attachments, resolve, reject })); },
    request(...args) { this.requests.push(args); return Promise.resolve(null); },
  };
  const panel = new Node('section'); panel.id = 'armory-panel-weapons';
  const bench = new WeaponBench({ panel, inspector, host });
  assert.equal(panel.querySelectorAll('.vb-bench-weapon[data-weapon]').length, 13);
  assert.equal(panel.querySelector('#armory-weapon-rail')?.getAttribute('aria-label'), 'Weapons');
  assert.equal(panel.querySelector('[data-weapon="rifle"]').getAttribute('aria-pressed'), 'true');
  assert.equal(inspector.shown.at(-1).weapon, 'rifle', 'the visible panel shows the weapon at once');
  const option = selector => panel.querySelector(selector);
  const pressed = selector => option(selector).getAttribute('aria-pressed');

  // Locked parts stay focusable, carry data-locked, show their level and never POST.
  const scope4 = option('[data-optic="scope4"]');
  assert.equal(scope4.dataset.locked, 'true');
  assert.equal(scope4.getAttribute('aria-disabled'), 'true');
  assert.match(scope4.textContent, /LV 18/);
  scope4.click();
  advance(BENCH_SAVE_DELAY * 2);
  assert.equal(host.saves.length, 0);
  assert.match(inspector.statuses.at(-1)[0], /career level 18/);

  // Two quick picks: optimistic pressed state, one POST with the last pick.
  option('[data-optic="reflex"]').click();
  assert.equal(pressed('[data-optic="reflex"]'), 'true', 'optimistic');
  advance(100);
  option('[data-optic="scope2"]').click();
  assert.equal(pressed('[data-optic="scope2"]'), 'true');
  assert.equal(pressed('[data-optic="reflex"]'), 'false');
  advance(BENCH_SAVE_DELAY - 1);
  assert.equal(host.saves.length, 0, 'still debouncing');
  advance(1);
  assert.equal(host.saves.length, 1, 'one save for both picks');
  assert.deepEqual({ ...host.saves[0].attachments }, { optic: 'scope2', grip: 'standard', counter: 'standard' });

  // Rejected save rolls back to the last confirmed setup and reports the error.
  host.saves[0].reject(new Error('Career unavailable'));
  await settle();
  assert.equal(pressed('[data-optic="standard"]'), 'true', 'rolled back');
  assert.deepEqual(inspector.statuses.at(-1), ['Career unavailable', 'error']);

  // An older response never overrides a newer pick.
  option('[data-optic="reflex"]').click();
  advance(BENCH_SAVE_DELAY);
  option('[data-grip="angled"]').click();
  advance(BENCH_SAVE_DELAY);
  assert.equal(host.saves.length, 3);
  host.saves[1].reject(new Error('stale failure'));
  await settle();
  assert.equal(pressed('[data-grip="angled"]'), 'true', 'stale failure does not roll back');
  assert.equal(pressed('[data-optic="reflex"]'), 'true');
  const saved = careerView({ ...raw, equipped: { ...raw.equipped, weaponAttachments: { rifle: { optic: 'reflex', grip: 'angled', counter: 'standard' } } } });
  host.saves[2].resolve(saved);
  await settle();
  assert.equal(inspector.statuses.at(-1)[0], 'VK-77 RAPTOR setup saved');
  assert.equal(pressed('[data-grip="angled"]'), 'true');
  assert.match(option('[data-grip="angled"]').textContent, /EQUIPPED/);

  // setProfile keeps a pending pick until its save answers.
  option('[data-grip="standard"]').click();
  bench.setProfile(saved);
  assert.equal(pressed('[data-grip="standard"]'), 'true', 'pending pick survives a profile refresh');
  advance(BENCH_SAVE_DELAY);
  const reflexOnly = careerView({ ...raw, equipped: { ...raw.equipped, weaponAttachments: { rifle: { optic: 'reflex', grip: 'standard', counter: 'standard' } } } });
  host.saves.at(-1).resolve(reflexOnly);
  await settle();

  // A save answer made stale by another career request keeps the pick; the newer answer confirms it.
  option('[data-grip="angled"]').click();
  advance(BENCH_SAVE_DELAY);
  host.saves.at(-1).resolve(null);
  await settle();
  assert.equal(pressed('[data-grip="angled"]'), 'true', 'a stale answer never rolls back');
  bench.setProfile(saved);
  assert.equal(inspector.statuses.at(-1)[0], 'VK-77 RAPTOR setup saved', 'the newer answer confirms the pick');
  assert.equal(pressed('[data-grip="angled"]'), 'true');
  // A newer answer that predates the save sends it again.
  option('[data-grip="standard"]').click();
  advance(BENCH_SAVE_DELAY);
  const staleSaves = host.saves.length;
  host.saves.at(-1).resolve(null);
  await settle();
  bench.setProfile(saved);
  assert.equal(host.saves.length, staleSaves + 1, 'the pick is sent again');
  assert.equal(host.saves.at(-1).attachments.grip, 'standard');
  assert.equal(pressed('[data-grip="standard"]'), 'true');
  host.saves.at(-1).resolve(reflexOnly);
  await settle();

  // FACTORY SETUP saves standard x3.
  option('[data-factory]').click();
  advance(BENCH_SAVE_DELAY);
  assert.deepEqual({ ...host.saves.at(-1).attachments }, { optic: 'standard', grip: 'standard', counter: 'standard' });
  host.saves.at(-1).resolve(view);
  await settle();

  // A pick that returns to the confirmed setup while an earlier save is in flight is still sent.
  const inflightSaves = host.saves.length;
  option('[data-optic="reflex"]').click();
  advance(BENCH_SAVE_DELAY);
  assert.equal(host.saves.length, inflightSaves + 1);
  option('[data-optic="standard"]').click();
  advance(BENCH_SAVE_DELAY);
  assert.equal(host.saves.length, inflightSaves + 2, 'the last pick goes out behind the pending save');
  assert.equal(host.saves.at(-1).attachments.optic, 'standard');
  const reflexView = careerView({ ...raw, equipped: { ...raw.equipped, weaponAttachments: { rifle: { optic: 'reflex', grip: 'standard', counter: 'standard' } } } });
  bench.setProfile(reflexView); // the first answer re-renders the host before its own promise settles
  host.saves.at(-2).resolve(reflexView);
  await settle();
  assert.equal(pressed('[data-optic="standard"]'), 'true', 'the older answer does not override the last pick');
  host.saves.at(-1).resolve(view);
  await settle();
  assert.equal(pressed('[data-optic="standard"]'), 'true');
  assert.equal(pressed('[data-optic="reflex"]'), 'false');
  // With nothing in flight, returning to the confirmed setup sends nothing.
  option('[data-optic="reflex"]').click();
  option('[data-optic="standard"]').click();
  advance(BENCH_SAVE_DELAY);
  assert.equal(host.saves.length, inflightSaves + 2, 'no request for an unchanged setup');

  // Handling readout compares against the equipped setup.
  const saves = host.saves.length;
  bench.showPreview('optic:scope2');
  const block = inspector.shown.at(-1).extra;
  assert.equal(block.querySelectorAll('meter').length, 5);
  for (const meter of block.querySelectorAll('meter')) assert.ok(meter.getAttribute('aria-valuetext'));
  assert.match(block.textContent, /RAPTOR · 200 human · 199 bot · 12 headshots/);
  assert.match(block.textContent, /NEXT: Raptor II nameplate · 249 \/ 250/);
  assert.equal(inspector.shown.at(-1).attachments.optic, 'scope2');
  assert.equal(block.querySelector('.vb-bench-stat').dataset.delta, 'worse', '2x sight costs ergonomics against the equipped factory sight');
  assert.match(block.querySelector('.vb-bench-stat .vb-bench-delta').textContent, /^WORSE -1$/);
  // Hover previews after the debounce and leaving the list reverts to the chosen setup.
  const shown = inspector.shown.length;
  option('[data-grip="angled"]').dispatch('pointerover');
  advance(119);
  assert.equal(inspector.shown.length, shown, 'preview is debounced');
  advance(1);
  assert.equal(inspector.shown.at(-1).attachments.grip, 'angled');
  assert.match(inspector.shown.at(-1).kicker, /PREVIEW/);
  panel.querySelector('.vb-bench-groups').dispatch('pointerleave');
  advance(120);
  assert.equal(inspector.shown.at(-1).attachments.grip, 'standard');
  advance(BENCH_SAVE_DELAY * 2);
  assert.equal(host.saves.length, saves, 'previewing never saves');

  // Skins: locked inspects only; owned equips; standard resets with the slot descriptor.
  const skin = option('[data-skin-option="rifle-overdrive"]');
  assert.equal(skin.dataset.state, 'next');
  assert.match(skin.textContent, /SPECIALIST · 249 \/ 250/);
  skin.click();
  await settle();
  assert.equal(host.requests.length, 0);
  assert.match(inspector.statuses.at(-1)[0], /mastery/);
  raw.mastery.rifle.botKills = 203; reconcileCareerUnlocks(raw);
  raw.equipped.weaponSkins.rifle = 'rifle-overdrive';
  bench.setProfile(careerView(raw));
  assert.equal(option('[data-skin-option="rifle-overdrive"]').dataset.state, 'equipped');
  option('[data-skin-option="standard"]').click();
  await settle();
  assert.deepEqual(host.requests.at(-1), ['standard', true, { slot: 'weaponSkin', weapon: 'rifle' }]);
  delete raw.equipped.weaponSkins.rifle;
  bench.setProfile(careerView(raw));
  option('[data-skin-option="rifle-overdrive"]').click();
  await settle();
  assert.deepEqual(host.requests.at(-1), ['rifle-overdrive', true]);

  // NEW rewards show on the bench and are marked seen once previewed or chosen.
  const fresh = new Set(['optic-reflex']), seenCalls = [];
  host.isNew = id => fresh.has(id);
  host.markSeen = id => { seenCalls.push(id); fresh.delete(id); };
  bench.setProfile(bench.profile);
  const reflexOption = option('[data-optic="reflex"]');
  assert.equal(reflexOption.dataset.new, 'optic-reflex');
  assert.match(reflexOption.textContent, /NEW/);
  bench.showPreview('optic:reflex');
  assert.deepEqual(seenCalls, ['optic-reflex'], 'previewing an owned reward marks it seen');
  reflexOption.onSeen();
  assert.doesNotMatch(reflexOption.textContent, /NEW/, 'the NEW chip goes once seen');
  bench.showPreview('optic:scope4');
  assert.deepEqual(seenCalls, ['optic-reflex'], 'a locked reward is never pre-marked seen');
  bench.showPreview(null);
  // FIT ON: select lands on the inspected part.
  bench.select('rifle', { part: 'optic', id: 'scope2' });
  assert.equal(document.activeElement.dataset.optic, 'scope2');
  assert.equal(inspector.shown.at(-1).attachments.optic, 'scope2', 'the inspected part is previewed');

  // Deep link, weapons without skins, and dispose flushing a last pick.
  bench.select('knife', { part: 'counter' });
  assert.equal(panel.querySelector('[data-weapon="knife"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement.dataset.counter, 'standard');
  assert.match(panel.querySelector('[data-group="skin"]').textContent, /No skins for this weapon yet/);
  assert.equal(panel.querySelectorAll('[data-optic]').length, 1);
  option('[data-counter="stattrak"]').click();
  const before = host.saves.length;
  bench.dispose();
  assert.equal(host.saves.length, before + 1, 'dispose sends the pending pick');
  assert.equal(host.saves.at(-1).weapon, 'knife');
  assert.equal(panel.children.length, 0);
  assert.equal(benchLockText(treeNode('optic-cyber'), { blockedByParent: true, requirements: [] }), 'CY-9 cyber scope: unlock 10x precision scope first.');
} finally {
  globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear;
}
console.log('Armory previews: artwork for every catalog item and kind, reticle and nameplate DOM contracts, bench save-on-select with latest-wins and rollback passed.');
