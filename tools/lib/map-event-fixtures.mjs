// Test helpers for the Conquest map events (docs/conquest.md "Map events"):
// a real battlefield engine with chosen event definitions and controllers,
// players placed on standable ground, and the wire sizes the budgets bound.
// Event tests (tools/conquest-map-event-<id>-test.mjs) build on these.
import { createMapState, getMapMeta } from '../../shared/worlddata.js';
import { GameEngine } from '../../server/game.js';
import { TICK_MS } from '../../server/protocol/admission.js';
import { isSolidBlock } from '../../shared/world/blocks.js';
import { decodeMapEvents, mapEventWireBytes } from '../../shared/conquest-map-events.js';
import { MapEventController } from '../../server/modes/conquest/map-events/controller.js';
import { fixtureMapEvent } from '../../shared/map-events/fixture.js';

export { TICK_MS, fixtureMapEvent };

/** Feet height (+1.02, as the metadata's) of the highest standable cell of a column, or null. */
export function groundY(world, x, z, top = 79) {
  for (let y = top; y > 0; y--) {
    if (isSolidBlock(world.getBlock(Math.floor(x), y - 1, Math.floor(z))) && !isSolidBlock(world.getBlock(Math.floor(x), y, Math.floor(z)))
      && !isSolidBlock(world.getBlock(Math.floor(x), y + 1, Math.floor(z)))) return y + 0.02;
  }
  return null;
}

/**
 * A live Conquest engine on a battlefield (`map`, `variant`) running exactly
 * `defs` with `controllers` ({id: MapEventController subclass}). Returns
 * {world, meta, game, policy, system, events, snap, run, runUntil, player,
 * place, kinds, decoded}.
 */
export function eventFixture({ map = 'frontier', variant = 'conquest', defs = [], controllers = {} } = {}) {
  const world = createMapState(map);
  const meta = getMapMeta(map);
  const events = [];
  let snap = null;
  const game = new GameEngine({ mode: 'conquest', ...(variant !== 'conquest' ? { conquestVariant: variant } : {}), world, mapMeta: meta,
    broadcast: s => { snap = s; for (const e of s.events ?? []) events.push(e); } });
  const policy = game.mode.policy;
  const system = policy.mapEvents.configure({ defs, controllers });
  const run = ms => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
  const runUntil = (test, ms) => { let t = 0; while (t < ms && !test()) { game.step(TICK_MS); t += TICK_MS; } return t; };
  const place = (p, x, z, y = groundY(world, x, z)) => Object.assign(p, { x, y, z, vx: 0, vy: 0, vz: 0, hp: 100, state: 'alive',
    vehicleId: null, spawnProtected: false, spawnProtectedUntil: 0, grounded: true, lastDamage: null });
  const player = (id, team, at = null) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    policy.setLobbyTeam(p, team);
    if (at) place(p, at.x, at.z, at.y);
    return p;
  };
  return {
    world, meta, game, policy, system, events, run, runUntil, player, place,
    get snap() { return snap; },
    /** Server events of one kind (default `map_event`) since the fixture started. */
    kinds: (kind = 'map_event') => events.filter(e => e.kind === kind),
    /** The latest snapshot's `ev` / `evp` decoded against `defs` (as the HUD does). */
    decoded: () => decodeMapEvents(snap?.match?.conquest?.ev, snap?.match?.conquest?.evp, map, defs),
  };
}

/** `match.conquest` bytes without the blocks that carry budgets of their own (`recon`, `ev`, `evp`). */
export function conquestBaseBytes(matchConquest) {
  const { recon = null, ev = null, evp = null, ...base } = matchConquest ?? {};
  return JSON.stringify(base).length;
}

export { mapEventWireBytes };

/**
 * A controller that records every hook call (`calls`) and, by default,
 * arms the event when its point is used and defuses it when used again.
 */
export class RecordingController extends MapEventController {
  constructor(event) { super(event); this.calls = []; }
  onReset() { this.calls.push(['reset']); }
  onPhase(phase, prev) { this.calls.push(['phase', phase, prev]); }
  onUse(point, entity, team) {
    this.calls.push(['use', point.id, String(entity?.id), team]);
    if (this.event.phase === 'idle') this.event.arm({ team, by: entity?.id });
    else if (this.event.phase === 'armed' && team !== this.event.team) { this.event.cancel({ reason: 'defused' }); this.system.payDefuse(entity?.id); }
  }
  onTarget(target, hit) { this.calls.push(['target', target.id, +hit.share.toFixed(3), hit.destroyed]); }
  wireExtra() { const t = this.target('pylon'); return t ? [Math.round(this.system.targets.share(t) * 100)] : null; }
  botTasks(team) {
    const task = this.useTask('charge', team, { priority: 2, squad: 1 });
    return task ? [task] : [];
  }
}
