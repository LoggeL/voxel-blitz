import assert from 'node:assert/strict';
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
  manager.ready(guest, true);
  assert.equal(manager.start(host), true);
  assert.equal(room.engine.mode.mode, 'duel');
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
