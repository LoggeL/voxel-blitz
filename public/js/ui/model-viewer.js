import * as THREE from '../vendor/three.module.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { normalizeCosmeticLoadout } from '../../../shared/career.js';
import { normalizeAttachments } from '../../../shared/weapon-attachments.js';
import { MaterialCache } from '../guns/kit.js';
import { buildGun, disposeGunModels } from '../guns/assemble.js';
import { applyAttachmentModel } from '../guns/attachment-model.js';
import { makeAvatar, disposeAvatar } from '../avatar/avatar.js';
import { applyGunCosmetics, applyAvatarCosmetics } from '../cosmetics/skins.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const element = (tag, parent, className, text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
};

/** An isolated, on-demand viewer of the same models used in matches. */
export class ModelViewer {
  constructor(container) {
    // Create WebGL first so callers can keep their artwork if it is unavailable.
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.element = element('div', container, 'vb-model-viewer');
    this.stage = element('div', this.element, 'vb-model-stage');
    this.canvas = this.renderer.domElement;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.stage.append(this.canvas);
    element('span', this.stage, 'vb-model-hint', 'DRAG TO ROTATE · SCROLL / PINCH TO ZOOM');
    this.status = element('span', this.stage, 'vb-model-status');
    this.status.setAttribute('role', 'status');
    const toolbar = element('div', this.element, 'vb-model-toolbar');
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '3D preview controls');
    element('span', toolbar, 'vb-model-label', '3D INSPECT');
    const button = (text, label, action, click) => {
      const node = element('button', toolbar, 'vb-model-control', text);
      node.type = 'button';
      node.dataset.viewerAction = action;
      node.setAttribute('aria-label', label);
      node.addEventListener('click', click);
      return node;
    };
    this.zoomOut = button('−', 'Zoom out', 'zoom-out', () => this.zoomBy(1 / 1.2));
    this.zoomIn = button('+', 'Zoom in', 'zoom-in', () => this.zoomBy(1.2));
    button('RESET VIEW', 'Reset 3D view', 'reset', () => this.reset());
    this.compare = button('SHOW STANDARD', 'Compare with standard model', 'standard', () => {
      this.standard = !this.standard;
      this.build();
    });
    this.compare.setAttribute('aria-pressed', 'false');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.005, 100);
    this.scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x443022, 2.5));
    for (const [color, intensity, position] of [[0xffdda9, 4, [2, 4, 3]], [0x8ab9ff, 3, [-3, 2, -2]], [0xffffff, 2, [-2, 0, 3]]]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position);
      this.scene.add(light);
    }
    this.pointers = new Map();
    this.events = new AbortController();
    const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: this.events.signal });
    on(this.canvas, 'pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      this.canvas.focus({ preventScroll: true });
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.canvas.setPointerCapture(event.pointerId);
      this.stage.classList.add('is-dragging');
    });
    on(this.canvas, 'pointermove', event => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      const oldDistance = this.pinchDistance();
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 1) {
        this.yaw -= (event.clientX - previous.x) * 0.01;
        this.pitch = clamp(this.pitch - (event.clientY - previous.y) * 0.01, 0.12, Math.PI - 0.12);
        this.render();
      } else if (oldDistance > 0) this.zoomBy(this.pinchDistance() / oldDistance);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(this.canvas, type, event => {
      this.pointers.delete(event.pointerId);
      if (!this.pointers.size) this.stage.classList.remove('is-dragging');
    });
    on(this.canvas, 'wheel', event => {
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.stage.clientHeight : 1);
      this.zoomBy(Math.exp(-clamp(pixels, -300, 300) * 0.002));
    }, { passive: false });
    on(this.canvas, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home', 'r', 'R'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowLeft') this.yaw += 0.15;
      if (event.key === 'ArrowRight') this.yaw -= 0.15;
      if (event.key === 'ArrowUp') this.pitch = clamp(this.pitch - 0.15, 0.12, Math.PI - 0.12);
      if (event.key === 'ArrowDown') this.pitch = clamp(this.pitch + 0.15, 0.12, Math.PI - 0.12);
      if (event.key === '+' || event.key === '=') this.zoomBy(1.2);
      else if (event.key === '-') this.zoomBy(1 / 1.2);
      else if (['Home', 'r', 'R'].includes(event.key)) this.reset();
      else this.render();
    });
    on(this.canvas, 'webglcontextlost', event => {
      event.preventDefault(); this.contextLost = true;
      this.canvas.dataset.ready = 'false';
      this.status.textContent = '3D preview paused. Waiting for graphics to recover.';
    });
    on(this.canvas, 'webglcontextrestored', () => {
      this.contextLost = false; this.status.textContent = ''; this.render();
    });
    on(document, 'visibilitychange', () => {
      this.pointers.clear(); this.stage.classList.remove('is-dragging');
      if (!document.hidden) this.render();
    });
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(this.stage);
  }

  pinchDistance() {
    if (this.pointers.size < 2) return 0;
    const [a, b] = this.pointers.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  show({ weapon = null, loadout = {}, attachments, label = 'Character' } = {}) {
    if (this.disposed) return;
    if (weapon && !WEAPONS[weapon]) throw new Error('Unknown preview weapon');
    const cosmetics = normalizeCosmeticLoadout(loadout);
    const skin = weapon ? cosmetics.weaponSkins[weapon] || 'standard' : cosmetics.characterSkin;
    const config = weapon ? normalizeAttachments(weapon, attachments) : null;
    const key = JSON.stringify([weapon, skin, config]);
    this.canvas.setAttribute('aria-label', `${label}. 3D preview. Drag or use arrow keys to rotate. Scroll, pinch or use plus and minus to zoom. Home resets the view.`);
    if (key === this.key) { this.render(); return; }
    const changedItem = weapon !== this.weapon || skin !== this.skin;
    Object.assign(this, { key, weapon, skin, config, cosmetics });
    if (changedItem) { this.standard = false; this.reset(false); }
    this.build();
  }

  clearModel() {
    if (this.gun) disposeGunModels([this.gun], this.cache);
    if (this.avatar) { disposeAvatar(this.avatar); this.avatar.group.removeFromParent(); }
    this.gun = this.avatar = this.cache = this.root = null;
  }

  build() {
    this.clearModel();
    const loadout = this.standard ? {} : this.cosmetics;
    if (this.weapon) {
      this.cache = new MaterialCache();
      this.gun = buildGun(this.weapon, this.cache);
      applyGunCosmetics(this.gun, this.weapon, loadout);
      applyAttachmentModel(this.gun, this.weapon, this.config);
      this.root = this.gun.root;
      this.root.traverse(object => { if (object.name === 'hand_l' || object.name === 'hand_r') object.visible = false; });
      this.gun.flash.grp.visible = false;
    } else {
      this.avatar = makeAvatar('cosmetic-preview', 'OPERATOR', null);
      this.avatar.suitMaterial.color.setHex(0x465361);
      this.avatar.darkMaterial.color.setHex(0x222c37);
      applyAvatarCosmetics(this.avatar, loadout);
      this.avatar.tag.visible = this.avatar.hpSpr.visible = false;
      this.avatar.weaponModel.root.visible = false;
      this.root = this.avatar.group;
    }
    this.scene.add(this.root);
    this.root.updateMatrixWorld(true);
    // Hidden hands, muzzle effects, nameplates and carried guns must not affect framing.
    const bounds = new THREE.Box3();
    this.root.traverseVisible(object => {
      if (!object.geometry) return;
      // Instanced parts use scaled/transformed copies of a unit primitive.
      // Its raw geometry box is not the rendered model's box.
      if (object.isInstancedMesh) object.computeBoundingBox();
      else object.geometry.computeBoundingBox();
      bounds.union((object.isInstancedMesh ? object.boundingBox : object.geometry.boundingBox).clone().applyMatrix4(object.matrixWorld));
    });
    const center = bounds.getCenter(new THREE.Vector3());
    this.root.position.sub(center);
    bounds.translate(center.negate());
    this.corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      this.corners.push(new THREE.Vector3(x, y, z));
    }
    this.compare.hidden = this.skin === 'standard';
    this.compare.textContent = this.standard ? 'SHOW SKIN' : 'SHOW STANDARD';
    this.compare.setAttribute('aria-pressed', String(!!this.standard));
    this.canvas.dataset.skin = this.standard ? 'standard' : this.skin;
    this.canvas.dataset.model = this.weapon || 'character';
    this.render();
  }

  reset(render = true) {
    this.yaw = this.weapon ? -1.15 : 2.65;
    this.pitch = this.weapon ? 1.25 : 1.4;
    this.zoom = 1;
    if (render) this.render();
  }

  zoomBy(factor) {
    this.zoom = clamp(this.zoom * factor, 0.65, 2.5);
    this.render();
  }

  render() {
    if (this.disposed || this.contextLost || !this.root || document.hidden || !this.element.getClientRects().length) return;
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!width || !height) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== width || size.y !== height) this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    const direction = new THREE.Vector3(Math.sin(this.pitch) * Math.sin(this.yaw), Math.cos(this.pitch), Math.sin(this.pitch) * Math.cos(this.yaw));
    const right = new THREE.Vector3(0, 1, 0).cross(direction).normalize();
    const up = direction.clone().cross(right);
    const tanY = Math.tan(this.camera.fov * Math.PI / 360), tanX = tanY * this.camera.aspect;
    // Fit visible bounds in both axes at every orbit angle, including mobile stages.
    let distance = 0;
    for (const point of this.corners) {
      distance = Math.max(distance, Math.abs(point.dot(right)) / tanX + point.dot(direction), Math.abs(point.dot(up)) / tanY + point.dot(direction));
    }
    this.camera.position.copy(direction.multiplyScalar(distance * 1.2 / this.zoom));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    this.zoomOut.disabled = this.zoom <= 0.65;
    this.zoomIn.disabled = this.zoom >= 2.5;
    this.canvas.dataset.ready = 'true';
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.events.abort();
    this.resize.disconnect();
    this.pointers.clear();
    this.clearModel();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.element.remove();
  }
}
