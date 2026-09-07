import * as THREE from '../../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';

function isRenderedOpaque({ object }) {
  if (object.material?.transparent === true) return false;
  // Three.js raycasting includes descendants of hidden groups. Match renderer
  // visibility so holstered throwable hands do not obstruct an iron-sight test.
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

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

    const sniper = new LocalPlayer({ input, physics, sendHz: 20 });
    sniper.setGameplayInputEnabled(true);
    sniper.recoilPitch = 0.015;
    sniper.recoilYaw = -0.007;
    const preShot = { yaw: sniper.shotYaw, pitch: sniper.shotPitch };
    sniper.addRecoil(0.04, 0.01, WEAPONS.sniper.weightKg, WEAPONS.sniper.recoil, 0);
    let recoilPacket;
    sniper._sendInputMaybe(0.05, { sendInput: payload => { recoilPacket = payload; return false; } });
    ok(recoilPacket.yaw === preShot.yaw && recoilPacket.pitch === preShot.pitch
      && sniper._pendingShotAim != null,
      'shot packet retains pre-shot visible recoil and excludes its own kick even after a failed send');
    sniper._sendInputMaybe(0.05, { sendInput: payload => { recoilPacket = payload; return true; } });
    ok(recoilPacket.pitch === preShot.pitch && sniper._pendingShotAim === null,
      'successful send clears the frozen shot aim');
    sniper._sendInputMaybe(0.05, { sendInput: payload => { recoilPacket = payload; return true; } });
    ok(recoilPacket.pitch === sniper.shotPitch && recoilPacket.pitch !== preShot.pitch,
      'subsequent aim packets include accumulated climb and the current camera spring');
    const secondAim = { yaw: sniper.shotYaw, pitch: sniper.shotPitch };
    sniper.addRecoil(0.04, 0.01, WEAPONS.sniper.weightKg, WEAPONS.sniper.recoil, 1430);
    sniper._sendInputMaybe(0.05, { sendInput: payload => { recoilPacket = payload; return true; } });
    ok(recoilPacket.pitch === secondAim.pitch && recoilPacket.yaw === secondAim.yaw
      && secondAim.pitch !== preShot.pitch,
      'a repeated sniper shot uses existing recoil exactly once and never adds its new kick to itself');
    const { computeSpreadConeDeg, SNIPER_SCOPE_ADS_THRESHOLD } = await import('../../shared/combatmath.js');
    ok(computeSpreadConeDeg(WEAPONS.sniper, 0, 0, SNIPER_SCOPE_ADS_THRESHOLD)
      === computeSpreadConeDeg(WEAPONS.sniper, 0, 0, 1)
      && computeSpreadConeDeg(WEAPONS.sniper, 0.8, 0, 1) > WEAPONS.sniper.spreadDeg.ads,
      'the first visible sniper scope has settled accuracy while residual shot bloom still matters');
    sniper.dispose();

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

    // Camera recoil is a velocity-driven spring: it peaks a few frames after the shot,
    // recovers on its own, keeps a fraction of the pitch on the true aim, and recovers
    // more slowly for a heavier weapon.
    const recoilTrace = (weightKg) => {
      const trace = [];
      const shooter = new LocalPlayer({ input, physics, sendHz: 20 });
      shooter.setGameplayInputEnabled(true);
      physics.vel.x = physics.vel.y = physics.vel.z = 0;
      shooter.update(1 / 60, 0, { sendInput: () => true });
      const aimBefore = shooter.view.pitch;
      shooter.addRecoil(0.02, 0.01, weightKg);
      const aimAfter = shooter.view.pitch;
      for (let frame = 1; frame <= 60; frame++) {
        shooter.update(1 / 60, frame * 16, { sendInput: () => true });
        trace.push(shooter.recoilPitch);
      }
      shooter.dispose();
      return { trace, climb: aimAfter - aimBefore };
    };
    const rifleRecoil = recoilTrace(WEAPONS.rifle.weightKg);
    const lmgRecoil = recoilTrace(WEAPONS.lmg.weightKg);
    const peakFrame = (trace) => trace.indexOf(Math.max(...trace));
    const settledAt = (trace) => trace.findIndex((v, i) => i > peakFrame(trace) && Math.abs(v) < 0.002);
    ok(peakFrame(rifleRecoil.trace) >= 1
        && Math.max(...rifleRecoil.trace) > 0.015 && Math.max(...rifleRecoil.trace) < 0.022
        && rifleRecoil.climb > 0.002 && rifleRecoil.climb < 0.01
        && peakFrame(lmgRecoil.trace) >= peakFrame(rifleRecoil.trace)
        && settledAt(lmgRecoil.trace) > settledAt(rifleRecoil.trace)
        && Math.abs(rifleRecoil.trace.at(-1)) < 0.001,
    'camera recoil peaks after the shot at the requested kick, leaves an aim climb, and recovers slower for heavy guns');

    const zoomed = new LocalPlayer({ input, physics, sendHz: 20 });
    zoomed.setGameplayInputEnabled(true);
    const zoomCamera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
    zoomed.updateCamera(0.05, zoomCamera, { id: 'rifle', adsFov: 55 }, 0, 75);
    const hipScale = zoomed.lookScale;
    zoomCamera.fov = 18;
    zoomed.updateCamera(0.05, zoomCamera, { id: 'sniper', adsFov: 18 }, 1, 75);
    const scopedScale = zoomed.lookScale;
    input.consumeDelta = () => ({ dx: 0.1, dy: 0 });
    const yawBefore = zoomed.view.yaw;
    zoomed.update(1 / 60, 0, { sendInput: () => true });
    const yawTurned = yawBefore - zoomed.view.yaw;
    input.consumeDelta = () => ({ dx: 0, dy: 0 });
    zoomed.dispose();
    ok(hipScale === 1 && scopedScale > 0.15 && scopedScale < 0.25
        && Math.abs(yawTurned - 0.1 * scopedScale) < 1e-9,
    'look input scales with the live zoom so a 5x scope turns at about a fifth of hip speed');
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
        const isMelee = id === 'knife';
        const standingSightY = carried.getSightWorldPosition(new THREE.Vector3()).y + 0.29;
        valid &&= carried.id === id
          && carried.modelRoot?.name === `gun_${id}`
          && carried.modelRoot.parent === carried.root
          && carried.root.children.length === 1
          && carried.twoHanded === !!HANDS[id].support
          && bakedHands.length >= 1
          && bakedHands.every((hand) => hand.visible === false)
          && carried.adsT > 0.9
          && Number.isFinite(carried.root.position.y)
          && Number.isFinite(carried.root.rotation.x)
          // Melee carries no ballistic flash and its firing pose is the forward
          // stab lunge (forward = -z, with a slight pitch dip), not a gun sight.
          && (isMelee
            ? (carried._model.flash.mats.length === 0
              && carried.root.position.z < -0.05
              && carried.root.rotation.x < -0.02)
            : (carried._model.flash.grp.visible === !carried._model.T.continuous
              && Math.abs(standingSightY - 1.62) < 0.02));
      }
      ok(valid && hipMounts.size >= 4,
        'remote-avatar mounts preserve weapon-specific grips and align every ADS sight through firing and crouch');
    } finally {
      carried.dispose();
    }
  }

  // Throwables: shared launch/flight rules drive the preview, the local prediction, and
  // authority adoption so a thrown grenade never pops or double-spawns.
  {
    const {
      GRENADE_FUSE_MS, GRENADE_TYPES, grenadeLaunch, predictGrenadePath, stepGrenade,
    } = await import('../../shared/grenade-rules.js');
    const { rocketLaunch, stepRocket } = await import('../../shared/rocket-rules.js');
    const floor = (x, y) => y < 20;
    const launch = grenadeLaunch({
      x: 10, y: 20, z: 10, eyeY: 21.62, vx: 2, vy: 0, vz: 0,
      dir: { x: 0, y: 0.2, z: -0.98 }, charge: 1,
    });
    const weak = grenadeLaunch({
      x: 10, y: 20, z: 10, eyeY: 21.62, dir: { x: 0, y: 0.2, z: -0.98 }, charge: 0,
    });
    const strong = predictGrenadePath(launch, floor);
    const short = predictGrenadePath(weak, floor);
    const replay = { ...launch };
    for (let i = 0; i < 40 * (GRENADE_FUSE_MS / 1000); i++) stepGrenade(replay, 1 / 40, floor);
    ok(strong.points.length > 10 && strong.points.length <= 96
        && strong.landing[1] > 19.9 && strong.landing[1] < 20.6
        && Math.abs(strong.landing[2] - replay.z) < 0.05
        && (10 - short.landing[2]) < (10 - strong.landing[2]) * 0.7
        && launch.vx > weak.vx,
    'shared grenade rules predict a floor-bounded path that matches the integrator and scales with charge');

    const wall = (x) => x >= 1 && x < 2;
    const fast = { type: 'frag', x: 0, y: 3, z: 0, vx: 80, vy: 0, vz: 0 };
    stepGrenade(fast, 0.05, wall);
    ok(fast.x < 1 && fast.vx < 0 && fast.hitSolid,
      'fast grenades bounce off a one-voxel wall even in a slow frame');
    const resting = { type: 'frag', x: 0, y: 20.18, z: 0, vx: 1, vy: -0.1, vz: 0 };
    for (let i = 0; i < 120; i++) stepGrenade(resting, 1 / 60, floor);
    ok(Math.abs(resting.y - 20.16) < 0.002 && resting.vy === 0 && resting.vx === 0,
      'frag grenades settle flush on the floor without endless micro-bounces');

    const limpetLaunch = grenadeLaunch({
      x: 10, y: 20, z: 10, eyeY: 21.62, dir: { x: 0, y: -0.3, z: -0.95 }, charge: 1, type: 'limpet',
    });
    const limpetPath = predictGrenadePath(limpetLaunch, floor);
    const limpetReplay = { ...limpetLaunch };
    for (let i = 0; i < 80; i++) stepGrenade(limpetReplay, 1 / 40, floor);
    const pulseLaunch = grenadeLaunch({
      x: 10, y: 20, z: 10, eyeY: 21.62, dir: { x: 0, y: -0.3, z: -0.95 }, charge: 1, type: 'pulse',
    });
    const pulsePath = predictGrenadePath(pulseLaunch, floor);
    ok(limpetLaunch.type === 'limpet' && limpetPath.rests && limpetPath.landing[1] > 19.9
        && Math.abs(limpetReplay.vx) < 1e-9 && Math.abs(limpetReplay.vz) < 1e-9
        && pulsePath.rests && pulsePath.points.length < strong.points.length
        && GRENADE_TYPES.pulse.impact && GRENADE_TYPES.limpet.sticky,
    'sticky and impact throwables stop at their first contact in prediction and integration');

    const rocket = rocketLaunch({ x: 10, y: 21.62, z: 10, dir: { x: 0, y: 0, z: -1 } });
    const flight = { ...rocket };
    const raycast = (ox, oy, oz, dx, dy, dz, max) => (oz + dz * max <= 0
      ? { x: 10, y: 21, z: -1, t: Math.max(0, (oz - 0) / Math.max(1e-6, -dz)) }
      : null);
    let stepsToWall = 0;
    while (!flight.hit && stepsToWall < 200) { stepRocket(flight, 1 / 40, raycast); stepsToWall++; }
    ok(rocket.type === 'rocket' && rocket.vz < -40 && flight.hit && flight.z < 0.5 && flight.z > -0.5
        && stepsToWall > 5,
    'shared rocket rules fly a straight fast projectile that stops at the first voxel contact');

    const { ProjectileFX } = await import('../../public/js/weapons/projectiles.js');
    const scene = new THREE.Scene();
    const carriers = new Map([['p9', { x: 30, y: 20, z: 30 }]]);
    const fx = new ProjectileFX(scene, (x, y) => (y < 20 ? 1 : 0), {
      getEntityPosition: (id) => carriers.get(id) || null,
    });
    try {
      const preview = fx.setPreview(launch);
      const previewShown = fx.previewLine.visible && fx.landingRing.visible && preview?.points.length > 10;
      fx.setPreview(null);
      ok(previewShown && !fx.previewLine.visible && !fx.landingRing.visible,
        'grenade preview draws a dotted arc with a landing ring and hides on release');

      const o = [launch.x, launch.y, launch.z];
      const v = [launch.vx, launch.vy, launch.vz];
      fx.launch({ type: 'frag', o, v, fuse: GRENADE_FUSE_MS }, { local: true });
      fx.update(0.1);
      const pendingBefore = fx.pendingLocal;
      const projectilesBefore = fx.projectiles.size;
      fx.launch({ pid: 'g1', type: 'frag', o, v, fuse: GRENADE_FUSE_MS }, { fromSelf: true });
      const adopted = fx.projectiles.get('g1');
      ok(pendingBefore === 1 && projectilesBefore === 1 && fx.projectiles.size === 1
          && adopted && !adopted.local && fx.pendingLocal === 0,
        'the authority launch event adopts the pending local prediction instead of double-spawning');

      fx.launch({ pid: 'g2', type: 'frag', o, v, fuse: GRENADE_FUSE_MS }, { fromSelf: false });
      fx.launch({ type: 'frag', o, v, fuse: GRENADE_FUSE_MS }, { local: true });
      for (let i = 0; i < 25; i++) fx.update(0.05);
      ok(fx.projectiles.size === 2 && fx.pendingLocal === 0,
        'an unconfirmed local throw times out while authoritative grenades keep flying');
      fx.explode({ pid: 'g1', type: 'frag', x: 10, y: 20, z: 5, radius: 5.6 });
      ok(!fx.projectiles.has('g1') && fx.blasts.length === 1,
        'explosion removes the adopted projectile and spawns one blast');

      fx.launch({ pid: 'l1', type: 'limpet', o, v, fuse: 3500 });
      fx.stick({ pid: 'l1', x: 30.2, y: 21, z: 30.1, to: 'p9', fuse: 1500 });
      carriers.set('p9', { x: 34, y: 20, z: 30 });
      fx.update(0.05);
      const limpet = fx.projectiles.get('l1');
      ok(limpet?.stuck && limpet.stuckTo === 'p9' && Math.abs(limpet.x - 34.2) < 1e-6
          && Math.abs(limpet.fuse - (limpet.age + 1.5 - 0.05)) < 1e-6,
        'a limpet stuck to a player rides that carrier and re-arms its fuse from the stick event');

      fx.launch({ pid: 'r1', type: 'rocket', o: [rocket.x, rocket.y, rocket.z], v: [rocket.vx, rocket.vy, rocket.vz], fuse: 4000 }, { fromSelf: false });
      const rocketBefore = fx.projectiles.get('r1').z;
      fx.update(0.05);
      ok(fx.projectiles.get('r1').z < rocketBefore - 1.5,
        'a launched rocket flies straight along the shared integrator');
      fx.explode({ pid: 'r1', type: 'rocket', x: 10, y: 21, z: 0, radius: 4.8 });
      fx.explode({ pid: 'l1', type: 'pulse', x: 34, y: 21, z: 30, radius: 6.5 });
      ok(!fx.projectiles.has('r1') && !fx.projectiles.has('l1')
          && fx.blasts.slice(-2).every((blast) => blast.ring)
          && fx.blasts.at(-1).material.wireframe,
        'rocket and pulse blasts add the expanding shockwave ring');
    } finally {
      fx.dispose();
    }
  }

  // Viewmodel: every canonical weapon must build and survive a real update.
  // The generic magswap request resolves into the weapon's physical reload
  // profile, and the camera-independent turn follower respects weapon mass.
  {
    const { ViewmodelRig } = await import('../../public/js/guns/viewmodel.js');
    const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
    const rig = new ViewmodelRig(camera);
    rig.setWeapon('lance');
    rig.setCharge(0.2);
    rig.update(1 / 60, { speed: 0, grounded: true });
    const smallOrb = rig._chargeOrb.scale.x;
    const lowGlow = rig._cur.uni.uGlow.value;
    rig.setCharge(0.95);
    rig.update(1 / 60, { speed: 0, grounded: true });
    ok(rig._chargeOrb.visible && rig._chargeOrb.scale.x > smallOrb * 3
        && rig._cur.uni.uGlow.value > lowGlow,
      'rail energy orb and coil glow grow visibly with charge');
    rig.setCharge(0);
    rig.update(1 / 60, { speed: 0, grounded: true });
    ok(!rig._chargeOrb.visible && rig._cur.flash.light.intensity === 0,
      'release removes the charging orb and light');
    rig.setCharge(0.9);
    rig.setWeapon('rifle');
    ok(!rig._chargeOrb.visible,
      'weapon switching clears rail charging effects');

    const lagByWeapon = new Map();
    const maxSpeedByWeapon = new Map();
    try {
      for (const id of WEAPON_IDS) {
        camera.rotation.set(0, 0, 0);
        rig.setWeapon(id);
        rig.reload(2, 'magswap');

        rig.update(1 / 60, {
          speed: 2.4,
          grounded: true,
        });
        camera.rotation.set(0.2, -0.6, 0);
        rig.update(1 / 60, { speed: 2.4, grounded: true });
        lagByWeapon.set(id, Math.abs(rig.turnLag.yaw));
        maxSpeedByWeapon.set(id, rig.turnLag.maxSpeed);
        ok(rig._models[id]?.root.parent === rig.content
          && Number.isFinite(rig.posG.position.x)
          && Number.isFinite(rig.pivot.rotation.y),
        `${id} viewmodel builds, attaches, and updates to finite transforms`);
      }

      const muzzleProbe = (id) => {
        const model = rig._models[id];
        camera.rotation.set(0, 0, 0);
        rig.setWeapon(id);
        rig.ads(0);
        for (let frame = 0; frame < 60; frame++) {
          rig.update(1 / 60, { grounded: true, aimSwayScale: 0 });
        }
        rig.content.updateWorldMatrix(true, true);
        const tip = new THREE.Box3();
        for (const child of model.body.children) {
          if (child !== model.flash.grp && child !== model.muzzleMarker) tip.expandByObject(child);
        }
        return Math.abs(tip.min.z
          - model.muzzleMarker.getWorldPosition(new THREE.Vector3()).z) < 1e-4;
      };
      ok(muzzleProbe('lance'), 'lance emitter tip lands exactly on its T.muzzle anchor');
      ok(muzzleProbe('knife'), 'knife point lands exactly on its T.muzzle anchor');
      const knifeSight = Number(rig._models.knife.body.userData.sightHeight);
      ok(Number.isFinite(knifeSight) && knifeSight > 0 && knifeSight <= 0.05
        && rig._models.knife.flash.mats.length === 0 && rig._models.lance.flash.mats.length === 2,
        'knife declares a small sightHeight and ships flashless; lance keeps its muzzle flash');
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
        const opaqueHit = centerRay.intersectObject(rig.root, true).find(isRenderedOpaque);
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
          .find(isRenderedOpaque);
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
        lagByWeapon.get(byWeight[i - 1]) <= lagByWeapon.get(id)
        && maxSpeedByWeapon.get(byWeight[i - 1]) >= maxSpeedByWeapon.get(id)
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

      // ADS tightens the follower so the sight line stays usable while turning.
      const flickLag = (adsT) => {
        camera.rotation.set(0, 0, 0);
        rig.setWeapon('rifle');
        rig.ads(adsT);
        for (let frame = 0; frame < 120; frame++) rig.update(1 / 60, { grounded: true });
        let peak = 0;
        for (let frame = 0; frame < 20; frame++) {
          camera.rotation.y -= 0.05;
          rig.update(1 / 60, { grounded: true });
          peak = Math.max(peak, Math.abs(rig.turnLag.yaw));
        }
        return peak;
      };
      const hipLag = flickLag(0);
      const adsLag = flickLag(1);
      ok(hipLag > 0.1 && adsLag < hipLag * 0.4 && Number.isFinite(rig.turnLag.roll),
        'aiming down sights tightens the weapon follower to a fraction of its hip-fire lag');

      camera.rotation.set(0, 0, 0);
      rig.setWeapon('lmg');
      rig.ads(0);
      for (let frame = 0; frame < 60; frame++) rig.update(1 / 60, { grounded: true });
      const restX = rig.posG.position.x;
      for (let frame = 0; frame < 30; frame++) {
        rig.update(1 / 60, { grounded: true, speed: 6, lateralSpeed: 6 });
      }
      const strafeLean = rig.posG.position.x - restX;
      for (let frame = 0; frame < 90; frame++) rig.update(1 / 60, { grounded: true });
      ok(strafeLean < -0.01 && Math.abs(rig.posG.position.x - restX) < 0.002,
        'strafing right swings the carried gun left on a lagged spring that settles when stopped');

      // Grenade wind-up pulls the gun aside while held; release lunges and settles.
      camera.rotation.set(0, 0, 0);
      rig.setWeapon('rifle');
      for (let frame = 0; frame < 60; frame++) rig.update(1 / 60, { grounded: true });
      const restY = rig.content.position.y;
      rig.grenadeCharge(1);
      for (let frame = 0; frame < 40; frame++) rig.update(1 / 60, { grounded: true });
      const woundY = rig.content.position.y;
      rig.grenadeThrow(1);
      let minZ = Infinity;
      for (let frame = 0; frame < 30; frame++) {
        rig.update(1 / 60, { grounded: true });
        minZ = Math.min(minZ, rig.content.position.z + rig.posG.position.z);
      }
      for (let frame = 0; frame < 120; frame++) rig.update(1 / 60, { grounded: true });
      ok(woundY < restY - 0.04 && minZ < -0.02 + rig.content.position.z
          && Math.abs(rig.content.position.y - restY) < 0.003,
        'grenade hold winds the weapon down and aside, release lunges forward, and the pose settles');
    } finally {
      rig.dispose();
    }
  }

  {
    // Recoil recovery, reconciliation smoothing, scope zoom steps, and optic-scaled sway.
    const stubInput = () => new Proxy({
      wantAdsHeld: false,
      wantFireHeld: false,
      _delta: { dx: 0, dy: 0 },
      consumeDelta() { const d = this._delta; this._delta = { dx: 0, dy: 0 }; return d; },
      getKeys: () => ({ sprint: false, crouch: false }),
      setGameplayEnabled() {},
      consumeBuyMenuRequest: () => false,
      consumeWeaponSwitch: () => 0,
      consumeWeaponSlot: () => null,
      consumeLastWeaponRequest: () => false,
      consumeFireTap: () => false,
    }, { get: (target, key) => target[key] ?? (() => false) });
    const stubPhysics = () => ({
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      grounded: true,
      _crouching: false,
      step: () => false,
      eyeY: () => 1.62,
      setMapMeta() {},
    });
    const { LocalPlayer, fovForZoom } = await import('../../public/js/player/local-player.js');
    const rifle = WEAPONS.rifle;

    const recovering = new LocalPlayer({ input: stubInput(), physics: stubPhysics(), sendHz: 20 });
    recovering.setGameplayInputEnabled(true);
    recovering.update(1 / 60, 0, {});
    const before = recovering.view.pitch;
    let now = 0;
    for (let shot = 0; shot < 5; shot++) {
      recovering.addRecoil(0.02, 0.004, rifle.weightKg, rifle.recoil, now);
      now += 90;
      recovering.update(0.09, now, {});
    }
    const climbed = recovering.view.pitch - before;
    const climbPeak = recovering.view.pitch;
    // Inside resetMs nothing is walked back; afterwards the recovery fraction returns.
    now += 100;
    recovering.update(0.1, now, {});
    const heldClimb = recovering.view.pitch;
    for (let i = 0; i < 60; i++) {
      now += 1000 / 60;
      recovering.update(1 / 60, now, {});
    }
    const settled = recovering.view.pitch - before;
    ok(climbed > 0.017 && climbed < 0.019
        && Math.abs(heldClimb - climbPeak) < 1e-9
        && settled > climbed * (1 - rifle.recoil.recovery) - 1e-4
        && settled < climbed * (1 - rifle.recoil.recovery) + 1e-4,
    'aim climb holds during the spray, then the weapon recovery fraction walks back after resetMs');

    const compensating = new LocalPlayer({ input: stubInput(), physics: stubPhysics(), sendHz: 20 });
    compensating.setGameplayInputEnabled(true);
    compensating.update(1 / 60, 0, {});
    const start = compensating.view.pitch;
    compensating.addRecoil(0.02, 0, rifle.weightKg, rifle.recoil, 0);
    compensating.input._delta = { dx: 0, dy: 0.02 * 0.18 }; // pull straight down by the climb
    compensating.update(1 / 60, 20, {});
    const pulled = compensating.view.pitch;
    for (let i = 0; i < 60; i++) compensating.update(1 / 60, 500 + i * 16.7, {});
    ok(Math.abs(pulled - start) < 1e-9 && Math.abs(compensating.view.pitch - start) < 1e-9,
      'mouse compensation during the spray is never undone by recoil recovery');

    const reconciled = new LocalPlayer({ input: stubInput(), physics: stubPhysics(), sendHz: 20 });
    reconciled.setGameplayInputEnabled(true);
    const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
    reconciled.update(1 / 60, 0, {});
    reconciled.updateCamera(1 / 60, camera, rifle);
    reconciled.reconcile({ x: 0.6, y: 0, z: 0, hp: 100, state: 'alive' }, 1, {});
    const bodyMoved = reconciled.pos.x;
    reconciled.updateCamera(1 / 60, camera, rifle);
    const cameraAfterOneFrame = camera.position.x;
    for (let i = 0; i < 90; i++) reconciled.updateCamera(1 / 60, camera, rifle);
    ok(Math.abs(bodyMoved - 0.6 * 0.28) < 1e-9
        && cameraAfterOneFrame > 0 && cameraAfterOneFrame < bodyMoved * 0.4
        && Math.abs(camera.position.x - reconciled.pos.x) < 1e-3,
    'reconciliation corrects the body at once while the camera eases through the correction');

    reconciled.reconcile({ x: 10, y: 0, z: 0, hp: 100, state: 'alive' }, 2, {});
    reconciled.updateCamera(1 / 60, camera, rifle);
    const snapOffset = Math.hypot(
      reconciled.reconcileOffset.x, reconciled.reconcileOffset.y, reconciled.reconcileOffset.z,
    );
    ok(reconciled.pos.x === 10 && snapOffset > 0 && snapOffset <= 1.6 + 1e-9,
      'a hard snap lands on the authoritative position with a clamped camera ease');

    const sniper = WEAPONS.sniper;
    const zooming = new LocalPlayer({ input: stubInput(), physics: stubPhysics(), sendHz: 20 });
    zooming.setGameplayInputEnabled(true);
    zooming.updateCamera(1 / 60, camera, sniper, 1, 75);
    const fullZoom = zooming.scopeZoom;
    const stepped = zooming.cycleScopeZoom(sniper);
    zooming.updateCamera(1 / 60, camera, sniper, 1, 75);
    const halfFov = fovForZoom(stepped, 75);
    const restored = zooming.cycleScopeZoom(sniper);
    ok(fullZoom === sniper.zoom && stepped === sniper.zoom / 2 && restored === sniper.zoom
        && Math.abs(fovForZoom(sniper.zoom, 75) - 17.5) < 0.5 && halfFov > 30 && halfFov < 36
        && zooming.cycleScopeZoom(rifle) === sniper.zoom,
    'scope zoom steps alternate between full and half magnification and only the sniper has them');

    const { AimSway } = await import('../../public/js/player/aim-sway.js');
    const settle = (options) => {
      const sway = new AimSway();
      let out = null;
      for (let i = 0; i < 12; i++) out = sway.update(0.05, { stationary: true, grounded: true, ...options });
      return { yaw: out.yaw, pitch: out.pitch };
    };
    const hip = settle({});
    const scoped = settle({ ads: 1, zoom: 5 });
    const scopedHeld = settle({ ads: 1, zoom: 5, shift: true });
    const magnitude = (value) => Math.hypot(value.yaw, value.pitch);
    ok(magnitude(scoped) > magnitude(hip) * 2 && magnitude(scopedHeld) < magnitude(hip),
      'a 5x optic magnifies idle sway and holding breath still beats hip sway');

    const { WeaponState } = await import('../../public/js/guns/weapon-state.js');
    const rigCalls = [];
    const weaponState = new WeaponState({
      rig: {
        root: null,
        setWeapon() {}, fire: () => true, reload: (...args) => rigCalls.push(['reload', ...args]),
        cancelReload: () => rigCalls.push(['cancel']),
        getMuzzleWorldPos: () => ({ x: 0, y: 0, z: 0 }), pumpAnim() {}, boltAnim() {}, ads() {},
      },
      audio: { draw() {}, reloadClick() {}, fire() {} },
      effects: { shoot() {} },
      network: { isCurrentGeneration: () => true, isRunning: () => true },
      feedback: { addExhaustion() {}, addRecoil() {} },
      now: () => 0,
      random: () => 0.5,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    weaponState.resetToLoadout();
    weaponState.forceWeapon(WEAPON_IDS.indexOf('sniper'), { now: 0 });
    weaponState.forceWeapon(WEAPON_IDS.indexOf('shotgun'), { now: 0 });
    const previousSlot = weaponState._lastSlot;
    weaponState.deathReset();
    weaponState.respawn({ mode: 'ffa', now: 1000 });
    ok(weaponState.slot === WEAPON_IDS.indexOf('shotgun') && weaponState._lastSlot === previousSlot
      && weaponState.ammoOf('shotgun').mag === WEAPONS.shotgun.magSize,
      'respawn retains equipped and quick-swap weapons with fresh ammunition');
    weaponState.respawn({ mode: 'gungame', weapon: WEAPON_IDS.indexOf('rifle'), now: 2000 });
    ok(weaponState.slot === WEAPON_IDS.indexOf('rifle'), 'Gun Game respawn obeys its authoritative weapon');
    const { PlayerEntity } = await import('../../server/sim/player.js');
    const spawn = { x: 4, y: 20, z: 4, index: 0 };
    const entity = new PlayerEntity('respawn-contract', 'Test', spawn, false);
    entity.weapon = WEAPON_IDS.indexOf('shotgun');
    entity.applySpawn(spawn);
    ok(entity.weapon === WEAPON_IDS.indexOf('shotgun') && entity.deployT === WEAPONS.shotgun.deployTime,
      'server respawn keeps the equipped weapon and uses its deployment time');
    weaponState.menuReset();
    weaponState.resetToLoadout();
    weaponState.forceWeapon(WEAPON_IDS.indexOf('shotgun'), { now: 0 });
    weaponState._ammo.shotgun.mag = 2;
    weaponState.startReload(1000);
    const stages = WEAPONS.shotgun.reloadStages;
    weaponState.reconcileServer({ reloading: false, alive: true }, 1100);
    const survivedStaleSnapshot = weaponState.isReloading && weaponState.ammoOf('shotgun').mag === 2;
    weaponState.tickReload(1000 + (stages.start + stages.perRound * 2 + 0.02) * 1000);
    const twoSeated = weaponState.ammoOf('shotgun').mag === 4
      && weaponState.ammoOf('shotgun').reserve === WEAPONS.shotgun.spareMags - 1;
    weaponState.applyIntents({ fireTap: true }, 2000, { allowFire: true, alive: true });
    const fired = weaponState.tryFire(2000, {
      allowFire: true, alive: true, generation: 0,
    });
    ok(survivedStaleSnapshot && twoSeated && fired && !weaponState.isReloading
        && weaponState.ammoOf('shotgun').mag === 3
        && rigCalls.some((call) => call[0] === 'cancel')
        && rigCalls[0][2] === 'tube' && rigCalls[0][3]?.rounds === 5,
    'client tube reload mirrors the authority: staged seating, snapshot grace, and fire interrupt');
    weaponState.startReload(3000);
    weaponState.reconcileServer({ reloading: true, alive: true }, 3100);
    weaponState.reconcileServer({ reloading: false, alive: true }, 3200);
    ok(!weaponState.isReloading,
      'an authoritative not-reloading snapshot clears a previously acknowledged reload');
    weaponState.resetToLoadout();
    weaponState.forceWeapon(WEAPON_IDS.indexOf('rifle'), { mode: 'gungame', now: 0 });
    weaponState._ammo.rifle.mag = 0;
    const infiniteReserve = weaponState.ammoOf('rifle').reserve;
    weaponState.startReload(1000);
    weaponState.tickReload(10000);
    const reloadCallsBefore = rigCalls.filter((call) => call[0] === 'reload').length;
    weaponState.reconcileServer({ reloading: true, alive: true }, 10001);
    ok(!weaponState.isReloading && !weaponState.startReload(10002)
      && rigCalls.filter((call) => call[0] === 'reload').length === reloadCallsBefore,
      'late server reload snapshot does not replay a completed reload');
    weaponState.reconcileServer({ reloading: false, alive: true }, 10003);
    ok(weaponState.ammoOf('rifle').reserve === infiniteReserve
      && weaponState.ammoOf('rifle').mag === WEAPONS.rifle.magSize
      && weaponState.readModel().infiniteMagazines,
      'Gun Game client reload fills the magazine without consuming reserves');
    weaponState.forceWeapon(WEAPON_IDS.indexOf('shotgun'), { mode: 'fun', now: 0 });
    weaponState._ammo.shotgun.mag = 1;
    weaponState.startReload(11000);
    weaponState.applyIntents({ fireHeld: true }, 11100, { allowFire: true, alive: true });
    ok(!weaponState.tryFire(11100, { allowFire: true, alive: true, generation: 0 })
      && weaponState.isReloading && weaponState.ammoOf('shotgun').mag === 1,
      'holding fire through a tube reload does not interrupt or fire a stray round');
    weaponState.resetToLoadout();
    weaponState.forceWeapon(WEAPON_IDS.indexOf('knife'), { now: 3500 });
    weaponState.applyIntents({ fireTap: true }, 4600, { allowFire: true, alive: true });
    const swung = weaponState.tryFire(4600, { allowFire: true, alive: true, generation: 0 });
    const knifeAmmo = weaponState.ammoOf('knife');
    const cadenceBlocked = weaponState.tryFire(4700, { allowFire: true, alive: true, generation: 0 });
    const swingsAgain = weaponState.tryFire(5100, { allowFire: true, alive: true, generation: 0 });
    weaponState.applyIntents({ reload: true }, 5100, { allowFire: true, alive: true });
    ok(swung && !cadenceBlocked && swingsAgain && knifeAmmo.mag === 0
        && knifeAmmo.reserve === 0 && !weaponState.isReloading
        && weaponState.readModel(4600).charge01 === null,
    'a melee swing is free: no ammo consumed, no reload ever, and no charge readout');

    weaponState.resetToLoadout();
    weaponState.forceWeapon(WEAPON_IDS.indexOf('lance'), { now: 5800 });
    weaponState.applyIntents({ fireHeld: true }, 7000, { allowFire: true, alive: true });
    weaponState.tryFire(7000, { allowFire: true, alive: true, generation: 0 });
    const quarterCell = weaponState.readModel(7000 + WEAPONS.lance.charge.ms / 4).charge01;
    const threeQuarterCell = weaponState.readModel(
      7000 + (WEAPONS.lance.charge.ms * 3) / 4,
    ).charge01;
    ok(weaponState.isCharging && quarterCell > 0.2 && quarterCell < 0.3
        && threeQuarterCell > 0.7 && threeQuarterCell < 0.8
        && threeQuarterCell > quarterCell,
    'the lance charge readout climbs throughout the long hold');
    const frame = { allowFire: true, alive: true, generation: 0 };
    weaponState.applyIntents({ fireHeld: false }, 8400, frame);
    ok(weaponState.tryFire(8400, frame) && weaponState.ammoOf('lance').mag === 0
        && !weaponState.isCharging, 'early client rail release fires and spends the single cell');
    weaponState.resetToLoadout();
    weaponState.forceWeapon(WEAPON_IDS.indexOf('lance'), { now: 8800 });
    weaponState.applyIntents({ fireHeld: true }, 9500, frame);
    weaponState.tryFire(9500, frame);
    ok(!weaponState.tryFire(12299, frame) && weaponState.tryFire(12300, frame)
        && weaponState.ammoOf('lance').mag === 0,
      'held client rail automatically fires at 2800 ms and empties its single cell');
    weaponState.startReload(12600);
    weaponState.tickReload(15499);
    ok(weaponState.isReloading && weaponState.ammoOf('lance').mag === 0,
      'rail cell remains empty until the 2.9 second reload finishes');
    weaponState.tickReload(15500);
    ok(!weaponState.isReloading && weaponState.ammoOf('lance').mag === 1,
      'rail reload seats exactly one new shot');
    weaponState.forceWeapon(WEAPON_IDS.indexOf('longarc'), { now: 15000 });
    weaponState.applyIntents({ fireHeld: true }, 16000, frame);
    ok(weaponState.tryFire(16000, frame) && !weaponState.tryFire(16199, frame)
        && weaponState.tryFire(16200, frame) && weaponState.ammoOf('longarc').mag === 6,
      'held client Bounce fires every 200 ms without a charge or another tap');
    weaponState.dispose();

    const { AvatarWeaponModel } = await import('../../public/js/avatar/avatar-weapon.js');
    const remote = new AvatarWeaponModel();
    try {
      remote.update({ weapon: 'rifle', dt: 1 / 60 });
      for (let i = 0; i < 20; i++) remote.update({ weapon: 'rifle', reloading: true, dt: 1 / 60 });
      const reloadPose = remote.reloadT;
      const tiltedDown = remote.root.rotation.x < -0.2;
      for (let i = 0; i < 40; i++) remote.update({ weapon: 'rifle', reloading: false, dt: 1 / 60 });
      const recovered = remote.reloadT;
      remote.update({ weapon: 'lmg', dt: 1 / 60 });
      const drawing = remote.deployT < 1 && remote.modelRoot.rotation.x < 0;
      for (let i = 0; i < 60; i++) remote.update({ weapon: 'lmg', dt: 1 / 60 });
      ok(reloadPose > 0.8 && tiltedDown && recovered < 0.05 && drawing
          && remote.deployT === 1 && Math.abs(remote.modelRoot.rotation.x) < 1e-9,
      'remote avatars show reload and weapon-draw poses that settle back to the mount');
    } finally {
      remote.dispose();
    }

    const restoreSpectatorGlobals = installGlobals({
      document: { addEventListener() {}, removeEventListener() {} },
    });
    try {
      const { SpectatorCamera, KILL_CAM_MS } = await import('../../public/js/player/spectator-camera.js');
      const presentations = [];
      let clock = 0;
      const spectator = new SpectatorCamera({
        camera: new THREE.PerspectiveCamera(75, 1, 0.01, 100),
        raycast: () => null,
        now: () => clock,
        onPresent: (state) => presentations.push(state),
      });
      const players = [
        { id: 'me', state: 'dead', name: 'ME' },
        { id: 'a', state: 'alive', name: 'A', x: 0, y: 0, z: 0, yaw: 0 },
        { id: 'killer', state: 'alive', name: 'KILLER', x: 4, y: 0, z: 0, yaw: 0 },
      ];
      spectator.focusKiller('killer');
      spectator.sync({ self: players[0], players, match: { mode: 'fun', phase: 'live' }, serverNow: 0 });
      const onKiller = spectator.targetId === 'killer' && presentations.at(-1)?.killCam === true;
      clock = KILL_CAM_MS + 1;
      spectator.sync({ self: players[0], players, match: { mode: 'fun', phase: 'live' }, serverNow: 0 });
      const stillOnKiller = spectator.targetId === 'killer' && presentations.at(-1)?.killCam === false;
      spectator.cycle(1);
      ok(onKiller && stillOnKiller && spectator.targetId === 'a' && spectator.killCam === null,
        'kill cam opens on the killer, expires into normal spectating, and cycling clears it');
      spectator.dispose();
    } finally {
      restoreSpectatorGlobals();
    }
  }
}
