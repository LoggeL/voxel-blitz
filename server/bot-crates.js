// Conquest bots and the supply crates (docs/conquest.md "Infantry supply"):
// a Support (AMMO CRATE) or Medic (MEDICAL CRATE) bot with no enemy in sight
// places its crate inside a flag it holds or defends, or where at least
// botMinMates teammates stand within botMateRadius m, through the human
// `crate` intent. At most one placement per botPlaceMs per bot; a crate that
// already stands near keeps its place. Tuning lives in SUPPLY_CRATE_RULES.

import { kitCrate } from '../shared/conquest-kits.js';
import { SUPPLY_CRATE_RULES } from '../shared/supply-crates.js';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class BotCrates {
  constructor(game) { this.game = game; }

  get policy() { return this.game.mode?.policy ?? null; }
  _team(p) { return this.game.mode?.teamFor?.(p) ?? p.team; }

  /** The crate kind a bot carries, or null. */
  kindOf(p) {
    const roles = this.policy?.roles;
    return roles ? kitCrate(roles.kitOf?.(p) ?? 'assault', roles.gadgetOf?.(p) ?? 0) : null;
  }

  /** Why here is a good spot: 'flag' (inside a held or defended flag), 'mates', or null. */
  spotReason(p, goal) {
    const r = SUPPLY_CRATE_RULES, team = this._team(p);
    const flag = goal?.target;
    if (flag && Number.isFinite(flag.x) && Number.isFinite(flag.radius) && flat(p, flag) <= flag.radius
        && (flag.owner === team || goal.stance === 'defend')) return 'flag';
    let mates = 0;
    for (const e of this.game.entities.values()) {
      if (e === p || e.state !== 'alive' || e.npcRole || e.vehicleId || !Number.isFinite(e.x) || this._team(e) !== team) continue;
      if (flat(e, p) <= r.botMateRadius && ++mates >= r.botMinMates) return 'mates';
    }
    return null;
  }

  /** Crate use with no enemy in sight (the caller checks): returns the placed crate or null. */
  use(br, p, goal, now) {
    const crates = this.policy?.supplyCrates;
    if (!crates || p.vehicleId || !p.grounded || now < (br.crateCheckAt ?? 0)) return null;
    br.crateCheckAt = now + SUPPLY_CRATE_RULES.botCheckMs;
    if (now < (br.cratePlacedAt ?? -Infinity) + SUPPLY_CRATE_RULES.botPlaceMs || !this.kindOf(p)) return null;
    const own = crates.crateOf(p.id);
    if (own && !Number.isFinite(own.expiresAt) && flat(own, p) <= SUPPLY_CRATE_RULES.botKeepRange) return null;
    if (!this.spotReason(p, goal)) return null;
    if (this.game.mode.conquestIntent?.(p, { type: 'crate' }) !== true) return null;
    br.cratePlacedAt = now;
    return crates.crateOf(p.id);
  }
}
