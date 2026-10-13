#!/usr/bin/env node
// Exercise real prediction and authority with the same clock/input sequence.
import assert from 'node:assert/strict';
import { WEAPONS, WEAPON_IDS, chargeAfterRelease } from '../shared/combatmath.js';
import { PlayerEntity } from '../server/sim/player.js';
import { cancelCharge, resolveWeaponIntent } from '../server/sim/combat.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';

let checks = 0;
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); checks++; };
const near = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`); checks++;
};

function fixture(id = 'chargerifle') {
  let now = 10_000, allowed = true, heldPrev = false, rigCharge = 0;
  const server = new PlayerEntity('pilot', 'Pilot', { x: 40, y: 20, z: 50, index: 0 }, false);
  Object.assign(server, { weapon: WEAPON_IDS.indexOf(id), deployT: 0, cooldown: 0 });
  server.mag[server.weapon] = WEAPONS[id].magSize;
  server.reserve[server.weapon] = WEAPONS[id].spareMags;
  const events = [], predicted = [], audio = [];
  const ctx = {
    now, entities: new Map([[server.id, server]]), blockHp: new Map(), blockMining: new Map(),
    getBlock: () => 0, solidAt: () => false, canFire: p => allowed && p.state === 'alive',
    canUseWeapon: () => true, canDamage: () => true, computeConeDeg: () => 0,
    pushEvent: event => events.push(event),
  };
  const local = new WeaponState({
    rig: { setWeapon() {}, fire: () => true, reload() {}, pumpAnim() {}, boltAnim() {}, ads() {},
      setCharge: charge => { rigCharge = charge; } },
    audio: { draw() {}, reloadClick() {}, fire() {}, weaponCharge: (...args) => audio.push(args) },
    effects: { shoot: event => predicted.push(event) },
    network: { isCurrentGeneration: () => true, isRunning: () => true },
    feedback: { addExhaustion() {}, addRecoil() {} }, now: () => now,
    random: () => 0.5, setTimer: () => 0, clearTimer() {},
  });
  local.resetToLoadout();
  local.forceWeapon(server.weapon, { mode: 'titanfall', owned: ['rifle', id, 'knife'], now: now - 5000 });
  function step(ms, held, extra = {}) {
    now += ms;
    ctx.now = now;
    server.cooldown = Math.max(0, server.cooldown - ms / 1000);
    const tap = extra.tap ?? (held && !heldPrev);
    server.input = { wantFire: held, reload: !!extra.reload, grenadeHandling: !!extra.grenadeHandling };
    server.fireEdgeQueued = tap;
    local.applyIntents({ fireHeld: held, fireTap: tap, reload: !!extra.reload,
      grenadeHandling: !!extra.grenadeHandling }, now, { allowFire: allowed, alive: server.state === 'alive' });
    resolveWeaponIntent(server, ms / 1000, ctx);
    local.tryFire(now);
    heldPrev = held;
    const shots = events.filter(event => event.kind === 'shoot');
    eq(predicted.length, shots.length, 'prediction and authority shot count');
    eq(local.ammoOf(id).mag, server.mag[WEAPON_IDS.indexOf(id)], 'prediction and authority ammunition');
    near(local.charge01, server.charge, 'prediction and authority charge');
    near(local.readModel(now).charge01, server.charge, 'HUD reads live capacitor energy');
    near(local.readDisplay({}, now).charge01, server.charge, 'on-gun display reads live capacitor energy');
    near(rigCharge, server.charge, 'energy cells read live capacitor energy');
    eq(local.isCharging, server.charging, 'retention is not active charging');
    return shots.length;
  }
  return { server, local, step, events, predicted, audio,
    get now() { return now; }, set allowed(value) { allowed = value; },
    chargeHalf() { step(0, true); step(530, true); step(20, false); near(server.charge, 0.5, 'half bank retained'); },
  };
}

near(chargeAfterRelease(WEAPONS.chargerifle, 0.5, 180), 0.5, 'grace includes 180 ms');
near(chargeAfterRelease(WEAPONS.chargerifle, 0.5, 355), 0.25, 'linear decay after grace');
eq(chargeAfterRelease(WEAPONS.chargerifle, 0.5, 530), 0, 'half bank empty after grace plus 350 ms');
eq(chargeAfterRelease(WEAPONS.lance, 0.5, 0), 0, 'VOLTLANCE has no retained bank');

{
  const f = fixture();
  f.chargeHalf();
  f.step(180, false);
  near(f.server.charge, 0.5, 'short release keeps half charge');
  eq(f.audio.at(-1)[1], false, 'released bank stops the charging whine');
  f.step(0, true);
  near(f.server.charge, 0.5, 'press resumes saved energy');
  eq(f.step(549, true), 0, 'no shot before the remaining 550 ms');
  eq(f.step(1, true), 1, 'remaining 550 ms completes the charge');
  eq(f.predicted[0].charge, 1, 'resumed shot is full strength');
  near(f.server.cooldown, 2.5, 'resumed shot keeps the full cadence');
  f.step(100, false);
  f.step(100, true);
  eq(f.server.charging, false, 'press during cooldown cannot charge');
  f.step(2300, true);
  eq(f.server.charging, false, 'cooldown hold requires a fresh press');
  f.step(1, false);
  f.step(1, true);
  eq(f.server.charging, true, 'fresh press after cooldown charges');
}

{
  const f = fixture();
  f.chargeHalf();
  f.step(355, false);
  near(f.server.charge, 0.25, 'released bank loses one quarter after grace');
  f.step(0, true);
  eq(f.step(824, true), 0, 'decayed charge needs the missing three quarters');
  eq(f.step(1, true), 1, 'decayed quarter completes after 825 ms');
}

{
  const f = fixture();
  f.chargeHalf();
  f.step(529, false);
  assert.ok(f.server.charge > 0); checks++;
  f.step(1, false);
  eq(f.server.charge, 0, 'stored half bank expires at 530 ms');
  eq(f.step(5000, false), 0, 'a released bank never fires even after a long frame');
  f.step(0, true);
  eq(f.step(1099, true), 0, 'fully drained bank needs the complete charge time');
  eq(f.step(1, true), 1, 'empty bank completes after 1100 ms');
}

{
  const f = fixture();
  f.step(0, false, { tap: true });
  eq(f.server.charging, false, 'collapsed press/release edge cannot start charging');
  eq(f.step(1500, false), 0, 'collapsed tap never produces a delayed shot');
}

for (const phase of ['held', 'released']) for (const reason of ['blocked', 'death', 'grenade', 'reload']) {
  const f = fixture();
  if (phase === 'released') f.chargeHalf();
  else { f.step(0, true); f.step(550, true); }
  if (reason === 'blocked') f.allowed = false;
  if (reason === 'death') f.server.state = 'dead';
  if (reason === 'reload') {
    f.server.mag[f.server.weapon] = 2;
    f.local.adoptServerAmmo(f.server.mag, f.server.reserve);
  }
  f.step(20, false, { grenadeHandling: reason === 'grenade', reload: reason === 'reload' });
  eq(f.server.charge, 0, `${phase}: ${reason} clears the bank`);
  eq(f.server.shotSeq, 0, `${phase}: ${reason} fires no shot`);
  if (reason === 'reload') eq(f.server.reloading, true, 'reload really starts');
}

for (const hz of [30, 60, 144]) {
  const f = fixture(), dt = 1000 / hz;
  f.step(0, true);
  for (let i = 0; i < Math.floor(hz * 0.4); i++) f.step(dt, true);
  f.step(dt, false);
  for (let i = 0; i < Math.floor(hz * 0.3); i++) f.step(dt, false);
  f.step(dt, true);
  let shots = 0;
  for (let i = 0; i < hz * 1.2 && !shots; i++) shots = f.step(dt, true);
  eq(shots, 1, `${hz} Hz: resumed charge completes once`);
}

for (const reason of ['vault', 'lost-input']) {
  const f = fixture();
  f.chargeHalf();
  f.server.input = reason === 'lost-input' ? null : { wantFire: false };
  if (reason === 'vault') f.server.vault = {};
  resolveWeaponIntent(f.server, 0.02, { canFire: () => true, canUseWeapon: () => true });
  eq(f.server.charge, 0, `${reason}: server clears the released bank`);
  eq(f.server.shotSeq, 0, `${reason}: cancellation fires no shot`);
}

{
  const f = fixture();
  f.chargeHalf();
  const oldSlot = f.server.weapon;
  f.server.input = { switchTo: WEAPON_IDS.indexOf('rifle'), wantFire: false };
  resolveWeaponIntent(f.server, 0.02, { now: f.now, canFire: () => true, canUseWeapon: () => true });
  f.local.forceWeapon(WEAPON_IDS.indexOf('rifle'), { now: f.now });
  eq(f.server.charge, 0, 'switch clears the server bank');
  eq(f.local.charge01, 0, 'switch clears the local bank');
  eq(f.server.mag[oldSlot], WEAPONS.chargerifle.magSize, 'switch spends no cell');
}

{
  const f = fixture();
  f.chargeHalf();
  // The actual server death/spawn reset clears these existing canonical fields;
  // a leftover decay timer must never be sufficient to revive stored energy.
  Object.assign(f.server, { charging: false, chargeT: 0, charge: 0 });
  f.local.cancelCharge();
  f.step(20, false);
  f.step(0, true);
  near(f.server.charge, 0, 'canonical reset cannot resurrect a retained bank');
  cancelCharge(f.server);
  eq(f.server.chargeReleasedT, 0, 'explicit cancellation also clears the timer');
}

{
  const f = fixture('lance');
  f.step(0, true);
  f.step(200, true);
  eq(f.step(20, false), 1, 'VOLTLANCE still fires immediately on partial release');
  assert.ok(f.predicted[0].charge > 0 && f.predicted[0].charge < 1); checks++;
  eq(f.server.charge, 0, 'VOLTLANCE shot clears its bank');
}

console.log(`chargerifle-charge-test: ${checks} checks passed`);
