/**
 * Titanfall loadout screen (docs/titanfall.md §8.1; WP6). Pilot column
 * (5 primaries, 4 anti-titan weapons, 3 tacticals plus a one-line hint), five
 * titan cards with live portraits of the real titan models, the kit strip
 * (weapon, abilities, HEALTH / SPEED / DASH from the frame table) and DEPLOY.
 * Reference: docs/design/titanfall/loadout.png with the README corrections
 * (real-model portraits, data-driven frame label, vertical scroll on phones).
 *
 * The selection is stored under `titanfall.loadout.v1` (every storage access
 * in try/catch) and sent packed as `{t:'titanfall', loadout}`; the server
 * applies it at the next respawn and reads the titan type at the next call.
 */
import { packTitanLoadout, unpackTitanLoadout, TITAN_LOADOUT_DEFAULT_PACKED, TITAN_TYPE_IDS } from '../../../shared/titan-contract.js';
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { loadoutModel } from './titan-hud-state.js';

export const LOADOUT_STORAGE_KEY = 'titanfall.loadout.v1';
/**
 * Click-through guard (playtest): the overlay opens on death under the crosshair while the
 * fire button may still be clicking. A pick counts only from a press that started on the
 * overlay at least `armMs` after it opened; a mouse that was already clicking inside that
 * window (fire held through the death) must also move `movePx` before a pick counts.
 */
export const LOADOUT_PICK_GUARD = Object.freeze({ armMs: 650, movePx: 8 });
const clockMs = doc => doc?.defaultView?.performance?.now?.() ?? Date.now();
/** HUD weapon art per pilot item (`assets/weapons/hud/<file>.png`). */
export const LOADOUT_ICON_FILES = Object.freeze({
  rifle: 'rifle', smg: 'smg', shotgun: 'shotgun', lmg: 'lmg', kraber: 'kraber',
  chargerifle: 'chargerifle', archer: 'archer', thunderbolt: 'thunderbolt', mgl: 'mgl',
});
export const PORTRAIT_SIZE = Object.freeze({ width: 220, height: 300 });
/** Line glyphs (24-unit viewBox, stroked) for the pilot tacticals, in the game's line-icon style. */
export const TACTICAL_GLYPHS = Object.freeze({
  // Grapple: a launcher on a rope and a three-prong hook.
  grapple: 'M4 20 L9 15 M7.5 13.5 L10.5 16.5 M9 15 Q13 11 15 9 M15 9 L15 4 M15 9 L20 9 M15 9 L18.5 5.5 M15 4 Q12.5 4 12.5 6.5 M20 9 Q20 11.5 17.5 11.5',
  // Stim: a syringe with plunger, barrel graduations and needle.
  stim: 'M3 21 L6.5 17.5 M6.5 17.5 L15.5 8.5 L18.5 11.5 L9.5 20.5 Z M17 7 L20 10 M18.5 5.5 L21.5 8.5 M20 4 L20 4 M10 13 L12 15 M12.5 10.5 L14.5 12.5',
  // Cloak: a hooded figure, dashed so it reads as fading out.
  cloak: 'M12 3 C8 3 6 6.5 6 10.5 L6 21 L18 21 L18 10.5 C18 6.5 16 3 12 3 Z M9 11 C10 13 14 13 15 11',
});

/** Fit a measured portrait slot into the render budget (long side 300 css px), or null. */
export function portraitSize(width, height) {
  if (!(width > 8 && height > 8)) return null;
  const scale = 300 / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The stored packed loadout, or null (no storage, nothing stored, or garbage). */
export function readStoredLoadout(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(LOADOUT_STORAGE_KEY);
    if (raw == null) return null;
    const value = Number(JSON.parse(raw)?.packed);
    return Number.isInteger(value) && value >= 0 && value <= 0xffff ? packTitanLoadout(unpackTitanLoadout(value)) : null;
  } catch { return null; }
}
/** Store a packed loadout; false when storage is unavailable. */
export function writeStoredLoadout(packed, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(LOADOUT_STORAGE_KEY, JSON.stringify({ v: 1, packed: packTitanLoadout(unpackTitanLoadout(packed)) }));
    return !!storage?.setItem;
  } catch { return false; }
}

function glyph(doc, id, parent) {
  const ns = 'http://www.w3.org/2000/svg';
  const make = tag => doc.createElementNS ? doc.createElementNS(ns, tag) : doc.createElement(tag);
  const icon = make('svg');
  icon.setAttribute('class', `tf-lo-tac-icon tf-tac-${id}`);
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = make('path');
  path.setAttribute('d', TACTICAL_GLYPHS[id] ?? 'M6 6 H18 V18 H6 Z');
  icon.appendChild(path);
  parent?.appendChild(icon);
  return icon;
}

function el(doc, tag, className = '', parent = null, text = '') {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

/** Portrait camera: direction (x per unit of -z, rise) and fit margin. */
export const PORTRAIT_VIEW = Object.freeze({ side: 0.62, rise: 0.14, margin: 1.06 });

/**
 * Live portraits of the five titan models through the game's own renderer:
 * an offscreen HDR target, a Neutral tone map + sRGB pass into an 8-bit
 * target, then read back into one 2D canvas per titan. The renderer's target,
 * clear colour and auto-clear are restored afterwards; the main canvas is never
 * drawn to. Resolves to Map(type -> HTMLCanvasElement), empty on failure.
 */
export async function renderTitanPortraits(renderer, { team = 'alpha', types = TITAN_TYPE_IDS, size = PORTRAIT_SIZE,
  documentRef = typeof document !== 'undefined' ? document : null, anchor = null } = {}) {
  const out = new Map();
  if (!renderer || !documentRef) return out;
  const [THREE, presentation, materials, contract] = await Promise.all([
    import('../vendor/three.module.js'), import('./titan-presentation.js'),
    import('../vehicles/voxel-model/material.js'), import('../../../shared/titan-contract.js')]);
  const ratio = 2, w = size.width * ratio, h = size.height * ratio;
  const kit = portraitKit(renderer, THREE, materials, w, h);
  const { scene, sun, rim, camera, hdr, ldr, quad, quadScene, quadCamera, owned } = kit;
  quad.material.uniforms.exposure.value = renderer.toneMappingExposure ?? 1;
  // Up in open air above the viewer, so the voxel light volume reads as sky light.
  const base = new THREE.Vector3(anchor?.x ?? 0, (anchor?.y ?? 0) + 60, anchor?.z ?? 0);
  sun.position.copy(base).add(new THREE.Vector3(-22, 40, -30)); sun.target.position.copy(base);
  rim.position.copy(base).add(new THREE.Vector3(26, 14, 22)); rim.target.position.copy(base);
  const prev = { target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
    autoClear: renderer.autoClear };
  const pixels = new Uint8Array(w * h * 4);
  try {
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    for (const type of types) {
      let model = null;
      try {
        model = presentation.createModel(type, { team, ...owned });
        model.group.position.copy(base);
        scene.add(model.group);
        const pips = TITAN_RULES.frames[contract.TITAN_CHASSIS[type]]?.pips ?? 2;
        const row = { type, tw: [0, pips * 10, 0, 0, 0, 0] };
        for (let i = 0; i < 40; i++) {
          model.animate?.(1 / 30, { speed: 0, visualSteer: 0, grounded: true, wreck: false, tw: row.tw, titan: contract.decodeTitanRow(row),
            mounts: [[0, 0.05]], phase: 0, legYaw: 0, yaw: 0, events: [], x: base.x, y: base.y, z: base.z, probe: () => base.y });
        }
        model.group.updateMatrixWorld(true);
        // Three-quarter view from the weapon side; frame the whole silhouette (weapon and sword included)
        // at the slot's own aspect, so the card shows it with object-fit: contain and nothing is cropped.
        camera.aspect = w / h; camera.updateProjectionMatrix();
        const box = new THREE.Box3().setFromObject(model.group);
        const center = box.getCenter(new THREE.Vector3()), extent = box.getSize(new THREE.Vector3());
        const height = Math.max(4, extent.y), across = Math.max(2, Math.hypot(extent.x, extent.z) * 0.86);
        const dir = new THREE.Vector3(PORTRAIT_VIEW.side, PORTRAIT_VIEW.rise, -1).normalize();
        const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), tanH = tanV * camera.aspect;
        const dist = Math.max((height / 2) / tanV, (across / 2) / tanH) * PORTRAIT_VIEW.margin + across * 0.35;
        camera.position.copy(center).addScaledVector(dir, dist);
        rim.position.copy(center).add(new THREE.Vector3(-dir.x * 30, 18, -dir.z * 30)); rim.target.position.copy(center);
        camera.lookAt(center.x, center.y, center.z);
        camera.updateMatrixWorld(true);
        renderer.setRenderTarget(hdr);
        renderer.render(scene, camera);
        renderer.setRenderTarget(ldr);
        renderer.render(quadScene, quadCamera);
        renderer.readRenderTargetPixels(ldr, 0, 0, w, h, pixels);
        const canvas = documentRef.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.className = 'tf-portrait';
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(w, h);
        for (let y = 0; y < h; y++) image.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        ctx.putImageData(image, 0, 0);
        out.set(type, canvas);
      } catch (error) {
        if (typeof console !== 'undefined') console.warn(`titanfall: portrait ${type} failed`, error);
      } finally {
        if (model) scene.remove(model.group);
      }
    }
  } finally {
    renderer.setRenderTarget(prev.target);
    renderer.setClearColor(prev.clear, prev.alpha);
    renderer.autoClear = prev.autoClear;
    // The targets are per call (sized to the slot); the programs stay with the kit's materials.
    hdr.dispose(); ldr.dispose();
    kit.hdr = kit.ldr = kit.quad.material.uniforms.map.value = null; kit.w = kit.h = 0;
  }
  return out;
}

/**
 * The portrait scene, targets, tone-map pass and one owned hull material set, kept for the match:
 * every portrait (and every reopen) shares one linked program per pass instead of linking, deleting
 * and relinking it per titan. disposeTitanPortraits() frees it (titan-ui dispose).
 */
let portraits = null;
function portraitKit(renderer, THREE, materials, w, h) {
  if (portraits && portraits.renderer !== renderer) disposeTitanPortraits();
  if (!portraits) portraits = buildPortraitKit(renderer, THREE, materials);
  if (!portraits.hdr || portraits.w !== w || portraits.h !== h) {
    portraits.hdr?.dispose(); portraits.ldr?.dispose();
    portraits.hdr = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    portraits.ldr = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType });
    portraits.quad.material.uniforms.map.value = portraits.hdr.texture;
    portraits.w = w; portraits.h = h;
  }
  return portraits;
}

/** Free the portrait kit (GPU targets, the tone-map pass, the owned hull materials). */
export function disposeTitanPortraits() {
  if (!portraits) return;
  const kit = portraits;
  portraits = null;
  kit.hdr?.dispose(); kit.ldr?.dispose();
  kit.quad.geometry.dispose(); kit.quad.material.dispose();
  for (const material of Object.values(kit.owned)) material.dispose?.();
}

/**
 * Load time (before warmShaders): one tiny portrait through the kit, so its hull and tone-map
 * programs are linked before the loadout screen first opens in the live match.
 */
export async function warmTitanPortraits(renderer, { team = 'alpha', documentRef = typeof document !== 'undefined' ? document : null } = {}) {
  if (!renderer || !documentRef) return false;
  const out = await renderTitanPortraits(renderer, { team, types: [TITAN_TYPE_IDS[0]], size: { width: 8, height: 8 }, documentRef });
  return out.size > 0;
}

function buildPortraitKit(renderer, THREE, materials) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x4a4036, 1.25));
  const sun = new THREE.DirectionalLight(0xfff0d6, 2.4);
  const rim = new THREE.DirectionalLight(0x9cc8ff, 1.8);
  scene.add(sun, sun.target, rim, rim.target);
  const camera = new THREE.PerspectiveCamera(27, 1, 0.5, 120);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, exposure: { value: renderer.toneMappingExposure ?? 1 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D map; uniform float exposure; varying vec2 vUv;
      vec3 neutral(vec3 c) {
        const float start = 0.76; const float desat = 0.15;
        float x = min(c.r, min(c.g, c.b)); float offset = x < 0.08 ? x - 6.25 * x * x : 0.04; c -= offset;
        float peak = max(c.r, max(c.g, c.b)); if (peak < start) return c;
        float d = 1.0 - start; float np = 1.0 - d * d / (peak + d - start); c *= np / peak;
        float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0); return mix(c, vec3(np), g);
      }
      vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
      void main() { vec4 t = texture2D(map, vUv); gl_FragColor = vec4(srgb(clamp(neutral(t.rgb * exposure), 0.0, 1.0)), t.a); }`,
    depthTest: false, depthWrite: false,
  }));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const owned = { material: materials.createVehicleMaterial({ name: 'titan-portrait' }),
    glass: materials.createVehicleGlassMaterial(), blur: materials.createRotorBlurMaterial() };
  return { renderer, scene, sun, rim, camera, quad, quadScene, quadCamera, owned, hdr: null, ldr: null, w: 0, h: 0 };
}

/**
 * The loadout overlay. `onChange(packed)` runs on every pick (the caller
 * stores and sends it); `onDeploy()` on DEPLOY / READY; `onClose()` whenever
 * the screen closes. `portraits(team, size)` resolves to Map(type -> canvas); `size` is the measured
 * card slot ({ width, height }, long side 300) so the render matches the card's aspect.
 */
export class TitanLoadout {
  constructor(parent = typeof document !== 'undefined' ? document.body : null, { documentRef = typeof document !== 'undefined' ? document : null,
    packed = TITAN_LOADOUT_DEFAULT_PACKED, onChange = () => {}, onDeploy = () => {}, onClose = () => {}, portraits = null } = {}) {
    this.doc = documentRef;
    this.packed = packTitanLoadout(unpackTitanLoadout(packed));
    this.onChange = onChange; this.onDeploy = onDeploy; this.onClose = onClose;
    this.portraits = portraits;
    this.portraitTeam = null;
    this.portraitCanvases = new Map();
    this.state = { team: 'alpha', dead: false, respawnIn: null, autoDeployIn: null };
    this.isOpen = false;
    this._sig = '';
    if (!this.doc || !parent) return;
    const d = this.doc;
    const root = this.root = el(d, 'section', 'tf-loadout', parent);
    root.id = 'titanfall-loadout';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Loadout');
    const scroll = this.scroll = el(d, 'div', 'tf-lo-scroll', root);
    const head = el(d, 'header', 'tf-lo-head', scroll);
    const titles = el(d, 'div', 'tf-lo-titles', head);
    el(d, 'h2', 'tf-lo-title', titles, 'LOADOUT');
    this.subtitle = el(d, 'span', 'tf-lo-sub', titles, '');
    this.respawn = el(d, 'div', 'tf-lo-respawn', head);
    this.respawnLabel = el(d, 'span', '', this.respawn, 'RESPAWN IN');
    this.respawnValue = el(d, 'b', '', this.respawn, '');
    const body = el(d, 'div', 'tf-lo-body', scroll);
    const pilot = el(d, 'div', 'tf-lo-panel tf-lo-pilot', body);
    el(d, 'h3', '', pilot, 'PILOT');
    this.groups = {};
    for (const [key, label] of [['primary', 'PRIMARY'], ['at', 'ANTI-TITAN'], ['tactical', 'TACTICAL']]) {
      const group = el(d, 'div', `tf-lo-group tf-lo-${key}`, pilot);
      el(d, 'h4', '', group, label);
      this.groups[key] = el(d, 'div', 'tf-lo-chips', group);
      this.groups[key].setAttribute('role', 'radiogroup');
      this.groups[key].setAttribute('aria-label', label);
    }
    this.hint = el(d, 'p', 'tf-lo-hint', pilot, '');
    // The selected primary's stats from WEAPONS (damage, rate of fire, magazine), relative to the five primaries.
    const pstats = el(d, 'div', 'tf-lo-pstats', pilot);
    this.pstatsName = el(d, 'b', 'tf-lo-pstats-name', pstats, '');
    this.pstatBars = {};
    for (const [key, label] of [['damage', 'DAMAGE'], ['rate', 'RATE'], ['mag', 'MAG']]) {
      const row = el(d, 'div', 'tf-lo-stat', pstats);
      el(d, 'span', '', row, label);
      const bar = el(d, 'i', 'tf-lo-bar', row);
      this.pstatBars[key] = { fill: el(d, 'i', '', bar), value: key === 'mag' ? el(d, 'span', 'tf-lo-stat-value', row, '') : null };
    }
    const titan = el(d, 'div', 'tf-lo-panel tf-lo-titan', body);
    el(d, 'h3', '', titan, 'TITAN');
    this.cards = el(d, 'div', 'tf-lo-cards', titan);
    this.cards.setAttribute('role', 'radiogroup');
    this.cards.setAttribute('aria-label', 'Titan');
    const kit = el(d, 'div', 'tf-lo-kit', titan);
    const kitHead = el(d, 'div', 'tf-lo-kit-head', kit);
    this.kitName = el(d, 'b', '', kitHead, '');
    this.kitFrame = el(d, 'span', '', kitHead, '');
    const kitRow = el(d, 'div', 'tf-lo-kit-row', kit);
    this.kitTiles = el(d, 'div', 'tf-lo-kit-tiles', kitRow);
    this.kitStats = el(d, 'div', 'tf-lo-stats', kitRow);
    const foot = el(d, 'footer', 'tf-lo-foot', scroll);
    this.deploy = el(d, 'button', 'tf-lo-deploy', foot);
    this.deploy.type = 'button';
    this.deployLabel = el(d, 'span', '', this.deploy, 'DEPLOY');
    el(d, 'i', 'tf-lo-chevron', this.deploy);
    this._onClick = event => this._click(event);
    root.addEventListener('click', this._onClick);
    this._openedAt = -Infinity;
    this._pressAt = -Infinity;
    this._spam = false;
    this._moved = false;
    this._origin = null;
    // Mouse travel since the first pointer event after opening (movePx).
    const track = event => {
      if (event?.pointerType && event.pointerType !== 'mouse') { this._moved = true; return; }
      if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return;
      if (!this._origin) { this._origin = [event.clientX, event.clientY]; return; }
      if (Math.hypot(event.clientX - this._origin[0], event.clientY - this._origin[1]) >= LOADOUT_PICK_GUARD.movePx) this._moved = true;
    };
    this._onPress = event => {
      const at = clockMs(this.doc);
      this._pressAt = at;
      if (at < this._openedAt + LOADOUT_PICK_GUARD.armMs && event?.pointerType !== 'touch') this._spam = true;
      track(event);
    };
    this._onMove = track;
    root.addEventListener('pointerdown', this._onPress);
    root.addEventListener('pointermove', this._onMove);
    this._onKey = event => {
      if (!this.isOpen || event.code !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.state.dead) this.close();
    };
    d.defaultView?.addEventListener('keydown', this._onKey, true);
  }

  get selection() { return unpackTitanLoadout(this.packed); }

  /** Open (or refresh) for a team; `dead` with `respawnIn` seconds shows the respawn countdown, then `autoDeployIn` the idle fallback. */
  open({ team = this.state.team, dead = false, respawnIn = null, autoDeployIn = null } = {}) {
    if (!this.root) return;
    this.state = { team, dead, respawnIn, autoDeployIn };
    if (!this.isOpen) {
      this.isOpen = true; this.root.hidden = false; this._sig = '';
      this._openedAt = clockMs(this.doc); this._spam = false; this._moved = false; this._origin = null;
    }
    this.render();
    this._portraitPromise = this._loadPortraits(team);
  }
  /** Resolves once the portraits for the open team are painted (or failed). */
  portraitsReady() { return this._portraitPromise ?? Promise.resolve(); }
  /** Countdown refresh while open (no DOM write when the label is unchanged). */
  update({ dead = this.state.dead, respawnIn = this.state.respawnIn, team = this.state.team, autoDeployIn = this.state.autoDeployIn } = {}) {
    this.state = { team, dead, respawnIn: Number.isFinite(respawnIn) ? Math.round(respawnIn * 10) / 10 : null,
      autoDeployIn: Number.isFinite(autoDeployIn) ? Math.ceil(autoDeployIn) : null };
    if (this.isOpen) this.render();
  }
  close() {
    if (!this.root || !this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.onClose();
  }
  select(field, id) {
    const next = { ...this.selection, [field]: id };
    const packed = packTitanLoadout(next);
    if (packed === this.packed) return false;
    this.packed = packed;
    this.render();
    this.onChange(packed);
    return true;
  }

  _click(event) {
    const target = event.target?.closest?.('[data-pick], .tf-lo-deploy');
    if (!target) return;
    if (target === this.deploy) { this.onDeploy(); this.close(); return; }
    // A pick needs a fresh press on the overlay, armMs after it opened (a trusted click
    // without its pointerdown, e.g. keyboard activation, passes once the window is over).
    const armedAt = this._openedAt + LOADOUT_PICK_GUARD.armMs;
    if (clockMs(this.doc) < armedAt || (event.isTrusted && event.detail > 0 && (this._pressAt < armedAt || (this._spam && !this._moved)))) return;
    this.select(target.dataset.field, target.dataset.pick);
  }

  async _loadPortraits(team) {
    if (!this.portraits || this.portraitTeam === team) return this._portraitPromise;
    this.portraitTeam = team;
    try {
      const slot = this.cards?.querySelector?.('.tf-lo-portrait');
      const canvases = await this.portraits(team, portraitSize(slot?.clientWidth, slot?.clientHeight) ?? PORTRAIT_SIZE);
      if (!this.root || this.portraitTeam !== team || !(canvases instanceof Map)) return;
      this.portraitCanvases = canvases;
      this._sig = '';
      this.render();
    } catch { /* cards keep their silhouettes */ }
  }

  /** Paint the model; returns the model (tests read it). */
  render() {
    const model = loadoutModel(this.packed, this.state);
    if (!this.root) return model;
    const sig = JSON.stringify([model.selection, model.subtitle, model.respawn, model.autoDeploy, model.deployLabel, this.portraitCanvases.size]);
    if (sig === this._sig) return model;
    this._sig = sig;
    const d = this.doc;
    this.subtitle.textContent = model.subtitle;
    // RESPAWN IN n.n while the timer runs, then AUTO-DEPLOY IN n S (as Conquest's deploy screen).
    this.respawn.hidden = model.respawn == null && model.autoDeploy == null;
    if (this.respawnLabel) this.respawnLabel.textContent = model.respawn == null && model.autoDeploy != null ? 'AUTO-DEPLOY IN' : 'RESPAWN IN';
    this.respawnValue.textContent = model.respawn != null ? model.respawn.toFixed(1) : model.autoDeploy != null ? `${model.autoDeploy} S` : '';
    this.deployLabel.textContent = model.deployLabel;
    this.root.dataset.dead = String(!!this.state.dead);
    for (const field of ['primary', 'at', 'tactical']) {
      const group = this.groups[field];
      const items = model[field];
      if (group.childElementCount !== items.length) {
        group.textContent = '';
        for (const item of items) {
          const chip = el(d, 'button', `tf-lo-chip tf-lo-chip-${field}`, group);
          chip.type = 'button';
          chip.dataset.field = field; chip.dataset.pick = item.id;
          chip.setAttribute('role', 'radio');
          if (field === 'tactical') glyph(d, item.id, chip);
          else {
            const img = el(d, 'img', 'tf-lo-weapon', chip);
            img.alt = ''; img.decoding = 'async'; img.draggable = false;
            img.src = `./assets/weapons/hud/${LOADOUT_ICON_FILES[item.id] ?? item.id}.png`;
            img.onerror = () => { img.hidden = true; };
          }
          el(d, 'span', '', chip, item.label);
        }
      }
      items.forEach((item, i) => {
        const chip = group.children[i];
        chip.setAttribute('aria-checked', String(item.selected));
        chip.classList.toggle('is-selected', item.selected);
      });
    }
    this.hint.textContent = model.tacticalHint;
    this.pstatsName.textContent = model.primaryName;
    for (const [key, bar] of Object.entries(this.pstatBars)) {
      bar.fill.style.setProperty('--fill', `${Math.round((model.primaryStats?.[key] ?? 0) * 100)}%`);
      if (bar.value) bar.value.textContent = String(model.primaryStats?.magSize ?? '');
    }
    if (this.cards.childElementCount !== model.titans.length) {
      this.cards.textContent = '';
      for (const card of model.titans) {
        const button = el(d, 'button', 'tf-lo-card', this.cards);
        button.type = 'button';
        button.dataset.field = 'titan'; button.dataset.pick = card.type; button.dataset.chassis = card.chassis.toLowerCase();
        button.setAttribute('role', 'radio');
        el(d, 'div', 'tf-lo-portrait', button);
        el(d, 'b', 'tf-lo-card-name', button, card.label);
        el(d, 'span', 'tf-lo-card-chassis', button, card.chassis);
      }
    }
    model.titans.forEach((card, i) => {
      const button = this.cards.children[i];
      button.setAttribute('aria-checked', String(card.selected));
      button.classList.toggle('is-selected', card.selected);
      const slot = button.querySelector('.tf-lo-portrait');
      const canvas = this.portraitCanvases.get(card.type);
      if (canvas && slot.firstChild !== canvas) { slot.textContent = ''; slot.appendChild(canvas); }
      slot.dataset.live = String(!!canvas);
    });
    const kit = model.kit;
    this.kitName.textContent = kit.label;
    this.kitFrame.textContent = kit.frame;
    this.kitTiles.textContent = '';
    kit.kit.forEach((label, i) => {
      const tile = el(d, 'div', `tf-lo-kit-tile tf-kit-${['weapon', 'defensive', 'tactical', 'ordnance', 'core'][i]}`, this.kitTiles);
      el(d, 'i', 'tf-lo-kit-icon', tile);
      el(d, 'span', '', tile, label);
    });
    this.kitStats.textContent = '';
    for (const [key, label] of [['health', 'HEALTH'], ['speed', 'SPEED'], ['dash', 'DASH']]) {
      const row = el(d, 'div', 'tf-lo-stat', this.kitStats);
      el(d, 'span', '', row, label);
      const bar = el(d, 'i', 'tf-lo-bar', row);
      el(d, 'i', '', bar).style.setProperty('--fill', `${Math.round((kit.stats?.[key] ?? 0) * 100)}%`);
    }
    return model;
  }

  dispose() {
    this.doc?.defaultView?.removeEventListener('keydown', this._onKey, true);
    this.root?.removeEventListener('click', this._onClick);
    this.root?.removeEventListener('pointerdown', this._onPress);
    this.root?.removeEventListener('pointermove', this._onMove);
    this.root?.remove();
    this.root = null;
    this.isOpen = false;
    this.portraitCanvases = new Map();
  }
}
