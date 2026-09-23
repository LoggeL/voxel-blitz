import {
  GRAPHICS_PROFILES, GRAPHICS_TIERS, autoGraphicsTier, graphicsQuality, isTouchDevice, resolveGraphicsProfile,
  setGraphicsQuality,
} from '../engine/graphics-quality.js';
import { el } from './hud-support.js';

const TIER_LABELS = Object.freeze(Object.fromEntries(GRAPHICS_TIERS.map(tier => [tier.value, tier.label])));

/** Device facts `auto` reads; capability clamps (MSAA, HDR) only apply once a renderer exists. */
export function graphicsDeviceFacts() {
  const memory = Number(globalThis.navigator?.deviceMemory);
  return { touch: isTouchDevice(), deviceMemory: Number.isFinite(memory) ? memory : undefined };
}

/**
 * One-line feature list of a concrete tier, resolved for this device the way
 * a match will resolve it (touch never multisamples). GPU limits are unknown
 * before a renderer exists, so a capable desktop GPU is assumed.
 */
export function describeGraphicsTier(tier, facts = {}) {
  if (!GRAPHICS_PROFILES[tier]) return '';
  const profile = resolveGraphicsProfile(tier, { touch: !!facts.touch, maxSamples: 16, halfFloat: true });
  const parts = [
    profile.msaa ? `${profile.msaa}× MSAA` : 'FXAA',
    profile.hdr ? (profile.bloomLevels ? 'HDR bloom' : 'HDR') : 'no bloom',
    profile.ibl ? 'reflections' : 'no reflections',
    profile.shadowMapSize ? `sun shadows ${profile.shadowMapSize}px` : 'baked shadows only',
  ];
  if (profile.ssao) parts.push('ambient occlusion');
  if (profile.normalMaps) parts.push('normal maps');
  parts.push(`up to ${profile.renderScale}× pixel ratio`);
  return parts.join(' · ');
}

/**
 * Text the settings card shows for a preference: the tier it resolves to on
 * this device (AUTO names its pick) and that the change waits for a map load.
 */
export function graphicsSettingsSummary(preference, facts = {}) {
  const autoTier = autoGraphicsTier(facts);
  const tier = preference === 'auto' ? autoTier : preference;
  const limits = facts.touch
    ? 'MSAA is off on touch devices; HDR switches off where the GPU lacks it.'
    : 'MSAA and HDR switch off where the GPU lacks them.';
  return {
    tier,
    autoTier,
    badge: preference === 'auto' ? `→ ${TIER_LABELS[autoTier]}` : '',
    help: `AUTO picks ${TIER_LABELS[autoTier]} on this device. ${TIER_LABELS[tier]}: ${describeGraphicsTier(tier, facts)}. `
      + `Changes apply when the next map loads. ${limits}`,
  };
}

/** Graphics quality select for the DISPLAY settings group. */
export class GraphicsSettings {
  mount(parent) {
    this.root = el('section', 'vb-frame-settings vb-graphics-settings', parent);
    this.root.setAttribute('aria-label', 'Graphics quality');
    const row = el('div', 'vb-setting-row', this.root);
    const header = el('div', 'vb-setting-header', row);
    const label = el('label', 'vb-label', header);
    label.textContent = 'GRAPHICS QUALITY';
    label.htmlFor = 'settings-graphics-quality';
    this.badge = el('span', 'vb-setting-val', header, 'settings-graphics-quality-hint');
    this.select = el('select', 'vb-select', row, 'settings-graphics-quality');
    this.select.setAttribute('aria-describedby', 'settings-graphics-help');
    for (const tier of GRAPHICS_TIERS) {
      const option = el('option', '', this.select);
      option.value = tier.value;
      option.textContent = tier.label;
    }
    this.help = el('p', 'vb-frame-help', this.root, 'settings-graphics-help');
    this.select.addEventListener('change', () => {
      setGraphicsQuality(this.select.value);
      this.update();
    });
    this.update();
    return this.root;
  }

  update() {
    if (!this.root) return;
    const preference = graphicsQuality();
    this.select.value = preference;
    const summary = graphicsSettingsSummary(preference, graphicsDeviceFacts());
    this.badge.textContent = summary.badge;
    this.help.textContent = summary.help;
    this.root.dataset.tier = summary.tier;
  }
}
