import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS, HITSCAN_REACH, damageAtDistance } from '../shared/combatmath.js';
import { raycastVoxels } from '../shared/raycast.js';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot } from '../server/sim/combat.js';
import { RailBeamFX } from '../public/js/weapons/rail-beam.js';
import { TracerFX } from '../public/js/weapons/ballistics.js';

function shotAt(weapon, distance, wallX = null) {
  const shooter = new PlayerEntity('shooter', 'Shooter', { x: 0.5, y: 2, z: 0.5 });
  const victim = new PlayerEntity('victim', 'Victim', { x: 0.5 + distance, y: 2.5, z: 0.5 });
  shooter.weapon = WEAPON_IDS.indexOf(weapon);
  shooter.yaw = -Math.PI / 2;
  victim.hp = 10000;
  const events = [];
  const solidAt = x => wallX !== null && x === wallX;
  const ctx = {
    now: 1000, entities: new Map([[shooter.id, shooter], [victim.id, victim]]),
    blockHp: new Map(), solidAt, getBlock: () => 0,
    computeConeDeg: () => 0, canDamage: () => true,
    pushEvent: event => events.push(event), killPlayer() {},
  };
  fireOneShot(shooter, ctx);
  return { victim, events };
}

const firearms = Object.values(WEAPONS).filter(def => !def.projectile && !def.flame && !def.melee);
for (const def of firearms) {
  for (const distance of [121, 301, 1250]) {
    const { victim, events } = shotAt(def.id, distance);
    assert.ok(victim.hp < 10000, `${def.id} hits a body at ${distance} without a distance cutoff`);
    assert.ok(events.some(event => event.kind === 'hit'), 'the authoritative hit is published');
  }
  assert.equal(damageAtDistance(def, 10000), def.damage[1], `${def.id} keeps its far damage`);
}
for (const weapon of ['rifle', 'sniper']) {
  for (const wall of [200, 1100]) {
    assert.equal(shotAt(weapon, 1250, wall).victim.hp, 10000,
      `${weapon} still stops at an intervening wall at ${wall}`);
  }
}
assert.ok(shotAt('lance', 1250, 1100).victim.hp < 10000,
  'a charged rail still crosses terrain beyond the former distance and voxel-step caps');

// A weapon has no maximum distance; the voxel walker still terminates in empty
// space and respects distant terrain throughout its supported world envelope.
let visited = 0;
assert.equal(raycastVoxels(() => { visited++; return false; },
  0.5, 2.5, 0.5, 1, 0, 0, HITSCAN_REACH), null);
assert.ok(visited < 5000, 'an empty-sky ray terminates at finite world safety bounds');
assert.equal(raycastVoxels(x => x === 1500, 0.5, 2.5, 0.5, 1, 0, 0, HITSCAN_REACH)?.x, 1500);

const scene = new THREE.Scene();
const beam = new RailBeamFX(scene, x => x >= 350 && x <= 370);
try {
  beam.shoot({ w: 'lance', o: [0.5, 2.5, 0.5], d: [1, 0, 0], charge: 0 });
  assert.ok(beam.pool[0].length > 300, 'the rail beam renders its distant terrain endpoint');
  beam.shoot({ w: 'lance', o: [0.5, 2.5, 0.5], d: [0, 1, 0], charge: 1 });
  assert.ok(Number.isFinite(beam.pool[1].length), 'empty-sky rail geometry stays finite');
} finally { beam.dispose(); }

const previousDocument = globalThis.document;
const canvasContext = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) },
  { get: (target, key) => target[key] ?? (() => {}) });
globalThis.document = { createElement: () => ({ getContext: () => canvasContext }) };
try {
  const impacts = [];
  const tracers = new TracerFX(scene, x => x === 350, hit => impacts.push(hit));
  try {
    tracers.shoot({ w: 'rifle', o: [0.5, 2.5, 0.5], d: [1, 0, 0] }, { local: true });
    assert.equal(impacts[0]?.x, 350, 'distant terrain receives impact feedback');
    assert.ok(tracers.tracers[0].len <= WEAPONS.rifle.tracer.len,
      'a visible tracer streak keeps finite geometry without limiting the hit');
  } finally { tracers.dispose(); }
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}

console.log('PASS weapon range: all hitscan firearms hit beyond 120/300, preserve falloff and distant wall occlusion; rail and impact feedback follow.');
