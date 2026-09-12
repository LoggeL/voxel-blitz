import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { WEAPONS, WEAPON_IDS, computeRecoilKickDeg } from '../shared/combatmath.js';
import { HANDLING_EXTREMES, HANDLING_LIMITS, WEAPON_HANDLING_PROFILES,
  normalizeWeaponHandling, withWeaponHandling, weaponTurnProfile, sampleWeaponSway } from '../shared/weapon-handling.js';
import { WeaponTurnInertia } from '../shared/weapon-turn.js';
import { WeaponAimMotion } from '../public/js/guns/weapon-aim.js';
import { AimSway } from '../public/js/player/aim-sway.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { GameEngine } from '../server/game.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';

const DEG = 180 / Math.PI, wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
assert.deepEqual(Object.keys(WEAPON_HANDLING_PROFILES).sort(), [...WEAPON_IDS].sort());
for (const def of Object.values(WEAPONS)) {
  assert.ok(Object.isFrozen(def.handling) && Object.isFrozen(def.handling.sway));
  for (const key of ['ergonomics', 'verticalRecoil', 'horizontalRecoil']) {
    assert.ok(def.handling[key] >= HANDLING_LIMITS[key][0] && def.handling[key] <= HANDLING_LIMITS[key][1]);
  }
  if (def.mode !== 'melee') {
    close(def.handling.verticalRecoil, def.recoil.pitch);
    close(def.handling.horizontalRecoil, def.recoil.yaw);
  }
}

const zero = withWeaponHandling(WEAPONS.rifle, { verticalRecoil: 0, horizontalRecoil: 0, sway: { amplitudeDeg: 0 } });
for (let i = 0; i < 80; i++) {
  const kick = computeRecoilKickDeg(zero, i, 1, i / 80); close(kick.pitch, 0); close(kick.yaw, 0);
}
const restored = withWeaponHandling(zero, { verticalRecoil: WEAPONS.rifle.handling.verticalRecoil });
close(restored.recoil.pitchRamp, WEAPONS.rifle.recoil.pitchRamp);
assert.equal(WEAPONS.rifle.recoil.pitch, 0.68, 'Customizing one instance never changes the base or another player');
assert.equal(WEAPONS.rifle.handling.sway.amplitudeDeg, 0.16);
const vertical = withWeaponHandling(WEAPONS.rifle, { verticalRecoil: 8 });
assert.equal(vertical.recoil.yaw, WEAPONS.rifle.recoil.yaw);
assert.equal(withWeaponHandling(WEAPONS.rifle, { horizontalRecoil: 4 }).recoil.pitch, WEAPONS.rifle.recoil.pitch);
const clamped = normalizeWeaponHandling({ ergonomics: -50, verticalRecoil: 500, horizontalRecoil: -1,
  sway: { amplitudeDeg: 100, frequencyHz: 0 } });
assert.deepEqual(clamped, { ergonomics: 0, verticalRecoil: 8, horizontalRecoil: 0,
  sway: { amplitudeDeg: 1.5, frequencyHz: 0.05 } });
assert.deepEqual(normalizeWeaponHandling({ ergonomics: NaN, sway: { frequencyHz: Infinity } }), normalizeWeaponHandling());

function turnTrial(handling, fps, ads = 0, target = Math.PI / 2) {
  const turn = new WeaponTurnInertia(); turn.reset(0, 0);
  let previous = 0, peak = 0, acquired = null;
  for (let i = 1; i <= fps * 8; i++) {
    const state = turn.update(1 / fps, { yaw: target, handling, ads });
    const speed = Math.abs(wrap(state.weaponYaw - previous)) * fps;
    // The fixed-step output may cover ceil(240/fps) substeps on a high-Hz frame.
    assert.ok(speed <= state.maxSpeed * Math.ceil(240 / fps) * fps / 240 + 1e-8);
    previous = state.weaponYaw; peak = Math.max(peak, state.speed * DEG);
    if (acquired === null && Math.abs(state.yaw) * DEG <= 1) acquired = i / fps;
  }
  assert.notEqual(acquired, null, 'Even the slowest supported profile settles');
  close(turn.readModel.yaw, 0, 0.001);
  return { acquiredSeconds: acquired, peakDegPerSecond: peak };
}
const results = [];
for (const [name, handling] of [...Object.entries(WEAPONS).map(([id, d]) => [id, d.handling]),
  ...Object.entries(HANDLING_EXTREMES).map(([id, h]) => [`extreme-${id}`, h])]) {
  const trials = [30, 60, 144].map(fps => ({ fps, ...turnTrial(handling, fps) }));
  assert.ok(Math.max(...trials.map(t => t.acquiredSeconds)) - Math.min(...trials.map(t => t.acquiredSeconds)) <= 1 / 30 + 1e-8);
  const ads = turnTrial(handling, 60, 1);
  assert.ok(ads.peakDegPerSecond <= weaponTurnProfile(handling).maxSpeed * DEG + 1e-6, 'ADS cannot bypass turn limits');
  results.push({ weapon: name, ...handling, maxTurnDegPerSecond: weaponTurnProfile(handling).maxSpeed * DEG,
    acquire90Seconds: trials[1].acquiredSeconds, trials, ads });
}
assert.ok(results.find(r => r.weapon === 'minigun').acquire90Seconds > results.find(r => r.weapon === 'smg').acquire90Seconds * 3);
close(weaponTurnProfile(HANDLING_EXTREMES.heavy).maxSpeed * DEG, 45);
close(weaponTurnProfile(HANDLING_EXTREMES.nimble).maxSpeed * DEG, 720);

// Regression for the old lag clamp: measure orientation, not the reported velocity.
for (const ads of [0, 1]) {
  const motion = new WeaponAimMotion(); motion.update(0, { weapon: 'minigun', ads });
  const cap = weaponTurnProfile(WEAPONS.minigun.handling).maxSpeed;
  const target = Math.PI;
  for (let i = 0; i < 10; i++) {
    const before = motion.turn.readModel.weaponYaw;
    motion.update(1 / 60, { weapon: 'minigun', yaw: target, ads });
    assert.ok(Math.abs(wrap(motion.turn.readModel.weaponYaw - before)) <= cap / 60 + 1e-8, '180-degree flick cannot drag the weapon across its cap');
  }
  assert.ok(Math.abs(motion.readModel.yaw) > 2.5, 'A heavy weapon is still turning after the camera flick');
}

// Wrap, diagonal limit, negative/invalid time and a 200ms render hitch.
const wrapped = new WeaponTurnInertia(); wrapped.reset(Math.PI - 0.02, 0);
wrapped.update(0.02, { yaw: -Math.PI + 0.02, handling: HANDLING_EXTREMES.heavy });
assert.ok(Math.abs(wrapped.readModel.yaw) < 0.05);
const stalled = new WeaponTurnInertia(), steady = new WeaponTurnInertia();
stalled.reset(); steady.reset();
stalled.update(0.2, { yaw: 1, pitch: 1, handling: HANDLING_EXTREMES.heavy });
for (let i = 0; i < 12; i++) steady.update(1 / 60, { yaw: 1, pitch: 1, handling: HANDLING_EXTREMES.heavy });
close(stalled.readModel.weaponYaw, steady.readModel.weaponYaw);
close(stalled.readModel.weaponPitch, steady.readModel.weaponPitch);
assert.ok(stalled.readModel.speed <= stalled.readModel.maxSpeed + 1e-9);
const saved = stalled.readModel.weaponYaw;
for (const dt of [NaN, Infinity, -1, 0]) stalled.update(dt, { yaw: 2 });
close(stalled.readModel.weaponYaw, saved);

// Independent sway axes: amplitude scales excursion; frequency scales time.
for (let t = 0; t < 20; t += 0.07) {
  const base = sampleWeaponSway({ amplitudeDeg: 0.2, frequencyHz: 0.2 }, t);
  const larger = sampleWeaponSway({ amplitudeDeg: 0.4, frequencyHz: 0.2 }, t);
  const faster = sampleWeaponSway({ amplitudeDeg: 0.2, frequencyHz: 0.4 }, t / 2);
  close(larger.yaw, base.yaw * 2); close(larger.pitch, base.pitch * 2);
  close(faster.yaw, base.yaw); close(faster.pitch, base.pitch);
  for (const amplitudeDeg of [0, 1.5]) for (const frequencyHz of [0.05, 2]) {
    const value = sampleWeaponSway({ amplitudeDeg, frequencyHz }, t);
    assert.ok(Math.abs(value.yaw) * DEG <= amplitudeDeg + 1e-9 && Math.abs(value.pitch) * DEG <= amplitudeDeg + 1e-9);
  }
}
const sways = [30, 60, 144].map(fps => {
  const sway = new AimSway();
  for (let i = 0; i < fps * 5; i++) sway.update(1 / fps, { stationary: true, ads: 1, handling: WEAPONS.minigun.handling });
  return sway.readModel;
});
for (const s of sways) { close(s.yaw, sways[0].yaw); close(s.pitch, sways[0].pitch); }

function localFixture(ads = false) {
  const input = new Proxy({ consumeDelta: () => ({ dx: 0, dy: 0 }),
    getKeys: () => ({}), setGameplayEnabled() {}, wantAdsHeld: ads, wantFireHeld: true,
  }, { get: (target, key) => target[key] ?? (() => false) });
  const physics = { pos: { x: 4, y: 1, z: 4 }, vel: { x: 0, y: 0, z: 0 },
    grounded: true, _crouching: false, step: () => false, eyeY: () => 2.62, setMapMeta() {} };
  const local = new LocalPlayer({ input, physics }); local.setGameplayInputEnabled(true); return local;
}
// Exercise the live player and real transport: a 180-degree mouse flick cannot
// send a camera-aligned shot while the heavy weapon is still pointing elsewhere.
for (const ads of [0, 1]) {
  const local = localFixture(!!ads), net = new NetClient(); let wire;
  net.ws = { readyState: 1, send: json => { wire = JSON.parse(json); } };
  const def = withWeaponHandling(WEAPONS.minigun, { sway: { amplitudeDeg: 0 } });
  const weapon = { def, slot: WEAPON_IDS.indexOf('minigun'), adsT: ads };
  local.update(0, 0, { weapon }); local.view.yaw = Math.PI;
  const authority = new PlayerEntity('handling', 'Test', { x: 4, y: 1, z: 4 }, false);
  authority.deployT = 0;
  for (let frame = 1; frame <= 10; frame++) {
    let predicted;
    local.update(1 / 60, frame * 1000 / 60, { weapon, fireAllowed: true,
      beforeSend: () => {
        predicted = { yaw: local.shotYaw, pitch: local.shotPitch };
        if (frame === 5) local.addRecoil(0.01, 0.005, def.weightKg, def.recoil, frame * 1000 / 60);
      }, sendInput: payload => net.sendInput(payload) });
    close(wire.yaw, predicted.yaw); close(wire.pitch, predicted.pitch);
    assert.ok(Math.abs(wrap(wire.viewYaw - wire.yaw)) > 2.5);
    GameEngine.prototype.applyInput.call({ entities: new Map([['handling', authority]]) }, 'handling', wire);
    stepMovement(authority, 1 / 60, { solidAt: (_x, y) => y < 1, mapMeta: {}, now: frame, onFall() {} });
    close(authority.yaw, wire.yaw); close(authority.pitch, wire.pitch);
  }
  local.dispose();
}
// Extreme impulses must remain finite and recover even across a render hitch.
for (const fps of [30, 60, 144]) for (const [verticalRecoil, horizontalRecoil] of [[0, 0], [8, 0], [0, 4], [8, 4]]) {
  const local = localFixture();
  const def = withWeaponHandling(WEAPONS.smg, { verticalRecoil, horizontalRecoil, sway: { amplitudeDeg: 0 } });
  const weapon = { def, slot: WEAPON_IDS.indexOf('smg'), adsT: 0 };
  local.update(0, 0, { weapon });
  const kick = computeRecoilKickDeg(def, 15, 0, 0.8);
  local.addRecoil(kick.pitch / DEG, kick.yaw / DEG, def.weightKg, def.recoil, 0);
  local.update(0.2, 200, { weapon });
  assert.ok(Math.abs(local.recoilPitch) < 1 && Math.abs(local.recoilYaw) < 1, 'A 200ms hitch cannot explode the recoil spring');
  for (let frame = 1; frame <= fps * 3; frame++) local.update(1 / fps, 200 + frame * 1000 / fps, { weapon });
  close(local.recoilPitch, 0, 1e-8); close(local.recoilYaw, 0, 1e-8);
  if (verticalRecoil === 0) close(local.shotPitch, 0);
  if (horizontalRecoil === 0) close(local.shotYaw, 0);
  local.dispose();
}
await mkdir('.artifacts/weapon-handling', { recursive: true });
await writeFile('.artifacts/weapon-handling/measurements.json', JSON.stringify(results, null, 2) + '\n');
console.table(results.map(r => ({ weapon: r.weapon, ergonomics: r.ergonomics,
  turnDegS: +r.maxTurnDegPerSecond.toFixed(1), acquire90s: +r.acquire90Seconds.toFixed(3), swayHz: r.sway.frequencyHz })));
console.log('Handling: all 12 weapons, both extremes, real angular caps, ADS, 30/60/144 FPS, hitch/wrap, independent customization and sway passed.');
