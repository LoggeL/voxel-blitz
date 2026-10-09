// Every map loads with structural integrity on and nothing collapses: blocks
// the rules cannot support are pinned as authored anchors, the world keeps
// its template voxels (fingerprints unchanged), and support memory and build
// time stay bounded. Damage next to pinned blocks then settles sensibly.
// Ground materials used as building material (demoted, structure-ground.js)
// fall exactly like the same blocks made of brick, on every map; the
// Minecraft B5 lighthouse and the Citadel bell tower come down whole.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { destroyBlockDirect } from '../server/sim/combat.js';
import { SupportField, keyX, keyY, keyZ, pack } from '../server/sim/structure-field.js';
import { MAP_IDS, createMapState, getMapMeta } from '../shared/worlddata.js';
import { MODE_IDS, isModeMapCompatible } from '../shared/modes.js';
import { STRUCTURE_EVENT_KINDS } from '../shared/structure.js';
import { BRICK, GROUND, MC_CLOUD, MC_STONE, STONE, isSolidBlock } from '../shared/world/blocks.js';

let passed = 0;
const ok = (value, message) => { assert.ok(value, message); passed++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); passed++; };
const rows = [];

for (const id of MAP_IDS) {
  const world = createMapState(id);
  const fingerprint = world.templateFingerprint;
  const started = performance.now();
  const events = [];
  const mode = MODE_IDS.find(m => isModeMapCompatible(m, id));
  const engine = new GameEngine({ world, mode, mapMeta: getMapMeta(id), broadcast: (s) => events.push(...s.events) });
  const bindMs = performance.now() - started;
  const structure = engine.structure;
  ok(structure.active, `${id}: structural integrity is on by default`);
  const field = structure.field, base = field.base;
  ok(base, `${id}: the room forks the template's support field`);
  for (let i = 0; i < 30; i++) engine.step();
  const structural = events.filter(e => STRUCTURE_EVENT_KINDS.includes(e.kind));
  ok(structural.length === 0, `${id}: nothing creaks or collapses at load (${structural.length} events)`);
  ok(world.matchesTemplate() && world.mutationCount === 0, `${id}: load leaves the template voxels untouched`);
  ok(world.templateFingerprint === fingerprint, `${id}: map fingerprint unchanged`);
  let templateChunks = 0;
  for (const chunk of base.slots) if (chunk) templateChunks++;
  const templateBytes = templateChunks * 512 + base.slots.length * 8;
  ok(templateBytes < 8e6, `${id}: template support memory bounded (${(templateBytes / 1e6).toFixed(2)} MB)`);
  ok(structure.memory().chunks === 0, `${id}: an untouched room owns no support chunks`);

  // Damage around the pinned (authored-floating) blocks and through ordinary
  // structures: everything settles, falls are bounded, the field stays exact.
  const pins = field.pinKeys();
  const targets = [];
  for (let i = 0; i < pins.length && targets.length < 24; i += Math.max(1, Math.floor(pins.length / 24))) targets.push(pins[i]);
  const { sx, sy, sz } = world.dimensions;
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let tries = 0; targets.length < 48 && tries < 200000; tries++) {
    const x = Math.floor(random() * sx), y = 1 + Math.floor(random() * (sy - 1)), z = Math.floor(random() * sz);
    if (field.kindAt(x, y, z) === 2) targets.push((y << 20) | (z << 10) | x);
  }
  for (const key of targets) destroyBlockDirect(keyX(key), keyY(key), keyZ(key), null, engine.contexts.combat, null);
  let ticks = 0;
  for (; ticks < 3000 && !structure.idle; ticks++) engine.step();
  ok(structure.idle, `${id}: damage near pinned blocks settles (${ticks} ticks)`);
  const fell = events.filter(e => e.kind === 'collapse' || e.kind === 'crumble').reduce((n, e) => n + e.n, 0);
  ok(fell < 40000, `${id}: ${targets.length} removals bring down a bounded ${fell} blocks`);
  if (id !== 'frontier') {
    const rebuilt = SupportField.build(world.dimensions, (x, y, z) => world.getBlock(x, y, z), { pins: field.pinKeys(), demoted: field.demoted });
    let mismatches = 0;
    for (let y = 1; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      if (field.kindAt(x, y, z) === 2 && rebuilt.read(x, y, z) !== field.read(x, y, z)) mismatches++;
    }
    ok(mismatches === 0, `${id}: incremental support equals a rebuild after the damage (${mismatches})`);
  }
  rows.push(`${id.padEnd(14)} ${mode.padEnd(8)} structural ${String(base.structural).padStart(7)} pins ${String(base.pins).padStart(5)} (props ${String(base.props?.size ?? 0).padStart(4)}) demoted ${String(demotedCells(base).length).padStart(5)}`
    + ` template ${(templateBytes / 1e6).toFixed(2)} MB bind ${bindMs.toFixed(0)} ms, damage ${targets.length} -> fell ${fell}`);
  engine.stop();
}
console.log(rows.join('\n'));

// Ground material as building material, per map: the largest demoted
// clusters away from the map edge (the edge holds boundary dressing leaning on
// the metal shell) lose the lowest block of every column, and exactly the
// blocks that would fall if those cells were BRICK fall (before demotion,
// ground material was an anchor and nothing fell).
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function demotedCells(field) {
  const out = [];
  if (!field.demoted) return out;
  for (let c = 0; c < field.demoted.length; c++) {
    const bits = field.demoted[c];
    if (!bits) continue;
    const cx = c % field.ncx, cz = Math.floor(c / field.ncx) % field.ncz, cy = Math.floor(c / (field.ncx * field.ncz));
    for (let i = 0; i < 512; i++) {
      if (!((bits[i >> 3] >> (i & 7)) & 1)) continue;
      const x = (cx << 3) | (i & 7), y = (cy << 3) | (i >> 6), z = (cz << 3) | ((i >> 3) & 7);
      if (y > 0 && field.kindAt(x, y, z) === 2) out.push(pack(x, y, z));
    }
  }
  return out;
}
function groundStructures(field) {
  const cells = new Set(demotedCells(field)), seen = new Set(), out = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    const group = [start];
    seen.add(start);
    for (let h = 0; h < group.length; h++) for (const [dx, dy, dz] of N6) {
      const next = pack(keyX(group[h]) + dx, keyY(group[h]) + dy, keyZ(group[h]) + dz);
      if (cells.has(next) && !seen.has(next)) { seen.add(next); group.push(next); }
    }
    const ys = group.map(keyY), inner = group.every(k => keyX(k) >= 4 && keyZ(k) >= 4 && keyX(k) < field.sx - 4 && keyZ(k) < field.sz - 4);
    if (inner && Math.max(...ys) > Math.min(...ys)) out.push(group);
  }
  return out.sort((a, b) => b.length - a.length);
}
const roomFor = (id) => {
  const engine = new GameEngine({ world: createMapState(id), mode: MODE_IDS.find(m => isModeMapCompatible(m, id)), mapMeta: getMapMeta(id) });
  const doom = engine.structure.doom.bind(engine.structure);
  engine.doomedKeys = new Set();
  engine.structure.doom = (keys, cause, origin, options) => { for (const k of keys) engine.doomedKeys.add(k); doom(keys, cause, origin, options); };
  return engine;
};
const settle = (engine) => {
  let ticks = 0;
  for (; ticks < 6000 && !engine.structure.idle; ticks++) engine.step();
  return ticks;
};
const cutBase = (engine, cells) => {
  const low = new Map();
  for (const k of cells) { const col = keyX(k) * 1024 + keyZ(k); if (!low.has(col) || keyY(low.get(col)) > keyY(k)) low.set(col, k); }
  const cut = new Set(low.values());
  for (const k of cut) destroyBlockDirect(keyX(k), keyY(k), keyZ(k), null, engine.contexts.combat, null);
  return cells.filter(k => !cut.has(k));
};
const groundRows = [];
let groundFell = 0;
for (const id of MAP_IDS) {
  const probe = roomFor(id), picks = groundStructures(probe.structure.field).slice(0, 2);
  probe.stop();
  const parts = [];
  for (const cells of picks) {
    const asGround = roomFor(id), asBrick = roomFor(id);
    asBrick.structure.beginBulk();
    for (const k of cells) asBrick.world.setBlock(keyX(k), keyY(k), keyZ(k), BRICK);
    asBrick.structure.reset();
    const above = cutBase(asGround, cells);
    cutBase(asBrick, cells);
    ok(settle(asGround) < 6000 && settle(asBrick) < 6000, `${id}: the cut settles`);
    const fell = above.filter(k => asGround.doomedKeys.has(k)), fellBrick = above.filter(k => asBrick.doomedKeys.has(k));
    eq(fell, fellBrick, `${id}: a ${cells.length}-block ground-material structure falls like brick (${fell.length}/${above.length})`);
    groundFell += fell.length;
    parts.push(`${cells.length} blocks -> ${fell.length}/${above.length} fell`);
    asGround.stop(); asBrick.stop();
  }
  groundRows.push(`${id.padEnd(14)} ${parts.join(', ') || 'no ground-material structures'}`);
}
ok(groundFell > 1000, `ground-material structures come down across the maps (${groundFell} blocks)`);
console.log(groundRows.join('\n'));

/** Solid blocks in a box (optionally skipping one block type). */
const solidIn = (world, [x0, y0, z0, x1, y1, z1], skip = -1) => {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const t = world.getBlock(x, y, z);
    if (isSolidBlock(t) && t !== skip) n++;
  }
  return n;
};
const cutBox = (engine, [x0, y0, z0, x1, y1, z1]) => {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (isSolidBlock(engine.world.getBlock(x, y, z))) destroyBlockDirect(x, y, z, null, engine.contexts.combat, null);
  }
};

// Minecraft B5 lighthouse (wool and plank tower on a floor at y 49, stone
// lantern y 71-79): its lantern used to be implicit ground and its floors
// load-time pins, so a shot-through tower floated. Cutting the tower two
// blocks above its floor now brings down everything above (the cloud
// overhead stays).
{
  const engine = roomFor('minecraft_b5'), { world, structure } = engine;
  ok(world.getBlock(26, 72, 25) === MC_STONE && structure.field.kindAt(26, 72, 25) === 2, 'b5: the lighthouse lantern stone is building material');
  const above = [20, 53, 19, 36, 87, 35];
  const before = solidIn(world, above, MC_CLOUD);
  let pins = 0;
  for (const key of structure.field.pinKeys()) if (keyX(key) >= 20 && keyX(key) <= 36 && keyZ(key) >= 19 && keyZ(key) <= 35 && keyY(key) >= 49) pins++;
  cutBox(engine, [23, 51, 22, 33, 52, 32]);
  const ticks = settle(engine);
  const after = solidIn(world, above, MC_CLOUD);
  ok(before > 900 && pins > 0, `b5: the lighthouse stands at load (${before} blocks above the cut, ${pins} load-time pins)`);
  eq(after, 0, `b5: cutting the lighthouse tower brings down all ${before} blocks above the cut (${ticks} ticks, ${structure.stats.released} pins released)`);
  engine.stop();
}

// Minecraft B5 lighthouse, load check: a hole through under half of its ring
// (y 51-52) leaves the tower standing; chipping on block by block (each shot
// settles first) until over half the ring is gone brings all of it down.
{
  const ringCells = (engine, from, to) => {
    const cells = [];
    for (let y = 51; y <= 52; y++) for (let z = 19; z <= 35; z++) for (let x = 20; x <= 36; x++) {
      const share = (Math.atan2(z + 0.5 - 27.5, x + 0.5 - 28.5) + Math.PI) / (2 * Math.PI);
      if (share >= from && share < to && isSolidBlock(engine.world.getBlock(x, y, z))) cells.push([x, y, z]);
    }
    return cells;
  };
  const above = [20, 53, 19, 36, 87, 35];
  const engine = roomFor('minecraft_b5'), { world, structure } = engine, before = solidIn(world, above, MC_CLOUD);
  for (const [x, y, z] of ringCells(engine, 0, 0.4)) destroyBlockDirect(x, y, z, null, engine.contexts.combat, null);
  settle(engine);
  ok(solidIn(world, above, MC_CLOUD) > before * 0.85 && !structure.stats.overloads, `b5: a hole through 40% of the lighthouse ring leaves it standing (${solidIn(world, above, MC_CLOUD)} of ${before})`);
  let shots = 0;
  for (const [x, y, z] of ringCells(engine, 0.4, 0.7)) {
    destroyBlockDirect(x, y, z, null, engine.contexts.combat, null);
    settle(engine);
    shots++;
    if (structure.stats.overloads) break;
  }
  eq(structure.stats.overloads, 1, `b5: chipping the ring block by block, the tower gives way after ${shots} more blocks`);
  eq(solidIn(world, above, MC_CLOUD), 0, 'b5: and all of it comes down');
  engine.stop();
}

// Citadel bell tower: above the curtain wall it is a brick and stone body
// with stone cornices at y 26 and 32 and stone belfry piers (y 33-35), which
// used to be ground anchors. Cutting the body below the lower cornice brings
// everything above down.
{
  const engine = roomFor('citadel'), { world, structure } = engine, T = GROUND;
  ok(world.getBlock(59, T + 20, 58) === STONE && structure.field.kindAt(59, T + 20, 58) === 2, 'citadel: the belfry piers are building material');
  const above = [57, T + 12, 56, 69, T + 24, 68], before = solidIn(world, above);
  cutBox(engine, [57, T + 10, 56, 69, T + 11, 68]);
  const ticks = settle(engine), after = solidIn(world, above);
  ok(before > 900, `citadel: the bell tower stands at load (${before} blocks above the cut)`);
  eq(after, 0, `citadel: cutting the bell tower below its cornice brings down all ${before} blocks above (${ticks} ticks)`);
  engine.stop();
}
console.log(`structure-maps-test: ${passed} checks passed`);
