// Protocol smoke test: starts the real HTTP+WebSocket server on an OS-assigned
// port, joins two real clients, and checks both direct simulation contracts and
// the actual wire stream.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import WebSocket from 'ws';

import { WEAPONS, WEAPON_IDS, CONDITION_RULES, computeSpreadConeDeg } from '../shared/combatmath.js';
import { valueNoise2 } from '../shared/noise.js';
import { raycastVoxels } from '../shared/raycast.js';
import { serializeWorld } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS, evDie, evRespawn, makeSnapshot } from '../server/protocol.js';

const fails = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (cond, name) => {
  if (cond) console.log('  ok -', name);
  else { console.log('  FAIL -', name); fails.push(name); }
};
const vectorNorm = (v) => Array.isArray(v) ? Math.hypot(...v) : 0;
const nearly = (actual, expected, tolerance = 1e-12) =>
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;

function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = { child, stopping: false, stdout: '', stderr: '' };

  server.exit = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error, code: null, signal: null }));
    child.once('exit', (code, signal) => resolve({ error: null, code, signal }));
  });

  server.port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not advertise its listening port')), 8000);
    server.exit.then(() => {
      clearTimeout(timer);
      reject(new Error('server exited before advertising its listening port'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      server.stdout = (server.stdout + chunk).slice(-8000);
      const match = server.stdout.match(/voxel-blitz listening on (?:https?:\/\/[^:\s]+)?:(\d+)\b/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { server.stderr = (server.stderr + chunk).slice(-8000); });
  server.failed = server.exit.then(({ error, code, signal }) => {
    if (server.stopping) return new Promise(() => {});
    const reason = error ? error.message : `code=${code} signal=${signal || 'none'}`;
    const detail = server.stderr.trim() || server.stdout.trim();
    throw new Error(`server exited before smoke completed (${reason})${detail ? `\n${detail}` : ''}`);
  });
  return server;
}

async function stopServer(server) {
  server.stopping = true;
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGINT');
  const graceful = await Promise.race([
    server.exit.then(() => true),
    delay(2000).then(() => false),
  ]);
  if (!graceful && server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
  }
  await server.exit;
}

async function waitForHttp(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/index.html`, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error('server did not serve HTTP after advertising readiness');
}

async function fetchBytes(port, target) {
  const response = await fetch(`http://127.0.0.1:${port}${target}`, {
    signal: AbortSignal.timeout(2000),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function fetchRawBytes(port, target) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: target,
      signal: AbortSignal.timeout(2000),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode || 0,
        contentType: String(response.headers['content-type'] || ''),
        body: Buffer.concat(chunks),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

class Client {
  constructor(port, name) {
    this.port = port;
    this.name = name;
    this.events = [];
    this.ticks = [];
    this.ws = null;
    this.mapBytes = 0;
  }

  async join() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.on('error', () => {});
    let welcome = null;
    let map = null;
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (map === null) map = new Uint8Array(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.t === 'welcome') { welcome = msg; this.id = msg.id; }
      else if (msg.t === 'ev') this.events.push(msg);
      else if (msg.t === 'tick') {
        this.ticks.push(msg);
        for (const ev of msg.events || []) this.events.push(ev);
      }
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ t: 'join', name: this.name }));
    const deadline = Date.now() + 8000;
    while (!(welcome && map)) {
      if (ws.readyState === WebSocket.CLOSED) throw new Error(`${this.name} socket closed during handshake`);
      if (Date.now() >= deadline) throw new Error(`${this.name} handshake timeout`);
      await delay(20);
    }
    this.welcome = welcome;
    this.mapBytes = map.byteLength;
    return welcome;
  }

  send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error(`${this.name} socket is not open`);
    this.ws.send(JSON.stringify(obj));
  }

  input(seq, overrides = {}) {
    this.send({
      t: 'input', seq,
      keys: {
        f: !!overrides.forward,
        b: !!overrides.back,
        l: !!overrides.left,
        r: !!overrides.right,
        jump: !!overrides.jump,
        sprint: !!overrides.sprint,
        crouch: !!overrides.crouch,
      },
      yaw: overrides.yaw ?? 0,
      pitch: overrides.pitch ?? 0,
      weapon: overrides.weapon ?? 0,
      wantFire: !!overrides.fire,
      wantAds: !!overrides.ads,
      reload: !!overrides.reload,
    });
  }

  async close() {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => ws.once('close', resolve));
    try { ws.close(1000, 'smoke complete'); } catch { try { ws.terminate(); } catch {} }
    if (!await Promise.race([closed.then(() => true), delay(500).then(() => false)])) {
      try { ws.terminate(); } catch {}
      await closed;
    }
  }
}

function runDirectContracts() {
  console.log('smoke: direct contracts…');

  const rangeSolid = (x, y, z) => x === 1 && y === 0 && z === 0;
  ok(raycastVoxels(rangeSolid, 0.5, 0.5, 0.5, 1, 0, 0, 0.49) === null
    && raycastVoxels(rangeSolid, 0.5, 0.5, 0.5, 1, 0, 0, 0.5)?.x === 1,
  'voxel DDA rejects hits beyond max distance but accepts the boundary');
  ok(raycastVoxels(rangeSolid, 0.5, 0.5, 0.5, 0, 0, 0, 10) === null
    && raycastVoxels(rangeSolid, 0.5, 0.5, 0.5, NaN, 0, 1, 10) === null,
  'voxel DDA rejects zero and nonfinite directions');

  const eps = 1e-6;
  let continuous = true;
  for (const x of [-0.4, 0.125, 0.5, 1.25]) {
    for (const z of [-1, 0, 1, 2]) {
      const below = valueNoise2(x, z - eps, 9137);
      const edge = valueNoise2(x, z, 9137);
      const above = valueNoise2(x, z + eps, 9137);
      if (Math.abs(below - edge) > 1e-8 || Math.abs(above - edge) > 1e-8) continuous = false;
    }
  }
  ok(continuous, 'value noise is continuous across lattice rows');

  const hitEngine = new GameEngine();
  hitEngine.addBot('shooter', 'Shooter');
  hitEngine.addBot('dead', 'Dead');
  hitEngine.addBot('target', 'Target');
  const shooter = hitEngine.entities.get('shooter');
  const dead = hitEngine.entities.get('dead');
  const target = hitEngine.entities.get('target');
  Object.assign(shooter, { x: 60, y: 30, z: 60 });
  Object.assign(dead, { x: 60, y: 30, z: 58, state: 'dead' });
  Object.assign(target, { x: 60, y: 30, z: 55, state: 'alive' });
  const targetHit = hitEngine.nearestVictim(shooter, [60, 31.62, 60], { x: 0, y: 0, z: -1 }, 20);
  ok(targetHit?.victim === target && targetHit.t > 4,
    'player ray excludes shooter and dead bodies, then hits the live target');

  const stateEvents = makeSnapshot([], [], [evDie('p'), evRespawn('p', 1, 2, 3)], 0).events;
  ok(stateEvents[0]?.kind === 'die' && stateEvents[1]?.kind === 'respawn',
    'embedded die and respawn events are dispatchable by kind');

  const expectedWeaponIds = ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'revolver'];
  const expectedWeights = [3.4, 2.3, 3.6, 5.2, 8.4, 1.4];
  ok(JSON.stringify(WEAPON_IDS) === JSON.stringify(expectedWeaponIds),
    'weapon roster exposes the exact six-slot order');
  const definitionsComplete = WEAPON_IDS.every((id, slot) => {
    const def = WEAPONS[id];
    return def?.id === id && typeof def.name === 'string' && def.name.length > 0
      && ['auto', 'semi', 'pump', 'bolt'].includes(def.mode)
      && Number.isFinite(def.rpm) && def.rpm > 0
      && Number.isInteger(def.magSize) && def.magSize > 0
      && Number.isInteger(def.reserveMax) && def.reserveMax >= def.magSize
      && Array.isArray(def.damage) && def.damage.length === 3 && def.damage.every(Number.isFinite)
      && Number.isFinite(def.headMult) && Number.isInteger(def.pellets)
      && Number.isFinite(def.spreadDeg?.hip) && Number.isFinite(def.spreadDeg?.ads)
      && ['bloomDeg', 'bloomMaxDeg', 'bloomRecover', 'moveSpreadDeg',
        'adsFov', 'zoom', 'adsTime', 'reloadTime', 'tacTime', 'deployTime']
        .every((key) => Number.isFinite(def[key]))
      && Number.isFinite(def.kickDeg?.pitch) && Number.isFinite(def.kickDeg?.yaw)
      && typeof def.tracer?.color === 'string' && Number.isFinite(def.tracer?.width)
      && Number.isFinite(def.tracer?.len) && typeof def.sfx === 'string'
      && def.weightKg === expectedWeights[slot];
  });
  ok(definitionsComplete, 'all six weapon definitions carry the complete shared contract');
  const lmg = WEAPONS.lmg;
  const revolver = WEAPONS.revolver;
  ok(lmg?.name === 'BASTION LMG' && lmg.mode === 'auto' && lmg.rpm === 720
    && lmg.magSize === 60 && lmg.reserveMax === 240 && lmg.sfx === 'lmg',
  'BASTION LMG has the contracted heavy automatic loadout');
  ok(revolver?.name === 'IRONCLAD .44' && revolver.mode === 'semi' && revolver.rpm === 300
    && revolver.magSize === 6 && revolver.reserveMax === 48 && revolver.sfx === 'revolver',
  'IRONCLAD .44 has the contracted precision sidearm loadout');

  const spreadDef = WEAPONS.rifle;
  const bloom = 0.7, speed = 3.1, adsT = 0.62, panic = 0.4, exhaustion = 0.65;
  const spreadBase = computeSpreadConeDeg(spreadDef, bloom, speed, adsT);
  const spreadConditioned = computeSpreadConeDeg(
    spreadDef, bloom, speed, adsT, panic, exhaustion
  );
  const conditionPenalty = (panic * 0.85 + exhaustion * 1.15) * (1 - adsT * 0.45);
  ok(Math.abs(spreadConditioned - spreadBase - conditionPenalty) < 1e-12,
    'panic and exhaustion add the exact shared ADS-scaled cone penalty');
  ok(computeSpreadConeDeg(spreadDef, bloom, speed, adsT, 0, 0) === spreadBase,
    'omitted hidden conditions preserve the original spread result');
  ok(JSON.stringify(CONDITION_RULES) === JSON.stringify({
    panicDamageGain: 0.012,
    panicHeadshotGain: 0.22,
    panicDecayPerS: 0.2,
    panicLowHpFloor: 0.45,
    exhaustionSprintPerS: 0.24,
    exhaustionRecoverPerS: 0.18,
    exhaustionJumpGain: 0.14,
    exhaustionShotGain: 0.025,
  }), 'authority and prediction share the exact hidden-condition rates');

  const tapSnapshots = [];
  const tapEngine = new GameEngine({ broadcast: (msg) => tapSnapshots.push(msg) });
  tapEngine.addBot('tap', 'Tap');
  const tapper = tapEngine.entities.get('tap');
  tapper.deployT = 0;
  const tapInput = {
    t: 'input',
    keys: { f: false, b: false, l: false, r: false, jump: false, sprint: false, crouch: false },
    yaw: 0, pitch: 1.2, weapon: 0, wantAds: false, reload: false,
  };
  tapEngine.applyInput('tap', { ...tapInput, seq: 1, wantFire: true });
  tapEngine.applyInput('tap', { ...tapInput, seq: 2, wantFire: false });
  tapEngine.step(TICK_MS);
  const tapShot = tapSnapshots[0]?.events.find((event) => event.kind === 'shoot' && event.id === 'tap');
  ok(tapShot && tapper.hp === 100,
    'a complete fire tap between ticks is accepted once without self-damage');

  const snapshots = [];
  const fireEngine = new GameEngine({ broadcast: (msg) => snapshots.push(msg) });
  fireEngine.addBot('cadence', 'Cadence');
  const firing = fireEngine.entities.get('cadence');
  const lmgSlot = WEAPON_IDS.indexOf('lmg');
  firing.weapon = lmgSlot;
  firing.deployT = 0;
  fireEngine.applyInput('cadence', {
    ...tapInput, seq: 1, pitch: 1.2, weapon: lmgSlot, wantFire: true,
  });
  for (let i = 0; i < 41; i++) fireEngine.step(TICK_MS);
  const lmgShots = [];
  let firstShoot = null;
  for (const tick of snapshots) {
    const ev = tick.events.find((candidate) => candidate.kind === 'shoot' && candidate.id === 'cadence');
    if (ev) { lmgShots.push(tick.now); firstShoot ||= ev; }
  }
  ok(firstShoot && firstShoot.w === 'lmg'
    && vectorNorm(firstShoot.d) > 0.9 && vectorNorm(firstShoot.spread) > 0.9,
  'accepted LMG shoot events carry their id plus nonzero aim and spread vectors');
  const actualSpan = lmgShots.at(-1) - lmgShots[0];
  const configuredSpan = (lmgShots.length - 1) * 60000 / lmg.rpm;
  ok(lmgShots.length > 15 && Math.abs(actualSpan - configuredSpan) <= TICK_MS,
    `held LMG fire follows configured ${lmg.rpm} rpm within one tick`);

  const firedRounds = lmg.magSize - firing.mag[lmgSlot];
  fireEngine.applyInput('cadence', {
    ...tapInput, seq: 2, weapon: lmgSlot, wantFire: false, reload: true,
  });
  for (let i = 0; i < Math.ceil(lmg.reloadTime * 1000 / TICK_MS) + 2; i++) {
    fireEngine.step(TICK_MS);
  }
  const reloadedRow = snapshots.at(-1)?.players.find((row) => row.id === 'cadence');
  ok(reloadedRow?.mag[lmgSlot] === lmg.magSize
    && reloadedRow.reserve[lmgSlot] === lmg.reserveMax - firedRounds,
  'LMG reload is authoritative in the six-slot snapshot loadout');

  const revolverSlot = WEAPON_IDS.indexOf('revolver');
  const releasedRevolverAt = (gateMs) => {
    const gateSnapshots = [];
    const engine = new GameEngine({ broadcast: (msg) => gateSnapshots.push(msg) });
    engine.addBot('semi', 'Semi');
    const player = engine.entities.get('semi');
    player.weapon = revolverSlot;
    player.deployT = 0;
    engine.applyInput('semi', {
      ...tapInput, seq: 1, pitch: 1.2, weapon: revolverSlot, wantFire: true,
    });
    engine.step(0);
    engine.applyInput('semi', {
      ...tapInput, seq: 2, pitch: 1.2, weapon: revolverSlot, wantFire: false,
    });
    engine.step(gateMs);
    engine.applyInput('semi', {
      ...tapInput, seq: 3, pitch: 1.2, weapon: revolverSlot, wantFire: true,
    });
    engine.applyInput('semi', {
      ...tapInput, seq: 4, pitch: 1.2, weapon: revolverSlot, wantFire: false,
    });
    engine.step(0);
    return gateSnapshots
      .filter((tick) => tick.events.some((event) => event.kind === 'shoot' && event.id === 'semi'))
      .map((tick) => ({
        now: tick.now,
        event: tick.events.find((event) => event.kind === 'shoot' && event.id === 'semi'),
      }));
  };
  const beforeRevolverGate = releasedRevolverAt(199);
  const atRevolverGate = releasedRevolverAt(200);
  ok(beforeRevolverGate.length === 1
    && atRevolverGate.length === 2
    && atRevolverGate[1].now - atRevolverGate[0].now === 200
    && atRevolverGate.every(({ event }) => event.w === 'revolver'),
  'released revolver presses are rejected at 199ms and accepted at the exact 200ms gate');

  const slotEngine = new GameEngine();
  slotEngine.addBot('slots', 'Slots');
  const slotter = slotEngine.entities.get('slots');
  slotter.deployT = 0;
  slotEngine.applyInput('slots', { ...tapInput, seq: 1, weapon: 999 });
  slotEngine.step(TICK_MS);
  const highSlot = slotter.weapon;
  slotter.deployT = 0;
  slotEngine.applyInput('slots', { ...tapInput, seq: 2, weapon: -999 });
  slotEngine.step(TICK_MS);
  ok(highSlot === WEAPON_IDS.length - 1 && slotter.weapon === 0,
    'authoritative slot selection clamps dynamically across all six weapons');

  const botEngine = new GameEngine();
  const botManager = attachBots(botEngine, WEAPON_IDS.length);
  for (let i = 0; i < 20; i++) botEngine.step(TICK_MS);
  const botSlots = [...botEngine.entities.values()].map((player) => player.weapon).sort((a, b) => a - b);
  ok(JSON.stringify(botSlots) === JSON.stringify(WEAPON_IDS.map((_, i) => i)),
    'authoritative bots deploy across the full weapon roster');
  botManager.dispose();

  const conditionSnapshots = [];
  const conditionEngine = new GameEngine({
    broadcast: (msg) => conditionSnapshots.push(msg),
  });
  conditionEngine.addBot('condition-shooter', 'Condition Shooter');
  conditionEngine.addBot('condition-target', 'Condition Target');
  const conditionShooter = conditionEngine.entities.get('condition-shooter');
  const conditionTarget = conditionEngine.entities.get('condition-target');

  Object.assign(conditionTarget, { hp: 100, panic: 0.1, state: 'alive' });
  const bodyLethal = conditionTarget.takeDamage(10, false);
  const bodyPanic = conditionTarget.panic;
  Object.assign(conditionTarget, { hp: 100, panic: 0.1, state: 'alive' });
  const headLethal = conditionTarget.takeDamage(10, true);
  ok(!bodyLethal && !headLethal
    && conditionTarget.hp === 90
    && nearly(bodyPanic, 0.1 + 10 * CONDITION_RULES.panicDamageGain)
    && nearly(conditionTarget.panic, 0.1 + 10 * CONDITION_RULES.panicDamageGain
      + CONDITION_RULES.panicHeadshotGain),
  'body damage and headshots apply their exact deterministic panic gains');

  Object.assign(conditionTarget, {
    hp: 100, panic: 0.8, exhaustion: 0, sprint: false, state: 'alive',
  });
  conditionEngine.updateCondition(conditionTarget, 0.5);
  const decayedPanic = conditionTarget.panic;
  Object.assign(conditionTarget, { hp: 25, panic: 0.1, exhaustion: 0, sprint: false });
  conditionEngine.updateCondition(conditionTarget, 0.5);
  ok(nearly(decayedPanic, 0.8 - CONDITION_RULES.panicDecayPerS * 0.5)
    && nearly(conditionTarget.panic, 0.75 * CONDITION_RULES.panicLowHpFloor),
  'panic decays at the exact rate without crossing its low-health floor');

  Object.assign(conditionTarget, {
    hp: 100, panic: 0.99, exhaustion: 0.99, sprint: true, state: 'alive',
  });
  conditionTarget.takeDamage(10, true);
  const upperPanic = conditionTarget.panic;
  conditionEngine.updateCondition(conditionTarget, 1);
  const upperExhaustion = conditionTarget.exhaustion;
  Object.assign(conditionTarget, {
    hp: 100, panic: 0.01, exhaustion: 0.01, sprint: false, state: 'alive',
  });
  conditionEngine.updateCondition(conditionTarget, 1);
  ok(upperPanic === 1 && upperExhaustion === 1
    && conditionTarget.panic === 0 && conditionTarget.exhaustion === 0,
  'panic and exhaustion clamp exactly to their normalized upper and lower bounds');

  Object.assign(conditionShooter, {
    weapon: 0, bloom: 0.7, vx: 3.1, vz: 0, adsT: 0.62,
    panic: 0.4, exhaustion: 0.65,
  });
  const engineCone = conditionEngine.computeConeDeg(conditionShooter);
  const expectedEngineCone = computeSpreadConeDeg(
    conditionShooter.def,
    conditionShooter.bloom,
    Math.hypot(conditionShooter.vx, conditionShooter.vz),
    conditionShooter.adsT,
    conditionShooter.panic,
    conditionShooter.exhaustion,
  );
  ok(nearly(engineCone, expectedEngineCone),
    'GameEngine.computeConeDeg forwards panic and exhaustion into shared spread math');

  Object.assign(conditionShooter, {
    x: 60, y: 70, z: 60, yaw: 0, pitch: 0.04, weapon: 0,
    deployT: 0, adsT: 1, bloom: 0, vx: 0, vz: 0, panic: 0, exhaustion: 0,
  });
  Object.assign(conditionTarget, {
    x: 60, y: 70, z: 55, hp: 100, panic: 0, exhaustion: 0,
    state: 'alive', hist: [],
  });
  let conditionSpreadExhaustion = null;
  const computeConditionCone = conditionEngine.computeConeDeg.bind(conditionEngine);
  conditionEngine.computeConeDeg = (player) => {
    if (player === conditionShooter) conditionSpreadExhaustion = player.exhaustion;
    return computeConditionCone(player);
  };
  conditionEngine.applyInput('condition-shooter', {
    ...tapInput, seq: 1, yaw: 0, pitch: 0.04, weapon: 0, wantFire: true,
  });
  conditionEngine.applyInput('condition-shooter', {
    ...tapInput, seq: 2, yaw: 0, pitch: 0.04, weapon: 0, wantFire: false,
  });
  conditionEngine.step(0);
  const conditionHit = conditionSnapshots.at(-1)?.events.find(
    (event) => event.kind === 'hit' && event.victim === 'condition-target'
  );
  const authoritativeHeadDamage = 100 - conditionTarget.hp;
  ok(conditionHit?.hs === true
    && authoritativeHeadDamage > 0
    && conditionHit.dmg === Math.round(authoritativeHeadDamage)
    && nearly(conditionTarget.panic,
      authoritativeHeadDamage * CONDITION_RULES.panicDamageGain
        + CONDITION_RULES.panicHeadshotGain)
    && conditionSpreadExhaustion === 0
    && nearly(conditionShooter.exhaustion, CONDITION_RULES.exhaustionShotGain),
  'authoritative headshots apply exact damage panic, headshot panic, and accepted-shot gain');

  const evolutionEngine = new GameEngine();
  evolutionEngine.addBot('condition-evolution', 'Condition Evolution');
  const evolving = evolutionEngine.entities.get('condition-evolution');
  evolving.exhaustion = 0.5;
  evolutionEngine.applyInput('condition-evolution', {
    ...tapInput, seq: 1, weapon: 0, wantFire: false,
  });
  evolutionEngine.step(TICK_MS);
  const recoveredExhaustion = evolving.exhaustion;

  evolving.exhaustion = 0.5;
  evolutionEngine.applyInput('condition-evolution', {
    ...tapInput,
    seq: 2,
    weapon: 0,
    wantFire: false,
    keys: { ...tapInput.keys, f: true, sprint: true },
  });
  evolutionEngine.step(TICK_MS);
  const sprintExhaustion = evolving.exhaustion;

  evolving.exhaustion = 0.9;
  evolving.grounded = true;
  evolving.vy = 0;
  evolutionEngine.applyInput('condition-evolution', {
    ...tapInput,
    seq: 3,
    weapon: 0,
    wantFire: false,
    keys: { ...tapInput.keys, jump: true },
  });
  evolutionEngine.step(TICK_MS);
  const jumpExhaustion = evolving.exhaustion;
  ok(nearly(recoveredExhaustion,
    0.5 - CONDITION_RULES.exhaustionRecoverPerS * TICK_MS / 1000)
    && nearly(sprintExhaustion,
      0.5 + CONDITION_RULES.exhaustionSprintPerS * TICK_MS / 1000)
    && nearly(jumpExhaustion,
      1 - CONDITION_RULES.exhaustionRecoverPerS * TICK_MS / 1000),
  'recovery, sprint, and clamped jump exhaustion evolve in fixed-step order at exact rates');

  const shotConeExhaustion = [];
  const computeEvolutionCone = evolutionEngine.computeConeDeg.bind(evolutionEngine);
  evolutionEngine.computeConeDeg = (player) => {
    shotConeExhaustion.push(player.exhaustion);
    return computeEvolutionCone(player);
  };
  Object.assign(evolving, {
    exhaustion: 0.99,
    deployT: 0,
    cooldown: 0,
    triggerPrev: false,
    fireEdgeQueued: false,
    weapon: 0,
  });
  evolutionEngine.applyInput('condition-evolution', {
    ...tapInput, seq: 4, weapon: 0, wantFire: true,
  });
  evolutionEngine.step(TICK_MS);
  const exhaustionAfterFirstShot = evolving.exhaustion;
  evolutionEngine.applyInput('condition-evolution', {
    ...tapInput, seq: 5, weapon: 0, wantFire: false,
  });
  evolutionEngine.applyInput('condition-evolution', {
    ...tapInput, seq: 6, weapon: 0, wantFire: true,
  });
  evolutionEngine.applyInput('condition-evolution', {
    ...tapInput, seq: 7, weapon: 0, wantFire: false,
  });
  evolutionEngine.step(100);
  ok(shotConeExhaustion.length === 2
    && nearly(shotConeExhaustion[0],
      0.99 - CONDITION_RULES.exhaustionRecoverPerS * TICK_MS / 1000)
    && exhaustionAfterFirstShot === 1
    && nearly(shotConeExhaustion[1], 1 - CONDITION_RULES.exhaustionRecoverPerS * 0.1)
    && evolving.exhaustion === 1,
  'accepted-shot exhaustion is gained after its cone and affects only subsequent shots');

  const respawnSnapshots = [];
  const respawnEngine = new GameEngine({ broadcast: (msg) => respawnSnapshots.push(msg) });
  respawnEngine.addBot('timed-respawn', 'Timed Respawn');
  const respawning = respawnEngine.entities.get('timed-respawn');
  respawning.weapon = revolverSlot;
  respawning.mag.fill(1);
  respawning.reserve.fill(2);
  respawning.panic = 0.8;
  respawning.exhaustion = 0.7;
  respawning.reloading = true;
  respawnEngine.killPlayer(respawning, null, 'rifle', false);
  const respawnDueAt = respawning.respawnAt;
  const ticksBeforeRespawn = Math.max(
    0,
    Math.ceil((respawnDueAt - respawnEngine.now) / TICK_MS) - 1,
  );
  for (let i = 0; i < ticksBeforeRespawn; i++) respawnEngine.step(TICK_MS);
  const noEarlyRespawn = respawning.state === 'dead'
    && respawnSnapshots.every((tick) =>
      !tick.events.some((event) => event.kind === 'respawn' && event.id === 'timed-respawn'));
  respawnEngine.step(TICK_MS);
  const respawnSnapshot = respawnSnapshots.at(-1);
  const respawnEvent = respawnSnapshot?.events.find(
    (event) => event.kind === 'respawn' && event.id === 'timed-respawn'
  );
  const respawnRow = respawnSnapshot?.players.find((row) => row.id === 'timed-respawn');
  const freshMags = WEAPON_IDS.map((id) => WEAPONS[id].magSize);
  const freshReserve = WEAPON_IDS.map((id) => WEAPONS[id].reserveMax);
  ok(noEarlyRespawn
    && respawnEvent
    && respawnSnapshot.now >= respawnDueAt
    && respawnSnapshot.now - respawnDueAt < TICK_MS
    && respawnRow?.state === 'alive'
    && respawnRow.weapon === WEAPON_IDS.indexOf('rifle')
    && JSON.stringify(respawnRow.mag) === JSON.stringify(freshMags)
    && JSON.stringify(respawnRow.reserve) === JSON.stringify(freshReserve)
    && respawnRow.panic === 0
    && respawnRow.exhaustion === 0,
  'timed respawn broadcasts its event and fresh rifle six-slot loadout at the due tick');
  ok(!!respawnEvent
    && !!respawnRow
    && respawnEvent.x === respawnRow.x
    && respawnEvent.y === respawnRow.y
    && respawnEvent.z === respawnRow.z
    && respawnRow.mag.length === WEAPON_IDS.length
    && respawnRow.reserve.length === WEAPON_IDS.length
    && typeof respawnRow.reloading === 'boolean',
  'respawn event and authoritative snapshot expose the same fresh-life state');

  const exact = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  const modeMapMeta = {
    id: 'foundry',
    spawns: {
      fun: [
        { x: 56, y: 70, z: 56, index: 0 },
        { x: 64, y: 70, z: 64, index: 1 },
      ],
      tdm: {
        alpha: [
          { x: 56, y: 70, z: 64, index: 0 },
          { x: 58, y: 70, z: 64, index: 1 },
        ],
        bravo: [
          { x: 72, y: 70, z: 64, index: 0 },
          { x: 74, y: 70, z: 64, index: 1 },
        ],
      },
      snd: {
        attackers: [
          { x: 48, y: 70, z: 60, index: 0 },
          { x: 48, y: 70, z: 62, index: 1 },
        ],
        defenders: [
          { x: 76, y: 70, z: 60, index: 0 },
          { x: 76, y: 70, z: 62, index: 1 },
        ],
      },
    },
    sites: [
      { id: 'A', minX: 50, maxX: 52, minZ: 50, maxZ: 52, y: 70 },
      { id: 'B', minX: 70, maxX: 72, minZ: 70, maxZ: 72, y: 70 },
    ],
  };
  const createModeEngine = (mode) => {
    const ticks = [];
    const engine = new GameEngine({
      mode,
      mapMeta: modeMapMeta,
      broadcast: (tick) => ticks.push(tick),
    });
    return { engine, ticks };
  };
  const stepModeAt = (subject, at) => {
    subject.engine.now = at;
    subject.engine.step(0);
    return subject.ticks.at(-1);
  };
  const playerRow = (tick, id) => tick?.players.find((row) => row.id === id);
  const applyInteract = (engine, id, seq, held) => {
    engine.applyInput(id, {
      ...tapInput,
      seq,
      weapon: revolverSlot,
      wantFire: false,
      keys: { ...tapInput.keys, interact: held },
    });
  };

  const fun = createModeEngine('fun');
  fun.engine.addBot('fun-player', 'Fun Player');
  const funPlayer = fun.engine.entities.get('fun-player');
  const funStart = fun.engine.now;
  const funStartTick = stepModeAt(fun, funStart);
  const funStartRow = playerRow(funStartTick, 'fun-player');
  ok(exact(funStartTick.match, {
    mode: 'fun',
    map: 'foundry',
    phase: 'live',
    phaseEndsAt: null,
    scores: null,
    winner: null,
    round: null,
    roundWinner: null,
    attackers: null,
    defenders: null,
    bomb: null,
  })
    && funStartRow?.team === null
    && funStartRow.credits === 0
    && exact(funStartRow.owned, WEAPON_IDS)
    && funStartRow.bomb === false
    && funStartRow.interaction === null
    && exact(funStartRow.mag, freshMags)
    && exact(funStartRow.reserve, freshReserve),
  'Fun snapshot exposes the full six-weapon loadout and exact unteamed match fields');

  fun.engine.killPlayer(funPlayer, null, 'world', false);
  const funDeathAt = fun.engine.now;
  const funDueAt = funPlayer.respawnAt;
  const funEarlyTick = stepModeAt(fun, funDeathAt + 1499);
  const funDueTick = stepModeAt(fun, funDeathAt + 1500);
  const funDueRow = playerRow(funDueTick, 'fun-player');
  ok(funDueAt - funDeathAt === 1500
    && playerRow(funEarlyTick, 'fun-player')?.state === 'dead'
    && !funEarlyTick.events.some((event) => event.kind === 'respawn')
    && funDueRow?.state === 'alive'
    && funDueTick.events.filter(
      (event) => event.kind === 'respawn' && event.id === 'fun-player'
    ).length === 1
    && exact(funDueRow.owned, WEAPON_IDS)
    && exact(funDueRow.mag, freshMags)
    && exact(funDueRow.reserve, freshReserve),
  'Fun respawns once at exactly 1500ms with a fresh full loadout');

  const tdm = createModeEngine('tdm');
  for (const [id, name] of [
    ['tdm-a1', 'TDM A1'],
    ['tdm-b1', 'TDM B1'],
    ['tdm-a2', 'TDM A2'],
    ['tdm-b2', 'TDM B2'],
  ]) tdm.engine.addBot(id, name);
  const tdmStart = tdm.engine.now;
  const tdmStartTick = stepModeAt(tdm, tdmStart);
  const tdmTeams = tdmStartTick.players.map(({ id, team }) => [id, team]);
  ok(exact(tdmTeams, [
    ['tdm-a1', 'alpha'],
    ['tdm-b1', 'bravo'],
    ['tdm-a2', 'alpha'],
    ['tdm-b2', 'bravo'],
  ])
    && exact(tdmStartTick.match, {
      mode: 'tdm',
      map: 'foundry',
      phase: 'live',
      phaseEndsAt: null,
      scores: { alpha: 0, bravo: 0 },
      winner: null,
      round: null,
      roundWinner: null,
      attackers: null,
      defenders: null,
      bomb: null,
    })
    && tdmStartTick.players.every((row) =>
      row.credits === 0
        && exact(row.owned, WEAPON_IDS)
        && row.bomb === false
        && row.interaction === null),
  'TDM balances alpha/bravo deterministically and publishes exact team match/player fields');

  const tdmShooter = tdm.engine.entities.get('tdm-a1');
  const tdmEnemy = tdm.engine.entities.get('tdm-b1');
  const tdmFriend = tdm.engine.entities.get('tdm-a2');
  const tdmOtherEnemy = tdm.engine.entities.get('tdm-b2');
  Object.assign(tdmShooter, { x: 60, y: 70, z: 60 });
  Object.assign(tdmFriend, { x: 60, y: 70, z: 58, hp: 100 });
  Object.assign(tdmEnemy, { x: 60, y: 70, z: 55, hp: 100 });
  Object.assign(tdmOtherEnemy, { x: 80, y: 70, z: 80, hp: 100 });
  const tdmTarget = tdm.engine.nearestVictim(
    tdmShooter,
    [60, 71.62, 60],
    { x: 0, y: 0, z: -1 },
    20,
  );
  ok(tdm.engine.mode.canDamage(tdmShooter, tdmFriend) === false
    && tdm.engine.mode.canDamage(tdmShooter, tdmEnemy) === true
    && tdmTarget?.victim === tdmEnemy
    && tdmFriend.hp === 100,
  'TDM friendly fire is immune while the same ray still targets an enemy behind a teammate');

  const tdmKillAt = tdm.engine.now;
  tdm.engine.killPlayer(tdmEnemy, tdmShooter, 'rifle', false);
  tdm.engine.killPlayer(tdmEnemy, tdmShooter, 'rifle', false);
  const tdmFirstScore = tdm.engine.mode.matchSnapshot();
  const tdmRespawnAt = tdmEnemy.respawnAt;
  const tdmEarlyRespawn = stepModeAt(tdm, tdmKillAt + 2999);
  const tdmExactRespawn = stepModeAt(tdm, tdmKillAt + 3000);
  ok(tdmFirstScore.scores.alpha === 1
    && tdmFirstScore.scores.bravo === 0
    && tdmShooter.score === 1
    && tdmShooter.kills === 1
    && tdmRespawnAt - tdmKillAt === 3000
    && playerRow(tdmEarlyRespawn, 'tdm-b1')?.state === 'dead'
    && !tdmEarlyRespawn.events.some((event) => event.kind === 'respawn')
    && playerRow(tdmExactRespawn, 'tdm-b1')?.state === 'alive'
    && tdmExactRespawn.events.filter(
      (event) => event.kind === 'respawn' && event.id === 'tdm-b1'
    ).length === 1,
  'one TDM enemy death awards exactly one team point and respawns once at exactly 3000ms');

  for (let score = 2; score <= 40; score++) {
    tdm.engine.killPlayer(tdmEnemy, tdmShooter, 'rifle', false);
    if (score < 40) tdm.engine.forceRespawn(tdmEnemy);
  }
  const tdmPostAt = tdm.engine.now;
  const tdmPostEndsAt = tdm.engine.mode.matchSnapshot().phaseEndsAt;
  const tdmPostTick = stepModeAt(tdm, tdmPostAt);
  const tdmBeforeReset = stepModeAt(tdm, tdmPostEndsAt - 1);
  const tdmResetTick = stepModeAt(tdm, tdmPostEndsAt);
  ok(tdmPostEndsAt - tdmPostAt === 5000
    && tdmPostTick.match.phase === 'post'
    && tdmPostTick.match.winner === 'alpha'
    && exact(tdmPostTick.match.scores, { alpha: 40, bravo: 0 })
    && tdmBeforeReset.match.phase === 'post'
    && exact(tdmBeforeReset.match.scores, { alpha: 40, bravo: 0 })
    && exact(tdmResetTick.match.scores, { alpha: 0, bravo: 0 })
    && tdmResetTick.match.phase === 'live'
    && tdmResetTick.match.phaseEndsAt === null
    && tdmResetTick.match.winner === null
    && tdmResetTick.players.every((row) =>
      row.state === 'alive' && row.score === 0 && row.kills === 0 && row.deaths === 0)
    && tdmResetTick.events.filter((event) => event.kind === 'respawn').length === 4
    && tdmResetTick.events.filter((event) => event.kind === 'match_start').length === 1,
  'TDM posts at score 40 for exactly 5000ms, then resets scores and every player once');

  const sndClock = createModeEngine('snd');
  sndClock.engine.addBot('snd-clock-a', 'SND Clock A');
  sndClock.engine.addBot('snd-clock-b', 'SND Clock B');
  const sndClockStart = sndClock.engine.now;
  const sndPrepTick = stepModeAt(sndClock, sndClockStart);
  const sndCarrierId = sndPrepTick.match.bomb?.carrier;
  const sndCarrier = sndClock.engine.entities.get(sndCarrierId);
  const sndDefenderId = sndCarrierId === 'snd-clock-a' ? 'snd-clock-b' : 'snd-clock-a';
  const sndCarrierRow = playerRow(sndPrepTick, sndCarrierId);
  const sndDefender = sndClock.engine.entities.get(sndDefenderId);
  const sndDefenderRow = playerRow(sndPrepTick, sndDefenderId);
  const revolverOnlyMag = WEAPON_IDS.map((id) => id === 'revolver' ? WEAPONS[id].magSize : 0);
  const revolverOnlyReserve = WEAPON_IDS.map(
    (id) => id === 'revolver' ? WEAPONS[id].reserveMax : 0
  );
  ok(sndPrepTick.match.mode === 'snd'
    && sndPrepTick.match.map === 'foundry'
    && sndPrepTick.match.phase === 'prep'
    && sndPrepTick.match.phaseEndsAt - sndPrepTick.now === 10000
    && exact(sndPrepTick.match.scores, { alpha: 0, bravo: 0 })
    && sndPrepTick.match.winner === null
    && sndPrepTick.match.round === 1
    && sndPrepTick.match.roundWinner === null
    && sndPrepTick.match.attackers === 'alpha'
    && sndPrepTick.match.defenders === 'bravo'
    && sndPrepTick.match.bomb?.state === 'carried'
    && sndCarrierRow?.team === 'alpha'
    && sndCarrierRow.credits === 800
    && exact(sndCarrierRow.owned, ['revolver'])
    && sndCarrierRow.weapon === revolverSlot
    && exact(sndCarrierRow.mag, revolverOnlyMag)
    && exact(sndCarrierRow.reserve, revolverOnlyReserve)
    && sndCarrierRow.bomb === true
    && sndCarrierRow.interaction === null
    && sndDefenderRow?.team === 'bravo'
    && sndDefenderRow.credits === 800
    && exact(sndDefenderRow.owned, ['revolver'])
    && sndDefenderRow.bomb === false,
  'S&D starts 10s prep with exact roles, scores, bomb, credits, and revolver-only player fields');

  sndCarrier.deployT = 0;
  const sndPrepMag = sndCarrier.mag[revolverSlot];
  sndClock.engine.applyInput(sndCarrierId, {
    ...tapInput,
    seq: 1,
    weapon: revolverSlot,
    wantFire: true,
  });
  const sndBlockedFireTick = stepModeAt(sndClock, sndClockStart);
  sndClock.engine.applyInput(sndCarrierId, {
    ...tapInput,
    seq: 2,
    weapon: revolverSlot,
    wantFire: false,
  });
  ok(sndCarrier.mag[revolverSlot] === sndPrepMag
    && !sndBlockedFireTick.events.some(
      (event) => event.kind === 'shoot' && event.id === sndCarrierId
    )
    && sndClock.engine.mode.canFire(sndCarrier) === false,
  'S&D prep blocks an otherwise-ready revolver shot without consuming ammunition');

  const sndPrepEndsAt = sndClock.engine.mode.matchSnapshot().phaseEndsAt;
  const sndBeforeLive = stepModeAt(sndClock, sndPrepEndsAt - 1);
  const sndBoundaryRespawned = sndClock.engine.respawnPlayer(
    sndDefender,
    sndClock.engine.mode.chooseSpawn(sndDefender, sndDefender.lastSpawnIndex),
  );
  const sndLiveTick = stepModeAt(sndClock, sndPrepEndsAt);
  const sndLivePhaseEvents = sndLiveTick.events.filter(
    (event) => event.kind === 'phase' && event.phase === 'live' && event.round === 1
  );
  const sndLivePhaseWasEarly = sndClock.ticks.some(
    (tick) => tick.now < sndPrepEndsAt
      && tick.events.some((event) => event.kind === 'phase' && event.phase === 'live')
  );
  const sndLiveFollowup = stepModeAt(sndClock, sndPrepEndsAt + 1);
  const sndLiveEndsAt = sndLiveTick.match.phaseEndsAt;
  const sndBeforeTimeout = stepModeAt(sndClock, sndLiveEndsAt - 1);
  const sndTimeoutTick = stepModeAt(sndClock, sndLiveEndsAt);
  ok(sndBeforeLive.match.phase === 'prep'
    && sndBeforeLive.now === sndPrepEndsAt - 1
    && !sndLivePhaseWasEarly
    && sndBoundaryRespawned === true
    && sndLiveTick.now === sndPrepEndsAt
    && sndLiveTick.match.phase === 'live'
    && sndLiveTick.match.round === 1
    && sndLiveEndsAt === sndPrepEndsAt + 90000
    && sndLivePhaseEvents.length === 1
    && sndLivePhaseEvents[0].at === sndLiveTick.now
    && sndLivePhaseEvents[0].mode === sndLiveTick.match.mode
    && sndLivePhaseEvents[0].endsAt === sndLiveEndsAt
    && exact(sndLiveTick.events.map((event) => event.kind), ['respawn', 'phase'])
    && sndLiveTick.events[0].id === sndDefenderId
    && sndLiveFollowup.now === sndPrepEndsAt + 1
    && sndLiveFollowup.match.phase === 'live'
    && sndLiveFollowup.match.round === 1
    && sndLiveFollowup.match.phaseEndsAt === sndLiveEndsAt
    && !sndLiveFollowup.events.some(
      (event) => event.kind === 'phase' && event.phase === 'live'
    )
    && sndBeforeTimeout.match.phase === 'live'
    && sndTimeoutTick.match.phase === 'post'
    && sndTimeoutTick.match.roundWinner === 'bravo'
    && exact(sndTimeoutTick.match.scores, { alpha: 0, bravo: 1 })
    && sndTimeoutTick.events.filter(
      (event) => event.kind === 'round_end'
        && event.winner === 'bravo'
        && event.reason === 'time'
    ).length === 1,
  'S&D emits one ordered live-phase event at exact prep expiry, never replays it, and times out at 90000ms');

  const sndEconomy = createModeEngine('snd');
  sndEconomy.engine.addBot('snd-buyer', 'SND Buyer');
  sndEconomy.engine.addBot('snd-loser', 'SND Loser');
  stepModeAt(sndEconomy, sndEconomy.engine.mode.matchSnapshot().phaseEndsAt);
  const sndBuyer = sndEconomy.engine.entities.get('snd-buyer');
  const sndLoser = sndEconomy.engine.entities.get('snd-loser');
  sndEconomy.engine.killPlayer(sndLoser, sndBuyer, 'revolver', false);
  const sndKillCredits = sndEconomy.engine.mode.playerSnapshot(sndBuyer).credits;
  const sndNoRespawnAt = sndLoser.respawnAt;
  const sndEconomyRoundTick = stepModeAt(sndEconomy, sndEconomy.engine.now);
  const sndEconomyPostEndsAt = sndEconomyRoundTick.match.phaseEndsAt;
  const sndEconomyBeforeRound = stepModeAt(sndEconomy, sndEconomyPostEndsAt - 1);
  const sndEconomyBuyTick = stepModeAt(sndEconomy, sndEconomyPostEndsAt);
  const creditsBeforeBuys = sndEconomy.engine.mode.playerSnapshot(sndBuyer).credits;
  const rejectedUnknown = sndEconomy.engine.mode.purchase(sndBuyer, 'invalid-weapon');
  const rejectedUnaffordable = sndEconomy.engine.mode.purchase(sndBuyer, 'sniper');
  const acceptedRifle = sndEconomy.engine.mode.purchase(sndBuyer, 'rifle');
  const sndBoughtTick = stepModeAt(sndEconomy, sndEconomy.engine.now);
  const sndBoughtRow = playerRow(sndBoughtTick, 'snd-buyer');
  const sndNextLiveAt = sndBoughtTick.match.phaseEndsAt;
  stepModeAt(sndEconomy, sndNextLiveAt);
  const rejectedLive = sndEconomy.engine.mode.purchase(sndBuyer, 'smg');
  ok(sndKillCredits === 1100
    && sndEconomyRoundTick.match.roundWinner === 'alpha'
    && playerRow(sndEconomyRoundTick, 'snd-buyer')?.credits === 4350
    && playerRow(sndEconomyRoundTick, 'snd-loser')?.credits === 2200
    && sndNoRespawnAt === Infinity
    && playerRow(sndEconomyBeforeRound, 'snd-loser')?.state === 'dead'
    && playerRow(sndEconomyBuyTick, 'snd-loser')?.state === 'alive'
    && creditsBeforeBuys === 4350
    && rejectedUnknown === false
    && rejectedUnaffordable === false
    && acceptedRifle === true
    && rejectedLive === false
    && sndBoughtRow?.credits === 1650
    && exact(sndBoughtRow.owned, ['rifle', 'revolver'])
    && sndBoughtRow.weapon === WEAPON_IDS.indexOf('rifle')
    && sndBoughtRow.mag[WEAPON_IDS.indexOf('rifle')] === WEAPONS.rifle.magSize
    && sndBoughtRow.reserve[WEAPON_IDS.indexOf('rifle')] === WEAPONS.rifle.reserveMax
    && sndEconomy.engine.mode.playerSnapshot(sndBuyer).credits === 1650,
  'S&D applies kill/win/loss credits once, never respawns mid-round, and enforces valid prep purchases');

  const sndObjective = createModeEngine('snd');
  for (const [id, name] of [
    ['snd-objective-a1', 'SND Objective A1'],
    ['snd-objective-b1', 'SND Objective B1'],
    ['snd-objective-a2', 'SND Objective A2'],
    ['snd-objective-b2', 'SND Objective B2'],
  ]) sndObjective.engine.addBot(id, name);
  stepModeAt(sndObjective, sndObjective.engine.mode.matchSnapshot().phaseEndsAt);
  const objectiveLiveAt = sndObjective.engine.now;
  const droppedCarrierId = sndObjective.engine.mode.matchSnapshot().bomb.carrier;
  const droppedCarrier = sndObjective.engine.entities.get(droppedCarrierId);
  const pickupPlayer = sndObjective.engine.players.find(
    (player) =>
      player.id !== droppedCarrierId
        && sndObjective.engine.mode.roleFor(player) === 'attackers'
  );
  const objectiveDefender = sndObjective.engine.players.find(
    (player) => sndObjective.engine.mode.roleFor(player) === 'defenders'
  );
  Object.assign(droppedCarrier, { x: 63, y: 70, z: 63 });
  Object.assign(pickupPlayer, { x: 80, y: 70, z: 80 });
  sndObjective.engine.killPlayer(droppedCarrier, objectiveDefender, 'revolver', false);
  const droppedBomb = sndObjective.engine.mode.matchSnapshot().bomb;
  const droppedCarrierFields = sndObjective.engine.mode.playerSnapshot(droppedCarrier);
  Object.assign(pickupPlayer, { x: 64.3, y: 70, z: 63 });
  const pickupTick = stepModeAt(sndObjective, objectiveLiveAt);
  ok(droppedBomb.state === 'dropped'
    && droppedBomb.carrier === null
    && droppedBomb.x === 63
    && droppedBomb.y === 70
    && droppedBomb.z === 63
    && droppedCarrierFields.bomb === false
    && pickupTick.match.bomb.state === 'carried'
    && pickupTick.match.bomb.carrier === pickupPlayer.id
    && playerRow(pickupTick, pickupPlayer.id)?.bomb === true
    && pickupTick.events.filter(
      (event) => event.kind === 'bomb_pickup' && event.id === pickupPlayer.id
    ).length === 1,
  'S&D drops the carried bomb at the death position and the nearby surviving attacker picks it up');

  Object.assign(pickupPlayer, { x: 51, y: 70, z: 51 });
  applyInteract(sndObjective.engine, pickupPlayer.id, 1, true);
  const plantStartedAt = sndObjective.engine.now;
  const plantStartTick = stepModeAt(sndObjective, plantStartedAt);
  const plantEarlyTick = stepModeAt(sndObjective, plantStartedAt + 2999);
  const plantedTick = stepModeAt(sndObjective, plantStartedAt + 3000);
  const plantedAt = plantedTick.now;
  ok(plantStartTick.match.bomb.state === 'carried'
    && playerRow(plantStartTick, pickupPlayer.id)?.interaction?.kind === 'plant'
    && playerRow(plantStartTick, pickupPlayer.id)?.interaction?.site === 'A'
    && plantEarlyTick.match.bomb.state === 'carried'
    && plantedTick.match.bomb.state === 'planted'
    && plantedTick.match.bomb.carrier === null
    && plantedTick.match.bomb.site === 'A'
    && plantedTick.match.bomb.x === 51
    && plantedTick.match.bomb.y === 70
    && plantedTick.match.bomb.z === 51
    && plantedTick.match.bomb.explodeAt - plantedAt === 40000
    && playerRow(plantedTick, pickupPlayer.id)?.credits === 1100
    && playerRow(plantedTick, pickupPlayer.id)?.bomb === false
    && playerRow(plantedTick, pickupPlayer.id)?.interaction === null
    && plantedTick.events.filter(
      (event) => event.kind === 'bomb_plant' && event.id === pickupPlayer.id
    ).length === 1,
  'S&D requires the full held 3000ms plant and publishes exact planted bomb/player fields');

  sndObjective.engine.killPlayer(pickupPlayer, objectiveDefender, 'revolver', false);
  const plantedEliminationTick = stepModeAt(sndObjective, sndObjective.engine.now);
  ok(plantedEliminationTick.match.phase === 'live'
    && plantedEliminationTick.match.roundWinner === null
    && plantedEliminationTick.match.bomb.state === 'planted'
    && sndObjective.engine.players
      .filter((player) => sndObjective.engine.mode.roleFor(player) === 'attackers')
      .every((player) => player.state === 'dead')
    && !plantedEliminationTick.events.some((event) => event.kind === 'round_end'),
  'a planted bomb keeps the S&D round live after every attacker is eliminated');

  Object.assign(objectiveDefender, {
    x: plantedEliminationTick.match.bomb.x,
    y: plantedEliminationTick.match.bomb.y,
    z: plantedEliminationTick.match.bomb.z,
  });
  applyInteract(sndObjective.engine, objectiveDefender.id, 1, true);
  const defuseStartedAt = plantedAt + 1000;
  const defuseStartTick = stepModeAt(sndObjective, defuseStartedAt);
  const defuseEarlyTick = stepModeAt(sndObjective, defuseStartedAt + 4999);
  const defusedTick = stepModeAt(sndObjective, defuseStartedAt + 5000);
  ok(playerRow(defuseStartTick, objectiveDefender.id)?.interaction?.kind === 'defuse'
    && defuseEarlyTick.match.bomb.state === 'planted'
    && defusedTick.match.bomb.state === 'defused'
    && defusedTick.match.phase === 'post'
    && defusedTick.match.roundWinner === 'bravo'
    && exact(defusedTick.match.scores, { alpha: 0, bravo: 1 })
    && defusedTick.events.filter(
      (event) => event.kind === 'bomb_defuse' && event.id === objectiveDefender.id
    ).length === 1
    && defusedTick.events.filter(
      (event) => event.kind === 'round_end'
        && event.winner === 'bravo'
        && event.reason === 'defuse'
    ).length === 1,
  'S&D completes defuse only after the full held 5000ms and awards defenders once');

  const sndPriority = createModeEngine('snd');
  sndPriority.engine.addBot('snd-priority-a', 'SND Priority A');
  sndPriority.engine.addBot('snd-priority-b', 'SND Priority B');
  stepModeAt(sndPriority, sndPriority.engine.mode.matchSnapshot().phaseEndsAt);
  const priorityCarrierId = sndPriority.engine.mode.matchSnapshot().bomb.carrier;
  const priorityCarrier = sndPriority.engine.entities.get(priorityCarrierId);
  const priorityDefender = sndPriority.engine.players.find(
    (player) => sndPriority.engine.mode.roleFor(player) === 'defenders'
  );
  Object.assign(priorityCarrier, { x: 51, y: 70, z: 51 });
  applyInteract(sndPriority.engine, priorityCarrier.id, 1, true);
  const priorityPlantStart = sndPriority.engine.now;
  stepModeAt(sndPriority, priorityPlantStart);
  const priorityPlanted = stepModeAt(sndPriority, priorityPlantStart + 3000);
  const priorityExplodeAt = priorityPlanted.match.bomb.explodeAt;
  Object.assign(priorityDefender, {
    x: priorityPlanted.match.bomb.x,
    y: priorityPlanted.match.bomb.y,
    z: priorityPlanted.match.bomb.z,
  });
  applyInteract(sndPriority.engine, priorityDefender.id, 1, true);
  stepModeAt(sndPriority, priorityExplodeAt - 5000);
  const priorityEarly = stepModeAt(sndPriority, priorityExplodeAt - 1);
  const priorityTick = stepModeAt(sndPriority, priorityExplodeAt);
  ok(priorityEarly.match.bomb.state === 'planted'
    && priorityTick.match.bomb.state === 'exploded'
    && priorityTick.match.phase === 'post'
    && priorityTick.match.roundWinner === 'alpha'
    && exact(priorityTick.match.scores, { alpha: 1, bravo: 0 })
    && priorityTick.events.filter((event) => event.kind === 'bomb_explode').length === 1
    && !priorityTick.events.some((event) => event.kind === 'bomb_defuse')
    && priorityTick.events.filter(
      (event) => event.kind === 'round_end'
        && event.winner === 'alpha'
        && event.reason === 'explosion'
    ).length === 1,
  'S&D explosion wins the exact tick on which a 5000ms defuse also completes');

  const sndLifecycle = createModeEngine('snd');
  sndLifecycle.engine.addBot('snd-life-alpha', 'SND Life Alpha');
  sndLifecycle.engine.addBot('snd-life-bravo', 'SND Life Bravo');
  const lifeAlpha = sndLifecycle.engine.entities.get('snd-life-alpha');
  const lifeBravo = sndLifecycle.engine.entities.get('snd-life-bravo');
  const alphaCreditsByRound = [4350, 7900, 11450, 15000, 16000, 16000];
  const bravoCreditsByRound = [2200, 4100, 6500, 9400, 12800, 16000];
  let firstHalfLifecycle = true;
  let roundSevenPrep = null;
  for (let round = 1; round <= 6; round++) {
    const prepEndsAt = sndLifecycle.engine.mode.matchSnapshot().phaseEndsAt;
    const liveTick = stepModeAt(sndLifecycle, prepEndsAt);
    sndLifecycle.engine.killPlayer(lifeBravo, lifeAlpha, 'revolver', false);
    const roundTick = stepModeAt(sndLifecycle, sndLifecycle.engine.now);
    const alphaRow = playerRow(roundTick, 'snd-life-alpha');
    const bravoRow = playerRow(roundTick, 'snd-life-bravo');
    firstHalfLifecycle = firstHalfLifecycle
      && liveTick.match.phase === 'live'
      && liveTick.match.phaseEndsAt - liveTick.now === 90000
      && roundTick.match.phase === 'post'
      && roundTick.match.round === round
      && roundTick.match.roundWinner === 'alpha'
      && roundTick.match.scores.alpha === round
      && roundTick.match.scores.bravo === 0
      && alphaRow?.credits === alphaCreditsByRound[round - 1]
      && bravoRow?.credits === bravoCreditsByRound[round - 1]
      && roundTick.events.filter((event) => event.kind === 'round_end').length === 1;
    const postEndsAt = roundTick.match.phaseEndsAt;
    const beforeNextRound = stepModeAt(sndLifecycle, postEndsAt - 1);
    const nextRound = stepModeAt(sndLifecycle, postEndsAt);
    firstHalfLifecycle = firstHalfLifecycle
      && postEndsAt - roundTick.now === 5000
      && beforeNextRound.match.phase === 'post'
      && nextRound.match.phase === 'prep'
      && nextRound.match.round === round + 1
      && nextRound.match.scores.alpha === round
      && nextRound.match.scores.bravo === 0
      && nextRound.players.every((row) => row.state === 'alive');
    if (round < 6) {
      firstHalfLifecycle = firstHalfLifecycle
        && nextRound.match.attackers === 'alpha'
        && nextRound.match.defenders === 'bravo'
        && !nextRound.events.some((event) => event.kind === 'halftime');
    } else {
      roundSevenPrep = nextRound;
    }
  }
  ok(firstHalfLifecycle
    && roundSevenPrep?.match.round === 7
    && exact(roundSevenPrep.match.scores, { alpha: 6, bravo: 0 })
    && roundSevenPrep.match.attackers === 'bravo'
    && roundSevenPrep.match.defenders === 'alpha'
    && sndLifecycle.engine.mode.roleFor(lifeAlpha) === 'defenders'
    && sndLifecycle.engine.mode.roleFor(lifeBravo) === 'attackers'
    && roundSevenPrep.events.filter((event) => event.kind === 'halftime').length === 1,
  'S&D preserves round scores and exact credit awards while swapping roles after six rounds');

  const roundSevenLive = stepModeAt(
    sndLifecycle,
    sndLifecycle.engine.mode.matchSnapshot().phaseEndsAt,
  );
  sndLifecycle.engine.killPlayer(lifeBravo, lifeAlpha, 'revolver', false);
  const matchWonTick = stepModeAt(sndLifecycle, sndLifecycle.engine.now);
  const matchResetAt = matchWonTick.match.phaseEndsAt;
  const beforeMatchReset = stepModeAt(sndLifecycle, matchResetAt - 1);
  const matchResetTick = stepModeAt(sndLifecycle, matchResetAt);
  ok(roundSevenLive.match.phase === 'live'
    && roundSevenLive.match.attackers === 'bravo'
    && roundSevenLive.match.defenders === 'alpha'
    && matchWonTick.match.phase === 'post'
    && matchWonTick.match.round === 7
    && matchWonTick.match.roundWinner === 'alpha'
    && matchWonTick.match.winner === 'alpha'
    && exact(matchWonTick.match.scores, { alpha: 7, bravo: 0 })
    && matchWonTick.events.filter(
      (event) => event.kind === 'match_end' && event.winner === 'alpha'
    ).length === 1
    && beforeMatchReset.match.winner === 'alpha'
    && exact(beforeMatchReset.match.scores, { alpha: 7, bravo: 0 })
    && matchResetAt - matchWonTick.now === 5000
    && matchResetTick.match.phase === 'prep'
    && matchResetTick.match.phaseEndsAt - matchResetTick.now === 10000
    && matchResetTick.match.round === 1
    && matchResetTick.match.roundWinner === null
    && matchResetTick.match.winner === null
    && exact(matchResetTick.match.scores, { alpha: 0, bravo: 0 })
    && matchResetTick.match.attackers === 'alpha'
    && matchResetTick.match.defenders === 'bravo'
    && matchResetTick.players.every((row) =>
      row.state === 'alive'
        && row.credits === 800
        && exact(row.owned, ['revolver'])
        && row.weapon === revolverSlot
        && row.score === 0
        && row.kills === 0
        && row.deaths === 0)
    && matchResetTick.events.filter((event) => event.kind === 'match_start').length === 1
    && matchResetTick.events.filter((event) => event.kind === 'round_start').length === 1,
  'S&D awards the seventh round, posts once, then resets the complete match lifecycle');
}

async function runNetwork(server, clients) {
  const port = await server.port;
  await waitForHttp(port);
  console.log(`smoke: real server on :${port}…`);

  const indexTargets = ['/', '/?headless=1', '/?lobby=ABCDE&headless=1'];
  const indexResponses = await Promise.all(indexTargets.map((target) => fetchBytes(port, target)));
  const [page, ...queryPages] = indexResponses;
  ok(indexResponses.every((response) => response.status >= 200 && response.status < 300)
    && indexResponses.every((response) => response.contentType.startsWith('text/html'))
    && queryPages.every((response) => response.body.equals(page.body))
    && page.body.includes(Buffer.from('VOXEL BLITZ')),
  'index queries serve identical HTML bytes');

  const [asset, queriedAsset] = await Promise.all([
    fetchBytes(port, '/shared/combatmath.js'),
    fetchBytes(port, '/shared/combatmath.js?v=smoke'),
  ]);
  ok(asset.status === 200
    && queriedAsset.status === asset.status
    && queriedAsset.contentType === asset.contentType
    && queriedAsset.body.equals(asset.body),
  'static asset query serves identical status, content type, and bytes');

  const blockedTargets = [
    '/%ZZ/server/index.js',
    '/../server/index.js',
    '/%2e%2e/server/index.js',
  ];
  const blockedResponses = await Promise.all(
    blockedTargets.map((target) => fetchRawBytes(port, target))
  );
  ok(blockedResponses.every((response) => response.status < 200 || response.status >= 300)
    && blockedResponses.every((response) => !response.body.includes(Buffer.from('voxel-blitz listening on'))),
  'malformed encoding and plain or encoded traversal are rejected without source disclosure');

  const a = new Client(port, 'SmokeA');
  const b = new Client(port, 'SmokeB');
  clients.push(a, b);
  await a.join();
  await b.join();
  const canonicalBytes = serializeWorld().byteLength;
  ok(a.welcome.mapBytes === canonicalBytes && b.welcome.mapBytes === canonicalBytes,
    `welcome advertises canonical map length (${canonicalBytes} bytes)`);
  ok(a.mapBytes === a.welcome.mapBytes, `SmokeA binary length matches welcome (${a.mapBytes} bytes)`);
  ok(b.mapBytes === b.welcome.mapBytes, `SmokeB binary length matches welcome (${b.mapBytes} bytes)`);
  ok(a.id && b.id && a.id !== b.id, 'distinct player ids');

  for (let s = 0; s < 150; s++) {
    a.input(s, { forward: true, fire: true });
    b.input(s, { fire: true, yaw: Math.PI / 4 });
    await delay(22);
  }

  ok(a.ticks.length >= 40, `snapshots flowing (${a.ticks.length})`);
  const lastTick = a.ticks.at(-1);
  ok(lastTick?.players.length >= 2, 'snapshot carries both players');
  const me = lastTick?.players.find((p) => p.id === a.id);
  ok(me && Number.isFinite(me.x) && Number.isFinite(me.y), 'own row has finite position');
  ok(me && typeof me.hp === 'number' && me.hp >= 0 && me.hp <= 100, 'hp sane');
  ok(me && Array.isArray(me.mag) && me.mag.length === WEAPON_IDS.length
    && me.mag.every(Number.isFinite)
    && Array.isArray(me.reserve) && me.reserve.length === WEAPON_IDS.length
    && me.reserve.every(Number.isFinite)
    && typeof me.reloading === 'boolean'
    && Number.isFinite(me.panic) && me.panic >= 0 && me.panic <= 1
    && Number.isFinite(me.exhaustion) && me.exhaustion >= 0 && me.exhaustion <= 1,
  'wire snapshot carries dynamic ammo, reload, and normalized hidden conditions');

  const shoot = a.events.find((e) => e.kind === 'shoot');
  ok(shoot, 'shoot events broadcast inside snapshots');
  ok(shoot && vectorNorm(shoot.d) > 0.9 && vectorNorm(shoot.spread) > 0.9,
    'wire shoot event vectors are nonzero');
  const totalKillEvs = [...a.events, ...b.events].filter((e) => e.kind === 'kill').length;
  const blockEvents = a.events.filter((e) => e.kind === 'block').length;
  console.log(`  info - kills=${totalKillEvs} brokenBlocks=${blockEvents}`);

  const firstTick = a.ticks.find((t) => t.players.some((p) => p.id === a.id));
  const firstMe = firstTick?.players.find((p) => p.id === a.id);
  const movedDist = me && firstMe ? Math.hypot(me.x - firstMe.x, me.z - firstMe.z) : 0;
  ok(movedDist > 0.5, `raw f input integrates movement (${movedDist.toFixed(2)}u)`);
}

async function main() {
  runDirectContracts();
  console.log('smoke: booting server…');
  const server = startServer();
  const clients = [];
  try {
    await Promise.race([runNetwork(server, clients), server.failed]);
    if (fails.length) throw new Error(`SMOKE FAILED: ${fails.length} assertion(s)`);
    console.log('\nSMOKE OK');
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error('smoke crashed:', error.message);
  process.exitCode = fails.length ? 1 : 2;
});
