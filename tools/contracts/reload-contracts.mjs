import { WEAPONS } from '../../shared/combatmath.js';
import { updateTimers } from '../../server/sim/movement.js';
import { resolveWeaponIntent } from '../../server/sim/combat.js';

export function runReloadContracts(ok) {
  const p = {
    weapon: 0, def: WEAPONS.rifle, mag: [0], reserve: [1],
    cooldown: 0, deployT: 0, bloom: 0, infiniteMagazines: true,
  };
  for (let i = 0; i < 20; i++) {
    p.mag[0] = 0;
    p.reloading = true;
    p.reloadT = 0.01;
    updateTimers(p, 0.02);
  }
  ok(p.mag[0] === WEAPONS.rifle.magSize && p.reserve[0] === 1,
    'Gun Game authority can reload repeatedly without exhausting magazines');
  p.infiniteMagazines = false;
  p.reloading = true;
  p.reloadT = 0.01;
  updateTimers(p, 0.02);
  ok(p.reserve[0] === 0, 'other modes still consume a spare magazine');

  p.mag[0] = 10;
  p.reserve[0] = 2;
  p.input = { reload: true, wantFire: false };
  const ctx = { canUseWeapon: () => true, canFire: () => true };
  resolveWeaponIntent(p, 0.01, ctx);
  updateTimers(p, 10);
  p.mag[0] -= 1; // A shot immediately after completing the reload.
  resolveWeaponIntent(p, 0.01, ctx);
  ok(!p.reloading && p.mag[0] === WEAPONS.rifle.magSize - 1 && p.reserve[0] === 1,
    'the same held reload signal cannot start another reload after a shot');
}
