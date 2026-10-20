// Aldric Quarry rockslide in the world (docs/conquest.md "Aldric
// Quarry rockslide"). Presentation only, from `map_event` events and the
// snapshot's `ev` row; the falling chunks and their rubble are the
// structural system's own effects (structure-fx.js).
//
//   warning   the site siren: the existing procedural alarm (sfx.bastionCue
//             'bastion_alarm', positional at the hut) every `sirenEveryS`
//             through the warning, grit trickling off the north face
//   blast     note per charge: the rocket blast voice, smoke and debris, a kick
//   slide     note as the face goes: the structure creak and a heavy impact,
//             a hard shake, a dust wall rolling down the face for `dustS`
//   settled   note at the grade: a last low dust ring on the talus
//
// A joiner who arrives mid-slide gets the dust wall from `sync` (fresh).
// There is no recorded siren or rockslide sound: everything reuses existing
// voices (see docs/conquest.md).
import { QUARRY_SITE, QUARRY_SLIDE } from '../../../../shared/map-events/quarry.js';

export const QUARRY_FX_RULES = Object.freeze({
  sirenEveryS: 1.1, sirenS: 5,
  blast: Object.freeze({ trauma: 0.22, rangeM: 140 }),
  slide: Object.freeze({ trauma: 0.7, rangeM: 260, dustS: 6, dustRate: 26 }),
});

const s = QUARRY_SLIDE;
const HUT = [QUARRY_SITE.plunger.x + 1.5, QUARRY_SITE.plunger.y + 2, QUARRY_SITE.plunger.z + 0.5];
const FACE = [(s.face.x0 + s.face.x1 + 1) / 2, 32, s.face.z1 + 1];

let siren = 0, sirenCarry = 0, dustSeq = 0;

function dustWall(kit, seconds = QUARRY_FX_RULES.slide.dustS) {
  const r = QUARRY_FX_RULES.slide;
  // The dust rolls south down the slide footprint: the source walks a deterministic ring of points.
  kit.emitter('quarry:dust', {
    kind: 'dust', rate: r.dustRate, until: seconds, params: { scale: 3.2, speed: 1.6, life: 1.4, alpha: 0.85 },
    pos: () => {
      const i = ++dustSeq, x = s.face.x0 + ((i * 7919) % (s.face.x1 - s.face.x0 + 1));
      const z = s.face.z1 + ((i * 104729) % (s.talus.z1 - s.face.z1));
      return [x + 0.5, 30 - (z - s.face.z1) * 0.3, z + 0.5];
    },
  });
}

export const QUARRY_FX = Object.freeze({
  onEvent(ev, kit) {
    if (ev.phase === 'warning' && !ev.note) {
      siren = QUARRY_FX_RULES.sirenS; sirenCarry = QUARRY_FX_RULES.sirenEveryS;
      kit.emitter('quarry:grit', { kind: 'grit', pos: FACE, rate: 6, until: QUARRY_FX_RULES.sirenS, params: { scale: 1.2 } });
      return true;
    }
    if (ev.note === 'blast') {
      const at = Array.isArray(ev.data?.pos) ? ev.data.pos : FACE;
      kit.sound.blast(at, 'rocket');
      kit.puff('smoke', at, { count: 10, scale: 2.2, speed: 1.4 });
      kit.puff('debris', at, { count: 12, scale: 1.4, speed: 1.6 });
      kit.puff('spark', at, { count: 8 });
      kit.shake(at, QUARRY_FX_RULES.blast.trauma, QUARRY_FX_RULES.blast.rangeM);
      return true;
    }
    if (ev.note === 'slide') {
      siren = 0;
      kit.sound.creak(FACE, { n: 600, seconds: 1.1 });
      kit.sound.impact(FACE, { n: 900, speed: 14 });
      kit.shake(FACE, QUARRY_FX_RULES.slide.trauma, QUARRY_FX_RULES.slide.rangeM);
      dustWall(kit);
      return true;
    }
    if (ev.note === 'settled') {
      const at = [(s.talus.x0 + s.talus.x1) / 2, 27, (s.talus.z0 + s.talus.z1) / 2];
      for (let i = 0; i < 8; i++) kit.puff('dust', kit.ring(at, 8, at[1]), { count: 3, scale: 2.6, speed: 0.6, alpha: 0.6 });
      return true;
    }
    // The blasts and the slide notes carry the strike; the active phase change adds nothing.
    return ev.phase === 'active' || ev.phase === 'done';
  },

  sync(event, kit, { fresh }) {
    if (fresh && event.phase === 'active' && (event.progress ?? 0) < 0.7) dustWall(kit, QUARRY_FX_RULES.slide.dustS * (1 - event.progress));
  },

  update(dt, kit) {
    if (!(siren > 0)) return;
    siren -= dt; sirenCarry += dt;
    if (sirenCarry >= QUARRY_FX_RULES.sirenEveryS) {
      sirenCarry = 0;
      kit.audio?.bastionCue?.('bastion_alarm', HUT);
    }
  },

  end() { siren = 0; },
  clear() { siren = 0; sirenCarry = 0; },
});
