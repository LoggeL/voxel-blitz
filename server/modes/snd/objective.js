function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function pointOf(value) {
  if (Array.isArray(value)) {
    const [x, y, z] = value;
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  }
  if (!value || typeof value !== 'object') return null;
  return [value.x, value.y, value.z].every(Number.isFinite)
    ? { x: value.x, y: value.y, z: value.z }
    : null;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function stableIdCompare(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function siteCenter(site) {
  if (!site) return null;
  const x = (site.minX + site.maxX) / 2;
  const z = (site.minZ + site.maxZ) / 2;
  return [x, site.y, z].every(Number.isFinite) ? { x, y: site.y, z } : null;
}

function insideSite(player, site) {
  return !!site
    && player.x >= site.minX && player.x <= site.maxX
    && player.z >= site.minZ && player.z <= site.maxZ
    && Number.isFinite(site.y) && Math.abs(player.y - site.y) <= 1.5;
}

export function freshBomb() {
  return {
    state: 'dropped',
    carrierId: null,
    siteId: null,
    x: null,
    y: null,
    z: null,
    plantedAt: null,
    explodeAt: null,
    unassigned: true,
  };
}

/** Owns bomb assignment, pickup, plant/defuse interactions and objective views. */
export class SndObjective {
  constructor(policy) {
    this.policy = policy;
    this.bomb = freshBomb();
    this.interactions = new Map();
  }

  resetBomb() {
    this.bomb = freshBomb();
  }

  assignBomb() {
    const p = this.policy;
    if (!this.bomb.unassigned) return;
    const candidates = [];
    for (const entity of p._entities.values()) {
      const state = p._state(entity);
      if (state?.participating && state.team === p.attackers && entity.state === 'alive') {
        candidates.push(entity);
      }
    }
    candidates.sort(stableIdCompare);
    if (!candidates.length) return;
    const carrier = candidates[(p.round - 1) % candidates.length];
    this.bomb.state = 'carried';
    this.bomb.carrierId = String(carrier.id);
    this.bomb.siteId = null;
    this.bomb.x = null;
    this.bomb.y = null;
    this.bomb.z = null;
    this.bomb.plantedAt = null;
    this.bomb.explodeAt = null;
    this.bomb.unassigned = false;
    p._syncAllPlayers();
    p._emit('bomb_assigned', { id: this.bomb.carrierId, round: p.round });
  }

  dropBomb(position, carrierId, reason) {
    if (!position) return;
    this.bomb.state = 'dropped';
    this.bomb.carrierId = null;
    this.bomb.siteId = null;
    this.bomb.x = position.x;
    this.bomb.y = position.y;
    this.bomb.z = position.z;
    this.bomb.plantedAt = null;
    this.bomb.explodeAt = null;
    this.bomb.unassigned = false;
    this.policy._syncAllPlayers();
    this.policy._emit('bomb_drop', {
      id: carrierId,
      reason,
      x: this.bomb.x,
      y: this.bomb.y,
      z: this.bomb.z,
    });
  }

  pickupDroppedBomb() {
    const p = this.policy;
    if (this.bomb.state !== 'dropped' || this.bomb.unassigned) return;
    const point = this.bombPosition();
    if (!point) return;
    const candidates = [];
    for (const entity of p._entities.values()) {
      const state = p._state(entity);
      if (!state?.participating || state.team !== p.attackers || entity.state !== 'alive') continue;
      const d = distance(point, entity);
      if (d <= p.rules.pickupRadius) candidates.push({ entity, d });
    }
    candidates.sort((a, b) => a.d - b.d || stableIdCompare(a.entity, b.entity));
    if (!candidates.length) return;
    const carrier = candidates[0].entity;
    this.bomb.state = 'carried';
    this.bomb.carrierId = String(carrier.id);
    this.bomb.x = null;
    this.bomb.y = null;
    this.bomb.z = null;
    p._syncAllPlayers();
    p._emit('bomb_pickup', { id: this.bomb.carrierId });
  }

  updateInteractions() {
    const p = this.policy;
    let completedDefuse = null;
    const entities = Array.from(p._entities.values()).sort(stableIdCompare);
    for (const entity of entities) {
      const id = String(entity.id);
      const state = p._state(entity);
      const held = !!(entity.input?.interact || entity.input?.keys?.interact);
      let intent = null;

      if (held && state?.participating && entity.state === 'alive') {
        if (state.team === p.attackers
            && this.bomb.state === 'carried'
            && this.bomb.carrierId === id) {
          const site = this.sites().find((candidate) => insideSite(entity, candidate));
          if (site) intent = { kind: 'plant', siteId: String(site.id), duration: p.rules.plantMs };
        } else if (state.team === p.defenders
            && this.bomb.state === 'planted'
            && distance(entity, this.bomb) <= p.rules.defuseRadius) {
          intent = { kind: 'defuse', siteId: this.bomb.siteId, duration: p.rules.defuseMs };
        }
      }

      if (!intent) {
        this.clearInteraction(id, true);
        continue;
      }

      let interaction = this.interactions.get(id);
      if (!interaction || interaction.kind !== intent.kind || interaction.siteId !== intent.siteId) {
        this.clearInteraction(id, true);
        interaction = { ...intent, startedAt: p.now };
        this.interactions.set(id, interaction);
        p._emit('interaction_start', { id, action: intent.kind, site: intent.siteId });
      }

      if (p.now - interaction.startedAt < interaction.duration) continue;
      if (interaction.kind === 'plant') {
        this.plantBomb(entity, interaction.siteId);
        return null;
      }
      if (!completedDefuse) completedDefuse = id;
    }
    p._syncAllPlayers();
    return completedDefuse;
  }

  plantBomb(entity, siteId) {
    const p = this.policy;
    this.bomb.state = 'planted';
    this.bomb.carrierId = null;
    this.bomb.siteId = siteId;
    this.bomb.x = entity.x;
    this.bomb.y = entity.y;
    this.bomb.z = entity.z;
    this.bomb.plantedAt = p.now;
    this.bomb.explodeAt = p.now + p.rules.fuseMs;
    this.bomb.unassigned = false;
    const state = p._state(entity);
    if (state) p._economy.addCredits(entity, state, p.rules.plantCredits, 'plant');
    this.clearAllInteractions();
    p._syncAllPlayers();
    p._emit('bomb_plant', {
      id: String(entity.id),
      site: siteId,
      x: this.bomb.x,
      y: this.bomb.y,
      z: this.bomb.z,
      explodeAt: this.bomb.explodeAt,
    });
  }

  clearInteraction(id, emit) {
    const prior = this.interactions.get(id);
    if (!prior) return;
    this.interactions.delete(id);
    const entity = this.policy._entity(id);
    if (entity) entity.interaction = null;
    if (emit) this.policy._emit('interaction_cancel', {
      id,
      action: prior.kind,
      site: prior.siteId,
    });
  }

  clearAllInteractions() {
    for (const id of Array.from(this.interactions.keys())) this.clearInteraction(id, false);
  }

  interactionSnapshot(id) {
    const interaction = this.interactions.get(id);
    if (!interaction) return null;
    return {
      kind: interaction.kind,
      site: interaction.siteId,
      progress: clamp01((this.policy.now - interaction.startedAt) / interaction.duration),
    };
  }

  bombPosition() {
    if (this.bomb.state === 'carried' && this.bomb.carrierId) {
      const carrier = this.policy._entity(this.bomb.carrierId);
      return carrier ? pointOf(carrier) : null;
    }
    return [this.bomb.x, this.bomb.y, this.bomb.z].every(Number.isFinite)
      ? { x: this.bomb.x, y: this.bomb.y, z: this.bomb.z }
      : null;
  }

  bombSnapshot() {
    const point = this.bombPosition();
    return {
      state: this.bomb.state,
      carrier: this.bomb.carrierId,
      site: this.bomb.siteId,
      x: point?.x ?? null,
      y: point?.y ?? null,
      z: point?.z ?? null,
      explodeAt: this.bomb.explodeAt,
    };
  }

  sites() {
    return Array.isArray(this.policy.mapMeta?.sites) ? this.policy.mapMeta.sites : [];
  }

  nearestSiteCenter(entity) {
    let best = null;
    let bestDistance = Infinity;
    for (const site of this.sites()) {
      const center = siteCenter(site);
      if (!center) continue;
      const d = distance(entity, center);
      if (d < bestDistance) {
        best = center;
        bestDistance = d;
      }
    }
    return best;
  }

  siteForId(id) {
    const sites = this.sites();
    if (!sites.length) return null;
    let hash = this.policy.round || 1;
    for (let i = 0; i < id.length; i++) {
      hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
    }
    return siteCenter(sites[hash % sites.length]);
  }

  dispose() {
    this.clearAllInteractions();
    this.interactions.clear();
    this.resetBomb();
  }
}
