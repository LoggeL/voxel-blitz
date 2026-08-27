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

const CLOCK_START = 1_000_000;
const FEET_Y = GROUND + 1.02;
const BUY_PRIORITY = ['sniper', 'lmg', 'rifle', 'shotgun', 'smg'];

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

function createEngine(mode) {
  const world = makeWorld();
  const realNow = Date.now;
  Date.now = () => CLOCK_START;
  try {
    const engine = new GameEngine({ mode, world, mapMeta: MAP_META });
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
proveSndEconomyAndPrepSafety();
provePlantAndDefuseBehavior();
proveDroppedBombRecoveryAndGuard();
console.log('bot mode smoke: ok');
