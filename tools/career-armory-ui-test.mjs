// ARMORY behaviour that main fixed before the redesign, kept under the single
// dialog on a fake DOM: friendly transport errors for career reads, equips and
// attachment saves, keyboard focus across rebuilds, a filtered jump that reveals
// its node, and the map preview retrying a failed decode.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

installFakeDom({ width: 1440 });
const { careerView, defaultCosmeticLoadout, reconcileCareerUnlocks, treeNode, xpForLevel } = await import('../shared/career.js');
const { careerFetch, focusedKey, restoreFocus } = await import('../public/js/ui/career-ui-support.js');
const { careerSaveAttachments } = await import('../public/js/ui/career-store.js');
const { ProgressionTree } = await import('../public/js/ui/progression.js');
const { CrossfadeImage } = await import('../public/js/ui/crossfade-image.js');

const json = (payload, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => structuredClone(payload) });
const htmlError = () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON'); } });
const timeout = () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
const settle = async (rounds = 4) => { for (let at = 0; at < rounds; at++) await new Promise(resolve => setTimeout(resolve, 0)); };

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
  /^Error: Career service unavailable\. Try again\.$/, 'a career read or equip uses the career wording');
await assert.rejects(careerSaveAttachments({ requestVersion: 0, render() {} }, 'rifle', { optic: 'standard', grip: 'standard', counter: 'standard' }),
  /^Error: Could not save\. Try again\.$/, 'an attachment save uses the workshop wording');
globalThis.fetch = async () => json({ error: 'Choose a valid attachment' }, false);
await assert.rejects(careerSaveAttachments({ requestVersion: 0, render() {} }, 'rifle', {}), /^Error: Choose a valid attachment$/);

const profile = level => {
  const raw = { xp: xpForLevel(level), kills: 0, pvpKills: 0, wins: 0, matches: 3, owned: ['amber', 'rookie'],
    equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout(), weaponAttachments: {} }, mastery: {} };
  reconcileCareerUnlocks(raw);
  return careerView(raw);
};
globalThis.fetch = async () => json(profile(12));
const menu = document.createElement('div');
menu.id = 'menu';
const nav = document.createElement('nav');
nav.className = 'vb-main-nav';
menu.append(nav);
document.body.append(menu);
const career = new ProgressionTree({ loadViewer: () => Promise.reject(new Error('no WebGL in Node')),
  loadWeaponBench: async () => class { constructor({ panel }) { this.panel = panel; } setProfile() {} select() {} dispose() {} } });
await career.start();
clearInterval(career.timer);
await career.open({ tab: 'progress' }, document.getElementById('career-open'));
await settle();

// A rebuild keeps keyboard focus on the same control.
const row = id => [...document.querySelectorAll('#progression-tree [role=treeitem]')].find(item => item.dataset.treeNode === id);
row('arctic').focus();
const before = document.activeElement;
career.renderDialog();
assert.notEqual(row('arctic'), before, 'the tree was rebuilt');
assert.equal(document.activeElement.dataset.treeNode, 'arctic', 'a rebuild restores focus to the rebuilt node');

// The filtered jump: a goal or journey target hidden by the branch filter is revealed and focused.
const next = treeNode('optic-scope4');
career.progress.setFilter('presentation');
assert.equal(row(next.id), undefined, 'the filter hides the target');
career.jumpTo(next.id);
assert.notEqual(row(next.id), undefined, 'the jump clears the hiding filter');
assert.equal(document.activeElement.dataset.treeNode, next.id, 'the jump focuses the revealed node');
assert.equal(document.getElementById('armory-inspector').dataset.featuredItem, next.id, 'the inspector shows it');

// A failed equip keeps the friendly wording in the status line and focus inside the dialog.
globalThis.fetch = async () => htmlError();
await career.equip('arctic');
assert.equal(document.getElementById('armory-status').textContent, 'Career service unavailable. Try again.');
assert.ok(career.dialog.contains(document.activeElement), 'focus stays inside the dialog');

// focusedKey ignores focus outside the container.
document.body.focus?.();
assert.equal(focusedKey(nav, ['node']), null);
assert.equal(restoreFocus(nav, [null]), false);
career.dialog.close();

// Map preview: a failed decode can be retried with the same source.
const root = document.createElement('div');
document.body.append(root);
let failures = 1;
const decodes = [];
const originalCreate = document.createElement;
document.createElement = tag => {
  const element = originalCreate.call(document, tag);
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

career.dispose(); fade.dispose();
console.log('ARMORY UI: friendly transport errors, focus across rebuilds, filtered jump and map preview retry passed.');
