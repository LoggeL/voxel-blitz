import { TTT_GADGET_RULES, TTT_SHOP } from '../../shared/ttt.js';
import { boxCollides, PHYSICS, solidBelow } from '../../shared/player-movement.js';
import { applyPowerup } from '../sim/powerups.js';

/** Round-scoped equipment. Radar snapshots and destinations only leave via privateState. */
export class TttEquipment {
  constructor(policy, engine) {
    this.policy = policy;
    this.engine = engine;
    this.players = new Map();
    this.teleportSerial = 0;
  }
  clear() { this.players.clear(); }
  remove(id) { this.players.delete(String(id)); }
  takeover(oldId, newId) {
    const gear = this.players.get(oldId);
    if (gear) { this.players.delete(oldId); this.players.set(String(newId), gear); }
  }
  admitted(player) {
    return this.policy.phase === 'live' && player?.state === 'alive'
      && this.policy.roles.get(String(player.id)) === 'traitor';
  }
  get(player) {
    const id = String(player.id);
    if (!this.players.has(id)) this.players.set(id, { owned: [], disguised: false, radar: null, teleporter: null, teleport: null });
    return this.players.get(id);
  }
  buy(player, item) {
    if (!this.admitted(player) || !Object.hasOwn(TTT_SHOP, item)) return false;
    const def = TTT_SHOP[item], id = String(player.id), credits = this.policy.wallets.get(id) ?? 0;
    if (credits < def.price) return false;
    const gear = this.get(player);
    if (def.permanent && gear.owned.includes(item)) return false;
    if (!def.permanent && !applyPowerup(player, item)) return false;
    if (item === 'radar') gear.radar = this.scan(player);
    if (item === 'disguiser') gear.disguised = true;
    if (item === 'teleporter') gear.teleporter = { mark: null, uses: TTT_GADGET_RULES.teleportUses, readyAt: 0 };
    if (def.permanent) gear.owned.push(item);
    this.policy.wallets.set(id, credits - def.price);
    return true;
  }
  scan(player) {
    const now = this.engine.now;
    return { scannedAt: now, nextScanAt: now + TTT_GADGET_RULES.radarMs,
      contacts: [...this.engine.entities.values()]
        .filter(p => p !== player && p.state === 'alive' && this.policy.roles.has(String(p.id)))
        .map(p => ({ x: p.x, y: p.y + 1, z: p.z, ally: this.policy.roles.get(String(p.id)) === 'traitor' })) };
  }
  tick() {
    for (const [id, gear] of this.players) {
      const player = this.engine.entities.get(id);
      if (!this.admitted(player)) continue;
      if (gear.radar && this.engine.now >= gear.radar.nextScanAt) gear.radar = this.scan(player);
    }
  }
  validMark(mark, player) {
    if (!mark || ![mark.x, mark.y, mark.z].every(Number.isFinite)) return false;
    const { sx, sy, sz } = this.engine.world.dimensions;
    if (mark.x < 1 || mark.x >= sx - 1 || mark.z < 1 || mark.z >= sz - 1 || mark.y < 1 || mark.y > sy - PHYSICS.height) return false;
    if (boxCollides(this.engine.solidAt, mark.x, mark.y, mark.z)
      || !solidBelow(this.engine.solidAt, mark.x, mark.y, mark.z)) return false;
    return ![...this.engine.entities.values()].some(p => p !== player && p.state === 'alive'
      && Math.abs(p.y - mark.y) < PHYSICS.height && Math.hypot(p.x - mark.x, p.z - mark.z) < PHYSICS.halfW * 2);
  }
  action(player, action) {
    if (!this.admitted(player)) return false;
    const gear = this.players.get(String(player.id));
    if (!gear) return false;
    if (action === 'disguise-on' || action === 'disguise-off') {
      if (!gear.owned.includes('disguiser')) return false;
      gear.disguised = action === 'disguise-on';
      return true;
    }
    const tele = gear.teleporter;
    if (!tele || !player.grounded || player.vault || player.proneT > 0 || player.crouch) return false;
    if (action === 'teleport-mark') {
      const mark = { x: player.x, y: player.y, z: player.z };
      if (!this.validMark(mark, player)) return false;
      tele.mark = mark;
      return true;
    }
    if (action !== 'teleport-return' || tele.uses <= 0 || this.engine.now < tele.readyAt
      || !this.validMark(tele.mark, player)) return false;
    Object.assign(player, tele.mark, { vx: 0, vy: 0, vz: 0, vault: null, jumpGroundY: null,
      coyote: 0, jumpWasHeld: false, quickMeleeQueued: null, fireEdgeQueued: false, fireAimQueued: null });
    player.hist = [];
    player.input = null;
    tele.uses--;
    tele.readyAt = this.engine.now + TTT_GADGET_RULES.teleportCooldownMs;
    gear.teleport = { seq: ++this.teleportSerial };
    return true;
  }
  isDisguised(id) {
    return this.admitted(this.engine.entities.get(String(id))) && this.players.get(String(id))?.disguised === true;
  }
  privateState(id) {
    const player = this.engine.entities.get(String(id));
    if (!this.admitted(player)) return {};
    const gear = this.players.get(String(id));
    const now = this.engine.now;
    return {
      equipment: gear?.owned.slice() ?? [], disguised: gear?.disguised ?? false,
      radar: gear?.radar ? { ...gear.radar, contacts: gear.radar.contacts.map(p => ({ ...p })) } : null,
      teleporter: gear?.teleporter ? { ...gear.teleporter, mark: gear.teleporter.mark ? { ...gear.teleporter.mark } : null,
        cooldown: Math.max(0, Math.ceil((gear.teleporter.readyAt - now) / 1000)) } : null,
      teleport: gear?.teleport ? { ...gear.teleport } : null,
    };
  }
}
