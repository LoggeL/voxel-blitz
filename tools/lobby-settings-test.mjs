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
} finally {
  if (saved === undefined) delete globalThis.document;
  else globalThis.document = saved;
}
console.log('Lobby settings passed: shared no-bot rule, TTT prep copy and duel weapon set from shared rules.');
