// LONGSHOT MK-II ballistics: drop table, authoritative flight over ticks,
// holdover at range, lag-compensated hits on movers, client/server path
// parity, and the bots' holdover and lead.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { AIR, CONCRETE, GROUND } from '../shared/worlddata.js';
import { playerHitboxes } from '../shared/player-hitboxes.js';
import { STONE } from '../shared/world/blocks.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { TracerFX } from '../public/js/weapons/ballistics.js';
import { CombatFeedback } from '../public/js/combat/feedback.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { Session } from '../public/js/session/session.js';
import { scopeHoldoverMarks, scopeMilVh } from '../public/js/ui/sniper-scope.js';
import {
  BALLISTIC_STEP_S, ballisticAimPitch, ballisticIntercept, ballisticLaunch, ballisticPoint, ballisticProfile,
  flightTimeS, holdoverMils, traceBallistic, zeroAngle,
} from '../shared/bullet-ballistics.js';

const SNIPER = WEAPON_IDS.indexOf('sniper');
const profile = ballisticProfile(WEAPONS.sniper);
const TICK_MS = 1000 / 60;

// 1. Trajectory: zeroed at 100 m, linear mil drop, finite muzzle speed.
{
  assert.ok(profile && profile.speed >= 350 && profile.speed <= 500, 'game-scale muzzle velocity');
  assert.equal(ballisticProfile(WEAPONS.rifle), null, 'other guns stay hitscan');
  assert.equal(ballisticProfile(WEAPONS.longarc), null, 'the LONGARC keeps its own bolt projectile');
  assert.ok(Math.abs(holdoverMils(profile, profile.zeroM)) < 1e-6, 'the round crosses the sight line at the zero');
  const launch = ballisticLaunch(profile, [0, 0, 0], { x: 0, y: 0, z: -1 });
  for (const range of [50, 150, 250, 300, 400]) {
    const t = flightTimeS(profile, range);
    const point = ballisticPoint(profile, launch, t);
    assert.ok(Math.abs(-point.z - range) < 1e-6, 'flight time covers the range');
    assert.ok(Math.abs(-point.y / range * 1000 - holdoverMils(profile, range)) < 1e-6,
      `holdover table matches the integrated arc at ${range} m`);
  }
  const drop = range => holdoverMils(profile, range) * range / 1000;
  assert.ok(drop(50) < 0 && drop(50) > -0.12, `50 m rides ${(-drop(50) * 100).toFixed(1)} cm high`);
  assert.ok(drop(150) > 0.15, `150 m drops ${(drop(150) * 100).toFixed(0)} cm: holdover starts to matter`);
  assert.ok(drop(250) > 0.9, `250 m drops ${drop(250).toFixed(2)} m`);
  assert.ok(flightTimeS(profile, 250) > 0.45, 'a 250 m shot needs lead on a mover');
  assert.ok(zeroAngle(profile) > 0 && zeroAngle(profile) < 0.01);
  // Bot/scope aim: the solved pitch drops the round onto the point.
  for (const [flat, dy] of [[60, 0], [250, 1.5], [320, -12]]) {
    const pitch = ballisticAimPitch(profile, flat, dy);
    const shot = ballisticLaunch(profile, [0, 0, 0], { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) });
    const at = ballisticPoint(profile, shot, flat / Math.hypot(shot.vx, shot.vz));
    assert.ok(Math.abs(at.y - dy) < 0.01, `ballisticAimPitch lands on target at ${flat} m (${at.y} vs ${dy})`);
  }
  console.log(`Sniper ballistics: ${profile.speed} m/s, zero ${profile.zeroM} m; holdover 150/250/300 m =`
    + ` ${[150, 250, 300].map(r => holdoverMils(profile, r).toFixed(2)).join('/')} mil,`
    + ` flight 250 m = ${flightTimeS(profile, 250).toFixed(3)} s.`);
}

// Open concrete floor with a human sniper and a target down range (-z).
function arena(distance, { bots = 0, difficulty = 'normal' } = {}) {
  const y = GROUND + 1.02;
  const spawn = { x: 400.5, y, z: 600.5, index: 0 };
  const world = {
    meta: { id: 'foundry', spawns: { fun: [spawn] } },
    getBlock: (x, by, z) => by <= GROUND ? CONCRETE : AIR,
    heightAt: () => GROUND,
    findSpawns: () => [spawn],
    setBlock: () => false,
  };
  const engine = new GameEngine({ world, mode: 'fun' });
  engine.now = 100_000;
  const manager = bots ? attachBots(engine, bots, { difficulties: new Map([['bot-0', difficulty]]) }) : null;
  engine.addClient('shooter', 'Shooter');
  engine.addClient('victim', 'Victim');
  const shooter = engine.entities.get('shooter');
  const victim = engine.entities.get('victim');
  Object.assign(shooter, { x: 400.5, y, z: 600.5, yaw: 0, pitch: 0, spawnProtectedUntil: 0 });
  Object.assign(victim, { x: 400.5, y, z: 600.5 - distance, yaw: 0, pitch: 0, spawnProtectedUntil: 0 });
  shooter.weapon = SNIPER;
  engine.contexts.combat.computeConeDeg = () => 0;
  const events = [];
  engine.tickEvents.push = function (...items) { events.push(...items); return Array.prototype.push.apply(this, items); };
  const hold = () => { victim.hp = 100_000; victim.spawnProtectedUntil = 0; };
  for (let i = 0; i < 20; i++) {
    hold();
    engine.applyInput('shooter', { keys: {}, weapon: SNIPER, wantAds: true, yaw: 0, pitch: 0, seq: i + 1 });
    engine.step(TICK_MS);
  }
  shooter.deployT = 0; shooter.adsT = 1; shooter.cooldown = 0;
  return { engine, shooter, victim, events, hold, manager };
}

const eyeOf = p => [p.eyeX, p.eyeY, p.eyeZ];
const zoneCenter = (p, zone) => playerHitboxes(p).find(box => box.zone === zone).center;
function losAngles(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Fire once with the given look and step until the round settles. */
function fire(f, aim, { viewAge = 60, beforeTick = () => {}, maxTicks = 150 } = {}) {
  const start = f.events.length;
  let seq = 1000;
  const send = wantFire => f.engine.applyInput('shooter', { keys: {}, weapon: SNIPER, wantAds: true,
    wantFire, yaw: aim.yaw, pitch: aim.pitch, viewAge, seq: seq++ });
  f.shooter.cooldown = 0; f.shooter.adsT = 1;
  send(true);
  let tick = 0, hitTick = null, bullet = null;
  for (; tick < maxTicks && !bullet; tick++) {
    f.hold(); beforeTick(tick);
    f.engine.step(TICK_MS);
    if (tick === 0) send(false);
    const fresh = f.events.slice(start);
    if (hitTick === null && fresh.some(e => e.kind === 'hit' && e.attacker === 'shooter')) hitTick = tick;
    bullet = fresh.find(e => e.kind === 'bullet' && e.id === 'shooter') || null;
  }
  const fresh = f.events.slice(start);
  return {
    shoot: fresh.find(e => e.kind === 'shoot' && e.id === 'shooter'),
    hit: fresh.find(e => e.kind === 'hit' && e.attacker === 'shooter') || null,
    hitTick, bullet,
  };
}

// 2. Short range stays immediate: a 5 m shot lands in the firing tick, 50 m
// needs only its ~0.11 s flight and lands on the head held dead on.
{
  const close = arena(5);
  const shot = fire(close, losAngles(eyeOf(close.shooter), zoneCenter(close.victim, 'torso')));
  assert.equal(shot.hitTick, 0, 'a 5 m round hits in the tick it was fired');
  assert.equal(shot.shoot.paths, undefined, 'a flying round publishes no instant path with the shot');
  assert.deepEqual(shot.bullet.hitVictims, ['victim'], 'the settled round names its victim');

  const f = arena(50);
  const result = fire(f, losAngles(eyeOf(f.shooter), zoneCenter(f.victim, 'head')));
  assert.ok(result.hit?.hs, '50 m: dead-on head aim is a headshot without holdover');
  const expectTicks = Math.ceil(flightTimeS(profile, 50) / BALLISTIC_STEP_S) - 1;
  assert.ok(Math.abs(result.hitTick - expectTicks) <= 1, `50 m lands after its flight (${result.hitTick} ticks)`);
}

// 3. 230 m: dead-on head aim drops into the hips; holding over lands the headshot.
let flightTicks250 = 0;
{
  const f = arena(230);
  const head = zoneCenter(f.victim, 'head');
  const low = fire(f, losAngles(eyeOf(f.shooter), head));
  assert.ok(low.hit && !low.hit.hs, '230 m without holdover hits low (no headshot)');
  assert.ok(low.hit.vy < head[1] - 0.6, `the round lands ${(head[1] - low.hit.vy).toFixed(2)} m under the aim`);
  const held = ballisticIntercept(profile, eyeOf(f.shooter), head);
  const high = fire(f, { yaw: held.yaw, pitch: held.pitch });
  assert.ok(high.hit?.hs, '230 m with holdover is a headshot');
  flightTicks250 = high.hitTick;
  const expectTicks = Math.ceil(flightTimeS(profile, 230) / BALLISTIC_STEP_S) - 1;
  assert.ok(Math.abs(high.hitTick - expectTicks) <= 1, `230 m hit arrives after ${high.hitTick} ticks (${expectTicks} expected)`);
}

// 4. 330 m: a centre-mass hold falls short into the ground (a grazing round
// may skip on into the legs); holding over puts it in the chest.
{
  const f = arena(330);
  const torso = zoneCenter(f.victim, 'torso');
  const miss = fire(f, losAngles(eyeOf(f.shooter), torso));
  const end = miss.bullet.paths[0].find(segment => segment.hit);
  assert.ok(end && end.end[2] > f.victim.z + 5, 'the round strikes the ground short of the target');
  assert.ok(!miss.hit || (!miss.hit.hs && miss.hit.vy < torso[1] - 0.3),
    '330 m centre hold without holdover never reaches the chest');
  // Client presentation flies the identical arc to the same ground contact.
  const launch = ballisticLaunch(profile, eyeOf(f.shooter), (() => {
    const a = losAngles(eyeOf(f.shooter), torso);
    return { x: -Math.sin(a.yaw) * Math.cos(a.pitch), y: Math.sin(a.pitch), z: -Math.cos(a.yaw) * Math.cos(a.pitch) };
  })());
  const predicted = traceBallistic(profile, launch, (x, y, z) => f.engine.world.getBlock(x, y, z) !== AIR);
  assert.ok(Math.hypot(predicted.end.x - end.end[0], predicted.end.y - end.end[1], predicted.end.z - end.end[2]) < 0.05,
    'client trace and authority agree on the impact point');
  const held = ballisticIntercept(profile, eyeOf(f.shooter), torso);
  const hit = fire(f, { yaw: held.yaw, pitch: held.pitch }).hit;
  assert.ok(hit && Math.abs(hit.vy - torso[1]) < 0.4, '330 m with holdover hits the chest');
}

// 5. Lag compensation over the flight: a 5 m/s crosser at 250 m, shooter
// presenting 120 ms old. Leading what the shooter saw hits the head; the same
// aim judged against a 25 ms view (no rewind for the presented age) misses it.
{
  const speed = 5, viewAge = 120;
  const run = serverViewAge => {
    const f = arena(250);
    const x0 = f.victim.x;
    let t = 0;
    const move = () => { f.victim.x = x0 + speed * t; f.victim.vx = 0; t += TICK_MS / 1000; };
    for (let i = 0; i < 40; i++) { f.hold(); move(); f.engine.step(TICK_MS); }
    // The fire resolves next tick at engine.now + 1 tick; the shooter saw the
    // body viewAge earlier. Lead that pose by the flight time.
    const seenT = t + TICK_MS / 1000 - viewAge / 1000;
    const seen = { ...f.victim, x: x0 + speed * (seenT - TICK_MS / 1000) };
    const aim = ballisticIntercept(profile, eyeOf(f.shooter), zoneCenter(seen, 'head'), [speed, 0, 0]);
    return fire(f, { yaw: aim.yaw, pitch: aim.pitch }, { viewAge: serverViewAge, beforeTick: move });
  };
  const fair = run(viewAge);
  assert.ok(fair.hit?.hs, 'a led shot on what the shooter saw is a headshot after a 0.5 s flight');
  const unfair = run(25);
  assert.ok(!unfair.hit?.hs, 'without the presented-age rewind the same shot misses the head');
}

// 6. Bots hold over and lead: a sniper bot keeps hitting a stationary and a
// strafing target well beyond 100 m (hitscan baseline: 100% / ~77% at 100 m).
{
  const rate = (distance, strafe) => {
    const f = arena(distance, { bots: 1 });
    const bot = f.engine.entities.get('bot-0');
    f.manager.prepareLoadout = () => [SNIPER];
    f.engine.removeClient('shooter');
    Object.assign(bot, { x: 400.5, y: f.victim.y, z: 600.5, yaw: 0, pitch: 0, deployT: 0, spawnProtectedUntil: 0 });
    bot.weapon = SNIPER;
    let shots = 0, hits = 0;
    const start = f.events.length;
    for (let tick = 0; tick < 30 * 60; tick++) {
      f.hold(); bot.reserve[SNIPER] = 30; bot.hp = 100; bot.x = 400.5; bot.z = 600.5; bot.vx = bot.vz = 0;
      const dir = Math.floor(tick / 150) % 2 ? -1 : 1;
      f.engine.applyInput('victim', { keys: strafe ? { r: dir > 0, l: dir < 0 } : {}, yaw: 0, pitch: 0, seq: tick + 1 });
      f.engine.step(TICK_MS);
    }
    for (const e of f.events.slice(start)) {
      if (e.kind === 'shoot' && e.id === 'bot-0') shots++;
      if (e.kind === 'hit' && e.attacker === 'bot-0') hits++;
    }
    return { shots, hits, rate: hits / Math.max(1, shots) };
  };
  const still = rate(100, false), moving = rate(100, true);
  assert.ok(still.shots >= 10 && still.rate >= 0.6, `bot vs stationary at 100 m: ${still.hits}/${still.shots}`);
  assert.ok(moving.shots >= 10 && moving.rate >= 0.5, `bot vs strafer at 100 m: ${moving.hits}/${moving.shots}`);
  console.log(`Sniper bots: 100 m stationary ${still.hits}/${still.shots}, strafing ${moving.hits}/${moving.shots}.`);
}

// 7. Client presentation: the streak flies the arc, dusts the wall when it
// arrives (not at the trigger), and authority can end it early on a body.
{
  const previousDocument = globalThis.document;
  const canvasContext = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => target[key] ?? (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => canvasContext }) };
  try {
    const impacts = [];
    const wallX = 200;
    const tracers = new TracerFX(new THREE.Scene(), x => x === wallX ? STONE : AIR, hit => impacts.push(hit));
    try {
      const eye = [0.5, 40, 0.5];
      tracers.shoot({ w: 'sniper', o: eye, d: [1, 0, 0], spread: [1, 0, 0] }, { local: true });
      assert.equal(tracers.rounds.length, 1, 'a sniper shot launches one flying round');
      assert.equal(impacts.length, 0, 'no wall feedback at the trigger');
      const round = tracers.rounds[0];
      const expected = flightTimeS(profile, wallX - eye[0]);
      assert.ok(Math.abs(round.end - expected) < 0.01, `the streak reaches the wall after its flight (${round.end})`);
      let t = 0;
      while (tracers.rounds.length && t < 2) { tracers.update(1 / 120); t += 1 / 120; }
      assert.equal(impacts.length, 1, 'the wall is dusted once, on arrival');
      assert.equal(impacts[0].x, wallX);
      assert.ok(Math.abs(t - expected) < 0.02, `arrival matches the flight time (${t.toFixed(3)} s)`);
      assert.ok(!tracers.tracers.some(tracer => tracer.round), 'the streak slot is released');

      // Remote round stopped by a body at 60 m: the streak ends there, with no wall dust.
      tracers.shoot({ id: 'enemy', w: 'sniper', o: [0.5 + 0.25, eye[1] - 0.15, 0.5], d: [1, 0, 0], spread: [1, 0, 0] });
      tracers.update(0.05);
      tracers.settleRound({ kind: 'bullet', id: 'enemy', w: 'sniper',
        paths: [[{ o: eye, end: [60.5, eye[1], 0.5] }]], hitVictims: ['me'] });
      assert.ok(Math.abs(tracers.rounds[0].end - 60 / profile.speed) < 0.01, 'authority ends the streak at the body');
      tracers.update(0.2);
      assert.equal(tracers.rounds.length, 0);
      assert.equal(impacts.length, 1, 'a body stop leaves no wall dust');
    } finally { tracers.dispose(); }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  // The scope's drop ladder reads the same holdover as the flight.
  for (const mark of scopeHoldoverMarks(profile)) {
    assert.equal(mark.mil, holdoverMils(profile, mark.range));
  }
  assert.ok(Math.abs(scopeMilVh(75) - 50 * Math.tan(0.001) / Math.tan(37.5 * Math.PI / 180)) < 1e-12);
  assert.ok(scopeMilVh(17) > scopeMilVh(34) * 1.9, 'first focal plane: marks spread with magnification');
}

// 8. The live client pipeline: Session subscribes the `bullet` event, and
// CombatFeedback settles the viewer's own predicted round (whose launch event
// carries no shooter id) and plays the remote round's flyby crack.
{
  const net = new NetClient(), delivered = [];
  const session = Object.create(Session.prototype);
  Object.assign(session, {
    _pregame: { net }, _gameplayUnsubs: [], _gameplayEventsWired: false,
    _liveResourcesOwned: true, _tornDown: false, _phase: 'live',
    onGameplayEvent(event) { delivered.push(event.kind); },
  });
  session._attachGameplayListeners(net);
  try {
    net._onTick({ now: 1000, players: [], vehicles: [], events: [
      { t: 'ev', kind: 'bullet', id: 'enemy', w: 'sniper', paths: [[{ o: [0, 2, 0], end: [50, 2, 0] }]] }] });
    net.interpolate(net.latestSnapshots.at(-1).now, 0);
    assert.ok(delivered.includes('bullet'), `Session delivers the bullet event (got ${delivered.join(',') || 'nothing'})`);
  } finally { session._detachGameplayListeners(); net.close(); }

  const previousDocument = globalThis.document;
  const canvasContext = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => target[key] ?? (() => {}) });
  globalThis.document = { createElement: () => ({ getContext: () => canvasContext }) };
  try {
    const impacts = [], whiz = [];
    const wallX = 200, eye = [0.5, 40, 0.5];
    const tracers = new TracerFX(new THREE.Scene(), x => x === wallX ? STONE : AIR, hit => impacts.push(hit));
    try {
      const listenerPos = { x: 30, y: eye[1] + 0.6, z: 0.5 };
      const feedback = new CombatFeedback({
        effects: { shoot: (ev, o) => tracers.shoot(ev, o), confirmShot() {}, settleRound: (ev, o) => tracers.settleRound(ev, o) },
        sfx: { fire() {}, bulletWhiz: (...args) => whiz.push(args) },
        hud: { setPainImpulse() {} }, onLocalFlinch() {},
        getMyId: () => 'me', isRunning: () => true, player: { alive: true },
        camera: { position: listenerPos }, world: { getBlock: () => AIR },
      });
      // Exactly the prediction event weapon-state builds: no `id`.
      tracers.shoot({ o: eye, d: [1, 0, 0], w: 'sniper', spread: [1, 0, 0], pellets: [[1, 0, 0]] }, { local: true });
      tracers.update(0.05);
      feedback.handleEvent({ kind: 'bullet', id: 'me', w: 'sniper',
        paths: [[{ o: eye, end: [60.5, eye[1], 0.5] }]], hitVictims: ['enemy'] });
      assert.equal(tracers.rounds.length, 1);
      assert.ok(Math.abs(tracers.rounds[0].end - 60 / profile.speed) < 0.01, 'authority ends the own streak at the body');
      for (let t = 0; t < 1 && tracers.rounds.length; t += 1 / 120) tracers.update(1 / 120);
      assert.equal(tracers.rounds.length, 0);
      assert.equal(impacts.length, 0, 'an own round stopped in a body never dusts the wall behind it');
      assert.equal(whiz.length, 0, 'the shooter hears no crack from their own round');
      // A remote round passing 0.6 m over the listener cracks on settlement.
      feedback.handleEvent({ kind: 'bullet', id: 'enemy', w: 'sniper',
        paths: [[{ o: eye, end: [wallX, eye[1], 0.5], hit: { x: wallX, y: eye[1], z: 0, nx: -1, ny: 0, nz: 0 } }]] });
      assert.equal(whiz.length, 1, 'a remote sniper round plays the near-miss crack');
    } finally { tracers.dispose(); }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

console.log(`Sniper ballistics: 5 m same-tick hit, 50 m head dead-on, 230 m holdover headshot after ${flightTicks250} ticks,`
  + ' 330 m holdover hit, client/server arc parity, lag-compensated lead on a crosser, streak timing, scope ladder and live bullet-event pipeline passed.');
