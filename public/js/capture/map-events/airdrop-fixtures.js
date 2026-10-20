/**
 * Supply airdrop HUD fixtures (docs/conquest.md "Map events" > "Supply
 * airdrop"; design docs/design/conquest/events/airdrop/) for the static
 * capture page: the crate inbound (banner with countdown, marker, flight line
 * on the minimap and the full map), the crate down with the HOLD CLAIM CRATE
 * ring 60 % in, and the claimer's own banner. Wire rows as the server writes
 * them; the helpers come from conquest-hud-fixtures.js.
 */
import { encodeMapEventPoint, encodeMapEventRow, mapEventsFor } from '../../../../shared/conquest-map-events.js';
import { AIRDROP_TUNING as T } from '../../../../shared/map-events/airdrop.js';

export function airdropHudFixtures({ state, roster, baseMatch, cam, yawTo, meAt, now, ground, from, to }) {
  const index = mapEventsFor('frontier').findIndex(d => d.id === 'airdrop');
  if (index < 0) return [];
  const out = [];
  // Landing cell 40 % of the way from B to C, the transport running in on a 130° heading.
  const spot = { x: Math.floor(from.x + (to.x - from.x) * 0.4) + 0.5, y: ground + 0.02, z: Math.floor(from.z + (to.z - from.z) * 0.4) + 0.5 };
  const anchor = { x: spot.x, y: spot.y, z: spot.z };
  const heading = Math.round(130 / T.headingStepDeg);
  const warnMs = T.approachMs + T.descentMs;
  {
    const at = { x: spot.x - 120, z: spot.z + 150 };
    const self = meAt(at.x, at.z);
    const match = baseMatch();
    const left = warnMs - 8000;
    match.conquest.ev = [encodeMapEventRow(index, { phase: 'warning', progress: 0, team: null, leftMs: left, anchor, extra: [heading] })];
    out.push(state('airdrop-inbound', 'Supply drop inbound · banner countdown, crate marker, flight line on the maps', { self, players: roster(self), match,
      events: [{ kind: 'map_event', event: 'airdrop', phase: 'warning', endsAt: now + left, pos: [Math.round(spot.x), Math.round(spot.y), Math.round(spot.z)] }],
      camera: cam(at.x, ground + 1.6, at.z, yawTo(at, spot), 0.05), bigMap: false }));
    out.push(state('airdrop-map', 'Supply drop inbound · full map with the flight line and the landing ring', { self, players: roster(self), match,
      events: [], camera: cam(at.x, ground + 1.6, at.z, yawTo(at, spot), 0.05), bigMap: true }));
  }
  {
    const at = { x: spot.x + 1.2, z: spot.z + 0.8 };
    const self = meAt(at.x, at.z, { cq: { squad: 1, kitId: 'assault', action: 60 } });
    const match = baseMatch();
    match.conquest.ev = [encodeMapEventRow(index, { phase: 'active', progress: 0, team: null, leftMs: 74000, anchor, extra: [heading] })];
    match.conquest.evp = [encodeMapEventPoint(index, 0, { teams: new Set(['alpha', 'bravo']), progress: 0.6, userTeam: 'alpha', dynamic: true, ...spot })];
    out.push(state('airdrop-claim', 'Supply crate down · HOLD CLAIM CRATE 60 %, crate marker with its time left', { self, players: roster(self), match,
      events: [{ kind: 'map_event', event: 'airdrop', phase: 'active', endsAt: now + 74000, pos: [Math.round(spot.x), Math.round(spot.y), Math.round(spot.z)] }],
      camera: cam(spot.x + 6, ground + 1.6, spot.z + 6, yawTo({ x: spot.x + 6, z: spot.z + 6 }, spot), -0.25), interactHeld: 1800 }));
  }
  {
    const self = meAt(spot.x, spot.z);
    const match = baseMatch();
    // An idle row (no marker, as in cooldown) stands in for the cooldown one: in game the `map_event` is handled on receipt, before the
    // HUD ingests the snapshot that shows the cooldown, while this page ingests first (and a seen phase does not banner twice).
    match.conquest.ev = [encodeMapEventRow(index, { phase: 'idle', progress: 0, team: null, leftMs: 0 })];
    out.push(state('airdrop-claimed', 'Supply crate claimed · the claimer\'s KRABER banner', { self, players: roster(self), match,
      events: [{ kind: 'map_event', event: 'airdrop', phase: 'cooldown', team: 'alpha', by: 'me', reason: 'claimed', endsAt: now + 900,
        data: { weapon: T.weapon.id }, pos: [Math.round(spot.x), Math.round(spot.y), Math.round(spot.z)] }],
      camera: cam(spot.x, ground + 1.6, spot.z, yawTo(spot, to), 0) }));
  }
  return out;
}
