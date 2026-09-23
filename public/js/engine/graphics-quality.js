// Graphics quality tiers. A tier only ever changes at map load: every knob
// below either allocates render targets or changes shader program keys, and a
// mid-match switch would recompile every material while players are fighting.
// `auto` stays conservative (touch and low-memory devices get LOW) because the
// browser exposes no reliable GPU timing to promote from.

export const GRAPHICS_PREF_KEY = 'vb-graphics-quality';

export const GRAPHICS_TIERS = Object.freeze([
  { value: 'auto', label: 'AUTO' },
  { value: 'low', label: 'LOW' },
  { value: 'medium', label: 'MEDIUM' },
  { value: 'high', label: 'HIGH' },
  { value: 'ultra', label: 'ULTRA' },
]);

/**
 * Per-tier knobs. renderScale caps the scene pixel ratio (the device ratio
 * still bounds it); ultra renders at the device ratio for integer-exact
 * texels on HiDPI screens.
 */
export const GRAPHICS_PROFILES = Object.freeze({
  low: Object.freeze({
    tier: 'low', renderScale: 1, msaa: 0, hdr: false, bloomLevels: 0, ibl: false,
    anisotropy: 4, edgeShading: false, normalMaps: false, grassDensity: 0,
    ambientParticles: 250, shadowMapSize: 0, ssao: false,
  }),
  medium: Object.freeze({
    tier: 'medium', renderScale: 1, msaa: 2, hdr: true, bloomLevels: 3, ibl: true,
    anisotropy: 4, edgeShading: true, normalMaps: false, grassDensity: 0.45,
    ambientParticles: 600, shadowMapSize: 0, ssao: false,
  }),
  high: Object.freeze({
    tier: 'high', renderScale: 1.35, msaa: 4, hdr: true, bloomLevels: 5, ibl: true,
    anisotropy: 8, edgeShading: true, normalMaps: true, grassDensity: 1,
    ambientParticles: 1200, shadowMapSize: 2048, ssao: false,
  }),
  ultra: Object.freeze({
    tier: 'ultra', renderScale: 2, msaa: 4, hdr: true, bloomLevels: 5, ibl: true,
    anisotropy: 16, edgeShading: true, normalMaps: true, grassDensity: 1,
    ambientParticles: 1500, shadowMapSize: 4096, ssao: true,
  }),
});

export function normalizeGraphicsQuality(value) {
  return GRAPHICS_TIERS.some(tier => tier.value === value) ? value : 'auto';
}

let preference = 'auto';
try { preference = normalizeGraphicsQuality(localStorage.getItem(GRAPHICS_PREF_KEY)); } catch {}

export function graphicsQuality() { return preference; }

export function setGraphicsQuality(value) {
  preference = normalizeGraphicsQuality(value);
  try { localStorage.setItem(GRAPHICS_PREF_KEY, preference); } catch {}
  return preference;
}

/** Tier `auto` resolves to for this device. */
export function autoGraphicsTier({ touch = false, deviceMemory } = {}) {
  if (touch) return 'low';
  if (Number.isFinite(deviceMemory) && deviceMemory <= 4) return 'low';
  if (Number.isFinite(deviceMemory) && deviceMemory >= 8) return 'high';
  return 'medium';
}

/**
 * Resolve a preference into concrete knobs for this device. Capability
 * facts clamp the tier: no MSAA without multisampled targets, no HDR target
 * without renderable half floats, and never MSAA on touch devices, whose
 * multisampled depth resolve is unreliable.
 */
export function resolveGraphicsProfile(value = preference, env = {}) {
  const pref = normalizeGraphicsQuality(value);
  const tier = pref === 'auto' ? autoGraphicsTier(env) : pref;
  const base = GRAPHICS_PROFILES[tier];
  const maxSamples = Number.isFinite(env.maxSamples) ? env.maxSamples : 0;
  const msaa = env.touch ? 0 : Math.min(base.msaa, maxSamples);
  const hdr = base.hdr && env.halfFloat === true;
  return Object.freeze({
    ...base,
    preference: pref,
    msaa,
    hdr,
    bloomLevels: hdr ? base.bloomLevels : 0,
    anisotropy: Math.min(base.anisotropy, Number.isFinite(env.maxAnisotropy) ? env.maxAnisotropy : base.anisotropy),
  });
}

/** Capability facts resolveGraphicsProfile reads from a live WebGLRenderer. */
export function rendererCapabilities(renderer) {
  const caps = renderer?.capabilities;
  const has = (name) => renderer?.extensions?.has?.(name) === true;
  return {
    maxSamples: Number(caps?.maxSamples) || 0,
    maxAnisotropy: typeof caps?.getMaxAnisotropy === 'function' ? caps.getMaxAnisotropy() : 1,
    halfFloat: has('EXT_color_buffer_float') || has('EXT_color_buffer_half_float'),
  };
}

export function isTouchDevice() {
  if (typeof matchMedia !== 'function') return false;
  try { return matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches; } catch { return false; }
}
