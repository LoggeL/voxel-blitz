// Levolutions in the world (docs/conquest.md "Map events", "Levolutions"):
// the Iron Bridge's effects (../bridge-fx.js) for any levolution event, driven
// by its `map_event` phases. Presentation only.
//
//   armed    (damaged) a groan from the structure voices, grit off the deck, a shake
//   warning  (failing) the groans through the warning window with a rising shake;
//            a joiner who walks into the groan starts it from the row's time left
//   active   (down) the rumble with dust (and water bursts over a water line)
//            as the span goes; the chunks themselves are structure-fx.js
//
// An event registers it in its FX slot: `trestle: levolutionFx()`, with the
// structure voice `material` ('metal', 'stone', 'wood') as the only option.
// No dedicated recording: the structure voices carry it.
import { mapEventDef } from '../../../../shared/conquest-map-events.js';
import { levolutionFootprint } from '../../../../shared/map-events/levolution.js';
import { BridgeFx } from '../bridge-fx.js';

const STAGE_OF_PHASE = Object.freeze({ armed: 'damaged', warning: 'failing', active: 'down' });

/** The FX hook of a levolution event (one BridgeFx per kit and event). */
export function levolutionFx({ material = 'metal' } = {}) {
  const perKit = new WeakMap();
  const fxFor = (kit, id) => {
    let byId = perKit.get(kit);
    if (!byId) perKit.set(kit, byId = new Map());
    if (byId.has(id)) return byId.get(id);
    const L = mapEventDef(id, kit.defs)?.tuning?.levolution;
    if (!L) return null;
    const f = levolutionFootprint(L.structure);
    const fx = new BridgeFx({ audio: kit.audio, cameraShake: kit.cameraShake, getCamera: kit.getCamera, fx: kit.fx, rules: L.rules,
      span: { x0: f.x0, z0: f.z0, x1: f.x1 - 1, z1: f.z1 - 1 }, deckY: L.structure.deckY, waterY: L.structure.waterY, material });
    byId.set(id, fx);
    return fx;
  };
  return Object.freeze({
    onEvent(ev, kit) {
      const stage = !ev.note ? STAGE_OF_PHASE[ev.phase] : null;
      if (stage) fxFor(kit, ev.event)?.stage(stage, { blocks: ev.data?.blocks | 0 });
      // The stages carry the strike; no generic dust ring.
      return true;
    },
    sync(event, kit, { fresh = false } = {}) {
      if (fresh && event.phase === 'warning') fxFor(kit, event.id)?.stage('failing', { leftMs: event.leftMs });
    },
    update(dt, kit) { for (const fx of perKit.get(kit)?.values() ?? []) fx.update(dt); },
    end(kit) { for (const fx of perKit.get(kit)?.values() ?? []) fx.clear(); },
    clear(kit) { for (const fx of perKit.get(kit)?.values() ?? []) fx.clear(); perKit.delete(kit); },
  });
}
