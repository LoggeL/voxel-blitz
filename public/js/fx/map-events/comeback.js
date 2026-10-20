/**
 * Comeback call-in in the world (docs/conquest.md "Comeback call-in"):
 * presentation only, from the snapshot's `ev` row (target anchor, [kind,
 * heading], the phase clock) and the `map_event` events.
 *
 *   telegraph  a red smoke column on the target through the warning (and the
 *              strike); the objective cues play the alarm stinger
 *   bomber     a visual-only jet (the strike jet's voxel model, no hull)
 *              crossing the target on the plan's line at the release height,
 *              timed so it passes each release point as the server drops that
 *              bomb; the recorded jet flyby lands on its pass over the target
 *   strike     the rounds themselves are ordinary server projectiles (jet
 *              bombs, mortar-type shells): their fall, whistle, blast and
 *              crater come from the projectile and vehicle effects
 *
 * A joiner mid-telegraph or mid-run gets the smoke and the jet from the same
 * row (`sync` with `fresh`). There is no siren recording: the alarm stinger
 * and the shells' own whistles carry the warning.
 */
import { VEHICLE_WEAPON_META } from '../../../../shared/conquest-contract.js';
import { COMEBACK_TUNING, comebackZoneOf } from '../../../../shared/map-events/comeback.js';
import { makePlaneModel } from '../../vehicles/models/plane.js';

const SMOKE_KEY = 'comeback:smoke';
const LIVE = new Set(['warning', 'active']);
const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** The strike clock of a decoded row: client ms at which the warning ends (the first impacts start then). */
function strikeStart(event, plan, now) {
  if (event.phase === 'warning') return now + (event.leftMs ?? 0);
  return now - Math.max(0, plan.activeMs - (event.leftMs ?? plan.activeMs));
}

/** The visual jet's pass: release line start, direction, speed, height and its visible window (ms on the strike clock). */
export function bomberPass(plan, groundY, tuning = COMEBACK_TUNING) {
  const t = tuning.bomber, g = VEHICLE_WEAPON_META[t.weapon]?.gravity ?? 9.8;
  const fall = Math.sqrt(2 * t.altitude / g) * 1000;
  const first = plan.drops[0], last = plan.drops.at(-1);
  // The jet is over drop i's release point at drop.atMs - fall, `speed * fall` short of the impact.
  const back = t.speed * fall / 1000;
  const start = { x: first.x - plan.dir.x * back, z: first.z - plan.dir.z * back };
  const lead = t.approachM / t.speed * 1000;
  return { start, dir: plan.dir, speed: t.speed, y: groundY + t.altitude, t0: first.atMs - fall, from: first.atMs - fall - lead,
    until: last.atMs - fall + lead, passTarget: (first.atMs + last.atMs) / 2 - fall };
}

export const COMEBACK_FX = {
  jet: null,
  key: null,

  sync(event, kit, { fresh } = {}) {
    const now = clock();
    // Past the strike the smoke goes; a jet still on its run flies out its window (update drops it).
    if (!LIVE.has(event.phase) || !event.anchor) { kit.stopEmitter(SMOKE_KEY); this.key = null; return; }
    const plan = comebackZoneOf(event);
    if (!plan) return;
    const at = [event.anchor.x, Number.isFinite(event.anchor.y) ? event.anchor.y : 30, event.anchor.z];
    const key = `${event.extra?.[0]}:${Math.round(at[0])}:${Math.round(at[2])}`;
    if (key !== this.key || fresh) {
      this.key = key;
      const t = COMEBACK_TUNING.smoke;
      kit.emitter(SMOKE_KEY, { kind: 'smoke', pos: [at[0], at[1] + 0.4, at[2]], rate: t.rate,
        params: { dir: [0, 1, 0], speed: 1.4, spread: 0.35, scale: 1.7, life: 2.4, color0: t.color, color1: t.color.map(v => v * 0.55) } });
      this._dropJet(kit);
      if (plan.kind === 'bomber') {
        const start = strikeStart(event, plan, now);
        const pass = bomberPass(plan, at[1]);
        this.jet = { pass, start, model: null };
        // The recorded flyby peaks as the jet crosses the target.
        kit.audio?.jetFlyby?.([at[0], pass.y, at[2]], { delay: Math.max(0, (start + pass.passTarget - now) / 1000) });
      }
    }
    // Keep the strike clock honest against the row (a 100 ms quantised countdown never drifts the jet more than that).
    if (this.jet && event.phase === 'warning') this.jet.start = Math.min(this.jet.start, strikeStart(event, plan, now) + 100);
  },

  onEvent(ev, kit) {
    // The impacts' blasts are the projectiles' own: no generic strike burst on top.
    if (ev.event === 'comeback' && ev.phase === 'active') return true;
    if (ev.event === 'comeback' && (ev.phase === 'cooldown' || ev.phase === 'done' || ev.phase === 'idle')) { kit.stopEmitter(SMOKE_KEY); this.key = null; }
    return false;
  },

  update(dt, kit) {
    const jet = this.jet;
    if (!jet) return;
    const t = clock() - jet.start, pass = jet.pass;
    if (t < pass.from) return;
    if (t > pass.until) { this._dropJet(kit); return; }
    if (!jet.model) {
      const scene = kit.scene ?? kit.camera()?.parent ?? null;
      if (!scene) return;
      jet.model = makePlaneModel({ team: 'neutral' });
      jet.model.group.rotation.y = -Math.atan2(pass.dir.x, -pass.dir.z);
      scene.add(jet.model.group);
      jet.scene = scene;
    }
    const s = pass.speed * (t - pass.t0) / 1000;
    jet.model.group.position.set(pass.start.x + pass.dir.x * s, pass.y, pass.start.z + pass.dir.z * s);
    jet.model.animate?.(dt, { grounded: false });
  },

  _dropJet() {
    const jet = this.jet;
    // The voxel parts are the plane's shared blueprint (real hulls use them too): remove, never dispose.
    if (jet?.model) jet.scene?.remove?.(jet.model.group);
    this.jet = null;
  },

  end(kit) { this._dropJet(kit); this.key = null; },
  clear(kit) { this._dropJet(kit); this.key = null; },
};
