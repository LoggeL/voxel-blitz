// Keep the camera, atmosphere and streamed detail on the same map profile.
// The full-map silhouette remains visible when adaptive detail backs off.
const LEGACY = Object.freeze({
  cameraFar: 400, fadeStart: 290, fadeEnd: 392,
  fogGroundDensity: null, fogAirDensity: null, detail: null,
});
const detail = (minRadius, initialRadius, maxRadius) => Object.freeze({ minRadius, initialRadius, maxRadius });
const FRONTIER = Object.freeze(Object.fromEntries([
  ['low', detail(6, 8, 8)],
  ['medium', detail(8, 10, 12)],
  ['high', detail(10, 12, 14)],
  ['ultra', detail(12, 14, 16)],
].map(([tier, range]) => [tier, Object.freeze({
  cameraFar: 1800, fadeStart: 1250, fadeEnd: 1760,
  fogGroundDensity: tier === 'low' ? 0.0028 : 0.002,
  fogAirDensity: tier === 'low' ? 0.001 : 0.00065,
  terrainStep: 8, silhouetteStep: 2, detail: range,
})])));

export function renderDistanceProfile(mapId, tier = 'medium') {
  return mapId === 'frontier' ? FRONTIER[tier] || FRONTIER.medium : LEGACY;
}

/** Hysteresis prevents geometry churn during short stalls or camera turns. */
export class AdaptiveChunkRange {
  constructor(profile) {
    this.profile = profile;
    this.radius = profile.initialRadius;
    this.average = null;
    this.slowSeconds = this.fastSeconds = this.cooldown = 0;
  }

  update(frameSeconds, { targetFps = 0, pendingLoads = 0, queued = 0 } = {}) {
    // A hidden tab or suspend/resume interval is not a graphics measurement.
    if (!(frameSeconds > 0) || frameSeconds > 0.25) {
      this.average = null;
      this.slowSeconds = this.fastSeconds = 0;
      return this.radius;
    }
    const budget = 1 / Math.min(60, Math.max(15, targetFps || 60));
    this.average ??= frameSeconds;
    this.average += (frameSeconds - this.average) * (1 - Math.exp(-frameSeconds * 2));
    this.cooldown = Math.max(0, this.cooldown - frameSeconds);
    this.slowSeconds = this.average > budget * 1.65 ? this.slowSeconds + frameSeconds : 0;
    this.fastSeconds = !pendingLoads && !queued && this.average < budget * 1.12
      ? this.fastSeconds + frameSeconds : 0;
    if (!this.cooldown && this.slowSeconds >= 1.5 && this.radius > this.profile.minRadius) {
      this.radius--;
      this.resetHysteresis();
    } else if (!this.cooldown && this.fastSeconds >= 8 && this.radius < this.profile.maxRadius) {
      this.radius++;
      this.resetHysteresis();
    }
    return this.radius;
  }

  resetHysteresis() {
    this.slowSeconds = this.fastSeconds = 0;
    this.cooldown = 4;
  }
}
