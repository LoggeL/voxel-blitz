// Hollin Fuel Depot in the world (docs/conquest.md "Hollin Fuel Depot"):
// presentation only, from the `map_event` notes and the decoded `ev` row.
//
//   burst    (note, one per tank) a fireball: fire, embers, sparks, black smoke
//            and debris at the tank, the heavy blast take of the bomb, a metal
//            impact and a camera shake out to 380 m
//   chain    (armed / warning) a metal groan from the structure voices
//   fire     a fire and a smoke source on every burst tank (and the canopy
//            once active) while the ground burns, from the row's time left
//   column   a stack of `smokeColumn` sources over the farm up to about 110 m
//            while the column stands (it thins out over its last seconds), so
//            it reads across the map; a joiner starts the same sources from
//            its first row
// No dedicated recording: the blasts reuse the explosion bank.
import { DEPOT_TANKS } from '../../../../shared/map-events/depot.js';
import { depotBurstTanks, depotFireLeftMs } from '../../ui/conquest/map-events/depot.js';

/** Presentation tuning (no gameplay meaning). */
export const DEPOT_FX_RULES = Object.freeze({
  shake: Object.freeze({ trauma: 1, rangeM: 380 }),
  fireball: Object.freeze({ fire: 70, ember: 50, spark: 36, smoke: 26, debris: 46 }),
  fire: Object.freeze({ rate: 36, scale: 3.2, jitter: 4, smokeRate: 5 }),
  column: Object.freeze({ levels: 5, stepM: 22, rate: 6, scale: 2.4, grow: 0.7, stopLeftMs: 9000 }),
});

const tankPos = (tank, lift = 4) => [tank.x, tank.y0 + lift, tank.z];

export const DEPOT_FX = Object.freeze({
  onEvent(ev, kit) {
    const anchor = Array.isArray(ev.pos) ? ev.pos : kit.anchor('depot');
    if (ev.note === 'burst') {
      const tank = DEPOT_TANKS[ev.data?.tank | 0];
      const at = tank ? tankPos(tank) : anchor;
      if (!at) return true;
      const n = DEPOT_FX_RULES.fireball;
      kit.puff('fire', at, { count: n.fire, scale: 5.5, speed: 4.5, life: 2.4 });
      kit.puff('fire', [at[0], at[1] + 6, at[2]], { count: n.fire / 2, scale: 7, speed: 3, life: 2 });
      kit.puff('ember', at, { count: n.ember, speed: 3, life: 2.5 });
      kit.puff('spark', at, { count: n.spark, speed: 1.4 });
      kit.puff('smoke', [at[0], at[1] + 3, at[2]], { count: n.smoke, scale: 4, speed: 2.5, color: [0.06, 0.055, 0.05] });
      kit.puff('debris', at, { count: n.debris, speed: 1.6, scale: 2.5 });
      kit.shake(at, DEPOT_FX_RULES.shake.trauma, DEPOT_FX_RULES.shake.rangeM);
      kit.sound.blast(at, 'bomb');
      kit.sound.impact(at, { n: 420, speed: 14, material: 'metal' });
      return true;
    }
    if (!ev.note && (ev.phase === 'armed' || ev.phase === 'warning') && anchor) {
      kit.sound.creak(anchor, { n: 320, material: 'metal', seconds: 1.4 });
      kit.shake(anchor, 0.2, 160);
    }
    // The bursts carry the strike; no generic dust ring.
    return true;
  },

  sync(event, kit) {
    const T = event.def.tuning, a = event.anchor;
    // Burning ground on every burst tank (and under the canopy once active).
    const fireLeft = depotFireLeftMs(event);
    const fires = fireLeft > 0 ? depotBurstTanks(event).map(t => ({ key: `depot:fire:${t.id}`, at: tankPos(t, 0.6) })) : [];
    if (fireLeft > 0 && event.phase === 'active') fires.push({ key: 'depot:fire:canopy', at: [T.fire.canopy.x, a.y - 1.4, T.fire.canopy.z] });
    const want = new Set();
    const F = DEPOT_FX_RULES.fire;
    for (const f of fires) {
      want.add(f.key); want.add(`${f.key}:smoke`);
      if (kit.emitters.has(f.key)) continue;
      kit.emitter(f.key, { kind: 'fire', pos: f.at, rate: F.rate, params: { scale: F.scale, speed: 1.4, life: 1.3, jitter: F.jitter, dir: [0, 1, 0] } });
      kit.emitter(`${f.key}:smoke`, { kind: 'smoke', pos: [f.at[0], f.at[1] + 2.5, f.at[2]], rate: F.smokeRate,
        params: { scale: 2.6, speed: 1.5, jitter: F.jitter, color0: [0.07, 0.065, 0.06], color1: [0.2, 0.19, 0.18] } });
    }
    // The column over the farm while it stands, stopped a few seconds before it ends so the last puffs drift off.
    const C = DEPOT_FX_RULES.column;
    if (event.phase === 'active' && a && (event.leftMs ?? 0) > C.stopLeftMs) {
      for (let k = 0; k < C.levels; k++) {
        const key = `depot:column:${k}`;
        want.add(key);
        if (kit.emitters.has(key)) continue;
        kit.emitter(key, { kind: 'smokeColumn', pos: [a.x, a.y + 4 + k * C.stepM, a.z], rate: C.rate,
          params: { scale: C.scale + k * C.grow, alpha: 0.95, speed: 1.1, jitter: T.column.radius * 0.55, dir: [0, 1, 0],
            color0: [0.05, 0.047, 0.045], color1: [0.16, 0.155, 0.15] } });
      }
    }
    for (const key of [...kit.emitters.keys()]) if (key.startsWith('depot:') && !want.has(key)) kit.stopEmitter(key);
  },
});
