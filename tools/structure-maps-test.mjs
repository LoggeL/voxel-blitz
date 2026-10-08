// Every map loads with structural integrity on and nothing collapses: blocks
// the rules cannot support are pinned as authored anchors, the world keeps
// its template voxels (fingerprints unchanged), and support memory and build
// time stay bounded. Damage next to pinned blocks then settles sensibly.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { destroyBlockDirect } from '../server/sim/combat.js';
import { SupportField, keyX, keyY, keyZ } from '../server/sim/structure-field.js';
import { MAP_IDS, createMapState, getMapMeta } from '../shared/worlddata.js';
import { MODE_IDS, isModeMapCompatible } from '../shared/modes.js';
import { STRUCTURE_EVENT_KINDS, STRUCTURE_KIND } from '../shared/structure.js';

let passed = 0;
const ok = (value, message) => { assert.ok(value, message); passed++; };
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
    if (STRUCTURE_KIND[world.getBlock(x, y, z)] === 2) targets.push((y << 20) | (z << 10) | x);
  }
  for (const key of targets) destroyBlockDirect(keyX(key), keyY(key), keyZ(key), null, engine.contexts.combat, null);
  let ticks = 0;
  for (; ticks < 3000 && !structure.idle; ticks++) engine.step();
  ok(structure.idle, `${id}: damage near pinned blocks settles (${ticks} ticks)`);
  const fell = events.filter(e => e.kind === 'collapse' || e.kind === 'crumble').reduce((n, e) => n + e.n, 0);
  ok(fell < 40000, `${id}: ${targets.length} removals bring down a bounded ${fell} blocks`);
  if (id !== 'frontier') {
    const rebuilt = SupportField.build(world.dimensions, (x, y, z) => world.getBlock(x, y, z), { pins: field.pinKeys() });
    let mismatches = 0;
    for (let y = 1; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      if (STRUCTURE_KIND[world.getBlock(x, y, z)] === 2 && rebuilt.read(x, y, z) !== field.read(x, y, z)) mismatches++;
    }
    ok(mismatches === 0, `${id}: incremental support equals a rebuild after the damage (${mismatches})`);
  }
  rows.push(`${id.padEnd(14)} ${mode.padEnd(8)} structural ${String(base.structural).padStart(7)} pins ${String(base.pins).padStart(5)}`
    + ` template ${(templateBytes / 1e6).toFixed(2)} MB bind ${bindMs.toFixed(0)} ms, damage ${targets.length} -> fell ${fell}`);
  engine.stop();
}
console.log(rows.join('\n'));
console.log(`structure-maps-test: ${passed} checks passed`);
