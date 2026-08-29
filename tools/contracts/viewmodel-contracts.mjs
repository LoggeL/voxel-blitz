import * as THREE from '../../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';

export async function runViewmodelContracts(ok, installGlobals) {
  {
    const { shouldShowViewmodel } = await import('../../public/js/guns/weapon-state.js');
    ok(shouldShowViewmodel()
        && !shouldShowViewmodel({ scopeActive: true })
        && !shouldShowViewmodel({ spectating: true })
        && !shouldShowViewmodel({ scopeActive: true, spectating: true }),
    'viewmodel stays hidden for both scoped sniper and spectator cameras');
  }

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

    input.getKeys = () => ({
      forward: true,
      back: false,
      left: false,
      right: false,
      jump: true,
      sprint: true,
      crouch: true,
      interact: true,
    });
    physics.vel.x = 3;
    physics.vel.y = 4;
    physics.vel.z = -2;
    let frozenInput = null;
    player.update(0.05, 50, {
      movementAllowed: false,
      sendInput: (payload) => { frozenInput = payload; return true; },
    });
    ok(Object.values(frozenInput?.keys || {}).every((value) => value === false)
        && physics.vel.x === 0 && physics.vel.y === 0 && physics.vel.z === 0
        && player.crouchBool === false,
    'movement authority freezes local prediction and sends no movement intent');
    player.dispose();
  }

  {
    const restoreGlobals = installGlobals({
      document: { addEventListener() {}, removeEventListener() {} },
    });
    const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 100);
    const { SpectatorCamera } = await import('../../public/js/player/spectator-camera.js');
    const presentations = [];
    const spectator = new SpectatorCamera({
      camera,
      now: () => 1000,
      onPresent: (state) => presentations.push(state),
    });
    const self = { id: 'self', state: 'dead', team: 'alpha', respawnAt: 4000 };
    const ally = {
      id: 'ally', name: 'Ally', state: 'alive', team: 'alpha',
      x: 10, y: 5, z: 8, yaw: 0, pitch: 0, hp: 100,
    };
    const enemy = {
      id: 'enemy', name: 'Enemy', state: 'alive', team: 'bravo',
      x: 2, y: 5, z: 2, yaw: 0, pitch: 0, hp: 100,
    };
    spectator.sync({
      self,
      players: [self, ally, enemy],
      match: { mode: 'tdm', phase: 'live' },
      serverNow: 1000,
    });
    const presented = spectator.ensureTargetPresent(new Map());
    spectator.update(presented, 1 / 60);
    const chaseDistance = camera.position.distanceTo(new THREE.Vector3(ally.x, ally.y + 1.35, ally.z));
    ok(spectator.targetId === ally.id
        && spectator.candidates.length === 1
        && presented.get(ally.id) === ally
        && !presented.has(enemy.id)
        && presentations.at(-1)?.respawnText === 'RESPAWN IN 3.0s'
        && chaseDistance > 3.5,
    'team spectator chases only a living ally and presents the authoritative respawn deadline');

    spectator.sync({
      self: { ...self, respawnAt: null },
      players: [self, ally, enemy],
      match: { mode: 'snd', phase: 'live' },
      serverNow: 1000,
    });
    ok(presentations.at(-1)?.respawnText === 'RESPAWN NEXT ROUND',
      'round-based spectator state does not invent a timed respawn deadline');
    spectator.dispose();
    restoreGlobals();
  }

  {
    const { HANDS } = await import('../../public/js/guns/defs.js');
    const { AvatarWeaponModel } = await import('../../public/js/avatar/avatar-weapon.js');
    const carried = new AvatarWeaponModel();
    try {
      let valid = true;
      const hipMounts = new Set();
      let referenceGrip = null;
      for (const id of WEAPON_IDS) {
        carried.update({ weapon: id, dt: 1 / 60 });
        hipMounts.add(carried.root.position.toArray().map((value) => value.toFixed(4)).join(','));
        const grip = HANDS[id].grip;
        const gripWorld = new THREE.Vector3(
          carried.root.position.x + grip.x * carried.modelRoot.scale.x,
          carried.root.position.y + grip.y * carried.modelRoot.scale.y,
          carried.root.position.z + grip.z * carried.modelRoot.scale.z,
        );
        referenceGrip ||= gripWorld.clone();
        valid &&= gripWorld.distanceTo(referenceGrip) < 1e-6;
        for (let frame = 0; frame < 30; frame++) {
          carried.update({
            weapon: id,
            firing: true,
            ads: true,
            crouchT: 1,
            dt: 1 / 60,
          });
        }
        const bakedHands = [];
        carried.modelRoot?.traverse((object) => {
          if (object.name === 'hand_r' || object.name === 'hand_l') bakedHands.push(object);
        });
        carried.root.updateMatrixWorld(true);
        const standingSightY = carried.getSightWorldPosition(new THREE.Vector3()).y + 0.29;
        valid &&= carried.id === id
          && carried.modelRoot?.name === `gun_${id}`
          && carried.modelRoot.parent === carried.root
          && carried.root.children.length === 1
          && carried.twoHanded === !!HANDS[id].support
          && bakedHands.length >= 1
          && bakedHands.every((hand) => hand.visible === false)
          && carried._model.flash.grp.visible
          && carried.adsT > 0.9
          && Math.abs(standingSightY - 1.62) < 0.02
          && Number.isFinite(carried.root.position.y)
          && Number.isFinite(carried.root.rotation.x);
      }
      ok(valid && hipMounts.size >= 4,
        'remote-avatar mounts preserve weapon-specific grips and align every ADS sight through firing and crouch');
    } finally {
      carried.dispose();
    }
  }

  // Viewmodel: every canonical weapon must build and survive a real update.
  // The generic magswap request resolves into the weapon's physical reload
  // profile, and the camera-independent turn follower respects weapon mass.
  {
    const { TIMERS } = await import('../../public/js/guns/defs.js');
    const { ViewmodelRig } = await import('../../public/js/guns/viewmodel.js');
    const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
    const rig = new ViewmodelRig(camera);
    const lagByWeapon = new Map();
    const maxSpeedByWeapon = new Map();
    try {
      for (const id of WEAPON_IDS) {
        camera.rotation.set(0, 0, 0);
        rig.setWeapon(id);
        rig.reload(2, 'magswap');
        ok(rig._rl?.type === TIMERS[id].magTimeline.type,
          `${id} magswap resolves to its ${TIMERS[id].magTimeline.type} profile`);

        rig.update(1 / 60, {
          speed: 2.4,
          grounded: true,
        });
        camera.rotation.set(0.2, -0.6, 0);
        rig.update(1 / 60, { speed: 2.4, grounded: true });
        lagByWeapon.set(id, Math.abs(rig.turnLag.yaw));
        maxSpeedByWeapon.set(id, rig.turnLag.maxSpeed);
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
        camera.rotation.set(0, 0, 0);
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
      camera.rotation.set(0, 0, 0);
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
      camera.rotation.set(0, 0, 0);
      rig.setWeapon('lmg');
      rig.update(1 / 60, { grounded: true });
      let lmgPeakSpeed = 0;
      for (let frame = 0; frame < 30; frame++) {
        camera.rotation.y -= 0.15;
        rig.update(1 / 60, { grounded: true });
        lmgPeakSpeed = Math.max(lmgPeakSpeed, rig.turnLag.speed);
      }
      const lmgReleaseLag = Math.abs(rig.turnLag.yaw);
      for (let frame = 0; frame < 90; frame++) {
        rig.update(1 / 60, { grounded: true });
      }
      ok(byWeight.every((id, i) => i === 0 || (
        lagByWeapon.get(byWeight[i - 1]) < lagByWeapon.get(id)
        && maxSpeedByWeapon.get(byWeight[i - 1]) > maxSpeedByWeapon.get(id)
      ))
        && lmgPeakSpeed <= rig.turnLag.maxSpeed + 1e-9
        && lmgPeakSpeed > rig.turnLag.maxSpeed * 0.95
        && lmgReleaseLag > 0.05
        && Math.abs(rig.turnLag.yaw) < 0.001,
      'viewmodel turn follower caps angular speed by weight, trails a flick, and settles');

      camera.rotation.set(0, 0, 0);
      rig.setWeapon('rifle');
      rig.update(1 / 60, { grounded: true, speed: 6.2, isSprinting: true });
      rig.update(1 / 60, { grounded: false, verticalVelocity: 7 });
      const takeoffLag = rig._air.p;
      for (let frame = 0; frame < 24; frame++) {
        rig.update(1 / 60, { grounded: false, verticalVelocity: -6 });
      }
      const fallingVelocity = rig._air.v;
      rig.update(1 / 60, { grounded: true, verticalVelocity: 0 });
      ok(takeoffLag < 0 && rig._air.v < fallingVelocity,
        'jump takeoff trails the gun downward and landing adds a damped impact impulse');
    } finally {
      rig.dispose();
    }
  }

}
