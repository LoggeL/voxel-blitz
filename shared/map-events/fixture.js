// The map event framework's own fixture (docs/conquest.md "Map events"):
// one definition with every part an event can have, at coordinates the
// caller reads from the map metadata. Never registered (./registry.js): the
// framework test (tools/conquest-map-events-test.mjs), its helpers
// (tools/lib/map-event-fixtures.mjs) and the HUD capture page swap it in
// through MapEventSystem.configure / ConquestHud.setEventDefs.
import { defineMapEvent } from './define.js';

/**
 * A fixture definition: `anchor` {x, y, z} on `maps`, one hold-to-use point
 * `charge` at `point` (both teams, 3 s), one integrity target `pylon` (a
 * 3 x 6 x 3 box at `target`, 300 integrity: three rockets), a 6 s warning, a
 * 4 s active phase, kill key `fixtureBlast`, a repeat when `repeat` is set.
 */
export function fixtureMapEvent({ id = 'fixture', maps = ['frontier', 'redrock'], anchor, point = anchor, target = anchor, flag = 'C',
  repeat = null, big = true, breakthrough = true, kind = 'levolution', durations = { warningMs: 6000, activeMs: 4000 } } = {}) {
  return defineMapEvent({
    id, maps, kind, name: 'Test Pylon', short: 'PYLON', glyph: 'charge', anchor, flag, big, repeat, breakthrough, durations,
    texts: {
      armed: { title: 'CHARGES ARMED', detail: 'DEFUSE AT THE PYLON', countdown: 'BLOWS IN' },
      warning: { title: 'COLLAPSE IMMINENT', countdown: 'COLLAPSE IN', own: { detail: 'CLEAR THE AREA' }, enemy: { detail: 'GET OUT OF THE BLAST ZONE' } },
      active: { title: 'DOWN', detail: 'DEBRIS ON THE ROAD' },
      'idle:defused': { title: 'CHARGES DEFUSED' },
    },
    points: [{ id: 'charge', x: point.x, y: point.y, z: point.z, radius: 2.5, holdMs: 3000, teams: 'any', verb: 'Plant charge', glyph: 'charge' }],
    targets: [{ id: 'pylon', integrity: 300, boxes: [{ x0: Math.floor(target.x) - 1, y0: Math.floor(target.y ?? 0), z0: Math.floor(target.z) - 1,
      x1: Math.floor(target.x) + 1, y1: Math.floor(target.y ?? 0) + 5, z1: Math.floor(target.z) + 1 }] }],
    killKeys: { fixtureBlast: { label: 'PYLON', icon: 'collapse' } },
    cues: { warning: { stinger: 'ticket_low', own: 'winning', enemy: 'under_attack' }, active: { stinger: 'neutralized' } },
    tuning: { crushDamage: 999, fireDps: 20 },
  });
}
