// Shared thermal state: heat survives holstering; only a fresh life resets it.
export const MINIGUN = Object.freeze({ spinUp: 0.7, spinDown: 1.2, heatPerShot: 0.0135, sweetHeatGainMult: 0.6,
  cooling: 0.2, unlockHeat: 0.3, sweetHeat: 0.65, maxDamageBonus: 0.30 });
export function createMinigunState() { return { heat: 0, spin: 0, overheated: false }; }
export function stepMinigun(state, dt, held, preSpin = false) {
  dt = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const driving = (held || preSpin) && !state.overheated;
  // Cool for the portion of this step spent winding up, even when this frame
  // crosses full speed. Otherwise heat depends on the rendering frame rate.
  // Holding aim keeps the rotor ready, but only live fire prevents cooling.
  const coolingDt = driving && held ? Math.min(dt, (1 - state.spin) * MINIGUN.spinUp) : dt;
  state.spin = Math.max(0, Math.min(1, state.spin + dt * (driving ? 1 / MINIGUN.spinUp : -1 / MINIGUN.spinDown)));
  state.heat = Math.max(0, state.heat - MINIGUN.cooling * coolingDt);
  if (state.overheated && state.heat <= MINIGUN.unlockHeat) state.overheated = false;
  return held && driving && !state.overheated && state.spin >= 1;
}
export function minigunDamageMult(state) {
  return 1 + MINIGUN.maxDamageBonus * Math.min(1, state.heat / MINIGUN.sweetHeat);
}
export function heatMinigun(state) {
  // Keep the full-damage window forgiving without delaying the initial warm-up.
  const gain = MINIGUN.heatPerShot * (state.heat >= MINIGUN.sweetHeat ? MINIGUN.sweetHeatGainMult : 1);
  state.heat = Math.min(1, state.heat + gain);
  if (state.heat >= 1) { state.overheated = true; state.spin = 0; }
}
