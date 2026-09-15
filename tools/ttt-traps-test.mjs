// Traitor traps: authored button placement on every map that has traps, then a
// real engine on Minecraft B5, Waterworld and Nuketown: role/phase/range
// gating, cooldown and single use, block effects with restore, damage volumes,
// smoke and fire fields, events without identity, private state only for
// traitors, bots, and round-end cleanup.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { LobbyManager } from '../server/lobby.js';
import { parseBuyFrame, TICK_MS } from '../server/protocol/admission.js';
import { AIR, FLUID_BLOCKS, MC_IRON, MC_LAVA, createMapState, getMapMeta, isSolidBlock, ladderContact } from '../shared/worlddata.js';
import { MAP_TRAPS, TRAP_EFFECT_KINDS, TRAP_RULES, isTrapRequest, trapButtonPoint, trapEffectContains, trapWallCell } from '../shared/world/traps.js';
import { isModeMapCompatible } from '../shared/modes.js';

// ---- 1. Every button stands on a reachable cell in front of a wall.
for (const [id, traps] of Object.entries(MAP_TRAPS)) {
  assert.ok(isModeMapCompatible('ttt', id), `${id} supports TTT`);
  const world = createMapState(id), meta = getMapMeta(id);
  const { sx, sy, sz } = world.dimensions, at = (x, y, z) => world.getBlock(x, y, z);
  assert.deepEqual(meta.traps.map((t) => t.id), traps.map((t) => t.id), `${id} metadata carries its traps`);
  assert.equal(new Set(traps.map((t) => t.id)).size, traps.length, `${id} trap ids are unique`);
  assert.ok(traps.length >= 2 && traps.length <= 3, `${id} authors 2–3 traps`);
  const passable = (x, y, z) => !isSolidBlock(at(x, y, z));
  const free = (x, y, z) => passable(x, y, z) && passable(x, y + 1, z);
  const onLadder = (x, y, z) => ladderContact(meta, x + 0.5, y + 0.5, z + 0.5);
  const stand = (x, y, z) => y >= 1 && y < sy - 2 && free(x, y, z) && (isSolidBlock(at(x, y - 1, z))
    || FLUID_BLOCKS.has(at(x, y - 1, z)) || FLUID_BLOCKS.has(at(x, y, z)) || onLadder(x, y, z));
  const key = (x, y, z) => `${x},${y},${z}`;
  const [origin] = meta.spawns.fun;
  const queue = [[Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)]];
  const reachable = new Set([key(...queue[0])]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i];
    const vertical = FLUID_BLOCKS.has(at(x, y, z)) || onLadder(x, y, z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) for (const dy of [0, 1, -1]) {
      if (dx === 0 && dz === 0 && (dy === 0 || !vertical)) continue;
      const X = x + dx, Y = y + dy, Z = z + dz, k = key(X, Y, Z);
      if (X < 1 || X > sx - 2 || Z < 1 || Z > sz - 2 || reachable.has(k) || !stand(X, Y, Z)) continue;
      if (dy === 1 && !free(x, y + 1, z)) continue;
      reachable.add(k);
      queue.push([X, Y, Z]);
    }
  }
  const inside = (x, y, z) => x >= 0 && x < sx && y >= 0 && y < sy && z >= 0 && z < sz;
  for (const trap of traps) {
    const b = trap.button, label = `${id}/${trap.id}`;
    assert.ok(['x+', 'x-', 'z+', 'z-'].includes(b.face), `${label} names its wall`);
    assert.ok(Number.isInteger(b.x) && Number.isInteger(b.y) && Number.isInteger(b.z), `${label} uses a voxel cell`);
    assert.ok(isSolidBlock(at(b.x, b.y - 1, b.z)), `${label} stands on solid floor`);
    assert.equal(at(b.x, b.y, b.z), AIR, `${label} has air at the feet`);
    assert.equal(at(b.x, b.y + 1, b.z), AIR, `${label} has air at the body`);
    const wall = trapWallCell(trap);
    assert.ok(isSolidBlock(at(wall.x, wall.y, wall.z)) && isSolidBlock(at(wall.x, wall.y + 1, wall.z)), `${label} hangs on a wall`);
    assert.ok(reachable.has(key(b.x, b.y, b.z)), `${label} connects to the spawn set`);
    assert.ok(trap.uses > 0 || trap.cooldownMs > 0, `${label} has uses or a cooldown`);
    assert.ok(typeof trap.name === 'string' && trap.name && typeof trap.detail === 'string', `${label} is labelled`);
    const e = trap.effect;
    assert.ok(TRAP_EFFECT_KINDS.includes(e.kind), `${label} effect kind`);
    if (e.kind === 'explosion') {
      assert.ok(inside(e.x, e.y, e.z) && at(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z)) === AIR, `${label} explodes in air`);
      assert.ok(e.radius > 0 && e.damage > 0 && e.terrainRadius >= 0, `${label} blast profile`);
    }
    if (e.region) {
      const r = e.region;
      assert.ok(inside(r.minX, r.minY, r.minZ) && inside(r.maxX, r.maxY, r.maxZ) && r.minX <= r.maxX && r.minY <= r.maxY && r.minZ <= r.maxZ, `${label} region in bounds`);
      let cells = 0;
      for (let x = r.minX; x <= r.maxX; x++) for (let y = r.minY; y <= r.maxY; y++) for (let z = r.minZ; z <= r.maxZ; z++) {
        if (e.kind === 'collapse' ? isSolidBlock(at(x, y, z)) : at(x, y, z) === AIR) cells++;
      }
      assert.ok(cells > 0, `${label} region has cells to change`);
      assert.ok(!['lava', 'flood', 'door_lock', 'collapse'].includes(e.kind) || e.durationMs > 0, `${label} restores`);
    }
    if (e.regions) for (const r of e.regions) assert.ok(inside(r.minX, r.minY, r.minZ) && inside(r.maxX, r.maxY, r.maxZ), `${label} volume in bounds`);
    if (e.kind === 'electrify' || e.kind === 'gas') assert.ok(e.durationMs > 0 && e.damage > 0 && e.intervalMs > 0, `${label} damage profile`);
    for (const f of e.fields ?? []) assert.equal(at(Math.floor(f.x), Math.floor(f.y), Math.floor(f.z)), AIR, `${label} smoke in air`);
    for (const p of e.points ?? []) {
      assert.equal(at(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), AIR, `${label} fire in air`);
      assert.ok(isSolidBlock(at(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z))), `${label} fire on ground`);
    }
    // The button itself never sits inside its own effect.
    assert.equal(trapEffectContains(e, b.x + 0.5, b.y, b.z + 0.5), false, `${label} button outside its effect`);
  }
  console.log(`${id}: ${traps.length} traitor traps verified (${reachable.size} reachable cells).`);
}
assert.ok(getMapMeta('harbor').traps.length === 0, 'maps without traps carry an empty list');

// ---- 2. Live engine on Minecraft B5.
const TICK = TICK_MS;
let snapshot;
const g = new GameEngine({ mode: 'ttt', mapMeta: getMapMeta('minecraft_b5'), broadcast: (s) => { snapshot = s; } });
for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) g.addClient(id, id);
const policy = g.mode.policy, traps = policy.traps, P = Object.fromEntries([...g.entities].map(([id, p]) => [id, p]));
const place = (p, x, y, z) => Object.assign(p, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true, input: null, spawnProtectedUntil: 0 });
const button = (trapId) => trapButtonPoint(MAP_TRAPS.minecraft_b5.find((t) => t.id === trapId));
const press = (id) => { g.applyInput(id, { keys: { interact: true } }); g.step(TICK); };
const release = (id) => { g.applyInput(id, { keys: { interact: false } }); g.step(TICK); };
const trapEvents = () => (snapshot?.events || []).filter((ev) => ev.kind === 'trap');

assert.equal(traps.defs.length, 3);
place(P.a, button('tnt').x, button('tnt').y, button('tnt').z);
assert.equal(traps.trigger(P.a, 'tnt'), false, 'no traps during preparation');
g.now = policy.phaseEndsAt; g.mode.tick(); assert.equal(policy.phase, 'live');
for (const id of ['a', 'b']) policy.roles.set(id, 'traitor');
for (const id of ['c', 'd', 'e', 'f']) policy.roles.set(id, 'innocent');

// Innocents at the button do nothing; a traitor out of range does nothing.
place(P.c, button('tnt').x, button('tnt').y, button('tnt').z);
press('c'); assert.equal(trapEvents().length, 0, 'innocent cannot press');
assert.equal(policy.buy(P.c, 'ttt:trap:tnt'), false, 'innocent request refused');
release('c');
place(P.a, button('tnt').x + TRAP_RULES.useRange + 1, button('tnt').y, button('tnt').z);
press('a'); assert.equal(trapEvents().length, 0, 'out of range');
assert.equal(policy.buy(P.a, 'ttt:trap:tnt'), false, 'range applies to requests too');
release('a');
assert.equal(traps.status(traps.defs[0]).state, 'ready');

// TNT: an innocent at the mine station dies to world damage, identity stays private.
const tnt = MAP_TRAPS.minecraft_b5[0].effect;
place(P.d, tnt.x, tnt.y - 1.2, tnt.z);
place(P.a, button('tnt').x, button('tnt').y, button('tnt').z);
const beforeHp = P.d.hp;
press('a');
const [ev] = trapEvents();
assert.ok(ev, 'trap event reaches the tick');
assert.equal(ev.id, 'tnt'); assert.equal(ev.by, 'traitor'); assert.equal(ev.effect, 'explosion');
assert.ok(!JSON.stringify(ev).includes('"a"') && !('playerId' in ev), 'event never names the traitor');
assert.ok(snapshot.events.some((e) => e.kind === 'projectileExplode' && e.type === 'trap' && e.id === ''), 'blast event without owner');
assert.ok(P.d.hp < beforeHp, 'innocent inside the blast is hurt');
assert.equal(P.d.state, 'dead', 'point-blank TNT kills');
assert.equal([...policy.corpses.values()].find((c) => c.playerId === 'd').weapon, 'trap', 'corpse reports a trap');
assert.equal(P.a.state, 'alive', 'the traitor at the button is far from the blast');
assert.equal(traps.status(traps.defs[0]).state, 'used', 'single use');
release('a'); press('a'); assert.equal(trapEvents().length, 0, 'a used trap stays silent');
assert.equal(policy.buy(P.a, 'ttt:trap:tnt'), false, 'a used trap refuses requests');
release('a');

// Private state: traitors see the roster, innocents see nothing.
const mine = policy.privateState('a');
assert.equal(mine.traps.length, 3);
assert.deepEqual(mine.traps.map((t) => t.state), ['used', 'ready', 'ready']);
assert.ok(mine.traps.every((t) => t.name && t.face && Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.z)));
assert.equal(policy.privateState('c').traps, undefined, 'innocents get no trap state');
assert.equal(policy.privateState('d').traps, undefined, 'dead traitors get no trap state');
const delivered = [];
const manager = Object.create(LobbyManager.prototype); manager.sendJson = (meta, obj) => delivered.push([meta.id, obj]);
manager._broadcastJson({ engine: g, members: new Map([...g.entities.values()].map((p) => [p.id, { id: p.id, meta: { id: p.id } }])) }, snapshot);
for (const [id, wire] of delivered) {
  const row = wire.players.find((p) => p.id === id);
  assert.equal(!!row.ttt.traps, policy.roles.get(id) === 'traitor' && P[id].state === 'alive', `wire private state for ${id}`);
  assert.ok(wire.players.filter((p) => p.id !== id).every((p) => !p.ttt), 'other rows carry no private state');
}

// Lava flood: request path, block deltas, burning innocents, restore after the duration.
const lava = MAP_TRAPS.minecraft_b5[1].effect, r = lava.region;
place(P.a, button('lava-flood').x, button('lava-flood').y, button('lava-flood').z);
place(P.e, 70.5, 42.02, 28.5);
assert.equal(g.world.getBlock(70, 42, 28), AIR);
assert.equal(policy.buy(P.a, 'ttt:trap:lava-flood'), true, 'traitor request triggers');
assert.equal(g.world.getBlock(70, 42, 28), MC_LAVA);
g.step(TICK);
assert.ok(snapshot.blocks.filter((b) => b.v === MC_LAVA).length >= 50, 'lava deltas reach the clients');
assert.ok(trapEvents().some((e) => e.id === 'lava-flood'));
for (let i = 0; i < 20; i++) g.step(TICK);
assert.ok(P.e.hp < 100, 'standing in trap lava burns');
assert.ok(P.e.lastDamage, 'lava damage is tracked');
let lavaCells = 0;
for (let x = r.minX; x <= r.maxX; x++) for (let z = r.minZ; z <= r.maxZ; z++) if (g.world.getBlock(x, r.minY, z) === MC_LAVA) lavaCells++;
assert.ok(lavaCells >= 50, `lava covers the square (${lavaCells})`);
place(P.e, 100.5, 58.02, 60.5);
g.now += lava.durationMs; g.step(TICK);
assert.equal(g.world.getBlock(70, 42, 28), AIR, 'lava drains after its duration');
assert.ok(snapshot.blocks.some((b) => b.v === AIR), 'restore deltas reach the clients');
assert.equal(traps.fills.length, 0);
assert.equal(traps.status(traps.defs[1]).state, 'used');

// Lockdown: iron seals the corridor except a cell a body occupies; cooldown; restore.
const lock = MAP_TRAPS.minecraft_b5[2], cells = [[57, 43, 54], [58, 43, 54], [57, 44, 54], [58, 44, 54]];
place(P.a, button('lockdown').x, button('lockdown').y, button('lockdown').z);
place(P.f, 57.5, 43.02, 54.5);
press('a');
assert.equal(g.world.getBlock(58, 43, 54), MC_IRON); assert.equal(g.world.getBlock(58, 44, 54), MC_IRON);
assert.equal(g.world.getBlock(57, 43, 54), AIR, 'an occupied cell is skipped');
assert.ok(g.solidAt(58, 43, 54), 'the barricade is solid');
assert.equal(traps.status(lock).state, 'cooldown'); assert.ok(traps.status(lock).cooldown > 0);
assert.equal(policy.buy(P.a, 'ttt:trap:lockdown'), false, 'cooldown refuses');
release('a');
g.now += lock.effect.durationMs; g.step(TICK);
for (const [x, y, z] of cells) assert.equal(g.world.getBlock(x, y, z), AIR, `barricade ${x},${y},${z} lifts`);
g.now += lock.cooldownMs; g.step(TICK);
assert.equal(traps.status(lock).state, 'ready', 'cooldown elapses');
place(P.f, 30.5, 43.02, 60.5);
assert.equal(policy.buy(P.a, 'ttt:trap:lockdown'), true, 'ready again');
for (const [x, y, z] of cells) assert.equal(g.world.getBlock(x, y, z), MC_IRON);

// Round end reverts every block change at once.
for (const id of ['a', 'b']) { P[id].state = 'dead'; policy.onPlayerDeath(P[id]); }
g.mode.tick(); assert.equal(policy.phase, 'post');
for (const [x, y, z] of cells) assert.equal(g.world.getBlock(x, y, z), AIR, 'round end lifts the barricade');
assert.equal(traps.fills.length, 0); assert.equal(traps.volumes.length, 0);
for (const p of g.entities.values()) if (!p.bot) g.mode.approveContinuation(p.id, g.mode.matchSnapshot().continuation.id);
g.now = g.mode.phaseEndsAt; g.mode.tick(); assert.equal(policy.phase, 'prep');
assert.deepEqual(traps.defs.map((t) => traps.status(t).state), ['ready', 'ready', 'ready'], 'a new round re-arms every trap');

// ---- 3. Waterworld: electrified pool, chlorine gas, tester sabotage by a bot.
const w = new GameEngine({ mode: 'ttt', mapMeta: getMapMeta('waterworld'), broadcast: (s) => { snapshot = s; } });
for (const id of ['t', 'u', 'swim', 'deck', 'far']) w.addClient(id, id);
w.addBot('bot', 'Bot');
const wp = w.mode.policy, W = Object.fromEntries([...w.entities].map(([id, p]) => [id, p]));
w.now = wp.phaseEndsAt; w.mode.tick(); assert.equal(wp.phase, 'live');
for (const id of ['t', 'bot']) wp.roles.set(id, 'traitor');
for (const id of ['u', 'swim', 'deck', 'far']) wp.roles.set(id, 'innocent');
const wb = (id) => trapButtonPoint(MAP_TRAPS.waterworld.find((t) => t.id === id));
place(W.t, wb('pool-shock').x, wb('pool-shock').y, wb('pool-shock').z);
place(W.swim, 170.5, 6.6, 50.5); W.swim.grounded = false;
place(W.deck, 170.5, 11.02, 30.5);
place(W.far, 70.5, 9.02, 141.5);
place(W.u, 110.5, 9.02, 141.5);
place(W.bot, 60.5, 9.02, 141.5);
assert.ok(FLUID_BLOCKS.has(w.world.getBlock(170, 6, 50)), 'the swimmer is in pool water');
w.applyInput('t', { keys: { interact: true } });
for (let i = 0; i < 30; i++) w.step(TICK);
assert.ok(W.swim.hp < 100, 'a swimmer in the electrified pool is hurt');
assert.equal(W.deck.hp, 100); assert.equal(W.far.hp, 100); assert.equal(W.t.hp, 100);
assert.equal(wp.privateState('t').traps.find((t) => t.id === 'pool-shock').state, 'cooldown');
w.applyInput('t', { keys: { interact: false } }); w.step(TICK);
place(W.t, wb('chlorine').x, wb('chlorine').y, wb('chlorine').z);
assert.equal(wp.buy(W.t, 'ttt:trap:chlorine'), true);
w.step(TICK);
assert.equal(snapshot.smokeFields.filter((f) => f.id.startsWith('smoke-trap-')).length, 3, 'chlorine smoke fields');
assert.ok(snapshot.smokeFields.every((f) => f.radius === 5));
const deckHp = W.deck.hp;
for (let i = 0; i < 40; i++) w.step(TICK);
assert.ok(W.deck.hp < deckHp, 'gas hurts on the deck');
assert.equal(W.far.hp, 100, 'gas stays on the deck');
w.now += 15000; w.step(TICK);
assert.equal(wp.traps.volumes.length, 0, 'gas dissipates');
// Traitor bot: an innocent riding the tester pulls the bot to the button, then it presses.
W.bot.owned = ['rifle'];
place(W.u, 124.5, 19.5, 87.5);
place(W.bot, wb('tester').x + 6, wb('tester').y, wb('tester').z);
let goal = wp.botGoal(W.bot);
assert.equal(goal.kind, 'move'); assert.deepEqual(goal.target, wb('tester'));
place(W.bot, wb('tester').x, wb('tester').y, wb('tester').z);
goal = wp.botGoal(W.bot);
assert.equal(goal.kind, 'fight');
assert.equal(wp.traps.status(MAP_TRAPS.waterworld[2]).state, 'cooldown', 'the bot pressed the tester button');
for (let i = 0; i < 30; i++) w.step(TICK);
assert.ok(W.u.hp < 100, 'the sabotaged tester shocks its rider');
place(W.u, 124.5, 19.5, 87.5);
assert.equal(wp.botGoal(W.bot).kind, 'fight', 'nothing ready, no trap goal');

// ---- 4. Nuketown: a gas-main fire burns through the existing molotov fields.
const n = new GameEngine({ mode: 'ttt', mapMeta: getMapMeta('nuketown'), broadcast: (s) => { snapshot = s; } });
for (const id of ['t', 'v', 'x'] ) n.addClient(id, id);
const np = n.mode.policy, N = Object.fromEntries([...n.entities].map(([id, p]) => [id, p]));
n.now = np.phaseEndsAt; n.mode.tick(); assert.equal(np.phase, 'live');
np.roles.set('t', 'traitor'); np.roles.set('v', 'innocent'); np.roles.set('x', 'innocent');
const nb = trapButtonPoint(MAP_TRAPS.nuketown.find((t) => t.id === 'gas-main'));
const fire = MAP_TRAPS.nuketown.find((t) => t.id === 'gas-main').effect;
place(N.t, nb.x, nb.y, nb.z); place(N.v, fire.points[0].x, 15.02, fire.points[0].z); place(N.x, 30.5, 15.02, 40.5);
assert.equal(np.buy(N.t, 'ttt:trap:gas-main'), true);
n.step(TICK);
assert.equal(snapshot.fireFields.length, 1, 'fire field appears'); assert.ok(Math.abs(snapshot.fireFields[0].expiresAt - n.now - (fire.durationMs - TICK)) < 1, 'fire lasts the authored duration');
for (let i = 0; i < 70; i++) n.step(TICK);
assert.ok(N.v.hp < 100, 'the gas-main fire burns'); assert.equal(N.x.hp, 100);

// ---- 5. Protocol.
assert.equal(parseBuyFrame({ t: 'buy', weapon: 'ttt:trap:tnt' }), 'ttt:trap:tnt');
assert.equal(parseBuyFrame({ t: 'buy', weapon: 'ttt:trap:../x' }), null);
assert.equal(isTrapRequest('ttt:trap:'), false);
console.log('TTT traps: placement on every map, role/phase/range gating, TNT, lava flood, lockdown, cooldown/uses, private state, round reset, pool shock, chlorine, bot tester sabotage, gas-main fire passed.');
