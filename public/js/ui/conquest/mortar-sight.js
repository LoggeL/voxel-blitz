/**
 * Support mortar fire-control panel (design docs/design/conquest/mortar/,
 * variant A): a heading-up map of the ground ahead of the mortar with the
 * range band, the azimuth line, the predicted impact and its blast ring, the
 * spotted enemies and flags; under it AZ / ELEV / RANGE / TOF, the rounds left
 * and the reload bar. A ground ring marks the impact in the world.
 *
 * Every value comes from the authoritative hull row: the tube's mount state
 * `[yaw, pitch, ammo, heat, reload]` and the shared mount pose
 * (VEHICLE_DEFS.mortar.mounts.tube), the arc from VEHICLE_WEAPON_META.mortarHE
 * (the server's projectile), the band from shared/mortar-rules.js. Only the
 * dashed "laying" mark is the operator's own aim (VehicleController yaw /
 * pitch) while the tube slews toward it.
 */
import { VEHICLE_WEAPON_META } from '../../../../shared/conquest-contract.js';
import * as vehicleDefs from '../../../../shared/vehicle-defs.js';
import { MORTAR_RULES, mortarFlatRange, mortarFlatTime, mortarRangeEnvelope } from '../../../../shared/mortar-rules.js';
import { mountPoseOf, mountState, seatWeapons, minimapPlacement } from '../conquest-hud-state.js';
import { ballisticImpact } from './projection.js';
import { el } from '../hud-support.js';
import { imageReady, overviewImage, paintFlag, paintUnit, paintVectorBase, toneColor } from './map-painter.js';
import { drawIcon } from './icons.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const heading = yaw => Math.round(((-yaw * 180 / Math.PI) % 360 + 360) % 360) % 360;
/** Aim and tube within this many radians: the tube is laid. */
const LAID = 0.012;
/** An RMB snap marks its target this long (ms). */
const SNAP_MS = 2500;
const AMBER = '#ffd166';
/** The key hints under the panel show this long after the operator takes the tube (ms), then go. */
export const MORTAR_HINT_MS = 10000;

/**
 * Read model of the sight, or null when the seat is no mortar operator.
 * `items`: mapItems(); `raycast(origin, dir, max)` the world picker (skips
 * water like the server's projectile cast); `aim` { yaw, pitch } the
 * operator's aim; `snap` the controller's last RMB snap { target, at };
 * `projector` for the in-world ring; `nowMs` a monotonic clock for the snap.
 */
export function mortarSightModel(seated, { items = [], raycast = null, aim = null, snap = null, projector = null, nowMs = 0,
  registry = vehicleDefs } = {}) {
  const row = seated?.row, seat = seated?.seat;
  if (row?.type !== MORTAR_RULES.type || seat?.id !== MORTAR_RULES.seat) return null;
  const state = mountState(row, seat.id, MORTAR_RULES.mount);
  if (!state) return null;
  const weapon = seatWeapons(row, seat.id)[0] || null;
  const meta = VEHICLE_WEAPON_META[MORTAR_RULES.weapon] || {};
  const def = registry?.vehicleWeapon?.(MORTAR_RULES.weapon) ?? null;
  const pose = mountPoseOf(row, seat.id, MORTAR_RULES.mount, registry);
  const origin = pose?.origin ?? [finite(row.x), finite(row.y) + 1, finite(row.z)];
  const yaw = state.yaw, pitch = state.pitch;
  const forward = [-Math.sin(yaw), -Math.cos(yaw)];
  // The arc of the tube as it stands, against the world; without a picker (or
  // no ground within the round's life) the flat-ground solution at the hull.
  const landed = pose && raycast ? ballisticImpact(pose.origin, pose.dir, meta.speed, meta.gravity, raycast,
    { maxSeconds: finite(def?.lifetimeMs, 14000) / 1000, step: 0.1 }) : null;
  const flatRange = mortarFlatRange(pitch);
  const impact = landed?.point ?? [origin[0] + forward[0] * flatRange, finite(row.y), origin[2] + forward[1] * flatRange];
  const range = landed ? landed.range : flatRange;
  const tof = landed ? landed.time : mortarFlatTime(pitch);
  // The operator's aim while the tube still slews toward it.
  let laying = null;
  if (aim && Number.isFinite(aim.yaw) && Number.isFinite(aim.pitch)) {
    const off = Math.max(Math.abs(wrap(aim.yaw - yaw)), Math.abs(aim.pitch - pitch));
    if (off > LAID) {
      const r = mortarFlatRange(aim.pitch);
      laying = { x: origin[0] - Math.sin(aim.yaw) * r, z: origin[2] - Math.cos(aim.yaw) * r, range: Math.round(r) };
    }
  }
  const center = { x: finite(row.x), z: finite(row.z) };
  const reach = MORTAR_RULES.sightRange;
  const targets = items.filter(item => (item.kind === 'spotted' || (item.kind === 'vehicle' && item.rel === 'spotted'))
    && Math.hypot(item.x - center.x, item.z - center.z) <= reach)
    .map(item => ({ id: item.id, x: item.x, z: item.z, vehicleType: item.vehicleType ?? null }));
  const snapped = snap && Array.isArray(snap.target) && nowMs - finite(snap.at, -Infinity) < SNAP_MS
    ? { x: snap.target[0], z: snap.target[2] } : null;
  const screen = projector ? projector.project(impact[0], impact[1], impact[2]) : null;
  const magazine = finite(def?.magazine, 5);
  const ammo = Number.isFinite(weapon?.ammo) && weapon.ammo >= 0 ? weapon.ammo : magazine;
  const envelope = mortarRangeEnvelope();
  return {
    vehicleId: String(row.id), center, origin, yaw,
    azimuth: heading(yaw), elevation: Math.round(pitch * 1800 / Math.PI) / 10,
    range: Math.round(range), tof: Math.round(tof * 10) / 10,
    impact, blastRadius: finite(def?.splashRadius, 5),
    screen: screen && !screen.behind ? { x: screen.x, y: screen.y } : null,
    laying, laid: !laying, snapped, targets,
    envelope: { min: Math.round(envelope.min), max: Math.round(envelope.max) },
    rounds: { ammo, magazine, reload: finite(weapon?.reload), ready: !!weapon?.ready },
    status: weapon?.reload > 0 && ammo === 0 ? 'RELOADING' : weapon?.reload > 0 ? 'LOADING' : laying ? 'LAYING' : 'READY',
    reach,
  };
}

/** The panel (right edge, above the vehicle card) and the in-world impact ring. */
export class MortarSight {
  constructor(parent, { hints = '' } = {}) {
    this.root = el('section', 'cq-mortar', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Mortar fire control');
    const head = el('header', 'cq-mortar-head', this.root);
    el('span', 'cq-mortar-title', head).textContent = 'MORTAR FIRE-CONTROL';
    this.status = el('span', 'cq-mortar-status', head);
    this.mapBox = el('div', 'cq-mortar-map', this.root);
    this.canvas = el('canvas', 'cq-mortar-canvas', this.mapBox);
    this.context = this.canvas.getContext?.('2d') ?? null;
    const readouts = el('div', 'cq-mortar-readouts', this.root);
    this.values = {};
    for (const [key, label] of [['az', 'AZ'], ['elev', 'ELEV'], ['range', 'RANGE'], ['tof', 'TOF']]) {
      const cell = el('div', 'cq-mortar-cell', readouts);
      el('span', 'cq-mortar-label', cell).textContent = label;
      this.values[key] = el('span', 'cq-mortar-value', cell);
    }
    const rounds = el('div', 'cq-mortar-rounds', this.root);
    el('span', 'cq-mortar-weapon', rounds).textContent = VEHICLE_WEAPON_META[MORTAR_RULES.weapon]?.label || 'MORTAR HE';
    this.pips = el('span', 'cq-mortar-pips', rounds);
    this.count = el('span', 'cq-mortar-count', rounds);
    const bar = el('div', 'cq-mortar-reload', this.root);
    this.fill = el('div', 'cq-mortar-reload-fill', bar);
    this.hints = el('footer', 'cq-mortar-hints', this.root);
    this.hints.hidden = true;
    this._hintText = hints;
    this._hintFor = null; this._hintAt = -Infinity;
    this.ring = el('div', 'cq-mortar-impact', parent);
    this.ring.hidden = true;
    this.ringLabel = el('span', 'cq-mortar-impact-label', this.ring);
    this.image = overviewImage();
    this._px = 0; this._pips = -1;
    this.model = null;
  }

  setHints(text) { this._hintText = text; }

  /** `clockMs` (a monotonic clock) times the key hints: shown for MORTAR_HINT_MS after a mortar is manned, never a permanent line. */
  update(model, { items = [], meta = null, size = { x: 768, z: 768 }, viewYaw = null, nowMs = 0, clockMs = nowMs } = {}) {
    this.model = model;
    this.root.hidden = !model;
    this.ring.hidden = !model?.screen;
    if (model?.vehicleId !== this._hintFor) { this._hintFor = model?.vehicleId ?? null; this._hintAt = clockMs; }
    const hint = model && clockMs - this._hintAt < MORTAR_HINT_MS ? this._hintText : '';
    if (this.hints.textContent !== hint) this.hints.textContent = hint;
    this.hints.hidden = !hint;
    if (!model) return;
    this.status.textContent = model.status;
    this.status.dataset.state = model.status.toLowerCase();
    this.values.az.textContent = `${String(model.azimuth).padStart(3, '0')}°`;
    this.values.elev.textContent = `${model.elevation.toFixed(1)}°`;
    this.values.range.textContent = `${model.range} M`;
    this.values.tof.textContent = `${model.tof.toFixed(1)} S`;
    const { ammo, magazine, reload } = model.rounds;
    if (this._pips !== magazine) {
      this.pips.replaceChildren(...Array.from({ length: magazine }, () => el('i', 'cq-mortar-pip')));
      this._pips = magazine;
    }
    [...this.pips.children].forEach((pip, index) => { pip.dataset.full = String(index < ammo); });
    this.count.textContent = `${ammo} / ${magazine}`;
    this.fill.style.width = `${Math.round((1 - reload) * 100)}%`;
    this.fill.dataset.state = reload > 0 ? 'loading' : 'ready';
    if (model.screen) {
      this.ring.style.transform = `translate(${model.screen.x.toFixed(1)}px, ${model.screen.y.toFixed(1)}px)`;
      this.ringLabel.textContent = `${model.range} M`;
      this.ring.dataset.laid = String(model.laid);
    }
    this._draw(model, { items, meta, size, viewYaw: Number.isFinite(viewYaw) ? viewYaw : model.yaw, nowMs });
  }

  hide() { this.update(null); }

  _draw(model, { items, meta, size, viewYaw, nowMs }) {
    const ctx = this.context;
    if (!ctx) return;
    const css = this.mapBox.clientWidth || 236;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const px = Math.round(css * dpr);
    if (px !== this._px) { this._px = px; this.canvas.width = px; this.canvas.height = px; }
    const k = px / css;
    // Heading-up on the view: the mortar sits at the bottom centre, its maximum range near the top edge.
    const ox = px / 2, oy = px - 14 * k;
    const s = (oy - 10 * k) / (model.envelope.max + 8);
    const c = Math.cos(viewYaw), sn = Math.sin(viewYaw);
    const a = s * c, b = s * sn, cc = -s * sn, d = s * c;
    const center = model.center;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, px, px); ctx.clip();
    ctx.fillStyle = '#0b1319'; ctx.fillRect(0, 0, px, px);
    ctx.setTransform(a, b, cc, d, ox - (a * center.x + cc * center.z), oy - (b * center.x + d * center.z));
    paintVectorBase(ctx, meta, (x, z) => ({ x, y: z }), 1);
    if (imageReady(this.image)) { ctx.globalAlpha = 0.9; ctx.drawImage(this.image, 0, 0, size.x, size.z); ctx.globalAlpha = 1; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05090d55'; ctx.fillRect(0, 0, px, px);
    const at = point => {
      const p = minimapPlacement(point, center, viewYaw, s);
      return { x: ox + p.x, y: oy + p.y };
    };
    // The reachable band (45..85 degrees of elevation) as dashed arcs with their ranges.
    ctx.lineWidth = 1.2 * k; ctx.setLineDash([4 * k, 4 * k]); ctx.strokeStyle = '#eef3f6aa';
    ctx.font = `700 ${10 * k}px system-ui, sans-serif`; ctx.fillStyle = '#eef3f6cc'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (const r of [model.envelope.min, model.envelope.max]) {
      ctx.beginPath(); ctx.arc(ox, oy, r * s, Math.PI, Math.PI * 2); ctx.stroke();
      ctx.fillText(`${r} M`, ox + 4 * k, oy - r * s - 2 * k);
    }
    ctx.setLineDash([]);
    const pulse = (Math.sin(nowMs / 160) + 1) * 0.75;
    for (const item of items) {
      if (item.kind === 'aura' || item.kind === 'self' || item.kind === 'hq') continue;
      if (item.kind === 'vehicle' && item.id === model.vehicleId) continue;
      const p = at(item);
      if (p.x < -20 || p.y < -20 || p.x > px + 20 || p.y > px + 20) continue;
      if (item.kind === 'flag') paintFlag(ctx, item, p, item.radius * s, { letterSize: 10 * k, pulse: item.contested ? pulse : 0 });
      else paintUnit(ctx, item, p, item.kind === 'vehicle' ? -(finite(item.yaw) - viewYaw) : 0, 0.9 * k);
    }
    // Azimuth line from the tube to the impact, the impact with its blast ring.
    const hit = at({ x: model.impact[0], z: model.impact[2] });
    ctx.strokeStyle = AMBER; ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(hit.x, hit.y); ctx.stroke();
    if (model.laying) {
      const aim = at(model.laying);
      ctx.setLineDash([3 * k, 3 * k]); ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 1.2 * k;
      ctx.beginPath(); ctx.arc(aim.x, aim.y, 6 * k, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    const blast = Math.max(6 * k, model.blastRadius * s);
    ctx.fillStyle = '#ffd16626'; ctx.strokeStyle = AMBER; ctx.lineWidth = 1.6 * k;
    ctx.beginPath(); ctx.arc(hit.x, hit.y, blast, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(hit.x - blast - 4 * k, hit.y); ctx.lineTo(hit.x + blast + 4 * k, hit.y);
    ctx.moveTo(hit.x, hit.y - blast - 4 * k); ctx.lineTo(hit.x, hit.y + blast + 4 * k); ctx.stroke();
    if (model.snapped) {
      const t = at(model.snapped);
      ctx.strokeStyle = toneColor('spotted'); ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(t.x - 8 * k, t.y - 8 * k, 16 * k, 16 * k);
    }
    // The mortar itself at the bottom centre.
    ctx.beginPath(); ctx.arc(ox, oy, 9 * k, 0, Math.PI * 2); ctx.fillStyle = '#0b1218e6'; ctx.fill();
    ctx.strokeStyle = toneColor('own'); ctx.lineWidth = 1.5 * k; ctx.stroke();
    drawIcon(ctx, 'mortar', ox, oy, 13 * k, toneColor('own'));
    ctx.restore();
  }

  dispose() { this.root.remove(); this.ring.remove(); }
}

const REFUSED_DETAIL = Object.freeze({
  kit: 'SUPPORT WITH THE M-81 MORTAR GADGET ONLY', state: 'NOT WHILE DOWN OR SEATED',
  ground: 'NEEDS FIRM GROUND AHEAD', blocked: 'NO ROOM AHEAD',
});

/** Banner for an own `mortar` event: placed, refused (with the reason) or lost (with the wait). */
export function mortarBanner(ev, selfId) {
  if (ev?.kind !== 'mortar' || selfId == null || String(ev.id) !== String(selfId)) return null;
  const wait = Math.max(1, Math.ceil(finite(ev.waitMs) / 1000));
  if (ev.state === 'placed') return { key: `mortar:placed:${ev.vehicleId}`, tone: 'own', title: 'MORTAR PLACED', detail: 'WALK YOUR ROUNDS ONTO SPOTTED ENEMIES', priority: 3 };
  if (ev.state === 'lost') return { key: `mortar:lost:${ev.vehicleId}`, tone: 'enemy', title: 'MORTAR LOST', detail: `NEW MORTAR IN ${wait} S`, priority: 4 };
  if (ev.state === 'refused') {
    const detail = ev.reason === 'cooldown' ? `READY IN ${wait} S` : REFUSED_DETAIL[ev.reason] || 'NOT HERE';
    return { key: `mortar:refused:${ev.reason}:${wait}`, tone: 'enemy', title: 'CANNOT PLACE MORTAR', detail, priority: 2 };
  }
  return null;
}
