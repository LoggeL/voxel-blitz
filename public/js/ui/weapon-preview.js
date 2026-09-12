import * as THREE from '../vendor/three.module.js';
import { MaterialCache } from '../guns/kit.js';
import { buildGun, disposeGunModels } from '../guns/assemble.js';
import { applyAttachmentModel } from '../guns/attachment-model.js';

export class WeaponPreview {
  constructor(container) {
    this.container = container;
    this.cache = new MaterialCache();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'Weapon preview. Drag to rotate.');
    container.append(this.renderer.domElement);
    this.scene.add(new THREE.HemisphereLight(0xe5f2ff, 0x41465a, 3));
    const key = new THREE.DirectionalLight(0xffffff, 4); key.position.set(2,3,1); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xffb547, 3); rim.position.set(-2,1,-2); this.scene.add(rim);
    this.resize = new ResizeObserver(() => this.render()); this.resize.observe(container);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', event => { this.dragX = event.clientX; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', event => {
      if (this.dragX === null || this.dragX === undefined || !this.model) return;
      this.model.root.rotation.y += (event.clientX - this.dragX) * 0.01;
      this.dragX = event.clientX; this.render();
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => { this.dragX = null; });
  }
  show(id, selection) {
    if (this.id !== id) {
      disposeGunModels(this.model ? [this.model] : [], this.cache);
      this.id = id; this.model = buildGun(id, this.cache);
      this.model.root.traverse(o => { if (o.name === 'hand_l' || o.name === 'hand_r') o.visible = false; });
      this.model.flash.grp.visible = false;
      this.scene.add(this.model.root);
      const bounds = new THREE.Box3().setFromObject(this.model.root);
      this.center = bounds.getCenter(new THREE.Vector3());
      this.size = bounds.getSize(new THREE.Vector3());
    }
    applyAttachmentModel(this.model, id, selection); this.render();
  }
  render() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h || !this.model) return;
    this.renderer.setSize(w,h,false);
    this.camera.aspect = w/h;
    const distance = Math.max(this.size.z / this.camera.aspect, this.size.y + this.size.x * 0.25) / (2 * Math.tan(16 * Math.PI/180)) * 1.3;
    this.camera.position.copy(this.center).add(new THREE.Vector3(1,0.25,0.22).normalize().multiplyScalar(distance));
    this.camera.lookAt(this.center); this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene,this.camera);
  }
  dispose() {
    this.resize.disconnect(); disposeGunModels(this.model ? [this.model] : [],this.cache);
    this.model = null; this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
