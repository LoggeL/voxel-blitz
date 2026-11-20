import { combatDamage } from '../../shared/combat-balance.js';
import { rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit } from '../protocol/events.js';
import { visibleBodyContact } from './body-contact.js';
import { occupantHitPose, occupantShielded, occupantDamageScale } from './vehicle-damage.js';

const pointOn = (a, direction, distance) => a.map((v, i) => v + direction[i] * distance);
const wirePoint = point => point.map(v => Math.round(v * 100) / 100);
const event = (id, phase, fields) => ({ t: 'ev', kind: 'stitch', id: String(id), phase, ...fields });

/** Nearest hard surface along a world-space segment. Hulls can block a filament too. */
function obstruction(a, direction, distance, ctx) {
  const wall = raycastVoxels(ctx.solidAt, ...a, ...direction, distance);
  const hull = ctx.vehicles?.rayHit(a, direction, wall?.t ?? distance);
  return hull?.distance ?? wall?.t ?? Infinity;
}

export function stitchHit(owner, victim, rawDamage, headshot, point, ctx, markers) {
  const damage = combatDamage(rawDamage * occupantDamageScale(victim));
  const lethal = victim.takeDamage(damage, headshot, owner, 'selvedge');
  ctx.pushEvent({ ...evHit(owner.id, victim.id, damage, headshot, point, victim.lastDamage), w: 'selvedge' });
  if (lethal) ctx.killPlayer(victim, owner, 'selvedge', headshot, markers);
}

function validPin(pin, ctx) {
  return pin && ctx.now < pin.expires && ctx.solidAt(...pin.cell)
    && !ctx.solidAt(...pin.a.map(Math.floor));
}

/** At most one waiting pin and one moving seam per wielder, including bots. */
export class SelvedgeSystem {
  constructor() {
    this.owners = new Map();
  }

  anchorFor(owner) {
    return this.owners.get(owner.id)?.pin?.a ?? null;
  }

  // A client entering a running round can still read an opponent's pin and
  // dodge a pulse that launched before its map arrived.
  activeEvents(now) {
    const events = [];
    for (const [id, { pin, seam }] of this.owners) {
      if (seam) {
        const { a, direction, distance, length, rules } = seam;
        events.push(event(id, 'sew', { restore: true, a: wirePoint(pointOn(a, direction, distance)),
          b: wirePoint(pointOn(a, direction, length)), ms: Math.round(1000 * (length - distance) / rules.speed),
          radius: rules.radius }));
      }
      // A new pin may coexist with its owner's previous travelling seam.
      if (pin && pin.expires > now) events.push(event(id, 'pin', {
        restore: true, a: wirePoint(pin.a), n: pin.n, ms: Math.ceil(pin.expires - now),
      }));
    }
    return events;
  }

  cancel(id, ctx) {
    if (this.owners.delete(id)) ctx?.pushEvent(event(id, 'clear'));
  }

  clear(ctx) {
    for (const id of this.owners.keys()) this.cancel(id, ctx);
  }

  pin(owner, point, hit, ctx) {
    if (hit.y < 0 || ctx.inMap?.(hit.x, hit.z) === false || !(hit.nx || hit.ny || hit.nz)) return;
    const normal = [hit.nx, hit.ny, hit.nz];
    const a = pointOn(point, normal, 0.06);
    if (ctx.solidAt(...a.map(Math.floor))) return;
    const rules = owner.def.stitch;
    let state = this.owners.get(owner.id);
    if (!state) {
      state = { owner, pin: null, seam: null };
      this.owners.set(owner.id, state);
    }
    const prior = state.pin;
    let reason;
    if (validPin(prior, ctx)) {
      const delta = a.map((v, i) => v - prior.a[i]);
      const length = Math.hypot(...delta);
      if (length < rules.minSpan) reason = 'short';
      else if (length > rules.maxSpan) reason = 'long';
      else {
        const direction = delta.map(v => v / length);
        if (obstruction(prior.a, direction, length, ctx) > length) {
          state.seam = { a: prior.a, direction, length, distance: 0, hit: new Set(), rules };
          state.pin = null;
          ctx.pushEvent(event(owner.id, 'sew', { a: wirePoint(prior.a), b: wirePoint(a),
            ms: Math.round(length / rules.speed * 1000), radius: rules.radius }));
          return;
        }
        reason = 'blocked';
      }
    }
    // Even an impossible pairing gives immediate feedback and a fresh starting
    // point. An empty-air tap leaves the last good surface alone.
    state.pin = { a, n: normal, cell: [hit.x, hit.y, hit.z], expires: ctx.now + rules.anchorMs };
    ctx.pushEvent(event(owner.id, 'pin', { a: wirePoint(a), n: normal, ms: rules.anchorMs, ...(reason && { reason }) }));
  }

  step(dt, ctx) {
    for (const [id, state] of this.owners) {
      const { owner, pin, seam } = state;
      if (ctx.entities.get(id) !== owner || owner.state !== 'alive' || owner.def.id !== 'selvedge'
        || !ctx.canFire(owner) || (owner.vehicleId && !ctx.vehicles?.seatAllowsPersonalWeapons?.(owner))) {
        this.cancel(id, ctx);
        continue;
      }
      if (pin && !validPin(pin, ctx)) {
        state.pin = null;
        ctx.pushEvent(event(id, 'clear', { part: 'pin' }));
      }
      if (seam && this.advance(owner, seam, dt, ctx)) state.seam = null;
      if (!state.pin && !state.seam) this.owners.delete(id);
    }
  }

  advance(owner, seam, dt, ctx) {
    const { rules, direction } = seam;
    const remaining = Math.min(seam.length - seam.distance, Math.max(0, dt) * rules.speed);
    if (remaining <= 0) return false;
    const start = pointOn(seam.a, direction, seam.distance);
    const blocked = obstruction(start, direction, remaining, ctx);
    const limit = Math.min(blocked, remaining);
    const dir = { x: direction[0], y: direction[1], z: direction[2] };
    for (const victim of (ctx.targets || ctx.entities).values()) {
      if (victim === owner || victim.state !== 'alive' || seam.hit.has(victim)
        || occupantShielded(victim) || !ctx.canDamage(owner, victim)) continue;
      const pose = occupantHitPose(victim);
      const bodyReach = victim.combatBox ? 2 * Math.hypot(...victim.combatBox) : 2.5 * (pose.bodyScale || 1);
      if (Math.hypot(pose.x - start[0], pose.y - start[1], pose.z - start[2]) > limit + rules.radius + bodyReach) continue;
      const hit = rayPlayerHitboxes(start, dir, pose, limit, { radius: rules.radius, preferCore: true });
      if (!hit) continue;
      const center = pointOn(start, direction, hit.t);
      const point = visibleBodyContact(center, pose, rules.radius + 1e-5, center, ctx.solidAt);
      if (!point) continue;
      const lateral = point.map((v, i) => v - center[i]);
      const reach = Math.hypot(...lateral);
      if (reach > 1e-5 && ctx.vehicles?.rayHit(center, lateral.map(v => v / reach), reach, victim.vehicleId ?? null)) continue;
      seam.hit.add(victim);
      stitchHit(owner, victim, rules.damage, false, point, ctx);
    }
    seam.distance += limit;
    if (blocked <= remaining) ctx.pushEvent(event(owner.id, 'clear', { part: 'seam' }));
    return blocked <= remaining || seam.distance >= seam.length - 1e-6;
  }
}
