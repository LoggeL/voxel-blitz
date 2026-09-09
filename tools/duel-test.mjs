import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { LobbyManager } from '../server/lobby.js';
import { DUEL_WEAPONS } from '../shared/modes.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
const messages = [];
const manager = new LobbyManager({ sendJson: (meta, msg) => messages.push({ id: meta.id, ...msg }), sendFrame: () => {}, closeClient: () => {} });
const host = { id: 'host' }, guest = { id: 'guest' }, third = { id: 'third' };
try {
  assert.equal(await manager.create(host, 'Host', 7, 'duel', 'depot'), true);
  const room = host.room;
  assert.equal(room.bots, 0);
  assert.equal(manager.list()[0].capacity, 2);
  manager.ready(host, true);
  assert.equal(manager.start(host), false);
  assert.equal(await manager.join(guest, 'Guest', room.code.toLowerCase()), true);
  assert.equal(await manager.join(third, 'Third', room.code), false);
  for (const entity of room.engine.entities.values()) {
    assert.deepEqual(room.engine.mode.playerSnapshot(entity).owned, DUEL_WEAPONS);
    assert.equal(room.engine.mode.canUseWeapon(entity, 'rocket'), false);
    assert.equal(room.engine.mode.canUseWeapon(entity, 'rifle'), true);
    assert.equal(entity.mag[WEAPON_IDS.indexOf('rocket')], 0);
    assert.ok(entity.grenades.every(n => n === 0));
    room.engine.mode.onPlayerRespawn(entity);
    assert.deepEqual(entity.owned, DUEL_WEAPONS);
  }
  assert.equal(room.engine.mode.rules.killLimit, 5);
  const settings = { gameMode: 'duel', map: 'depot', bots: 0, duelKillLimit: 10 };
  assert.equal(manager.configure(guest, settings), false, 'only host can set target');
  for (const value of [0, -1, 7, 5.5, '5', 1000]) {
    assert.equal(manager.configure(host, { ...settings, duelKillLimit: value }), false);
  }
  assert.equal(manager.configure(host, settings), true);
  assert.equal(room.engine.mode.rules.killLimit, 10);
  assert.ok([...room.members.values()].every(m => !m.ready));
  assert.equal(messages.filter(m => m.t === 'lobbyState').at(-1).duelKillLimit, 10);
  assert.equal(manager.configure(host, { ...settings, duelKillLimit: 5 }), true);
  manager.ready(host, true);
  manager.ready(guest, true);
  assert.equal(manager.start(host), true);
  assert.equal(room.engine.mode.mode, 'duel');
  assert.equal(manager.configure(host, settings), false, 'target is locked during play');
  const killer = room.engine.entities.get(host.id);
  const victim = room.engine.entities.get(guest.id);
  room.engine.killPlayer(victim, null, 'world', false);
  assert.equal(killer.kills, 0, 'environmental deaths do not advance target');
  for (let kill = 1; kill <= 5; kill++) {
    room.engine.respawnPlayer(victim);
    room.engine.killPlayer(victim, killer, 'rifle', false);
    assert.equal(room.engine.mode.phase, kill === 5 ? 'post' : 'live');
  }
  const result = room.engine.mode.matchSnapshot();
  assert.equal(result.winner, host.id);
  assert.equal(result.scores[host.id], 5);
  assert.equal(result.killLimit, 5);
  assert.equal(room.engine.mode.canFire(killer), false);
  assert.equal(room.engine.mode.canDamage(killer, victim), false);
  assert.equal(room.engine.mode.canRespawn(victim), false);
  room.engine.now = result.phaseEndsAt;
  room.engine.mode.tick();
  assert.equal(room.engine.mode.phase, 'live');
  assert.equal(killer.kills, 0);
  assert.equal(victim.deaths, 0);
  assert.equal(room.engine.mode.matchSnapshot().winner, null);
  assert.equal(room.engine.mode.rules.killLimit, 5);

  assert.equal(await manager.join({ id: 'late' }, 'Late', room.code), false);
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  await manager.create(a, 'A', 0, 'fun', 'depot');
  await manager.join(b, 'B', a.room.code);
  await manager.join(c, 'C', a.room.code);
  assert.equal(manager.configure(a, { gameMode: 'duel', map: 'depot', bots: 0 }), false);
  manager.leave(c);
  assert.equal(manager.configure(a, { gameMode: 'duel', map: 'depot', bots: 7 }), true);
  assert.equal(a.room.bots, 0);
  assert.equal(a.room.engine.mode.mode, 'duel');
  assert.ok([...a.room.members.values()].every(m => !m.ready));
  console.log('Duel tests passed: invite admission, capacity, readiness, loadout, respawn, configuration.');
} finally { manager.stop(); }

// Exercise the actual composition-root gate without starting the WebGL app.
const source = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
const body = source.match(/  isAuthoritativeFireAllowed\(\) \{([\s\S]*?)\n  \}/)[1];
const gate = new Function(body);
const context = {
  session: { gameplayInputEnabled: true }, player: { alive: true, physics: {} },
  selfRow: { state: 'alive' }, weaponWheel: { open: false },
  matchState: { mode: 'duel', phase: 'live' },
};
assert.equal(gate.call(context), true, 'live duel permits firing');
const weapon = new WeaponState({
  rig: { setWeapon() {}, fire() {}, reload() {}, pumpAnim() {}, boltAnim() {}, ads() {} },
  audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
  network: { isCurrentGeneration: () => true, isRunning: () => true },
  feedback: { addExhaustion() {}, addRecoil() {} }, now: () => 0,
});
weapon.applyIntents({ fireTap: true, fireHeld: true }, 0,
  { allowFire: gate.call(context), alive: true, mode: 'duel', owned: DUEL_WEAPONS });
assert.deepEqual(weapon._pendingShotIntent, { tap: true, held: true }, 'duel fire input survives the client gate');
for (const phase of ['waiting', 'prep', 'post']) {
  context.matchState.phase = phase;
  assert.equal(gate.call(context), false);
}
context.matchState.phase = 'live';
for (const [object, key, blocked] of [
  [context.session, 'gameplayInputEnabled', false], [context.player, 'alive', false],
  [context.selfRow, 'state', 'dead'], [context.weaponWheel, 'open', true],
  [context.player.physics, 'vault', true],
]) {
  const previous = object[key]; object[key] = blocked;
  assert.equal(gate.call(context), false, key);
  object[key] = previous;
}
console.log('Duel firing regression passed: live shot intent and gameplay safety gates.');
