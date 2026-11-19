import { createBlenderParts } from '../engine/blender-assets.js';

/** Bind the authored PBR finishes to the existing per-avatar cosmetic and team slots. */
export function createRivetParts({ suit, dark, armor, visor, skin }) {
  return createBlenderParts('rivet', { materialFor(original) {
    const { slot, paletteColor } = original.userData;
    let material;
    if (slot === 'suit') material = suit.copy(original);
    else if (slot === 'dark') material = dark.copy(original);
    else if (slot === 'skin') {
      const swatch = skin.color.clone();
      material = skin.copy(original);
      material.color.copy(swatch);
    } else if (paletteColor === 0x26323b) material = armor.copy(original);
    else if (paletteColor === 0x6aa5af) material = visor.copy(original);
    else material = original.clone();
    material.transparent = true;
    return material;
  } });
}
