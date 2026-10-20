// Conquest dynamic weather, presented (docs/conquest.md, *Weather*; tiers in
// docs/graphics.md). The server sends the weather mix as `match.conquest.wx`
// (shared/conquest-weather.js); this view eases toward it and blends the
// Frontier mood presets (map-atmosphere.js golden / overcast / mist / storm)
// over the live world, uniform-only, so no program key ever changes mid-match:
//
//  - sky dome (colours, haze, glow, cloud layer, overcast deck, sun disc),
//    fog colour and density (fogScale, read by main.js), hemisphere and sun
//    light, image-based light, post grade, voxel-light min sky and shadow
//    strength, water palette and the backdrop's air fog share;
//  - rain: a second ambience field (map-ambience.js `rain` streaks, sized by
//    the tier's ambient particle budget, faded indoors through the voxel sky
//    light), alpha and draw range by the rain, slanted by the wind;
//  - wet ground: TERRAIN_WET (chunks.js) from the server's wetness, the far
//    terrain darkened to match;
//  - lightning: each `weather_strike` flashes hemisphere, deck and exposure
//    and draws one jagged bolt (one additive draw), and hands the thunder to
//    the soundscape (onThunder), which delays it by distance.
//
// The view starts at the load mood (worldview.palette) and never touches the
// baked pieces (voxel sun direction, backdrop vertex colours, environment map).

import * as THREE from '../vendor/three.module.js';
import { WEATHER_IDS } from '../../../shared/conquest-weather.js';
import { mapAtmosphere } from './map-atmosphere.js';
import { buildMapAmbience } from './map-ambience.js';
import { TERRAIN_WET } from './chunks.js';
import { resolveGrade } from './combat-post-process.js';
import { applyWaterPalette } from './fluid-material.js';

/** Presentation tuning (no gameplay): easing, flash shape, bolt and rain. */
export const WEATHER_VIEW = Object.freeze({
  // Seconds to ease 63 % of the way to a new server mix (hides the 1 % blend steps).
  ease: 1.6,
  // Ambient motes of the load mood (pollen) per state: they thin out under cloud and vanish in rain.
  motes: Object.freeze({ golden: 1, overcast: 0.55, mist: 0.3, storm: 0 }),
  // Rain streaks: wind slant at full wind (m/s) and the share of the field drawn at full rain.
  rainSlant: 5.5, rainDraw: 1.25,
  // Wet ground: far terrain darkening at full wetness (near terrain: chunks.js TERRAIN_WET).
  farWetDim: 0.24,
  flash: Object.freeze({ hemi: 1.25, deck: 0.7, glow: 0.55, exposure: 0.26, near: 260, far: 1400, farLevel: 0.3,
    seconds: 0.62, bolt: 0.24 }),
  bolt: Object.freeze({ top: 190, segments: 14, jitter: 9, width: 1.4, branch: 0.45 }),
});

const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const color = value => new THREE.Color(value);

/** Numeric look of one mood preset (map-atmosphere.js palette), every colour linear. */
export function weatherLook(palette) {
  const top = color(palette.skyTop), horizon = color(palette.skyHorizon);
  const grade = resolveGrade(palette.grade || {});
  const deck = color(palette.deckColor || palette.cloud || '#ffffff');
  return {
    skyTop: top, skyHorizon: horizon,
    // A preset without a mid stop gets the two-stop gradient's colour there, so midAt can stay on.
    skyMid: palette.skyMid ? color(palette.skyMid) : horizon.clone().lerp(top, 0.3),
    skyHaze: palette.skyHaze ?? 0,
    glowColor: color(palette.horizonGlow || palette.skyHorizon), glow: palette.horizonGlow ? palette.horizonGlowStrength ?? 0.2 : 0,
    sunGlow: palette.sunGlow ?? 0, overcast: palette.overcast ?? 0, deckColor: deck,
    cloudCover: palette.cloudLayer?.cover ?? 0,
    cloudLit: color(palette.cloudLayer?.lit || palette.cloud || '#ffffff'), cloudShade: color(palette.cloudLayer?.shade || deck),
    sunDisc: palette.sunDisc ?? 1,
    fog: color(palette.fog), fogScale: Number.isFinite(palette.fogScale) ? palette.fogScale : 1,
    airFogScale: Number.isFinite(palette.airFogScale) ? palette.airFogScale : Number.isFinite(palette.fogScale) ? palette.fogScale : 1,
    skyLight: color(palette.skyLight), groundLight: color(palette.groundLight), ambient: palette.ambient,
    sun: color(palette.sun), sunlight: palette.sunlight, envIntensity: palette.envIntensity ?? 0.45,
    exposure: grade.exposure, saturation: grade.saturation, contrast: grade.contrast,
    shadowTint: new THREE.Vector3(...grade.shadowTint), highlightTint: new THREE.Vector3(...grade.highlightTint),
    minSky: palette.light?.minSky ?? 0.5, shadow: palette.light?.shadow ?? 0.75,
    water: { skyTop: top, skyHorizon: horizon, reflection: palette.water?.reflection ?? 0.5, shallow: color(palette.water?.shallow || '#2f4a55'),
      deep: color(palette.water?.deep || '#132a33'), tile: palette.water?.tile ?? 0.25, specular: palette.water?.specular ?? 1 },
    airFog: palette.backdrop?.air?.fog ?? 0.2,
  };
}

const COLOR_KEYS = ['skyTop', 'skyHorizon', 'skyMid', 'glowColor', 'deckColor', 'cloudLit', 'cloudShade', 'fog', 'skyLight', 'groundLight', 'sun'];
const NUMBER_KEYS = ['skyHaze', 'glow', 'sunGlow', 'overcast', 'cloudCover', 'sunDisc', 'fogScale', 'airFogScale', 'ambient', 'sunlight',
  'envIntensity', 'exposure', 'saturation', 'contrast', 'minSky', 'shadow', 'airFog'];

/** Weighted sum of looks into `out` (weights: one per look, summing to 1). */
export function blendLooks(looks, weights, out = null) {
  const target = out || weatherLook({ skyTop: '#000', skyHorizon: '#000', fog: '#000', skyLight: '#000', groundLight: '#000', sun: '#000',
    ambient: 0, sunlight: 0 });
  for (const key of COLOR_KEYS) target[key].setRGB(0, 0, 0);
  for (const key of NUMBER_KEYS) target[key] = 0;
  target.shadowTint.set(0, 0, 0); target.highlightTint.set(0, 0, 0);
  const w = target.water;
  w.skyTop.setRGB(0, 0, 0); w.skyHorizon.setRGB(0, 0, 0); w.shallow.setRGB(0, 0, 0); w.deep.setRGB(0, 0, 0);
  w.reflection = w.tile = w.specular = 0;
  looks.forEach((look, i) => {
    const k = weights[i];
    if (!(k > 0)) return;
    for (const key of COLOR_KEYS) { const c = look[key]; target[key].r += c.r * k; target[key].g += c.g * k; target[key].b += c.b * k; }
    for (const key of NUMBER_KEYS) target[key] += look[key] * k;
    target.shadowTint.addScaledVector(look.shadowTint, k);
    target.highlightTint.addScaledVector(look.highlightTint, k);
    for (const key of ['skyTop', 'skyHorizon', 'shallow', 'deep']) {
      const c = look.water[key]; w[key].r += c.r * k; w[key].g += c.g * k; w[key].b += c.b * k;
    }
    w.reflection += look.water.reflection * k; w.tile += look.water.tile * k; w.specular += look.water.specular * k;
  });
  return target;
}

/** Flash brightness 0..1 at `t` s after a strike: a bright stroke, a dip, a restrike, then the fade. */
export function flashCurve(t, seconds = WEATHER_VIEW.flash.seconds) {
  if (!(t >= 0) || t > seconds) return 0;
  if (t < 0.05) return 1;
  if (t < 0.1) return 0.3;
  if (t < 0.16) return 0.85;
  return 0.85 * Math.pow(1 - (t - 0.16) / (seconds - 0.16), 2);
}

export class ConquestWeatherView {
  /**
   * @param {{ worldview:object, post?:object, graphics?:object, onThunder?:(strike:{pos:number[], distance:number})=>void,
   *   random?:()=>number }} options `worldview` is the Frontier WorldView (its weather is the load mood).
   */
  constructor({ worldview, post = null, graphics = null, onThunder = null, random = Math.random } = {}) {
    this.worldview = worldview;
    this.post = post;
    this.onThunder = typeof onThunder === 'function' ? onThunder : null;
    this.random = random;
    this.scene = worldview.scene;
    this.loadWeather = worldview.weather || 'golden';
    this.looks = WEATHER_IDS.map(id => weatherLook(mapAtmosphere('frontier', { weather: id })));
    this.baseLook = weatherLook(worldview.palette);
    const loadIndex = Math.max(0, WEATHER_IDS.indexOf(this.loadWeather));
    this.weights = WEATHER_IDS.map((_, i) => (i === loadIndex ? 1 : 0));
    this.target = this.weights.slice();
    this.current = blendLooks(this.looks, this.weights);
    this.wind = { x: 0, z: 0, strength: 0 };
    this.rain = 0;
    this.wet = 0;
    this.targetWet = 0;
    this.weather = null;
    this.snapped = false;
    this.flashes = [];
    this.flash = 0;
    this.strikes = 0;
    this._waterAt = -Infinity;
    this.hemi = this.scene.getObjectByName('hemi');
    this.sky = worldview.skyUpdate?.uniforms ?? null;
    if (this.sky) this.sky.midAt.value = 0.3;
    this.motesAlpha = worldview.ambience?.uniforms?.uAlpha?.value ?? 0;
    // Rain streaks: one more ambience draw, its count from the tier's ambient particle budget.
    this.rainField = buildMapAmbience({ ambience: { kind: 'rain' } }, { graphics, lightUniforms: worldview.lightUniforms, floorY: 0 });
    if (this.rainField) {
      this.rainField.points.material.name = 'ambience-rain';
      this.rainAlpha = this.rainField.uniforms.uAlpha.value;
      this.rainVel = [this.rainField.uniforms.uVel.value.clone(), this.rainField.uniforms.uVel2.value.clone()];
      this.rainField.points.geometry.setDrawRange(0, 0);
      this.scene.add(this.rainField.points);
    }
    this.bolt = this._buildBolt();
    this.scene.add(this.bolt.mesh);
    this.disposed = false;
    this._apply(0, null);
  }

  /** Feed the decoded `match.conquest.wx` (decodeConquestWeather) of the latest snapshot; null keeps the load mood. */
  set(weather) {
    this.weather = weather || null;
    const target = WEATHER_IDS.map(() => 0);
    if (weather) {
      const k = weather.blend * weather.blend * (3 - 2 * weather.blend);
      target[Math.max(0, WEATHER_IDS.indexOf(weather.from))] += 1 - k;
      target[Math.max(0, WEATHER_IDS.indexOf(weather.to))] += k;
      this.targetWet = clamp01(weather.wet);
      const rad = (weather.windDeg || 0) * Math.PI / 180;
      this.wind = { x: Math.cos(rad), z: Math.sin(rad), strength: clamp01(weather.wind) };
      // The first mix after joining snaps: a mid-match join never watches the sky change from golden.
      if (!this.snapped) { this.weights = target.slice(); this.wet = this.targetWet; this.snapped = true; }
    } else target[Math.max(0, WEATHER_IDS.indexOf(this.loadWeather))] = 1;
    this.target = target;
  }

  /**
   * A `weather_strike` event `{x, y, z}`: flash and bolt now, thunder through
   * onThunder (distance from `listener`, the camera position).
   */
  strike(event, listener = null) {
    if (this.disposed || !Number.isFinite(event?.x) || !Number.isFinite(event?.z)) return false;
    const pos = [event.x, Number.isFinite(event.y) ? event.y : 30, event.z];
    const at = listener ? Math.hypot(pos[0] - listener.x, pos[1] - listener.y, pos[2] - listener.z) : WEATHER_VIEW.flash.near;
    const F = WEATHER_VIEW.flash;
    const level = at <= F.near ? 1 : Math.max(F.farLevel, 1 - (at - F.near) / (F.far - F.near) * (1 - F.farLevel));
    this.flashes.push({ age: 0, level });
    if (this.flashes.length > 4) this.flashes.shift();
    this.strikes++;
    this._placeBolt(pos, listener);
    this.onThunder?.({ pos, distance: at });
    return true;
  }

  /** × on the render-distance fog density relative to the load mood (main.js; `air` while flying). */
  fogScale(air = false) {
    const now = air ? this.current.airFogScale : this.current.fogScale;
    const base = air ? this.baseLook.airFogScale : this.baseLook.fogScale;
    return base > 0 ? now / base : 1;
  }

  /** Per frame, before the render. */
  update(dt, camera = null) {
    if (this.disposed) return;
    const step = Math.max(0, Math.min(0.25, Number(dt) || 0));
    const k = step > 0 ? 1 - Math.exp(-step / WEATHER_VIEW.ease) : 0;
    for (let i = 0; i < this.weights.length; i++) this.weights[i] += (this.target[i] - this.weights[i]) * k;
    this.wet += (this.targetWet - this.wet) * k;
    let flash = 0;
    for (const f of this.flashes) { f.age += step; flash = Math.max(flash, flashCurve(f.age) * f.level); }
    this.flashes = this.flashes.filter(f => f.age <= WEATHER_VIEW.flash.seconds);
    this.flash = flash;
    this._apply(step, camera);
  }

  _apply(step, camera) {
    const look = blendLooks(this.looks, this.weights, this.current);
    const F = WEATHER_VIEW.flash, flash = this.flash;
    const sky = this.sky;
    if (sky) {
      sky.topColor.value.copy(look.skyTop);
      sky.horizonColor.value.copy(look.skyHorizon);
      sky.midColor.value.copy(look.skyMid);
      sky.skyHaze.value = look.skyHaze;
      sky.glowColor.value.copy(look.glowColor).lerp(_white, flash * 0.6);
      sky.glow.value = look.glow + flash * F.glow;
      sky.sunGlow.value = look.sunGlow;
      sky.overcast.value = look.overcast;
      sky.deckColor.value.copy(look.deckColor).lerp(_flashTint, flash * F.deck);
      sky.cloudCover.value = look.cloudCover;
      sky.cloudLit.value.copy(look.cloudLit);
      sky.cloudShade.value.copy(look.cloudShade);
      sky.sunDisc.value = look.sunDisc;
    }
    this.scene.fog?.color.copy(look.fog);
    if (this.hemi) {
      this.hemi.color.copy(look.skyLight).lerp(_flashTint, flash * 0.5);
      this.hemi.groundColor.copy(look.groundLight);
      this.hemi.intensity = look.ambient + flash * F.hemi;
    }
    const sun = this.worldview.sun;
    if (sun) { sun.color.copy(look.sun); sun.intensity = look.sunlight; }
    if (this.worldview.environment) this.scene.environmentIntensity = look.envIntensity;
    const params = this.worldview.lightUniforms?.voxelLightParams?.value;
    if (params) { params.x = look.minSky; params.w = look.shadow; }
    const u = this.post?.uniforms;
    if (u?.exposure) {
      u.exposure.value = look.exposure * (1 + flash * F.exposure);
      u.gradeSaturation.value = look.saturation;
      u.gradeContrast.value = look.contrast;
      u.shadowTint.value.copy(look.shadowTint);
      u.highlightTint.value.copy(look.highlightTint);
    }
    // The water palette walks every water material: a few times a second is plenty.
    this._waterAt -= step;
    if (this._waterAt <= 0) {
      this._waterAt = 0.25;
      const w = look.water;
      applyWaterLook(w);
    }
    const air = this.worldview.backdrop?.group?.getObjectByName?.('backdrop-silhouettes')?.material?.userData?.backdropAir;
    if (air) air.value.w = look.airFog;
    // Load-mood motes thin out under cloud and vanish in the rain.
    let motes = 0;
    WEATHER_IDS.forEach((id, i) => { motes += this.weights[i] * (WEATHER_VIEW.motes[id] ?? 1); });
    const ambience = this.worldview.ambience?.uniforms?.uAlpha;
    if (ambience) ambience.value = this.motesAlpha * motes;
    // Rain from the storm's share of the mix.
    let rain = 0;
    WEATHER_IDS.forEach((id, i) => { if (id === 'storm') rain += this.weights[i]; });
    this.rain = clamp01((rain - 0.15) / 0.85);
    const field = this.rainField;
    if (field) {
      const count = Math.round(field.count * Math.min(1, this.rain * WEATHER_VIEW.rainDraw));
      field.points.geometry.setDrawRange(0, count);
      field.uniforms.uAlpha.value = this.rainAlpha * Math.min(1, 0.4 + this.rain);
      const slant = WEATHER_VIEW.rainSlant * this.wind.strength;
      field.uniforms.uVel.value.set(this.rainVel[0].x + this.wind.x * slant, this.rainVel[0].y, this.rainVel[0].z + this.wind.z * slant);
      field.uniforms.uVel2.value.set(this.rainVel[1].x + this.wind.x * slant * 0.8, this.rainVel[1].y, this.rainVel[1].z + this.wind.z * slant * 0.8);
      if (step > 0) field.update(step);
    }
    TERRAIN_WET.value = clamp01(this.wet);
    const dim = 1 - WEATHER_VIEW.farWetDim * clamp01(this.wet);
    for (const material of [this.worldview.farTerrain?.material, this.worldview.farTerrain?.silhouette?.material]) material?.color?.setScalar(dim);
    this._updateBolt(camera);
  }

  _buildBolt() {
    const B = WEATHER_VIEW.bolt;
    const quads = B.segments + Math.ceil(B.segments * 0.5);
    const positions = new Float32Array(quads * 4 * 3);
    const index = [];
    for (let q = 0; q < quads; q++) { const o = q * 4; index.push(o, o + 1, o + 2, o, o + 2, o + 3); }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.5, 3), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: true });
    material.name = 'weather-bolt';
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'weather-bolt';
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    return { mesh, geometry, material, quads, age: Infinity };
  }

  /** A jagged channel from the cloud deck to the strike, plus one branch, facing the listener. */
  _placeBolt(pos, listener) {
    const B = WEATHER_VIEW.bolt, bolt = this.bolt, rnd = this.random;
    const p = bolt.geometry.attributes.position.array;
    const dx = listener ? pos[0] - listener.x : 1, dz = listener ? pos[2] - listener.z : 0;
    const len = Math.hypot(dx, dz) || 1;
    // Ribbon width runs across the line of sight, so the bolt never reads edge-on.
    const sx = -dz / len * B.width * 0.5, sz = dx / len * B.width * 0.5;
    const points = [];
    const top = pos[1] + B.top;
    let x = pos[0] + (rnd() - 0.5) * 40, z = pos[2] + (rnd() - 0.5) * 40;
    for (let i = 0; i <= B.segments; i++) {
      const t = i / B.segments;
      const y = top + (pos[1] - top) * t;
      if (i === B.segments) { x = pos[0]; z = pos[2]; } else if (i > 0) {
        x += (rnd() - 0.5) * B.jitter * 2 + (pos[0] - x) * 0.25;
        z += (rnd() - 0.5) * B.jitter * 2 + (pos[2] - z) * 0.25;
      }
      points.push([x, y, z]);
    }
    let q = 0;
    const quad = (a, b, w) => {
      const o = q++ * 12;
      p.set([a[0] - sx * w, a[1], a[2] - sz * w, a[0] + sx * w, a[1], a[2] + sz * w,
        b[0] + sx * w, b[1], b[2] + sz * w, b[0] - sx * w, b[1], b[2] - sz * w], o);
    };
    for (let i = 0; i < B.segments; i++) quad(points[i], points[i + 1], 1);
    // One fork off the upper channel, thinner and fading out mid-air.
    const from = Math.floor(B.segments * (0.2 + rnd() * 0.25));
    let branch = points[from];
    for (let i = 0; q < bolt.quads && i < Math.ceil(B.segments * 0.5); i++) {
      const next = [branch[0] + (rnd() - 0.3) * B.jitter * 2.2, branch[1] - (top - pos[1]) / B.segments * 0.8,
        branch[2] + (rnd() - 0.3) * B.jitter * 2.2];
      quad(branch, next, B.branch * (1 - i / B.segments));
      branch = next;
    }
    bolt.geometry.attributes.position.needsUpdate = true;
    bolt.geometry.setDrawRange(0, q * 6);
    bolt.age = 0;
  }

  _updateBolt() {
    const bolt = this.bolt;
    const latest = this.flashes.at(-1);
    bolt.age = latest ? latest.age : Infinity;
    const visible = bolt.age <= WEATHER_VIEW.flash.bolt;
    bolt.material.opacity = visible ? flashCurve(bolt.age) : 0;
    if (!visible && bolt.geometry.drawRange.count !== 0) bolt.geometry.setDrawRange(0, 0);
  }

  /** Test and capture read-out. */
  get stats() {
    return { load: this.loadWeather, weights: Object.fromEntries(WEATHER_IDS.map((id, i) => [id, Math.round(this.weights[i] * 1000) / 1000])),
      rain: Math.round(this.rain * 1000) / 1000, wet: Math.round(this.wet * 1000) / 1000, flash: Math.round(this.flash * 1000) / 1000,
      strikes: this.strikes, rainDrawn: this.rainField?.points.geometry.drawRange.count ?? 0, rainCapacity: this.rainField?.count ?? 0,
      fogScale: Math.round(this.fogScale(false) * 1000) / 1000 };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    TERRAIN_WET.value = 0;
    this.rainField?.dispose();
    this.bolt.mesh.removeFromParent();
    this.bolt.geometry.dispose();
    this.bolt.material.dispose();
  }
}

const _white = new THREE.Color(1, 1, 1);
const _flashTint = new THREE.Color(0.86, 0.9, 1);

/** Water palette (fluid-material.js applyWaterPalette) from a blended look's water block. */
function applyWaterLook(w) {
  applyWaterPalette({ skyTop: w.skyTop, skyHorizon: w.skyHorizon,
    water: { reflection: w.reflection, shallow: w.shallow, deep: w.deep, tile: w.tile, specular: w.specular } });
}
