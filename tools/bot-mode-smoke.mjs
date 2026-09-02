import assert from 'node:assert/strict';

import { attachBots } from '../server/bots.js';
import { GameEngine } from '../server/game.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { MODE_RULES, WEAPON_PRICES } from '../shared/modes.js';
import {
  AIR,
  CONCRETE,
  GROUND,
  METAL,
  SX,
  SY,
  SZ,
  getBlock as getSharedBlock,
  setBlock as setSharedBlock,
} from '../shared/worlddata.js';
import { TICK_MS } from '../server/protocol.js';
import { PLAYER_KEYS } from './lib/protocol-contract.mjs';

const CLOCK_START = 1_000_000;
const FEET_Y = GROUND + 1.02;
const BUY_PRIORITY = ['sniper', 'lmg', 'longarc', 'rifle', 'shotgun', 'smg'];
const MAP_META = Object.freeze({
  id: 'foundry',
  spawns: {
    fun: [
      { x: 16.5, y: FEET_Y, z: 16.5, index: 0 },
      { x: 18.5, y: FEET_Y, z: 16.5, index: 1 },
    ],
    tdm: {
      alpha: [
        { x: 20.5, y: FEET_Y, z: 20.5, index: 0 },
        { x: 20.5, y: FEET_Y, z: 24.5, index: 1 },
      ],
      bravo: [
        { x: 30.5, y: FEET_Y, z: 20.5, index: 0 },
        { x: 30.5, y: FEET_Y, z: 24.5, index: 1 },
      ],
    },
    snd: {
      attackers: [
        { x: 20.5, y: FEET_Y, z: 30.5, index: 0 },
        { x: 22.5, y: FEET_Y, z: 30.5, index: 1 },
      ],
      defenders: [
        { x: 100.5, y: FEET_Y, z: 30.5, index: 0 },
        { x: 102.5, y: FEET_Y, z: 30.5, index: 1 },
      ],
    },
  },
  sites: [
    { id: 'A', minX: 40, maxX: 42, minZ: 30, maxZ: 32, y: FEET_Y },
    { id: 'B', minX: 88, maxX: 92, minZ: 68, maxZ: 72, y: FEET_Y },
  ],
});

function makeWorld() {
  const stats = { blockReads: 0, heightReads: 0 };
  const spawnPool = MAP_META.spawns.fun;
  return {
    meta: MAP_META,
    stats,
    getBlock(x, y, z) {
      stats.blockReads++;
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      if (y < 0 || x < 0 || z < 0 || x >= SX || z >= SZ) return METAL;
      if (y >= SY) return AIR;
      return y <= GROUND ? CONCRETE : AIR;
    },
    setBlock() {
      return false;
    },
    heightAt(x, z) {
      stats.heightReads++;
      return x >= 0 && z >= 0 && x < SX && z < SZ ? GROUND : -1;
    },
    findSpawns(n) {
      return Array.from({ length: Math.max(0, n | 0) }, (_, i) => ({
        ...spawnPool[i % spawnPool.length],
        index: i % spawnPool.length,
      }));
    },
  };
}

function createEngine(mode, broadcast = undefined) {
  const world = makeWorld();
  const realNow = Date.now;
  Date.now = () => CLOCK_START;
  try {
    const engine = new GameEngine({ mode, world, mapMeta: MAP_META, broadcast });
    assert.equal(engine.now, CLOCK_START, `${mode} engine clock is deterministic`);
    assert.strictEqual(engine.world, world, `${mode} engine retains its room-owned world`);
    return engine;
  } finally {
    Date.now = realNow;
  }
}

function captureInputs(engine) {
  const calls = [];
  const applyInput = engine.applyInput.bind(engine);
  engine.applyInput = (id, input) => {
    if (String(id).startsWith('bot-')) {
      calls.push({
        id: String(id),
        phase: engine.mode.phase,
        round: engine.mode.round,
        owned: engine.mode.playerSnapshot(id).owned.slice(),
        input: structuredClone(input),
      });
    }
    return applyInput(id, input);
  };
  return calls;
}

function latestCall(calls, id) {
  const call = calls.findLast((candidate) => candidate.id === id);
  assert.ok(call, `bot input captured for ${id}`);
  return call;
}

function setPosition(player, x, z, y = FEET_Y) {
  player.x = x; player.y = y; player.z = z;
  player.vx = 0; player.vy = 0; player.vz = 0;
  player.yaw = 0; player.pitch = 0;
  player.grounded = false;
}

const CLEAR_SHOT_SETTLE_TICKS = 16;

function stageClearTdmShot(engine, shooter, target, label) {
  const shooterTeam = engine.mode.teamFor(shooter);
  const targetTeam = engine.mode.teamFor(target);
  const shooterSpawn = MAP_META.spawns.tdm[shooterTeam]?.[0];
  const targetSpawn = MAP_META.spawns.tdm[targetTeam]?.[0];
  assert.ok(shooterSpawn,
    `${label}: ${shooter.id} team ${shooterTeam} has a serialized TDM spawn`);
  assert.ok(targetSpawn,
    `${label}: ${target.id} team ${targetTeam} has a serialized TDM spawn`);

  setPosition(shooter, shooterSpawn.x, shooterSpawn.z, shooterSpawn.y);
  setPosition(target, targetSpawn.x, targetSpawn.z, targetSpawn.y);
  assert.equal(engine.world.heightAt(shooter.x, shooter.z), GROUND,
    `${label}: ${shooter.id} serialized spawn is standable in the engine world`);
  assert.equal(engine.world.heightAt(target.x, target.z), GROUND,
    `${label}: ${target.id} serialized spawn is standable in the engine world`);
  assert.equal(engine.enemyHasSpawnLos(shooter, targetSpawn), true,
    `${label}: serialized TDM spawns provide map-clear LOS from ${shooter.id} to ${target.id}`);

  const dx = target.x - shooter.x;
  const dy = target.y + 1.15 - shooter.eyeY;
  const dz = target.z - shooter.z;
  const flat = Math.hypot(dx, dz);
  const distance = Math.hypot(dx, dy, dz);
  shooter.yaw = Math.atan2(-dx, -dz);
  shooter.pitch = Math.atan2(dy, flat);
  const ray = { x: dx / distance, y: dy / distance, z: dz / distance };

  let resolved = null;
  for (let tick = 0; tick <= CLEAR_SHOT_SETTLE_TICKS; tick++) {
    resolved = engine.nearestVictim(
      shooter,
      [shooter.x, shooter.eyeY, shooter.z],
      ray,
      distance + 1,
    );
    if (resolved?.victim === target) break;
    if (tick < CLEAR_SHOT_SETTLE_TICKS) engine.step(TICK_MS);
  }
  assert.strictEqual(resolved?.victim, target,
    `${label}: ${shooter.id} ray must resolve ${target.id} within ${CLEAR_SHOT_SETTLE_TICKS} history-settle ticks`);
  return ray;
}

function assertPoint(actual, expected, label) {
  assert.ok(actual, `${label} has a target`);
  assert.equal(actual.x, expected.x, `${label} target x`);
  assert.equal(actual.y, expected.y, `${label} target y`);
  assert.equal(actual.z, expected.z, `${label} target z`);
}

function transitionToLive(engine, calls) {
  assert.equal(engine.mode.phase, 'prep');
  const before = calls.length;
  engine.now = engine.mode.phaseEndsAt;
  engine.step(0);
  assert.equal(engine.mode.phase, 'live', 'fixed clock step starts S&D live phase');
  const boundaryCalls = calls.slice(before);
  assert.equal(boundaryCalls.length, engine.stats.bots,
    'every bot runs before the mode controller changes the boundary tick to live');
  assert.ok(boundaryCalls.every((call) => call.phase === 'prep' && !call.input.wantFire),
    'the live-transition tick is still a fire-free prep decision for every bot');
}

function disposeAndProveUnhooked(engine, manager, calls) {
  const beforeCalls = calls.length;
  let probeTicks = 0;
  const removeProbe = engine.registerTickHook(() => { probeTicks++; });
  const beforeHooks = engine.tickHooks.length;
  try {
    manager.dispose();
    assert.equal(engine.tickHooks.length, beforeHooks - 1,
      'dispose removes only the bot tick hook');
    assert.equal(engine.stats.bots, 0, 'dispose removes bot entities');
    engine.step(TICK_MS);
    assert.equal(calls.length, beforeCalls, 'disposed manager cannot submit stale bot inputs');
    assert.equal(probeTicks, 1, 'dispose leaves unrelated engine tick hooks active');
  } finally {
    removeProbe();
  }
  assert.equal(engine.tickHooks.length, beforeHooks - 2, 'tick-hook probe removes itself');
}

function installSharedWorldWall() {
  const saved = [];
  for (let x = 20; x <= 30; x++) {
    for (let y = GROUND + 1; y <= GROUND + 3; y++) {
      const z = 20;
      saved.push({ x, y, z, value: getSharedBlock(x, y, z) });
      setSharedBlock(x, y, z, x === 25 ? CONCRETE : AIR);
    }
  }
  return () => {
    for (const cell of saved) setSharedBlock(cell.x, cell.y, cell.z, cell.value);
  };
}

function proveTdmTargeting() {
  const restoreSharedWorld = installSharedWorldWall();
  let engine;
  let calls;
  let manager;
  try {
    engine = createEngine('tdm');
    calls = captureInputs(engine);
    manager = attachBots(engine, 4);

    const self = engine.entities.get('bot-0');
    const enemy = engine.entities.get('bot-1');
    const teammate = engine.entities.get('bot-2');
    const otherEnemy = engine.entities.get('bot-3');

    assert.equal(engine.mode.teamFor(self), engine.mode.teamFor(teammate), 'TDM fixture has a closer teammate');
    assert.notEqual(engine.mode.teamFor(self), engine.mode.teamFor(enemy), 'TDM fixture has an enemy');
    setPosition(self, 20.5, 20.5);
    setPosition(teammate, 20.5, 16.5);
    setPosition(enemy, 30.5, 20.5);
    setPosition(otherEnemy, 110.5, 80.5);

    engine.step(TICK_MS);

    const decision = latestCall(calls, self.id).input;
    assert.ok(decision.yaw < -0.1,
      'TDM bot excludes its nearer teammate and aims toward the selected enemy');
    assert.equal(decision.wantFire, true, 'TDM bot attacks its visible enemy');
    assert.ok(engine.world.stats.blockReads > 0, 'bot LOS reads the engine room world');
  } finally {
    try {
      if (manager) disposeAndProveUnhooked(engine, manager, calls);
    } finally {
      restoreSharedWorld();
    }
  }
}

function proveAuthoritativeRowsAndProtection() {
  const snapshots = [];
  const engine = createEngine('tdm', (snapshot) => snapshots.push(snapshot));
  engine.addClient('human-0', 'Human');
  const calls = captureInputs(engine);
  const manager = attachBots(engine, 2);
  let removeDeterministicInputs = null;
  try {
    const human = engine.entities.get('human-0');
    const bot = engine.entities.get('bot-0');
    const teammate = engine.entities.get('bot-1');
    assert.notEqual(engine.mode.teamFor(bot), engine.mode.teamFor(human),
      'bot/human protection fixture requires opposing TDM teams');
    assert.equal(engine.mode.teamFor(human), engine.mode.teamFor(teammate),
      'bot/human protection fixture requires bot-1 to share the human team');

    setPosition(teammate, MAP_META.spawns.snd.defenders[0].x, MAP_META.spawns.snd.defenders[0].z);
    let forcedBotFire = null;
    let forcedSeq = 100_000;
    removeDeterministicInputs = engine.registerTickHook(() => {
      for (const controlledBot of [bot, teammate]) {
        engine.applyInput(controlledBot.id, {
          seq: ++forcedSeq,
          keys: {},
          yaw: controlledBot.yaw,
          pitch: controlledBot.pitch,
          wantFire: controlledBot === forcedBotFire,
          wantAds: false,
          reload: false,
        });
      }
    });

    human.hp = 73;
    const botRay = stageClearTdmShot(
      engine,
      bot,
      human,
      'protected-human bot shot staging',
    );
    assert.equal(engine.mode.canDamage(bot, human), true,
      'protected-human staging must resolve as enemy damage before protection is enabled');
    bot.deployT = 0;
    bot.cooldown = 0;
    bot.reloading = false;
    bot.spawnProtectedUntil = engine.now + 1_500;
    bot.spawnProtected = true;
    human.spawnProtectedUntil = engine.now + 1_500;
    human.spawnProtected = true;

    assert.equal(engine.mode.canDamage(bot, human), false,
      'protected-human canDamage must reject bot-0 as the opposing shooter');
    assert.equal(
      engine.nearestVictim(
        bot,
        [bot.x, bot.eyeY, bot.z],
        botRay,
        Math.hypot(human.x - bot.x, human.z - bot.z) + 1,
      ),
      null,
      'protected-human hit resolution must remove human-0 from the staged clear bot ray',
    );

    const beforeBotMag = bot.mag[bot.weapon];
    forcedBotFire = bot;
    engine.step(TICK_MS);
    forcedBotFire = null;
    assert.equal(latestCall(calls, bot.id).input.wantFire, true,
      'deterministic post-AI bot input must submit the staged protected-human shot');
    assert.equal(bot.firing, true,
      'staged bot input must reach the authoritative accepted-fire path');
    assert.equal(bot.mag[bot.weapon], beforeBotMag - 1,
      'accepted protected-human bot shot must consume exactly one round');
    assert.equal(bot.spawnProtected, false,
      'accepted protected-human bot shot must clear bot-0 shooter protection');
    assert.equal(bot.spawnProtectedUntil, 0,
      'accepted protected-human bot shot must clear bot-0 protection deadline');
    assert.equal(human.hp, 73,
      'protected human-0 must retain exactly 73 HP after the accepted bot shot');
    assert.equal(human.spawnProtected, true,
      'blocked bot damage must leave human-0 target protection active');

    const tick = snapshots.at(-1);
    assert.ok(tick && Array.isArray(tick.players),
      'accepted protected-human bot shot must emit an authoritative player snapshot');
    assert.deepEqual(tick.players.map((row) => row.id).sort(),
      ['bot-0', 'bot-1', 'human-0'], 'snapshot carries exact bot and human identities');
    for (const row of tick.players) {
      assert.equal(Object.keys(row).sort().join(','), PLAYER_KEYS,
        `${row.id} carries the complete authoritative player row`);
      assert.ok(Number.isFinite(row.pain) && row.pain >= 0 && row.pain <= 1,
        `${row.id} pain remains normalized to 0..1`);
      assert.equal(typeof row.spawnProtected, 'boolean',
        `${row.id} spawn protection is authoritative boolean state`);
    }
    assert.deepEqual(
      Object.keys(tick.players.find((row) => row.id === bot.id)).sort(),
      Object.keys(tick.players.find((row) => row.id === human.id)).sort(),
      'bot and human snapshots expose identical player contracts',
    );

    bot.hp = 61;
    const humanRay = stageClearTdmShot(
      engine,
      human,
      bot,
      'protected-bot human shot staging',
    );
    assert.equal(engine.mode.canDamage(human, bot), true,
      'protected-bot staging must resolve as enemy damage before protection is enabled');
    human.deployT = 0;
    human.cooldown = 0;
    human.reloading = false;
    human.spawnProtectedUntil = engine.now + 1_500;
    human.spawnProtected = true;
    bot.spawnProtectedUntil = engine.now + 1_500;
    bot.spawnProtected = true;
    assert.equal(engine.mode.canDamage(human, bot), false,
      'protected-bot canDamage must reject human-0 as the opposing shooter');
    assert.equal(
      engine.nearestVictim(
        human,
        [human.x, human.eyeY, human.z],
        humanRay,
        Math.hypot(bot.x - human.x, bot.z - human.z) + 1,
      ),
      null,
      'protected-bot hit resolution must remove bot-0 from the staged clear human ray',
    );

    const beforeHumanMag = human.mag[human.weapon];
    engine.applyInput(human.id, {
      seq: 1,
      keys: {},
      yaw: human.yaw,
      pitch: human.pitch,
      wantFire: true,
      wantAds: false,
      reload: false,
    });
    engine.step(TICK_MS);
    assert.equal(human.firing, true,
      'staged human input must reach the authoritative accepted-fire path');
    assert.equal(human.mag[human.weapon], beforeHumanMag - 1,
      'accepted protected-bot human shot must consume exactly one round');
    assert.equal(human.spawnProtected, false,
      'accepted protected-bot human shot must clear human-0 shooter protection');
    assert.equal(human.spawnProtectedUntil, 0,
      'accepted protected-bot human shot must clear human-0 protection deadline');
    assert.equal(bot.hp, 61,
      'protected bot-0 must retain exactly 61 HP after the accepted human shot');
    assert.equal(bot.spawnProtected, true,
      'blocked human damage must leave bot-0 target protection active');
  } finally {
    if (removeDeterministicInputs) removeDeterministicInputs();
    disposeAndProveUnhooked(engine, manager, calls);
  }
}

function proveGunGameProgression() {
  const engine = createEngine('gungame');
  engine.addClient('human-0', 'Human');
  engine.addClient('human-1', 'Opponent');
  {
    const killer = engine.entities.get('human-0');
    const victim = engine.entities.get('human-1');
    for (let level = 0; level < MODE_RULES.gungame.weaponOrder.length; level++) {
      const required = MODE_RULES.gungame.weaponOrder[level];
      const slot = WEAPON_IDS.indexOf(required);
      assert.equal(killer.weapon, slot, `Gun Game level ${level} equips ${required}`);
      assert.deepEqual(engine.mode.playerSnapshot(killer).owned, [required],
        `Gun Game level ${level} owns only ${required}`);

      engine.killPlayer(victim, killer, required, level === 3, {
        longRange: level === 3,
        noScope: level === 3,
      });
      assert.equal(killer.score, level + 1,
        `Gun Game valid ${required} kill advances exactly one level`);
      if (level + 1 < MODE_RULES.gungame.weaponOrder.length) {
        assert.equal(killer.weapon,
          WEAPON_IDS.indexOf(MODE_RULES.gungame.weaponOrder[level + 1]),
        'Gun Game immediately equips the next weapon');
        assert.equal(engine.forceRespawn(victim), true,
          'Gun Game victim uses the authoritative timed-respawn path');
      }
    }

    assert.equal(engine.mode.phase, 'post', 'final revolver kill concludes Gun Game');
    assert.equal(engine.mode.matchWinner, killer.id, 'Gun Game winner is the final killer');
    const finalKill = engine.tickEvents.findLast((event) => event.kind === 'kill');
    const markedKill = engine.tickEvents.find((event) => event.kind === 'kill' && event.hs);
    assert.deepEqual(
      { hs: markedKill?.hs, lr: markedKill?.lr, ns: markedKill?.ns },
      { hs: true, lr: true, ns: true },
      'kill events preserve authoritative HEADSHOT, LONG RANGE, and NO-SCOPE markers',
    );
    assert.equal(finalKill?.w, 'revolver', 'final Gun Game kill reports its required weapon');

    engine.now = engine.mode.phaseEndsAt;
    engine.step(0);
    assert.equal(engine.mode.phase, 'live', 'Gun Game post phase resets to live');
    assert.equal(killer.score, 0, 'Gun Game reset clears progression score');
    assert.equal(killer.weapon, WEAPON_IDS.indexOf(MODE_RULES.gungame.weaponOrder[0]),
      'Gun Game reset restores the first weapon');
  }
}

function proveSndEconomyAndPrepSafety() {
  const engine = createEngine('snd');
  const calls = captureInputs(engine);
  const purchases = [];
  const purchase = engine.mode.purchase.bind(engine.mode);
  engine.mode.purchase = (player, weapon) => {
    const before = engine.mode.playerSnapshot(player);
    const result = purchase(player, weapon);
    const after = engine.mode.playerSnapshot(player);
    purchases.push({ id: String(player.id), weapon, before, after, result });
    return result;
  };

  const manager = attachBots(engine, 4);
  try {
    setPosition(engine.entities.get('bot-0'), 30.5, 30.5);
    setPosition(engine.entities.get('bot-1'), 34.5, 30.5);
    setPosition(engine.entities.get('bot-2'), 30.5, 34.5);
    setPosition(engine.entities.get('bot-3'), 34.5, 34.5);

    engine.step(TICK_MS);
    assert.ok(calls.filter((call) => call.phase === 'prep').length >= 4, 'prep decisions were exercised');
    assert.ok(calls.filter((call) => call.phase === 'prep').every((call) => !call.input.wantFire),
      'S&D bots never request fire during prep even with visible enemies');
    assert.equal(purchases.length, 0, 'bots do not attempt an unaffordable opening-round purchase');

    transitionToLive(engine, calls);
    const alpha = engine.entities.get('bot-0');
    for (const player of engine.entities.values()) {
      if (engine.mode.teamFor(player) !== engine.mode.teamFor(alpha)) {
        engine.killPlayer(player, null, 'smoke', false);
      }
    }
    engine.step(0);
    assert.equal(engine.mode.phase, 'post', 'elimination reaches post phase without timers');
    engine.now = engine.mode.phaseEndsAt;
    engine.step(0);
    assert.equal(engine.mode.phase, 'prep', 'fixed clock step reaches the next buy phase');
    engine.step(0);

    assert.equal(purchases.length, 4, 'each bot makes one second-round purchase');
    for (const record of purchases) {
      const price = WEAPON_PRICES[record.weapon];
      const expected = BUY_PRIORITY.find((weapon) => record.before.credits >= WEAPON_PRICES[weapon]);
      assert.equal(record.weapon, expected, `${record.id} buys its strongest affordable priority weapon`);
      assert.ok(Number.isFinite(price) && record.before.credits >= price,
        `${record.id} never attempts an invalid or unaffordable purchase`);
      assert.equal(record.result, true, `${record.id} purchase succeeds`);
      assert.ok(record.after.owned.includes(record.weapon), `${record.id} owns its purchase`);
      assert.equal(record.after.credits, record.before.credits - price, `${record.id} is charged the exact price`);
    }

    for (const player of engine.entities.values()) {
      const snapshot = engine.mode.playerSnapshot(player);
      assert.ok(snapshot.owned.includes(WEAPON_IDS[player.weapon]), `${player.id} selects only an owned weapon`);
    }
    for (const decision of calls) {
      if (decision.input.switchTo === undefined) continue;
      assert.ok(decision.owned.includes(WEAPON_IDS[decision.input.switchTo]),
        `${decision.id} never requests an unowned weapon slot`);
    }
    assert.ok(calls.filter((call) => call.phase === 'prep').every((call) => !call.input.wantFire),
      'all exercised S&D prep ticks remain fire-free');
  } finally {
    disposeAndProveUnhooked(engine, manager, calls);
  }
}

function createSndBots() {
  const engine = createEngine('snd');
  const calls = captureInputs(engine);
  const manager = attachBots(engine, 4);
  return { engine, calls, manager };
}

function provePlantAndDefuseBehavior() {
  const { engine, calls, manager } = createSndBots();
  try {
    engine.step(0);
    transitionToLive(engine, calls);
    const bomb = engine.mode.matchSnapshot().bomb;
    const carrier = engine.entities.get(bomb.carrier);
    const attackers = [...engine.entities.values()].filter((player) =>
      engine.mode.teamFor(player) === engine.mode.attackers);
    const escort = attackers.find((player) => player !== carrier);
    const defenders = [...engine.entities.values()].filter((player) =>
      engine.mode.teamFor(player) === engine.mode.defenders);
    const site = { x: 41, y: FEET_Y, z: 31 };

    setPosition(carrier, 30.5, 31);
    setPosition(escort, 20.5, 31);
    setPosition(defenders[0], 112.5, 20.5);
    setPosition(defenders[1], 112.5, 82.5);

    const carrierGoal = engine.mode.botGoal(carrier);
    const escortGoal = engine.mode.botGoal(escort);
    assert.equal(carrierGoal.kind, 'plant', 'bomb carrier receives the plant goal');
    assertPoint(carrierGoal.target, site, 'plant');
    assert.equal(escortGoal.kind, 'escortCarrier', 'attacking teammate receives the escort goal');
    assertPoint(escortGoal.target, { x: carrier.x, y: carrier.y, z: carrier.z }, 'escort');

    engine.step(TICK_MS);
    const carrierRoute = latestCall(calls, carrier.id).input;
    const escortRoute = latestCall(calls, escort.id).input;
    assert.equal(carrierRoute.keys.f, true, 'carrier routes toward the plant site');
    assert.equal(carrierRoute.keys.interact, false, 'carrier does not plant before reaching the site');
    assert.equal(escortRoute.keys.f, true, 'teammate routes toward the carrier');
    assert.equal(escortRoute.keys.interact, false, 'escort does not steal the plant interaction');

    setPosition(carrier, site.x, site.z, site.y);
    engine.step(TICK_MS);
    const plantHold = latestCall(calls, carrier.id).input;
    assert.equal(plantHold.keys.f, false, 'carrier stops inside the plant site');
    assert.equal(plantHold.keys.interact, true, 'carrier holds interact to plant');
    const plantInteraction = engine.mode.playerSnapshot(carrier).interaction;
    assert.equal(plantInteraction?.kind, 'plant', 'authoritative plant interaction starts');

    engine.now += MODE_RULES.snd.plantMs;
    engine.step(0);
    const planted = engine.mode.matchSnapshot().bomb;
    assert.equal(planted.state, 'planted', 'fixed held-interact steps plant the bomb');

    const bombGuard = engine.mode.botGoal(escort);
    assert.equal(bombGuard.kind, 'defendBomb', 'attacker switches to the planted-bomb defense goal');
    assertPoint(bombGuard.target, { x: planted.x, y: planted.y, z: planted.z }, 'planted-bomb defense');

    const defuser = defenders[0];
    setPosition(defuser, planted.x + 10, planted.z, planted.y);
    const defuseGoal = engine.mode.botGoal(defuser);
    assert.equal(defuseGoal.kind, 'defuse', 'planted bomb gives a defender the defuse goal');
    assertPoint(defuseGoal.target, { x: planted.x, y: planted.y, z: planted.z }, 'defuse');
    engine.step(TICK_MS);
    const defuseRoute = latestCall(calls, defuser.id).input;
    assert.equal(defuseRoute.keys.f, true, 'defender routes toward the planted bomb');
    assert.equal(defuseRoute.keys.interact, false, 'defender does not interact outside defuse range');

    setPosition(defuser, planted.x, planted.z, planted.y);
    engine.step(TICK_MS);
    const defuseHold = latestCall(calls, defuser.id).input;
    assert.equal(defuseHold.keys.f, false, 'defender stops at the planted bomb');
    assert.equal(defuseHold.keys.interact, true, 'defender holds interact to defuse');
    assert.equal(engine.mode.playerSnapshot(defuser).interaction?.kind, 'defuse',
      'authoritative defuse interaction starts');

    engine.now += MODE_RULES.snd.defuseMs;
    engine.step(0);
    assert.equal(engine.mode.matchSnapshot().bomb.state, 'defused',
      'fixed held-interact steps complete the defuse');
    assert.equal(engine.mode.phase, 'post', 'completed defuse ends the round');

  } finally {
    disposeAndProveUnhooked(engine, manager, calls);
  }
}

function proveDroppedBombRecoveryAndGuard() {
  const { engine, calls, manager } = createSndBots();
  try {
    engine.step(0);
    transitionToLive(engine, calls);
    const carrierId = engine.mode.matchSnapshot().bomb.carrier;
    const carrier = engine.entities.get(carrierId);
    const attackers = [...engine.entities.values()].filter((player) =>
      engine.mode.teamFor(player) === engine.mode.attackers);
    const recoverer = attackers.find((player) => player !== carrier);
    const guards = [...engine.entities.values()].filter((player) =>
      engine.mode.teamFor(player) === engine.mode.defenders);

    setPosition(carrier, 50.5, 20.5);
    setPosition(recoverer, 10.5, 20.5);
    setPosition(guards[0], 115.5, 20.5);
    setPosition(guards[1], 115.5, 82.5);
    engine.killPlayer(carrier, guards[0], 'smoke', false);
    const dropped = engine.mode.matchSnapshot().bomb;
    assert.equal(dropped.state, 'dropped', 'carrier death drops the bomb through GameEngine');

    const recoveryGoal = engine.mode.botGoal(recoverer);
    const guardGoal = engine.mode.botGoal(guards[0]);
    assert.equal(recoveryGoal.kind, 'recoverBomb', 'remaining attacker receives the recovery goal');
    assert.equal(guardGoal.kind, 'guardBomb', 'defender receives the dropped-bomb guard goal');
    assertPoint(recoveryGoal.target, { x: dropped.x, y: dropped.y, z: dropped.z }, 'recovery');
    assertPoint(guardGoal.target, { x: dropped.x, y: dropped.y, z: dropped.z }, 'guard');

    engine.step(TICK_MS);
    const recovery = latestCall(calls, recoverer.id).input;
    const guard = latestCall(calls, guards[0].id).input;
    assert.equal(recovery.keys.f, true, 'attacker routes toward the dropped bomb');
    assert.equal(recovery.keys.interact, false, 'bomb recovery uses pickup proximity, not interact');
    assert.equal(guard.keys.f, true, 'defender routes to guard the dropped bomb');
    assert.equal(guard.keys.interact, false, 'guard never submits an objective interaction');

    setPosition(recoverer, dropped.x, dropped.z, dropped.y);
    engine.step(TICK_MS);
    const recovered = engine.mode.matchSnapshot().bomb;
    assert.equal(recovered.state, 'carried', 'pickup proximity recovers the dropped bomb');
    assert.equal(recovered.carrier, recoverer.id, 'the recovering attacker becomes bomb carrier');

  } finally {
    disposeAndProveUnhooked(engine, manager, calls);
  }
}

console.log('bot mode smoke: deterministic direct behavior');
proveTdmTargeting();
proveAuthoritativeRowsAndProtection();
proveGunGameProgression();
proveSndEconomyAndPrepSafety();
provePlantAndDefuseBehavior();
proveDroppedBombRecoveryAndGuard();
console.log('bot mode smoke: ok');
