// Bots answering the comm rose (docs/conquest.md "Squad orders and the comm rose").
//
// Part of the BotCommander's 2 Hz plan. Every live request of the team
// (server/modes/conquest/comms.js) gets at most one bot:
//  - NEED MEDIC: the nearest Medic bot within respondRange.medic walks to the
//    requester (a downed body within REVIVE_RANGE becomes the ordinary
//    revive; a downed call is answered only from as far as a sprint covers
//    before the body bleeds out) and stands by it inside the heal aura;
//  - NEED AMMO: the nearest Support bot walks to within ammoStand m, inside
//    its resupply aura, until the aura has refilled the requester;
//  - NEED REPAIR: the nearest Engineer bot walks to the named hull and holds
//    the repair intent (any damage, not just under REPAIR_BELOW);
//  - NEED RIDE: a free bot next to an empty friendly jeep or transport drives
//    (or flies) it to the requester as a pickup ride, waits there, and once
//    the requester is aboard takes it to the requester's squad order flag.
// The bot is named to the team with `comm_answer`. Bots that crew a hull,
// ride a squad ride or hitch never answer; a bot that cannot leave its flag
// (hitchBusy: capturing, holding a threatened flag) only answers a call from
// inside that flag zone.

import { KITS } from '../shared/conquest-contract.js';
import { COMM_RESPONDER_ABILITY, COMM_RULES } from '../shared/conquest-comms.js';
import { vehicleSeats, vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { PHYSICS } from '../shared/player-movement.js';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const isAircraftType = type => type === 'helicopter' || type === 'plane' || type === 'transport';
/** A bot within this of a free pickup hull may take it (jeep / transport on its pad). */
const PICKUP_HULL_REACH = Object.freeze({ jeep: 45, transport: 90 });
/** The pickup point follows the requester once it has moved this far (a new route). */
const PICKUP_RETARGET = 15;
/** A pickup ride counts as at the pickup point inside this (ground: the unload radius). */
const PICKUP_ARRIVE = 14;
/** Medic standing distance from a living requester (inside the 6 m heal aura). */
const MEDIC_STAND = 3;

/** Plan the team's answers: keep standing ones, assign new responders, run pickup rides. */
export function planComms(cmd, ts, view, now) {
  const comms = cmd.game.mode?.policy?.comms ?? null;
  if (!comms) { ts.commAssign = new Map(); return; }
  const requests = comms.list(ts.team);
  const bySeq = new Map(requests.map(r => [r.seq, r]));
  const prior = ts.commAssign ?? new Map();
  const next = new Map();
  const taken = new Set();
  for (const [botId, a] of prior) {
    const r = bySeq.get(a.seq), p = cmd.game.entities.get(botId);
    if (!r || !p || p.state !== 'alive' || p.vehicleId || cmd.teamOf(p) !== ts.team || ts.crews.has(botId)) continue;
    const pos = comms.position(r);
    if (!pos || flat(p, pos) > COMM_RULES.respondRange[r.kind] * 1.4) continue;
    next.set(botId, a);
    taken.add(r.seq);
  }
  for (const transit of ts.transits.values()) if (transit.pickup) taken.add(transit.pickup.seq);
  for (const r of requests) {
    if (taken.has(r.seq)) continue;
    if (r.kind === 'ride') { planPickup(cmd, ts, comms, r, now); continue; }
    const pos = comms.position(r);
    if (!pos) continue;
    const ability = COMM_RESPONDER_ABILITY[r.kind];
    // A bot already on it (a revive, heal or repair walk it claimed) is the answer.
    // A downed requester bleeds out at body.until: only a Medic that can sprint there in time answers.
    const body = r.kind === 'medic' ? cmd.game.mode?.policy?.roles?.downedBodies?.(ts.team)?.find(b => String(b.id) === r.by) : null;
    const reachable = body ? Math.max(0, body.until - now) / 1000 * PHYSICS.sprint : Infinity;
    let best = alreadyOnIt(cmd, ts, r, next, now), bestD = Math.min(COMM_RULES.respondRange[r.kind], reachable);
    for (const br of best ? [] : cmd.teamBrains(ts.team)) {
      const id = br.id, p = cmd.game.entities.get(id);
      if (!p || id === r.by || p.state !== 'alive' || p.vehicleId || next.has(id) || ts.crews.has(id) || ts.hitches.has(id)) continue;
      if (KITS[cmd.kitOf(p)]?.ability !== ability || inTransit(ts, id)) continue;
      // A bot that must hold its flag only answers a call from inside that same flag zone.
      if (cmd.hitchBusy(p, ts, view, now) && !sameZone(view, p, pos)) continue;
      const d = flat(p, pos);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (!best) continue;
    next.set(best, { seq: r.seq, kind: r.kind, by: r.by, vehicleId: r.vehicleId });
    comms.answer(r.seq, best);
  }
  ts.commAssign = next;
  updatePickups(cmd, ts, comms, view, now);
}

/** The team bot holding a support claim on the request's target (revive / heal / repair walk), or null. */
function alreadyOnIt(cmd, ts, r, next, now) {
  const names = r.kind === 'repair' ? [`repair:${r.vehicleId}`] : r.kind === 'medic' ? [`revive:${r.by}`, `heal:${r.by}`] : [];
  for (const name of names) {
    const claim = cmd.roleClaims.get(name);
    const p = claim && claim.until > now ? cmd.game.entities.get(claim.id) : null;
    if (p?.bot && p.state === 'alive' && cmd.teamOf(p) === ts.team && !next.has(claim.id)) return claim.id;
  }
  return null;
}

/** Both points stand inside one flag zone (radius, presenceDy 8 m). */
const sameZone = (view, a, b) => view.flags.some(f => flat(a, f) <= f.radius && flat(b, f) <= f.radius
  && Math.abs(a.y - f.y) <= 8 && Math.abs(b.y - f.y) <= 8);

const inTransit = (ts, id) => [...ts.transits.values()].some(t => t.seats.has(id));

/** NEED RIDE: book a free bot onto an empty jeep or transport near it and send it to the requester. */
function planPickup(cmd, ts, comms, r, now) {
  const requester = cmd.game.entities.get(r.by);
  if (!requester || requester.state !== 'alive' || requester.vehicleId) return;
  const busy = new Set([...ts.transits.values()].map(t => t.vehicleId));
  for (const crew of ts.crews.values()) busy.add(crew.vehicleId);
  const hulls = [...cmd.game.vehicles?.vehicles.values() ?? []].filter(v => v.team === ts.team && v.hp > 0 && !busy.has(v.id)
    && PICKUP_HULL_REACH[v.type] && !(((v.st | 0) & 2) !== 0 || v.disabled === true) && !v.padInactive
    && flat(v, requester) <= COMM_RULES.respondRange.ride
    && !vehicleSeats(v).some(seat => vehicleSeatOccupantId(v, seat.id) != null));
  if (!hulls.length) return;
  let best = null;
  for (const br of cmd.teamBrains(ts.team)) {
    const id = br.id, p = cmd.game.entities.get(id);
    if (!p || p.state !== 'alive' || p.vehicleId || ts.crews.has(id) || ts.hitches.has(id) || inTransit(ts, id)) continue;
    if (ts.commAssign?.has(id) || KITS[cmd.kitOf(p)]?.ability === 'revive') continue;
    for (const v of hulls) {
      const walk = flat(p, v);
      if (walk > PICKUP_HULL_REACH[v.type] || Math.abs(p.y - v.y) > 12) continue;
      const score = walk * 2 + flat(v, requester);
      if (!best || score < best.score) best = { id, v, score };
    }
  }
  if (!best) return;
  const driver = vehicleSeats(best.v).find(seat => seat.drives)?.id ?? 'driver';
  const at = { x: requester.x, y: requester.y, z: requester.z };
  ts.transits.set(best.v.id, { vehicleId: best.v.id, squadId: 0, seats: new Map([[best.id, driver]]), destination: at,
    flagId: null, createdAt: now, departAt: 0, until: now + COMM_RULES.pickupMaxMs, done: false,
    pickup: { humanId: r.by, seq: r.seq, stage: 'pickup', arrivedAt: 0 } });
  comms.answer(r.seq, best.id);
}

/**
 * Pickup rides in flight: follow the requester, wait at the pickup point,
 * then (requester aboard) head for its squad order flag. The ride ends when
 * the requester dies, boards another hull or never shows up.
 */
function updatePickups(cmd, ts, comms, view, now) {
  for (const [vehicleId, transit] of ts.transits) {
    const pickup = transit.pickup;
    if (!pickup) continue;
    const v = cmd.game.vehicles?.vehicles.get(vehicleId);
    const human = cmd.game.entities.get(pickup.humanId);
    if (!v || !human || human.state !== 'alive' || cmd.teamOf(human) !== ts.team) { ts.transits.delete(vehicleId); continue; }
    if (pickup.stage === 'pickup') {
      if (human.vehicleId === vehicleId) {
        // Aboard: off to the squad's order flag (else the team's focus flag).
        const order = cmd.squadOrders?.orderOf?.(human);
        const flag = view.flags.find(f => f.id === order?.flagId) ?? cmd.focusFlag(ts);
        pickup.stage = 'deliver';
        transit.destination = flag ? { x: flag.x, y: flag.y, z: flag.z } : transit.destination;
        transit.flagId = flag?.id ?? null;
        transit.departAt = now;
        transit.until = now + COMM_RULES.pickupMaxMs;
        continue;
      }
      if (human.vehicleId) { ts.transits.delete(vehicleId); continue; }
      if (flat(human, transit.destination) > PICKUP_RETARGET && !pickup.arrivedAt) {
        transit.destination = { x: human.x, y: human.y, z: human.z };
      }
      const air = isAircraftType(v.type);
      const near = air ? v.grounded !== false && flat(v, transit.destination) <= PICKUP_ARRIVE * 2 : flat(v, transit.destination) <= PICKUP_ARRIVE;
      if (near && !pickup.arrivedAt) pickup.arrivedAt = now;
      if (pickup.arrivedAt && now - pickup.arrivedAt > COMM_RULES.pickupWaitMs) ts.transits.delete(vehicleId);
    } else if (human.vehicleId !== vehicleId) {
      // The requester got out: the ride is over (the driver parks and gets out).
      transit.done = true;
    }
  }
}

/** The goal of a bot answering a request (medic, ammo, repair), or null. */
export function commGoal(cmd, p, kit, ts, now) {
  const a = ts.commAssign?.get(String(p.id));
  if (!a) return null;
  const comms = cmd.game.mode?.policy?.comms;
  const r = comms?.list(ts.team).find(x => x.seq === a.seq);
  const pos = r && comms.position(r);
  if (!pos) return null;
  const requester = cmd.game.entities.get(r.by);
  if (r.kind === 'repair') {
    const v = cmd.game.vehicles?.vehicles.get(r.vehicleId);
    if (!v || !(v.hp > 0) || KITS[kit]?.ability !== 'repair') return null;
    // A moving hull is walked toward; the repair intent waits until it stands.
    if (Math.hypot(v.vx || 0, v.vz || 0) > 2 || (isAircraftType(v.type) && v.grounded === false)) {
      return { kind: 'heal', target: pos, interact: false, role: 'support', point: { ...pos }, arrive: 6, comm: r.seq };
    }
    return cmd.repairGoal(p, v, now);
  }
  if (r.kind === 'medic') {
    if (KITS[kit]?.ability !== 'revive') return null;
    const point = requester?.state === 'alive' ? standBeside(cmd, p, pos, MEDIC_STAND) : { ...pos };
    return { kind: 'heal', target: point, interact: false, role: 'support', point, arrive: requester?.state === 'alive' ? 2 : 1.2,
      healId: r.by, comm: r.seq };
  }
  if (r.kind === 'ammo') {
    if (KITS[kit]?.ability !== 'resupply') return null;
    const point = standBeside(cmd, p, pos, COMM_RULES.ammoStand);
    return { kind: 'heal', target: point, interact: false, role: 'support', point, arrive: 2, comm: r.seq };
  }
  return null;
}

/** A walkable spot `dist` m from `pos` on the responder's side. */
function standBeside(cmd, p, pos, dist) {
  const d = flat(p, pos);
  if (d <= dist) return { x: p.x, y: p.y, z: p.z };
  const ux = (p.x - pos.x) / d, uz = (p.z - pos.z) / d;
  const spot = { x: pos.x + ux * dist, y: pos.y, z: pos.z + uz * dist };
  return cmd.walkablePoint(spot) ?? spot;
}
