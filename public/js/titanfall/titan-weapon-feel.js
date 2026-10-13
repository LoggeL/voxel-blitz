// Titan primary weapon feel (docs/titanfall.md §5.4 "Feel", §7.3): what an authoritative titan
// `shoot` event does to the viewer beyond the muzzle FX (vehicle-fx.js) and the report
// (vehicle-audio.js). titan-presentation.js calls applyShotFeel() for every primary shot:
//   - camera shake: the shot holds the shake bus at least at its trauma (never stacks past it, so
//     the Predator's 17 rounds a second keep a steady rumble instead of saturating the bus);
//     nearby viewers of the heavy shots get a share by distance
//   - FOV punch: an impulse on the camera's FOV that the vehicle camera's own easing takes back
//   - cockpit kick: the cabin view model is thrown back on a damped spring (titan-cockpit.js
//     kick()); the camera itself never moves, so the crosshair ray the server converges on
//     stays where the pilot aims
//   - the glass reticle blooms for the shot (titan-cockpit-hud.js)
// Presentation only: every number here is feel, none of it reaches the server.

/** Per weapon: shake trauma (own shot), FOV punch (degrees), cabin kick peaks (radians, metres). */
export const TITAN_WEAPON_FEEL = Object.freeze({
  // ION: a crisp tick per round; the ADS split is a fatter, wider shove.
  splitter: Object.freeze({ trauma: 0.22, fov: 0.4, cabin: Object.freeze({ pitch: 0.006, yaw: 0.002, roll: 0.003, push: 0.012 }), bloom: 0.35 }),
  splitterSplit: Object.freeze({ trauma: 0.3, fov: 0.9, cabin: Object.freeze({ pitch: 0.011, yaw: 0.003, roll: 0.004, push: 0.022 }), bloom: 0.6 }),
  // SCORCH: one heavy thump with a roll as the launcher bucks.
  t203: Object.freeze({ trauma: 0.42, fov: 2.2, cabin: Object.freeze({ pitch: 0.022, yaw: 0.004, roll: 0.008, push: 0.045 }), bloom: 0.8 }),
  // NORTHSTAR: scales with the charge the shot left at (event.charge); a full charge is the hardest hit in the game.
  railgun: Object.freeze({ trauma: 0.62, fov: 4, cabin: Object.freeze({ pitch: 0.035, yaw: 0.004, roll: 0.006, push: 0.07 }), bloom: 1, minCharge: 0.3 }),
  // RONIN: a shotgun shove, more roll than the T-203.
  leadwall: Object.freeze({ trauma: 0.48, fov: 2.8, cabin: Object.freeze({ pitch: 0.026, yaw: 0.006, roll: 0.01, push: 0.055 }), bloom: 0.9 }),
  // LEGION: small per-round kicks that the spring turns into a sustained rattle; the yaw alternates per round.
  predatorClose: Object.freeze({ trauma: 0.27, fov: 0.15, cabin: Object.freeze({ pitch: 0.004, yaw: 0.003, roll: 0.002, push: 0.008 }), bloom: 0.25, alternate: true }),
  predatorLong: Object.freeze({ trauma: 0.24, fov: 0.2, cabin: Object.freeze({ pitch: 0.005, yaw: 0.002, roll: 0.002, push: 0.01 }), bloom: 0.3, alternate: true }),
});

/** Viewers outside the hull: heavy shots shake them out to `range` m (share of the trauma at 0 m). */
export const TITAN_FEEL_NEAR = Object.freeze({ range: 24, share: 0.55, heavy: Object.freeze(['t203', 'railgun', 'leadwall']) });
/** The chase view keeps this share of the FOV punch; the punch never takes the FOV more than `maxFov` past where it was. */
export const TITAN_FEEL_VIEW = Object.freeze({ chaseFov: 0.6, maxFov: 6 });

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp01 = value => Math.max(0, Math.min(1, finite(value)));

/**
 * The feel of one primary shot: { key, trauma, fov, cabin, bloom } for weapon `weapon`
 * (the event's vehicleWeapon). `split`: an ION split shot (several paths); `charge`: the
 * railgun's event charge (0..1). Null for anything that is not a titan primary.
 */
export function shotFeel(weapon, { split = false, charge = 1 } = {}) {
  const key = weapon === 'splitter' && split ? 'splitterSplit' : weapon;
  const base = TITAN_WEAPON_FEEL[key];
  if (!base || key === 'titanMelee') return null;
  const k = weapon === 'railgun' ? base.minCharge + (1 - base.minCharge) * clamp01(charge) : 1;
  const cabin = base.cabin;
  return {
    key, trauma: base.trauma * (weapon === 'railgun' ? 0.4 + 0.6 * k : 1), fov: base.fov * k * k, bloom: base.bloom * k,
    cabin: { pitch: cabin.pitch * k, yaw: cabin.yaw * k, roll: cabin.roll * k, push: cabin.push * k }, alternate: !!base.alternate,
  };
}

/** Raise the shake bus to `trauma` (never past it): a burst holds a level instead of saturating the bus. */
export function holdShake(shake, trauma) {
  if (!shake?.add || !(trauma > 0)) return 0;
  const now = finite(shake.trauma);
  return now < trauma ? shake.add(trauma - now) : now;
}

let alternate = 1;
/**
 * Apply a shot's feel. ctx: { self (the own titan fired), distance (m from the camera, others' shots),
 * shake (CameraShake), camera (PerspectiveCamera), cockpit (the shown titan cockpit or null),
 * chase (own titan seen from the chase camera) }. Returns what was applied (tests).
 */
export function applyShotFeel(feel, { self = false, distance = Infinity, shake = null, camera = null, cockpit = null, chase = false } = {}) {
  const out = { trauma: 0, fov: 0, kicked: false };
  if (!feel) return out;
  if (!self) {
    const weapon = feel.key === 'splitterSplit' ? 'splitter' : feel.key;
    if (!TITAN_FEEL_NEAR.heavy.includes(weapon) || !(distance < TITAN_FEEL_NEAR.range)) return out;
    const fall = 1 - distance / TITAN_FEEL_NEAR.range;
    out.trauma = feel.trauma * TITAN_FEEL_NEAR.share * fall;
    holdShake(shake, out.trauma);
    return out;
  }
  out.trauma = feel.trauma;
  holdShake(shake, out.trauma);
  if (camera?.isPerspectiveCamera && feel.fov > 0) {
    const punch = feel.fov * (chase ? TITAN_FEEL_VIEW.chaseFov : 1);
    // A burst's punches add up only to maxFov over the FOV the camera eased back to.
    const base = camera.userData.titanFeelBase;
    const rest = Number.isFinite(base) && camera.fov > base ? base : camera.fov;
    camera.userData.titanFeelBase = rest;
    const next = Math.min(rest + TITAN_FEEL_VIEW.maxFov, camera.fov + punch);
    out.fov = next - camera.fov;
    if (out.fov > 0) { camera.fov = next; camera.updateProjectionMatrix?.(); }
  }
  if (cockpit && !chase) {
    const side = feel.alternate ? (alternate = -alternate) : (Math.random() < 0.5 ? -1 : 1);
    const cabin = feel.cabin;
    out.kicked = !!cockpit.kick?.({ pitch: cabin.pitch, yaw: cabin.yaw * side, roll: cabin.roll * -side, push: cabin.push }, feel.bloom);
  }
  return out;
}
