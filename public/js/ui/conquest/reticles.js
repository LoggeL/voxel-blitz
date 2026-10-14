/**
 * Seat reticles on one viewport canvas: tank shell impact marker (with drop,
 * range readout and a 100 m range ladder) plus the desired-aim circle and
 * reload arc, helicopter rocket pip at convergence,
 * chin-gun gimbal box (and, through the gimbal sensor sight, its optic:
 * bracket frame, bar reticle, barrel pip, range / heading / zoom readouts),
 * door-gun arc limits, hitscan mount crosshair, the tank hull indicator
 * (top-down hull and turret, turned as seen from the view), jet gun
 * funnel with lead pipper, the pilot instruments (speed / AGL tapes, climb,
 * throttle, stall) with the mouse-aim circle, and the locker box for our own
 * lock attempt. Models come from reticleModel / lockerModel.
 */
import { el } from '../hud-support.js';
import { clampToEdge } from './projection.js';

const AMBER = '#ffcf5c', WHITE = '#f4f7f9', RED = '#ff4b4b', GREEN = '#7ef29a', CYAN = '#4cc3ff';
/** Gimbal sensor symbology: pale phosphor green-white over the monochrome world. */
const SENSOR = '#dcffe6', SENSOR_DIM = '#dcffe699';
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
    /** Screen rect of the tank hull indicator after the last draw, else null. */
    this.hullBox = null;
    /** Screen rects of the tank driver's periscope instruments ({ bar, tape }) after the last draw, else null. */
    this.driverBoxes = null;
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
    this.hullBox = null;
    this.driverBoxes = null;
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
    this.hullBox = null;
    this.driverBoxes = null;
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
      // Pilot instruments first, so projected symbology stays on top.
      if (model.flight) this._instruments(ctx, model.flight, width, height);
      switch (model.kind) {
        case 'tank': if (model.periscope) this._periscope(ctx, model, width, height, touch); else this._tank(ctx, model); break;
        case 'pods': this._pods(ctx, model); break;
        case 'gimbal': this._gimbal(ctx, model, width, height, touch); break;
        case 'door': this._door(ctx, model, width, height); break;
        case 'jet': this._jet(ctx, model, width, height); break;
        case 'flight': this._nose(ctx, model.nose); break;
        case 'mg': this._mg(ctx, model); break;
        default: break;
      }
      if (model.hull) this._hull(ctx, model.hull, width, height, touch);
      if (model.aim) this._aimCircle(ctx, model.center, model.kind === 'jet' ? model.boresight : model.kind === 'pods' ? model.pip : model.nose);
    }
    if (locker) this._locker(ctx, locker, width, height);
  }

  _text(ctx, text, x, y, color = WHITE) {
    ctx.save();
    // Round joins: a mitred outline spikes off sharp glyphs (M, V, W).
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3; ctx.strokeStyle = '#000000b0'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
    ctx.restore();
  }

  _tank(ctx, m) {
    const { x, y } = m.center;
    this._aimRing(ctx, x, y, m);
    this._shellMarks(ctx, m);
    this._text(ctx, m.ready ? `${m.label} · READY` : `${m.label} · LOADING`, x, y + 46, m.ready ? GREEN : AMBER);
  }

  /** Desired aim: a dashed circle with the reload arc around it (clockwise as the breech reloads). */
  _aimRing(ctx, x, y, m) {
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffffb0';
    ctx.setLineDash([4, 4]);
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 20, 0, TAU); ctx.stroke(); });
    ctx.setLineDash([]);
    const progress = 1 - Math.max(0, Math.min(1, m.reload));
    ctx.lineWidth = 3; ctx.strokeStyle = m.ready ? GREEN : AMBER;
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 26, -Math.PI / 2, -Math.PI / 2 + TAU * progress); ctx.stroke(); });
  }

  /** The shell's range ladder and the impact marker with its range readout. */
  _shellMarks(ctx, m) {
    // Range ladder: the shell's arc at 100 m steps below the bore (labels in hundreds of metres).
    let lastY = -Infinity;
    for (const tick of m.ladder ?? []) {
      if (Math.abs(tick.y - lastY) < 9) continue;
      lastY = tick.y;
      // Stadia marks start just left of the arc point, clear of the impact marker's right arm.
      const length = tick.range % 200 === 0 ? 10 : 6, x0 = tick.x - 14 - length;
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffffc0';
      shadowed(ctx, () => { ctx.beginPath(); ctx.moveTo(x0, tick.y); ctx.lineTo(x0 + length, tick.y); ctx.stroke(); });
      ctx.save();
      ctx.font = '700 10px "Rajdhani", "Barlow Condensed", system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = '#000000b0'; ctx.strokeText(String(tick.range / 100), x0 - 3, tick.y);
      ctx.fillStyle = '#ffffffd0'; ctx.fillText(String(tick.range / 100), x0 - 3, tick.y);
      ctx.restore();
    }
    // Barrel impact marker where the shell lands (terrain, with drop).
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
      if (Number.isFinite(m.range)) {
        ctx.save(); ctx.textAlign = 'left';
        this._text(ctx, m.airburst ? `AIRBURST ${m.range} M` : `${m.range} M`, ix + 16, iy - 6, m.aligned ? GREEN : WHITE);
        ctx.restore();
      }
    }
  }

  /**
   * Top-down tank at (cx, cy): the white hull (track strips, front chevron,
   * amber once it faces away) turned by `hull`, the green turret ring and
   * barrel turned by `turret` (rad, +left = counter-clockwise), and a faint
   * wedge on the side the tracks drive (`travel` +1 / -1 / 0).
   */
  _silhouette(ctx, cx, cy, scale, hull, turret, travel) {
    const halfW = 15 * scale, halfL = 23 * scale, track = 5 * scale;
    // The view looks up the screen; +yaw is left, so a hull offset turns the drawing counter-clockwise.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.save();
    ctx.rotate(-hull);
    if (travel) {
      // Faint wedge on the side the tracks are driving (behind the hull while reversing).
      const dir = travel, r0 = halfL + 3 * scale, r1 = halfL + 22 * scale;
      const grad = ctx.createLinearGradient?.(0, -dir * r0, 0, -dir * r1);
      grad?.addColorStop(0, '#ffffff38'); grad?.addColorStop(1, '#ffffff00');
      ctx.fillStyle = grad ?? '#ffffff22';
      ctx.beginPath();
      ctx.moveTo(-halfW * 0.7, -dir * r0); ctx.lineTo(halfW * 0.7, -dir * r0);
      ctx.lineTo(halfW * 1.25, -dir * r1); ctx.lineTo(-halfW * 1.25, -dir * r1);
      ctx.closePath(); ctx.fill();
    }
    // Hull with a bevelled glacis and the two track strips, on a dark fill so it reads over bright ground.
    const bevel = 5 * scale;
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-halfW + bevel, -halfL); ctx.lineTo(halfW - bevel, -halfL); ctx.lineTo(halfW, -halfL + bevel);
      ctx.lineTo(halfW, halfL); ctx.lineTo(-halfW, halfL); ctx.lineTo(-halfW, -halfL + bevel); ctx.closePath();
    };
    outline(); ctx.fillStyle = '#05090ca8'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = WHITE; ctx.lineJoin = 'round';
    shadowed(ctx, () => {
      outline();
      ctx.moveTo(-halfW + track, -halfL + bevel); ctx.lineTo(-halfW + track, halfL);
      ctx.moveTo(halfW - track, -halfL + bevel); ctx.lineTo(halfW - track, halfL);
      ctx.stroke();
    });
    const tip = -halfL - 12 * scale, base = -halfL - 3 * scale;
    ctx.fillStyle = Math.abs(hull) > Math.PI / 2 ? AMBER : WHITE;
    ctx.beginPath(); ctx.moveTo(0, tip); ctx.lineTo(8 * scale, base); ctx.lineTo(-8 * scale, base); ctx.closePath();
    ctx.lineWidth = 3; ctx.strokeStyle = '#000000a0'; ctx.stroke(); ctx.fill();
    ctx.restore();
    // Turret ring and barrel.
    ctx.save();
    ctx.rotate(-turret);
    ctx.lineWidth = 2; ctx.strokeStyle = GREEN;
    shadowed(ctx, () => {
      ctx.beginPath(); ctx.arc(0, 0, 8.5 * scale, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -8.5 * scale); ctx.lineTo(0, -31 * scale); ctx.stroke();
    });
    ctx.restore();
    ctx.restore();
  }

  /**
   * Tank hull indicator (docs/design/conquest/tank-hud/, variant A): a top-down
   * tank whose turret and barrel point where the gun points and whose hull is
   * turned by the hull's offset from the view, so the front chevron shows
   * where W drives. Desktop: centred above the exit prompt, readouts beside
   * it. Phones: smaller, readouts under it, below the prompt (portrait) or
   * left of it (landscape).
   */
  _hull(ctx, h, width, height, touch = false) {
    const landscape = touch && width > height;
    const scale = touch ? (landscape ? 0.72 : 0.86) : 1.2;
    const cx = landscape ? width / 2 - 128 : width / 2;
    const cy = !touch ? height - 242 : landscape ? height - 92 : Math.min(height / 2 + 206, height - 150);
    const halfL = 23 * scale;
    this._silhouette(ctx, cx, cy, scale, h.hull, h.turret, h.travel);
    // Readouts: how far the hull is turned from the view (arrow to its side) and the hull heading.
    const offset = Math.abs(h.offset) < 3 ? 'HULL AHEAD' : `${h.offset > 0 ? '\u25C0' : '\u25B6'} ${Math.abs(h.offset)}\u00B0`;
    const heading = `HULL ${String(h.heading).padStart(3, '0')}\u00B0`;
    const reach = halfL + 22 * scale;
    let box;
    ctx.save();
    ctx.textBaseline = 'middle';
    if (!touch) {
      ctx.textAlign = 'left';
      ctx.font = '700 12px "Rajdhani", "Barlow Condensed", system-ui, sans-serif';
      this._text(ctx, heading, cx + reach + 8, cy - 9, WHITE);
      ctx.font = '700 14px "Rajdhani", "Barlow Condensed", system-ui, sans-serif';
      this._text(ctx, offset, cx + reach + 8, cy + 9, GREEN);
      box = { left: cx - reach, top: cy - reach, right: cx + reach + 86, bottom: cy + reach };
    } else {
      ctx.textAlign = 'center';
      ctx.font = '700 11px "Rajdhani", "Barlow Condensed", system-ui, sans-serif';
      const line = Math.abs(h.offset) < 3 ? `HULL AHEAD \u00B7 ${String(h.heading).padStart(3, '0')}\u00B0` : `${offset} \u00B7 ${heading}`;
      this._text(ctx, line, cx, cy + reach + 8, GREEN);
      box = { left: cx - Math.max(reach, 56), top: cy - reach, right: cx + Math.max(reach, 56), bottom: cy + reach + 15 };
    }
    ctx.restore();
    this.hullBox = box;
    this.reserved.push(box);
  }

  /**
   * Tank driver's periscope (DRIVER view; docs/design/conquest/tank-hud/driver-view/,
   * variant B): the screen centre is the hull's nose, so the gun's marks are
   * wherever the gun points. The aim ring sits on the mouse aim, the ladder and
   * impact marker where the shell lands; an impact outside the periscope window
   * slides to its edge as a GUN arrow. The instruments come from `m.driver`.
   */
  _periscope(ctx, m, width, height, touch = false) {
    const frame = this._driverHud(ctx, m.driver, width, height, touch);
    const a = m.aimMark;
    if (a?.inside) this._aimRing(ctx, a.x, a.y, m);
    const raw = m.impactRaw;
    const within = raw && raw.inside && raw.x >= frame.left && raw.x <= width - frame.right && raw.y >= frame.top && raw.y <= height - frame.bottom;
    if (within) { this._shellMarks(ctx, m); return; }
    if (!raw) return;
    // Off the window: an arrow on its edge toward where the gun points.
    const edge = clampToEdge({ x: raw.x, y: raw.y, inside: false }, width, height, frame);
    ctx.save();
    ctx.translate(edge.x, edge.y);
    ctx.rotate(edge.angle);
    ctx.fillStyle = m.ready ? GREEN : AMBER; ctx.lineWidth = 3; ctx.strokeStyle = '#000000a0';
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(9, 4); ctx.lineTo(0, -1); ctx.lineTo(-9, 4); ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
    const dx = Math.sin(edge.angle), dy = -Math.cos(edge.angle);
    this._text(ctx, 'GUN', edge.x - dx * 22, edge.y - dy * 22 + 4, m.ready ? GREEN : AMBER);
  }

  /**
   * The periscope instruments: corner brackets, the hull heading tape (with
   * the gun's bearing on it) and the instrument bar (speed and gear, the
   * turret over the fixed hull, the main gun's load, hull integrity and
   * smoke). Phones get one compact panel in the vehicle card's place (which
   * hides in this view) and, in landscape, a shorter tape. Returns the
   * periscope window insets the gun marks keep inside.
   */
  _driverHud(ctx, d, width, height, touch = false) {
    const landscape = touch && width > height;
    const MINT = '#c9f7d6', PANEL = '#0a0e16d0', EDGE = '#ffffff2e';
    const font = (size, weight = 700) => `${weight} ${size}px "Rajdhani", "Barlow Condensed", system-ui, sans-serif`;
    const pad = n => String(n).padStart(3, '0');
    const gun = !d ? '' : Math.abs(d.gunOffset) < 3 ? 'GUN AHEAD' : `GUN ${d.gunOffset > 0 ? '\u25C0' : '\u25B6'} ${Math.abs(d.gunOffset)}\u00B0`;
    const boxes = {};
    // Corner brackets of the periscope window (desktop; a phone screen is all window).
    const inset = 18, arm = 30;
    ctx.save();
    if (!touch) {
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffffffb0';
    shadowed(ctx, () => {
      ctx.beginPath();
      for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const x = sx ? width - inset : inset, y = sy ? height - inset : inset, hx = sx ? -arm : arm, vy = sy ? -arm : arm;
        ctx.moveTo(x + hx, y); ctx.lineTo(x, y); ctx.lineTo(x, y + vy);
      }
      ctx.stroke();
    });
    }
    ctx.restore();
    if (!d) return { top: 80, bottom: 96, left: 40, right: 40 };
    // Heading tape under the ticket bar and the V view strip (not on portrait
    // phones: the panel carries the heading).
    let tapeBottom = touch ? 64 : 96;
    if (!touch || landscape) {
      const tw = touch ? Math.min(250, width * 0.3) : Math.min(440, width * 0.32), th = touch ? 20 : 26;
      const tx = width / 2 - tw / 2, ty = touch ? 94 : 136, span = touch ? 70 : 90, pxPer = tw / span;
      ctx.save();
      ctx.fillStyle = PANEL; ctx.fillRect(tx, ty, tw, th);
      ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);
      ctx.beginPath(); ctx.rect(tx, ty, tw, th); ctx.clip();
      ctx.strokeStyle = '#ffffff90'; ctx.fillStyle = MINT; ctx.font = font(touch ? 9 : 10, 600); ctx.textAlign = 'center';
      const from = Math.floor((d.headingDeg - span / 2) / 5) * 5;
      for (let deg = from; deg <= d.headingDeg + span / 2 + 5; deg += 5) {
        const x = width / 2 + (deg - d.headingDeg) * pxPer, major = deg % 15 === 0;
        ctx.beginPath(); ctx.moveTo(x, ty + th); ctx.lineTo(x, ty + th - (major ? 7 : 4)); ctx.stroke();
        const norm = ((deg % 360) + 360) % 360;
        if (major) ctx.fillText(norm === 0 ? 'N' : norm === 90 ? 'E' : norm === 180 ? 'S' : norm === 270 ? 'W' : pad(norm), x, ty + (touch ? 10 : 12));
      }
      // The gun's bearing on the tape (it turns with the turret, the tape with the hull).
      const gx = width / 2 - (d.turret * 180 / Math.PI) * pxPer;
      if (gx > tx + 4 && gx < tx + tw - 4) {
        ctx.fillStyle = GREEN;
        ctx.beginPath(); ctx.moveTo(gx, ty + th - 1); ctx.lineTo(gx - 5, ty + th - 8); ctx.lineTo(gx + 5, ty + th - 8); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // Centre caret and the boxed hull heading.
      ctx.save();
      ctx.fillStyle = WHITE;
      ctx.beginPath(); ctx.moveTo(width / 2, ty + 7); ctx.lineTo(width / 2 - 5, ty); ctx.lineTo(width / 2 + 5, ty); ctx.closePath(); ctx.fill();
      const bw = touch ? 34 : 44, bh = touch ? 15 : 19, by = ty + th + 3;
      ctx.fillStyle = '#0b1218'; ctx.strokeStyle = '#ffffffa0'; ctx.lineWidth = 1;
      ctx.fillRect(width / 2 - bw / 2, by, bw, bh); ctx.strokeRect(width / 2 - bw / 2 + 0.5, by + 0.5, bw - 1, bh - 1);
      ctx.fillStyle = WHITE; ctx.font = font(touch ? 11 : 14); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pad(d.heading), width / 2, by + bh / 2 + 1);
      ctx.restore();
      boxes.tape = { left: tx, top: ty, right: tx + tw, bottom: by + bh };
      tapeBottom = by + bh;
    }
    // Instrument cells.
    const cell = (x, y, w, h) => {
      ctx.fillStyle = PANEL; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    };
    const speedCell = (x, y, w, h, big) => {
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = GREEN; ctx.font = font(big ? 40 : 20, 800);
      ctx.fillText(String(d.speedKmh), x + w / 2, y + (big ? 44 : 21));
      ctx.fillStyle = MINT; ctx.font = font(big ? 12 : 8);
      ctx.fillText('KM/H', x + w / 2, y + (big ? 59 : 31));
      // Gear row R N D with the active one boxed.
      const gw = big ? 24 : 15, gy = y + h - (big ? 30 : 16), gh = big ? 21 : 12;
      ['R', 'N', 'D'].forEach((g, i) => {
        const gx = x + w / 2 + (i - 1) * (gw + (big ? 6 : 3)) - gw / 2, on = g === d.gear;
        if (on) { ctx.strokeStyle = g === 'R' ? AMBER : GREEN; ctx.lineWidth = 1.5; ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1); }
        ctx.fillStyle = on ? (g === 'R' ? AMBER : GREEN) : '#ffffff55'; ctx.font = font(big ? 14 : 10, 800);
        ctx.fillText(g, gx + gw / 2, gy + gh - (big ? 5 : 3));
      });
      ctx.restore();
    };
    const gunCell = (x, y, w, h, big) => {
      this._silhouette(ctx, x + w / 2, y + h / 2 - (big ? 6 : 5), big ? 0.95 : 0.5, 0, d.turret, d.gear === 'D' ? 1 : d.gear === 'R' ? -1 : 0);
      ctx.save(); ctx.textAlign = 'center'; ctx.font = font(big ? 15 : 10);
      this._text(ctx, gun, x + w / 2, y + h - (big ? 8 : 5), GREEN);
      ctx.restore();
    };
    const weaponCell = (x, y, w, h, big) => {
      const wpn = d.weapon;
      ctx.save(); ctx.textAlign = 'center';
      ctx.font = font(big ? 15 : 10, 800);
      this._text(ctx, wpn?.label ?? '--', x + w / 2, y + (big ? 20 : 12), AMBER);
      const ready = !!wpn?.ready, fill = 1 - Math.max(0, Math.min(1, wpn?.reload ?? 0));
      if (big) {
        const r = 21, cx = x + w / 2, cy = y + 53;
        ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff1e'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
        ctx.strokeStyle = ready ? GREEN : AMBER; ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * fill); ctx.stroke();
        // Inside the ring: the rounds left once loaded, else the load progress.
        ctx.font = font(13, 800); ctx.textBaseline = 'middle'; ctx.fillStyle = ready ? GREEN : AMBER;
        ctx.fillText(ready ? (Number.isFinite(wpn?.ammo) && wpn.ammo >= 0 ? String(wpn.ammo) : 'RDY') : `${Math.round(fill * 100)}%`, cx, cy + 1);
        ctx.textBaseline = 'alphabetic'; ctx.font = font(12);
        this._text(ctx, ready ? 'READY' : 'LOADING', cx, y + h - 7, ready ? GREEN : AMBER);
      } else {
        const bx = x + 8, bw = w - 16, by = y + 20;
        ctx.fillStyle = '#ffffff1e'; ctx.fillRect(bx, by, bw, 5);
        ctx.fillStyle = ready ? GREEN : AMBER; ctx.fillRect(bx, by, bw * fill, 5);
        ctx.font = font(9);
        this._text(ctx, ready ? 'READY' : 'LOADING', x + w / 2, y + h - 6, ready ? GREEN : AMBER);
      }
      ctx.restore();
    };
    const hullCell = (x, y, w, h, big) => {
      ctx.save();
      const fraction = d.fraction ?? 1, tone = fraction < 0.3 ? RED : fraction < 0.6 ? AMBER : GREEN;
      ctx.font = font(big ? 14 : 9, 800); ctx.textAlign = 'left';
      this._text(ctx, 'HULL', x + 10, y + (big ? 21 : 12), MINT);
      ctx.textAlign = 'right';
      this._text(ctx, big ? `${Math.ceil(d.hp)} / ${Math.ceil(d.maxHp)}` : `${Math.ceil(d.hp)}`, x + w - 10, y + (big ? 21 : 12), tone);
      const bx = x + 10, bw = w - 20, by = y + (big ? 29 : 16);
      ctx.fillStyle = '#ffffff1e'; ctx.fillRect(bx, by, bw, big ? 7 : 4);
      ctx.fillStyle = tone; ctx.fillRect(bx, by, bw * fraction, big ? 7 : 4);
      // Danger badges (disabled, burning) under the bar, else the smoke readiness.
      const badge = d.badges[0];
      const smoke = d.smoke;
      const sy = y + (big ? 60 : 33);
      ctx.textAlign = 'left'; ctx.font = font(big ? 14 : 9, 800);
      if (smoke) {
        const label = smoke.active ? 'SMOKE ACTIVE' : smoke.available ? 'SMOKE READY' : `SMOKE ${Math.round(smoke.ready * 100)}%`;
        ctx.fillStyle = smoke.available ? GREEN : '#ffffff55';
        ctx.beginPath(); ctx.arc(x + 14, sy - (big ? 4 : 3), big ? 4 : 3, 0, TAU); ctx.fill();
        this._text(ctx, label, x + (big ? 24 : 20), sy, smoke.available ? GREEN : MINT);
      }
      if (badge) {
        ctx.font = font(big ? 12 : 8, 800);
        this._text(ctx, d.badges.map(b => b.label).join(' \u00B7 '), x + 10, y + h - (big ? 10 : 5), badge.tone === 'danger' ? RED : AMBER);
      }
      ctx.restore();
    };
    let bar;
    if (!touch) {
      // Desktop: the instrument bar at the bottom centre, under the exit prompt,
      // kept right of the squad list (minimap 22 + 184 + 18, list up to 190 wide).
      const SQUAD_RIGHT = 424;
      const bw = Math.min(780, Math.max(560, width - 2 * SQUAD_RIGHT - 12)), bh = 108;
      const bx = Math.max(width / 2 - bw / 2, SQUAD_RIGHT + 6), by = height - 18 - bh;
      const widths = [0.2, 0.24, 0.24, 0.32].map(f => Math.round(bw * f));
      let x = bx;
      const draws = [speedCell, gunCell, weaponCell, hullCell];
      widths.forEach((w, i) => { const cw = i === widths.length - 1 ? bx + bw - x : w; cell(x, by, cw, bh); draws[i](x, by, cw, bh, true); x += cw; });
      bar = { left: bx, top: by, right: bx + bw, bottom: by + bh };
    } else {
      // Phones: a 2 x 2 panel in the vehicle card's slot (top right), headed by the hull heading on portrait.
      const pw = Math.min(196, width * 0.5), header = landscape ? 0 : 16, ph = header + 2 * 54;
      const px = width - 12 - pw, py = landscape ? 8 : 64;
      if (header) {
        cell(px, py, pw, header);
        ctx.save(); ctx.font = font(10, 800); ctx.textAlign = 'left';
        this._text(ctx, 'DRIVER', px + 8, py + 12, MINT);
        ctx.textAlign = 'right';
        this._text(ctx, `HDG ${pad(d.heading)}`, px + pw - 8, py + 12, WHITE);
        ctx.restore();
      }
      const cw = pw / 2, ch = 54, y0 = py + header;
      [[speedCell, 0, 0], [gunCell, 1, 0], [weaponCell, 0, 1], [hullCell, 1, 1]].forEach(([draw, cx, cy]) => {
        cell(px + cx * cw, y0 + cy * ch, cw, ch); draw(px + cx * cw, y0 + cy * ch, cw, ch, false);
      });
      bar = { left: px, top: py, right: px + pw, bottom: py + ph };
    }
    boxes.bar = bar;
    this.driverBoxes = boxes;
    for (const box of Object.values(boxes)) this.reserved.push({ left: box.left - 4, top: box.top - 4, right: box.right + 4, bottom: box.bottom + 4 });
    // The gun marks stay inside the brackets, below the tape and above the bar (desktop).
    return { top: tapeBottom + 16, bottom: touch ? 110 : height - bar.top + 16, left: 44, right: 44 };
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
    if (m.sensor) { this._sensor(ctx, m, width, height, touch); return; }
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
    this._gimbalBox(ctx, m, bx, by, bw, bh);
  }

  /** The gun's yaw / pitch envelope with the pointing dot, the heat bar and its label. */
  _gimbalBox(ctx, m, bx, by, bw, bh, label = '25MM CHIN \u00B7 GIMBAL') {
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
    this._text(ctx, m.overheated ? 'OVERHEAT' : label, bx + bw / 2, by - 6, m.overheated ? RED : WHITE);
  }

  /**
   * Chin gimbal through its sensor (design docs/design/conquest/gunner-sensor/,
   * variant B): range brackets, a bar reticle on the sight line, the barrel
   * pip where the gun really points, rangefinder / heading / zoom readouts
   * above the frame and the turret envelope box under it. Every value comes
   * from the model (sensorReadout over the authoritative mount row).
   */
  _sensor(ctx, m, width, height, touch = false) {
    const { x, y } = m.center, s = m.sensor;
    const narrow = width < 520;
    const fw = touch ? Math.min(width * (narrow ? 0.7 : 0.42), 380) : Math.min(width * 0.36, 520);
    const fh = touch ? Math.min(height * (narrow ? 0.26 : 0.4), 220) : Math.min(height * 0.38, 320);
    const left = x - fw / 2, right = x + fw / 2, top = y - fh / 2, bottom = y + fh / 2;
    const line = m.overheated ? RED : SENSOR;
    // Range brackets with stadia ticks.
    ctx.lineWidth = 1.5; ctx.strokeStyle = SENSOR_DIM;
    shadowed(ctx, () => {
      ctx.beginPath();
      for (const side of [-1, 1]) {
        const bx = side < 0 ? left : right;
        ctx.moveTo(bx - side * 12, top); ctx.lineTo(bx, top); ctx.lineTo(bx, bottom); ctx.lineTo(bx - side * 12, bottom);
        for (let k = 1; k < 8; k++) {
          const ty = top + (fh * k) / 8;
          ctx.moveTo(bx, ty); ctx.lineTo(bx - side * (k % 2 ? 5 : 9), ty);
        }
      }
      ctx.stroke();
    });
    // Bar reticle on the sight line: four bars around an open centre and a dot.
    const gap = 14, horizontal = touch ? 34 : 46, vertical = touch ? 28 : 38;
    ctx.lineWidth = 2.5; ctx.strokeStyle = line;
    shadowed(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(x - horizontal, y); ctx.lineTo(x - gap, y); ctx.moveTo(x + gap, y); ctx.lineTo(x + horizontal, y);
      ctx.moveTo(x, y - vertical); ctx.lineTo(x, y - gap); ctx.moveTo(x, y + gap); ctx.lineTo(x, y + vertical);
      ctx.stroke();
    });
    ctx.fillStyle = line;
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill();
    // Barrel pip: where the 25 mm points now; it trails the sight while the turret slews.
    if (s.pip) {
      const p = s.pip, onTarget = Math.hypot(p.x - x, p.y - y) < 4;
      ctx.lineWidth = 1.5; ctx.strokeStyle = onTarget ? SENSOR_DIM : AMBER;
      shadowed(ctx, () => { ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, TAU); ctx.stroke(); });
    }
    // Readouts above the frame: rangefinder (left), sensor mode and zoom (centre), heading / elevation (right).
    ctx.save();
    ctx.font = `700 ${touch ? 12 : 14}px "Rajdhani", "Barlow Condensed", system-ui, sans-serif`;
    const pad = (value, digits) => String(Math.abs(value)).padStart(digits, '0');
    const range = Number.isFinite(s.range) ? `RNG ${pad(s.range, 4)} M` : 'RNG ---- M';
    const mode = `SENSOR \u00B7 BW \u00B7 ${s.zoom > 1.5 ? 'NFOV' : 'WFOV'} ${s.zoom.toFixed(1)}x`;
    const elevation = `${s.elevation < 0 ? '-' : s.elevation > 0 ? '+' : ''}${Math.abs(s.elevation)}`;
    const heading = `HDG ${pad(s.heading, 3)} \u00B7 EL ${elevation}`;
    const row = top - 12, stacked = fw < 400;
    ctx.textAlign = 'left'; this._text(ctx, range, left, row, SENSOR);
    ctx.textAlign = 'right'; this._text(ctx, heading, right, row, SENSOR);
    ctx.textAlign = 'center'; this._text(ctx, mode, x, stacked ? row - 18 : row, m.overheated ? RED : SENSOR);
    ctx.restore();
    this.reserved.push({ left: left - 4, top: row - (stacked ? 34 : 16), right: right + 4, bottom: row + 6 });
    // Turret envelope and heat under the frame (phones: the touch layout of the plain gimbal box).
    const bw = touch ? Math.min(120, width * 0.3) : Math.min(170, width * 0.3), bh = bw * 0.42;
    const beside = touch && width > height;
    const bx = beside ? right + 18 : x - bw / 2;
    const by = beside ? y - bh / 2 + 24 : touch ? Math.min(bottom + 26, height / 2 + 120 - bh - 18) : Math.min(height - bh - 24, bottom + 30);
    this._gimbalBox(ctx, m, Math.min(bx, width - bw - 8), by, bw, bh, 'TURRET ENVELOPE');
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
    // Older models without instruments keep their speed / altitude tapes.
    if (!m.flight) this._instruments(ctx, { speedKmh: m.speedKmh, agl: null, altitude: m.altitude, throttle: null, rotor: false }, width, height);
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

  /**
   * Pilot tapes: airspeed (left, with the jet's throttle bar on its inner
   * side) and height above ground (right, with the climb rate under it), and
   * the stall warning above the aim. `f` is flightInstruments().
   */
  _instruments(ctx, f, width, height) {
    // Phones: narrower tapes (portrait) and shorter ones set a little lower,
    // clear of the vehicle card (landscape).
    const narrow = width < 600, low = height < 500;
    const half = narrow ? 26 : 34, box = narrow ? 24 : 30;
    const tapeH = low ? Math.min(130, height * 0.32) : Math.min(220, height * 0.36);
    const mid = low ? height / 2 + 26 : height / 2, top = mid - tapeH / 2;
    const tape = (x, value, step, unit, align) => {
      this.reserved.push({ left: x - half, top: top - 18, right: x + half, bottom: top + tapeH + 18 });
      ctx.save();
      ctx.beginPath(); ctx.rect(x - half, top, half * 2, tapeH); ctx.clip();
      ctx.fillStyle = '#05090cb0'; ctx.fillRect(x - half, top, half * 2, tapeH);
      ctx.strokeStyle = '#7ef29a90'; ctx.lineWidth = 1; ctx.fillStyle = '#c9f7d6';
      ctx.font = '600 10px "Rajdhani", system-ui, sans-serif'; ctx.textAlign = align === 'left' ? 'right' : 'left';
      const known = Number.isFinite(value), shown = known ? value : 0;
      const pxPer = tapeH / (step * 6);
      const base = Math.floor(shown / step) * step;
      for (let k = -4; k <= 4 && known; k++) {
        const v = base + k * step, y = mid - (v - shown) * pxPer;
        if (Math.abs(y - mid) < 13) continue;
        const tick = align === 'left' ? x + half : x - half, dir = align === 'left' ? -1 : 1;
        ctx.beginPath(); ctx.moveTo(tick, y); ctx.lineTo(tick + dir * 7, y); ctx.stroke();
        if (v >= 0) ctx.fillText(String(v), tick + dir * 10, y + 3);
      }
      ctx.restore();
      ctx.fillStyle = '#0b1218'; ctx.strokeStyle = GREEN; ctx.lineWidth = 1.5;
      ctx.fillRect(x - box, mid - 11, box * 2, 22); ctx.strokeRect(x - box, mid - 11, box * 2, 22);
      ctx.fillStyle = GREEN; ctx.font = `700 ${narrow ? 13 : 14}px "Rajdhani", system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(known ? String(Math.round(value)) : '--', x, mid + 5);
      ctx.font = '700 10px "Rajdhani", system-ui, sans-serif';
      this._text(ctx, unit, x, top - 6, '#c9f7d6');
    };
    const gap = Math.min(260, width * (narrow ? 0.3 : 0.26));
    const left = width / 2 - gap, right = width / 2 + gap;
    tape(left, f.speedKmh, 50, 'KM/H', 'left');
    // Height above ground; the absolute height only when no ground cast is available.
    const agl = Number.isFinite(f.agl);
    tape(right, agl ? f.agl : f.altitude, f.rotor ? 10 : 20, agl ? 'AGL M' : 'ALT M', 'right');
    ctx.save();
    ctx.font = '700 10px "Rajdhani", system-ui, sans-serif'; ctx.textAlign = 'center';
    if (Number.isFinite(f.climb) && f.airborne !== false) {
      // Climb rate under the altitude tape: the collective's effect at a glance.
      const climb = Math.abs(f.climb) < 0.3 ? 'LEVEL' : `${f.climb > 0 ? '\u25B2' : '\u25BC'} ${Math.abs(f.climb).toFixed(1)} M/S`;
      this._text(ctx, climb, right, top + tapeH + 13, Math.abs(f.climb) < 0.3 ? '#c9f7d6' : WHITE);
    }
    if (Number.isFinite(f.throttle)) {
      // Throttle bar on the inner side of the speed tape.
      const bx = left + half + 6, bw = narrow ? 6 : 8, fill = Math.max(0, Math.min(1, f.throttle));
      this.reserved.push({ left: bx - 2, top: top - 18, right: bx + bw + 16, bottom: top + tapeH + 18 });
      ctx.fillStyle = '#05090cb0'; ctx.fillRect(bx, top, bw, tapeH);
      ctx.fillStyle = fill > 0.95 ? AMBER : GREEN; ctx.fillRect(bx, top + tapeH * (1 - fill), bw, tapeH * fill);
      ctx.strokeStyle = '#7ef29a90'; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, top + 0.5, bw - 1, tapeH - 1);
      this._text(ctx, `THR ${Math.round(fill * 100)}%`, bx + bw / 2, top + tapeH + 13, '#c9f7d6');
    }
    ctx.restore();
    // Warning chips above the aim, sized to their text: the stall warning
    // (red) nearest, the map-edge guidance (amber) above it, so a turn the
    // pilot did not ask for is explained. Where a chip would cover the tapes
    // (phones) the stack sits above them instead.
    const chips = [];
    if (f.stalled) chips.push({ label: 'STALL \u00B7 NOSE DOWN', color: RED, fill: '#2a0b0dd0' });
    if (f.edge) chips.push({ label: f.edge === 'autopilot' ? 'MAP EDGE \u00B7 AUTOPILOT' : 'MAP EDGE \u00B7 TURN BACK', color: AMBER, fill: '#2a1f08d0' });
    chips.forEach(({ label, color, fill }, slot) => {
      ctx.save();
      ctx.font = '700 12px "Rajdhani", "Barlow Condensed", system-ui, sans-serif'; ctx.textAlign = 'center';
      const w = Math.max(110, Math.ceil(ctx.measureText?.(label)?.width ?? 140) + 24), h = 22, x = width / 2 - w / 2;
      const clear = x >= left + half + 4 && x + w <= right - half - 4;
      const y = (clear ? height / 2 - 80 : top - 24 - h) - slot * (h + 6);
      this.reserved.push({ left: x, top: y, right: x + w, bottom: y + h });
      ctx.fillStyle = fill; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = color; ctx.fillText(label, width / 2, y + 15);
      ctx.restore();
    });
  }

  /** Mouse aim: the white aim circle at the screen centre, a dotted line to the nose marker. */
  _aimCircle(ctx, center, nose) {
    const { x, y } = center, r = 17;
    if (nose && Number.isFinite(nose.x) && Number.isFinite(nose.y)) {
      const dx = nose.x - x, dy = nose.y - y, d = Math.hypot(dx, dy);
      if (d > r + 12) {
        ctx.save();
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#7ef29a90'; ctx.setLineDash([2, 5]);
        ctx.beginPath(); ctx.moveTo(x + dx / d * r, y + dy / d * r); ctx.lineTo(nose.x - dx / d * 11, nose.y - dy / d * 11); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffffe0';
    shadowed(ctx, () => { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke(); });
    ctx.fillStyle = '#ffffffe0';
    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
  }

  /** Nose marker of an unarmed pilot seat: a small gun cross where the nose points. */
  _nose(ctx, nose) {
    if (!nose) return;
    ctx.lineWidth = 1.5; ctx.strokeStyle = GREEN;
    shadowed(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(nose.x - 11, nose.y); ctx.lineTo(nose.x - 4, nose.y); ctx.moveTo(nose.x + 4, nose.y); ctx.lineTo(nose.x + 11, nose.y);
      ctx.moveTo(nose.x, nose.y - 4); ctx.lineTo(nose.x, nose.y - 9);
      ctx.stroke();
    });
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
