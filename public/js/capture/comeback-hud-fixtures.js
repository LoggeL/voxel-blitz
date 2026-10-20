/**
 * Capture fixtures of the comeback call-in (docs/conquest.md "Comeback
 * call-in"; design docs/design/conquest/events/comeback/), appended to
 * conquestHudFixtures with its helpers. Snapshot-shaped: the `ev` row comes
 * from the shared encoder at the event's wire index on Frontier.
 *
 *   callin-ready     WEST trails 141 : 228, the squad leader sees the READY
 *                    pill and banner
 *   callin-map       the same leader on the full map: the designator strip,
 *                    BOMBER RUN picked, the cursor's bomb line over D
 *   callin-incoming  EAST called artillery on the player's position: the red
 *                    INCOMING banner with the impact countdown, the strike
 *                    marker and the circle on the minimap
 */
import { encodeMapEventRow, mapEventsFor } from '../../../shared/conquest-map-events.js';
import { comebackHeadingDeg, comebackKindCode } from '../../../shared/map-events/comeback.js';

export function comebackHudFixtures({ state, roster, baseMatch, meAt, cam, yawTo, C, D, GROUND, meta, now }) {
  const index = mapEventsFor('frontier').findIndex(d => d.id === 'comeback');
  if (index < 0) return [];
  const out = [];
  const tickets = { alpha: 141, bravo: 228 };
  const ready = encodeMapEventRow(index, { phase: 'armed', progress: 0, team: 'alpha', leftMs: null });
  {
    const self = meAt(C.x - 60, C.z + 34);
    const match = baseMatch({ tickets });
    match.conquest.ev = [ready];
    out.push(state('callin-ready', 'Comeback call-in · READY for the trailing WEST · squad leader', { self, players: roster(self), match,
      camera: cam(self.x, GROUND + 1.6, self.z, yawTo(self, C)),
      events: [{ kind: 'map_event', event: 'comeback', phase: 'armed', team: 'alpha', reason: 'ready' }] }));
    const mapMatch = baseMatch({ tickets });
    mapMatch.conquest.ev = [ready];
    out.push(state('callin-map', 'Comeback call-in · full map designator · bomber run over D', { self, players: roster(self), match: mapMatch,
      camera: cam(self.x, GROUND + 1.6, self.z, yawTo(self, C)), bigMap: true, mapCursor: { u: (D.x + 6) / 768, v: (D.z + 4) / 768 }, toolKind: 'bomber' }));
  }
  {
    const self = meAt(C.x + 30, C.z + 70, { cq: { squad: 1, kitId: 'medic' } });
    const target = { x: Math.round(self.x - 6), z: Math.round(self.z - 10) };
    const heading = comebackHeadingDeg(meta, 'bravo', target);
    const row = encodeMapEventRow(index, { phase: 'warning', progress: 0, team: 'bravo', leftMs: 3600, extra: [comebackKindCode('artillery'), heading],
      anchor: { x: target.x, z: target.z } });
    const match = baseMatch({ tickets: { alpha: 236, bravo: 150 } });
    match.conquest.ev = [row];
    out.push(state('callin-incoming', 'Comeback call-in · EAST artillery on the player · 4 s telegraph', { self, players: roster(self), match,
      camera: cam(self.x + 18, GROUND + 3.2, self.z + 22, yawTo({ x: self.x + 18, z: self.z + 22 }, target), -0.12),
      events: [{ kind: 'map_event', event: 'comeback', phase: 'warning', team: 'bravo', by: 'en1', endsAt: now + 3600,
        data: { kind: 'artillery', heading }, pos: [target.x, GROUND, target.z] }] }));
  }
  return out;
}
