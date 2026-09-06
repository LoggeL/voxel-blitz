import { RailBeamFX } from '../../public/js/weapons/rail-beam.js';
import { TracerFX } from '../../public/js/weapons/ballistics.js';
import { AIR, STONE } from '../../shared/worlddata.js';
import * as THREE from '../../public/js/vendor/three.module.js';

export function runEnergyFxContracts(ok) {
  const beams = new RailBeamFX(new THREE.Scene(), (_x, _y, z) => z <= -10 ? STONE : AIR);
  beams.shoot({ o: [0, 2, 0], d: [0, 0, -1], charge: 1 });
  ok(beams.pool[0].length > 10 && beams.pool[0].length <= 18 && beams.pool[0].group.visible,
    'charged rail beam crosses solid cover up to its block budget');
  for (let i = 0; i < 30; i++) beams.shoot({ o: [0, 2, 0], d: [0, 0, -1], charge: 1 });
  beams.update(1);
  ok(beams.pool.length === 12 && beams.pool.every((beam) => !beam.group.visible),
    'rail beam pool stays bounded and every effect expires');
  beams.dispose();
  let contacts = 0;
  const fx = Object.create(TracerFX.prototype);
  Object.assign(fx, { stats: { shots: 0 }, spawnFlash() {},
    spawnTracer() { contacts++; }, onWallImpact() { contacts++; } });
  for (const w of ['longarc', 'lance']) {
    for (const local of [true, false]) fx.shoot({ w, o: [0, 2, 0], d: [0, 0, -1] }, { local });
  }
  ok(contacts === 0, 'local and remote lasers produce no ballistic tracers or predicted bullet impacts');
}
