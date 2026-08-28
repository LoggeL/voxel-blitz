import * as THREE from '../../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';

export async function runViewmodelContracts(ok, installGlobals) {
  // Viewmodel: every canonical weapon must build and survive a real update.
  // The generic magswap request resolves into the weapon's physical reload
  // profile, and identical mouse travel lags more as weapon mass increases.
  {
    const { TIMERS } = await import('../../public/js/guns/defs.js');
    const { ViewmodelRig } = await import('../../public/js/guns/viewmodel.js');
    const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
    const rig = new ViewmodelRig(camera);
    const lagByWeapon = new Map();
    try {
      for (const id of WEAPON_IDS) {
        rig.setWeapon(id);
        rig.reload(2, 'magswap');
        ok(rig._rl?.type === TIMERS[id].magTimeline.type,
          `${id} magswap resolves to its ${TIMERS[id].magTimeline.type} profile`);

        rig.update(0.016, {
          speed: 2.4,
          grounded: true,
          mouseDX: 1,
          mouseDY: -0.5,
        });
        lagByWeapon.set(id, Math.abs(rig._sway.x));
        ok(rig._id === id
          && rig._models[id]?.root.parent === rig.content
          && Number.isFinite(rig.posG.position.x)
          && Number.isFinite(rig.pivot.rotation.y),
        `${id} viewmodel builds, attaches, and updates to finite transforms`);
      }

      ok(Object.keys(rig._models).length === WEAPON_IDS.length,
        'one ViewmodelRig lazily constructs all six canonical weapon models');
      ok(WEAPON_IDS.every((id) => {
        const model = rig._models[id];
        const sightHeight = model?.body?.userData?.sightHeight;
        return Number.isFinite(sightHeight)
          && Math.abs(model.T.adsOffset.x) < 1e-9
          && Math.abs(model.T.adsOffset.y + sightHeight) < 1e-9
          && model.T.adsOffset.z <= -0.58;
      }), 'all six ADS profiles center their declared sight line at a safe camera distance');
      const byWeight = [...WEAPON_IDS].sort(
        (a, b) => WEAPONS[a].weightKg - WEAPONS[b].weightKg
      );
      ok(byWeight.every((id, i) =>
        i === 0 || lagByWeapon.get(byWeight[i - 1]) < lagByWeapon.get(id)),
      'viewmodel turn lag strictly follows canonical weapon-weight ordering');
    } finally {
      rig.dispose();
    }
  }

}
