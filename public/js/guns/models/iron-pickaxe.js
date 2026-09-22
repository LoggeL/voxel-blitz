import * as THREE from '../../vendor/three.module.js';

// IRON PICK: an original 16x16 item sprite in the blocky-survival item style,
// extruded one pixel thick like a held inventory item. Column c runs toward the
// head (+forward), row r runs down. The crescent is mirror-symmetric about the
// handle diagonal (c + r = 15); shading is lit from the top left.
//   O d m l h  head outline / dark / mid / light / highlight
//   o w W      handle outline / dark / light
export const PICKAXE_GRID = Object.freeze([
  '................',
  '...OOOOOO.......',
  '..OlhhlllOO.....',
  '.OlddddmmlhOO...',
  '.OdOOOOddmmlO...',
  '.OO....OOdmmmO..',
  '.........OlmdO..',
  '........WoOhmdO.',
  '.......Ww.OlmdO.',
  '......Ww...OhdO.',
  '.....wW....OldO.',
  '....Ww.....OldO.',
  '...Ww......OldO.',
  '..Ww......OldO..',
  '.Ww.......OOO...',
  'oo..............',
]);

export const PICKAXE_ROLES = Object.freeze({
  O: 'head-outline', d: 'head-dark', m: 'head-mid', l: 'head-light', h: 'head-highlight',
  o: 'handle-outline', w: 'handle-dark', W: 'handle-light',
});

// Stable palette keys: skins tint by these exact hex values (never 0xffffff,
// never the glove keys 0x22252a / 0x15171a / 0xb09a72).
export const IRON_PALETTE = Object.freeze({
  'head-outline': 0x383a3e, 'head-dark': 0x6c7076, 'head-mid': 0xa6aaaf,
  'head-light': 0xd2d5d8, 'head-highlight': 0xf0f1ee,
  'handle-outline': 0x3a2811, 'handle-dark': 0x664a23, 'handle-light': 0x9a7641,
});
// [roughness, metalness]: forged iron stays bright under the arena's flat lights.
const FINISH = Object.freeze({ head: [0.5, 0.32], handle: [0.92, 0.0] });

/** Tilt of the sprite in the y-z plane: the handle leans 20 degrees forward
 * of vertical, the head arcs over the top with its lower point reaching ahead. */
export const PICKAXE_TILT = 25 * Math.PI / 180;
// Fist centre on the sprite (continuous pixel coords): between the light and
// dark stick pixels of row 12, three pixels above the butt.
const GRIP_PIXEL = Object.freeze([4, 12.5]);
// StatTrak plate seat: the flat two-pixel fill band of the rear head arm.
const PLATE_PIXEL = Object.freeze([6.5, 3]);

const geometries = new Map();

/** Sprite point (x right, y down, pixel units) -> [forward, up] around the grip. */
function tilt(x, y) {
  const u = x - GRIP_PIXEL[0], v = GRIP_PIXEL[1] - y;
  const c = Math.cos(PICKAXE_TILT), s = Math.sin(PICKAXE_TILT);
  return [u * c - v * s, u * s + v * c];
}

function cells() {
  const out = [];
  PICKAXE_GRID.forEach((row, r) => [...row].forEach((key, c) => {
    if (PICKAXE_ROLES[key]) out.push({ c, r, role: PICKAXE_ROLES[key] });
  }));
  return out;
}

/** Page-owned merged geometry per role: front/back faces for every pixel plus
 * only the side faces that border empty sprite space. */
function spriteGeometry(grip, tipZ, centerX) {
  const key = [grip.x, grip.y, grip.z, tipZ, centerX].join('|');
  if (geometries.has(key)) return geometries.get(key);
  const filled = cells();
  const solid = new Set(filled.map(({ c, r }) => c + ',' + r));
  let reach = 0;
  for (const { c, r } of filled) for (const [x, y] of [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]]) {
    reach = Math.max(reach, tilt(x, y)[0]);
  }
  const pixel = (grip.z - tipZ) / reach;
  const half = pixel / 2;
  const point = (x, y, side) => {
    const [f, u] = tilt(x, y);
    return new THREE.Vector3(centerX + side * half, grip.y + u * pixel, grip.z - f * pixel);
  };
  const buffers = new Map();
  const quad = (role, corners, normal) => {
    if (!buffers.has(role)) buffers.set(role, { position: [], normal: [] });
    const out = buffers.get(role);
    const [a, b, c, d] = corners;
    const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const order = cross.dot(normal) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
    for (const v of order) { out.position.push(v.x, v.y, v.z); out.normal.push(normal.x, normal.y, normal.z); }
  };
  // Outward side normal for a sprite direction (dx right, dy up).
  const side = (dx, dy) => {
    const c = Math.cos(PICKAXE_TILT), s = Math.sin(PICKAXE_TILT);
    return new THREE.Vector3(0, dx * s + dy * c, -(dx * c - dy * s));
  };
  let tip = null;
  for (const { c, r, role } of filled) {
    for (const s of [1, -1]) {
      quad(role, [point(c, r, s), point(c + 1, r, s), point(c + 1, r + 1, s), point(c, r + 1, s)],
        new THREE.Vector3(s, 0, 0));
    }
    const edges = [
      [0, -1, [c, r], [c + 1, r]], [0, 1, [c, r + 1], [c + 1, r + 1]],
      [-1, 0, [c, r], [c, r + 1]], [1, 0, [c + 1, r], [c + 1, r + 1]],
    ];
    for (const [dc, dr, p, q] of edges) {
      if (solid.has((c + dc) + ',' + (r + dr))) continue;
      quad(role, [point(...p, 1), point(...q, 1), point(...q, -1), point(...p, -1)], side(dc, -dr));
    }
    for (const [x, y] of [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]]) {
      const at = point(x, y, 0);
      if (!tip || at.z < tip.z - 1e-9) tip = at;
    }
  }
  const byRole = {};
  for (const [role, { position, normal }] of buffers) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.userData.pageOwned = true;
    byRole[role] = geometry;
  }
  const plate = point(...PLATE_PIXEL, 0);
  const built = { byRole, pixel, tip, plate: { x: plate.x, y: plate.y, z: plate.z, rx: PICKAXE_TILT } };
  geometries.set(key, built);
  return built;
}

/**
 * Build the iron pickaxe into `body`: one merged mesh per palette role under the
 * `pickaxe_head` / `pickaxe_handle` groups (eight draws). The handle passes through
 * `grip`; the forward-most vertex lands exactly on `tipZ` (the T.muzzle plane).
 */
export function buildIronPickaxe({ kit, body, grip, tipZ, centerX = grip.x / 2 }) {
  const { byRole, pixel, tip, plate } = spriteGeometry(grip, tipZ, centerX);
  const head = new THREE.Group(); head.name = 'pickaxe_head';
  const handle = new THREE.Group(); handle.name = 'pickaxe_handle';
  for (const [role, geometry] of Object.entries(byRole)) {
    const [rough, metal] = role.startsWith('head') ? FINISH.head : FINISH.handle;
    const mesh = new THREE.Mesh(geometry, kit.mat(IRON_PALETTE[role], rough, metal));
    mesh.name = `pickaxe_${role}`;
    mesh.userData.pickaxeRole = role;
    (role.startsWith('head') ? head : handle).add(mesh);
  }
  const marker = new THREE.Object3D(); marker.name = 'pickaxe_tip';
  marker.position.copy(tip);
  head.add(marker);
  body.add(handle, head);
  body.userData.pickaxe = { palette: 'iron', roles: IRON_PALETTE, pixel, tip: marker, plate };
  body.userData.proceduralAsset = 'iron-pickaxe';
  return { head, handle, tip: marker, pixel };
}
