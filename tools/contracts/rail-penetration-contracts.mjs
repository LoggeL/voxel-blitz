import { GameEngine } from '../../server/game.js';
import { fireOneShot } from '../../server/sim/combat.js';
import { AIR, STONE, METAL, PLANK } from '../../shared/worlddata.js';
import { WEAPONS, WEAPON_IDS, PLAYER_HALF, chargeShotProfile } from '../../shared/combatmath.js';
import { beamReticleRadiusPx } from '../../public/js/ui/hud-support.js';

export function runRailPenetrationContracts(ok) {
  function shoot(blocks = [], offset = 0, charge = 1, targetX = 55) {
    const engine = new GameEngine();
    engine.addBot('rail', 'Rail');
    engine.addBot('target', 'Target');
    for (let x = 36; x <= 65; x++) for (let y = 15; y <= 20; y++) {
      for (let z = 38; z <= 43; z++) engine.world.setBlock(x, y, z, AIR);
    }
    blocks.forEach((type, i) => engine.world.setBlock(42 + i, 16, 40, type));
    const shooter = engine.entities.get('rail');
    const target = engine.entities.get('target');
    Object.assign(shooter, { x: 40, y: 15, z: 40.5, yaw: -Math.PI / 2, pitch: 0,
      weapon: WEAPON_IDS.indexOf('lance'), cooldown: 0, bloom: 0, exhaustion: 0 });
    Object.assign(target, { x: targetX, y: 15.5, yaw: -Math.PI / 2, pitch: 0, z: 40.5 + offset, hp: 1000,
      spawnProtected: false, spawnProtectedUntil: 0 });
    engine.tickEvents.length = 0;
    fireOneShot(shooter, { ...engine.contexts.combat, computeConeDeg: () => 0 }, charge);
    const hits = engine.tickEvents.filter((event) => event.kind === 'hit');
    const result = { hits, damage: 1000 - target.hp,
      blocks: blocks.map((_, i) => engine.world.getBlock(42 + i, 16, 40)) };
    engine.stop();
    return result;
  }
  const clear = shoot();
  const covered = shoot([STONE, METAL]);
  ok(covered.hits.length === 1 && covered.damage > 0 && covered.damage < clear.damage
    && covered.blocks[0] === AIR,
    'rail spends power on stone and metal, breaks weaker cover, and loses damage');
  ok(shoot(Array(3).fill(METAL)).damage > shoot(Array(6).fill(METAL)).damage
    && shoot(Array(12).fill(METAL), 0, 1, 60).hits.length === 0,
    'successive hard layers attenuate and eventually stop a full rail');
  ok(shoot([PLANK], 0, 0).hits.length === 1 && shoot([METAL], 0, 0).hits.length === 0,
    'a tapped rail crosses soft wood but stops at hard metal');
  ok(shoot([], PLAYER_HALF.x + 0.4).hits.length === 1
    && shoot([], 0.6 + 1.7).hits.length === 0,
    'wide rail collision catches a clear graze and rejects targets outside its 1.6-meter radius');
  ok(shoot([STONE], 0, 1, 42.8).hits.length === 1,
    'a body overlapping a pierced wall receives damage only once');
  const core = shoot([], PLAYER_HALF.x + 0.15);
  const middle = shoot([], PLAYER_HALF.x + 0.8);
  const edge = shoot([], PLAYER_HALF.x + 1.4);
  ok(core.damage === clear.damage && middle.damage > edge.damage && edge.damage > 0
    && middle.damage < core.damage && core.hits.every(hit => !hit.hs),
    'rail core retains full damage while the corona fades continuously without grazing headshots');
  ok(shoot([], PLAYER_HALF.x + 0.8, 0).hits.length === 0,
    'a tap has a smaller real collision radius than a full charge');
  const tap = chargeShotProfile(WEAPONS.lance, 0).hitRadius;
  const full = chargeShotProfile(WEAPONS.lance, 1).hitRadius;
  ok(full === 1.6 && Math.abs(tap - 0.64) < 1e-9
    && beamReticleRadiusPx(full, 20) > beamReticleRadiusPx(tap, 20)
    && beamReticleRadiusPx(full, 10) > beamReticleRadiusPx(full, 20)
    && beamReticleRadiusPx(full, 20, 42) > beamReticleRadiusPx(full, 20, 75),
    'rail reticle follows collision radius, distance and zoom');
}
