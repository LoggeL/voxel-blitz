/**
 * Pure read models for squad orders and the comm rose (docs/conquest.md
 * "Squad orders and the comm rose", design docs/design/conquest/orders/).
 * Everything comes from the authoritative snapshot: the squad tuple's order
 * flag (match.conquest.squads), the requesters' `cqc` player fields and the
 * vehicle rows. The rose only labels what the server will decide again
 * (flagInSight is the same shared function the server runs).
 */
import {
  COMM_LABELS, COMM_MARKER_LABELS, COMM_REQUESTS, COMM_ROSE, COMM_RULES, commAudience, commRequestsOf, decodeCommField, flagInSight,
  orderStance,
} from '../../../../shared/conquest-comms.js';
import { decodeConquestPlayer } from '../../../../shared/conquest-contract.js';
import { vehicleMaxHp as hullMaxHp } from '../../../../shared/vehicles.js';

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const alive = p => !!p && p.state !== 'dead' && p.hp > 0;
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Rose glyph per comm kind (public/js/ui/conquest/icons.js). */
export const COMM_ICONS = Object.freeze({
  medic: 'revive', ammo: 'ammo', repair: 'repair', ride: 'jeep', yes: 'yes', no: 'no', spot: 'recon', order: 'attack',
});
/** World / map marker glyph per request kind. */
export const REQUEST_ICONS = Object.freeze({ medic: 'revive', ammo: 'ammo', repair: 'repair', ride: 'jeep' });
/** Requests show to their audience within this flat range (m): a little past the bot answer range. */
export const REQUEST_MARKER_RANGE = Object.freeze({ medic: 140, ammo: 110, repair: 140, ride: 320 });
/** The pad opens the rose after holding D-pad right this long; a shorter tap spots. */
export const PAD_ROSE_HOLD_MS = 300;
/** Mouse / stick deflection (px) before a rose segment is highlighted. */
export const ROSE_DEADZONE_PX = 26;

/** The squad entry ({team, squadId, leaderId, order}) of the local player, or null. */
export function ownSquad(cq, self) {
  const team = self?.team === 'alpha' || self?.team === 'bravo' ? self.team : null;
  const squad = decodeConquestPlayer(self)?.squad | 0;
  if (!team || !(squad > 0)) return null;
  return cq?.squads?.find(s => s.team === team && s.squadId === squad) ?? { team, squadId: squad, leaderId: null, order: null };
}

/** True when the local player leads its squad (the only one who may order it). */
export const isSquadLeader = (cq, self) => {
  const entry = ownSquad(cq, self);
  return !!entry && entry.leaderId != null && String(entry.leaderId) === String(self?.id);
};

/**
 * The squad order chip: { flagId, stance, title ('ATTACK C'), name, distance,
 * leader }, or null without an order. The stance follows the flag owner on
 * every frame, so a captured attack flag reads DEFEND at once.
 */
export function squadOrderModel(cq, self) {
  const entry = ownSquad(cq, self);
  if (!entry?.order) return null;
  const flag = cq.flags?.find(f => f.id === entry.order);
  if (!flag) return null;
  const stance = orderStance(flag, entry.team);
  const distance = Number.isFinite(self?.x) && Number.isFinite(flag.x) ? Math.round(flat(self, flag)) : null;
  return { flagId: flag.id, stance, title: `${stance === 'defend' ? 'DEFEND' : 'ATTACK'} ${flag.id}`, name: String(flag.name || flag.id).toUpperCase(),
    distance, leader: entry.leaderId != null && String(entry.leaderId) === String(self?.id) };
}

/** The flag the own squad is ordered onto and its stance ({flagId, stance}), or null (world marker badge, map ring). */
export function orderFlagOf(cq, self) {
  const model = squadOrderModel(cq, self);
  return model ? { flagId: model.flagId, stance: model.stance } : null;
}

/** A damaged own-team hull NEED REPAIR would name: the own seat's hull, else the nearest within repairReach. */
export function repairTargetOf(self, vehicles = [], seated = null) {
  const damaged = v => v && v.hp > 0 && v.team === self?.team && v.hp < (hullMaxHp(v.type) || v.maxHp || Infinity);
  if (seated?.row) return damaged(seated.row) ? seated.row : null;
  let best = null, bestD = COMM_RULES.repairReach;
  for (const v of vehicles || []) {
    if (!damaged(v) || !Number.isFinite(v.x)) continue;
    const d = flat(v, self);
    if (d <= bestD) { best = v; bestD = d; }
  }
  return best;
}

/**
 * The comm rose: one segment per COMM_ROSE entry (clockwise from the top),
 * {kind, label, icon, enabled, note}. `view` is the camera {x, y, z, yaw,
 * pitch}: ORDER names the flag under the crosshair for a squad leader.
 */
export function commRoseModel({ cq, self, vehicles = [], seated = null, view = null } = {}) {
  if (!cq || !self) return null;
  const leader = isSquadLeader(cq, self);
  const team = self.team;
  const eye = view && Number.isFinite(view.x) ? view : (Number.isFinite(self.x) ? { x: self.x, y: finite(self.y) + 1.6, z: self.z, yaw: self.yaw, pitch: self.pitch } : null);
  const sighted = leader && eye ? flagInSight(eye, eye.yaw, eye.pitch, cq.flags) : null;
  const down = decodeConquestPlayer(self)?.down === true;
  const living = alive(self);
  const segments = COMM_ROSE.map(kind => {
    const segment = { kind, label: COMM_LABELS[kind], icon: COMM_ICONS[kind], enabled: living, note: '' };
    switch (kind) {
      // The heal aura skips seated mates (server/modes/conquest/roles.js): on foot only, like AMMO and RIDE.
      case 'medic': segment.enabled = (living || down) && !seated; if (seated) segment.note = 'ON FOOT'; break;
      case 'ammo': if (seated) { segment.enabled = false; segment.note = 'ON FOOT'; } break;
      case 'ride': if (seated) { segment.enabled = false; segment.note = 'ON FOOT'; } break;
      case 'repair': if (!repairTargetOf(self, vehicles, seated)) { segment.enabled = false; segment.note = 'NO DAMAGED HULL'; } break;
      case 'order': {
        if (!leader) { segment.enabled = false; segment.label = 'SQUAD ORDER'; segment.note = 'LEADER ONLY'; break; }
        if (!sighted) { segment.enabled = false; segment.label = 'SQUAD ORDER'; segment.note = 'AIM AT A FLAG'; break; }
        const stance = orderStance(sighted, team);
        segment.label = `${stance === 'defend' ? 'DEFEND' : 'ATTACK'} ${sighted.id}`;
        segment.icon = stance === 'defend' ? 'defend' : 'attack';
        segment.note = String(sighted.name || '').toUpperCase();
        segment.flagId = sighted.id;
        break;
      }
      default: break;
    }
    return segment;
  });
  return { leader, segments, flagId: sighted?.id ?? null };
}

/**
 * The deploy screen's CALL MEDIC button while the local player is down (the
 * comm rose cannot open on the deploy screen): null when not down, else
 * {requested, responderName, label}. `requested` and the responder come from
 * the own row's authoritative `cqc` field, never from the button press.
 */
export function downedMedicModel(self, players = []) {
  if (decodeConquestPlayer(self)?.down !== true) return null;
  const comm = decodeCommField(self);
  const requested = comm?.kind === 'medic';
  const responder = requested && comm.responder ? (players || []).find(p => String(p?.id) === comm.responder) : null;
  const responderName = responder ? String(responder.name || '').toUpperCase() : '';
  const label = !requested ? 'CALL MEDIC' : responderName ? `MEDIC ${responderName} RESPONDING` : 'MEDIC CALLED';
  return { requested, responderName, label };
}

/**
 * The rose segment a deflection points at (index into COMM_ROSE, clockwise
 * from the top), or -1 inside the dead zone. dy grows downward (screen px).
 */
export function roseIndexAt(dx, dy, deadzone = ROSE_DEADZONE_PX, count = COMM_ROSE.length) {
  if (!(Math.hypot(dx, dy) >= deadzone)) return -1;
  const angle = Math.atan2(dx, -dy); // 0 up, clockwise positive
  const step = Math.PI * 2 / count;
  return ((Math.round(angle / step) % count) + count) % count;
}

/**
 * Live requests the local player should see: its own, and those its kit (or
 * driver seat) can answer, of its own team within REQUEST_MARKER_RANGE.
 * {seq, kind, by, name, x, y, z, distance, responder, responderName, own}.
 */
export function visibleRequests({ self, players = [], vehicles = [], seated = null } = {}) {
  if (!self || !Number.isFinite(self.x)) return [];
  const kit = decodeConquestPlayer(self)?.kit ?? null;
  const driving = !!seated && seated.seat?.drives === true;
  const names = new Map((players || []).filter(Boolean).map(p => [String(p.id), p.name || '']));
  const out = [];
  for (const r of commRequestsOf(players, vehicles)) {
    if (r.team !== self.team) continue;
    const own = r.by === String(self.id);
    if (!own && !commAudience(r.kind, { kit, driving })) continue;
    const distance = Math.round(Math.hypot(r.x - self.x, r.z - self.z));
    if (!own && distance > (REQUEST_MARKER_RANGE[r.kind] ?? 140)) continue;
    out.push({ ...r, own, distance, name: names.get(r.by) || '', responderName: r.responder ? names.get(r.responder) || '' : '' });
  }
  return out;
}

/** World markers for visible requests (not the own one: the requester sees it on the map). */
export function requestMarkerModels(requests, { projector = null } = {}) {
  if (!projector) return [];
  const out = [];
  for (const r of requests || []) {
    if (r.own) continue;
    const p = projector.project(r.x, r.y + 2.6, r.z);
    if (!p?.inside) continue;
    out.push({ kind: 'request', comm: r.kind, id: `req:${r.seq}`, by: r.by, name: `NEED ${COMM_MARKER_LABELS[r.kind]}`, distance: r.distance, x: p.x, y: p.y });
  }
  return out;
}

/** Minimap / full-map items for visible requests ({kind: 'request', comm, x, z}). */
export const requestMapItems = requests => (requests || []).map(r => ({ kind: 'request', id: `req:${r.seq}`, comm: r.kind, rel: r.own ? 'self' : 'squad', x: r.x, z: r.z }));

/** Map items with the own squad's order ring on its flag (item.order = 'attack' | 'defend'). */
export function withOrderRing(items, order) {
  if (!order) return items;
  return items.map(item => (item.kind === 'flag' && item.id === order.flagId ? { ...item, order: order.stance } : item));
}

/**
 * A banner for a `squad_order` event of the own squad: { key, tone, title,
 * detail, priority }, or null. `flagName` / `stance` come from the decoded state.
 */
export function squadOrderBanner(ev, { selfTeam, squad, flag = null, now = 0 } = {}) {
  if (!ev || ev.team !== selfTeam || !(squad > 0) || (ev.squad | 0) !== squad) return null;
  if (ev.flag == null) return { key: `order:${ev.squad}:clear:${now}`, tone: 'neutral', title: 'ORDER CLEARED', detail: 'SQUAD ORDER', priority: 2 };
  const stance = orderStance(flag, selfTeam) ?? 'attack';
  return { key: `order:${ev.squad}:${ev.flag}:${now}`, tone: stance === 'defend' ? 'own' : 'neutral',
    title: `${stance === 'defend' ? 'DEFEND' : 'ATTACK'} ${ev.flag}`, detail: `SQUAD ORDER${flag?.name ? ` · ${String(flag.name).toUpperCase()}` : ''}`, priority: 3 };
}

/**
 * A short radio line for a comm event the local player should hear: its own
 * squad's callouts and orders, requests of its audience, answers to its own
 * requests. { text, tone } or null.
 */
export function radioLine(ev, { selfId, selfTeam, squad = 0, kit = null, driving = false, players = [] } = {}) {
  if (!ev || ev.team !== selfTeam) return null;
  const name = id => (players || []).find(p => String(p?.id) === String(id))?.name || 'SQUAD';
  const own = String(ev.by) === String(selfId);
  if (ev.kind === 'comm') {
    if (COMM_REQUESTS.includes(ev.comm)) {
      if (own) return { text: `${COMM_LABELS[ev.comm]} SENT`, tone: 'own' };
      return commAudience(ev.comm, { kit, driving }) || ((ev.squad | 0) === squad && squad > 0)
        ? { text: `${name(ev.by).toUpperCase()}: ${COMM_LABELS[ev.comm]}`, tone: 'squad' } : null;
    }
    if (own || !((ev.squad | 0) === squad && squad > 0)) return null;
    return { text: `${name(ev.by).toUpperCase()}: ${COMM_LABELS[ev.comm]}`, tone: ev.comm === 'no' ? 'warn' : 'squad' };
  }
  if (ev.kind === 'comm_answer' && own) {
    return { text: `${COMM_MARKER_LABELS[ev.comm] ?? 'SUPPORT'} ${name(ev.responder).toUpperCase()} RESPONDING`, tone: 'squad' };
  }
  return null;
}

