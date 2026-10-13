// Private IPC test preload. Every observed frame is the production simulation,
// delivered by its normal websocket; this creates no HTTP mutation endpoint.
import { GameEngine } from '../../server/game.js';
import { damageBlock, fireOneShot } from '../../server/sim/combat.js';
import { AIR, CONCRETE, BLOCK_HP } from '../../shared/worlddata.js';
import { reloadPlan } from '../../shared/combatmath.js';
import { humanPlayer, serveEngineCommands } from './engine-fixture.mjs';

const sourceId = 'acoustics-source';
const listener = { x: 19.5, y: 2.01, z: 20.5 };
const source = { x: 25.5, y: 2.01, z: 20.5 };
const wall = [];
const shell = [];
const authority = [];
let lastReload = null;
const step = GameEngine.prototype.step;
GameEngine.prototype.step = function (...args) {
  const player = [...this.entities.values()].find(p => p.id !== sourceId && !p.bot);
  const before = player && { reloading: player.reloading, mag: player.mag[player.weapon], reserve: player.reserve[player.weapon] };
  const result = step.apply(this, args);
  if (player && !before.reloading && player.reloading) {
    lastReload = { started: this.now, seconds: player.reloadState.seconds,
      expected: reloadPlan(player.def, before.mag, before.reserve, player.panic).seconds,
      panic: player.panic, magBefore: before.mag, reserveBefore: before.reserve, weapon: player.def.id };
    authority.push(lastReload);
  }
  if (player && before.reloading && !player.reloading && lastReload) {
    Object.assign(lastReload, { ended: this.now, elapsed: (this.now - lastReload.started) / 1000,
      magAfter: player.mag[player.weapon], reserveAfter: player.reserve[player.weapon] });
    lastReload = null;
  }
  return result;
};

function put(engine, x, y, z, value) {
  if (engine.world.getBlock(x, y, z) === value) return;
  engine.world.setBlock(x, y, z, value);
  engine.pushBlockDelta(x, y, z, value);
}
function destroy(engine, cells) {
  const player = humanPlayer(engine);
  let destroyed = 0;
  for (const [x, y, z] of cells) {
    const type = engine.world.getBlock(x, y, z);
    if (type === AIR) continue;
    damageBlock(x, y, z, type, BLOCK_HP[type] + 1, engine.contexts.combat, player.id);
    if (engine.world.getBlock(x, y, z) === AIR) destroyed++;
  }
  return { destroyed, revision: engine.blockRevision };
}

serveEngineCommands({
  stage(engine) {
    const player = humanPlayer(engine);
    engine.powerups.active.clear();
    engine.powerups.nextSpawnAt = engine.now + 600_000;
    // A wide clear apron removes unrelated map geometry from the acoustic probe.
    for (let x = 5; x <= 42; x++) for (let z = 4; z <= 42; z++) {
      put(engine, x, 1, z, CONCRETE);
      for (let y = 2; y <= 25; y++) put(engine, x, y, z, AIR);
    }
    for (let x = 14; x <= 29; x++) for (let z = 14; z <= 27; z++) {
      for (let y = 2; y <= 7; y++) {
        if (x !== 14 && x !== 29 && z !== 14 && z !== 27 && y !== 7) continue;
        put(engine, x, y, z, CONCRETE); shell.push([x, y, z]);
      }
    }
    for (let y = 2; y <= 6; y++) for (let z = 15; z <= 26; z++) {
      put(engine, 22, y, z, CONCRETE); wall.push([22, y, z]);
    }
    Object.assign(player, listener, { vx: 0, vy: 0, vz: 0, input: null,
      hp: 100, armor: 0, panic: 0, pain: 0, grounded: true,
      spawnProtectedUntil: 0, spawnProtected: false, deployT: 0 });
    engine.addClient(sourceId, 'ACOUSTIC TEST SOURCE');
    const remote = engine.entities.get(sourceId);
    Object.assign(remote, source, { yaw: -Math.PI / 2, pitch: 0.8, vx: 0, vy: 0, vz: 0,
      input: null, grounded: true, spawnProtectedUntil: 0, spawnProtected: false, deployT: 0 });
    authority.length = 0;
    return { listener, source, localId: player.id, wallCells: wall.length, shellCells: shell.length,
      revision: engine.blockRevision };
  },
  shot(engine) {
    const remote = engine.entities.get(sourceId);
    remote.mag[remote.weapon] = remote.def.magSize;
    remote.cooldown = 0;
    fireOneShot(remote, engine.contexts.combat);
    return { shotSeq: remote.shotSeq, source: [remote.eyeX, remote.eyeY, remote.eyeZ], now: engine.now,
      events: engine.tickEvents.filter(event => event.kind === 'shoot') };
  },
  doorway(engine) { return destroy(engine, wall.filter(([, y, z]) => y <= 4 && z >= 23 && z <= 24)); },
  breach(engine) { return destroy(engine, wall); },
  outdoors(engine) { return destroy(engine, shell); },
  restoreRoom(engine) {
    for (const [x, y, z] of [...shell, ...wall]) put(engine, x, y, z, CONCRETE);
    return { revision: engine.blockRevision };
  },
  calm(engine) {
    const player = humanPlayer(engine);
    player.hp = 100; player.armor = 0; player.panic = 0; player.pain = 0;
    return { hp: player.hp, panic: player.panic, pain: player.pain };
  },
  hurt(engine) {
    const player = humanPlayer(engine);
    const lethal = player.takeDamage(55, false, engine.entities.get(sourceId), 'rifle');
    return { hp: player.hp, panic: player.panic, pain: player.pain, lethal };
  },
  state(engine) {
    const player = humanPlayer(engine);
    return { now: engine.now, hp: player.hp, panic: player.panic, pain: player.pain,
      reloading: player.reloading, reload: player.reloadState, weapon: player.def.id,
      mag: player.mag[player.weapon], reserve: player.reserve[player.weapon],
      wall: engine.world.getBlock(22, 3, 20), authority };
  },
});

await import('../../server/index.js');
