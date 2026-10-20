/**
 * Capture fixtures of the flag radars (docs/conquest.md "Flag radars"; design
 * docs/design/conquest/radar/), appended to conquestHudFixtures with its
 * helpers. Snapshot-shaped: the `ev` rows come from the shared encoder at the
 * radars' wire indices on Frontier.
 *
 *   radar-sweep   a WEST jeep 113 m from D inside EAST's Ridge radar ring:
 *                 the ENEMY RADAR D chip (sweep in 6 s), the orange ring and
 *                 sweep on the minimap, the RADAR D marker over the dome
 *   radar-swept   the sweep just caught that jeep: RADAR · SWEPT, SPOTTED 5 S
 *   radar-map     the full map: WEST's St. Aldric radar at B (cyan rings and
 *                 sweep) and EAST's at D (orange)
 *   radar-down    St. Aldric just came down: the destroyed banner
 */
import { encodeMapEventRow, mapEventsFor } from '../../../shared/conquest-map-events.js';

export function radarHudFixtures({ state, roster, baseMatch, meAt, cam, yawTo, vehicle, GROUND, now }) {
  const defs = mapEventsFor('frontier'), at = id => defs.findIndex(d => d.id === id);
  const ridge = at('radar-ridge'), aldric = at('radar-aldric');
  if (ridge < 0 || aldric < 0) return [];
  const out = [];
  const dome = { x: 528.5, z: 226.5 };
  const jeepAt = { x: 480.5, z: 360.5 };
  const rows = (ridgeLeft, aldricLeft = 9000) => [
    encodeMapEventRow(aldric, { phase: 'active', progress: 0, team: 'alpha', leftMs: aldricLeft }),
    encodeMapEventRow(ridge, { phase: 'active', progress: 0, team: 'bravo', leftMs: ridgeLeft }),
  ];
  const inJeep = () => {
    const self = meAt(jeepAt.x, jeepAt.z, { vehicleId: 'alpha-jeep', vehicleSeatId: 'driver', y: GROUND + 1 });
    const jeep = vehicle('alpha-jeep', 'jeep', 'alpha', jeepAt.x, jeepAt.z, { hp: 0.72, y: GROUND + 1, yaw: yawTo(jeepAt, dome), seatOccupants: { driver: 'me' }, speed: 6 });
    return { self, jeep };
  };
  const view = () => cam(jeepAt.x, GROUND + 3.4, jeepAt.z, yawTo(jeepAt, dome), 0.02);
  {
    const { self, jeep } = inJeep();
    const match = baseMatch();
    match.conquest.ev = rows(6000);
    out.push(state('radar-sweep', 'Flag radar · WEST jeep inside EAST\'s Ridge radar ring · sweep in 6 s', { self, players: roster(self), vehicles: [jeep], match,
      camera: view() }));
  }
  {
    const { self, jeep } = inJeep();
    const match = baseMatch();
    match.conquest.ev = rows(14600);
    out.push(state('radar-swept', 'Flag radar · the sweep caught the jeep · spotted 5 s', { self, players: roster(self), vehicles: [{ ...jeep, sp: 0 }], match,
      camera: view(),
      events: [{ kind: 'map_event', event: 'radar-ridge', phase: 'active', team: 'bravo', note: 'sweep', data: { team: 'bravo', ids: ['alpha-jeep'] }, pos: [529, 44, 227] }] }));
  }
  {
    const self = meAt(300.5, 500.5);
    const match = baseMatch();
    match.conquest.ev = rows(6000, 3400);
    out.push(state('radar-map', 'Flag radar · full map · WEST\'s St. Aldric radar at B, EAST\'s Ridge radar at D', { self, players: roster(self), match,
      camera: cam(self.x, GROUND + 1.6, self.z, 0), bigMap: true }));
  }
  {
    const self = meAt(300.5, 500.5);
    const match = baseMatch();
    // The capture page applies the snapshot before the events; live, the `done` event comes first, so its row rides from the next state on.
    match.conquest.ev = [rows(6000)[1]];
    out.push(state('radar-down', 'Flag radar · St. Aldric destroyed · B loses its sweep', { self, players: roster(self), match,
      camera: cam(self.x, GROUND + 6, self.z, yawTo(self, { x: 262, z: 546 }), 0.05),
      events: [{ kind: 'map_event', event: 'radar-aldric', phase: 'done', team: 'bravo', by: 'en1', reason: 'toppled', pos: [267, 71, 542] }] }));
  }
  return out;
}
