import assert from 'node:assert/strict';
import { WEAPONS, WEAPON_IDS, reloadPlan } from '../shared/combatmath.js';
import { beginReload, advanceReload } from '../shared/reload.js';
import { chaosWeaponDef } from '../shared/chaos.js';
import { PlayerEntity } from '../server/sim/player.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { updateTimers } from '../server/sim/movement.js';

// GL-3 SKIPJACK: one round rides in the closed chamber, each flank cassette
// carries magSize - 1. A tactical swap keeps the chambered round and needs no
// charging stroke; an empty swap strips a fresh round into the chamber.
const mgl = WEAPONS.mgl;
assert.equal(mgl.chamber, 1);
assert.equal(mgl.magSize, 3);
assert.ok(mgl.tacTime < mgl.reloadTime, 'skipping the charging stroke makes a tactical swap faster');

function swap(def, mag, reserve = 3) {
  const ammo = { mag, reserve };
  const plan = beginReload(def, ammo);
  const during = ammo.mag;
  advanceReload(plan, def, ammo, plan.seconds + 1);
  return { plan, during, ...ammo };
}

const empty = swap(mgl, 0);
assert.deepEqual([empty.during, empty.mag, empty.reserve], [0, 2, 2], 'empty swap: 2 of 3 rounds');
assert.equal(empty.plan.seconds, mgl.reloadTime);
assert.equal(empty.plan.rounds, 2);
for (const mag of [1, 2]) {
  const tactical = swap(mgl, mag);
  assert.deepEqual([tactical.during, tactical.mag, tactical.reserve], [1, 3, 2],
    `tactical swap from ${mag}: the chambered round stays, the cassette is replaced`);
  assert.equal(tactical.plan.seconds, mgl.tacTime);
  assert.equal(tactical.plan.chambered, true);
}
assert.equal(beginReload(mgl, { mag: 3, reserve: 3 }), null, 'a full launcher does not swap');

// The Spare chamber upgrade adds one round per cassette: 4 total, 3 outside.
const upgraded = chaosWeaponDef({ chaosUpgrades: { mgl: 3 } }, mgl);
assert.equal(upgraded.chamber, 1);
assert.deepEqual([swap(upgraded, 0).mag, swap(upgraded, 1).mag], [3, 4]);

// Life totals: three cassettes of two keep the old 3 + 2 x 3 = 9 round budget.
let fired = mgl.magSize;
let ammo = { mag: 0, reserve: mgl.spareMags };
while (ammo.reserve > 0) {
  const plan = beginReload(mgl, ammo);
  advanceReload(plan, mgl, ammo, plan.seconds);
  fired += ammo.mag;
  ammo.mag = 0;
}
assert.equal(fired, 9, 'always emptying the launcher still yields nine rounds per life');

// Other magazine weapons keep dropping the whole magazine.
for (const id of WEAPON_IDS) {
  const def = WEAPONS[id];
  if (id === 'mgl' || def.reloadStages || def.mode === 'melee' || def.glaive || !(def.magSize > 1)) continue;
  const plan = reloadPlan(def, 1, 3);
  assert.equal(plan.chambered, false, `${id} has no separate chamber`);
  assert.equal(swap(def, 1).during, 0, `${id} still drops its magazine`);
  assert.equal(swap(def, 0).mag, def.magSize, `${id} empty swap still fills the magazine`);
}

// Server authority: the same rules run through the authoritative intent path.
const context = { canUseWeapon: () => true, canFire: () => true };
const slot = WEAPON_IDS.indexOf('mgl');
for (const [start, expected, seconds] of [[2, 3, mgl.tacTime], [0, 2, mgl.reloadTime]]) {
  const player = new PlayerEntity(`skipjack-${start}`, 'Test', { x: 4, y: 2, z: 4 }, false);
  player.weapon = slot;
  player.deployT = 0;
  player.mag[slot] = start;
  assert.equal(player.reserve[slot], mgl.spareMags);
  player.input = { reload: true, reloadId: 1, wantFire: false };
  resolveWeaponIntent(player, 0.02, context);
  assert.equal(player.reloading, true);
  assert.equal(player.mag[slot], Math.min(start, 1), 'the authority keeps only the chambered round');
  let elapsed = 0;
  while (player.reloading && elapsed < 6) {
    player.input = { reload: false, reloadId: 1, wantFire: false };
    updateTimers(player, 0.02);
    resolveWeaponIntent(player, 0.02, context);
    elapsed += 0.02;
  }
  assert.equal(player.mag[slot], expected);
  assert.equal(player.reserve[slot], mgl.spareMags - 1);
  assert.ok(Math.abs(elapsed - seconds) < 0.05, `authoritative swap time ${elapsed} ~ ${seconds}`);
}

console.log('SKIPJACK ammo: chambered tactical swap, empty charging swap, upgrade, life total and authority passed.');
