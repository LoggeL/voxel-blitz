// Career and Armory dialog behaviour under a small fake DOM: friendly transport
// errors, keyboard focus across rebuilds, the filtered next-unlock jump, the
// career poll pausing for the Armory, and the map preview retrying a failed decode.
import assert from 'node:assert/strict';
import { ATTACHMENT_SLOTS } from '../shared/weapon-attachments.js';
import { PROGRESSION_BRANCHES, careerView, defaultCosmeticLoadout, reconcileCareerUnlocks } from '../shared/career.js';

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.dataset = {};
    this.attributes = new Map(); this.listeners = {}; this.style = { setProperty() {} };
    this.classList = { add: name => { this.className = `${this.className || ''} ${name}`.trim(); } };
    this.className = ''; this.textContent = ''; this.disabled = false; this.open = false;
  }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === document.body; }
  append(...nodes) { for (const child of nodes) { child.remove(); child.parentNode = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  insertBefore(child, before) { this.append(child); const i = this.children.indexOf(before); if (i >= 0) { this.children.pop(); this.children.splice(i, 0, child); } }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
    // Like a browser, a removed focused element hands focus back to <body>.
    if (this.contains(document.activeElement)) document.activeElement = document.body;
  }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  async click() { if (!this.disabled) for (const handler of this.listeners.click || []) await handler({ type: 'click' }); }
  focus() { if (!this.disabled && this.isConnected) document.activeElement = this; }
  scrollIntoView() {}
  getClientRects() { return [1]; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const handler of this.listeners.close || []) handler(); }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  matches(selector) {
    if (selector === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
    const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attribute) {
      const [, name, value] = attribute;
      const actual = name.startsWith('data-')
        ? this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] : this.getAttribute(name);
      return value === undefined ? actual != null : actual === value;
    }
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return [...this.walk()].filter(node => !selector.includes(' ') && node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const listeners = {};
const intervals = [];
globalThis.document = {
  body: new FakeElement('body'),
  activeElement: null,
  hidden: false,
  createElement: tag => new FakeElement(tag),
  getElementById(id) { return [...this.body.walk()].find(node => node.id === id) || null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  documentElement: { style: { setProperty() {} } },
};
document.activeElement = document.body;
globalThis.window = {
  addEventListener(name, handler) { (listeners[name] ||= []).push(handler); },
  removeEventListener(name, handler) { listeners[name] = (listeners[name] || []).filter(entry => entry !== handler); },
  dispatchEvent(event) { for (const handler of listeners[event.type] || []) handler(event); return true; },
  matchMedia: () => ({ matches: true }),
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };

const { careerFetch, focusedKey, restoreFocus } = await import('../public/js/ui/career-ui-support.js');
const { ProgressionTree } = await import('../public/js/ui/progression.js');
const { WeaponCustomization } = await import('../public/js/ui/weapon-customization.js');
const { CrossfadeImage } = await import('../public/js/ui/crossfade-image.js');

const json = (payload, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => payload });
const htmlError = () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON'); } });
const timeout = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
const settle = () => new Promise(resolve => setImmediate(resolve));

// Transport failures read as a service problem; server errors pass through.
globalThis.fetch = async () => htmlError();
await assert.rejects(careerFetch('/api/career', {}, 'Offline.'), /^Error: Offline\.$/, 'a proxy HTML page never leaks parser text');
globalThis.fetch = async () => timeout();
await assert.rejects(careerFetch('/api/career', {}, 'Offline.'), /^Error: Offline\.$/, 'a timeout never leaks the abort text');
globalThis.fetch = async () => json({ error: 'Not earned' }, false);
const rejected = await careerFetch('/api/career', {}, 'Offline.');
assert.equal(rejected.response.ok, false);
assert.equal(rejected.payload.error, 'Not earned', 'server errors still reach the caller');
globalThis.fetch = async () => htmlError();
await assert.rejects(ProgressionTree.prototype.request.call({ requestVersion: 0, render() {} }),
  /^Error: Career service unavailable\. Try again\.$/);

const profile = extra => {
  const raw = { xp: 19600, kills: 250, pvpKills: 250, wins: 0, matches: 10,
    owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout() },
    mastery: { rifle: { kills: 250, headshots: 20 } }, ...extra };
  reconcileCareerUnlocks(raw);
  return careerView(raw);
};

// Career: the jump button works under every branch filter.
const career = new ProgressionTree();
career.profile = profile();
career.featuredId = 'arctic';
const next = career.nextUnlock();
assert.ok(next, 'fixture has a next unlock');
career.filter = PROGRESSION_BRANCHES.find(branch => branch.id !== next.item.branch).id;
career.renderTree();
assert.equal(career.tree.querySelector('[aria-current="step"]'), null, 'the filter hides the next unlock');
career.jumpToNextUnlock();
assert.equal(career.filter, next.item.branch, 'jump reveals the branch holding the next unlock');
assert.equal(document.activeElement.dataset.node, next.item.id, 'jump focuses the next unlock');

// Career: a rebuild keeps focus on the same control, and equipping lands on the node.
career.dialog.showModal();
career.filter = 'all';
career.render();
const nodeButton = career.tree.querySelector('[data-node="arctic"]');
nodeButton.focus();
career.render();
assert.notEqual(document.activeElement, nodeButton, 'the tree was rebuilt');
assert.equal(document.activeElement.dataset.node, 'arctic', 'render restores focus to the rebuilt node');
const equipped = profile();
equipped.equipped.theme = 'arctic';
globalThis.fetch = async () => json(equipped);
const equip = career.tree.querySelector('[data-item="arctic"]');
assert.equal(equip.disabled, false, 'fixture can equip Arctic');
equip.focus();
await equip.click();
assert.equal(career.status.textContent, 'Arctic equipped');
assert.ok(document.activeElement.isConnected && career.dialog.contains(document.activeElement), 'focus stays inside the dialog');
assert.equal(document.activeElement.dataset.node, 'arctic', 'the disabled EQUIPPED button hands focus to its tree node');
globalThis.fetch = async () => htmlError();
const retry = career.tree.querySelector('[data-item="orchid"]') || [...career.tree.querySelectorAll('button')]
  .find(button => button.dataset.item && !button.disabled);
retry.focus();
await retry.click();
assert.equal(career.status.textContent, 'Career service unavailable. Try again.');
assert.equal(document.activeElement.dataset.item, retry.dataset.item, 'a failed equip returns focus to the re-enabled button');
career.dialog.close();

// Career: the background poll pauses while the Armory is open.
let requests = 0;
globalThis.fetch = async () => { requests++; return json(profile()); };
await career.start();
const poll = intervals.find(entry => entry.ms === 15000);
assert.ok(poll, 'career poll is scheduled');
const armory = new WeaponCustomization();
armory.dialog.showModal();
const before = requests;
poll.fn(); await settle();
assert.equal(requests, before, 'no career poll while the Armory is open');
armory.dialog.close();
poll.fn(); await settle();
assert.equal(requests, before + 1, 'the poll resumes once the Armory closes');

// Armory: selecting an option keeps focus on it.
armory.dialog.showModal();
armory.ready = true; armory.saved = {}; armory.weapon = 'rifle';
armory.render();
const grip = armory.slots.querySelector('[data-grip="standard"]');
grip.focus();
await grip.click();
assert.notEqual(document.activeElement, grip, 'the options were rebuilt');
assert.equal(document.activeElement.dataset.grip, 'standard', 'focus follows the rebuilt option');

// Armory: an unchanged career broadcast neither rebuilds nor overwrites the status.
const detail = profile();
window.dispatchEvent(new CustomEvent('vb-career-change', { detail }));
armory.render('Could not save. Try again.');
const options = armory.slots.children[0];
window.dispatchEvent(new CustomEvent('vb-career-change', { detail: profile() }));
assert.equal(armory.status.textContent, 'Could not save. Try again.', 'a repeated profile keeps the status line');
assert.equal(armory.slots.children[0], options, 'a repeated profile does not rebuild the options');
armory.busy = true; armory.render('Saving setup...');
window.dispatchEvent(new CustomEvent('vb-career-change', { detail: { ...detail, unlockedParts: { optic: ['standard'], grip: ['standard'], counter: ['standard'] } } }));
assert.equal(armory.status.textContent, 'Saving setup...', 'a busy save keeps its status');
assert.deepEqual(armory.parts.grip, ['standard'], 'the new unlock state is still recorded');
armory.busy = false;

// Armory: transport failures use the Armory wording.
globalThis.fetch = async () => htmlError();
await armory.refresh();
assert.equal(armory.status.textContent, 'Could not load your setups.');
armory.ready = true; armory.parts = detail.unlockedParts;
const optic = ATTACHMENT_SLOTS.rifle.optics.find(part => part !== 'standard' && detail.unlockedParts.optic.includes(part));
assert.ok(optic, 'fixture has an unlocked rifle optic');
armory.drafts.rifle = { optic, grip: 'standard', counter: 'standard' };
armory.render();
assert.equal(armory.save.disabled, false, 'fixture has an unsaved setup');
await armory.persist();
assert.equal(armory.status.textContent, 'Could not save. Try again.');
armory.dialog.close();

// focusedKey ignores focus outside the container.
document.body.focus?.();
document.activeElement = document.body;
assert.equal(focusedKey(armory.slots, ['optic']), null);
assert.equal(restoreFocus(armory.slots, [null]), false);

// Map preview: a failed decode can be retried with the same source.
const root = new FakeElement('div');
document.body.append(root);
let failures = 1;
const decodes = [];
const originalCreate = document.createElement;
document.createElement = tag => {
  const element = new FakeElement(tag);
  if (tag === 'img') element.decode = async () => { decodes.push(element.src); if (failures-- > 0) throw new Error('network'); };
  return element;
};
const fade = new CrossfadeImage(root);
fade.set('/maps/a.png');
await settle(); await settle();
assert.equal(fade.running, false);
assert.equal(fade.current, '', 'a failed decode keeps the previous image');
fade.set('/maps/a.png');
await settle(); await settle();
assert.equal(fade.current, '/maps/a.png', 'the same source is retried after a failure');
assert.equal(fade.image.src, '/maps/a.png');
fade.set('/maps/a.png');
await settle();
assert.equal(decodes.filter(src => src === '/maps/a.png').length, 3, 'a displayed source is not decoded again');
document.createElement = originalCreate;

career.dispose(); armory.dispose(); fade.dispose();
globalThis.setInterval = realSetInterval;
console.log('Career & Armory UI: friendly transport errors, focus across rebuilds, filtered jump, Armory poll pause and map preview retry passed.');
