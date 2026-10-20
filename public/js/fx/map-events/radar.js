/**
 * Flag radars in the world (docs/conquest.md "Flag radars"): presentation
 * only, from the `map_event` events. The structural system draws the rest:
 * the groan's creak (the server's `creak` of the structure's cells shakes
 * them and plays the structure creak), the chunks' fall and the landing.
 *
 *   warning  a light shake and grit off the structure as it starts to groan
 *   done     a heavier shake as it goes, dust round its foot
 *
 * No sweep sound: there is no recording for it (docs/audio/conquest-sfx.md).
 */
export const RADAR_FX_RULES = Object.freeze({ groanTrauma: 0.08, fallTrauma: 0.35, rangeM: 160, grit: 6, dust: 10, ringM: 7 });

export const RADAR_FX = Object.freeze({
  onEvent(ev, kit) {
    if (ev.note) return true;
    const at = Array.isArray(ev.pos) ? ev.pos : kit.anchor(ev.event);
    if (!at) return true;
    const R = RADAR_FX_RULES;
    if (ev.phase === 'warning') {
      kit.shake(at, R.groanTrauma, R.rangeM);
      for (let i = 0; i < R.grit; i++) kit.puff('grit', kit.ring(at, 3, at[1]), { count: 3, scale: 1.2, speed: 0.8 });
    } else if (ev.phase === 'done') {
      kit.shake(at, R.fallTrauma, R.rangeM);
      for (let i = 0; i < R.dust; i++) kit.puff('dust', kit.ring(at, R.ringM, at[1] - 6), { count: 4, scale: 2.4, speed: 1.2 });
    }
    return true;
  },
});

/** The FX hook of every radar id (the FX registry spreads it into its radar slot). */
export const RADAR_FX_HOOKS = Object.freeze({
  'radar-aldric': RADAR_FX, 'radar-ridge': RADAR_FX, 'radar-mesa': RADAR_FX, 'radar-palmera': RADAR_FX,
});
