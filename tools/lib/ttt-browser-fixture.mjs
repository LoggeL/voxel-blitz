// Test-only preload for the TTT browser tests. IPC arranges roles, positions
// and pickups; the round itself runs through the production engine.
import { humanPlayer, serveEngineCommands } from './engine-fixture.mjs';

const firstBot = engine => [...engine.entities.values()].find(entity => entity.bot);
const still = { vx: 0, vy: 0, vz: 0, input: null };

serveEngineCommands({
  stage(engine) {
    const player = humanPlayer(engine);
    const item = [...engine.mode.policy.pickups.values()][0];
    Object.assign(player, { x: item.x, y: item.y, z: item.z, ...still });
    // Keep bots still so UI checks do not end the round mid-capture.
    engine.tickHooks.length = 0;
    for (const bot of engine.entities.values()) bot.input = null;
    return { item, id: player.id };
  },
  reveal(engine) {
    const player = humanPlayer(engine);
    const policy = engine.mode.policy;
    engine.now = policy.phaseEndsAt;
    engine.mode.tick();
    if (policy.roles.get(player.id) !== 'traitor') {
      const [traitor] = [...policy.roles].find(([, role]) => role === 'traitor');
      policy.roles.set(traitor, 'innocent');
      policy.wallets.set(traitor, 0);
      policy.roles.set(player.id, 'traitor');
      policy.wallets.set(player.id, 2);
    }
    return true;
  },
  grenade(engine) {
    const player = humanPlayer(engine);
    const item = [...engine.mode.policy.pickups.values()].find(pickup => pickup.grenade === 'smoke');
    Object.assign(player, { x: item.x, y: item.y, z: item.z, ...still });
    return item;
  },
  ally(engine) {
    const player = humanPlayer(engine);
    const ally = firstBot(engine);
    engine.mode.policy.roles.set(ally.id, 'traitor');
    const dx = player.x > 50 ? -12 : 12;
    Object.assign(ally, { x: player.x + dx, y: player.y, z: player.z, ...still });
    for (let y = Math.floor(player.y); y < Math.floor(player.y) + 4; y++) {
      engine.world.setBlock(Math.floor(player.x + dx / 2), y, Math.floor(player.z), 1);
    }
    return { name: ally.name, id: ally.id };
  },
  corpse(engine) {
    const player = humanPlayer(engine);
    const victim = firstBot(engine);
    engine.mode.policy.roles.set(victim.id, 'traitor');
    Object.assign(victim, { x: player.x + 1, y: player.y, z: player.z, vx: 0, vy: 0, vz: 0 });
    engine.killPlayer(victim, player, 'rifle', false);
    return { name: victim.name, id: victim.id };
  },
  finish(engine) {
    const player = humanPlayer(engine);
    const policy = engine.mode.policy;
    for (const victim of engine.entities.values()) {
      if (victim.state === 'alive' && policy.roles.get(victim.id) === 'innocent') {
        engine.killPlayer(victim, player, 'rifle', false);
      }
    }
    engine.mode.tick();
    return true;
  },
  'radar-target-move'(engine) {
    const target = firstBot(engine);
    target.x += 5;
    return { x: target.x };
  },
  'radar-scan'(engine) {
    const policy = engine.mode.policy;
    const radar = policy.privateState(humanPlayer(engine).id).radar;
    engine.now = radar.nextScanAt;
    policy.equipment.tick();
    return true;
  },
  'teleporter-stage'(engine) {
    const policy = engine.mode.policy;
    policy.equipment.clear();
    policy.wallets.set(humanPlayer(engine).id, 2);
    return teleportToDistantPad(engine);
  },
  'teleporter-away': teleportToDistantPad,
  innocent(engine) {
    const player = humanPlayer(engine);
    const policy = engine.mode.policy;
    policy.roles.set(player.id, 'innocent');
    policy.wallets.set(player.id, 0);
    policy.roles.set(firstBot(engine).id, 'traitor');
    return true;
  },
});

function teleportToDistantPad(engine) {
  const player = humanPlayer(engine);
  const policy = engine.mode.policy;
  const mark = engine.spawnPoints.find(spawn => policy.equipment.validMark(spawn, player)
    && Math.hypot(spawn.x - player.x, spawn.z - player.z) > 10);
  if (!mark) throw new Error('No free distant teleport pad');
  Object.assign(player, { x: mark.x, y: mark.y, z: mark.z, ...still, grounded: true });
  return mark;
}

await import('../../server/index.js');
