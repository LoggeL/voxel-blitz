import assert from 'node:assert/strict';
import { DUEL_WEAPONS, MODE_RULES, mapForMode } from '../shared/modes.js';
import { WEAPON_NAMES } from '../public/js/ui/hud-support.js';

// Just enough DOM for the host controls: they only build elements and selects.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  set innerHTML(_) { this.children = []; }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type) { for (const listener of this.listeners[type] || []) listener({ type }); }
}
const saved = globalThis.document;
globalThis.document = { createElement: tag => new Element(tag) };
try {
  const { LobbySettings } = await import('../public/js/ui/lobby-settings.js');
  const changes = [];
  const settings = new LobbySettings(new Element('div'), change => changes.push(change));
  const lobby = (gameMode, extra = {}) => ({ phase: 'waiting', gameMode, map: mapForMode(gameMode, 'foundry'), bots: 5,
    members: [{ id: '1', name: 'Host' }], ...extra });

  // Bot-less modes zero and lock the bot control, both on sync and on a host change.
  for (const gameMode of ['training', 'duel', 'bastion']) {
    settings.update(lobby(gameMode), true);
    assert.equal(settings.controls.bots.value, '0', `${gameMode} shows no lobby bots`);
    assert.equal(settings.controls.bots.disabled, true, `${gameMode} locks the bot control`);
  }
  settings.update(lobby('tdm'), true);
  const mapOptions = [...settings.controls.map.options];
  settings.update(lobby('tdm', { members: [{ id: '1', ready: true, ping: 42 }] }), true);
  assert.ok(settings.controls.map.options.every((option, index) => option === mapOptions[index]), 'readiness and ping updates preserve native map option nodes');
  assert.equal(settings.controls.bots.value, '5');
  assert.equal(settings.controls.bots.disabled, false);
  settings.controls.gameMode.value = 'bastion';
  settings.controls.gameMode.dispatch('change');
  assert.equal(changes.at(-1).bots, 0, 'switching to Bastion never requests bots');

  // Rule copy reads the shared rules the server enforces.
  settings.update(lobby('ttt', { traitorCount: 1 }), true);
  assert.match(settings.traitorCount.textContent, new RegExp(`Roles after ${MODE_RULES.ttt.prepMs / 1000} seconds`));
  settings.update(lobby('duel'), true);
  for (const id of DUEL_WEAPONS) assert.ok(settings.loadout.textContent.includes(WEAPON_NAMES[id]), `duel set lists ${id}`);
  assert.match(settings.loadout.textContent, /^BASE 1V1 WEAPON SET: .+\. No throwables\.$/);

  // The closed map menu fits its label: the "768 × 768" size lives in the capacity line, not the option.
  settings.update(lobby('conquest', { map: 'frontier' }), true);
  const frontier = settings.controls.map.options.find(option => option.value === 'frontier');
  assert.match(frontier.textContent, /^FRONTIER · \d+ PLAYERS$/, `short Frontier option (${frontier.textContent})`);
  assert.ok(frontier.textContent.length <= 26, 'the Frontier option fits the closed menu');
  assert.match(settings.capacity.textContent, /FRONTIER · 768 × 768$/, 'the capacity line keeps the battlefield size');

  // Conquest offers both battlefields, Frontier first (the default), and names the chosen one in the hint.
  settings.update(lobby('conquest'), true);
  assert.deepEqual(settings.controls.map.options.map(option => option.value), ['frontier', 'redrock'], 'Conquest lists only the battlefields');
  assert.equal(settings.controls.map.value, 'frontier', 'Frontier stays the default Conquest map');
  assert.match(settings.hint.textContent, /^Frontier: river valley/);
  settings.update(lobby('conquest', { map: 'redrock' }), true);
  assert.equal(settings.controls.map.value, 'redrock');
  const redrock = settings.controls.map.options.find(option => option.value === 'redrock');
  assert.match(redrock.textContent, /^REDROCK CANYON · \d+ PLAYERS$/, `short Redrock option (${redrock.textContent})`);
  assert.ok(redrock.textContent.length <= 30, 'the Redrock option fits the closed menu');
  assert.match(settings.capacity.textContent, /REDROCK CANYON · 768 × 768$/);
  assert.match(settings.hint.textContent, /^Redrock Canyon: desert canyon/);
  // Breakthrough names the battlefield too and reads its sector table.
  settings.update(lobby('conquest', { map: 'redrock', conquestVariant: 'breakthrough' }), true);
  assert.match(settings.hint.textContent, /^Redrock Canyon: .*Breakthrough on 768 × 768: .*3 sectors \(A \+ B → C → D \+ E\)/);
  settings.update(lobby('conquest', { map: 'redrock' }), true);
  settings.controls.map.value = 'redrock';
  settings.controls.map.dispatch('change');
  assert.equal(changes.at(-1).map, 'redrock', 'the host requests Redrock');
  assert.equal(changes.at(-1).gameMode, 'conquest');
  // Leaving Conquest drops the Conquest-only map.
  settings.controls.gameMode.value = 'tdm';
  settings.controls.gameMode.dispatch('change');
  assert.notEqual(changes.at(-1).map, 'redrock', 'TDM never requests Redrock');
} finally {
  if (saved === undefined) delete globalThis.document;
  else globalThis.document = saved;
}
console.log('Lobby settings passed: shared no-bot rule, TTT prep copy, duel weapon set from shared rules and a map label that fits.');
