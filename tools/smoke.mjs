import { combatDamage } from '../shared/combat-balance.js';
import { computeConeDeg, fireOneShot, nearestVictim, resolveWeaponIntent } from '../server/sim/combat.js';
import { updateCondition } from '../server/sim/movement.js';
import { weaponSwapProfile } from '../shared/weapon-swap.js';
// Protocol smoke test: starts the real HTTP+WebSocket server on an OS-assigned
// port, joins two real clients, and checks both direct simulation contracts and
// the actual wire stream.
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ok as assertOk, nearly, vectorNorm } from './lib/assert.mjs';
import { delay } from './lib/async.mjs';
import { startServer as startManagedServer, stopServer, waitForHttp } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';

import {
  CONDITION_RULES,
  WEAPONS,
  WEAPON_IDS,
  computeRecoilKickDeg,
  computeSpreadConeDeg,
  damageAtDistance,
  samplePelletDirection,
} from '../shared/combatmath.js';
import { valueNoise2 } from '../shared/noise.js';
import { NETWORK_PRESENTATION } from '../shared/networking.js';
import { raycastVoxels } from '../shared/raycast.js';
import {
  AIR,
  GLASS,
  METAL,
  STONE,
  getMapMeta,
  serializeWorld,
} from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { evDie, evRespawn } from '../server/protocol/events.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { PROJECTILE_RULES } from '../server/sim/projectiles.js';
import { GRENADE_TYPES, GRENADE_TYPE_IDS } from '../shared/grenade-rules.js';
import { BOLT_RULES, boltBounces } from '../shared/bolt-rules.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { ImpactFX } from '../public/js/weapons/impacts.js';

const fails = [];
const ok = (condition, name) => assertOk(
  condition,
  name,
  (message) => { console.log('  FAIL -', message); fails.push(message); },
  (message) => console.log('  ok -', message),
);

function startServer() {
  return startManagedServer({
    failureContext: 'smoke',
    stopTimeout: 2_000,
    stopSignal: 'SIGINT',
  });
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

function runDirectContracts() {
  console.log('smoke: direct contracts…');

  const impactScene = new THREE.Scene();
  const impactFx = new ImpactFX(impactScene, new THREE.PerspectiveCamera(), () => 0);
  ok(impactFx.impactMeshes.every((mesh) =>
    mesh.material.depthTest === true && mesh.material.depthWrite === false),
  'world hit confirmations respect scene depth without writing it');
  impactFx.dispose();

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
  const targetHit = nearestVictim(shooter, [60, 31.62, 60], { x: 0, y: 0, z: -1 }, 20, hitEngine.contexts.combat);
  ok(targetHit?.victim === target && targetHit.t > 4,
    'player ray excludes shooter and dead bodies, then hits the live target');

  const stateEvents = makeSnapshot([], [], [evDie('p'), evRespawn('p', 1, 2, 3)], 0).events;
  ok(stateEvents[0]?.kind === 'die' && stateEvents[1]?.kind === 'respawn',
    'embedded die and respawn events are dispatchable by kind');

  const expectedWeaponIds = ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'revolver', 'longarc', 'rocket', 'lance', 'knife', 'minigun', 'flamethrower'];
  const expectedWeights = [3.4, 2.3, 3.6, 5.2, 8.4, 1.4, 4.1, 9.6, 3.8, 0.9, 11.8, 5.8];
  ok(JSON.stringify(WEAPON_IDS) === JSON.stringify(expectedWeaponIds),
    'weapon roster exposes the exact ten-slot order');
  const definitionsComplete = WEAPON_IDS.every((id, slot) => {
    const def = WEAPONS[id];
    return def?.id === id && typeof def.name === 'string' && def.name.length > 0
      && ['auto', 'semi', 'pump', 'bolt', 'charge', 'melee'].includes(def.mode)
      && Number.isFinite(def.rpm) && def.rpm > 0
      && Number.isInteger(def.magSize) && def.magSize >= 0
      && Number.isInteger(def.spareRounds ?? def.spareMags) && (def.spareRounds ?? def.spareMags) >= 0
      && Array.isArray(def.damage) && def.damage.length === 3 && def.damage.every(Number.isFinite)
      && (def.falloffStart === undefined || Number.isFinite(def.falloffStart))
      && Number.isFinite(def.headMult) && Number.isInteger(def.pellets)
      && (def.centerPellet === undefined || typeof def.centerPellet === 'boolean')
      && Number.isFinite(def.spreadDeg?.hip) && Number.isFinite(def.spreadDeg?.ads)
      && ['bloomDeg', 'bloomMaxDeg', 'bloomRecover', 'moveSpreadDeg',
        'adsFov', 'zoom', 'adsTime', 'reloadTime', 'tacTime', 'deployTime']
        .every((key) => Number.isFinite(def[key]))
      && Number.isFinite(def.recoil?.pitch) && def.recoil.pitch > 0
      && Number.isFinite(def.recoil?.pitchRamp) && def.recoil.pitchRamp >= 0
      && Number.isFinite(def.recoil?.maxPitchRamp) && def.recoil.maxPitchRamp >= 0
      && Number.isFinite(def.recoil?.yaw) && def.recoil.yaw > 0
      && Array.isArray(def.recoil?.yawPattern) && def.recoil.yawPattern.length >= 2
      && def.recoil.yawPattern.every(Number.isFinite)
      && Number.isFinite(def.recoil?.jitter) && def.recoil.jitter >= 0
      && Number.isFinite(def.recoil?.resetMs) && def.recoil.resetMs > 0
      && def.recoil.resetMs > 60000 / def.rpm
      && Number.isFinite(def.recoil?.adsMult) && def.recoil.adsMult > 0 && def.recoil.adsMult <= 1
      && (def.mode === 'melee' || def.id === 'longarc' || def.id === 'lance'
        ? def.tracer === null
        : (typeof def.tracer?.color === 'string' && Number.isFinite(def.tracer?.width)
          && Number.isFinite(def.tracer?.len)))
      && typeof def.sfx === 'string'
      && def.weightKg === expectedWeights[slot];
  });
  ok(definitionsComplete, 'all ten weapon definitions carry the complete shared contract');
  const recoilSignatures = WEAPON_IDS.map((id) => WEAPONS[id].recoil.yawPattern.join(','));
  const rifleKick0 = computeRecoilKickDeg(WEAPONS.rifle, 0, 0, 0.5);
  const rifleKick5 = computeRecoilKickDeg(WEAPONS.rifle, 5, 0, 0.5);
  const rifleAdsKick5 = computeRecoilKickDeg(WEAPONS.rifle, 5, 1, 0.5);
  ok(new Set(recoilSignatures).size === WEAPON_IDS.length
    && rifleKick5.pitch > rifleKick0.pitch
    && nearly(rifleAdsKick5.pitch, rifleKick5.pitch * WEAPONS.rifle.recoil.adsMult)
    && WEAPONS.shotgun.recoil.pitch >= 2.2
    && WEAPONS.sniper.recoil.pitch >= 3.5
    && WEAPONS.revolver.recoil.pitch >= 2,
  'weapon recoil profiles are distinct, stronger, ramping, and ADS-scaled');
  const shotgun = WEAPONS.shotgun;
  const shotgunAim = { x: 0, y: 0, z: -1 };
  let shotgunRngCalls = 0;
  const shotgunCenter = samplePelletDirection(
    shotgun,
    shotgunAim,
    () => { shotgunRngCalls += 1; return 0.5; },
    shotgun.spreadDeg.ads,
    0,
  );
  ok(shotgun.centerPellet === true
    && shotgun.rpm >= 90
    && shotgun.spreadDeg.ads <= 1.5
    && nearly(damageAtDistance(shotgun, 30), 8)
    && shotgunCenter.x === shotgunAim.x
    && shotgunCenter.y === shotgunAim.y
    && shotgunCenter.z === shotgunAim.z
    && shotgunRngCalls === 0,
  'shotgun keeps a deterministic aim ray and useful open-map ADS damage');
  const lmg = WEAPONS.lmg;
  const revolver = WEAPONS.revolver;
  ok(lmg?.name === 'BASTION LMG' && lmg.mode === 'auto' && lmg.rpm === 720
    && lmg.magSize === 60 && lmg.spareMags === 4 && lmg.sfx === 'lmg',
  'BASTION LMG has the contracted heavy automatic loadout');
  ok(revolver?.name === 'IRONCLAD .44' && revolver.mode === 'semi' && revolver.rpm === 300
    && revolver.magSize === 6 && revolver.spareMags === 8 && revolver.sfx === 'revolver',
  'IRONCLAD .44 has the contracted precision sidearm loadout');

  const spreadDef = WEAPONS.rifle;
  const bloom = 0.7, speed = 3.1, adsT = 0.62, panic = 0.4, exhaustion = 0.65;
  const spreadBase = computeSpreadConeDeg(spreadDef, bloom, speed, adsT);
  const spreadConditioned = computeSpreadConeDeg(
    spreadDef, bloom, speed, adsT, panic, exhaustion
  );
  const conditionPenalty = (panic * 0.10 + exhaustion * 0.35) * (1 - adsT * 0.45);
  ok(Math.abs(spreadConditioned - spreadBase - conditionPenalty) < 1e-12,
    'panic and exhaustion add the exact shared ADS-scaled cone penalty');
  ok(computeSpreadConeDeg(spreadDef, bloom, speed, adsT, 0, 0) === spreadBase,
    'omitted hidden conditions preserve the original spread result');
  ok(JSON.stringify(CONDITION_RULES) === JSON.stringify({
    panicDamageGain: 0.012,
    panicHeadshotGain: 0.22,
    panicDecayPerS: 0.06,
    panicLowHpFloor: 0,
    painDamageGain: 0.012,
    painHeadshotGain: 0.12,
    painHalfLifeS: 2,
    painLowHpFloor: 0.12,
    steadyPanicRecoverPerS: 0.12,
    crouchPanicRecoverMult: 1.35,
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
    viewAge: 9999,
  };
  tapEngine.applyInput('tap', { ...tapInput, seq: 1, wantFire: true });
  tapEngine.applyInput('tap', { ...tapInput, seq: 2, wantFire: false });
  tapEngine.step(TICK_MS);
  const tapShot = tapSnapshots[0]?.events.find((event) => event.kind === 'shoot' && event.id === 'tap');
  ok(tapShot && tapper.hp === 100
    && tapper.input.viewAge === NETWORK_PRESENTATION.maxViewAgeMs,
  'a complete fire tap is accepted once and its reported view age is authority-clamped');

  const grenadeEngine = new GameEngine();
  grenadeEngine.addBot('thrower', 'Thrower');
  grenadeEngine.addBot('blast-target', 'Blast Target');
  const thrower = grenadeEngine.entities.get('thrower');
  const blastTarget = grenadeEngine.entities.get('blast-target');
  Object.assign(thrower, { x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0 });
  Object.assign(blastTarget, { x: 44.5, y: 20, z: 53, hp: 100 });
  for (let y = 18; y <= 24; y++) {
    for (let z = 47; z <= 55; z++) {
      for (let x = 38; x <= 49; x++) grenadeEngine.world.setBlock(x, y, z, AIR);
    }
  }
  grenadeEngine.world.setBlock(44, 20, 50, STONE);
  grenadeEngine.world.setBlock(45, 20, 50, METAL);
  const grenadeContext = grenadeEngine.contexts.projectiles;
  const grenade = grenadeEngine.projectiles.throw(thrower, grenadeContext);
  Object.assign(grenade, { x: 44.5, y: 21.5, z: 50.5 });
  grenadeEngine.projectiles.explode(grenade, grenadeContext);
  ok(thrower.grenades.join(',') === '1,1,2,1,1'
    && blastTarget.hp < 100
    && grenadeEngine.world.getBlock(44, 20, 50) === AIR
    && grenadeEngine.world.getBlock(45, 20, 50) === METAL
    && grenadeEngine.tickEvents.some((event) => event.kind === 'projectileLaunch' && event.type === 'frag')
    && grenadeEngine.tickEvents.some((event) => event.kind === 'projectileExplode' && event.type === 'frag')
    && grenadeEngine.tickEvents.some((event) => event.kind === 'hit' && event.victim === 'blast-target'),
  'one authoritative frag consumes its own inventory slot, damages visible players, destroys stone, and preserves metal');

  const chargeEngine = new GameEngine();
  chargeEngine.addBot('charge-thrower', 'Charge Thrower');
  const chargeThrower = chargeEngine.entities.get('charge-thrower');
  Object.assign(chargeThrower, { yaw: -Math.PI / 2, pitch: 0, vx: 0, vy: 0, vz: 0 });
  const chargeContext = chargeEngine.contexts.projectiles;
  const shortThrow = chargeEngine.projectiles.throw(chargeThrower, chargeContext, 0);
  const longThrow = chargeEngine.projectiles.throw(chargeThrower, chargeContext, 1);
  const cookedThrow = chargeEngine.projectiles.throw(chargeThrower, chargeContext, 1, 0, 1500);
  const cookedLaunch = chargeEngine.tickEvents.filter((event) => event.kind === 'projectileLaunch').at(-1);
  ok(Math.hypot(longThrow.vx, longThrow.vz) > Math.hypot(shortThrow.vx, shortThrow.vz) * 2
    && longThrow.vy > shortThrow.vy
    && cookedThrow.explodeAt - chargeContext.now === GRENADE_TYPES.frag.fuseMs - 1500
    && cookedLaunch.fuse === GRENADE_TYPES.frag.fuseMs - 1500,
  'full grenade charge throws materially farther and higher, and a cooked frag leaves with the burned fuse');

  const forgedEngine = new GameEngine();
  forgedEngine.addBot('forged-thrower', 'Forged Thrower');
  forgedEngine.applyInput('forged-thrower', {
    seq: 1, keys: {}, yaw: 0, pitch: 0, weapon: 0,
    wantFire: false, wantAds: false, reload: false,
    throwGrenade: true, grenadeCharge: 99, grenadeType: 42, grenadeCook: 999999,
  });
  const forgedThrower = forgedEngine.entities.get('forged-thrower');
  ok(forgedThrower.grenadeEdgeQueued && forgedThrower.grenadeChargeQueued === 1
    && forgedThrower.grenadeTypeQueued === GRENADE_TYPE_IDS.length - 1
    && forgedThrower.grenadeCookQueued === 0,
  'authoritative input clamps forged grenade charge, type, and cook before simulation');

  const handEngine = new GameEngine();
  handEngine.addBot('cook-owner', 'Cook Owner');
  const cookOwner = handEngine.entities.get('cook-owner');
  Object.assign(cookOwner, { x: 44.5, y: 20, z: 50.5, hp: 100 });
  cookOwner.grenadeEdgeQueued = true;
  cookOwner.grenadeChargeQueued = 1;
  cookOwner.grenadeTypeQueued = 0;
  cookOwner.grenadeCookQueued = GRENADE_TYPES.frag.fuseMs;
  handEngine.projectiles.step(0.05, handEngine.contexts.projectiles);
  ok(cookOwner.grenades[0] === 1 && cookOwner.hp < 100
    && handEngine.projectiles.active.size === 0
    && handEngine.tickEvents.some((event) => event.kind === 'projectileExplode' && event.type === 'frag'),
  'a frag cooked to the end of its fuse detonates in the hand and hurts the holder');

  const limpetEngine = new GameEngine();
  limpetEngine.addBot('limpet-owner', 'Limpet Owner');
  limpetEngine.addBot('limpet-victim', 'Limpet Victim');
  const limpetOwner = limpetEngine.entities.get('limpet-owner');
  const limpetVictim = limpetEngine.entities.get('limpet-victim');
  for (let y = 18; y <= 26; y++) {
    for (let z = 44; z <= 58; z++) {
      for (let x = 36; x <= 56; x++) limpetEngine.world.setBlock(x, y, z, AIR);
    }
  }
  Object.assign(limpetOwner, { x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0, vx: 0, vy: 0, vz: 0 });
  Object.assign(limpetVictim, { x: 40.5, y: 20, z: 52.5, hp: 100, spawnProtectedUntil: 0, vx: 0, vy: 0, vz: 0 });
  limpetEngine.world.setBlock(42, 21, 50, 1);
  const limpetIndex = GRENADE_TYPE_IDS.indexOf('limpet');
  const limpet = limpetEngine.projectiles.throw(limpetOwner, limpetEngine.contexts.projectiles, 1, limpetIndex);
  limpetOwner.z = 54.5;
  limpetEngine.now += 1000;
  limpetEngine.projectiles.step(0.05, limpetEngine.contexts.projectiles);
  ok(limpet?.stuck && limpetEngine.projectiles.active.size === 1, 'Claymore remains mounted after arming');
  limpetVictim.x = 41.5;
  limpetVictim.z = 50.5;
  limpetEngine.projectiles.step(0.05, limpetEngine.contexts.projectiles);
  const limpetKill = limpetEngine.tickEvents.find((event) => event.kind === 'kill' && event.victim === 'limpet-victim');
  ok(limpetOwner.grenades[limpetIndex] === 0 && limpetEngine.projectiles.active.size === 0
    && limpetKill?.w === 'limpet' && limpetVictim.state === 'dead',
  'a wall-mounted Claymore detonates when an enemy crosses its laser');

  const pulseEngine = new GameEngine();
  pulseEngine.addBot('pulse-owner', 'Pulse Owner');
  pulseEngine.addBot('pulse-victim', 'Pulse Victim');
  const pulseOwner = pulseEngine.entities.get('pulse-owner');
  const pulseVictim = pulseEngine.entities.get('pulse-victim');
  for (let y = 18; y <= 26; y++) {
    for (let z = 44; z <= 58; z++) {
      for (let x = 36; x <= 56; x++) pulseEngine.world.setBlock(x, y, z, AIR);
    }
  }
  pulseEngine.world.setBlock(46, 20, 50, STONE);
  Object.assign(pulseOwner, { x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0 });
  Object.assign(pulseVictim, { x: 44.5, y: 20, z: 50.5, hp: 100, vx: 0, vy: 0, vz: 0, panic: 0 });
  const pulseIndex = GRENADE_TYPE_IDS.indexOf('pulse');
  const pulse = pulseEngine.projectiles.throw(pulseOwner, pulseEngine.contexts.projectiles, 1, pulseIndex);
  Object.assign(pulse, { x: 45.7, y: 20.5, z: 50.5, vx: 14, vy: 0, vz: 0 });
  pulseEngine.now += 300;
  pulseEngine.projectiles.step(0.05, pulseEngine.contexts.projectiles);
  ok(pulseEngine.projectiles.active.size === 0
    && pulseEngine.tickEvents.some((event) => event.kind === 'projectileExplode' && event.type === 'pulse')
    && pulseEngine.world.getBlock(46, 20, 50) === STONE
    && pulseVictim.hp < 100 && pulseVictim.hp > 50
    && Math.hypot(pulseVictim.vx, pulseVictim.vz) > 8
    && pulseVictim.concussedUntil > pulseEngine.now && pulseVictim.panic > 0.3,
  'a pulse shock detonates on impact, spares terrain, and trades damage for knockback plus a concussion');

  const blastCapEngine = new GameEngine();
  blastCapEngine.addBot('cap-owner', 'Cap Owner');
  const capOwner = blastCapEngine.entities.get('cap-owner');
  Object.assign(capOwner, { x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0 });
  for (let y = 18; y <= 35; y++) {
    for (let z = 47; z <= 53; z++) {
      for (let x = 41; x <= 47; x++) blastCapEngine.world.setBlock(x, y, z, GLASS);
    }
    blastCapEngine.world.setBlock(44, y, 50, AIR);
  }
  const capContext = blastCapEngine.contexts.projectiles;
  const capGrenade = blastCapEngine.projectiles.throw(capOwner, capContext);
  const capOrigin = [44.5, 20.5, 50.5];
  Object.assign(capGrenade, { x: capOrigin[0], y: capOrigin[1], z: capOrigin[2] });
  blastCapEngine.projectiles.explode(capGrenade, capContext);
  const blastBlocks = blastCapEngine.tickEvents.filter((event) => event.kind === 'block');
  const blastBlockKeys = new Set(blastBlocks.map((event) => `${event.x},${event.y},${event.z}`));
  ok(blastBlocks.length > 0
    && blastBlocks.length <= PROJECTILE_RULES.frag.maxDestroyedBlocks
    && blastBlockKeys.size === blastBlocks.length
    && blastBlocks.every((event) => Math.hypot(
      event.x + 0.5 - capOrigin[0],
      event.y + 0.5 - capOrigin[1],
      event.z + 0.5 - capOrigin[2],
    ) <= PROJECTILE_RULES.frag.terrainRadius),
  'grenade terrain carving stays unique, inside its radius, and below its hard block cap');

  const chainEngine = new GameEngine();
  chainEngine.addBot('chain-owner', 'Chain Owner');
  const chainOwner = chainEngine.entities.get('chain-owner');
  for (let y = 18; y <= 26; y++) {
    for (let z = 44; z <= 58; z++) {
      for (let x = 36; x <= 56; x++) chainEngine.world.setBlock(x, y, z, AIR);
    }
  }
  Object.assign(chainOwner, { x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0 });
  const chainContext = chainEngine.contexts.projectiles;
  const first = chainEngine.projectiles.throw(chainOwner, chainContext, 1, 0);
  const second = chainEngine.projectiles.throw(chainOwner, chainContext, 1, 0);
  Object.assign(first, { x: 44.5, y: 21, z: 50.5 });
  Object.assign(second, { x: 47.0, y: 21, z: 50.5, explodeAt: chainEngine.now + 5000 });
  chainEngine.projectiles.explode(first, chainContext);
  ok(second.explodeAt === chainEngine.now && second.chained === true,
    'an explosion sympathetically detonates other live explosives inside its blast');

  const ownerEngine = new GameEngine();
  ownerEngine.addBot('owner-bot', 'Owner Bot');
  ownerEngine.addBot('owner-target', 'Owner Target');
  const ownerBot = ownerEngine.entities.get('owner-bot');
  const ownerTarget = ownerEngine.entities.get('owner-target');
  Object.assign(ownerBot, { x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0 });
  Object.assign(ownerTarget, { x: 46.5, y: 20, z: 50.5, hp: 100 });
  for (let y = 18; y <= 24; y++) {
    for (let z = 47; z <= 53; z++) {
      for (let x = 38; x <= 49; x++) ownerEngine.world.setBlock(x, y, z, AIR);
    }
  }
  const ownerContext = ownerEngine.contexts.projectiles;
  const ownedGrenade = ownerEngine.projectiles.throw(ownerBot, ownerContext);
  ownerEngine.takeoverBot('owner-bot', 'owner-human', 'Owner Human');
  Object.assign(ownedGrenade, { x: 45.2, y: 21.1, z: 50.5 });
  ownerEngine.projectiles.explode(ownedGrenade, ownerContext);
  const ownedExplosion = ownerEngine.tickEvents.find((event) => event.kind === 'projectileExplode');
  const ownedHit = ownerEngine.tickEvents.find(
    (event) => event.kind === 'hit' && event.victim === 'owner-target',
  );

  const protectedEngine = new GameEngine();
  protectedEngine.addBot('protected-owner', 'Protected Owner');
  const protectedOwner = protectedEngine.entities.get('protected-owner');
  const protectedContext = protectedEngine.contexts.projectiles;
  const protectedGrenade = protectedEngine.projectiles.throw(protectedOwner, protectedContext);
  protectedEngine.respawnPlayer(
    protectedOwner,
    { x: 44.5, y: 20, z: 50.5, index: 0 },
    { protect: true },
  );
  for (let y = 18; y <= 24; y++) {
    for (let z = 47; z <= 53; z++) {
      for (let x = 41; x <= 47; x++) protectedEngine.world.setBlock(x, y, z, AIR);
    }
  }
  Object.assign(protectedGrenade, { x: 44.5, y: 21, z: 50.5 });
  protectedEngine.projectiles.explode(protectedGrenade, protectedContext);

  const postEngine = new GameEngine();
  postEngine.addBot('post-owner', 'Post Owner');
  postEngine.addBot('post-target', 'Post Target');
  const postOwner = postEngine.entities.get('post-owner');
  const postTarget = postEngine.entities.get('post-target');
  const postContext = postEngine.contexts.projectiles;
  const postGrenade = postEngine.projectiles.throw(postOwner, postContext);
  postEngine.mode.policy.phase = 'post';
  Object.assign(postTarget, { x: 44.5, y: 20, z: 50.5, hp: 100 });
  postEngine.world.setBlock(44, 20, 51, STONE);
  Object.assign(postGrenade, { x: 44.5, y: 21, z: 50.5 });
  const postEventStart = postEngine.tickEvents.length;
  postEngine.projectiles.explode(postGrenade, postContext);
  const postEvents = postEngine.tickEvents.slice(postEventStart);
  ok(ownedGrenade.owner.id === 'owner-human'
    && ownedExplosion?.id === 'owner-human'
    && ownedHit?.attacker === 'owner-human'
    && protectedOwner.hp === 100
    && postTarget.hp === 100
    && postEngine.world.getBlock(44, 20, 51) === STONE
    && postEvents.some((event) => event.kind === 'projectileExplode')
    && !postEvents.some((event) => event.kind === 'hit' || event.kind === 'block'),
  'grenades retain takeover ownership, respect fresh-life protection, and become inert after live play');

  const rocketEngine = new GameEngine();
  rocketEngine.addBot('rocketeer', 'Rocketeer');
  rocketEngine.addBot('rocket-target', 'Rocket Target');
  const rocketeer = rocketEngine.entities.get('rocketeer');
  const rocketTarget = rocketEngine.entities.get('rocket-target');
  for (let y = 18; y <= 28; y++) {
    for (let z = 44; z <= 58; z++) {
      for (let x = 36; x <= 60; x++) rocketEngine.world.setBlock(x, y, z, AIR);
    }
  }
  for (let y = 18; y <= 28; y++) {
    for (let z = 44; z <= 58; z++) rocketEngine.world.setBlock(56, y, z, STONE);
  }
  const rocketSlot = WEAPON_IDS.indexOf('rocket');
  Object.assign(rocketeer, {
    x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0, weapon: rocketSlot, deployT: 0, cooldown: 0,
  });
  Object.assign(rocketTarget, { x: 54.5, y: 20, z: 53.2, hp: 100, vx: 0, vy: 0, vz: 0 });
  fireOneShot(rocketeer, rocketEngine.contexts.combat);
  const rocketLaunchEvent = rocketEngine.tickEvents.find((event) => event.kind === 'projectileLaunch' && event.type === 'rocket');
  const rocketShoot = rocketEngine.tickEvents.find((event) => event.kind === 'shoot' && event.w === 'rocket');
  let rocketTicks = 0;
  while (rocketEngine.projectiles.active.size > 0 && rocketTicks < 60) {
    rocketEngine.now += 50;
    rocketEngine.projectiles.step(0.05, rocketEngine.contexts.projectiles);
    rocketTicks++;
  }
  const rocketBlast = rocketEngine.tickEvents.find((event) => event.kind === 'projectileExplode' && event.type === 'rocket');
  ok(rocketeer.mag[rocketSlot] === 0 && rocketShoot && rocketLaunchEvent
    && rocketLaunchEvent.v[0] > 38 && rocketTicks > 2 && rocketTicks < 20
    && rocketBlast && rocketBlast.x > 52 && rocketBlast.x < 56.5
    && rocketTarget.hp < 100 && Math.hypot(rocketTarget.vx, rocketTarget.vz) > 1.5
    && rocketEngine.tickEvents.some((event) => event.kind === 'kill' && event.w === 'rocket')
      === (rocketTarget.state === 'dead'),
  'a fired rocket is its own authoritative projectile that flies straight, detonates on the far wall, and blasts the bystander');

  const jumpEngine = new GameEngine();
  jumpEngine.addBot('jumper', 'Jumper');
  const jumper = jumpEngine.entities.get('jumper');
  for (let y = 18; y <= 28; y++) {
    for (let z = 44; z <= 58; z++) {
      for (let x = 36; x <= 56; x++) jumpEngine.world.setBlock(x, y, z, AIR);
    }
  }
  for (let z = 47; z <= 54; z++) {
    for (let x = 41; x <= 48; x++) jumpEngine.world.setBlock(x, 19, z, STONE);
  }
  Object.assign(jumper, { x: 44.5, y: 20, z: 50.5, yaw: 0, pitch: -1.4, weapon: rocketSlot, deployT: 0, cooldown: 0, vx: 0, vy: 0, vz: 0 });
  fireOneShot(jumper, jumpEngine.contexts.combat);
  let jumpTicks = 0;
  while (jumpEngine.projectiles.active.size > 0 && jumpTicks < 20) {
    jumpEngine.now += 50;
    jumpEngine.projectiles.step(0.05, jumpEngine.contexts.projectiles);
    jumpTicks++;
  }
  ok(jumper.vy > 8 && jumper.hp < 100 && jumper.hp > 30 && jumper.state === 'alive',
    'a rocket fired at the floor launches its owner upward for a survivable rocket jump');

  const coilEngine = new GameEngine();
  coilEngine.addBot('coil', 'Coil');
  coilEngine.addBot('coil-first', 'Coil First');
  coilEngine.addBot('coil-second', 'Coil Second');
  const coil = coilEngine.entities.get('coil');
  const coilFirst = coilEngine.entities.get('coil-first');
  const coilSecond = coilEngine.entities.get('coil-second');
  for (let y = 18; y <= 28; y++) {
    for (let z = 44; z <= 58; z++) {
      for (let x = 36; x <= 60; x++) coilEngine.world.setBlock(x, y, z, AIR);
    }
  }
  // Bounce arena: indestructible STONE end walls so bolts ricochet between
  // them instead of escaping the carved lane (test lanes sit at z 50.5/54.5
  // so the swept DDA never grazes a cell boundary).
  for (let y = 18; y <= 28; y++) {
    for (let z = 44; z <= 58; z++) {
      coilEngine.world.setBlock(35, y, z, STONE);
      coilEngine.world.setBlock(52, y, z, STONE);
    }
  }
  const longarcSlot = WEAPON_IDS.indexOf('longarc');
  Object.assign(coil, { x: 40.5, y: 20, z: 50.5, yaw: -Math.PI / 2, pitch: 0, weapon: longarcSlot, deployT: 0, cooldown: 0, adsT: 1 });
  Object.assign(coilFirst, { x: 48.5, y: 20, z: 50.5, hp: 100 });
  Object.assign(coilSecond, { x: 48.5, y: 20, z: 54.5, hp: 100 });
  const coilInput = {
    keys: { f: false, b: false, l: false, r: false, jump: false, sprint: false, crouch: false },
    yaw: -Math.PI / 2, pitch: 0, weapon: longarcSlot, wantAds: false, reload: false, viewAge: 100,
  };
  coilEngine.applyInput('coil', { ...coilInput, seq: 1, wantFire: true });
  for (let i = 0; i < 4; i++) resolveWeaponIntent(coil, 0.05, coilEngine.contexts.combat);
  const midCharge = coil.charge;
  coilEngine.applyInput('coil', { ...coilInput, seq: 2, wantFire: false });
  resolveWeaponIntent(coil, 0.05, coilEngine.contexts.combat);
  const coilTapShot = coilEngine.tickEvents.find((event) => event.kind === 'shoot' && event.w === 'longarc');
  const coilTapLaunch = coilEngine.tickEvents.find(
    (event) => event.kind === 'projectileLaunch' && event.type === 'bolt');
  let tapBoltTicks = 0;
  while (coilEngine.projectiles.active.size > 0 && tapBoltTicks < 60) {
    coilEngine.now += 50;
    coilEngine.projectiles.step(0.05, coilEngine.contexts.projectiles);
    tapBoltTicks++;
  }
  const coilTapHit = coilEngine.tickEvents.find((event) => event.kind === 'hit' && event.victim === 'coil-first');
  const tapFizzle = coilEngine.tickEvents.find(
    (event) => event.kind === 'projectileExplode' && event.type === 'bolt');
  ok(midCharge === 0 && coilTapShot && coilTapShot.charge === undefined
    && coilTapLaunch && coilTapLaunch.bn === boltBounces(midCharge)
    && coilTapLaunch.bn === BOLT_RULES.bouncesTap
    && coilTapLaunch.fuse === BOLT_RULES.lifetimeMs && coilTapLaunch.v[0] > 45
    && coilTapHit && coilTapHit.dmg > 0 && coilTapHit.dmg === Math.round(combatDamage(WEAPONS.longarc.damage[0]))
    && tapFizzle && tapFizzle.radius === 0.5 && Math.abs(tapFizzle.x - 48.5) < 1
    && !coilEngine.tickEvents.some((event) => event.kind === 'arc'),
  'a short LONGARC trigger tap launches a one-bounce bolt (bn 1) that lands full damage and fizzles in a small pop at the victim with no arc events');

  coilEngine.tickEvents.length = 0;
  Object.assign(coil, { cooldown: 0, triggerPrev: false, adsT: 1, bloom: 0 });
  Object.assign(coilFirst, { hp: 100 });
  coilEngine.applyInput('coil', { ...coilInput, seq: 3, wantFire: true });
  for (let i = 0; i < 40; i++) resolveWeaponIntent(coil, 0.05, coilEngine.contexts.combat);
  const fullCharge = coil.charge;
  coilEngine.applyInput('coil', { ...coilInput, seq: 4, wantFire: false });
  resolveWeaponIntent(coil, 0.05, coilEngine.contexts.combat);
  const fullShot = coilEngine.tickEvents.find((event) => event.kind === 'shoot' && event.w === 'longarc');
  const fullLaunch = coilEngine.tickEvents.find(
    (event) => event.kind === 'projectileLaunch' && event.type === 'bolt');
  let fullBoltTicks = 0;
  while (coilEngine.projectiles.active.size > 0 && fullBoltTicks < 60) {
    coilEngine.now += 50;
    coilEngine.projectiles.step(0.05, coilEngine.contexts.projectiles);
    fullBoltTicks++;
  }
  const fullHit = coilEngine.tickEvents.find((event) => event.kind === 'hit' && event.victim === 'coil-first');
  ok(fullCharge === 0 && fullShot && fullShot.charge === undefined && fullLaunch?.bn === boltBounces(1)
    && fullHit && fullHit.dmg === Math.round(combatDamage(WEAPONS.longarc.damage[0]))
    && Math.abs(coilFirst.hp - (100 - combatDamage(WEAPONS.longarc.damage[0]))) < 0.2,
  'holding LONGARC launches a one-bounce bolt that lands its 70.4 damage on a direct body hit');

  // Ricochet exhaustion: with both victims parked off the flight line, a full
  // charge (bn 3) bounces between the two end walls, ignores its owner, and
  // fizzles harmlessly once the reflections run out.
  coilEngine.tickEvents.length = 0;
  Object.assign(coil, { cooldown: 0, triggerPrev: false, adsT: 1, bloom: 0 });
  Object.assign(coilFirst, { x: 44.5, y: 20, z: 46.5, hp: 100, vx: 0, vy: 0, vz: 0 });
  Object.assign(coilSecond, { x: 48.5, y: 20, z: 54.5, hp: 100, vx: 0, vy: 0, vz: 0 });
  coilEngine.applyInput('coil', { ...coilInput, seq: 5, wantFire: true });
  for (let i = 0; i < 40; i++) resolveWeaponIntent(coil, 0.05, coilEngine.contexts.combat);
  coilEngine.applyInput('coil', { ...coilInput, seq: 6, wantFire: false });
  resolveWeaponIntent(coil, 0.05, coilEngine.contexts.combat);
  const ricochetLaunch = coilEngine.tickEvents.find(
    (event) => event.kind === 'projectileLaunch' && event.type === 'bolt');
  let ricochetTicks = 0;
  while (coilEngine.projectiles.active.size > 0 && ricochetTicks < 80) {
    coilEngine.now += 50;
    coilEngine.projectiles.step(0.05, coilEngine.contexts.projectiles);
    ricochetTicks++;
  }
  const ricochetFizzle = coilEngine.tickEvents.find(
    (event) => event.kind === 'projectileExplode' && event.type === 'bolt');
  ok(ricochetLaunch?.bn === BOLT_RULES.bouncesCharged && ricochetTicks > 2 && ricochetTicks < 80
    && ricochetFizzle && ricochetFizzle.radius === 0.5
    && ricochetFizzle.x > 35 && ricochetFizzle.x < 38
    && coil.hp === 100 && coilFirst.hp === 100 && coilSecond.hp === 100
    && !coilEngine.tickEvents.some((event) => event.kind === 'hit' || event.kind === 'kill'),
  'a full-charge bolt with no targets ricochets between both end walls, never hurts its owner, and fizzles harmlessly once its one reflection runs out');

  coilEngine.tickEvents.length = 0;
  Object.assign(coil, { cooldown: 0, triggerPrev: false });
  coilEngine.applyInput('coil', { ...coilInput, seq: 7, wantFire: true });
  let ventShots = 0;
  for (let i = 0; i < 60; i++) {
    resolveWeaponIntent(coil, 0.05, coilEngine.contexts.combat);
    ventShots = coilEngine.tickEvents.filter((event) => event.kind === 'shoot').length;
    if (ventShots) break;
  }
  ok(ventShots === 1 && !coil.charging,
    'holding the LONGARC trigger past the vent time fires the shot on its own');

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

  const spareMagsBeforeReload = firing.reserve[lmgSlot];
  fireEngine.applyInput('cadence', {
    ...tapInput, seq: 2, weapon: lmgSlot, wantFire: false, reload: true,
  });
  fireEngine.step(TICK_MS);
  const reloadStartedRow = snapshots.at(-1)?.players.find((row) => row.id === 'cadence');
  const reloadDiscardedPartialMag = reloadStartedRow?.reloading === true
    && reloadStartedRow.mag[lmgSlot] === 0
    && reloadStartedRow.reserve[lmgSlot] === spareMagsBeforeReload;
  for (let i = 0; i < Math.ceil(lmg.reloadTime * 1000 / TICK_MS) + 2; i++) {
    fireEngine.step(TICK_MS);
  }
  const reloadedRow = snapshots.at(-1)?.players.find((row) => row.id === 'cadence');
  ok(reloadDiscardedPartialMag
    && reloadedRow?.mag[lmgSlot] === lmg.magSize
    && reloadedRow.reserve[lmgSlot] === spareMagsBeforeReload - 1,
  'reload discards the partial magazine then consumes exactly one full spare magazine');

  // Tube reload: shells seat one at a time, the chambered shells stay usable, and a
  // trigger pull interrupts the load keeping every seated shell.
  {
    const shotgunSlot = WEAPON_IDS.indexOf('shotgun');
    const shotgun = WEAPONS.shotgun;
    const stages = shotgun.reloadStages;
    fireEngine.applyInput('cadence', {
      ...tapInput, seq: 3, pitch: 1.2, weapon: shotgunSlot, wantFire: false, reload: false,
    });
    for (let i = 0; i < Math.ceil(weaponSwapProfile(shotgun).total * 1000 / TICK_MS) + 2; i++) {
      fireEngine.step(TICK_MS);
    }
    firing.mag[shotgunSlot] = 2;
    const sparesBefore = firing.reserve[shotgunSlot];
    fireEngine.applyInput('cadence', {
      ...tapInput, seq: 4, pitch: 1.2, weapon: shotgunSlot, wantFire: false, reload: true,
    });
    fireEngine.step(TICK_MS);
    const tubeStarted = firing.reloading === true && firing.mag[shotgunSlot] === 2
      && firing.reserve[shotgunSlot] === sparesBefore;
    const ticksToSecondShell = Math.ceil((stages.start + stages.perRound * 2 + 0.02) * 1000 / TICK_MS);
    for (let i = 0; i < ticksToSecondShell; i++) fireEngine.step(TICK_MS);
    const twoSeated = firing.reloading === true && firing.mag[shotgunSlot] === 4
      && firing.reserve[shotgunSlot] === sparesBefore - 2;
    fireEngine.applyInput('cadence', {
      ...tapInput, seq: 5, pitch: 1.2, weapon: shotgunSlot, wantFire: true, reload: false,
    });
    fireEngine.step(TICK_MS);
    const interrupted = firing.reloading === false && firing.mag[shotgunSlot] === 3;
    ok(tubeStarted && twoSeated && interrupted,
      'tube reload seats shells one at a time and a shot interrupts it keeping seated shells');

    fireEngine.applyInput('cadence', {
      ...tapInput, seq: 6, pitch: 1.2, weapon: shotgunSlot, wantFire: false, reload: false,
    });
    for (let i = 0; i < 40; i++) fireEngine.step(TICK_MS);
    const sparesBeforeFull = firing.reserve[shotgunSlot];
    fireEngine.applyInput('cadence', {
      ...tapInput, seq: 7, pitch: 1.2, weapon: shotgunSlot, wantFire: false, reload: true,
    });
    const missing = shotgun.magSize - firing.mag[shotgunSlot];
    const fullTicks = Math.ceil((stages.start + stages.perRound * missing + stages.end + 0.05)
      * 1000 / TICK_MS);
    for (let i = 0; i < fullTicks; i++) fireEngine.step(TICK_MS);
    ok(firing.reloading === false && firing.mag[shotgunSlot] === shotgun.magSize
      && firing.reserve[shotgunSlot] === sparesBeforeFull - missing,
    'an uninterrupted tube reload consumes exactly the number of inserted shells');
  }

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
    'authoritative slot selection clamps dynamically across all eight weapons');

  const botEngine = new GameEngine();
  const botManager = attachBots(botEngine, WEAPON_IDS.length);
  ok([...botEngine.entities.values()].every((player) => player.weapon === 0),
    'bots start on the default slot before authoritative loadout selection');
  // Isolate spawn loadouts from combat's empty-magazine weapon cycling.
  botEngine.mode.canFire = () => false;
  botEngine.step(TICK_MS);
  const botSlots = [...botEngine.entities.values()].map((player) => player.weapon).sort((a, b) => a - b);
  ok(botSlots.length === WEAPON_IDS.length
    && JSON.stringify(botSlots) === JSON.stringify(WEAPON_IDS.map((_, i) => i)),
    'authoritative bots deploy across distinct roster slots');
  botManager.dispose();

  const conditionSnapshots = [];
  const conditionEngine = new GameEngine({
    broadcast: (msg) => conditionSnapshots.push(msg),
  });
  conditionEngine.addBot('condition-shooter', 'Condition Shooter');
  conditionEngine.addBot('condition-target', 'Condition Target');
  const conditionShooter = conditionEngine.entities.get('condition-shooter');
  const conditionTarget = conditionEngine.entities.get('condition-target');

  Object.assign(conditionTarget, { hp: 100, panic: 0.1, pain: 0.1, state: 'alive' });
  const bodyLethal = conditionTarget.takeDamage(10, false);
  const bodyPanic = conditionTarget.panic;
  const bodyPain = conditionTarget.pain;
  Object.assign(conditionTarget, { hp: 100, panic: 0.1, pain: 0.1, state: 'alive' });
  const headLethal = conditionTarget.takeDamage(10, true);
  ok(!bodyLethal && !headLethal
    && conditionTarget.hp === 90
    && nearly(bodyPanic, 0.1 + 10 * CONDITION_RULES.panicDamageGain)
    && nearly(conditionTarget.panic, 0.1 + 10 * CONDITION_RULES.panicDamageGain
      + CONDITION_RULES.panicHeadshotGain)
    && nearly(bodyPain, 0.1 + 10 * CONDITION_RULES.painDamageGain)
    && nearly(conditionTarget.pain, 0.1 + 10 * CONDITION_RULES.painDamageGain
      + CONDITION_RULES.painHeadshotGain),
  'body damage and headshots apply their exact deterministic panic and pain gains');

  Object.assign(conditionTarget, {
    hp: 100, panic: 0.8, pain: 0.8, exhaustion: 0, sprint: false, state: 'alive',
  });
  updateCondition(conditionTarget, 0.5);
  const decayedPanic = conditionTarget.panic;
  const decayedPain = conditionTarget.pain;
  Object.assign(conditionTarget, {
    hp: 25, panic: 0.1, pain: 0.1, exhaustion: 0, sprint: false,
  });
  updateCondition(conditionTarget, 2);
  ok(nearly(decayedPanic, 0.8 - CONDITION_RULES.panicDecayPerS * 0.5)
    && nearly(decayedPain, 0.8 * 2 ** (-0.5 / CONDITION_RULES.painHalfLifeS))
    && nearly(conditionTarget.panic, 0.75 * CONDITION_RULES.panicLowHpFloor)
    && nearly(conditionTarget.pain, 0.095),
  'panic decays linearly and excess pain halves in two seconds without crossing its injury floor');

  Object.assign(conditionTarget, {
    hp: 100, panic: 0.99, pain: 0.99, exhaustion: 0.99, sprint: true, state: 'alive',
  });
  conditionTarget.takeDamage(10, true);
  const upperPanic = conditionTarget.panic;
  const upperPain = conditionTarget.pain;
  updateCondition(conditionTarget, 1);
  const upperExhaustion = conditionTarget.exhaustion;
  Object.assign(conditionTarget, {
    hp: 100, panic: 0.01, pain: 0.01, exhaustion: 0.01, sprint: false, state: 'alive',
  });
  updateCondition(conditionTarget, 1);
  ok(upperPanic === 1 && upperPain === 1 && upperExhaustion === 1
    && conditionTarget.panic === 0 && nearly(conditionTarget.pain, 0.01 * Math.SQRT1_2)
    && conditionTarget.exhaustion === 0,
  'conditions stay normalized while pain retains its exponential recovery tail');

  Object.assign(conditionShooter, {
    x: 60, y: 70, z: 60, yaw: 0, pitch: 0.04, weapon: 0,
    deployT: 0, adsT: 1, bloom: 0, vx: 0, vz: 0,
    panic: 0, pain: 0, exhaustion: 0,
  });
  Object.assign(conditionTarget, {
    x: 60, y: 70, z: 55, hp: 100, panic: 0, exhaustion: 0,
    state: 'alive', hist: [],
  });
  let conditionSpreadExhaustion = null;
  const computeConditionCone = computeConeDeg;
  conditionEngine.contexts.combat.computeConeDeg = (player) => {
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
  const computeEvolutionCone = computeConeDeg;
  evolutionEngine.contexts.combat.computeConeDeg = (player) => {
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
  const deadRespawnRow = respawnSnapshots.at(-1)?.players.find(
    (row) => row.id === 'timed-respawn'
  );
  const noEarlyRespawn = respawning.state === 'dead'
    && deadRespawnRow?.state === 'dead'
    && deadRespawnRow.respawnAt === respawnDueAt
    && respawnSnapshots.every((tick) =>
      !tick.events.some((event) => event.kind === 'respawn' && event.id === 'timed-respawn'));
  respawnEngine.step(TICK_MS);
  const respawnSnapshot = respawnSnapshots.at(-1);
  const respawnEvent = respawnSnapshot?.events.find(
    (event) => event.kind === 'respawn' && event.id === 'timed-respawn'
  );
  const respawnRow = respawnSnapshot?.players.find((row) => row.id === 'timed-respawn');
  const freshMags = WEAPON_IDS.map((id) => WEAPONS[id].magSize);
  const freshReserve = WEAPON_IDS.map((id) => (WEAPONS[id].spareRounds ?? WEAPONS[id].spareMags));
  ok(noEarlyRespawn
    && respawnEvent
    && respawnSnapshot.now >= respawnDueAt
    && respawnSnapshot.now - respawnDueAt < TICK_MS
    && respawnRow?.state === 'alive'
    && respawnRow.respawnAt === null
    && respawnRow.weapon === revolverSlot
    && JSON.stringify(respawnRow.mag) === JSON.stringify(freshMags)
    && JSON.stringify(respawnRow.reserve) === JSON.stringify(freshReserve)
    && respawnRow.panic === 0
    && respawnRow.exhaustion === 0,
  'timed respawn publishes its deadline and event, retains the selected weapon, and refills ammunition');
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
  'Fun snapshot exposes the full eight-weapon loadout and exact unteamed match fields');
  fun.engine.addBot('fun-attacker', 'Fun Attacker');
  const funAttacker = fun.engine.entities.get('fun-attacker');

  fun.engine.killPlayer(funPlayer, null, 'world', false);
  const funDeathAt = fun.engine.now;
  const funDueAt = funPlayer.respawnAt;
  const funEarlyTick = stepModeAt(fun, funDeathAt + 1499);
  const funDueTick = stepModeAt(fun, funDeathAt + 1500);
  const funDueRow = playerRow(funDueTick, 'fun-player');
  const funProtectionUntil = funPlayer.spawnProtectedUntil;
  ok(funDueAt - funDeathAt === 1500
    && playerRow(funEarlyTick, 'fun-player')?.state === 'dead'
    && !funEarlyTick.events.some((event) => event.kind === 'respawn')
    && funDueRow?.state === 'alive'
    && funDueRow.spawnProtected === true
    && funProtectionUntil - funDueTick.now === 1500
    && funDueTick.events.filter(
      (event) => event.kind === 'respawn' && event.id === 'fun-player'
    ).length === 1
    && exact(funDueRow.owned, WEAPON_IDS)
    && exact(funDueRow.mag, freshMags)
    && exact(funDueRow.reserve, freshReserve),
  'Fun respawns once at exactly 1500ms with a fresh full loadout');

  Object.assign(funAttacker, {
    x: 60, y: 70, z: 60, yaw: 0, pitch: 0.04, weapon: 0,
    deployT: 0, cooldown: 0, adsT: 1, bloom: 0, vx: 0, vz: 0,
  });
  Object.assign(funPlayer, {
    x: 60, y: 70, z: 55, hp: 100, state: 'alive', hist: [],
  });
  fun.engine.applyInput('fun-attacker', {
    ...tapInput, seq: 1, yaw: 0, pitch: 0.04, weapon: 0, wantFire: true,
  });
  fun.engine.applyInput('fun-attacker', {
    ...tapInput, seq: 2, yaw: 0, pitch: 0.04, weapon: 0, wantFire: false,
  });
  fun.engine.step(0);
  const funProtectedShotTick = fun.ticks.at(-1);
  ok(funProtectedShotTick.events.some(
    (event) => event.kind === 'shoot' && event.id === 'fun-attacker'
  )
    && !funProtectedShotTick.events.some(
      (event) => event.kind === 'hit' && event.victim === 'fun-player'
    )
    && funProtectedShotTick.now === funDueTick.now
    && funProtectionUntil - funProtectedShotTick.now === 1500
    && playerRow(funProtectedShotTick, 'fun-player')?.spawnProtected === true
    && funPlayer.hp === 100,
  'Fun timed-respawn protection blocks an authoritative incoming shot without hiding the shot');

  const funBeforeProtectionExpiry = stepModeAt(fun, funProtectionUntil - 1);
  const funAtProtectionExpiry = stepModeAt(fun, funProtectionUntil);
  ok(playerRow(funBeforeProtectionExpiry, 'fun-player')?.spawnProtected === true
    && playerRow(funAtProtectionExpiry, 'fun-player')?.spawnProtected === false
    && funAtProtectionExpiry.now - funDueTick.now === 1500,
  'Fun timed-respawn protection remains through 1499ms and expires at exactly 1500ms');

  funAttacker.cooldown = 0;
  funAttacker.bloom = 0;
  fun.engine.applyInput('fun-attacker', {
    ...tapInput, seq: 3, yaw: 0, pitch: 0.04, weapon: 0, wantFire: true,
  });
  fun.engine.applyInput('fun-attacker', {
    ...tapInput, seq: 4, yaw: 0, pitch: 0.04, weapon: 0, wantFire: false,
  });
  fun.engine.step(0);
  const funExpiredShotTick = fun.ticks.at(-1);
  const funExpiredHit = funExpiredShotTick.events.find(
    (event) => event.kind === 'hit' && event.victim === 'fun-player'
  );
  ok(funExpiredShotTick.events.some(
    (event) => event.kind === 'shoot' && event.id === 'fun-attacker'
  )
    && funExpiredHit?.dmg === Math.round(100 - funPlayer.hp)
    && funPlayer.hp < 100,
  'enemy damage applies through the authoritative fire path at the exact protection boundary');

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
  const tdmTarget = nearestVictim(
    tdmShooter,
    [60, 71.62, 60],
    { x: 0, y: 0, z: -1 },
    20, tdm.engine.contexts.combat);
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
  const tdmProtectionUntil = tdmEnemy.spawnProtectedUntil;
  ok(tdmFirstScore.scores.alpha === 1
    && tdmFirstScore.scores.bravo === 0
    && tdmShooter.score === 1
    && tdmShooter.kills === 1
    && tdmRespawnAt - tdmKillAt === 3000
    && playerRow(tdmEarlyRespawn, 'tdm-b1')?.state === 'dead'
    && !tdmEarlyRespawn.events.some((event) => event.kind === 'respawn')
    && playerRow(tdmExactRespawn, 'tdm-b1')?.state === 'alive'
    && playerRow(tdmExactRespawn, 'tdm-b1')?.spawnProtected === true
    && tdmProtectionUntil - tdmExactRespawn.now === 1500
    && tdmExactRespawn.events.filter(
      (event) => event.kind === 'respawn' && event.id === 'tdm-b1'
    ).length === 1,
  'one TDM enemy death awards exactly one team point and respawns once at exactly 3000ms');

  Object.assign(tdmEnemy, {
    x: 60, y: 70, z: 55, yaw: 0, pitch: 1.2, weapon: 0,
    deployT: 0, cooldown: 0, adsT: 1, bloom: 0, vx: 0, vz: 0, hp: 100, hist: [],
  });
  Object.assign(tdmShooter, {
    x: 60, y: 70, z: 60, yaw: 0, pitch: 0.04, weapon: 0,
    deployT: 0, cooldown: 0, adsT: 1, bloom: 0, vx: 0, vz: 0,
  });
  tdm.engine.applyInput('tdm-b1', {
    ...tapInput, seq: 1, yaw: 0, pitch: 1.2, weapon: 0, wantFire: true,
  });
  tdm.engine.applyInput('tdm-b1', {
    ...tapInput, seq: 2, yaw: 0, pitch: 1.2, weapon: 0, wantFire: false,
  });
  tdm.engine.step(0);
  const tdmProtectionClearTick = tdm.ticks.at(-1);
  ok(tdm.engine.now < tdmProtectionUntil
    && tdm.engine.now === tdmExactRespawn.now
    && tdmProtectionClearTick.events.some(
      (event) => event.kind === 'shoot' && event.id === 'tdm-b1'
    )
    && tdmEnemy.spawnProtectedUntil === 0
    && playerRow(tdmProtectionClearTick, 'tdm-b1')?.spawnProtected === false,
  'an accepted TDM shot immediately clears timed-respawn protection before its deadline');

  tdm.engine.applyInput('tdm-a1', {
    ...tapInput, seq: 1, yaw: 0, pitch: 0.04, weapon: 0, wantFire: true,
  });
  tdm.engine.applyInput('tdm-a1', {
    ...tapInput, seq: 2, yaw: 0, pitch: 0.04, weapon: 0, wantFire: false,
  });
  tdm.engine.step(0);
  const tdmClearedProtectionTick = tdm.ticks.at(-1);
  const tdmClearedProtectionHit = tdmClearedProtectionTick.events.find(
    (event) => event.kind === 'hit' && event.victim === 'tdm-b1'
  );
  ok(tdm.engine.now < tdmProtectionUntil
    && tdm.engine.now === tdmExactRespawn.now
    && tdmClearedProtectionHit?.attacker === 'tdm-a1'
    && tdmClearedProtectionHit.dmg === Math.round(100 - tdmEnemy.hp)
    && tdmEnemy.hp < 100,
  'enemy damage applies through the authoritative fire path immediately after protection is cleared');

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
    (id) => id === 'revolver' ? (WEAPONS[id].spareRounds ?? WEAPONS[id].spareMags) : 0
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

  const sndFrozenAt = { x: sndCarrier.x, y: sndCarrier.y, z: sndCarrier.z };
  sndClock.engine.applyInput(sndCarrierId, {
    ...tapInput,
    seq: 3,
    yaw: 0.75,
    wantFire: false,
    keys: { ...tapInput.keys, f: true, jump: true, sprint: true, crouch: true },
  });
  sndClock.engine.step(TICK_MS);
  ok(sndCarrier.x === sndFrozenAt.x
    && sndCarrier.y === sndFrozenAt.y
    && sndCarrier.z === sndFrozenAt.z
    && sndCarrier.vx === 0 && sndCarrier.vy === 0 && sndCarrier.vz === 0
    && sndCarrier.crouch === false && sndCarrier.sprint === false
    && sndCarrier.yaw === 0.75
    && sndClock.engine.mode.canMove(sndCarrier) === false,
  'S&D prep freezes authoritative translation and stance while still allowing aim');

  const sndCombatTicks = [];
  const sndCombat = new GameEngine({
    mode: 'snd',
    mapMeta: getMapMeta('citadel'),
    broadcast: (tick) => sndCombatTicks.push(tick),
  });
  sndCombat.addBot('snd-combat-attacker', 'SND Combat Attacker');
  sndCombat.addBot('snd-combat-defender', 'SND Combat Defender');
  sndCombat.step(0);
  const sndCombatAttacker = Array.from(sndCombat.entities.values()).find(
    (player) => sndCombat.mode.roleFor(player) === 'attackers'
  );
  const sndCombatDefender = Array.from(sndCombat.entities.values()).find(
    (player) => sndCombat.mode.roleFor(player) === 'defenders'
  );
  const stageSndCombat = () => {
    const x = 60.5;
    const attackerZ = 76.5;
    const defenderZ = 73.5;
    const y = sndCombat.world.heightAt(x, attackerZ) + 1.02;
    Object.assign(sndCombatAttacker, {
      x, y, z: attackerZ, yaw: 0, pitch: -0.18, weapon: revolverSlot,
      deployT: 0, cooldown: 0, bloom: 0, adsT: 1,
      panic: 0, pain: 0, exhaustion: 0,
      triggerPrev: false, fireEdgeQueued: false,
    });
    Object.assign(sndCombatDefender, {
      x, y, z: defenderZ, hp: 100, state: 'alive', hist: [],
      spawnProtectedUntil: 0, spawnProtected: false,
    });
    return raycastVoxels(
      sndCombat.solidAt,
      sndCombatAttacker.x,
      sndCombatAttacker.eyeY,
      sndCombatAttacker.z,
      0,
      0,
      -1,
      attackerZ - defenderZ,
    ) === null;
  };
  const sndPrepLaneClear = stageSndCombat();
  const sndCombatPrepHp = sndCombatDefender.hp;
  const sndCombatPrepMag = sndCombatAttacker.mag[revolverSlot];
  sndCombat.applyInput(sndCombatAttacker.id, {
    ...tapInput, seq: 1, yaw: 0, pitch: -0.18,
    weapon: revolverSlot, wantAds: true, wantFire: true,
  });
  sndCombat.applyInput(sndCombatAttacker.id, {
    ...tapInput, seq: 2, yaw: 0, pitch: -0.18,
    weapon: revolverSlot, wantAds: true, wantFire: false,
  });
  sndCombat.step(0);
  const sndCombatPrepTick = sndCombatTicks.at(-1);
  const sndCombatAfterPrepHp = sndCombatDefender.hp;
  const sndCombatAfterPrepMag = sndCombatAttacker.mag[revolverSlot];
  const sndCombatLiveAt = sndCombat.mode.matchSnapshot().phaseEndsAt;
  sndCombat.now = sndCombatLiveAt;
  sndCombat.step(0);
  const sndLiveLaneClear = stageSndCombat();
  const sndCombatLiveHp = sndCombatDefender.hp;
  sndCombat.applyInput(sndCombatAttacker.id, {
    ...tapInput, seq: 3, yaw: 0, pitch: -0.18,
    weapon: revolverSlot, wantAds: true, wantFire: true,
  });
  sndCombat.applyInput(sndCombatAttacker.id, {
    ...tapInput, seq: 4, yaw: 0, pitch: -0.18,
    weapon: revolverSlot, wantAds: true, wantFire: false,
  });
  sndCombat.step(0);
  const sndCombatLiveTick = sndCombatTicks.at(-1);
  const sndCombatShot = sndCombatLiveTick.events.find(
    (event) => event.kind === 'shoot' && event.id === sndCombatAttacker.id
  );
  const sndCombatHit = sndCombatLiveTick.events.find(
    (event) => event.kind === 'hit'
      && event.attacker === sndCombatAttacker.id
      && event.victim === sndCombatDefender.id
  );
  const sndCombatDamage = sndCombatLiveHp - sndCombatDefender.hp;
  ok(sndCombat.mode.matchSnapshot().map === 'citadel'
    && sndPrepLaneClear
    && sndLiveLaneClear
    && sndCombatPrepTick.match.phase === 'prep'
    && sndCombatDefender.hp < sndCombatLiveHp
    && sndCombatAfterPrepHp === sndCombatPrepHp
    && sndCombatAfterPrepMag === sndCombatPrepMag
    && !sndCombatPrepTick.events.some(
      (event) => event.kind === 'shoot' || event.kind === 'hit'
    )
    && sndCombatLiveTick.match.phase === 'live'
    && sndCombatShot?.w === 'revolver'
    && sndCombatHit?.dmg === Math.round(sndCombatDamage)
    && sndCombatDamage > 0,
  'S&D prep is damage-immune while live enemy fire deals authoritative damage in clear Citadel geometry');

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
    && sndBoughtRow.reserve[WEAPON_IDS.indexOf('rifle')] === WEAPONS.rifle.spareMags
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
  const pickupPlayer = Array.from(sndObjective.engine.entities.values()).find(
    (player) =>
      player.id !== droppedCarrierId
        && sndObjective.engine.mode.roleFor(player) === 'attackers'
  );
  const objectiveDefender = Array.from(sndObjective.engine.entities.values()).find(
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
    && Array.from(sndObjective.engine.entities.values())
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
  const priorityDefender = Array.from(sndPriority.engine.entities.values()).find(
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

  const outside = await mkdtemp(fileURLToPath(new URL('../.static-test-', import.meta.url)));
  try {
    await writeFile(path.join(outside, 'index.html'), 'PRIVATE INDEX SENTINEL');
    const blockedTargets = [
      '/%ZZ/server/index.js',
      '/../server/index.js',
      '/%2e%2e/server/index.js',
      '/%252e%252e/server/index.js',
      `/../${path.basename(outside)}/`,
      `/%2e%2e/${path.basename(outside)}/`,
      `/%252e%252e/${path.basename(outside)}/`,
      `/%252e%252e%252f${path.basename(outside)}%252f`,
    ];
    const blockedResponses = await Promise.all(
      blockedTargets.map((target) => fetchRawBytes(port, target))
    );
    ok(blockedResponses.every((response) => response.status < 200 || response.status >= 300)
      && blockedResponses.every((response) => !response.body.includes(Buffer.from('voxel-blitz listening on'))
        && !response.body.includes(Buffer.from('PRIVATE INDEX SENTINEL'))),
    'malformed encoding and plain or encoded traversal are rejected without source disclosure');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }

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

  const pingMark = a.mark();
  a.send({ t: 'ping', nonce: 918273 });
  const pong = await a.waitForJson(
    (message) => message?.t === 'pong' && message.nonce === 918273,
    'application pong',
    pingMark,
  );
  ok(pong.nonce === 918273, 'server echoes the exact application ping nonce for measured RTT');

  const movementTickStart = a.ticks.length;
  const movementHeadings = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  for (let s = 0; s < 150; s++) {
    // Sample every cardinal direction so a spawn-facing wall cannot trap the test.
    const yaw = movementHeadings[Math.floor(s * movementHeadings.length / 150)];
    a.input(s, { forward: true, fire: true, yaw });
    b.input(s, { fire: true, yaw: Math.PI / 4 });
    await delay(22);
  }

  ok(a.ticks.length >= 40, `snapshots flowing (${a.ticks.length})`);
  const lastTick = a.ticks.at(-1);
  ok(lastTick?.players.length >= 2, 'snapshot carries both players');
  const me = lastTick?.players.find((p) => p.id === a.id);
  ok(me && Number.isFinite(me.x) && Number.isFinite(me.y), 'own row has finite position');
  ok(Number.isFinite(me?.ping) && me.ping >= 0, 'scoreboard row carries server-measured WebSocket RTT');
  ok(me && typeof me.hp === 'number' && me.hp >= 0 && me.hp <= 100, 'hp sane');
  ok(me && Array.isArray(me.mag) && me.mag.length === WEAPON_IDS.length
    && me.mag.every(Number.isFinite)
    && Array.isArray(me.reserve) && me.reserve.length === WEAPON_IDS.length
    && me.reserve.every(Number.isFinite)
    && typeof me.reloading === 'boolean'
    && Number.isFinite(me.panic) && me.panic >= 0 && me.panic <= 1
    && Number.isFinite(me.exhaustion) && me.exhaustion >= 0 && me.exhaustion <= 1
    && Array.isArray(me.grenades) && me.grenades.length === GRENADE_TYPE_IDS.length
    && me.grenades.every((count) => Number.isInteger(count) && count >= 0)
    && Number.isFinite(me.charge) && me.charge >= 0 && me.charge <= 1,
  'wire snapshot carries dynamic ammo, reload, per-type grenade, charge, and normalized hidden-condition state');

  const shoot = a.events.find((e) => e.kind === 'shoot');
  ok(shoot, 'shoot events broadcast inside snapshots');
  ok(shoot && vectorNorm(shoot.d) > 0.9 && vectorNorm(shoot.spread) > 0.9,
    'wire shoot event vectors are nonzero');
  const totalKillEvs = [...a.events, ...b.events].filter((e) => e.kind === 'kill').length;
  const blockEvents = a.events.filter((e) => e.kind === 'block').length;
  console.log(`  info - kills=${totalKillEvs} brokenBlocks=${blockEvents}`);

  let lifeOrigin = null, movedDist = 0;
  for (const tick of a.ticks.slice(movementTickStart)) {
    const row = tick.players.find((p) => p.id === a.id);
    if (!row || row.state !== 'alive') { lifeOrigin = null; continue; }
    const respawned = tick.events.some((event) => event.kind === 'respawn' && event.id === a.id);
    // A death count change also catches a life transition between snapshots.
    // Never count the respawn teleport itself as evidence of movement.
    if (!lifeOrigin || respawned || row.deaths !== lifeOrigin.deaths) {
      lifeOrigin = row;
      continue;
    }
    movedDist = Math.max(movedDist, Math.hypot(row.x - lifeOrigin.x, row.z - lifeOrigin.z));
  }
  ok(movedDist > 0.5, `raw f input integrates movement within one life (${movedDist.toFixed(2)}u)`);
}

async function main() {
  runDirectContracts();
  console.log('smoke: booting server…');
  const server = startServer();
  const clients = [];
  try {
    await Promise.race([runNetwork(server, clients), server.unexpectedExit]);
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
