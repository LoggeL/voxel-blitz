// AX-9 seeker feedback reads the same frame state as the launch gate. It never
// advances the lock itself: a lost target, empty tube or reload clears it at once.
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const AMBER = 0xe7ab38;
const GREEN = 0x74e5b3;
const RED = 0xe15d42;

export class StingerPresentation {
  constructor(model) {
    this.parts = model?.extra?.userData?.stinger;
    this.reset();
  }

  reset(state = null) {
    this.time = 0;
    this.shotT = null;
    this.dryT = null;
    this.setState(state);
    if (this.parts?.seeker) this.parts.seeker.rotation.set(0, 0, 0);
    this.update(0);
  }

  setState(state) {
    this.mag = Math.max(0, Math.trunc(Number(state?.mag) || 0));
    this.reloading = !!state?.reloading;
    this.lockProgress = this.mag > 0 && !this.reloading ? clamp01(state?.lockProgress) : 0;
    if (this.parts) this.parts.authoritativeMag = this.mag;
    // State changes land before rendering, including a shot on this frame.
    this._lights();
    if (this.parts?.frontCover && !this.reloading) this.parts.frontCover.visible = this.mag > 0;
  }

  fire() {
    this.shotT = 0;
    this.mag = Math.max(0, this.mag - 1);
    if (this.parts) this.parts.authoritativeMag = this.mag;
    this.lockProgress = 0;
    if (this.parts?.frontCover) this.parts.frontCover.visible = false;
    this._lights();
  }

  dryFire() { this.dryT = 0; }

  update(dt, { reloading = false } = {}) {
    const elapsed = Math.max(0, Number(dt) || 0);
    this.time += elapsed;
    if (this.shotT !== null && (this.shotT += elapsed) > 0.4) this.shotT = null;
    if (this.dryT !== null && (this.dryT += elapsed) > 0.18) this.dryT = null;
    const parts = this.parts;
    if (!parts) return;
    const active = this.mag > 0 && !this.reloading && !reloading;
    const searching = active && this.lockProgress < 1;
    const settle = this.shotT === null ? 0 : Math.sin(Math.PI * this.shotT / 0.4) * (1 - this.shotT / 0.4);
    if (parts.seeker) {
      // The small gimbal searches until a confirmed lock holds it centred.
      parts.seeker.rotation.y = searching ? Math.sin(this.time * 2.8) * 0.07 * (1 - this.lockProgress) : 0;
      parts.seeker.rotation.x = (searching ? Math.sin(this.time * 2.1) * 0.026 * (1 - this.lockProgress) : 0) + settle * 0.09;
    }
    this._lights(reloading);
    // WeaponActions owns the fresh cover while its canister travels into place.
    if (parts.frontCover && !this.reloading && !reloading) parts.frontCover.visible = this.mag > 0;
  }

  _lights(actionReloading = false) {
    const parts = this.parts;
    if (!parts) return;
    const reloading = this.reloading || actionReloading;
    const loaded = this.mag > 0 && !reloading;
    const progress = loaded ? this.lockProgress : 0;
    const locked = progress >= 1;
    const lamps = parts.lamps || [];
    const count = Math.floor(progress * lamps.length + 1e-6);
    const pulse = this.dryT === null ? 0 : Math.sin(Math.PI * this.dryT / 0.18);
    for (let i = 0; i < lamps.length; i++) {
      const material = lamps[i].material;
      material.color.setHex(i < count ? (locked ? GREEN : AMBER) : 0x172824);
      material.emissive?.setHex(locked ? GREEN : AMBER);
      material.emissiveIntensity = i < count ? (locked ? 1.8 : 1.15) : 0.035;
    }
    if (parts.statusLamp) {
      const material = parts.statusLamp.material;
      const color = locked ? GREEN : loaded || reloading ? AMBER : RED;
      material.color.setHex(color);
      material.emissive?.setHex(color);
      material.emissiveIntensity = (locked ? 1.8 : reloading ? 0.22 : loaded ? 0.55 : 0.16) + pulse;
    }
  }
}

const presentations = new WeakMap();
export function stingerPresentationFor(model) {
  if (!model?.extra?.userData?.stinger) return null;
  let presentation = presentations.get(model);
  if (!presentation) {
    presentation = new StingerPresentation(model);
    presentations.set(model, presentation);
  }
  return presentation;
}
