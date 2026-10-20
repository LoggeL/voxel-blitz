// Canyon Trestle collapse (docs/conquest.md "Map events" -> "Canyon Trestle
// collapse"; docs/maps/redrock.md): Redrock's second levolution, the Iron
// Bridge pattern on the rail and road trestle that carries the B-E road over
// the south canyon (z500, between B and E, 140 m from each). Explosives on its
// steel bents wear one pool down; at 0 the trestle groans for 3.5 s, then the
// deck and the bents over the canyon come down through the structural system
// and settle into a rubble berm across the canyon floor: a new infantry
// crossing, while vehicles lose the crossing for the round (B-E +176 m over
// the dam crest; with the dam breached B and E lose their tank link: B-E
// +744 m, HQ to the far canyon flag +385 m).
//
// Geometry comes from the trestle site (shared/world/redrock-sites/dam.js
// `decks`: a plank deck on a steel floor at y32, x358-409, z496-503, railings
// at z495 and z504, rusted bents every 6 m from x361 to x409 standing on the
// canyon floor). Every number below is data the server controller
// (server/modes/conquest/map-events/trestle.js), the bots and the HUD read.
import { METAL, PLANK, RUST } from '../world/blocks.js';
import { defineLevolution } from './levolution.js';

/** Deck top block row (plank) and the railing rows either side of it. */
const DECK_Y = 32;
const Z0 = 495, Z1 = 504;

/**
 * The seven bents over the canyon (x367-403; the two on the rims, x361 and
 * x409, stay and carry the deck stubs): each bent's two rusted columns
 * (z496, z503) and its cross bracing, from its lowest column block up through
 * the deck over it to the air on it (the bent's head, what the rims see; the
 * Iron Bridge's truss feet take in the deck the same way), grown one voxel
 * each way, so an AT mine laid at a column's foot on the canyon floor or on
 * the deck over the bent sits inside the box (the full 150).
 */
const BENTS = Object.freeze([[367, 24], [373, 19], [379, 15], [385, 15], [391, 19], [397, 19], [403, 25]]);

/**
 * Event tuning (the controller and the HUD read it; voxel units, ms engine time):
 *  berm      the wreck settles `delayMs` after the fall starts into a rubble bar
 *            across the canyon floor, x `x0`-`x1` under the old deck: each row
 *            `rows[z]` voxels over the floor (`floorY`, the canyon floor's top
 *            block), river columns filled from the bed up, slopes above that height
 *            untouched. The low outer rows are the walkway (one step up from the
 *            floor), the high middle rows the cover; `materials` cycle by a
 *            fixed hash, every `lumpEvery`th cell of the high rows one higher
 *  alternate the other southern road crossing: when it is already closed as the
 *            trestle falls, the fall banners NO SOUTHERN CROSSING
 */
export const TRESTLE_TUNING = Object.freeze({
  berm: Object.freeze({
    delayMs: 2500, x0: 362, x1: 405, floorY: 20,
    rows: Object.freeze({ 497: 1, 498: 2, 499: 3, 500: 3, 501: 2, 502: 1 }),
    lumpEvery: 5, materials: Object.freeze([RUST, RUST, METAL, PLANK, RUST]),
  }),
  alternate: 'redrock-dam',
});

export const TRESTLE_EVENT = defineLevolution({
  id: 'trestle',
  maps: ['redrock'],
  name: 'Canyon Trestle',
  short: 'TRESTLE',
  anchor: { x: 384, y: DECK_Y + 1, z: 500 },
  flag: null,
  breakthrough: true,
  crossing: 'trestle',
  // Rockets 100, tank HE 120, a bomb 420, an AT mine 150 (IRON_BRIDGE_RULES.supportDamage):
  // 9 rockets, 8 HE shells, 3 bombs or 6 AT mines at the bent feet.
  integrity: 900,
  supports: BENTS.map(([x, y0], i) => ({ id: `bent-${i + 1}`, x0: x - 1, y0, z0: Z0, x1: x + 1, y1: DECK_Y + 1, z1: Z1 })),
  // Everything over the canyon between the rim bents: the deck, its railings and the bents.
  span: { x0: 362, y0: 14, z0: Z0, x1: 405, y1: DECK_Y + 1, z1: Z1 },
  // Only the trestle's own blocks fall; the canyon walls and the road fill inside the box stay.
  materials: [PLANK, METAL, RUST],
  deckY: DECK_Y,
  heads: [{ x: 353.5, y: 32.02, z: 499.5 }, { x: 415.5, y: 32.02, z: 499.5 }],
  axis: 'x',
  detect: [384, DECK_Y, 500],
  killKeys: { trestle: { label: 'TRESTLE', icon: 'collapse' } },
  texts: {
    armed: { title: 'DAMAGED', detail: 'SUPPORTS HOLDING' },
    warning: { title: 'COLLAPSING', detail: 'GET OFF THE SPAN', countdown: 'FALLS IN' },
    active: { title: 'DOWN', detail: 'VEHICLES CROSS AT THE DAM' },
    'active:cut': { title: 'DOWN', detail: 'NO SOUTHERN CROSSING' },
  },
  cues: {
    armed: { stinger: 'capture_start' },
    warning: { stinger: 'ticket_low' },
    active: { stinger: 'neutralized' },
  },
  tuning: TRESTLE_TUNING,
});
