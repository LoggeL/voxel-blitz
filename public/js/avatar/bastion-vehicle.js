import * as THREE from '../vendor/three.module.js';
import { BASTION_ENEMIES } from '../../../shared/bastion.js';
import { disposeObjectTree } from '../engine/dispose.js';

// Vehicle presenter for Bastion rows with `npcVehicle:true`. Returns the avatar
// duck-type avatar-roster.js expects (group, head, torso, tag, hpSpr, material
// lists, limbStates) so the roster keeps position, opacity, hit flash, hp bar and
// the corpse pool, and skips the humanoid pose paths for `avatar.vehicle`.
// Bodies are metres with the origin at ground contact; forward is local -Z.
const SIGNAL = Object.freeze({ charging: 0xff5500, cooldown: 0x174052, ram: 0xffb020, deploy: 0xffb020 });
const DEATH_TILT = 0.35, DEATH_SECONDS = 0.6;

function sprite(resources, width, height) {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let ctx = null, texture = null;
  if (canvas) { canvas.width = 256; canvas.height = 64; ctx = canvas.getContext('2d'); texture = new THREE.CanvasTexture(canvas); resources.push(texture); }
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }); resources.push(material);
  const spr = new THREE.Sprite(material); spr.scale.set(width, height, 1);
  return { sprite: spr, ctx, texture };
}

export function makeVehicleAvatar(id, kind) {
  const profile = BASTION_ENEMIES[kind] ?? BASTION_ENEMIES.buggy ?? {};
  const look = profile.look ?? { suit: 0x8a8a8a, dark: 0x222222 };
  const combatBox = Array.isArray(profile.combatBox) ? profile.combatBox : [1, 0.8, 1];
  const group = new THREE.Group(), hull = new THREE.Group(); group.add(hull);
  const resources = [], bodyMaterials = [], baseColors = new Map();
  const material = (color, extra = {}, body = true) => {
    const m = new THREE.MeshStandardMaterial({ color, transparent: true, roughness: 0.6, metalness: 0.35, ...extra });
    resources.push(m); baseColors.set(m, new THREE.Color(color)); if (body) bodyMaterials.push(m); return m;
  };
  const mesh = (parent, geometry, mat, x, y, z) => { resources.push(geometry); const m = new THREE.Mesh(geometry, mat); m.position.set(x, y, z); parent.add(m); return m; };
  const box = (parent, w, h, d, mat, x, y, z) => mesh(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const wheel = (parent, r, x, y, z) => { const g = new THREE.CylinderGeometry(r, r, 0.3, 12); g.rotateZ(Math.PI / 2); const w = mesh(parent, g, dark, x, y, z); w.userData.radius = r; parts.wheels.push(w); return w; };
  const suit = material(look.suit), dark = material(look.dark), glass = material(0x8fb7c4, { roughness: 0.2, metalness: 0.7 });
  // Lit parts stay out of the flash list so a hit flash cannot wipe their glow.
  const signal = material(0x222222, { emissive: 0x000000, emissiveIntensity: 1.2 }, false);
  const parts = { wheels: [], legs: [], turret: null, signal, strobe: null, core: null, hatch: null };
  let torso, gun, topY;
  if (kind === 'apc') {
    torso = box(hull, 2.8, 1.2, 4.4, suit, 0, 1.05, 0);
    const glacis = box(hull, 2.8, 0.9, 1.0, suit, 0, 1.5, -2.2); glacis.rotation.x = 0.6;
    for (const x of [-1.45, 1.45]) box(hull, 0.15, 0.5, 4.0, dark, x, 0.55, 0);
    for (const x of [-1.5, 1.5]) for (const z of [-1.4, 0, 1.4]) wheel(hull, 0.45, x, 0.45, z);
    const turret = new THREE.Group(); turret.position.set(0, 1.9, -0.3); hull.add(turret); parts.turret = turret;
    box(turret, 1.2, 0.5, 1.2, dark, 0, 0, 0);
    const tube = new THREE.CylinderGeometry(0.12, 0.12, 1.1, 10); tube.rotateX(Math.PI / 2); gun = mesh(turret, tube, dark, 0.3, 0.05, -0.9);
    parts.hatch = material(0x5a1414, { emissive: 0xff2020, emissiveIntensity: 0.9 }, false);
    box(hull, 1.4, 0.8, 0.1, parts.hatch, 0, 1.0, 2.21);
    parts.strobe = material(0x332200, { emissive: 0xffb020, emissiveIntensity: 1.5 }, false);
    box(hull, 0.2, 0.15, 0.2, parts.strobe, 0, 2.25, 0.4);
    box(hull, 0.5, 0.12, 0.2, signal, 0, 1.75, -2.3);
    topY = 2.4;
  } else if (kind === 'walker') {
    torso = box(hull, 2.4, 1.6, 2.2, suit, 0, 2.6, 0);
    box(hull, 1.2, 0.2, 0.1, glass, 0, 2.95, -1.12);
    for (const x of [-0.95, 0.95]) box(hull, 0.4, 0.4, 1.2, dark, x, 2.3, -0.9);
    const tube = new THREE.CylinderGeometry(0.06, 0.06, 0.6, 8); tube.rotateX(Math.PI / 2); gun = mesh(hull, tube, dark, 0.95, 2.3, -1.7);
    parts.core = material(0x3a1a00, { emissive: 0xff7a00, emissiveIntensity: 1.2 }, false);
    box(hull, 0.6, 0.6, 0.3, parts.core, 0, 2.6, 1.25);
    box(hull, 0.3, 0.1, 0.3, signal, 0, 3.45, -0.8);
    for (const [i, [x, z]] of [[-1.1, -0.8], [1.1, 0.8], [-1.1, 0.8], [1.1, -0.8]].entries()) {
      const side = Math.sign(x), hip = new THREE.Group(); hip.position.set(x, 2.5, z); hull.add(hip);
      const upper = new THREE.Group(); upper.rotation.z = side * 0.75; hip.add(upper);
      box(upper, 0.35, 1.6, 0.35, dark, 0, -0.8, 0);
      const knee = new THREE.Group(); knee.position.set(0, -1.6, 0); knee.rotation.z = -side * 0.4; upper.add(knee);
      box(knee, 0.3, 1.4, 0.3, suit, 0, -0.7, 0);
      box(knee, 0.5, 0.2, 0.6, dark, 0, -1.45, 0);
      parts.legs.push({ hip, upper, knee, phaseOffset: i * Math.PI });
    }
    topY = 3.4;
  } else {
    torso = box(hull, 2.0, 0.6, 2.8, suit, 0, 0.65, 0);
    box(hull, 1.2, 0.6, 1.2, glass, 0, 1.25, -0.2);
    for (const x of [-0.6, 0.6]) for (const z of [-0.55, 0.55]) box(hull, 0.08, 0.7, 0.08, dark, x, 1.3, z);
    for (const z of [-0.55, 0.55]) box(hull, 1.3, 0.08, 0.08, dark, 0, 1.65, z);
    for (const x of [-1.05, 1.05]) for (const z of [-0.95, 0.95]) wheel(hull, 0.38, x, 0.38, z);
    const barrel = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8); barrel.rotateX(Math.PI / 2);
    const gunMount = new THREE.Group(); gunMount.position.set(0, 1.75, -0.4); hull.add(gunMount); parts.turret = gunMount;
    gun = mesh(gunMount, barrel, dark, 0, 0, -0.2);
    box(hull, 0.4, 0.1, 0.1, signal, 0, 1.0, -1.42);
    topY = 1.85;
  }
  const head = new THREE.Object3D(); head.position.y = topY; group.add(head);
  const labelY = combatBox[1] * 2;
  const tagRes = sprite(resources, 1.6, 0.4); tagRes.sprite.position.set(0, labelY + 0.6, 0); group.add(tagRes.sprite);
  if (tagRes.ctx) {
    const c = tagRes.ctx; c.fillStyle = 'rgba(8,10,14,.55)'; c.fillRect(16, 8, 224, 48);
    c.font = 'bold 28px Rajdhani, Arial Narrow, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 3; c.strokeStyle = '#000'; c.strokeText(profile.name ?? String(kind).toUpperCase(), 128, 33);
    c.fillStyle = '#fff'; c.fillText(profile.name ?? String(kind).toUpperCase(), 128, 33);
  }
  const hpRes = sprite(resources, 1.2, 0.3); hpRes.sprite.position.set(0, labelY + 0.35, 0); group.add(hpRes.sprite);
  const empty = () => new THREE.Object3D();
  const muzzle = new THREE.Vector3();
  const avatar = {
    id, name: profile.name ?? kind, kind, vehicle: true, bodyScale: 1, alive: false, team: 'bravo',
    group, hull, head, torso, hips: empty(), lLeg: empty(), rLeg: empty(), lArm: empty(), rArm: empty(), lElbow: empty(), rElbow: empty(),
    weaponModel: {
      root: new THREE.Object3D(), reloadT: 0, update() {}, resetPose() {}, stopDeathEffects() {}, dispose() {},
      getMuzzleWorldPosition(v = muzzle) { gun.updateWorldMatrix(true, false); return v.set(0, 0, -0.35).applyMatrix4(gun.matrixWorld); },
    },
    tag: tagRes.sprite, hpSpr: hpRes.sprite, limbStates: [], parts,
    fadeMaterials: [...bodyMaterials], flashMaterials: [...bodyMaterials],
    deathT: 0, deathForcedUntil: 0, hitT: 0, hitSide: 1, lastImpact: null, lastHp: null, motionSeeded: false,
    px: 0, pz: 0, py: null, lastYaw: null, moveSpeed: 0, phase: 0, wheelAngle: 0, disguised: false,
    updateHealth(t01) {
      if (!hpRes.ctx) return;
      const c = hpRes.ctx; c.clearRect(0, 0, 256, 64); c.fillStyle = '#10141a'; c.fillRect(0, 52, 256, 12);
      c.fillStyle = t01 > 0.5 ? '#7fd069' : t01 > 0.25 ? '#ffb340' : '#ff3355';
      c.fillRect(0, 52, Math.max(0, Math.round(256 * Math.max(0, Math.min(1, t01)))), 12); hpRes.texture.needsUpdate = true;
    },
    /** Fresh spawn: level hull, bright paint, labels back. */
    reset() {
      avatar.alive = true; avatar.deathT = 0; avatar.deathForcedUntil = 0; avatar.hitT = 0; avatar.motionSeeded = false; avatar.lastImpact = null;
      hull.rotation.set(0, 0, 0); group.visible = true; group.rotation.set(0, 0, 0); group.scale.set(1, 1, 1);
      for (const [m, base] of baseColors) { m.color.copy(base); m.opacity = 1; }
      tagRes.sprite.visible = true; hpRes.sprite.visible = true;
    },
    /** Death without limb physics: the hull keeps its world pose and tilts over in update(). */
    beginDeath() {
      if (!avatar.alive) return false;
      avatar.alive = false; avatar.deathT = 0; avatar.hitT = 0; tagRes.sprite.visible = false; hpRes.sprite.visible = false;
      avatar.hips.position.copy(group.position); avatar.moveSpeed = 0; return true;
    },
    update(dt = 0, remote = null) {
      const step = Math.max(0, Math.min(dt, 0.1));
      if (remote && avatar.alive) {
        const travelled = avatar.motionSeeded ? Math.hypot(remote.x - avatar.px, remote.z - avatar.pz) : 0;
        avatar.px = remote.x; avatar.pz = remote.z; avatar.motionSeeded = true;
        const speed = Number.isFinite(remote.moveSpeed) ? remote.moveSpeed : step > 0 ? travelled / step : 0;
        avatar.moveSpeed += (Math.min(12, speed) - avatar.moveSpeed) * (1 - Math.exp(-step * 8));
        avatar.wheelAngle += travelled;
        for (const w of parts.wheels) w.rotation.x = avatar.wheelAngle / w.userData.radius;
        avatar.phase += avatar.moveSpeed * 3.2 * step;
        const gait = Math.min(1, avatar.moveSpeed / 1.5);
        for (const leg of parts.legs) { const s = Math.sin(avatar.phase + leg.phaseOffset) * 0.5 * gait; leg.hip.rotation.x = s; leg.knee.rotation.x = -s * 0.8; }
        signal.emissive.setHex(SIGNAL[remote.npcAttack] ?? 0x000000);
        avatar.hips.position.copy(group.position);
      } else if (!avatar.alive) {
        avatar.deathT += step;
        const t = Math.min(1, avatar.deathT / DEATH_SECONDS), ease = 1 - (1 - t) * (1 - t);
        hull.rotation.z = DEATH_TILT * ease;
        for (const [m, base] of baseColors) m.color.copy(base).multiplyScalar(1 - 0.6 * ease);
        signal.emissive.setHex(0x000000);
        for (const leg of parts.legs) { leg.hip.rotation.x *= 1 - ease; leg.knee.rotation.x *= 1 - ease; }
      }
      const clock = avatar.phase + avatar.deathT;
      if (parts.strobe) parts.strobe.emissiveIntensity = avatar.alive && (Date.now() % 1000) < 120 ? 2.4 : 0.15;
      if (parts.core) parts.core.emissiveIntensity = avatar.alive ? 0.9 + 0.6 * Math.abs(Math.sin(clock * 2 + Date.now() / 400)) : 0.1;
      // Lit parts follow the hull's fade even though the roster never lists them.
      const opacity = suit.opacity;
      for (const m of [signal, parts.strobe, parts.core, parts.hatch]) if (m) m.opacity = opacity;
    },
    dispose() {
      disposeObjectTree(group); group.removeFromParent(); parts.wheels.length = 0; parts.legs.length = 0;
    },
  };
  avatar.updateHealth(1);
  return avatar;
}
