import assert from 'node:assert/strict';
import { simulateFight } from './lib/ttk-simulation.mjs';
import { simulateBlast } from './lib/blast-simulation.mjs';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { runBlastImpulseContracts } from './contracts/blast-impulse-contracts.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
// Role boundaries: short-range shotgun still kills; the 10 m body shot does not.
assert.equal(simulateFight({ weapon: 'shotgun', distance: 5 }).killMs, 0);
assert.equal(simulateFight({ weapon: 'shotgun', distance: 10 }).shots, 2);
assert.equal(simulateFight({ weapon: 'revolver', distance: 10, scenario: 'ideal-head' }).shots, 2);
assert.equal(simulateFight({ weapon: 'revolver', distance: 80, scenario: 'ideal-head' }).shots, 3);
assert.equal(simulateFight({ weapon: 'revolver', distance: 80 }).shots, 5);
assert.equal(simulateFight({ weapon: 'minigun', distance: 10, minigun: 'hot' }).killMs, 400);
assert.equal(simulateFight({ weapon: 'flamethrower', distance: 10 }).killMs, 1350);

// Hitpoints come from the actual explosion path, including scaling and rounding.
close(simulateBlast({ direct: true }).damage, 156.8);
close(simulateBlast({ distance: 0 }).damage, 76.8);
close(simulateBlast({ distance: 3 }).damage, 34.64);
close(simulateBlast({ distance: 5 }).damage, 9.76);
assert.equal(simulateBlast({ distance: ROCKET_RULES.damageRadius }).damage, 0);
assert.equal(simulateBlast({ distance: 7 }).damage, 0);
assert.equal(simulateBlast({ distance: 3, blocked: true }).damage, 0);
assert.equal(simulateBlast({ distance: 5 }).impulse, 0, 'added damage reach must not expand pressure');
assert.equal(ROCKET_RULES.terrainRadius, 4.4);
assert.ok(simulateBlast({ distance: 2, self: true }).damage < simulateBlast({ distance: 2 }).damage);
assert.ok(simulateBlast({ distance: 2, self: true }).impulse > simulateBlast({ distance: 2 }).impulse);
const armored = simulateBlast({ direct: true, armor: 100 });
close(armored.hpLeft, 43.2);
let previous = Infinity;
for (let distance = 0; distance <= 7; distance += 0.125) {
  const { damage } = simulateBlast({ distance });
  assert.ok(Number.isFinite(damage) && damage >= 0 && damage <= previous, 'splash decreases monotonically');
  previous = damage;
}
// Existing grenade/rocket pressure, cover, and client impulse reconciliation.
runBlastImpulseContracts((value, message) => assert.ok(value, message));
console.log('Weapon balance: near/far kill boundaries, minigun bonus, flame buff, direct/splash damage, curved falloff, radius cutoff, cover, armor and preserved rocket-jump pressure passed.');
