/**
 * Supply airdrop on the HUD (docs/conquest.md "Map events" > "Supply
 * airdrop"; design docs/design/conquest/events/airdrop/, variant A). The
 * framework draws the banner (SUPPLY DROP · INBOUND, LANDS IN 12 S · 240 M NE
 * with its countdown bar), the hexagon crate badge and marker and the HOLD
 * CLAIM CRATE prompt; this presenter adds the transport's flight line with
 * the aircraft on it to both maps, a ring at the landing cell, the crate's
 * time left on the world marker, and the claimer's own banner. Every value
 * comes from the decoded `ev` row (anchor, heading extra, phase clock) or the
 * `map_event` event.
 */
import { WEAPONS } from '../../../../../shared/combatmath.js';
import { AIRDROP_TUNING, airdropClock, airdropHeading, airdropPose, airdropSpot } from '../../../../../shared/map-events/airdrop.js';

/** The framework's hazard amber (MAP_EVENT_COLORS.hazard; not imported: ../map-events.js imports this file's registry). */
const AMBER = '#ffb020';

/** Rounds the crate gives: the magazine plus its whole spare magazines. */
export function airdropRounds(rules = AIRDROP_TUNING) {
  const W = rules.weapon, def = WEAPONS[W.id];
  return W.mag + W.reserve * (def?.magSize ?? 0);
}

/** The flight line of a drop on the maps: entry and exit points (world x/z) and the transport now, or null. */
export function airdropFlightLine(event, rules = AIRDROP_TUNING) {
  const ms = airdropClock(event, rules), spot = airdropSpot(event?.anchor);
  if (ms == null || !spot) return null;
  const heading = airdropHeading(Array.isArray(event.extra) ? event.extra[0] : 0, rules);
  const entry = airdropPose(spot, heading, 0, rules).plane, exit = airdropPose(spot, heading, rules.approachMs + rules.planeExitMs, rules).plane;
  const pose = airdropPose(spot, heading, ms, rules);
  return { entry, exit, plane: pose.plane.visible ? pose.plane : null, crate: pose.crate, heading, spot };
}

export const AIRDROP_PRESENTER = Object.freeze({
  /** The claimer reads which weapon it got and where it sits; everyone else keeps the framework's team-relative banner. */
  banner(ev, ctx, base) {
    if (!base || ev.reason !== 'claimed' || !ctx.selfId || ev.by !== ctx.selfId) return undefined;
    const W = WEAPONS[AIRDROP_TUNING.weapon.id];
    return { ...base, key: `${base.key}:self`, tone: 'own', title: `${ctx.def.name} · ${W?.name ?? 'POWER WEAPON'} ARMED`,
      detail: `${airdropRounds()} ROUNDS · GADGET SLOT (3) · THIS LIFE ONLY` };
  },

  /** Under the markers: the dashed flight line, the transport's arrow while it is over the map, the landing ring. */
  paintMap(ctx, event, { nowMs = 0, px = 1 } = {}) {
    const line = airdropFlightLine(event);
    if (!line) return;
    const m = v => Math.max(v / Math.max(px, 1e-3), 0.25);
    const amber = AMBER;
    if (event.phase === 'warning') {
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = amber; ctx.lineWidth = m(1.6);
      ctx.setLineDash?.([m(5), m(4)]);
      ctx.beginPath(); ctx.moveTo(line.entry.x, line.entry.z); ctx.lineTo(line.exit.x, line.exit.z); ctx.stroke();
      ctx.setLineDash?.([]);
      if (line.plane) {
        // A small aircraft arrow along the heading.
        const fx = -Math.sin(line.heading), fz = -Math.cos(line.heading), s = m(7);
        ctx.globalAlpha = 1; ctx.fillStyle = amber;
        ctx.beginPath();
        ctx.moveTo(line.plane.x + fx * s, line.plane.z + fz * s);
        ctx.lineTo(line.plane.x - fx * s * 0.7 - fz * s * 0.6, line.plane.z - fz * s * 0.7 + fx * s * 0.6);
        ctx.lineTo(line.plane.x - fx * s * 0.35, line.plane.z - fz * s * 0.35);
        ctx.lineTo(line.plane.x - fx * s * 0.7 + fz * s * 0.6, line.plane.z - fz * s * 0.7 - fx * s * 0.6);
        ctx.closePath(); ctx.fill();
      }
    }
    const pulse = event.phase === 'warning' ? (Math.sin(nowMs / 220) + 1) / 2 : 0;
    ctx.globalAlpha = 0.5 + 0.4 * pulse;
    ctx.strokeStyle = amber; ctx.lineWidth = m(1.4);
    ctx.beginPath(); ctx.arc(line.spot.x, line.spot.z, Math.max(AIRDROP_TUNING.claimRadius * 2, m(14 + 4 * pulse)), 0, Math.PI * 2); ctx.stroke();
  },

  /** The crate's time left on the ground ("CRATE · 74 S"); the framework counts the warning itself. */
  marker(model, event) {
    if (event.phase === 'active' && Number.isFinite(event.leftMs)) return { ...model, name: `${event.def.short} · ${Math.ceil(event.leftMs / 1000)} S` };
    return model;
  },
});
