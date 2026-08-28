import * as THREE from '../../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';

export async function runViewmodelContracts(ok, installGlobals) {
  {
    const { AimSway } = await import('../../public/js/player/aim-sway.js');
    const idle = new AimSway().update(0.05, { stationary: true, grounded: true });
    const crouched = new AimSway().update(0.05, {
      stationary: true, grounded: true, crouching: true,
    });
    const held = new AimSway().update(0.05, {
      stationary: true, grounded: true, shift: true,
    });
    const magnitude = (value) => Math.hypot(value.yaw, value.pitch);
    ok(magnitude(idle) > 0 && magnitude(crouched) < magnitude(idle)
        && magnitude(held) < magnitude(crouched),
    'idle aim sway is subtle, crouch-damped, and suppressed by stationary Shift breath hold');

    const holdFrames = (panic, pain) => {
      const sway = new AimSway();
      let frames = 0;
      while (frames < 80 && sway.update(0.05, {
        stationary: true, grounded: true, shift: true, panic, pain,
      }).holdingBreath) frames++;
      return frames;
    };
    ok(holdFrames(0.9, 0.9) < holdFrames(0, 0),
      'pain and panic shorten the finite hold-breath window');

    const calm = new AimSway().update(0.05, { stationary: true, grounded: true });
    const distressed = new AimSway().update(0.05, {
      stationary: true, grounded: true, panic: 1, pain: 1,
    });
    ok(magnitude(distressed) > magnitude(calm) * 2,
      'pain and panic materially increase stationary aim sway');

    const { disposeFirstPersonBody, makeFirstPersonBody } =
      await import('../../public/js/player/first-person-body.js');
    const body = makeFirstPersonBody();
    ok(body.torso.position.z > 0
        && body.torso.position.y + body.torso.geometry.parameters.height / 2 < 1.1,
    'first-person torso stays below and behind the straight-ahead eye line');
    disposeFirstPersonBody(body);

    const input = new Proxy({
      wantAdsHeld: false,
      wantFireHeld: false,
      consumeDelta: () => ({ dx: 0, dy: 0 }),
      getKeys: () => ({ sprint: false, crouch: false }),
      setGameplayEnabled() {},
      consumeBuyMenuRequest: () => false,
      consumeWeaponSwitch: () => 0,
      consumeWeaponSlot: () => null,
      consumeLastWeaponRequest: () => false,
      consumeFireTap: () => false,
    }, { get: (target, key) => target[key] ?? (() => false) });
    const physics = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      grounded: true,
      _crouching: false,
      step: () => false,
      eyeY: () => 1.62,
      setMapMeta() {},
    };
    const { LocalPlayer } = await import('../../public/js/player/local-player.js');
    const player = new LocalPlayer({ input, physics, sendHz: 20 });
    player.setGameplayInputEnabled(true);
    let sent = null;
    player.update(0.05, 0, { sendInput: (payload) => { sent = payload; return true; } });
    const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
    player.updateCamera(0.05, camera, { id: 'rifle', adsFov: 60 });
    ok(Math.hypot(player.aimYaw, player.aimPitch) > 0
        && sent?.yaw === player.aimYaw && sent?.pitch === player.aimPitch
        && camera.rotation.y === player.aimYaw && camera.rotation.x === player.aimPitch,
    'LocalPlayer presents and sends the same swayed aim used by its camera');
    player.dispose();
  }

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
      const centerRay = new THREE.Raycaster(
        new THREE.Vector3(),
        new THREE.Vector3(0, 0, -1),
        0.01,
        10,
      );
      const blockedIronSights = [];
      for (const id of WEAPON_IDS.filter((weaponId) => weaponId !== 'sniper')) {
        rig.setWeapon(id);
        rig.ads(1);
        for (let frame = 0; frame < 120; frame++) {
          rig.update(1 / 60, { grounded: true, aimSwayScale: 0 });
        }
        camera.updateWorldMatrix(true, true);
        const opaqueHit = centerRay.intersectObject(rig.root, true).find(({ object }) =>
          object.visible && object.material?.transparent !== true);
        if (opaqueHit) blockedIronSights.push(id);
      }
      ok(blockedIronSights.length === 0,
        `non-scoped ADS sight axes stay clear of opaque geometry (${blockedIronSights.join(', ')})`);
      rig.setWeapon('revolver');
      rig.ads(1);
      for (let frame = 0; frame < 120; frame++) {
        rig.update(1 / 60, { grounded: true, aimSwayScale: 0 });
      }
      let blockedRevolverFrames = 0;
      for (let frame = 0; frame < 360; frame++) {
        rig.update(1 / 60, {
          speed: 4.4,
          grounded: true,
          aimSwayScale: 1,
          panic: 1,
          pain: 1,
          exhaustion: 1,
        });
        camera.updateWorldMatrix(true, true);
        const hammerHit = centerRay.intersectObject(rig._models.revolver.bolt, true)
          .find(({ object }) => object.visible && object.material?.transparent !== true);
        if (hammerHit) blockedRevolverFrames++;
      }
      ok(blockedRevolverFrames === 0,
        `revolver ADS hammer stays clear throughout moving distressed aim (${blockedRevolverFrames} blocked frames)`);
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
