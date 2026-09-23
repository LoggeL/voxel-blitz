import * as THREE from '../vendor/three.module.js';
import { mulberry32 } from '../../../shared/noise.js';
import { AIR, GLASS, MC_WATER, isSolidBlock } from '../../../shared/world/blocks.js';
import { getMapDimensions } from '../../../shared/world/dimensions.js';
import { buildMapBackdrop } from './map-backdrop.js';
import { mapAtmosphere } from './map-atmosphere.js';

/**
 * Client-only life and set dressing for BIKINI BOTTOM (map-spec §11): sky
 * flowers, bubble columns, a jellyfish swarm, fish schools, god rays, road
 * caustics, the sea-surface sheet, the horizon ring (reef mesas, giant kelp,
 * a tiki/barrel/anchor skyline and boat-car traffic) and set-piece glows.
 * Original procedural work inspired by the show; no copied assets.
 *
 * Nothing here collides or touches the voxel bytes. Every system is one
 * instanced or merged draw with one geometry and one material (about 20 draws
 * in total), all motion is time based and all randomness is seeded. Anything
 * that reads as sitting on a voxel re-checks `getBlock` on a timer and hides
 * once that voxel is gone (blocks may still be streaming in at build time, so
 * those systems start hidden and appear on their first check).
 */
const SEED = 20260922;
const CENTRE_X = 64;
const CENTRE_Z = 48;
const TAU = Math.PI * 2;

const BRIGHT_FRAG_TAIL = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/** Merge [{ geometry, color: [r,g,b], matrix? }] into one non-indexed, vertex-coloured geometry. */
function mergeColored(parts) {
  const position = [], normal = [], color = [];
  for (const { geometry, color: [r, g, b], matrix } of parts) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (matrix) flat.applyMatrix4(matrix);
    if (!flat.attributes.normal) flat.computeVertexNormals();
    const p = flat.attributes.position.array, n = flat.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      position.push(p[i], p[i + 1], p[i + 2]);
      normal.push(n[i], n[i + 1], n[i + 2]);
      color.push(r, g, b);
    }
    if (flat !== geometry) flat.dispose();
    geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  merged.computeBoundingSphere();
  return merged;
}

const rgb = (hex, scale = 1) => {
  const c = new THREE.Color(hex);
  return [c.r * scale, c.g * scale, c.b * scale];
};
const at = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

/** A 5- or 6-petal flat flower in the XY plane with a darker centre ring. */
function flowerGeometry(petals) {
  const shape = new THREE.Shape();
  const steps = petals * 14;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * TAU;
    const r = 0.55 + 0.45 * Math.pow(Math.abs(Math.cos((petals * a) / 2)), 0.7);
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return mergeColored([
    { geometry: new THREE.ShapeGeometry(shape, 1), color: [1, 1, 1] },
    { geometry: new THREE.RingGeometry(0.2, 0.31, 24), color: [0.58, 0.58, 0.58], matrix: at(0, 0, 0.01) },
    { geometry: new THREE.CircleGeometry(0.2, 18), color: [0.86, 0.86, 0.86], matrix: at(0, 0, 0.012) },
  ]);
}

/** True when (x, z) lies more than `margin` outside the playable rectangle. */
function outsideRect(x, z, margin, dims) {
  return x < -margin || x > dims.sx + margin || z < -margin || z > dims.sz + margin;
}

/**
 * @param {object} meta map metadata (meta.slides carries the flume path)
 * @param {(x:number,y:number,z:number)=>number} getBlock live visual block getter
 */
export function buildBikiniBottomDetails(meta, getBlock = () => AIR) {
  const group = new THREE.Group();
  group.name = 'bikini-bottom-details';
  const dims = getMapDimensions('bikini_bottom');
  const rng = mulberry32(SEED);
  const disposables = [];
  const keep = (item) => { disposables.push(item); return item; };
  const block = (x, y, z) => {
    const type = getBlock(x, y, z);
    return Number.isFinite(type) ? type : AIR;
  };
  const solid = (x, y, z) => isSolidBlock(block(x, y, z));
  const time = { value: 0 };
  const tickers = [];
  const checks = [];                         // { every, wait, run }
  const check = (every, run) => checks.push({ every, wait: 0, run });
  let draws = 0;
  const add = (object) => { group.add(object); draws++; return object; };
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const euler = new THREE.Euler();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  // ---- 1. Sky flowers: the signature pastel blossoms high in the sea sky.
  // Placed on a ring around the town above the 40-voxel reef shell, so they
  // read over the wall from the streets; slow spin about their own axis.
  {
    const palette = ['#ffb3d9', '#b3f0ff', '#d4ffb3', '#ffe9a8', '#e0c3ff'];
    const material = keep(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, fog: false, side: THREE.DoubleSide,
    }));
    const flowers = [];
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * TAU + (rng() - 0.5) * 0.22;
      const r = 165 + rng() * 65;
      const x = CENTRE_X + Math.cos(a) * r, z = CENTRE_Z + Math.sin(a) * r;
      const y = 95 + rng() * 55;
      const base = new THREE.Object3D();
      base.position.set(x, y, z);
      base.lookAt(CENTRE_X, y * 0.45, CENTRE_Z);      // face the town, tipped down toward the streets
      flowers.push({ petals: i % 3 === 0 ? 6 : 5, color: palette[i % palette.length], size: 9 + rng() * 13,
        base, spin: (i % 2 ? 1 : -1) * 0.02, phase: rng() * TAU });
    }
    for (const petals of [5, 6]) {
      const list = flowers.filter((f) => f.petals === petals);
      const geometry = keep(flowerGeometry(petals));
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      mesh.name = `bikini-sky-flowers-${petals}`;
      mesh.renderOrder = -1;
      mesh.frustumCulled = false;
      list.forEach((f, i) => mesh.setColorAt(i, new THREE.Color(f.color)));
      mesh.instanceColor.needsUpdate = true;
      const spinQ = new THREE.Quaternion();
      const zAxis = new THREE.Vector3(0, 0, 1);
      tickers.push((t) => {
        list.forEach((f, i) => {
          spinQ.setFromAxisAngle(zAxis, f.phase + f.spin * t);
          quat.copy(f.base.quaternion).multiply(spinQ);
          scale.setScalar(f.size);
          mesh.setMatrixAt(i, matrix.compose(f.base.position, quat, scale));
        });
        mesh.instanceMatrix.needsUpdate = true;
      });
      add(mesh);
    }
  }

  // ---- 2. Bubble columns: instanced spheres rising with a wobble and
  // respawning at their source. Sources on destructible voxels (chimney, vat,
  // stack, crown, lagoon, vents, flume lip) hide while that voxel is gone.
  // Ambient bubbles stay small (radius <= 0.16 m at the top of the climb, a
  // Soap Shot is 0.24 m) and flat white, so they never read as SUDSBLASTER fire.
  const bubbleSources = [];
  const bubbleSource = (x, y, z, { count, rise, speed = [1.5, 3], spread = 0.35, size = [0.06, 0.12], alive = null }) => {
    const source = { x, y, z, count, rise, speed, spread, size, alive, visible: !alive };
    bubbleSources.push(source);
    if (alive) check(1, () => { source.visible = !!alive(); });
    return source;
  };
  bubbleSource(31.5, 35, 38.5, { count: 14, rise: 16, size: [0.08, 0.14], alive: () => solid(31, 34, 38) });          // Krusty Krab chimney
  bubbleSource(101.5, 21, 47.5, { count: 12, rise: 9, spread: 0.9, alive: () => solid(101, 20, 47) });               // chum vat goo
  bubbleSource(40.5, 38, 21.5, { count: 10, rise: 13, alive: () => solid(40, 37, 21) });                               // pineapple crown spike
  bubbleSource(64, 31, 19.5, { count: 10, rise: 13, spread: 1.4, alive: () => solid(64, 30, 19) });                    // moai crown
  bubbleSource(66, 29.1, 46, { count: 10, rise: 12, size: [0.07, 0.13], alive: () => solid(65, 28, 45) });             // school smokestack
  for (const [x, z] of [[38.5, 75.5], [41.5, 74.5]]) {                                                                  // Goo Lagoon floor
    bubbleSource(x, 13, z, { count: 8, rise: 2.4, speed: [0.9, 1.6], spread: 0.6, size: [0.08, 0.16],
      alive: () => block(Math.floor(x), 14, Math.floor(z)) === MC_WATER });
  }
  bubbleSource(44.5, 19.2, 75.5, { count: 8, rise: 2.2, speed: [1.2, 2.2], spread: 0.9, size: [0.07, 0.15],
    alive: () => solid(44, 18, 75) });                                                                                  // flume lip foam
  const vents = [];
  for (let i = 0; i < 6; i++) {
    const kelp = i < 3;
    const x = kelp ? 16 + Math.floor(rng() * 16) : 96 + Math.floor(rng() * 15);
    const z = kelp ? 15 + Math.floor(rng() * 11) : 69 + Math.floor(rng() * 11);
    vents.push([x, z]);
    bubbleSource(x + 0.5, 15, z + 0.5, { count: 7, rise: 22, spread: 0.3, size: [0.05, 0.1],
      alive: () => solid(x, 14, z) && !solid(x, 15, z) });
  }
  // Boat-car wakes follow the traffic (section 8); filled in below.
  const wakes = [0, 1, 2].map(() => bubbleSource(0, 0, 0, { count: 10, rise: 6, speed: [0.8, 1.6], spread: 1.2, size: [0.08, 0.14] }));
  for (const wake of wakes) wake.visible = false;       // until the traffic places them
  {
    const bubbles = [];
    for (const source of bubbleSources) {
      for (let i = 0; i < source.count; i++) {
        bubbles.push({ source, phase: rng(), speed: source.speed[0] + rng() * (source.speed[1] - source.speed[0]),
          size: source.size[0] + rng() * (source.size[1] - source.size[0]),
          ox: (rng() - 0.5) * 2 * source.spread, oz: (rng() - 0.5) * 2 * source.spread,
          wobble: 0.08 + rng() * 0.22, freq: 1.5 + rng() * 2.5, seed: rng() * TAU });
      }
    }
    const geometry = keep(new THREE.IcosahedronGeometry(1, 1));
    const material = keep(new THREE.MeshBasicMaterial({
      color: 0xe8fbff, transparent: true, opacity: 0.35, depthWrite: false,
    }));
    const mesh = new THREE.InstancedMesh(geometry, material, bubbles.length);
    mesh.name = 'bikini-bubbles';
    mesh.frustumCulled = false;
    tickers.push((t) => {
      bubbles.forEach((b, i) => {
        const s = b.source;
        if (!s.visible) { mesh.setMatrixAt(i, hidden); return; }
        const climb = (b.phase * s.rise + t * b.speed) % s.rise;
        const k = climb / s.rise;
        const pop = k > 0.88 ? 1 - (k - 0.88) / 0.12 : 1;
        const wob = b.wobble * (0.4 + k);
        pos.set(s.x + b.ox + Math.sin(t * b.freq + b.seed) * wob, s.y + climb, s.z + b.oz + Math.cos(t * b.freq * 0.8 + b.seed) * wob);
        scale.setScalar(b.size * (0.55 + 0.6 * k) * Math.max(0, pop));
        mesh.setMatrixAt(i, matrix.compose(pos, quat.identity(), scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
    add(mesh);
  }

  // ---- 3. Jellyfish swarm: pink bells with four ribbon tentacles, pulsing at
  // 1.3 Hz on slow Lissajous paths over the Jellyfish Fields, a few over
  // Jellyfish Trail (clear of the pad columns) and two dim ones in the lab.
  {
    const parts = [
      { geometry: new THREE.SphereGeometry(0.5, 12, 6, 0, TAU, 0, Math.PI / 2), color: [1, 1, 1] },
      { geometry: new THREE.RingGeometry(0.34, 0.5, 16), color: [1, 0.8, 0.9], matrix: at(0, 0.005, 0, Math.PI / 2) },
    ];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + Math.PI / 4;
      parts.push({ geometry: new THREE.PlaneGeometry(0.1, 1.15), color: [0.85, 0.7, 0.95],
        matrix: at(Math.cos(a) * 0.22, -0.56, Math.sin(a) * 0.22, 0, a + Math.PI / 2, 0.12 * (k % 2 ? 1 : -1)) });
    }
    const geometry = keep(mergeColored(parts));
    const material = keep(new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
    }));
    // Near-camera fade: a bell within ~2.5 m of the eye vanishes, so a jelly
    // drifting through head height never masks a player for humans only.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vJellyNear;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vec4 jellyCentre = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vJellyNear = smoothstep(2.5, 6.0, length(cameraPosition - jellyCentre.xyz));`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vJellyNear;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vJellyNear;');
    };
    const jellies = [];
    const jelly = (cx, cy, cz, ax, ay, az, color, size, lab = false) => jellies.push({
      cx, cy, cz, ax, ay, az, color, size, lab,
      fx: 0.05 + rng() * 0.07, fy: 0.09 + rng() * 0.08, fz: 0.04 + rng() * 0.07,
      px: rng() * TAU, py: rng() * TAU, pz: rng() * TAU, pulse: rng() * TAU,
    });
    for (let i = 0; i < 18; i++) jelly(103.5, 25, 74.5, 6.5 + rng() * 1.5, 4.5, 5 + rng(), '#ff8fc8', 0.9 + rng() * 0.5);
    for (const cx of [28, 99]) {
      for (let i = 0; i < 2; i++) jelly(cx, 23, 64.5, 9, 2.5, 1.8, '#ffa6d6', 0.8 + rng() * 0.4);
    }
    for (let i = 0; i < 2; i++) jelly(107.2, 15.8, 53.8, 1.6, 0.25, 1.4, '#8a4a70', 0.45, true);
    let labOpen = false;
    check(1, () => { labOpen = !solid(107, 15, 53) && !solid(107, 16, 53) && solid(107, 17, 53); });
    const mesh = new THREE.InstancedMesh(geometry, material, jellies.length);
    mesh.name = 'bikini-jellyfish';
    mesh.frustumCulled = false;
    jellies.forEach((j, i) => mesh.setColorAt(i, new THREE.Color(j.color)));
    mesh.instanceColor.needsUpdate = true;
    tickers.push((t) => {
      jellies.forEach((j, i) => {
        if (j.lab && !labOpen) { mesh.setMatrixAt(i, hidden); return; }
        pos.set(j.cx + j.ax * Math.sin(t * j.fx + j.px), j.cy + j.ay * Math.sin(t * j.fy + j.py),
          j.cz + j.az * Math.sin(t * j.fz * 1.3 + j.pz));
        const beat = Math.sin(t * 1.3 * TAU + j.pulse);
        scale.set(j.size * (1 + 0.1 * beat), j.size * (1 - 0.08 * beat), j.size * (1 + 0.1 * beat));
        euler.set(0.18 * Math.sin(t * 0.7 + j.px), t * 0.2 + j.pz, 0.18 * Math.cos(t * 0.6 + j.py));
        mesh.setMatrixAt(i, matrix.compose(pos, quat.setFromEuler(euler), scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
    add(mesh);
  }

  // ---- 4. Fish schools: three boids-lite schools of 20 over the north
  // houses, mid and the south quarter, above the tallest roofs and crowns.
  {
    const geometry = keep(mergeColored([
      { geometry: new THREE.OctahedronGeometry(0.5, 0), color: [1, 1, 1], matrix: at(0, 0, 0, 0, 0, 0, 1.1, 0.5, 0.26) },
      { geometry: new THREE.ConeGeometry(0.26, 0.42, 3), color: [0.72, 0.72, 0.72], matrix: at(-0.66, 0, 0, 0, 0, Math.PI / 2, 1, 1, 0.3) },
      { geometry: new THREE.BoxGeometry(0.07, 0.07, 0.3), color: [0.1, 0.1, 0.12], matrix: at(0.3, 0.06, 0) },
    ]));
    const material = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const schools = [
      { cx: 72, cy: 37, cz: 20.5, rx: 16, rz: 4, speed: 0.09, color: '#ffb347' },
      { cx: 64, cy: 33, cz: 48, rx: 12, rz: 9, speed: -0.12, color: '#ffe066' },
      { cx: 70, cy: 39, cz: 74.5, rx: 20, rz: 4.5, speed: 0.075, color: '#7fd3ff' },
    ];
    const fish = [];
    schools.forEach((school, s) => {
      for (let i = 0; i < 20; i++) {
        const a = rng() * TAU, r = Math.sqrt(rng()) * 3.4;
        fish.push({ s, ox: Math.cos(a) * r, oy: (rng() - 0.5) * 3, oz: Math.sin(a) * r,
          phase: rng() * TAU, size: 0.55 + rng() * 0.35, lag: rng() * 0.25 });
      }
    });
    const mesh = new THREE.InstancedMesh(geometry, material, fish.length);
    mesh.name = 'bikini-fish';
    mesh.frustumCulled = false;
    const tint = new THREE.Color();
    fish.forEach((f, i) => mesh.setColorAt(i, tint.set(schools[f.s].color).offsetHSL((f.phase - Math.PI) * 0.006, 0, 0)));
    mesh.instanceColor.needsUpdate = true;
    tickers.push((t) => {
      fish.forEach((f, i) => {
        const school = schools[f.s];
        const a = (t - f.lag) * school.speed + f.s * 2.1;
        const dir = Math.sign(school.speed);
        const x = school.cx + Math.cos(a) * school.rx, z = school.cz + Math.sin(a) * school.rz;
        const tx = -Math.sin(a) * school.rx * dir, tz = Math.cos(a) * school.rz * dir;
        pos.set(x + f.ox + 0.5 * Math.sin(t * 1.1 + f.phase), school.cy + f.oy + 0.3 * Math.sin(t * 1.7 + f.phase),
          z + f.oz + 0.5 * Math.cos(t * 0.9 + f.phase));
        euler.set(0, Math.atan2(-tz, tx) + 0.18 * Math.sin(t * 7 + f.phase), 0.08 * Math.sin(t * 2 + f.phase));
        scale.setScalar(f.size);
        mesh.setMatrixAt(i, matrix.compose(pos, quat.setFromEuler(euler), scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
    add(mesh);
  }

  // ---- 5. God rays: seven additive tapered shafts slanting down from the
  // palette sun direction, each fading on its own slow beat. They thin out
  // near the camera so a ray never washes over the view.
  {
    const palette = mapAtmosphere('bikini_bottom');
    const [sx, sy, sz] = palette.sunDir || [20, 120, 10];
    const lean = [sx / sy, sz / sy];
    const position = [], ray = [];
    const shafts = [[64, 48], [43, 48], [84, 47], [87.5, 75], [40.5, 21.5], [25, 47], [103.5, 75]];
    shafts.forEach(([bx, bz], i) => {
      const height = 52 + rng() * 10;
      const phase = rng() * TAU;
      const top = [bx + lean[0] * height, 15 + height, bz + lean[1] * height];
      for (const cross of [0, Math.PI / 2]) {
        const cx = Math.cos(cross + i * 0.4), cz = Math.sin(cross + i * 0.4);
        const quad = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];
        for (const [u, v] of quad) {
          const width = v ? 1.4 : 4.2;
          const x = v ? top[0] : bx, y = v ? top[1] : 15, z = v ? top[2] : bz;
          position.push(x + cx * u * width, y, z + cz * u * width);
          ray.push(u, v, phase);
        }
      }
    });
    const geometry = keep(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('ray', new THREE.Float32BufferAttribute(ray, 3));
    geometry.computeBoundingSphere();
    const material = keep(new THREE.ShaderMaterial({
      uniforms: { time, color: { value: new THREE.Color('#dffbff') }, strength: { value: 0.11 } },
      vertexShader: `
        attribute vec3 ray;
        varying vec3 vRay;
        varying float vDist;
        void main() {
          vRay = ray;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vDist = length(cameraPosition - world.xyz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform float time;
        uniform vec3 color;
        uniform float strength;
        varying vec3 vRay;
        varying float vDist;
        void main() {
          float along = smoothstep(0.0, 0.3, vRay.y) * (1.0 - smoothstep(0.75, 1.0, vRay.y));
          float across = 1.0 - vRay.x * vRay.x;
          float beat = 0.45 + 0.55 * (0.5 + 0.5 * sin(time * 0.23 + vRay.z)) * (0.8 + 0.2 * sin(time * 0.71 + vRay.z * 2.0));
          float near = smoothstep(3.0, 14.0, vDist) * (1.0 - smoothstep(150.0, 260.0, vDist));
          gl_FragColor = vec4(color, along * across * beat * near * strength);
          ${BRIGHT_FRAG_TAIL}
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'bikini-god-rays';
    add(mesh);
  }

  // ---- 6. Caustics: one additive scrolling decal just above the roads and
  // both lots (never the site interiors). A 128x96 mask, refreshed every two
  // seconds, keeps it only on exposed floor, so props and craters stay clean.
  {
    const rects = [[3, 28, 125, 34], [3, 62, 125, 68], [37, 34, 50, 62], [78, 34, 91, 62]];
    const geometry = keep(mergeColored(rects.map(([x0, z0, x1, z1]) => ({
      geometry: new THREE.PlaneGeometry(x1 - x0, z1 - z0),
      color: [1, 1, 1],
      matrix: at((x0 + x1) / 2, 15.03, (z0 + z1) / 2, -Math.PI / 2),
    }))));
    const maskData = new Uint8Array(dims.sx * dims.sz * 4);
    const mask = keep(new THREE.DataTexture(maskData, dims.sx, dims.sz, THREE.RGBAFormat));
    mask.magFilter = THREE.LinearFilter;
    mask.minFilter = THREE.LinearFilter;
    mask.needsUpdate = true;
    const material = keep(new THREE.ShaderMaterial({
      uniforms: { time, mask: { value: mask }, size: { value: new THREE.Vector2(dims.sx, dims.sz) },
        color: { value: new THREE.Color('#d2fbff') }, strength: { value: 0.2 } },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform float time;
        uniform sampler2D mask;
        uniform vec2 size;
        uniform vec3 color;
        uniform float strength;
        varying vec3 vWorld;
        float layer(vec2 p, float t) {
          vec2 q = p;
          float v = 0.0;
          for (int i = 0; i < 3; i++) {
            float k = float(i);
            q = vec2(q.x + 0.85 * sin(q.y * 0.7 + t * 0.8 + k), q.y + 0.85 * cos(q.x * 0.6 - t * 0.7 + k * 1.7));
            v += 1.0 - abs(sin(q.x) * sin(q.y));
          }
          return pow(v / 3.0, 7.0);
        }
        void main() {
          float floorMask = texture2D(mask, vWorld.xz / size).r;
          float dist = length(cameraPosition - vWorld);
          float fade = 1.0 - smoothstep(26.0, 72.0, dist);
          float c = layer(vWorld.xz * 0.55, time) * 0.7 + layer(vWorld.zx * 0.83 + 3.1, time * 1.3) * 0.5;
          gl_FragColor = vec4(color, clamp(c, 0.0, 1.0) * floorMask * fade * strength);
          ${BRIGHT_FRAG_TAIL}
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'bikini-caustics';
    add(mesh);
    check(2, () => {
      for (const [x0, z0, x1, z1] of rects) {
        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) {
            const open = solid(x, 14, z) && !solid(x, 15, z) && block(x, 14, z) !== MC_WATER;
            maskData[(z * dims.sx + x) * 4] = open ? 255 : 0;
          }
        }
      }
      mask.needsUpdate = true;
    });
  }

  // ---- 7. Sea-surface sheet high overhead with a slow ripple sheen.
  {
    const geometry = keep(new THREE.PlaneGeometry(900, 900, 1, 1));
    const material = keep(new THREE.ShaderMaterial({
      uniforms: { time, deep: { value: new THREE.Color('#7fdcec') }, glint: { value: new THREE.Color('#f2feff') } },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform float time;
        uniform vec3 deep;
        uniform vec3 glint;
        varying vec3 vWorld;
        void main() {
          vec2 p = vWorld.xz * 0.045;
          float r = sin(p.x * 1.3 + time * 0.21 + sin(p.y * 0.9 - time * 0.13) * 1.6)
            * sin(p.y * 1.1 - time * 0.17 + sin(p.x * 0.7 + time * 0.11) * 1.4);
          float shine = smoothstep(0.35, 0.95, r);
          float fade = 1.0 - smoothstep(210.0, 440.0, length(vWorld.xz - cameraPosition.xz));
          gl_FragColor = vec4(mix(deep, glint, shine), (0.1 + 0.1 * shine) * fade);
          ${BRIGHT_FRAG_TAIL}
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'bikini-sea-surface';
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(CENTRE_X, 78, CENTRE_Z);
    mesh.renderOrder = -0.5;
    add(mesh);
  }

  // ---- 8. Horizon ring beyond the shell: reef mesas and the sand ring (the
  // stock backdrop builder, one draw), swaying giant kelp, a tiki / barrel /
  // anchor skyline and three boat-cars cruising a lane high over the reef so
  // they clear the 40-voxel wall from across town.
  const atmosphere = mapAtmosphere('bikini_bottom');
  const backdrop = buildMapBackdrop({
    ...atmosphere,
    backdrop: { style: 'mesa', seed: 22, ground: 14.95, groundColor: '#d9c79a', colors: ['#b8828c', '#9c7078', '#c99a8e'],
      top: '#d98fa4', height: [58, 108], gap: [70, 140], count: 13, haze: 0.08, shape: { width: [50, 110], depth: [34, 60] } },
  }, dims);
  if (backdrop) { group.add(backdrop.group); draws++; }
  const ringPoint = (angle, gap) => {
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const edge = Math.min((dims.sx / 2) / Math.max(Math.abs(dx), 1e-6), (dims.sz / 2) / Math.max(Math.abs(dz), 1e-6));
    return { x: dims.sx / 2 + dx * (edge + gap), z: dims.sz / 2 + dz * (edge + gap), angle };
  };
  {
    // Giant kelp: crossed ribbons in clusters, swayed in the vertex shader.
    const parts = [];
    const swayData = [];
    const clusters = 11;
    for (let c = 0; c < clusters; c++) {
      const centre = ringPoint((c / clusters) * TAU + rng() * 0.35, 16 + rng() * 34);
      const stalks = 3 + Math.floor(rng() * 3);
      for (let s = 0; s < stalks; s++) {
        const x = centre.x + (rng() - 0.5) * 16, z = centre.z + (rng() - 0.5) * 16;
        if (!outsideRect(x, z, 12, dims)) continue;
        const height = 48 + rng() * 50, width = 1.6 + rng() * 1.2, phase = rng() * TAU;
        const segments = 12;
        const low = rgb('#1f5a32'), high = rgb(rng() < 0.5 ? '#6aa33e' : '#86a83a');
        for (const turn of [0, Math.PI / 2]) {
          const geometry = new THREE.PlaneGeometry(width, height, 1, segments);
          const p = geometry.attributes.position;
          for (let i = 0; i < p.count; i++) {
            const k = (p.getY(i) + height / 2) / height;
            p.setX(i, p.getX(i) * (0.7 + 0.5 * Math.sin(k * Math.PI)));
          }
          const count = geometry.index ? geometry.index.count : p.count;
          parts.push({ geometry, color: [1, 1, 1], matrix: at(x, 14.95 + height / 2, z, 0, turn + phase, 0) });
          swayData.push({ count, height, base: 14.95, phase, low, high });
        }
      }
    }
    // mergeColored flattens each part; rebuild per-vertex colour and sway from the flattened heights.
    const geometry = keep(mergeColored(parts));
    const p = geometry.attributes.position, colors = geometry.attributes.color;
    const sway = new Float32Array(p.count * 2);
    let v = 0;
    for (const part of swayData) {
      for (let i = 0; i < part.count; i++, v++) {
        const k = Math.max(0, Math.min(1, (p.getY(v) - part.base) / part.height));
        sway[v * 2] = Math.pow(k, 1.6);
        sway[v * 2 + 1] = part.phase;
        colors.setXYZ(v, part.low[0] + (part.high[0] - part.low[0]) * k, part.low[1] + (part.high[1] - part.low[1]) * k,
          part.low[2] + (part.high[2] - part.low[2]) * k);
      }
    }
    geometry.setAttribute('sway', new THREE.BufferAttribute(sway, 2));
    const material = keep(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute vec2 sway;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.x += sin(uTime * 0.55 + sway.y + position.y * 0.045) * 3.2 * sway.x;
          transformed.z += cos(uTime * 0.41 + sway.y * 1.3) * 1.8 * sway.x;`);
    };
    material.customProgramCacheKey = () => 'bikini-kelp-sway';
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'bikini-giant-kelp';
    add(mesh);
  }
  {
    // Skyline: tiki heads, barrel houses and anchor towers facing the town.
    const parts = [];
    const lit = rgb('#ffe9a8');
    const types = ['tiki', 'barrel', 'anchor'];
    for (let i = 0; i < 12; i++) {
      const spot = ringPoint((i / 12) * TAU + 0.26 + rng() * 0.2, 34 + rng() * 40);
      const yaw = Math.atan2(CENTRE_X - spot.x, CENTRE_Z - spot.z);
      const place = (x, y, z, rx = 0, ry = 0, rz = 0) => {
        const local = at(x, y, z, rx, ry, rz);
        return new THREE.Matrix4().makeRotationY(yaw).premultiply(new THREE.Matrix4().makeTranslation(spot.x, 14.95, spot.z)).multiply(local);
      };
      const type = types[i % 3];
      const h = 46 + rng() * 34;
      if (type === 'tiki') {
        const stone = rng() < 0.5 ? '#7d93a6' : '#8a6a52';
        parts.push({ geometry: new THREE.BoxGeometry(12, h, 11), color: rgb(stone), matrix: place(0, h / 2, 0) });
        parts.push({ geometry: new THREE.BoxGeometry(12.6, 2.2, 3), color: rgb(stone, 0.72), matrix: place(0, h * 0.72, 5.5) });
        for (const ex of [-3, 3]) parts.push({ geometry: new THREE.BoxGeometry(2.6, 2.4, 1), color: lit, matrix: place(ex, h * 0.64, 5.8) });
        parts.push({ geometry: new THREE.BoxGeometry(2.4, h * 0.22, 3.2), color: rgb(stone, 0.85), matrix: place(0, h * 0.5, 6.2) });
        parts.push({ geometry: new THREE.BoxGeometry(6, 1.6, 1), color: rgb(stone, 0.45), matrix: place(0, h * 0.3, 5.8) });
        for (let k = -2; k <= 2; k++) {
          parts.push({ geometry: new THREE.BoxGeometry(1.2, 7, 1.2), color: rgb('#5e9a44'), matrix: place(k * 2.4, h + 3, 0, 0, 0, k * 0.28) });
        }
      } else if (type === 'barrel') {
        parts.push({ geometry: new THREE.CylinderGeometry(6.2, 6.8, h, 14), color: rgb('#8a6a48'), matrix: place(0, h / 2, 0) });
        for (const k of [0.12, 0.5, 0.88]) {
          parts.push({ geometry: new THREE.CylinderGeometry(6.9, 6.9, 1.3, 14), color: rgb('#4a3826'), matrix: place(0, h * k, 0) });
        }
        for (const k of [0.3, 0.68]) {
          for (const side of [-0.5, 0.5]) {
            parts.push({ geometry: new THREE.BoxGeometry(1.8, 1.8, 0.8), color: lit, matrix: place(side * 5, h * k, 5.5, 0, -side * 0.9, 0) });
          }
        }
        parts.push({ geometry: new THREE.CylinderGeometry(0.7, 0.7, 7, 6), color: rgb('#5d6b70'), matrix: place(2.5, h + 3.5, 0) });
      } else {
        const metal = '#5d6b70';
        parts.push({ geometry: new THREE.BoxGeometry(3.2, h, 3.2), color: rgb(metal), matrix: place(0, h / 2, 0) });
        parts.push({ geometry: new THREE.BoxGeometry(18, 2.6, 3.2), color: rgb(metal, 0.85), matrix: place(0, h * 0.8, 0) });
        parts.push({ geometry: new THREE.TorusGeometry(3.4, 1, 6, 16), color: rgb(metal, 1.1), matrix: place(0, h + 3.2, 0) });
        parts.push({ geometry: new THREE.TorusGeometry(10, 1.3, 6, 18, Math.PI), color: rgb(metal), matrix: place(0, 11, 0, 0, 0, Math.PI) });
        for (const side of [-1, 1]) {
          parts.push({ geometry: new THREE.ConeGeometry(2.2, 4.4, 4), color: rgb(metal, 0.8), matrix: place(side * 10, 11.5, 0, 0, 0, side * -0.5) });
        }
        for (let k = 0.25; k < 0.75; k += 0.12) parts.push({ geometry: new THREE.BoxGeometry(1, 1.2, 0.6), color: lit, matrix: place(0, h * k, 1.8) });
      }
    }
    const geometry = keep(mergeColored(parts));
    const material = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'bikini-skyline';
    mesh.matrixAutoUpdate = false;
    add(mesh);
  }
  {
    // Boat-car traffic: three cars loop a high lane beyond the reef, with wakes.
    const geometry = keep(mergeColored([
      { geometry: new THREE.BoxGeometry(7, 1.9, 3.4), color: [1, 1, 1] },
      { geometry: new THREE.ConeGeometry(1.9, 3.2, 4), color: [1, 1, 1], matrix: at(5.1, 0, 0, Math.PI / 4, 0, -Math.PI / 2, 1, 1, 1) },
      { geometry: new THREE.BoxGeometry(3.6, 1.7, 2.9), color: [0.72, 0.9, 1.0], matrix: at(0.4, 1.7, 0) },
      { geometry: new THREE.BoxGeometry(2.2, 1.6, 0.35), color: [0.9, 0.9, 0.9], matrix: at(-2.9, 1.6, 0) },
      { geometry: new THREE.BoxGeometry(7.4, 0.5, 3.6), color: [0.35, 0.35, 0.38], matrix: at(0, -1, 0) },
    ]));
    const material = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const colors = ['#3f8f8a', '#e0463a', '#f2c230'];
    const mesh = new THREE.InstancedMesh(geometry, material, 3);
    mesh.name = 'bikini-boat-traffic';
    mesh.frustumCulled = false;
    colors.forEach((c, i) => mesh.setColorAt(i, new THREE.Color(c)));
    mesh.instanceColor.needsUpdate = true;
    tickers.push((t) => {
      for (let i = 0; i < 3; i++) {
        const a = t * 0.021 + (i / 3) * TAU;
        const x = CENTRE_X + Math.cos(a) * 178, z = CENTRE_Z + Math.sin(a) * 152, y = 72 + 1.6 * Math.sin(t * 0.6 + i * 2);
        const tx = -Math.sin(a) * 178, tz = Math.cos(a) * 152;
        pos.set(x, y, z);
        euler.set(0, Math.atan2(-tz, tx), 0.05 * Math.sin(t * 0.8 + i));
        scale.setScalar(1.35);
        mesh.setMatrixAt(i, matrix.compose(pos, quat.setFromEuler(euler), scale));
        const wake = wakes[i];
        const back = Math.hypot(tx, tz) || 1;
        wake.x = x - (tx / back) * 7; wake.y = y - 1.2; wake.z = z - (tz / back) * 7;
        wake.visible = true;
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    add(mesh);
  }

  // ---- 9. Set-piece animation.
  const glowMaterial = (color, opacity = 0.8) => keep(new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  {
    // Wheelhouse lamp: a pulsing core inside the glass lantern on the roof.
    const material = glowMaterial('#fff0a0', 0.7);
    const mesh = add(new THREE.Mesh(keep(new THREE.SphereGeometry(0.72, 14, 10)), material));
    mesh.name = 'bikini-school-lamp';
    mesh.position.set(64, 26, 48);
    mesh.visible = false;
    check(1, () => { mesh.visible = block(63, 25, 47) === GLASS; });
    tickers.push((t) => {
      const beat = 0.5 + 0.5 * Math.sin(t * 2.4);
      material.opacity = 0.35 + 0.45 * beat;
      mesh.scale.setScalar(0.85 + 0.2 * beat);
    });
  }
  {
    // Chum Lab screen glow on the lab screen tile's room face.
    const material = glowMaterial('#6ff0ff', 0.75);
    const mesh = add(new THREE.Mesh(keep(new THREE.PlaneGeometry(0.9, 0.7)), material));
    mesh.name = 'bikini-lab-screen';
    mesh.position.set(105.02, 16.5, 52.5);
    mesh.rotation.y = Math.PI / 2;
    mesh.visible = false;
    check(1, () => { mesh.visible = solid(104, 16, 52) && !solid(105, 16, 52); });
    tickers.push((t) => { material.opacity = 0.55 + 0.2 * Math.sin(t * 9) * Math.sin(t * 2.3) + 0.1 * Math.sin(t * 31); });
  }
  {
    // Chum Bucket lip neon on top of the rust lip; hidden below 60% of the lip.
    const lip = [];
    for (let x = 90; x <= 113; x++) {
      for (let z = 36; z <= 59; z++) {
        const d = Math.hypot(x - 101.5, z - 47.5);
        if (d >= 9.5 && d < 11) lip.push([x, z]);
      }
    }
    const material = glowMaterial('#9dff6a', 0.85);
    const mesh = add(new THREE.Mesh(keep(new THREE.TorusGeometry(10.25, 0.12, 6, 96)), material));
    mesh.name = 'bikini-chum-neon';
    mesh.position.set(102, 28.08, 48);
    mesh.rotation.x = Math.PI / 2;
    mesh.visible = false;
    check(2, () => { mesh.visible = lip.filter(([x, z]) => solid(x, 27, z)).length >= lip.length * 0.6; });
    tickers.push((t) => {
      const flicker = Math.sin(t * 0.9) > 0.97 ? 0.25 : 1;
      material.opacity = (0.7 + 0.15 * Math.sin(t * 3.1)) * flicker;
    });
  }
  {
    // Treedome sheen: a faint Fresnel shell with a slow rising glint band.
    const glass = [];
    for (let x = 80; x <= 94; x++) {
      for (let z = 68; z <= 81; z++) {
        const d = Math.hypot(x - 87, z - 74.5);
        if (d >= 7.3) continue;
        const rib = (((Math.atan2(z - 74.5, x - 87) * 180) / Math.PI) % 45 + 45) % 45;
        if (rib < 5 || rib > 40) continue;
        for (let y = 19; y <= 25; y++) if (Math.abs(Math.hypot(d, y - 18) - 7) < 0.6) glass.push([x, y, z]);
      }
    }
    const material = keep(new THREE.ShaderMaterial({
      uniforms: { time, color: { value: new THREE.Color('#c8f4ff') } },
      vertexShader: `
        varying vec3 vNormalW;
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        uniform float time;
        uniform vec3 color;
        varying vec3 vNormalW;
        varying vec3 vWorld;
        void main() {
          vec3 view = normalize(cameraPosition - vWorld);
          float rim = pow(1.0 - abs(dot(normalize(vNormalW), view)), 2.6);
          float band = smoothstep(0.92, 1.0, sin(vWorld.y * 1.1 - time * 0.9 + vWorld.x * 0.15));
          // Eight faint meridians every 45 degrees, lined up with the PALE ribs.
          float meridian = 1.0 - smoothstep(0.0, 0.035, abs(fract(atan(vWorld.z - 75.0, vWorld.x - 87.5) / 0.7853982 + 0.5) - 0.5));
          gl_FragColor = vec4(color, 0.04 + rim * 0.42 + band * 0.08 + meridian * 0.07);
          ${BRIGHT_FRAG_TAIL}
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const geometry = keep(new THREE.SphereGeometry(8.1, 36, 14, 0, TAU, 0, Math.acos(0.5 / 8.1)));
    const mesh = add(new THREE.Mesh(geometry, material));
    mesh.name = 'bikini-treedome-sheen';
    mesh.position.set(87.5, 18.5, 75);
    mesh.visible = false;
    check(2, () => { mesh.visible = glass.length > 0 && glass.filter(([x, y, z]) => block(x, y, z) === GLASS).length >= glass.length * 0.5; });
  }
  {
    // Flume sheen: a scrolling translucent strip on the trough floor along the
    // slide path; each sample hides while the floor voxel under it is gone.
    const path = meta?.slides?.[0]?.path || [];
    const samples = [];
    let run = 0;
    for (let s = 0; s + 1 < path.length; s++) {
      const [ax, , az] = path[s], [bx, , bz] = path[s + 1];
      const length = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(length / 0.5));
      for (let i = s === 0 ? 0 : 1; i <= steps; i++) {
        const t = i / steps;
        samples.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, px: -(bz - az) / length, pz: (bx - ax) / length, u: run + length * t });
      }
      run += length;
    }
    if (samples.length > 1) {
      const position = [], uv = [], alive = [];
      for (let i = 0; i + 1 < samples.length; i++) {
        const a = samples[i], b = samples[i + 1];
        const corner = (s, side) => { position.push(s.x + s.px * side * 1.3, 19.05, s.z + s.pz * side * 1.3); uv.push(s.u, side); alive.push(1); };
        corner(a, -1); corner(b, -1); corner(b, 1);
        corner(a, -1); corner(b, 1); corner(a, 1);
      }
      const geometry = keep(new THREE.BufferGeometry());
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      const aliveAttr = new THREE.Float32BufferAttribute(alive, 1);
      geometry.setAttribute('alive', aliveAttr);
      geometry.computeBoundingSphere();
      const material = keep(new THREE.ShaderMaterial({
        uniforms: { time, color: { value: new THREE.Color('#c4f6ff') } },
        vertexShader: `
          attribute float alive;
          varying vec2 vUv;
          varying float vAlive;
          void main() {
            vUv = uv;
            vAlive = alive;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform float time;
          uniform vec3 color;
          varying vec2 vUv;
          varying float vAlive;
          void main() {
            if (vAlive < 0.5) discard;
            float streak = smoothstep(0.55, 0.95, sin(vUv.x * 2.2 - time * 7.0 + sin(vUv.y * 3.0 + time) * 0.6));
            float edge = 1.0 - smoothstep(0.55, 1.0, abs(vUv.y));
            gl_FragColor = vec4(color, (0.12 + 0.38 * streak) * edge);
            ${BRIGHT_FRAG_TAIL}
          }`,
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      }));
      const mesh = add(new THREE.Mesh(geometry, material));
      mesh.name = 'bikini-flume-sheen';
      check(1, () => {
        for (let i = 0; i + 1 < samples.length; i++) {
          const mid = { x: (samples[i].x + samples[i + 1].x) / 2, z: (samples[i].z + samples[i + 1].z) / 2 };
          const on = solid(Math.floor(mid.x), 18, Math.floor(mid.z)) ? 1 : 0;
          for (let k = 0; k < 6; k++) aliveAttr.array[i * 6 + k] = on;
        }
        aliveAttr.needsUpdate = true;
      });
    }
  }
  {
    // Goo Lagoon toys: a striped beach ball and a ring float bobbing on the water.
    const ballParts = [];
    const stripes = ['#e0463a', '#fff4e0', '#2f7fd6', '#f2c230', '#fff4e0', '#3fb07a'];
    stripes.forEach((c, i) => ballParts.push({
      geometry: new THREE.SphereGeometry(0.42, 4, 10, (i / 6) * TAU, TAU / 6), color: rgb(c),
    }));
    const ringParts = [];
    for (let i = 0; i < 8; i++) {
      ringParts.push({ geometry: new THREE.TorusGeometry(0.45, 0.16, 8, 4, TAU / 8), color: rgb(i % 2 ? '#fff4e0' : '#e0463a'),
        matrix: at(0, 0, 0, Math.PI / 2, 0, (i / 8) * TAU) });
    }
    const material = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const ball = add(new THREE.Mesh(keep(mergeColored(ballParts)), material));
    const ring = add(new THREE.Mesh(keep(mergeColored(ringParts)), material));
    ball.name = 'bikini-beach-ball';
    ring.name = 'bikini-ring-float';
    let wet = false;
    check(1, () => { wet = block(39, 14, 75) === MC_WATER && block(41, 14, 76) === MC_WATER; });
    tickers.push((t) => {
      ball.visible = ring.visible = wet;
      if (!wet) return;
      ball.position.set(39.5 + 2.2 * Math.sin(t * 0.13), 15.35 + 0.06 * Math.sin(t * 1.6), 75.5 + 1.6 * Math.sin(t * 0.17 + 1));
      ball.rotation.set(t * 0.4, t * 0.25, 0);
      ring.position.set(40.5 + 1.8 * Math.sin(t * 0.11 + 2), 15.08 + 0.05 * Math.sin(t * 1.4 + 1), 74.5 + 1.8 * Math.cos(t * 0.15));
      ring.rotation.set(0.06 * Math.sin(t * 1.2), t * 0.1, 0.06 * Math.cos(t * 1.1));
    });
  }
  {
    // Anglerfish lures in the Chum Lab: a dark stalk from the ceiling and a
    // glowing bulb that sways and pulses.
    const geometry = keep(mergeColored([
      { geometry: new THREE.CylinderGeometry(0.025, 0.035, 0.55, 5), color: [0.12, 0.14, 0.16], matrix: at(0, 0.3, 0) },
      { geometry: new THREE.SphereGeometry(0.1, 10, 8), color: [0.72, 1, 0.92] },
      { geometry: new THREE.SphereGeometry(0.2, 10, 8), color: [0.16, 0.34, 0.3] },
    ]));
    const material = keep(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    const lures = [[106.5, 16.35, 53.5], [108.3, 16.3, 52.4], [106.2, 16.25, 55.6]].map(([x, y, z], i) => ({ x, y, z, phase: i * 2.1, on: false }));
    const mesh = new THREE.InstancedMesh(geometry, material, lures.length);
    mesh.name = 'bikini-lab-lures';
    mesh.frustumCulled = false;
    check(1, () => {
      for (const lure of lures) {
        const x = Math.floor(lure.x), z = Math.floor(lure.z);
        lure.on = solid(x, 17, z) && !solid(x, 16, z) && !solid(x, 15, z);
      }
    });
    tickers.push((t) => {
      lures.forEach((lure, i) => {
        if (!lure.on) { mesh.setMatrixAt(i, hidden); return; }
        pos.set(lure.x + 0.08 * Math.sin(t * 0.9 + lure.phase), lure.y, lure.z + 0.08 * Math.cos(t * 0.7 + lure.phase));
        euler.set(0.12 * Math.sin(t * 0.9 + lure.phase), 0, 0.12 * Math.cos(t * 0.7 + lure.phase));
        scale.setScalar(0.9 + 0.12 * Math.sin(t * 2.6 + lure.phase));
        mesh.setMatrixAt(i, matrix.compose(pos, quat.setFromEuler(euler), scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
    add(mesh);
  }

  const meshes = [];
  group.traverse((object) => { if (object.isInstancedMesh) meshes.push(object); });
  let first = true;
  return {
    group,
    stats: { draws },
    /** Advance every animated system; `dt` in seconds. */
    update(dt = 0) {
      time.value += Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
      for (const item of checks) {
        item.wait -= first ? item.wait : dt;
        if (item.wait <= 0) { item.wait = item.every; item.run(); }
      }
      first = false;
      for (const tick of tickers) tick(time.value);
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      for (const item of disposables) item.dispose();
      backdrop?.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
