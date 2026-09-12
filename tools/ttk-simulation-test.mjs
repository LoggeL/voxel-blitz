import assert from 'node:assert/strict';
import { simulateFight, summarize } from './lib/ttk-simulation.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const rifle = simulateFight({ weapon: 'rifle', distance: 10, trace: true });
assert.equal(rifle.shots, 5);
assert.equal(rifle.killMs, 350);
assert.equal(rifle.firstAttackDamage, 20);
assert.equal(rifle.damageWindowMs, 350);
const armored = simulateFight({ weapon: 'rifle', distance: 10, armor: 100 });
assert.equal(armored.hits, 10);
assert.equal(armored.totalDamage, 200);

// Read actual HP damage, not the rounded integer displayed on the wire.
close(simulateFight({ weapon: 'smg', distance: 10 }).firstAttackDamage, 15.2);
close(simulateFight({ weapon: 'shotgun', distance: 2 }).firstAttackDamage, 104.4);
assert.equal(simulateFight({ weapon: 'sniper', distance: 120, scenario: 'ideal-head' }).killMs, 0);

const rocket = simulateFight({ weapon: 'rocket', distance: 10 });
close(rocket.firstAttackDamage, 156.8);
assert.equal(rocket.killMs, 250);
assert.equal(rocket.damageWindowMs, 0);
assert.ok(simulateFight({ weapon: 'rocket', distance: 80 }).killMs > rocket.killMs);
const bolt = simulateFight({ weapon: 'longarc', distance: 80, scenario: 'ideal-head' });
assert.equal(bolt.headHits, 1, 'ballistic compensation must actually reach the head');
assert.equal(bolt.damageWindowMs, 0);
assert.ok(bolt.killMs > 1400, 'flight is included even in a first-impact kill');

const halfRail = simulateFight({ weapon: 'lance', distance: 10, chargeMs: 1400, maxSeconds: 1.4 });
assert.equal(halfRail.killMs, null);
assert.equal(halfRail.shots, 1);
close(halfRail.firstAttackDamage, 74.4);
assert.equal(simulateFight({ weapon: 'lance', distance: 10 }).killMs, 2800);
const cold = simulateFight({ weapon: 'minigun', distance: 10 });
const ready = simulateFight({ weapon: 'minigun', distance: 10, minigun: 'ready' });
const hot = simulateFight({ weapon: 'minigun', distance: 10, minigun: 'hot' });
assert.ok(cold.killMs > ready.killMs && ready.killMs > hot.killMs);
assert.equal(hot.killMs, 400);
close(hot.firstAttackDamage, 12.48);
assert.equal(simulateFight({ weapon: 'knife', distance: 2, backstab: true }).killMs, 0);
assert.equal(simulateFight({ weapon: 'knife', distance: 5 }).killMs, null);
assert.equal(simulateFight({ weapon: 'flamethrower', distance: 40 }).killMs, null);
assert.ok(simulateFight({ weapon: 'flamethrower', distance: 20 }).killMs > 2000);

const caseOptions = { weapon: 'shotgun', distance: 40, scenario: 'ads-body', seed: 345 };
assert.deepEqual(simulateFight(caseOptions), simulateFight(caseOptions));
const spread = Array.from({ length: 32 }, (_, seed) => simulateFight({ ...caseOptions, seed }));
assert.ok(spread.some(f => f.killMs > simulateFight({ weapon: 'shotgun', distance: 40 }).killMs));
const reload = simulateFight({ weapon: 'shotgun', distance: 80, scenario: 'ads-body', seed: 77 });
assert.ok(reload.reloads > 0);
assert.ok(reload.shots > 7 && reload.killMs > 5000);
const censored = summarize([rifle, ...Array.from({ length: 3 }, () => ({ ...rifle, killMs: null }))]);
assert.equal(censored.medianMs, null);
assert.equal(censored.p90Ms, null);
assert.equal(censored.killRate, 0.25);
assert.throws(() => simulateFight({ weapon: 'rifle', distance: -1 }));
assert.throws(() => simulateFight({ weapon: 'rifle', distance: 10, armor: 101 }));
console.log('TTK simulation: damage precision, armor, tick cadence, spread, deterministic seeds, projectile travel, head contacts, charge, heat, reloads, range limits and censored percentiles passed.');
