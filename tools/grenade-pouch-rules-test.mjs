import assert from 'node:assert/strict';
import {
  GRENADE_DEFAULT_POWER_INDEX,
  GRENADE_PIN_MS,
  GRENADE_POUCH_HOLD_MS,
  GRENADE_POWER_STEPS,
  GRENADE_ROLES,
  GRENADE_TAP_MS,
  GRENADE_THROW_COOLDOWN_MS,
  GRENADE_TYPE_IDS,
  GRENADE_TYPES,
  autoReadyGrenade,
  freshGrenadeLoadout,
  grenadeCookFromHold,
  grenadeEffectRadius,
  grenadeLaunch,
  grenadePowerAt,
  nextStockedGrenade,
  predictGrenadePath,
} from '../shared/grenade-rules.js';

// Roster and constants stay stable: ids are wire indices and saved preferences.
assert.deepEqual([...GRENADE_TYPE_IDS], ['frag', 'limpet', 'pulse', 'molotov', 'smoke']);
assert.deepEqual(freshGrenadeLoadout(), [2, 1, 2, 1, 1]);
assert.equal(GRENADE_TAP_MS, 170);
assert.equal(GRENADE_PIN_MS, 240);
assert.equal(GRENADE_POUCH_HOLD_MS, 200);
assert.equal(GRENADE_THROW_COOLDOWN_MS, 450);
assert.deepEqual([...GRENADE_POWER_STEPS], [0.2, 0.4, 0.6, 0.8, 1.0]);
assert.ok(Object.isFrozen(GRENADE_POWER_STEPS) && Object.isFrozen(GRENADE_ROLES));
for (const id of GRENADE_TYPE_IDS) assert.ok(GRENADE_ROLES[id], `${id} has a role`);

// Power steps: clamped index, default 0.6.
assert.equal(grenadePowerAt(GRENADE_DEFAULT_POWER_INDEX), 0.6);
assert.equal(grenadePowerAt(0), 0.2);
assert.equal(grenadePowerAt(4), 1.0);
assert.equal(grenadePowerAt(-3), 0.2);
assert.equal(grenadePowerAt(99), 1.0);
assert.equal(grenadePowerAt(NaN), 0.6);

// Cook is measured from the pin pull and only for cookable types.
const frag = GRENADE_TYPES.frag;
assert.equal(grenadeCookFromHold(100, frag), 0);
assert.equal(grenadeCookFromHold(GRENADE_PIN_MS, frag), 0);
assert.equal(grenadeCookFromHold(1000, frag), 1000 - GRENADE_PIN_MS);
assert.equal(grenadeCookFromHold(1000, 'frag'), 760);
for (const id of ['limpet', 'pulse', 'molotov', 'smoke']) {
  assert.equal(grenadeCookFromHold(5000, GRENADE_TYPES[id]), 0, `${id} never cooks`);
}
assert.equal(grenadeCookFromHold(NaN, frag), 0);

// Stepping only lands on stocked types, wraps both ways, never returns `from`.
assert.equal(nextStockedGrenade([2, 0, 2, 0, 1], 0), 2);
assert.equal(nextStockedGrenade([2, 0, 2, 0, 1], 2), 4);
assert.equal(nextStockedGrenade([2, 0, 2, 0, 1], 4), 0);
assert.equal(nextStockedGrenade([2, 0, 2, 0, 1], 0, -1), 4);
assert.equal(nextStockedGrenade([2, 0, 2, 0, 1], 2, -1), 0);
assert.equal(nextStockedGrenade([0, 0, 1, 0, 0], 2), -1, 'nothing else stocked');
assert.equal(nextStockedGrenade([0, 0, 0, 0, 0], 0), -1);
assert.equal(nextStockedGrenade([0, 0, 0, 0, 0], 0, -1), -1);
assert.equal(nextStockedGrenade([0, 0, 1, 0, 1], -1), 2, 'no ready type picks the first stocked');
assert.equal(nextStockedGrenade([0, 0, 1, 0, 1], -1, -1), 4);

// Auto-ready: current, then the last manual pick, then same role, then belt order.
assert.equal(autoReadyGrenade([2, 1, 2, 1, 1], 3, 0), 3, 'current kept while stocked');
assert.equal(autoReadyGrenade([0, 1, 2, 1, 1], 0, 4), 4, 'preferred next');
assert.equal(autoReadyGrenade([0, 0, 0, 2, 1], 0, 0), 3, 'TTT frag runs out -> molotov (lethal)');
assert.equal(autoReadyGrenade([0, 0, 1, 0, 1], 0, 0), 2, 'Bastion: belt order -> pulse, not smoke');
assert.equal(autoReadyGrenade([0, 0, 0, 0, 1], 2, -1), 4, 'pulse -> smoke (tactical)');
assert.equal(autoReadyGrenade([0, 0, 0, 0, 0], 0, 0), -1, 'empty pouch');
assert.equal(autoReadyGrenade([1, 0, 0, 0, 0], -1, -1), 0, 'nothing ready -> first stocked');

// Landing-zone radius follows the authoritative effect footprint.
assert.equal(grenadeEffectRadius('frag'), 7.5);
assert.equal(grenadeEffectRadius('pulse'), GRENADE_TYPES.pulse.damageRadius);
assert.equal(grenadeEffectRadius('limpet'), GRENADE_TYPES.limpet.damageRadius);
assert.equal(grenadeEffectRadius('molotov'), 3.2);
assert.equal(grenadeEffectRadius('molotov', 1), 4.2);
assert.equal(grenadeEffectRadius('smoke'), 4);
assert.equal(grenadeEffectRadius('smoke', 1), 5);

// A frag thrown at a floor reports its bounce contacts; impact types report none.
const floor = (_x, y) => y < 0;
const aim = { x: 0, y: -0.5, z: -Math.sqrt(0.75) };
const fragPath = predictGrenadePath(
  grenadeLaunch({ x: 0, y: 0, z: 0, eyeY: 1.6, dir: aim, charge: 0.6, type: 'frag' }), floor);
assert.ok(Array.isArray(fragPath.bounces) && fragPath.bounces.length > 0, 'frag bounces');
assert.ok(fragPath.bounces.length < 12, `rolling is not one bounce per step (${fragPath.bounces.length})`);
for (const point of fragPath.bounces) {
  assert.equal(point.length, 3);
  assert.ok(point[1] >= 0 && point[1] < 0.5, `bounce sits on the floor (${point[1]})`);
}
assert.ok(fragPath.points.length > 1 && fragPath.landing.length === 3 && fragPath.rests);
const pulsePath = predictGrenadePath(
  grenadeLaunch({ x: 0, y: 0, z: 0, eyeY: 1.6, dir: aim, charge: 0.6, type: 'pulse' }), floor);
assert.deepEqual(pulsePath.bounces, [], 'impact types detonate on first contact');

console.log('grenade pouch rules: ok');
