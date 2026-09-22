import { HANDS } from '../defs.js';
import { buildIronPickaxe } from './iron-pickaxe.js';

// IRON PICK. The stable `knife` slot id stays for loadouts and the wire format;
// the model is the procedural extruded item sprite (see iron-pickaxe.js), so the
// Node suites and the browser render the same eight-draw pickaxe.
export function build({ kit, T, groups }) {
  const { body } = groups;
  buildIronPickaxe({ kit, body, grip: HANDS.knife.grip, tipZ: T.muzzle[2] });
  body.userData.sightHeight = 0.02;
}
