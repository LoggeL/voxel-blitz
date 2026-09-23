/** Full-screen black for the local death cut. Opacity only; it never takes input. */
export class DeathFade {
  constructor(parent = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'vb-death-fade';
    this.el.id = 'death-fade';
    this.el.setAttribute('aria-hidden', 'true');
    parent.append(this.el);
    this.value = 0;
    this.dying = false;
  }

  /** `dying` marks the head flight so the spectator overlay stays out of it. */
  set(opacity, dying = false) {
    if (dying !== this.dying) {
      this.dying = dying;
      this.el.ownerDocument.body.classList.toggle('is-dying', dying);
    }
    const value = Math.round(Math.max(0, Math.min(1, Number(opacity) || 0)) * 1000) / 1000;
    if (value === this.value) return;
    this.value = value;
    this.el.style.opacity = String(value);
  }

  dispose() {
    this.set(0, false);
    this.el.remove();
  }
}
