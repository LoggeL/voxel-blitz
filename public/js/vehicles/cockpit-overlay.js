// First-person cockpit dressing: thin canopy frames, instrument panels with
// lit displays, sticks and gauges that the 0.2 m voxel hulls cannot show up
// close. VehicleView builds one only for the local player's own hull while its
// camera is in the cockpit view (VehicleCamera), parented to the model body in
// the hull frame, so other players and every exterior shot keep the voxel
// model alone. Presentation only. Design reference:
// docs/design/conquest/views/cockpit-reference.jpg.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/utils/BufferGeometryUtils.js';

const FRAME = 0x1b1f22, PANEL = 0x24282b, COAMING = 0x141618, GRIP = 0x101112, CONSOLE = 0x2c3134;
/** Display atlas tiles (4 x 2 grid of 128 px squares). */
const TILE = Object.freeze({ radar: 0, attitude: 1, gauge: 2, rpm: 3, caution: 4, map: 5 });

const UP = new THREE.Vector3(0, 1, 0);

function colored(geometry, hex) {
  const color = new THREE.Color(hex), count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Collects frame boxes and display quads in the hull frame, then merges them per material. */
class OverlayBuilder {
  constructor() { this.solids = []; this.screens = []; this.glass = []; }

  /** Axis-aligned box from min to max corner. */
  slab(min, max, hex = PANEL) {
    const size = [0, 1, 2].map(i => Math.max(0.005, max[i] - min[i]));
    const geometry = new THREE.BoxGeometry(...size);
    geometry.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    this.solids.push(colored(geometry, hex));
  }

  /** A square-section tube from a to b. */
  bar(a, b, width = 0.045, hex = FRAME) {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const length = from.distanceTo(to);
    if (length < 1e-4) return;
    const geometry = new THREE.BoxGeometry(width, length, width);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, to.clone().sub(from).normalize());
    geometry.applyQuaternion(quaternion);
    geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.solids.push(colored(geometry, hex));
  }

  /** Elliptic arch in the x-y plane at depth z: centre [x, y], radii [rx, ry], from angle a0 to a1. */
  arch(z, [cx, cy], [rx, ry], { from = 0, to = Math.PI, segments = 10, width = 0.05 } = {}) {
    for (let i = 0; i < segments; i++) {
      const t0 = from + (to - from) * i / segments, t1 = from + (to - from) * (i + 1) / segments;
      this.bar([cx + rx * Math.cos(t0), cy + ry * Math.sin(t0), z], [cx + rx * Math.cos(t1), cy + ry * Math.sin(t1), z], width);
    }
  }

  /** A lit display facing +z (toward the crew), showing one atlas tile, optionally tilted back. */
  screen([x, y, z], [w, h], tile, tilt = 0) {
    const geometry = new THREE.PlaneGeometry(w, h);
    const u0 = (tile % 4) / 4, v0 = 1 - (Math.floor(tile / 4) + 1) / 2;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) / 4, v0 + uv.getY(i) / 2);
    if (tilt) geometry.rotateX(-tilt);
    geometry.translate(x, y, z);
    this.screens.push(geometry);
  }

  /** A transparent pane (head-up display combiner). */
  pane([x, y, z], [w, h], tilt = 0) {
    const geometry = new THREE.PlaneGeometry(w, h);
    if (tilt) geometry.rotateX(-tilt);
    geometry.translate(x, y, z);
    this.glass.push(geometry);
  }

  build(name, materials) {
    const group = new THREE.Group();
    group.name = name;
    for (const [list, material, label] of [[this.solids, materials.solid, 'frame'], [this.screens, materials.screen, 'displays'],
      [this.glass, materials.glass, 'glass']]) {
      if (!list.length) continue;
      const merged = mergeGeometries(list.map(geometry => geometry.index ? geometry.toNonIndexed() : geometry));
      for (const geometry of list) geometry.dispose();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}-${label}`;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.renderOrder = label === 'glass' ? 3 : 0;
      group.add(mesh);
    }
    return group;
  }
}

/** Per hull: the cockpit dressing in hull metres (the seat eyes are in shared/vehicle-defs seatCameras). */
const BUILDERS = {
  plane(b) {
    // Canopy bow arching over the eye line, sills and the aft hoop.
    b.arch(-2.0, [0, 1.8], [0.44, 0.72], { segments: 12, width: 0.05 });
    for (const x of [-0.44, 0.44]) b.bar([x, 1.8, -2.0], [x, 1.8, -0.5], 0.05);
    b.arch(-0.5, [0, 1.8], [0.44, 0.76], { segments: 10, width: 0.07 });
    // Panel high under the bow (the displays sit in the lower view), glare
    // shield, two displays and the up-front controller.
    b.slab([-0.38, 1.5, -2.02], [0.38, 1.88, -1.96], PANEL);
    b.slab([-0.4, 1.88, -2.08], [0.4, 1.93, -1.86], COAMING);
    b.screen([-0.2, 1.7, -1.955], [0.2, 0.2], TILE.radar);
    b.screen([0.2, 1.7, -1.955], [0.2, 0.2], TILE.attitude);
    b.screen([0, 1.72, -1.955], [0.12, 0.14], TILE.caution);
    // Head-up display: two short posts and the combiner glass.
    for (const x of [-0.08, 0.08]) b.bar([x, 1.93, -1.92], [x, 2.06, -1.96], 0.014);
    b.pane([0, 2.0, -1.94], [0.16, 0.13], 0.25);
    // Side consoles, the stick under the right hand and the throttle under the left.
    for (const side of [-1, 1]) b.slab([side < 0 ? -0.42 : 0.3, 1.3, -1.9], [side < 0 ? -0.3 : 0.42, 1.5, -0.9], CONSOLE);
    b.bar([0.27, 1.24, -1.58], [0.27, 1.5, -1.62], 0.04, GRIP);
    b.bar([-0.33, 1.5, -1.42], [-0.3, 1.56, -1.6], 0.05, GRIP);
  },
  helicopter(b) {
    // Instrument panel across both seats with a coaming lip, two displays each.
    b.slab([-0.62, 1.42, -2.02], [0.62, 1.78, -1.97], PANEL);
    b.slab([-0.64, 1.78, -2.06], [0.64, 1.83, -1.86], COAMING);
    b.screen([-0.47, 1.6, -1.965], [0.2, 0.2], TILE.radar);
    b.screen([-0.24, 1.6, -1.965], [0.2, 0.2], TILE.attitude);
    b.screen([0.24, 1.6, -1.965], [0.2, 0.2], TILE.map);
    b.screen([0.47, 1.6, -1.965], [0.2, 0.2], TILE.radar);
    b.screen([0, 1.62, -1.965], [0.13, 0.13], TILE.caution);
    // Pilot cyclic and collective; the gunner's sight hood between his grips.
    b.bar([-0.36, 1.05, -1.32], [-0.36, 1.57, -1.35], 0.04, GRIP);
    b.bar([-0.6, 1.2, -0.72], [-0.66, 1.53, -0.98], 0.045, GRIP);
    b.slab([0.27, 1.6, -1.64], [0.45, 1.78, -1.46], CONSOLE);
    b.screen([0.36, 1.69, -1.455], [0.14, 0.12], TILE.radar);
  },
  transport(b) {
    b.slab([-0.8, 1.6, -2.64], [0.8, 1.65, -2.3], COAMING);
    b.screen([-0.52, 1.42, -2.395], [0.22, 0.2], TILE.attitude);
    b.screen([-0.24, 1.42, -2.395], [0.2, 0.2], TILE.map);
    b.screen([0.24, 1.42, -2.395], [0.2, 0.2], TILE.radar);
    b.screen([0.52, 1.42, -2.395], [0.22, 0.2], TILE.attitude);
    b.screen([0, 1.21, -1.995], [0.16, 0.14], TILE.caution, Math.PI / 2 - 0.5);
    b.bar([-0.36, 0.72, -1.3], [-0.36, 1.57, -1.35], 0.04, GRIP);
    b.bar([-0.62, 0.9, -0.72], [-0.66, 1.53, -0.98], 0.045, GRIP);
  },
  jeep(b) {
    // A dash plate under the cowl with the two round gauges.
    b.slab([-0.8, 1.12, -0.42], [0.8, 1.4, -0.38], PANEL);
    b.screen([0.02, 1.27, -0.375], [0.15, 0.15], TILE.gauge);
    b.screen([0.22, 1.27, -0.375], [0.15, 0.15], TILE.rpm);
  },
};

let atlas = null;
/** The display atlas (canvas texture), drawn once; null without a DOM (Node tests). */
function displayAtlas() {
  if (atlas !== null) return atlas || null;
  const canvas = globalThis.document?.createElement?.('canvas');
  const g = canvas?.getContext?.('2d');
  if (!g || typeof g.arc !== 'function' || typeof g.fillRect !== 'function') { atlas = false; return null; }
  canvas.width = 512; canvas.height = 256;
  const S = 128, green = '#59f08a', dim = '#1f5c35';
  const tile = (index, draw) => {
    const x = (index % 4) * S, y = Math.floor(index / 4) * S;
    g.save(); g.translate(x, y);
    g.fillStyle = '#04120a'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#0d2a18'; g.lineWidth = 6; g.strokeRect(3, 3, S - 6, S - 6);
    draw(); g.restore();
  };
  tile(TILE.radar, () => {
    g.strokeStyle = green; g.lineWidth = 2;
    for (const r of [18, 36, 54]) { g.beginPath(); g.arc(64, 64, r, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(64, 8); g.lineTo(64, 120); g.moveTo(8, 64); g.lineTo(120, 64); g.stroke();
    g.fillStyle = green; for (const [x, y] of [[84, 40], [44, 50], [90, 82]]) g.fillRect(x - 3, y - 3, 6, 6);
    g.strokeStyle = '#a8ffc6'; g.beginPath(); g.moveTo(64, 64); g.lineTo(108, 28); g.stroke();
  });
  tile(TILE.attitude, () => {
    g.fillStyle = '#0b3a5c'; g.fillRect(10, 10, 108, 52); g.fillStyle = '#4a3418'; g.fillRect(10, 62, 108, 56);
    g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(10, 62); g.lineTo(118, 62); g.stroke();
    for (const dy of [-24, -12, 12, 24]) { g.beginPath(); g.moveTo(50, 62 + dy); g.lineTo(78, 62 + dy); g.stroke(); }
    g.strokeStyle = '#ffd34d'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(34, 64); g.lineTo(56, 64); g.lineTo(64, 72); g.lineTo(72, 64); g.lineTo(94, 64); g.stroke();
  });
  const dial = (index, needle) => tile(index, () => {
    g.fillStyle = '#101214'; g.fillRect(0, 0, S, S);
    g.fillStyle = '#1c1f22'; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d9dde0'; g.lineWidth = 3;
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (0.75 + i * 1.5 / 8);
      g.beginPath(); g.moveTo(64 + Math.cos(a) * 44, 64 + Math.sin(a) * 44); g.lineTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54); g.stroke();
    }
    g.strokeStyle = '#ff6a3d'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.cos(needle) * 46, 64 + Math.sin(needle) * 46); g.stroke();
  });
  dial(TILE.gauge, Math.PI * 1.55);
  dial(TILE.rpm, Math.PI * 1.15);
  tile(TILE.caution, () => {
    const colors = ['#59f08a', '#59f08a', '#ffd34d', '#59f08a', '#ff5a3d', '#59f08a', '#59f08a', '#59f08a', '#ffd34d'];
    colors.forEach((color, i) => { g.fillStyle = color; g.fillRect(14 + (i % 3) * 36, 14 + Math.floor(i / 3) * 36, 28, 26); });
  });
  tile(TILE.map, () => {
    g.strokeStyle = dim; g.lineWidth = 1;
    for (let i = 16; i < S; i += 16) { g.beginPath(); g.moveTo(i, 6); g.lineTo(i, 122); g.moveTo(6, i); g.lineTo(122, i); g.stroke(); }
    g.strokeStyle = green; g.lineWidth = 2;
    g.beginPath(); g.moveTo(14, 100); g.bezierCurveTo(40, 70, 70, 96, 112, 30); g.stroke();
    g.fillStyle = green; g.beginPath(); g.moveTo(64, 50); g.lineTo(72, 72); g.lineTo(64, 66); g.lineTo(56, 72); g.closePath(); g.fill();
  });
  atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  atlas.name = 'cockpit-displays';
  return atlas;
}

/** True when a hull type has first-person cockpit dressing. */
export const hasCockpitOverlay = type => Object.hasOwn(BUILDERS, type);

/**
 * Build the dressing for one hull type: { group, dispose } or null. The group
 * is in hull metres: parent it to the model body (whose pivot is the origin).
 */
export function makeCockpitOverlay(type) {
  const build = BUILDERS[type];
  if (!build) return null;
  const builder = new OverlayBuilder();
  build(builder);
  const map = displayAtlas();
  const materials = {
    solid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.2 }),
    screen: new THREE.MeshBasicMaterial({ color: map ? 0xffffff : 0x59f08a, map, toneMapped: false }),
    glass: new THREE.MeshBasicMaterial({ color: 0x9fffc4, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  };
  materials.solid.name = 'cockpit-frame'; materials.screen.name = 'cockpit-displays'; materials.glass.name = 'cockpit-hud-glass';
  const group = builder.build(`cockpit-overlay-${type}`, materials);
  group.userData.cockpitOverlay = true;
  return {
    group,
    dispose() {
      group.removeFromParent();
      group.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
