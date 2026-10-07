/**
 * Seat reticles on one viewport canvas: tank barrel impact marker with the
 * desired-aim circle and reload arc, helicopter rocket pip at convergence,
 * chin-gun gimbal box, door-gun arc limits, hitscan mount crosshair, jet gun
 * funnel with lead pipper and speed / altitude tapes, and the locker box for
 * our own lock attempt. Models come from reticleModel / lockerModel.
 */
import { el } from '../hud-support.js';

const AMBER = '#ffcf5c', WHITE = '#f4f7f9', RED = '#ff4b4b', GREEN = '#7ef29a', CYAN = '#4cc3ff';
const TAU = Math.PI * 2;

function shadowed(ctx, draw) {
  ctx.save();
  ctx.strokeStyle = '#000000a0';
  ctx.lineWidth += 2;
  draw();
  ctx.restore();
  draw();
}

export class Reticles {
  constructor(parent) {
    this.canvas = el('canvas', 'cq-reticles', parent);
    this.canvas.setAttribute('aria-hidden', 'true');
    this.context = this.canvas.getContext?.('2d') ?? null;
    this._w = 0; this._h = 0; this._dpr = 1;
    this._blank = true;
    this.reserved = [];
  }

  _resize(width, height) {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (width !== this._w || height !== this._h || dpr !== this._dpr) {
      this._w = width; this._h = height; this._dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    return dpr;
  }

  clear() {
    this.reserved = [];
    if (this._blank || !this.context) return;
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._blank = true;
  }

  /**
   * `touch` lays the gimbal box out for phones (beside the crosshair in
   * landscape, above the tap-to-exit prompt in portrait). After a draw,
   * `reserved` lists the screen rects of the fixed instruments (gimbal box,
   * jet tapes) that edge-clamped flag markers keep clear of.
   */
  draw(model, locker, width, height, { touch = false } = {}) {
    this.reserved = [];
    const ctx = this.context;
    if (!ctx) return;
    if (!model && !locker) { this.clear(); return; }
    const dpr = this._resize(width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.font = '700 11px "Rajdhani", "Barlow Condensed", system-ui, sans-serif';
    ctx.textAlign = 'center';
    this._blank = false;
    if (model) {
      switch (model.kind) {
        case 'tank': this._tank(ctx, model); break;
        case 'pods': this._pods(ctx, model); break;
        case 'gimbal': this._gimbal(ctx, model, width, height, touch); break;
        case 'door': this._door(ctx, model, width, height); break;
        case 'jet': this._jet(ctx, model, width, height); break;
        case 'flight': break;
        case 'mg': this._mg(ctx, model); break;
        default: break;
      }
    }
    if (locker) this._locker(ctx, locker, width, height);
  }

  _text(ctx, text, x, y, color = WHITE) {
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = '#000000b0'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
    ctx.restore();
  }

  _tank(ctx, m) {
    const { x, y } = m.center;
    // Desired aim: dashed circle on the camera ray.
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffffb0';
    ctx.setLineDash([4, 4]);
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 20, 0, TAU); ctx.stroke(); });
    ctx.setLineDash([]);
    // Reload arc around the aim circle (clockwise as the breech reloads).
    const progress = 1 - Math.max(0, Math.min(1, m.reload));
    ctx.lineWidth = 3; ctx.strokeStyle = m.ready ? GREEN : AMBER;
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 26, -Math.PI / 2, -Math.PI / 2 + TAU * progress); ctx.stroke(); });
    // Barrel impact marker where the gun actually points.
    if (m.impact) {
      const { x: ix, y: iy } = m.impact;
      ctx.lineWidth = 2; ctx.strokeStyle = m.aligned ? GREEN : WHITE;
      shadowed(ctx, () => {
        ctx.beginPath();
        ctx.moveTo(ix - 12, iy); ctx.lineTo(ix - 4, iy); ctx.moveTo(ix + 4, iy); ctx.lineTo(ix + 12, iy);
        ctx.moveTo(ix, iy + 4); ctx.lineTo(ix, iy + 12);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(ix, iy, 1.6, 0, TAU); ctx.stroke();
      });
    }
    this._text(ctx, m.ready ? `${m.label} · READY` : `${m.label} · LOADING`, x, y + 46, m.ready ? GREEN : AMBER);
  }

  _pods(ctx, m) {
    const p = m.pip ?? m.center;
    ctx.lineWidth = 2; ctx.strokeStyle = AMBER;
    shadowed(ctx, () => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x - 22, p.y); ctx.lineTo(p.x - 14, p.y); ctx.moveTo(p.x + 14, p.y); ctx.lineTo(p.x + 22, p.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, TAU); ctx.stroke();
    });
    if (m.reload > 0) {
      ctx.lineWidth = 3; ctx.strokeStyle = WHITE;
      shadowed(ctx, () => { ctx.beginPath(); ctx.arc(p.x, p.y, 19, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - m.reload)); ctx.stroke(); });
    }
    const ammo = m.reload > 0 ? 'RELOADING' : Number.isFinite(m.ammo) ? `${m.ammo} RKT` : 'RKT';
    this._text(ctx, `${ammo} · ${m.convergence} M`, p.x, p.y + 36, m.reload > 0 ? WHITE : AMBER);
  }

  _gimbal(ctx, m, width, height, touch = false) {
    const { x, y } = m.center;
    // Crosshair on the camera ray (the chin camera looks along the gun).
    ctx.lineWidth = 1.5; ctx.strokeStyle = m.overheated ? RED : WHITE;
    shadowed(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(x - 16, y); ctx.lineTo(x - 6, y); ctx.moveTo(x + 6, y); ctx.lineTo(x + 16, y);
      ctx.moveTo(x, y - 16); ctx.lineTo(x, y - 6); ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 16);
      ctx.stroke();
    });
    // Gimbal box: the gun's yaw / pitch envelope with the current pointing dot. On phones the
    // tap-to-exit prompt sits under the crosshair (portrait 50% + 120 px, landscape 108 px above
    // the bottom), so the box goes beside the crosshair (landscape) or ends above the prompt.
    const bw = touch ? Math.min(120, width * 0.3) : Math.min(170, width * 0.3), bh = bw * 0.42;
    const beside = touch && width > height;
    const bx = beside ? x + 80 : x - bw / 2;
    const by = beside ? y - bh / 2 + 24 : touch ? Math.min(y + 70, height / 2 + 120 - bh - 18) : Math.min(height - bh - 24, y + 70);
    this.reserved.push({ left: bx - 4, top: by - 20, right: bx + bw + 4, bottom: by + bh + 12 });
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff90';
    shadowed(ctx, () => { ctx.strokeRect(bx, by, bw, bh); });
    const u = 0.5 - (m.yaw / m.yawLimit) / 2;
    const v = (m.pitchMax - m.pitch) / (m.pitchMax - m.pitchMin);
    const dx = bx + Math.max(0, Math.min(1, u)) * bw, dy = by + Math.max(0, Math.min(1, v)) * bh;
    ctx.fillStyle = m.overheated ? RED : AMBER;
    ctx.beginPath(); ctx.arc(dx, dy, 4, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#ffffff40'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx + bw / 2, by); ctx.lineTo(bx + bw / 2, by + bh); ctx.stroke();
    // Heat bar under the box.
    ctx.fillStyle = '#0008'; ctx.fillRect(bx, by + bh + 6, bw, 4);
    ctx.fillStyle = m.overheated ? RED : m.heat > 0.75 ? AMBER : CYAN; ctx.fillRect(bx, by + bh + 6, bw * m.heat, 4);
    this._text(ctx, m.overheated ? 'OVERHEAT' : '25MM CHIN · GIMBAL', bx + bw / 2, by - 6, m.overheated ? RED : WHITE);
  }

  _door(ctx, m, width) {
    const { x, y } = m.center;
    ctx.lineWidth = 1.5; ctx.strokeStyle = m.overheated ? RED : WHITE;
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 10, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 1.5, 0, TAU); ctx.stroke(); });
    // Arc limit bracket: the traverse window and where the gun sits in it.
    const r = Math.min(150, width * 0.22);
    const span = m.arc;
    ctx.lineWidth = 3; ctx.strokeStyle = m.atLimit ? RED : '#ffffff70';
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, r, -Math.PI / 2 - span / 2, -Math.PI / 2 + span / 2); ctx.stroke(); });
    const t = -Math.PI / 2 - (m.offset / m.arc) * (span / 2);
    ctx.fillStyle = m.atLimit ? RED : AMBER;
    ctx.beginPath(); ctx.arc(x + Math.cos(t) * r, y + Math.sin(t) * r, 4.5, 0, TAU); ctx.fill();
    for (const end of [-1, 1]) {
      const a = -Math.PI / 2 + end * span / 2;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * (r - 7), y + Math.sin(a) * (r - 7)); ctx.lineTo(x + Math.cos(a) * (r + 7), y + Math.sin(a) * (r + 7));
      ctx.strokeStyle = m.atLimit ? RED : WHITE; ctx.lineWidth = 2; ctx.stroke();
    }
    this._text(ctx, m.atLimit ? 'ARC LIMIT' : m.overheated ? 'OVERHEAT' : `DOOR GUN · ${m.side.toUpperCase()}`, x, y + 34, m.atLimit || m.overheated ? RED : WHITE);
  }

  _mg(ctx, m) {
    const p = m.barrel ?? m.center;
    ctx.lineWidth = 1.5; ctx.strokeStyle = m.overheated ? RED : WHITE;
    shadowed(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(p.x - 13, p.y); ctx.lineTo(p.x - 5, p.y); ctx.moveTo(p.x + 5, p.y); ctx.lineTo(p.x + 13, p.y);
      ctx.moveTo(p.x, p.y + 5); ctx.lineTo(p.x, p.y + 13);
      ctx.stroke();
    });
    if (m.heat > 0) {
      ctx.lineWidth = 2.5; ctx.strokeStyle = m.overheated ? RED : m.heat > 0.75 ? AMBER : CYAN;
      shadowed(ctx, () => { ctx.beginPath(); ctx.arc(p.x, p.y, 18, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * m.heat); ctx.stroke(); });
    }
  }

  _jet(ctx, m, width, height) {
    const b = m.boresight ?? m.center;
    // Speed (left) and altitude (right) tapes, drawn first so projected symbology (pipper, target box) stays on top.
    const tapeH = Math.min(220, height * 0.36), top = height / 2 - tapeH / 2;
    const tape = (x, value, step, unit, align) => {
      this.reserved.push({ left: x - 34, top: top - 18, right: x + 34, bottom: top + tapeH });
      ctx.save();
      ctx.beginPath(); ctx.rect(x - 34, top, 68, tapeH); ctx.clip();
      ctx.fillStyle = '#05090cb0'; ctx.fillRect(x - 34, top, 68, tapeH);
      ctx.strokeStyle = '#7ef29a90'; ctx.lineWidth = 1; ctx.fillStyle = '#c9f7d6';
      ctx.font = '600 10px "Rajdhani", system-ui, sans-serif'; ctx.textAlign = align === 'left' ? 'right' : 'left';
      const pxPer = tapeH / (step * 6);
      const base = Math.floor(value / step) * step;
      for (let k = -4; k <= 4; k++) {
        const v = base + k * step, y = height / 2 - (v - value) * pxPer;
        const tick = align === 'left' ? x + 34 : x - 34, dir = align === 'left' ? -1 : 1;
        ctx.beginPath(); ctx.moveTo(tick, y); ctx.lineTo(tick + dir * 8, y); ctx.stroke();
        if (v >= 0) ctx.fillText(String(v), tick + dir * 11, y + 3);
      }
      ctx.restore();
      ctx.fillStyle = '#0b1218'; ctx.strokeStyle = GREEN; ctx.lineWidth = 1.5;
      ctx.fillRect(x - 30, height / 2 - 11, 60, 22); ctx.strokeRect(x - 30, height / 2 - 11, 60, 22);
      ctx.fillStyle = GREEN; ctx.font = '700 14px "Rajdhani", system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(String(Math.round(value)), x, height / 2 + 5);
      ctx.font = '700 10px "Rajdhani", system-ui, sans-serif';
      this._text(ctx, unit, x, top - 6, '#c9f7d6');
    };
    const gap = Math.min(260, width * 0.26);
    tape(width / 2 - gap, m.speedKmh, 50, 'KM/H', 'left');
    tape(width / 2 + gap, m.altitude, 20, 'ALT M', 'right');
    // Boresight cross.
    ctx.lineWidth = 1.5; ctx.strokeStyle = GREEN;
    shadowed(ctx, () => {
      ctx.beginPath(); ctx.moveTo(b.x - 10, b.y); ctx.lineTo(b.x + 10, b.y); ctx.moveTo(b.x, b.y - 10); ctx.lineTo(b.x, b.y + 10); ctx.stroke();
    });
    // Gun funnel: walls converge on the boresight from below (bullet drop envelope).
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#7ef29ab0';
    shadowed(ctx, () => {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(b.x + side * 9, b.y + 4);
        ctx.quadraticCurveTo(b.x + side * 16, b.y + 70, b.x + side * 46, b.y + 150);
        ctx.stroke();
      }
    });
    if (m.pipper) {
      const p = m.pipper;
      ctx.lineWidth = 2; ctx.strokeStyle = AMBER;
      shadowed(ctx, () => { ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, TAU); ctx.stroke(); });
      this._text(ctx, `${p.range} M`, p.x, p.y - 17, AMBER);
    }
    if (m.target) {
      const t = m.target;
      ctx.lineWidth = 1.5; ctx.strokeStyle = RED;
      shadowed(ctx, () => { ctx.strokeRect(t.x - 14, t.y - 14, 28, 28); });
    }
    if (m.heat > 0) {
      ctx.fillStyle = '#0008'; ctx.fillRect(width / 2 - 40, height / 2 + 60, 80, 3);
      ctx.fillStyle = m.heat >= 0.999 ? RED : m.heat > 0.75 ? AMBER : GREEN; ctx.fillRect(width / 2 - 40, height / 2 + 60, 80 * m.heat, 3);
    }
  }

  _locker(ctx, locker, width, height) {
    const p = locker.box ?? { x: width / 2, y: height / 2 };
    const size = locker.locked ? 22 : 44 - 22 * locker.progress;
    const color = locker.locked ? RED : AMBER;
    ctx.lineWidth = 2; ctx.strokeStyle = color;
    shadowed(ctx, () => {
      const s = size, l = 9;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(p.x + sx * s, p.y + sy * (s - l)); ctx.lineTo(p.x + sx * s, p.y + sy * s); ctx.lineTo(p.x + sx * (s - l), p.y + sy * s);
      }
      ctx.stroke();
    });
    // Seeker progress ring (STINGER / AA missile): fills clockwise while the
    // lock builds and closes red once it is complete.
    const ring = size + 8, fill = Math.max(0, Math.min(1, locker.progress));
    ctx.lineWidth = 3; ctx.strokeStyle = color;
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(p.x, p.y, ring, -Math.PI / 2, -Math.PI / 2 + TAU * fill); ctx.stroke(); });
    this._text(ctx, locker.label, p.x, p.y + ring + 14, color);
  }
}
