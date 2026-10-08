// Client presentation of structural collapses (docs/structural-physics.md):
// `creak` shakes the doomed blocks and trickles grit, `collapse` drops them
// as a rigid voxel chunk on the presented server clock, `collapseLand` bursts
// dust and debris with an impact sound and camera shake, `crumble` bursts the
// blocks that do not fall in place.
//
// Block deltas reach the world the moment their snapshot arrives, the events
// one presentation delay later. So that the blocks never vanish before their
// chunk is drawn (or show twice), everything that will move or break is held
// by proxy meshes from the moment its snapshot arrives: `receive(snapshot)`
// (before the snapshot's block deltas apply) hides those cells from the
// terrain mesher and covers them with sections built by the same mesher, and
// each section becomes visible in the frame its terrain chunk was rebuilt
// without them. The presented clock then hands cells from the proxies to the
// falling chunk (same frame), to a crumble burst, or back to the terrain
// (a creak whose blocks were saved), again swapping in the rebuild frame.
//
// Sections are world-aligned 8^3 blocks, so each lies in one 16 x 16 terrain
// column and the server's own chunk split (8^3 too) takes whole sections.
//
// Meshing is budgeted (`meshBudgetMs` per frame, receipt included): a creak
// section past the budget stays *pending*, its cells still drawn by the
// terrain (not hidden yet), and is meshed and hidden in a later frame; chunk
// meshes are built ahead of their fall the same way. Whatever the deltas of a
// snapshot remove from the store is meshed at once (cover proxies, pending
// sections a collapse claims), and a chunk still unmeshed at its start is
// built then, so every block stays drawn exactly once.
import * as THREE from '../vendor/three.module.js';
import { collapseMatrix, STRUCTURE_EVENT_KINDS, STRUCTURE_RULES } from '../../../shared/structure.js';
import { BLOCK_TINTS, blockSoundFor } from '../weapons/impacts.js';

const AIR = 0;

/** Per graphics tier: live chunk meshes, particle share, falling dust trails. */
export const STRUCTURE_FX_TIERS = Object.freeze({
  low: Object.freeze({ maxChunks: 6, particles: 0.35, trails: false }),
  medium: Object.freeze({ maxChunks: 12, particles: 0.65, trails: true }),
  high: Object.freeze({ maxChunks: 24, particles: 1, trails: true }),
  ultra: Object.freeze({ maxChunks: 32, particles: 1, trails: true }),
});

/** Presentation tuning (no gameplay meaning). */
export const STRUCTURE_FX = Object.freeze({
  /** A creak keeps its cells this long past `at + fall` for collapses released over later ticks. */
  releaseGraceMs: 200,
  /** A cover proxy whose cells never moved gives them back after this long. */
  coverTimeoutMs: 2500,
  /** Creak shake amplitude (m) ramping from the first to the second value over `fall`. */
  shake: Object.freeze([0.008, 0.03]),
  /** Grit particles per second from a creaking cluster: base + per sqrt(block). */
  gritRate: Object.freeze([16, 4.5]),
  /** Seconds between dust puffs left behind a falling chunk. */
  trailInterval: 0.07,
  /** Upper bounds per burst before the tier share. */
  landChips: 48, landDust: 72, crumbleChips: 64, crumbleDust: 24,
  /** Camera shake from a landing: range = base + perRoot * sqrt(n) metres, capped. */
  shakeRange: Object.freeze([10, 4, 70]),
  /** A chunk is dropped this long after its landing time whatever else happens. */
  staleMs: 3000,
  /** Proxy-section and chunk meshing per frame (ms, receipt included); the rest waits for later frames. */
  meshBudgetMs: 3,
});

const SECTION = 3; // log2 of the section edge (8 blocks)
/** Dust colour: this much of the block tint, the rest a pale mortar grey so clouds read against the ground. */
const SHADE = 0.4;
const DUST_BASE = Object.freeze([0.76, 0.72, 0.66]);
const linearCache = new Map();
/** Linear RGB of a block's debris tint, cached per id. */
export function blockTintLinear(type) {
  let rgb = linearCache.get(type);
  if (!rgb) {
    const color = new THREE.Color().setHex(BLOCK_TINTS[type] ?? 0x999999);
    rgb = Object.freeze([color.r, color.g, color.b]);
    linearCache.set(type, rgb);
  }
  return rgb;
}

/** The sound material of the most common listed block ('stone', 'wood', 'metal' or 'glass'). */
export function dominantMaterial(types) {
  const counts = { stone: 0, wood: 0, metal: 0, glass: 0 };
  for (let i = 0; i < types.length && i < 128; i++) counts[blockSoundFor(types[i])]++;
  let best = 'stone';
  for (const key of ['wood', 'metal', 'glass']) if (counts[key] > counts[best]) best = key;
  return best;
}

/** Deterministic 0..1 noise from an integer (shake phases, sampling). */
function hash01(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function disposeMeshes(meshes) {
  for (let i = 0; i < meshes.length; i++) {
    meshes[i].removeFromParent();
    meshes[i].geometry.dispose();
  }
  meshes.length = 0;
}

/**
 * @param {object} options
 * @param {THREE.Object3D} options.parent       scene node the proxies and chunks hang under
 * @param {object} options.mesher               terrain ChunkStore: meshCells (always) and, for
 *   masking, hideCells / showCells / cellsRebuiltSince / serial / hidden
 * @param {(x,y,z)=>number} options.getBlock     the block store the deltas write to
 * @param {{sx,sy,sz}} options.dimensions
 * @param {object|null} options.fx               ParticleField (dust, grit, debris)
 * @param {object|null} options.chips            ImpactFX (block-coloured chips)
 * @param {object|null} options.audio            sfx facade (structureCreak/Impact/Crumble)
 * @param {object|null} options.cameraShake      CameraShake bus
 * @param {() => object|null} options.getCamera  camera for shake distance
 * @param {string} options.tier                  graphics tier (STRUCTURE_FX_TIERS)
 * @param {boolean} options.masking              false for replays: no proxies, the terrain
 *   and the events advance together
 * @param {number} options.meshBudgetMs          meshing per frame (STRUCTURE_FX.meshBudgetMs)
 * @param {() => number} options.now             clock for that budget (performance.now)
 */
export class StructureFx {
  constructor({ parent, mesher, getBlock, dimensions, fx = null, chips = null, audio = null, cameraShake = null,
    getCamera = () => null, tier = 'medium', masking = true, meshBudgetMs = STRUCTURE_FX.meshBudgetMs,
    now = () => performance.now() } = {}) {
    this.root = new THREE.Group();
    this.root.name = 'structure-fx';
    parent?.add(this.root);
    this.mesher = mesher;
    this.getBlock = getBlock;
    this.SX = dimensions.sx; this.SY = dimensions.sy; this.SZ = dimensions.sz;
    this.fx = fx; this.chips = chips; this.audio = audio; this.cameraShake = cameraShake;
    this.getCamera = getCamera;
    this.masking = masking !== false && typeof mesher?.hideCells === 'function';
    this.setTier(tier);
    /** Proxies, creaks, chunks, landings and crumbles in arrival order. */
    this.holds = [];
    this.creaks = [];
    this.chunks = [];
    this.lands = [];
    this.crumbles = [];
    this.chunkById = new Map();
    /** Cells drawn by proxies: index -> section, index -> block type. */
    this.cellSection = new Map();
    this.cellType = new Map();
    /** Proxy cells a waiting chunk or crumble will take: their proxy may not let go before. */
    this.claimedCells = new Set();
    this.dirtySections = new Set();
    /** Meshing queued past the frame budget, in arrival order. */
    this.pendingSections = [];
    this.pendingChunks = [];
    this.meshBudgetMs = meshBudgetMs >= 0 ? meshBudgetMs : STRUCTURE_FX.meshBudgetMs;
    this.now = now;
    this._meshSpent = 0;
    this.receivedNow = -Infinity;
    this.clock = null;
    this.liveChunkMeshes = 0;
    this.stats = { holds: 0, sections: 0, sectionBuilds: 0, chunks: 0, chunkMeshes: 0, overCap: 0, landed: 0,
      crumbles: 0, creaks: 0, released: 0, disposedGeometries: 0, trailPuffs: 0, deferredSections: 0, deferredChunks: 0,
      forcedSections: 0, forcedChunks: 0, forcedRebuilds: 0 };
    this._matrix = new Float64Array(12);
    this._m4 = new THREE.Matrix4();
    this._pos = [0, 0, 0];
    this._params = { count: 1, scale: 1, alpha: 1, speed: 1, life: 1, color: null, dir: null, spread: undefined, ground: undefined,
      jitter: undefined };
    this._chipOpt = { speed: 1.6, gravity: 16, size: 2.6, life: 1.1, blocky: true, spread: 0.45, radial: 2.4 };
    this._up = [0, 1, 0];
    this._dust = [0, 0, 0];
    this._seed = 0x51c0;
    // The proxy neighbourhood: drawn proxy cells, else the terrain as drawn (hidden cells are air).
    this._proxyBlock = (x, y, z) => {
      if (x < 0 || z < 0 || y < 0 || x >= this.SX || z >= this.SZ || y >= this.SY) return getBlock(x, y, z);
      const index = x + this.SX * (z + this.SZ * y);
      const type = this.cellType.get(index);
      if (type !== undefined) return type;
      if (this.mesher?.hidden?.has(index)) return AIR;
      return getBlock(x, y, z);
    };
    this._disposed = false;
  }

  setTier(tier) {
    this.tier = STRUCTURE_FX_TIERS[tier] ? tier : 'medium';
    this.limits = STRUCTURE_FX_TIERS[this.tier];
  }

  index(x, y, z) { return x + this.SX * (z + this.SZ * y); }

  _rand() {
    this._seed = (this._seed + 0x6d2b79f5) | 0;
    return hash01(this._seed);
  }

  /** Decode an event's `o` + `b` into a flat [x, y, z, type, ...] list (cells inside the world only). */
  _cells(event) {
    const o = Array.isArray(event?.o) ? event.o : null, b = Array.isArray(event?.b) ? event.b : null;
    const out = [];
    if (!o || !b) return out;
    for (let i = 0; i + 3 < b.length; i += 4) {
      const x = o[0] + b[i], y = o[1] + b[i + 1], z = o[2] + b[i + 2], type = b[i + 3] | 0;
      if (!(x >= 0 && y >= 0 && z >= 0 && x < this.SX && y < this.SY && z < this.SZ) || type === AIR) continue;
      out.push(x, y, z, type);
    }
    return out;
  }

  // ---------------------------------------------------------------- receipt

  /**
   * A snapshot just arrived; call before its block deltas are applied. Holds
   * every cell its structure events will move under proxies, and drops proxy
   * cells that other deltas replace.
   */
  receive(snapshot) {
    if (this._disposed || !snapshot) return;
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    if (Number.isFinite(snapshot.serverNow)) this.receivedNow = Math.max(this.receivedNow, snapshot.serverNow);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event || !STRUCTURE_EVENT_KINDS.includes(event.kind)) continue;
      if (event.kind === 'creak') this._receiveCreak(event);
      else if (event.kind === 'collapse') this._receiveCollapse(event);
      else if (event.kind === 'crumble') this._receiveCrumble(event);
      else if (event.kind === 'collapseLand') this._receiveLand(event, snapshot.blocks);
    }
    // Any other delta into a proxy cell (a rocket during the creak) wins at once.
    const blocks = Array.isArray(snapshot.blocks) ? snapshot.blocks : null;
    if (blocks && this.cellSection.size) {
      for (let i = 0; i < blocks.length; i++) {
        const index = blocks[i]?.i;
        if (!Number.isInteger(index)) continue;
        const section = this.cellSection.get(index);
        if (!section) continue;
        if (!this.claimedCells.has(index)) { this._dropCell(index, true); continue; }
        // The store loses a claimed cell now: its proxy must exist before the terrain rebuilds.
        if (section.pending) { this._meshSection(section); this.stats.forcedSections++; }
      }
    }
    this._rebuildDirty();
    this._flushPending(false);
  }

  _receiveCreak(event) {
    const cells = this._cells(event);
    if (!cells.length) return;
    this.stats.creaks++;
    const fall = Number.isFinite(event.fall) ? event.fall : STRUCTURE_RULES.creakMs;
    const creak = {
      id: String(event.id ?? ''), at: Number(event.at) || 0, fall, n: Number(event.n) || cells.length / 4,
      center: [0, 0, 0], bottoms: [], material: 'stone', tint: [0.5, 0.5, 0.5], hold: null, sounded: false, gritCarry: 0,
      phase: hash01(cells[0] * 73856093 ^ cells[1] * 19349663 ^ cells[2] * 83492791),
    };
    const types = [];
    let cx = 0, cy = 0, cz = 0;
    const own = new Set();
    for (let i = 0; i < cells.length; i += 4) own.add(this.index(cells[i], cells[i + 1], cells[i + 2]));
    for (let i = 0; i < cells.length; i += 4) {
      const x = cells[i], y = cells[i + 1], z = cells[i + 2];
      cx += x + 0.5; cy += y + 0.5; cz += z + 0.5;
      if (types.length < 128) types.push(cells[i + 3]);
      // Grit leaves from the underside: cells with nothing of the cluster below.
      if (creak.bottoms.length < 3 * 32 && (y === 0 || !own.has(this.index(x, y - 1, z)))) creak.bottoms.push(x + 0.5, y, z + 0.5);
    }
    const count = cells.length / 4;
    creak.center[0] = cx / count; creak.center[1] = cy / count; creak.center[2] = cz / count;
    creak.material = dominantMaterial(types);
    creak.tint = this._dustTint(blockTintLinear(types[0])).slice();
    if (this.masking) creak.hold = this._hold(cells, 'creak', creak);
    this.creaks.push(creak);
  }

  _receiveCollapse(event) {
    const id = String(event.id ?? '');
    const cells = this._cells(event);
    if (!cells.length || this.chunkById.has(id) || !Array.isArray(event.p)) return;
    this.stats.chunks++;
    const index = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const local = new Map(), types = [];
    for (let i = 0; i < cells.length; i += 4) {
      const x = cells[i], y = cells[i + 1], z = cells[i + 2], k = this.index(x, y, z);
      index.push(k); local.set(k, cells[i + 3]);
      if (types.length < 128) types.push(cells[i + 3]);
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    const chunk = {
      id, event, at: Number(event.at) || 0, land: Math.max(0, Number(event.land) || 0), cells, index,
      n: Number(event.n) || index.length, min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
      material: dominantMaterial(types), tint: blockTintLinear(types[0]),
      group: null, meshes: [], state: 'waiting', rubble: null, rubbleSerial: 0, trailCarry: 0,
    };
    if (this.liveChunkMeshes < this.limits.maxChunks) {
      // The mesh slot is taken now; the mesh is built within the budget (at the latest when it falls).
      chunk.local = local;
      chunk.meshPending = true;
      this.liveChunkMeshes++;
      this.pendingChunks.push(chunk);
    } else this.stats.overCap++;
    if (this.masking) this._claim(cells, index);
    this.chunks.push(chunk);
    this.chunkById.set(id, chunk);
  }

  /** Build a chunk's mesh (hidden until it falls); frees its slot when nothing is drawable. */
  _meshChunk(chunk) {
    if (!chunk.meshPending) return;
    chunk.meshPending = false;
    const local = chunk.local;
    chunk.local = null;
    // Broken loose: only the chunk's own blocks hide faces and shade corners.
    const meshes = this.mesher.meshCells(chunk.cells, (x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= this.SX || y >= this.SY || z >= this.SZ) return AIR;
      return local.get(this.index(x, y, z)) ?? AIR;
    });
    if (!meshes.length) { this.liveChunkMeshes--; return; }
    const group = new THREE.Group();
    group.name = `structure-chunk-${chunk.id}`;
    group.matrixAutoUpdate = false;
    group.visible = false;
    for (const mesh of meshes) group.add(mesh);
    this.root.add(group);
    chunk.group = group;
    chunk.meshes = meshes;
    this.stats.chunkMeshes++;
  }

  _receiveCrumble(event) {
    const cells = this._cells(event);
    if (!cells.length) return;
    const index = [], types = [];
    for (let i = 0; i < cells.length; i += 4) {
      index.push(this.index(cells[i], cells[i + 1], cells[i + 2]));
      if (types.length < 128) types.push(cells[i + 3]);
    }
    if (this.masking) this._claim(cells, index);
    this.crumbles.push({ at: Number(event.at) || 0, n: Number(event.n) || index.length, cells, index,
      material: dominantMaterial(types) });
  }

  /** Cells a chunk or crumble takes when its time comes: covered now, held until then. */
  _claim(cells, index) {
    this._cover(cells);
    for (let i = 0; i < index.length; i++) {
      const section = this.cellSection.get(index[i]);
      if (!section || this.claimedCells.has(index[i])) continue;
      this.claimedCells.add(index[i]);
      section.hold.claimed++;
    }
  }

  _receiveLand(event, blocks) {
    if (![event.x, event.y, event.z].every(Number.isFinite)) return;
    const chunk = this.chunkById.get(String(event.id ?? ''));
    this.lands.push({ at: Number(event.at) || 0, x: event.x, y: event.y, z: event.z, n: Number(event.n) || 1,
      speed: Number(event.speed) || 0, chunk: chunk || null });
    // Rubble arrives with this snapshot but must appear when the chunk lands on the presented clock.
    if (!this.masking || !chunk || chunk.state === 'landed' || chunk.state === 'done' || !Array.isArray(blocks) || !blocks.length) return;
    // Landing offset of the pivot (the server collides the unrotated blocks): d = p(land) - p.
    const pose = collapseMatrix(chunk.event, chunk.land, this._matrix);
    const p = chunk.event.p, off = [0, 0, 0];
    off[0] = pose[0] * p[0] + pose[1] * p[1] + pose[2] * p[2] + pose[3] - p[0];
    off[1] = pose[4] * p[0] + pose[5] * p[1] + pose[6] * p[2] + pose[7] - p[1];
    off[2] = pose[8] * p[0] + pose[9] * p[1] + pose[10] * p[2] + pose[11] - p[2];
    const x0 = chunk.min[0] + Math.floor(off[0]) - 1, x1 = chunk.max[0] + Math.ceil(off[0]) + 1;
    const z0 = chunk.min[2] + Math.floor(off[2]) - 1, z1 = chunk.max[2] + Math.ceil(off[2]) + 1;
    const y0 = chunk.min[1] + Math.floor(off[1]) - STRUCTURE_RULES.rubble.settle - 1, y1 = chunk.max[1] + Math.ceil(off[1]);
    const rubble = [];
    const SX = this.SX, SZ = this.SZ;
    for (let i = 0; i < blocks.length; i++) {
      const delta = blocks[i], index = delta?.i;
      if (!Number.isInteger(index) || !(delta.v > 0)) continue;
      const x = index % SX, z = Math.floor(index / SX) % SZ, y = Math.floor(index / (SX * SZ));
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) rubble.push(index);
    }
    if (!rubble.length) return;
    chunk.rubble = rubble;
    this.mesher.hideCells(rubble);
  }

  /** Cover cells no proxy draws yet with a cover proxy (a collapse or crumble without its creak). */
  _cover(cells) {
    let missing = null;
    for (let i = 0; i < cells.length; i += 4) {
      if (this.cellSection.has(this.index(cells[i], cells[i + 1], cells[i + 2]))) continue;
      (missing ??= []).push(cells[i], cells[i + 1], cells[i + 2], cells[i + 3]);
    }
    // The store loses these cells with this snapshot: no budget, the proxy must exist now.
    if (missing) this._hold(missing, 'cover', null, true);
  }

  /**
   * A proxy over the cells no other proxy holds. Its sections are meshed (and
   * their cells leave the terrain mesh) now when `sync` or within the budget,
   * else they stay pending and the terrain keeps drawing their cells.
   */
  _hold(cells, kind, creak, sync = false) {
    const hold = { kind, creak, group: new THREE.Group(), sections: [], cells: 0, claimed: 0, born: this.receivedNow,
      releasing: false };
    const byKey = new Map();
    hold.group.name = `structure-${kind}`;
    const added = [];
    for (let i = 0; i < cells.length; i += 4) {
      const x = cells[i], y = cells[i + 1], z = cells[i + 2], type = cells[i + 3];
      const index = this.index(x, y, z);
      if (this.cellSection.has(index)) continue;
      // Only blocks the terrain still draws (the store holds them now, before this snapshot's deltas).
      if (this.getBlock(x, y, z) === AIR) continue;
      const key = ((y >> SECTION) * 4096 + (z >> SECTION)) * 4096 + (x >> SECTION);
      let section = byKey.get(key);
      if (!section) {
        section = { key, hold, chunkKey: `${x >> 4},${z >> 4}`, cells: new Map(), meshes: [], serial: 0,
          shown: !this.masking, releasing: false, dead: false, pending: true };
        byKey.set(key, section);
        hold.sections.push(section);
        this.stats.sections++;
      }
      section.cells.set(index, type);
      this.cellSection.set(index, section);
      this.cellType.set(index, type);
      added.push(index);
      hold.cells++;
    }
    if (!hold.cells) return null;
    this.root.add(hold.group);
    this.holds.push(hold);
    this.stats.holds++;
    for (const section of hold.sections) {
      if (sync) this._meshSection(section);
      else this.pendingSections.push(section);
    }
    return hold;
  }

  /** Mesh a pending section and take its cells from the terrain mesh (shown once that rebuilt). */
  _meshSection(section) {
    if (!section.pending) return;
    section.pending = false;
    if (section.dead || section.releasing) return;
    if (!section.cells.size) { this._removeSection(section); return; }
    this.mesher.hideCells([...section.cells.keys()]);
    section.serial = this.mesher.serial;
    section.shown = !this.masking;
    this._meshCells(section);
  }

  _meshCells(section) {
    disposeMeshes(section.meshes);
    const flat = [];
    for (const [index, type] of section.cells) {
      flat.push(index % this.SX, Math.floor(index / (this.SX * this.SZ)), Math.floor(index / this.SX) % this.SZ, type);
    }
    const meshes = this.mesher.meshCells(flat, this._proxyBlock);
    this.stats.sectionBuilds++;
    for (const mesh of meshes) { mesh.visible = section.shown; section.hold.group.add(mesh); }
    section.meshes = meshes;
  }

  /**
   * Mesh queued chunks, then queued sections, until this frame's budget is
   * spent (`progress`: at least one item, so the queues always drain).
   */
  _flushPending(progress) {
    let first = progress;
    while (this.pendingChunks.length || this.pendingSections.length) {
      if (!first && this._meshSpent >= this.meshBudgetMs) break;
      first = false;
      const started = this.now();
      if (this.pendingChunks.length) {
        const chunk = this.pendingChunks.shift();
        if (chunk.state === 'waiting' && chunk.meshPending) { this._meshChunk(chunk); this.stats.deferredChunks++; }
      } else {
        const section = this.pendingSections.shift();
        if (section.pending && !section.dead) { this._meshSection(section); this.stats.deferredSections++; }
      }
      this._meshSpent += this.now() - started;
    }
  }

  /**
   * A cell leaves its proxy: the section and the proxy neighbours that hid
   * faces against it remesh. A pending section never hid its cells.
   */
  _dropCell(index, show) {
    const section = this.cellSection.get(index);
    if (!section) return;
    if (section.pending) show = false;
    this.cellSection.delete(index);
    this.cellType.delete(index);
    section.cells.delete(index);
    section.hold.cells--;
    if (this.claimedCells.delete(index)) section.hold.claimed--;
    this.dirtySections.add(section);
    const SX = this.SX, SZ = this.SZ;
    const x = index % SX, z = Math.floor(index / SX) % SZ, y = Math.floor(index / (SX * SZ));
    if (x > 0) this._touch(index - 1);
    if (x < SX - 1) this._touch(index + 1);
    if (z > 0) this._touch(index - SX);
    if (z < SZ - 1) this._touch(index + SX);
    if (y > 0) this._touch(index - SX * SZ);
    if (y < this.SY - 1) this._touch(index + SX * SZ);
    if (show) this.mesher.showCells?.([index]);
  }

  _dropCells(index) {
    let held = null;
    for (let i = 0; i < index.length; i++) {
      const section = this.cellSection.get(index[i]);
      if (!section) continue;
      const hidden = !section.pending;
      this._dropCell(index[i], false);
      if (hidden) (held ??= []).push(index[i]);
    }
    if (held) this.mesher.showCells?.(held);
  }

  _touch(index) {
    const section = this.cellSection.get(index);
    if (section) this.dirtySections.add(section);
  }

  _rebuildDirty() {
    if (!this.dirtySections.size) return;
    for (const section of this.dirtySections) {
      if (section.releasing || section.dead) continue;
      if (!section.cells.size) { this._removeSection(section); continue; }
      // A pending section is meshed with its cells as they are then.
      if (section.pending) continue;
      // A drawn section must lose a dropped cell in the same frame: no budget here.
      this._meshCells(section);
    }
    this.dirtySections.clear();
  }

  // ------------------------------------------------------------- presentation

  /**
   * Per frame, after the terrain's rebuild budget ran (WorldView.update):
   * `clock` is the presented server time (ms), the same timeline the events
   * are drained on.
   */
  update(dt, clock) {
    if (this._disposed || !Number.isFinite(clock)) return;
    this.clock = clock;
    // A new frame's meshing budget (snapshots received since the last frame spent part of the old one).
    this._meshSpent = 0;
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    // Chunks start and land first: their cells leave the proxies before the proxies rebuild.
    for (let i = 0; i < this.chunks.length; i++) this._updateChunk(this.chunks[i], clock, step);
    for (let i = 0; i < this.crumbles.length; i++) {
      const crumble = this.crumbles[i];
      if (clock < crumble.at) continue;
      this._burst(crumble);
      this.crumbles.splice(i--, 1);
    }
    for (let i = 0; i < this.lands.length; i++) {
      const land = this.lands[i];
      if (clock < land.at) continue;
      this._land(land);
      this.lands.splice(i--, 1);
    }
    for (let i = 0; i < this.creaks.length; i++) {
      if (this._updateCreak(this.creaks[i], clock, step)) this.creaks.splice(i--, 1);
    }
    this._rebuildDirty();
    this._flushPending(true);
    for (let i = 0; i < this.holds.length; i++) {
      if (this._updateHold(this.holds[i], clock)) { this.root.remove(this.holds[i].group); this.holds.splice(i--, 1); }
    }
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].state === 'done') { this.chunkById.delete(this.chunks[i].id); this.chunks.splice(i--, 1); }
    }
  }

  _updateCreak(creak, clock, step) {
    const end = creak.at + creak.fall;
    const hold = creak.hold;
    if (clock >= creak.at && clock < end) {
      if (!creak.sounded) {
        creak.sounded = true;
        this.audio?.structureCreak?.(creak.center, { n: creak.n, material: creak.material, seconds: creak.fall / 1000 });
      }
      const k = (clock - creak.at) / Math.max(1, creak.fall);
      if (hold && !hold.releasing) {
        const amp = STRUCTURE_FX.shake[0] + (STRUCTURE_FX.shake[1] - STRUCTURE_FX.shake[0]) * k * k;
        const t = clock * 0.001, ph = creak.phase * 40;
        hold.group.position.set(amp * Math.sin(t * 53 + ph), amp * 0.35 * Math.sin(t * 71 + ph * 1.7),
          amp * Math.sin(t * 61 + ph * 2.3));
      }
      // Grit trickles faster as the fall nears.
      const rate = (STRUCTURE_FX.gritRate[0] + STRUCTURE_FX.gritRate[1] * Math.sqrt(creak.n)) * this.limits.particles * (0.4 + k);
      creak.gritCarry += rate * step;
      while (creak.gritCarry >= 1 && this.fx && creak.bottoms.length) {
        creak.gritCarry -= 1;
        const pick = Math.floor(this._rand() * (creak.bottoms.length / 3)) * 3;
        this._pos[0] = creak.bottoms[pick] + (this._rand() - 0.5) * 0.8;
        this._pos[1] = creak.bottoms[pick + 1] - 0.05;
        this._pos[2] = creak.bottoms[pick + 2] + (this._rand() - 0.5) * 0.8;
        this._emit('grit', this._pos, 1, 1, 1, creak.tint);
      }
      if (creak.gritCarry > 4) creak.gritCarry = 0;
    } else if (hold && clock >= end) hold.group.position.set(0, 0, 0);
    // Saved blocks (support restored in time) go back to the terrain after the grace.
    const release = end + STRUCTURE_FX.releaseGraceMs;
    if (clock < release) return false;
    // Wait for the ticks that could still carry its collapses, and for the chunks already on their way.
    if (hold && this.masking && (this.receivedNow < release || hold.claimed > 0) && clock < release + STRUCTURE_FX.staleMs) return false;
    if (hold && !hold.releasing) this._release(hold);
    return true;
  }

  /** Give a proxy's remaining cells back to the terrain; each section goes once its chunk rebuilt. */
  _release(hold) {
    hold.releasing = true;
    hold.group.position.set(0, 0, 0);
    for (const section of hold.sections.slice()) {
      const index = [...section.cells.keys()], hidden = !section.pending;
      for (const k of index) {
        this.cellSection.delete(k); this.cellType.delete(k);
        if (this.claimedCells.delete(k)) hold.claimed--;
      }
      section.cells.clear();
      section.releasing = true;
      this.dirtySections.delete(section);
      this.stats.released += index.length;
      // Cells the store no longer holds (or a pending section never hid) need no
      // terrain rebuild: the proxy goes now.
      if (!this.masking || !hidden || !this.mesher.showCells(index)) {
        this._removeSection(section);
        continue;
      }
      section.serial = this.mesher.serial;
    }
    hold.cells = 0;
  }

  /** Show sections whose terrain rebuilt without them; drop released ones once it rebuilt with them. */
  _updateHold(hold, clock) {
    if (hold.kind === 'cover' && !hold.releasing && hold.cells > 0 && hold.claimed === 0 && Number.isFinite(hold.born)
      && clock > hold.born + STRUCTURE_FX.coverTimeoutMs && this.receivedNow > hold.born + STRUCTURE_FX.coverTimeoutMs) {
      this._release(hold);
    }
    const sections = hold.sections;
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section.releasing) {
        if (!this.masking || this._rebuilt(section)) { this._removeSection(section); i--; }
        continue;
      }
      if (section.pending) continue;
      if (!section.shown && this._rebuilt(section)) {
        section.shown = true;
        for (let m = 0; m < section.meshes.length; m++) section.meshes[m].visible = true;
      }
      if (!section.cells.size) { this._removeSection(section); i--; }
    }
    return sections.length === 0;
  }

  /**
   * Cells about to leave their proxies: a proxy section that is not shown yet
   * (its terrain column has not rebuilt since the cells were hidden, e.g. a
   * starved rebuild budget) would leave the stale terrain drawing them next to
   * the chunk. Rebuild that column now (rare).
   */
  _settle(index) {
    if (!this.masking || typeof this.mesher.rebuildChunk !== 'function') return;
    let seen = null;
    for (let i = 0; i < index.length; i++) {
      const section = this.cellSection.get(index[i]);
      if (!section || section.shown || section.pending || (seen && seen.has(section))) continue;
      (seen ??= new Set()).add(section);
      if (!this._rebuilt(section)) {
        const [cx, cz] = section.chunkKey.split(',').map(Number);
        this.mesher.rebuildChunk(cx, cz);
        this.stats.forcedRebuilds++;
      }
      section.shown = true;
      for (let m = 0; m < section.meshes.length; m++) section.meshes[m].visible = true;
    }
  }

  _rebuilt(section) {
    const rec = this.mesher.chunks?.get?.(section.chunkKey);
    return !rec || rec.serial > section.serial;
  }

  _removeSection(section) {
    if (section.dead) return;
    section.dead = true;
    disposeMeshes(section.meshes);
    const list = section.hold.sections, at = list.indexOf(section);
    if (at >= 0) list.splice(at, 1);
    this.dirtySections.delete(section);
  }

  _updateChunk(chunk, clock, step) {
    if (chunk.state === 'done') return;
    const t = clock - chunk.at;
    if (chunk.state === 'waiting') {
      if (t < 0) return;
      if (chunk.meshPending) { this._meshChunk(chunk); this.stats.forcedChunks++; }
      this._settle(chunk.index);
      // Start: the cells leave the proxies (and the terrain mask: the store is air there) this frame.
      this._dropCells(chunk.index);
      chunk.state = 'falling';
      if (chunk.group) chunk.group.visible = true;
      else this._burst({ cells: chunk.cells, n: chunk.n, material: chunk.material, at: chunk.at, quiet: true });
    }
    if (chunk.state === 'falling') {
      if (chunk.group) {
        const m = collapseMatrix(chunk.event, t, this._matrix);
        this._m4.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
        chunk.group.matrix.copy(this._m4);
        chunk.group.matrixWorldNeedsUpdate = true;
        if (this.limits.trails && this.fx) {
          chunk.trailCarry += step;
          if (chunk.trailCarry >= STRUCTURE_FX.trailInterval) {
            chunk.trailCarry = 0;
            const p = chunk.event.p;
            this._pos[0] = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
            this._pos[1] = m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7] + (chunk.max[1] - chunk.min[1] + 1) * 0.5;
            this._pos[2] = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
            const size = Math.sqrt(chunk.index.length);
            this.stats.trailPuffs++;
            this._emit('dust', this._pos, 2 + (size > 6 ? 1 : 0), 0.45 + size * 0.07, 0.95, this._dustTint(chunk.tint), 0.35, 0.8);
          }
        }
      }
      if (t >= chunk.land) this._chunkLanded(chunk);
    } else if (chunk.state === 'landed') {
      if (!chunk.rubble || this.mesher.cellsRebuiltSince(chunk.rubble, chunk.rubbleSerial) || t > chunk.land + STRUCTURE_FX.staleMs) {
        this._finishChunk(chunk);
      }
    }
    if (chunk.state !== 'done' && t > chunk.land + STRUCTURE_FX.staleMs + STRUCTURE_RULES.maxFallMs) this._finishChunk(chunk);
  }

  _chunkLanded(chunk) {
    chunk.state = 'landed';
    this.stats.landed++;
    const m = collapseMatrix(chunk.event, chunk.land, this._matrix);
    // The chunk breaks up: block-coloured chips from a sample of its blocks where they landed.
    const count = chunk.index.length;
    const chips = Math.max(4, Math.round(Math.min(STRUCTURE_FX.landChips, 6 + count * 0.5) * this.limits.particles));
    for (let i = 0; i < chips; i++) {
      const c = Math.floor(this._rand() * count) * 4;
      const x = chunk.cells[c] + 0.5, y = chunk.cells[c + 1] + 0.5, z = chunk.cells[c + 2] + 0.5;
      this._pos[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
      this._pos[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      this._pos[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      this.chips?.spawnParticles(this._pos[0], this._pos[1], this._pos[2], 1, BLOCK_TINTS[chunk.cells[c + 3]] ?? 0x999999, this._chipOpt);
    }
    if (chunk.rubble && this.masking) {
      this.mesher.showCells(chunk.rubble);
      chunk.rubbleSerial = this.mesher.serial;
      // The landed chunk stays one more terrain rebuild, until the rubble is drawn.
      return;
    }
    this._finishChunk(chunk);
  }

  _finishChunk(chunk) {
    if (chunk.state === 'done') return;
    if (chunk.state === 'waiting') this._dropCells(chunk.index);
    if (chunk.rubble && chunk.state !== 'landed' && this.masking) this.mesher.showCells(chunk.rubble);
    chunk.state = 'done';
    if (chunk.meshPending) { chunk.meshPending = false; chunk.local = null; this.liveChunkMeshes--; }
    if (chunk.group) {
      this.stats.disposedGeometries += chunk.meshes.length;
      disposeMeshes(chunk.meshes);
      chunk.group.removeFromParent();
      chunk.group = null;
      this.liveChunkMeshes--;
    }
  }

  /** Dust cloud, impact sound, camera shake and a few bits where a chunk hit the ground. */
  _land(land) {
    const chunk = land.chunk;
    const n = Math.max(1, land.n), speed = Math.max(0, land.speed);
    const root = Math.sqrt(n), hard = Math.min(1.4, speed / 9);
    const ground = chunk ? land.y - (chunk.max[1] - chunk.min[1] + 1) * 0.5 : land.y - 0.5;
    const tint = this._dustTint(chunk?.tint ?? [0.5, 0.48, 0.44]);
    this._pos[0] = land.x; this._pos[1] = ground + 0.2; this._pos[2] = land.z;
    const dust = Math.round(Math.min(STRUCTURE_FX.landDust, 10 + root * 5 * (0.5 + hard)) * this.limits.particles);
    const params = this._params;
    // The cloud covers the footprint: a fast ring rolling out along the ground, then a slow billow.
    params.ground = ground; params.jitter = Math.max(0.5, Math.min(4.5, 0.4 * root)); params.dir = this._up;
    params.spread = 1.5;
    this._emit('dust', this._pos, dust, 1.1 + root * 0.13, 1.4, tint, 1.6 + hard * 0.6, 1.4);
    params.spread = 0.7;
    this._emit('dust', this._pos, Math.max(1, Math.round(dust * 0.5)), 1.4 + root * 0.15, 1.1, tint, 0.7, 2);
    params.ground = undefined; params.jitter = undefined; params.dir = null; params.spread = undefined;
    const bits = Math.max(3, Math.round(Math.min(16, 3 + root) * this.limits.particles));
    if (this.fx) {
      params.count = bits; params.scale = 0.9 + root * 0.04; params.alpha = 1; params.speed = 0.6 + hard * 0.4;
      params.life = 1; params.color = chunk?.tint ?? tint; params.dir = this._up; params.spread = 1.2;
      this.fx.emit('debris', this._pos, params);
      params.dir = null; params.spread = undefined; params.color = null;
    }
    this.audio?.structureImpact?.([land.x, ground, land.z], { n, speed, material: chunk?.material ?? 'stone' });
    const camera = this.getCamera?.();
    if (this.cameraShake && camera?.position) {
      const [base, perRoot, cap] = STRUCTURE_FX.shakeRange;
      const range = Math.min(cap, base + perRoot * root);
      const d = Math.hypot(land.x - camera.position.x, ground - camera.position.y, land.z - camera.position.z);
      if (d < range) {
        const falloff = 1 - d / range;
        this.cameraShake.add(Math.min(0.7, 0.05 * root * (0.35 + hard)) * falloff * falloff);
      }
    }
  }

  /** Blocks that break where they stand: proxies let go, chips, dust and a crumble sound. */
  _burst(burst) {
    this.stats.crumbles++;
    const cells = burst.cells, count = cells.length / 4;
    if (burst.index) { this._settle(burst.index); this._dropCells(burst.index); }
    const chips = Math.max(3, Math.round(Math.min(STRUCTURE_FX.crumbleChips, 4 + count * 0.4) * this.limits.particles));
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < count; i++) { cx += cells[i * 4]; cy += cells[i * 4 + 1]; cz += cells[i * 4 + 2]; }
    cx = cx / count + 0.5; cy = cy / count + 0.5; cz = cz / count + 0.5;
    for (let i = 0; i < chips; i++) {
      const c = Math.floor(this._rand() * count) * 4;
      this.chips?.spawnParticles(cells[c] + 0.5, cells[c + 1] + 0.5, cells[c + 2] + 0.5, 1,
        BLOCK_TINTS[cells[c + 3]] ?? 0x999999, this._chipOpt);
    }
    const puffs = Math.max(1, Math.round(Math.min(STRUCTURE_FX.crumbleDust, 2 + Math.sqrt(count) * 1.5) * this.limits.particles));
    const tint = this._dustTint(blockTintLinear(cells[3]));
    for (let i = 0; i < puffs; i++) {
      const c = Math.floor(this._rand() * count) * 4;
      this._pos[0] = cells[c] + 0.5; this._pos[1] = cells[c + 1] + 0.3; this._pos[2] = cells[c + 2] + 0.5;
      this._emit('dust', this._pos, 2, 0.9, 1.1, tint, 0.9);
      this._emit('grit', this._pos, 3, 1, 1, tint);
    }
    if (!burst.quiet) this.audio?.structureCrumble?.([cx, cy, cz], { n: burst.n ?? count, material: burst.material ?? 'stone' });
  }

  _dustTint(tint) {
    const out = this._dust;
    out[0] = tint[0] * SHADE + DUST_BASE[0] * (1 - SHADE); out[1] = tint[1] * SHADE + DUST_BASE[1] * (1 - SHADE);
    out[2] = tint[2] * SHADE + DUST_BASE[2] * (1 - SHADE);
    return out;
  }

  _emit(kind, pos, count, scale = 1, alpha = 1, color = null, speed = 1, life = 1) {
    if (!this.fx || count <= 0) return 0;
    const params = this._params;
    params.count = count; params.scale = scale; params.alpha = alpha; params.color = color; params.speed = speed; params.life = life;
    return this.fx.emit(kind, pos, params);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Drop everything (killcam start, map change): the terrain draws its own blocks again. */
  clear() {
    for (const chunk of this.chunks) this._finishChunk(chunk);
    this.chunks.length = 0;
    this.chunkById.clear();
    for (const hold of this.holds) {
      for (const section of hold.sections) {
        if (!section.releasing && !section.pending && this.masking) this.mesher.showCells([...section.cells.keys()]);
        section.cells.clear();
        section.dead = true;
        disposeMeshes(section.meshes);
      }
      hold.sections.length = 0;
      this.root.remove(hold.group);
    }
    this.holds.length = 0;
    this.cellSection.clear();
    this.cellType.clear();
    this.claimedCells.clear();
    this.dirtySections.clear();
    this.pendingSections.length = 0;
    this.pendingChunks.length = 0;
    this.creaks.length = 0;
    this.lands.length = 0;
    this.crumbles.length = 0;
    this.liveChunkMeshes = 0;
  }

  /** Meshing still queued past the frame budget (tests, diagnostics). */
  get pending() {
    let sections = 0, chunks = 0;
    for (const section of this.pendingSections) if (section.pending && !section.dead) sections++;
    for (const chunk of this.pendingChunks) if (chunk.meshPending) chunks++;
    return { sections, chunks };
  }

  /** Live proxy and chunk counts (tests, diagnostics). */
  get counts() {
    let sections = 0, meshes = 0;
    for (const hold of this.holds) for (const section of hold.sections) { sections++; meshes += section.meshes.length; }
    return { holds: this.holds.length, sections, sectionMeshes: meshes, chunks: this.chunks.length,
      chunkMeshes: this.liveChunkMeshes, heldCells: this.cellSection.size, creaks: this.creaks.length,
      lands: this.lands.length, crumbles: this.crumbles.length };
  }

  dispose() {
    if (this._disposed) return;
    this.clear();
    this._disposed = true;
    this.root.removeFromParent();
  }
}
