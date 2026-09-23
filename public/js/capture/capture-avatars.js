// Opt-in map capture actors (?avatars=1 on capture.html): a few static avatars
// standing in front of the shot camera, so character lighting, the light floor,
// rim and contact shadows can be reviewed against real map lighting. Capture
// only; never loaded by a match.

import * as THREE from '../vendor/three.module.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import { makeAvatar, updateAvatarStancePose, updateAvatarWeaponPose } from '../avatar/avatar.js';
import { prepareCharacterTree, setCharacterLightEnabled } from '../engine/character-light.js';

const SPOTS = Object.freeze([
  { distance: 3.6, side: -0.9, team: 'alpha', lift: 0 },
  { distance: 6.5, side: 1.3, team: 'bravo', lift: 0 },
  { distance: 10, side: -0.6, team: 'bravo', lift: 0 },
  { distance: 5.5, side: 2.9, team: 'alpha', lift: 1.1 },
]);
// ?melee=1: one more avatar at knife range, left of the viewmodel, unsnapped.
const MELEE_SPOT = Object.freeze({ distance: 1.25, side: -0.75, team: 'bravo', lift: 0, exact: true });

/** Feet height of a standable column top at or below `fromY`, or NaN. */
function standHeight(getBlock, x, z, fromY) {
  const cx = Math.floor(x), cz = Math.floor(z);
  for (let y = Math.floor(fromY); y >= 1; y--) {
    if (!isSolidBlock(getBlock(cx, y, cz))) continue;
    if (isSolidBlock(getBlock(cx, y + 1, cz)) || isSolidBlock(getBlock(cx, y + 2, cz))) return NaN;
    return y + 1;
  }
  return NaN;
}

/** Nearest cell centre within two cells whose 3x3 neighbourhood is level ground. */
function flatSpot(getBlock, x, z, fromY) {
  for (let r = 0; r <= 2; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = Math.floor(x) + dx + 0.5, cz = Math.floor(z) + dz + 0.5;
        const y = standHeight(getBlock, cx, cz, fromY);
        if (!Number.isFinite(y)) continue;
        let level = true;
        for (let nz = -1; nz <= 1 && level; nz++) {
          for (let nx = -1; nx <= 1; nx++) if (standHeight(getBlock, cx + nx, cz + nz, y + 1) !== y) { level = false; break; }
        }
        if (level) return { x: cx, y, z: cz };
      }
    }
  }
  return null;
}

/**
 * ?charlight=0 / ?blobs=0 render the same actors without character light or
 * blobs for A/B shots; ?blobscale=N widens the blobs for inspection;
 * ?viewmodel=1 also holds the rifle viewmodel in front of the camera;
 * ?melee=1 adds an avatar at knife range (it must keep its own light).
 */
export async function placeCaptureAvatars(worldview, camera, getBlock, params = new URLSearchParams()) {
  setCharacterLightEnabled(params.get('charlight') !== '0');
  if (params.get('blobs') === '0') worldview.contactShadows.strength = 0;
  const blobScale = Number(params.get('blobscale')) || 1;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const avatars = [];
  const spots = params.get('melee') === '1' ? [...SPOTS, MELEE_SPOT] : SPOTS;
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    const x = camera.position.x + forward.x * spot.distance + right.x * spot.side;
    const z = camera.position.z + forward.z * spot.distance + right.z * spot.side;
    const spot2 = spot.exact ? { x, y: standHeight(getBlock, x, z, camera.position.y + 1), z }
      : flatSpot(getBlock, x, z, camera.position.y + 2);
    if (spot2 && !Number.isFinite(spot2.y)) continue;
    if (!spot2) continue;
    const ground = spot2.y;
    const avatar = makeAvatar(`capture-${i}`, `CAPTURE ${i + 1}`, spot.team);
    avatar.tag.visible = false;
    avatar.hpSpr.visible = false;
    avatar.group.position.set(spot2.x, ground + spot.lift, spot2.z);
    const dx = camera.position.x - spot2.x, dz = camera.position.z - spot2.z;
    avatar.group.rotation.y = Math.atan2(-dx, -dz) + (i % 2 ? 0.35 : -0.3);
    for (let frame = 0; frame < 30; frame++) {
      updateAvatarWeaponPose(avatar, { weapon: 'rifle', dt: 1 / 60, blend: 1 });
      updateAvatarStancePose(avatar, { blend: 1 });
    }
    worldview.scene.add(avatar.group);
    prepareCharacterTree(avatar.group, false);
    avatars.push({ avatar, lift: spot.lift });
  }
  const roster = {
    addContactShadows(shadows) {
      for (const { avatar } of avatars) {
        const p = avatar.group.position;
        shadows.add(p.x, p.y, p.z, 0.58 * blobScale, 0.7);
      }
    },
  };
  if (params.get('viewmodel') === '1') {
    const { ViewmodelRig } = await import('../guns/viewmodel.js');
    const rig = new ViewmodelRig(camera);
    rig.setWeapon('rifle');
    rig.ads(0);
    const pose = { speed: 0, grounded: true, aimSwayScale: 0 };
    for (let frame = 0; frame < 300; frame++) rig.update(1 / 60, pose);
    worldview.addCharacterRoots(rig.root);   // under the camera, so it takes the probe
  }
  worldview.presentCharacters({ camera, dt: 0, roster, bodyPosition: null });
  return avatars.map(({ avatar }) => avatar.group.position.toArray().map(v => Math.round(v * 100) / 100));
}
