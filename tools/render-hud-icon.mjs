// Render the transparent side-profile HUD silhouette for one or more procedural guns into
// public/assets/weapons/hud/<weapon>.png without a browser: the real gun model is built
// headlessly (the same assemble.js the viewmodel uses), then flat-shaded and z-buffered by
// a tiny orthographic software rasterizer and written as an RGBA PNG.
//
//   node tools/render-hud-icon.mjs --weapon rocket
//   node tools/render-hud-icon.mjs --all [--out-dir DIR] [--width 480] [--height 240]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { buildGun } from '../public/js/guns/assemble.js';
import { GLOW_ACCENT, MaterialCache } from '../public/js/guns/kit.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'weapons', 'hud');
const SUPERSAMPLE = 3;
const MARGIN = 1.06;
/** Key light from the viewer's upper left, matching the existing illustrations. */
const KEY_LIGHT = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();
const FILL_LIGHT = new THREE.Vector3(-0.3, -0.5, -0.8).normalize();

function parseArgs(argv) {
  const options = { weapon: null, all: false, outDir: DEFAULT_OUT_DIR, width: 480, height: 240 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index++;
      return next;
    };
    if (arg === '--all') options.all = true;
    else if (arg === '--weapon') options.weapon = value();
    else if (arg === '--out-dir') options.outDir = path.resolve(value());
    else if (arg === '--width') options.width = Number(value());
    else if (arg === '--height') options.height = Number(value());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.all && !options.weapon) throw new Error('pass --weapon <id> or --all');
  if (options.weapon && !WEAPON_IDS.includes(options.weapon)) {
    throw new Error(`unknown weapon: ${options.weapon}`);
  }
  if (!Number.isInteger(options.width) || options.width < 64) throw new Error('invalid --width');
  if (!Number.isInteger(options.height) || options.height < 32) throw new Error('invalid --height');
  return options;
}

/** Collect world-space triangles `{a,b,c,color,emissive}` from every opaque mesh. */
function collectTriangles(root, accent) {
  const triangles = [];
  const vertex = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!object.isMesh || !object.visible) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (!material || material.transparent || material.isShaderMaterial) return;
    const geometry = object.geometry;
    const positions = geometry.attributes.position;
    if (!positions) return;
    const index = geometry.index;
    const count = index ? index.count : positions.count;
    const color = material.color ? material.color.clone() : new THREE.Color(0x888888);
    const emissive = material.emissive && material.emissiveIntensity > 0
      ? material.emissive.clone().multiplyScalar(material.emissiveIntensity)
      : null;
    const glow = accent && color.getHex() === accent;
    for (let i = 0; i < count; i += 3) {
      const corners = [];
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(i + k) : i + k;
        vertex.fromBufferAttribute(positions, vi).applyMatrix4(object.matrixWorld);
        corners.push(vertex.clone());
      }
      triangles.push({ a: corners[0], b: corners[1], c: corners[2], color, emissive, glow });
    }
  });
  return triangles;
}

/**
 * Orthographic side view from the gun's left (-x): screen-right is gun -z (muzzle points
 * right) and screen-up is gun +y. Depth is gun x (smaller x is closer to the viewer).
 */
function rasterize(triangles, width, height) {
  const bounds = new THREE.Box3();
  for (const tri of triangles) bounds.expandByPoint(tri.a).expandByPoint(tri.b).expandByPoint(tri.c);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const spanZ = size.z * MARGIN;
  const spanY = size.y * MARGIN;
  const scale = Math.min(width / spanZ, height / spanY);
  const project = (p) => ({
    x: width / 2 + (center.z - p.z) * scale,
    y: height / 2 - (p.y - center.y) * scale,
    depth: p.x,
  });
  const rgba = new Float32Array(width * height * 4);
  const depth = new Float32Array(width * height).fill(Infinity);
  const normal = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  for (const tri of triangles) {
    edge1.subVectors(tri.b, tri.a);
    edge2.subVectors(tri.c, tri.a);
    normal.crossVectors(edge1, edge2);
    if (normal.lengthSq() < 1e-12) continue;
    normal.normalize();
    const key = Math.max(0, normal.dot(KEY_LIGHT));
    const fill = Math.max(0, normal.dot(FILL_LIGHT));
    const facing = Math.max(0, -normal.x);
    const light = 0.42 + key * 0.72 + fill * 0.16 + facing * 0.1;
    let r = tri.color.r * light;
    let g = tri.color.g * light;
    let b = tri.color.b * light;
    if (tri.emissive) { r += tri.emissive.r; g += tri.emissive.g; b += tri.emissive.b; }
    if (tri.glow) { r = Math.min(1, r * 1.15 + 0.08); g = Math.min(1, g * 1.1 + 0.04); b = Math.min(1, b * 1.05); }
    const pa = project(tri.a), pb = project(tri.b), pc = project(tri.c);
    const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
    const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
    const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((pb.x - px) * (pc.y - py) - (pc.x - px) * (pb.y - py)) / area;
        const w1 = ((pc.x - px) * (pa.y - py) - (pa.x - px) * (pc.y - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * pa.depth + w1 * pb.depth + w2 * pc.depth;
        const at = y * width + x;
        if (z >= depth[at]) continue;
        depth[at] = z;
        rgba[at * 4] = r;
        rgba[at * 4 + 1] = g;
        rgba[at * 4 + 2] = b;
        rgba[at * 4 + 3] = 1;
      }
    }
  }
  return rgba;
}

/** Box-filter downsample with premultiplied-alpha averaging so edges stay clean. */
function downsample(rgba, width, height, factor) {
  const outW = width / factor;
  const outH = height / factor;
  const out = Buffer.alloc(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const at = ((y * factor + sy) * width + (x * factor + sx)) * 4;
          const alpha = rgba[at + 3];
          r += rgba[at] * alpha;
          g += rgba[at + 1] * alpha;
          b += rgba[at + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * outW + x) * 4;
      if (a > 0) {
        out[o] = Math.round(Math.min(1, r / a) * 255);
        out[o + 1] = Math.round(Math.min(1, g / a) * 255);
        out[o + 2] = Math.round(Math.min(1, b / a) * 255);
        out[o + 3] = Math.round((a / (factor * factor)) * 255);
      }
    }
  }
  return out;
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderHudIcon(weapon, { width = 480, height = 240 } = {}) {
  const cache = new MaterialCache();
  const model = buildGun(weapon, cache);
  model.flash.grp.visible = false;
  const triangles = collectTriangles(model.root, GLOW_ACCENT[weapon]);
  const superWidth = width * SUPERSAMPLE;
  const superHeight = height * SUPERSAMPLE;
  const rgba = rasterize(triangles, superWidth, superHeight);
  const pixels = downsample(rgba, superWidth, superHeight, SUPERSAMPLE);
  cache.releaseRig();
  return { png: encodePng(pixels, width, height), triangles: triangles.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const weapons = options.all ? WEAPON_IDS.slice() : [options.weapon];
  await mkdir(options.outDir, { recursive: true });
  for (const weapon of weapons) {
    const { png, triangles } = renderHudIcon(weapon, options);
    const output = path.join(options.outDir, `${weapon}.png`);
    await writeFile(output, png);
    console.log(`hud icon: ${weapon} -> ${path.relative(PROJECT_ROOT, output)} (${triangles} triangles, ${png.length} bytes)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`hud icon render failed: ${error.message}`);
    process.exit(1);
  });
}
