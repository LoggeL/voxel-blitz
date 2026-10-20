// Signal Rock relay and radio mast (docs/conquest.md "Signal Rock relay") on
// the real Frontier world: the contested 8 s hold and the flip, the scan's
// spot marks for the owner, the wire row, the mast's integrity and charge,
// the groan, the deterministic topple across the north loop road (crush
// credited with the event's kill key, the wreck flattened on the road, the
// relay offline), the bots' tasks and the rematch reset; one HUD banner.
import assert from 'node:assert/strict';
import { AIR, isSolidBlock } from '../shared/world/blocks.js';
import { mapEventsFor, mapEventWireBytes } from '../shared/conquest-map-events.js';
import { RELAY_EVENT, RELAY_SITE } from '../shared/map-events/relay.js';
import { RelayController } from '../server/modes/conquest/map-events/relay.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { MapEventFx } from '../public/js/fx/map-event-fx.js';
import { TICK_MS, eventFixture } from './lib/map-event-fixtures.mjs';

assert(mapEventsFor('frontier').includes(RELAY_EVENT) && !mapEventsFor('redrock').includes(RELAY_EVENT), 'registered on Frontier only');

const F = eventFixture({ defs: [RELAY_EVENT], controllers: { relay: RelayController } });
const { game, policy, system, world } = F;
const relayAt = RELAY_EVENT.points[0], chargeAt = RELAY_EVENT.points[1];
const a = F.player('a', 'alpha'), b = F.player('b', 'bravo'), b2 = F.player('b2', 'bravo');
F.run(TICK_MS * 2);
const ev = system.instance('relay');
const use = (p, key) => game.mode.conquestIntent(p, { type: 'support', support: 'use', targetId: key });
const hold = (p, ms, key = 'relay:0') => { for (let t = 0; t < ms; t += 200) { use(p, key); F.run(200); } };
const far = p => F.place(p, 300, 300);
F.place(a, relayAt.x, relayAt.z, relayAt.y); far(b); far(b2);
assert.equal(ev.phase, 'idle');
assert.deepEqual(F.snap.match.conquest.evp, [[0, 0, 3]], 'the neutral relay point rides evp for both sides');

// Contest: an enemy in the zone stops the hold, then it completes uncontested.
F.place(b, RELAY_SITE.bunker.x + 6, RELAY_SITE.bunker.z, relayAt.y);
F.run(TICK_MS * 2);
hold(a, 1000);
assert.equal(system.points.get(ev, 'relay').progress, 0, 'no progress while an enemy stands in the bunker zone');
far(b); F.run(TICK_MS * 2);
hold(a, 8400);
assert.deepEqual([ev.phase, ev.team], ['active', 'alpha'], 'the 8 s hold takes the relay');
const row = F.snap.match.conquest.ev?.[0];
assert.deepEqual(row.slice(0, 4), [0, 3, 0, 0], 'ev row: active, mast intact, owner WEST');
assert(row[4] > 50 && row[4] <= 60, `leftDs counts to the first scan (${row[4]})`);
const relayBytes = mapEventWireBytes(F.snap.match.conquest);
console.log(`relay wire while held: ${relayBytes} B (ev + evp)`);
assert(relayBytes <= 50, `relay rows stay small (${mapEventWireBytes(F.snap.match.conquest)} B)`);

// Scan: enemies within 180 m of the mast are spotted for the owner, one far away is not.
F.place(b, 470, 240); F.place(b2, 470, 400);
F.runUntil(() => ev.controller.scans > 0, 7000);
const spotting = policy.roles.spotting;
assert(spotting.isSpotted(b) && !spotting.isSpotted(b2), 'the scan marks b (72 m) and not b2 (232 m)');
assert.equal(F.kinds().filter(e => e.note === 'scan').at(-1)?.data?.n, 1);

// Flip: the rival's own hold takes it over (no tickets change).
const tickets = [...Object.values(F.snap.match.conquest.tickets ?? {})];
F.place(a, 300, 300); F.place(b, relayAt.x, relayAt.z, relayAt.y);
F.run(TICK_MS * 2);
hold(b, 8400);
assert.deepEqual([ev.phase, ev.team], ['active', 'bravo'], 'EAST flips the relay');
assert.deepEqual([...Object.values(F.snap.match.conquest.tickets ?? {})], tickets, 'no tickets involved');

// Charge: WEST plants on the mast foot; the fuse takes 450 of the 600 pool.
F.place(b, 300, 300); F.place(a, chargeAt.x, chargeAt.z, chargeAt.y);
F.run(TICK_MS * 2);
hold(a, 5400, 'relay:1');
assert(F.kinds().some(e => e.note === 'planted'), 'planted note');
F.place(a, 440, 190);
F.run(5200);
const mast = system.targets.get(ev, 'mast');
assert(Math.abs(system.targets.share(mast) - 0.25) < 1e-6, `the charge leaves a quarter (${system.targets.share(mast)})`);
assert(F.snap.events?.length >= 0 && F.events.some(e => e.kind === 'projectileExplode' && /^relay-charge/.test(e.pid)), 'the charge explodes for the clients');

// The final blow: two rockets at the feet; the groan, then the fall across the road.
const victim = F.place(b2, 468.5, 140.5);
const roadTop = (() => { for (let y = 40; y > 0; y--) if (isSolidBlock(world.getBlock(468, y, 140))) return y; return -1; })();
for (let i = 0; i < 2; i++) game.mode.onBlast([468.5, 32, 166.2], { key: 'rocket', radius: 3, ownerId: 'a' });
assert.deepEqual([ev.phase, ev.team, ev.by], ['warning', 'alpha', 'a'], 'the groan, credited to the final blow');
assert.equal(system.points.of(ev).filter(p => p.enabled).length, 0, 'the relay goes offline');
const t0 = performance.now();
let maxTick = 0;
F.run(TICK_MS);
assert(F.events.some(e => e.kind === 'creak' && e.n >= 150), 'the mast creaks (structure FX)');
for (let t = 0; t < 4000 + 2600 + 1500; t += TICK_MS) { const s = performance.now(); game.step(TICK_MS); maxTick = Math.max(maxTick, performance.now() - s); }
assert.equal(ev.phase, 'done');
assert(F.events.some(e => e.kind === 'collapse' && Array.isArray(e.w) && e.w[0] < 0), 'one collapse chunk spinning north about the hinge');
assert.equal(victim.state, 'dead', 'the crush line kills an enemy on the road');
assert.equal(F.kinds('kill').find(k => k.victim === 'b2')?.w, 'relayMast');
assert.equal(world.getBlock(467, 50, 167), AIR, 'the standing mast is gone');
let onRoad = 0, offRoad = 0;
for (let y = roadTop + 1; y <= roadTop + 4; y++) onRoad += isSolidBlock(world.getBlock(467, y, 140)) ? 1 : 0;
for (let y = 26; y <= 34; y++) offRoad += isSolidBlock(world.getBlock(467, y, 150)) ? 1 : 0;
assert.equal(onRoad, 1, 'one crushed layer on the road');
assert(offRoad >= 2, 'the lattice lies off the road');
assert(isSolidBlock(world.getBlock(468, roadTop + 1, 140)) || isSolidBlock(world.getBlock(469, roadTop + 1, 140)), 'the wreck crosses the road');
assert.deepEqual(F.snap.match.conquest.ev?.[0]?.slice(0, 4), [0, 4, 100, 0], 'ev row: done, mast down, toppled by WEST');
console.log(`relay fall: ${system.edits.stats.cells} cells, edit step max ${system.edits.stats.maxTickMs.toFixed(3)} ms, whole tick max ${maxTick.toFixed(2)} ms over ${((performance.now() - t0) / 1000).toFixed(2)} s`);

// Rematch: everything back.
policy.reset();
F.run(TICK_MS * 2);
const fresh = system.instance('relay');
assert.equal(fresh.phase, 'idle');
assert(isSolidBlock(world.getBlock(467, 50, 167)), 'restoreWorld stands the mast again');
assert.equal(system.targets.share(system.targets.get(fresh, 'mast')), 1);

// Bots: the non-owner gets take tasks in its window; the charge task wants an explosive kit.
{
  const c = fresh.controller;
  fresh.setPhase('active', { ms: 25000, team: 'bravo', by: 'b' });
  c.holdSince = system.now - 30000;
  const ids = team => c.botTasks(team).map(t => t.id);
  const alpha = c.botTasks('alpha');
  assert(alpha.some(t => t.pointKey === 'relay:1'), 'a charge task once the enemy has held it 20 s');
  assert(alpha.find(t => t.pointKey === 'relay:1')?.kits?.includes('engineer'));
  assert.deepEqual(ids('bravo'), [], 'the owner posts nothing while no enemy is near');
}

// HUD: the owner's banner.
const banner = mapEventBanner({ kind: 'map_event', event: 'relay', phase: 'active', team: 'alpha', reason: 'captured', endsAt: 7000 },
  { nowMs: 1000, selfTeam: 'alpha' });
assert.equal(banner.title, 'SIGNAL ROCK RELAY · RELAY SECURED');
// FX: the groan voices and shakes, a scan pings from the mast.
{
  const calls = [];
  const fx = new MapEventFx({ audio: { structureCreak: () => calls.push('creak'), reconGadget: () => calls.push('ping') },
    cameraShake: { add: () => calls.push('shake') }, getCamera: () => ({ position: { x: 470, y: 30, z: 150 } }) });
  fx.mapId = 'frontier';
  fx.handleEvent({ kind: 'map_event', event: 'relay', phase: 'warning', team: 'alpha' });
  fx.update(0.016, { match: null, mapId: 'frontier' });
  fx.handleEvent({ kind: 'map_event', event: 'relay', phase: 'active', note: 'scan', data: { team: 'alpha', n: 1 } });
  assert(['creak', 'shake', 'ping'].every(c => calls.includes(c)), `relay FX ${calls}`);
}
console.log('conquest relay: contested hold and flip, scan marks, wire, charge, groan, topple across the road, crush credit, rematch, bots, HUD passed');
