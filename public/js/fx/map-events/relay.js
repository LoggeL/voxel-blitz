// Signal Rock relay in the world (docs/conquest.md "Signal Rock relay").
// Presentation only, on top of the structural FX that draws the mast itself
// (the server's creak, collapse and collapseLand events, structure-fx.js):
//
//   scan      the recon sensor's ping from the mast top and a spark at its light
//   planted   the AT mine's arming click at the mast foot
//   groan     metal groans from the structure voices, grit off the platforms
//             and a rising shake through the 4 s warning (as the Iron Bridge)
//   fall      a shake and dust along the fall line as the mast lies down
//
// No recording of its own (no ElevenLabs takes): every sound reuses an
// existing procedural or sampled voice.
import { RELAY_EVENT, RELAY_SITE, relayCrushLine } from '../../../../shared/map-events/relay.js';

const T = RELAY_EVENT.tuning;
const TOP = [RELAY_SITE.mastCentre.x, 60, RELAY_SITE.mastCentre.z];
const PLATFORMS = [[468.5, 45, 168.5], [468.5, 55, 168.5]];
const FX = Object.freeze({ groanEveryS: 1.1, gritEveryS: 0.18, shake: [0.05, 0.3], rangeM: 260, landTrauma: 0.5, dust: 14 });

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
let groan = null;   // {start, end, nextGroan, nextGrit}
let fall = null;    // {landAt}

function lineDust(kit) {
  const line = relayCrushLine(T.fall);
  for (let i = 0; i < FX.dust; i++) {
    const t = (i + 0.5) / FX.dust, z = line.az + (line.bz - line.az) * t;
    kit.puff('dust', [line.ax + (i % 3 - 1) * 1.6, 29, z], { count: 4, scale: 2.6, speed: 1.2 });
  }
}

export const RELAY_FX = Object.freeze({
  onEvent(ev, kit) {
    if (ev.note === 'scan') {
      kit.audio?.reconGadget?.(TOP, 'sensor');
      kit.puff('spark', [TOP[0], 62.5, TOP[2]], { count: 6, scale: 0.8, speed: 0.6 });
      return true;
    }
    if (ev.note === 'planted') { kit.audio?.atMineArm?.([468.5, 31, 165.5]); return true; }
    if (ev.note) return true;
    if (ev.phase === 'warning') {
      const now = clock(), ms = RELAY_EVENT.durations.warningMs;
      groan = { start: now, end: now + ms, nextGroan: now, nextGrit: now };
      return true;
    }
    if (ev.phase === 'done' && ev.reason === 'toppled') {
      groan = null;
      fall = { landAt: clock() + T.fall.fallMs };
      kit.sound.creak(TOP, { n: 400, material: 'metal', seconds: 1.4 });
      return true;
    }
    return true;
  },

  /** A joiner during the groan gets its standing effects from the snapshot row. */
  sync(event, kit, { fresh } = {}) {
    if (fresh && event.phase === 'warning' && Number.isFinite(event.leftMs) && !groan) {
      const now = clock();
      groan = { start: now - (RELAY_EVENT.durations.warningMs - event.leftMs), end: now + event.leftMs, nextGroan: now, nextGrit: now };
    }
  },

  update(_dt, kit) {
    const now = clock();
    if (groan) {
      if (now >= groan.end) groan = null;
      else {
        const k = Math.min(1, (now - groan.start) / Math.max(1, groan.end - groan.start));
        if (now >= groan.nextGroan) {
          groan.nextGroan = now + FX.groanEveryS * 1000;
          kit.sound.creak(PLATFORMS[1], { n: 300, material: 'metal', seconds: 0.9 });
          kit.shake(TOP, FX.shake[0] + (FX.shake[1] - FX.shake[0]) * k, FX.rangeM);
        }
        if (now >= groan.nextGrit) {
          groan.nextGrit = now + FX.gritEveryS * 1000;
          for (const p of PLATFORMS) kit.puff('grit', [p[0] + (Math.random() - 0.5) * 4, p[1], p[2] + (Math.random() - 0.5) * 4], { count: 2 });
        }
      }
    }
    if (fall && now >= fall.landAt) {
      fall = null;
      const line = relayCrushLine(T.fall);
      kit.shake([line.ax, 29, (line.az + line.bz) / 2], FX.landTrauma, FX.rangeM);
      lineDust(kit);
    }
  },

  end() { groan = null; fall = null; },
  clear() { groan = null; fall = null; },
});
