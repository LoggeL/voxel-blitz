// Conquest weather for bots (docs/conquest.md, *Weather*): the current
// weather's `vision` and `recognition` multipliers as observeBotTarget /
// observeBotVehicle options, and its `lock` multiplier for the STINGER engage
// range. Outside Conquest (no weather) every scale is 1 and options pass
// through untouched.

const CALM = Object.freeze({ vision: 1, recognition: 1, lock: 1 });
/** effects object -> frozen sight options without a base (one per weather change). */
const SIGHT = new WeakMap();

/** `{ vision, recognition, lock }` of the game's current weather. */
export function botWeather(game) {
  const fx = game?.mode?.weatherEffects?.();
  return fx && typeof fx === 'object' ? fx : CALM;
}

/**
 * Perception options with the weather's sight scales: `visionScale` (× the
 * sight range) and `recognitionScale` (× the detection rate). A calm sky
 * returns `options` as given.
 */
export function weatherSight(game, options = null) {
  const fx = botWeather(game);
  if (fx === CALM || (fx.vision === 1 && fx.recognition === 1)) return options;
  if (!options) {
    let cached = SIGHT.get(fx);
    if (!cached) SIGHT.set(fx, cached = Object.freeze({ visionScale: fx.vision, recognitionScale: fx.recognition }));
    return cached;
  }
  return { ...options, visionScale: fx.vision, recognitionScale: fx.recognition };
}

/** × applied to lock-range engage distances (STINGER) under the current weather. */
export function weatherLockScale(game) {
  const lock = botWeather(game).lock;
  return Number.isFinite(lock) && lock > 0 ? lock : 1;
}
