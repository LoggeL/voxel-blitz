import { el } from './hud-support.js';

/** A local QR preview; the invite URL is never sent to a QR service. */
export class LobbyInviteQr {
  constructor(parent, navigation = null) {
    this.parent = parent;
    this.navigation = navigation;
    this.dialog = null;
    this.generation = 0;
  }

  get isOpen() { return !!this.dialog?.open; }

  async show(url, code, trigger) {
    const generation = ++this.generation;
    const { default: qrcode } = await import('../vendor/qrcode-generator-2.0.4.mjs');
    if (generation !== this.generation) return;
    if (!this.dialog) {
      const dialog = this.dialog = el('dialog', 'vb-invite-qr', this.parent, 'lobby-qr-dialog');
      dialog.setAttribute('aria-labelledby', 'lobby-qr-title');
      el('h2', '', dialog, 'lobby-qr-title').textContent = 'SCAN TO JOIN';
      this.code = el('div', 'vb-invite-qr-code', dialog);
      this.canvas = el('canvas', 'vb-invite-qr-image', dialog, 'lobby-qr-canvas');
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', 'Scan this QR code to join the lobby');
      this.link = el('div', 'vb-invite-qr-link', dialog);
      const close = el('button', 'vb-btn', dialog, 'lobby-qr-close');
      close.type = 'button';
      close.textContent = 'CLOSE';
      close.addEventListener('click', () => this.close());
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
      dialog.addEventListener('keydown', (event) => event.stopPropagation());
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right ||
            event.clientY < rect.top || event.clientY > rect.bottom) this.close();
      });
    }
    const qr = qrcode(0, 'M');
    qr.addData(new URL(url).href);
    qr.make();
    const modules = qr.getModuleCount();
    const quietZone = 4;
    const cell = 8;
    this.canvas.width = this.canvas.height = (modules + quietZone * 2) * cell;
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#000';
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) ctx.fillRect((col + quietZone) * cell, (row + quietZone) * cell, cell, cell);
      }
    }
    this.code.textContent = code;
    this.link.textContent = url;
    this.trigger = trigger;
    if (!this.dialog.open) this.dialog.showModal();
    this.navigation?.open(this, () => this.close());
  }

  close() {
    ++this.generation;
    this.navigation?.close(this);
    if (this.dialog?.open) {
      this.dialog.close();
      this.trigger?.focus();
    }
  }
}
