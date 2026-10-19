/**
 * Mobile AA gunner HUD (design docs/design/conquest/aa/, variant A): the gun
 * reticle with its heat arc, the radar track box with range around the
 * tracked enemy aircraft and the lead pipper where the flak meets it, and the
 * round radar scope above the exit prompt (heading-up: screen up is where the
 * view looks), with range rings, the hull and gun wedge and every airborne
 * aircraft in radar range as a blip. Models are pure functions of snapshot
 * rows (aircraft rows carry position, velocity and the airborne flag), so the
 * scope shows exactly what the server publishes; the draw only paints them.
 */
import { VEHICLE_WEAPON_META, vehicleStatus } from '../../../../shared/conquest-contract.js';
import { isAircraftType } from '../../../../shared/vehicle-defs.js';
import { AA_RADAR } from '../../../../shared/vehicle-handling/aa.js';
import { angleTo, leadPoint } from './projection.js';

const AMBER = '#ffcf5c', WHITE = '#f4f7f9', RED = '#ff4b4b', GREEN = '#7ef29a', CYAN = '#4cc3ff', ORANGE = '#ff8a3d';
const SCOPE = '#7ef29a', SCOPE_DIM = '#7ef29a55', SCOPE_FAINT = '#7ef29a26', SCOPE_GLASS = '#04140bd0';
const TAU = Math.PI * 2;
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/** True for an aircraft row in flight (rows spell flight out as grounded:false; st carries the bit). */
export function rowAirborne(row) {
  if (!row || !isAircraftType(row.type) || !(row.hp > 0)) return false;
  if (row.grounded === false) return true;
  if (row.grounded === true) return false;
  return row.st != null && !vehicleStatus(row).grounded;
}

/**
 * Radar picture around an AA hull: every airborne aircraft within
 * AA_RADAR.range of `origin` (default the hull), nearest first, at most
 * AA_RADAR.maxContacts. `rel` is the bearing from the view (rad, +left like
 * every yaw), `range` metres, `enemy` against `selfTeam`. `hull` and `gun`
 * are the hull's and the guns' yaw offsets from the view.
 */
export function aaRadarModel(row, vehicles, { selfTeam = null, viewYaw = null, origin = null, hullYaw = null } = {}) {
  if (!row) return null;
  const o = origin ?? [row.x, finite(row.y), row.z];
  const yaw = finite(hullYaw, finite(row.yaw)), turret = finite(row.turretYaw, yaw);
  const view = Number.isFinite(viewYaw) ? viewYaw : turret;
  const contacts = [];
  for (const v of vehicles || []) {
    if (!v || v.id === row.id || !rowAirborne(v)) continue;
    const dx = v.x - o[0], dz = v.z - o[2], range = Math.hypot(dx, finite(v.y) - o[1], dz);
    if (!(range <= AA_RADAR.range)) continue;
    const bearing = Math.atan2(-dx, -dz);
    contacts.push({ id: String(v.id), type: v.type, team: v.team ?? null, enemy: selfTeam != null && v.team != null && v.team !== selfTeam,
      rel: wrap(bearing - view), range: Math.round(range), altitude: Math.round(finite(v.y) - o[1]) });
  }
  contacts.sort((a, b) => a.range - b.range);
  const shown = contacts.slice(0, AA_RADAR.maxContacts);
  return { range: AA_RADAR.range, contacts: shown, hostile: shown.filter(c => c.enemy).length,
    hull: wrap(yaw - view), gun: wrap(turret - view) };
}

/**
 * The AA gun's tracked target: the airborne enemy aircraft in radar range
 * nearest the gun line within AA_RADAR.trackCone, else null.
 */
export function aaTrackTarget(row, pose, vehicles, selfTeam) {
  if (!pose?.origin || !pose?.dir) return null;
  let best = null, bestAngle = AA_RADAR.trackCone;
  for (const v of vehicles || []) {
    if (!v || v.id === row?.id || !rowAirborne(v) || v.team == null || v.team === selfTeam) continue;
    const point = [v.x, finite(v.y), v.z];
    if (Math.hypot(point[0] - pose.origin[0], point[1] - pose.origin[1], point[2] - pose.origin[2]) > AA_RADAR.range) continue;
    const angle = angleTo(pose.dir, pose.origin, point);
    if (angle < bestAngle) { bestAngle = angle; best = v; }
  }
  return best;
}

/**
 * The AA driver's reticle model (kind 'aa'): `bore` the guns' line 300 m out
 * (where they point now), heat, the radar picture and the track: the box on
 * the target, its range, and the lead pipper (flak speed and drop from
 * VEHICLE_WEAPON_META) with `onTarget` once the bore sits on it.
 */
export function aaReticleModel(base, row, selected, pose, { project, vehicles = [], selfTeam = null, viewYaw = null, hullYaw = null } = {}) {
  const meta = VEHICLE_WEAPON_META[selected.weapon] ?? {};
  const far = pose ? project([pose.origin[0] + pose.dir[0] * 300, pose.origin[1] + pose.dir[1] * 300, pose.origin[2] + pose.dir[2] * 300]) : null;
  const radar = aaRadarModel(row, vehicles, { selfTeam, viewYaw, hullYaw, origin: pose?.pivot ?? null });
  const target = aaTrackTarget(row, pose, vehicles, selfTeam);
  let track = null;
  if (target && pose) {
    const at = [target.x, finite(target.y), target.z];
    const lead = leadPoint(pose.origin, at, [finite(target.vx), finite(target.vy), finite(target.vz)], finite(meta.speed));
    // The shell drops on the way: aim that much above the meeting point.
    const aimAt = [lead.point[0], lead.point[1] + 0.5 * finite(meta.gravity) * lead.tof * lead.tof, lead.point[2]];
    const box = project(at), pip = project(aimAt);
    const range = Math.round(Math.hypot(at[0] - pose.origin[0], at[1] - pose.origin[1], at[2] - pose.origin[2]));
    track = { id: String(target.id), range, tof: lead.tof, box: box ? { x: box.x, y: box.y } : null, lead: pip ? { x: pip.x, y: pip.y } : null };
    const bore = far ?? base.center;
    track.onTarget = !!(track.lead && Math.hypot(track.lead.x - bore.x, track.lead.y - bore.y) < 10);
  }
  return { ...base, kind: 'aa', bore: far ? { x: far.x, y: far.y } : null, heat: selected.heat, overheated: selected.overheated,
    ready: selected.ready, label: selected.label, radar, track };
}

/** Scope placement: desktop centred above the exit prompt; phones smaller (portrait under the prompt, landscape left of it). */
export function aaScopeLayout(width, height, touch = false) {
  const landscape = touch && width > height;
  const radius = touch ? (landscape ? 44 : 54) : 66;
  const cx = landscape ? width / 2 - 150 : width / 2;
  const cy = !touch ? height - 276 : landscape ? height - 80 : Math.min(height / 2 + 262, height - 160);
  return { cx, cy, radius, caption: cy + radius + 13, rect: { left: cx - radius - 4, top: cy - radius - 4, right: cx + radius + 4, bottom: cy + radius + 20 } };
}

/**
 * Paint the AA HUD. `text(ctx, text, x, y, color)` and `shadowed(ctx, draw)`
 * are the Reticles helpers (outlined labels and strokes). Returns the scope's
 * screen rect for the reserved list.
 */
export function drawAaReticle(ctx, m, width, height, { touch = false, text, shadowed, now = globalThis.performance?.now?.() ?? 0 } = {}) {
  const { x, y } = m.center;
  // Gun reticle: the aim circle and dot, the bore cross when the guns lag the aim.
  ctx.save();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffffd0';
  shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 34, 0, TAU); ctx.stroke(); });
  ctx.fillStyle = WHITE; ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill();
  if (m.bore && Math.hypot(m.bore.x - x, m.bore.y - y) > 4) {
    const b = m.bore;
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffffb0';
    shadowed(ctx, () => { ctx.beginPath(); ctx.moveTo(b.x - 7, b.y); ctx.lineTo(b.x + 7, b.y); ctx.moveTo(b.x, b.y - 7); ctx.lineTo(b.x, b.y + 7); ctx.stroke(); });
  }
  // Heat arc on the right of the circle, filling from the bottom up.
  const heat = Math.max(0, Math.min(1, finite(m.heat))), tone = m.overheated ? RED : heat > 0.75 ? ORANGE : AMBER;
  ctx.lineWidth = 3.5; ctx.strokeStyle = '#00000070';
  ctx.beginPath(); ctx.arc(x, y, 41, Math.PI * 0.4, -Math.PI * 0.4, true); ctx.stroke();
  if (heat > 0.005) {
    ctx.strokeStyle = tone;
    ctx.beginPath(); ctx.arc(x, y, 41, Math.PI * 0.4, Math.PI * 0.4 - Math.PI * 0.8 * heat, true); ctx.stroke();
  }
  ctx.textAlign = 'left';
  text(ctx, m.overheated ? 'OVERHEAT' : `HEAT ${Math.round(heat * 100)}%`, x + 44, y + 34, m.overheated ? RED : tone);
  ctx.restore();

  // Radar track: box, range, dotted lead line and pipper.
  const t = m.track;
  if (t?.box) {
    const tb = t.box, s = 15;
    ctx.save();
    ctx.lineWidth = 1.5; ctx.strokeStyle = ORANGE;
    shadowed(ctx, () => { ctx.strokeRect(tb.x - s, tb.y - s, s * 2, s * 2); });
    text(ctx, `TRK ${t.range} M`, tb.x, tb.y - s - 6, ORANGE);
    if (t.lead) {
      const lp = t.lead, color = t.onTarget ? GREEN : ORANGE;
      ctx.setLineDash([3, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = '#ff8a3dc0';
      ctx.beginPath(); ctx.moveTo(tb.x, tb.y); ctx.lineTo(lp.x, lp.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2; ctx.strokeStyle = color;
      shadowed(ctx, () => { ctx.beginPath(); ctx.moveTo(lp.x, lp.y - 8); ctx.lineTo(lp.x + 8, lp.y); ctx.lineTo(lp.x, lp.y + 8); ctx.lineTo(lp.x - 8, lp.y); ctx.closePath(); ctx.stroke(); });
    }
    ctx.restore();
  }

  // Radar scope.
  const r = m.radar;
  const layout = aaScopeLayout(width, height, touch);
  if (!r) return layout.rect;
  const { cx, cy, radius } = layout;
  ctx.save();
  ctx.fillStyle = SCOPE_GLASS;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TAU); ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = SCOPE;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TAU); ctx.stroke();
  ctx.lineWidth = 1; ctx.strokeStyle = SCOPE_DIM;
  ctx.beginPath(); ctx.arc(cx, cy, radius / 2, 0, TAU); ctx.stroke();
  ctx.strokeStyle = SCOPE_FAINT;
  ctx.beginPath(); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); ctx.stroke();
  // Sweep line with a fading wedge behind it (presentation clock).
  const sweep = Number.isFinite(m.sweep) ? m.sweep : (now / 1000 / AA_RADAR.sweepSeconds) * TAU;
  const steps = 10;
  for (let i = 0; i < steps; i++) {
    const a0 = sweep - (i + 1) * 0.07, a1 = sweep - i * 0.07;
    ctx.fillStyle = `rgba(126, 242, 154, ${(0.22 * (1 - i / steps)).toFixed(3)})`;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, radius, a0 - Math.PI / 2, a1 - Math.PI / 2); ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = SCOPE; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(sweep) * radius, cy - Math.cos(sweep) * radius); ctx.stroke();
  // Range labels on the rings.
  ctx.font = `700 ${touch ? 9 : 10}px "Rajdhani", "Barlow Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.fillStyle = '#7ef29ab0';
  ctx.fillText(String(Math.round(r.range / 2)), cx, cy - radius / 2 - 3);
  ctx.fillText(String(r.range), cx, cy - radius + 11);
  // The guns' field of view (a narrow wedge along the gun yaw) and the hull chevron.
  const gun = -finite(r.gun), hull = -finite(r.hull);
  ctx.strokeStyle = '#f4f7f9b0'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(gun - 0.22) * radius, cy - Math.cos(gun - 0.22) * radius);
  ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(gun + 0.22) * radius, cy - Math.cos(gun + 0.22) * radius);
  ctx.stroke();
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(hull);
  ctx.fillStyle = WHITE; ctx.strokeStyle = '#000000a0'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-5, 5); ctx.closePath(); ctx.stroke(); ctx.fill();
  ctx.restore();
  // Contacts: triangles pointing up, enemy orange, friendly blue; the tracked one boxed.
  for (const c of r.contacts) {
    const d = Math.min(1, c.range / r.range) * (radius - 6), a = -c.rel;
    const px = cx + Math.sin(a) * d, py = cy - Math.cos(a) * d;
    ctx.fillStyle = c.enemy ? ORANGE : CYAN; ctx.strokeStyle = '#000000b0'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, py - 5); ctx.lineTo(px + 4.5, py + 3.5); ctx.lineTo(px - 4.5, py + 3.5); ctx.closePath(); ctx.stroke(); ctx.fill();
    if (t && c.id === t.id) { ctx.strokeStyle = ORANGE; ctx.lineWidth = 1; ctx.strokeRect(px - 7.5, py - 7.5, 15, 15); }
  }
  ctx.restore();
  ctx.save();
  ctx.font = `700 ${touch ? 9 : 10.5}px "Rajdhani", "Barlow Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  text(ctx, `AA RADAR · ${r.range} M · ${r.hostile} CONTACT${r.hostile === 1 ? '' : 'S'}`, cx, layout.caption, SCOPE);
  ctx.restore();
  return layout.rect;
}
