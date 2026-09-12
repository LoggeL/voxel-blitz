import { ACCENT, AIR, DUST_WOOD, GROUND, METAL, PALE, TEAL_SIDING } from './blocks.js';

const freeze = values => Object.freeze(values.map(value => Object.freeze(value)));

// Shared positions own the authoritative fixture and the luminous face together.
// All heights are absolute voxel heights, all lamps stand outside objective pads.
export const LARGE_MAP_LIGHTS = Object.freeze({
  harbor: freeze([
    ...[58, 85, 110].flatMap((z, index) => [
      { id: `quay-west-${z}`, kind: 'flood', x: 9, z, face: '+x', color: index === 1 ? 'amber' : 'cyan' },
      { id: `quay-east-${z}`, kind: 'flood', x: 182, z: 143 - z, face: '-x', color: index === 1 ? 'amber' : 'cyan' },
    ]),
    ...[[27, 62], [44, 81], [147, 62], [164, 81]].map(([x, z], index) =>
      ({ id: `dock-marker-${index}`, kind: 'bollard', x, z, color: index < 2 ? 'cyan' : 'amber' })),
  ]),
  canyon: freeze([
    ...[[26, 62], [44, 81], [147, 62], [165, 81], [79, 41], [112, 102], [44, 34], [147, 109]].map(([x, z], index) =>
      ({ id: `expedition-lantern-${index}`, kind: 'lantern', x, z, color: 'warm' })),
  ]),
});

const faceNormal = face => face === '+x' ? [1, 0, 0] : face === '-x' ? [-1, 0, 0]
  : face === '-z' ? [0, 0, -1] : [0, 0, 1];

/** Small, solid voxel fixtures; support cells include the entire grounded stem. */
export function lightFixtureGeometry(light) {
  const cells = [];
  const { x, z } = light;
  const add = (dx, dy, dz, type) => cells.push([x + dx, GROUND + dy, z + dz, type]);
  const surfaces = [];
  const panel = (face, rise, width, height) => {
    const normal = faceNormal(face);
    surfaces.push({ position: [x + 0.5 + normal[0] * 0.518, GROUND + rise,
      z + 0.5 + normal[2] * 0.518], normal, width, height });
  };
  if (light.kind === 'flood') {
    for (let rise = 1; rise <= 7; rise++) add(0, rise, 0, rise === 2 ? ACCENT : METAL);
    const acrossX = light.face.endsWith('z');
    for (let across = -1; across <= 1; across++) {
      for (let rise = 8; rise <= 10; rise++) add(acrossX ? across : 0, rise,
        acrossX ? 0 : across, rise === 9 ? PALE : METAL);
    }
    panel(light.face, 9.5, 2.68, 0.72);
  } else {
    const top = light.kind === 'bollard' ? 2 : 4;
    for (let rise = 1; rise < top; rise++) add(0, rise, 0,
      light.kind === 'lantern' ? DUST_WOOD : METAL);
    add(0, top, 0, light.color === 'cyan' ? TEAL_SIDING : ACCENT);
    add(0, top + 1, 0, METAL);
    for (const face of ['+x', '-x', '+z', '-z']) panel(face, top + 0.5, 0.72, 0.72);
  }
  return { cells, surfaces, foundation: [x, GROUND, z] };
}

export function addMapLightFixtures(world, map) {
  for (const light of LARGE_MAP_LIGHTS[map] || []) {
    const { cells, foundation } = lightFixtureGeometry(light);
    // Dressing never replaces a route structure authored by the geometry pass.
    if (world.getBlock(...foundation) === AIR || cells.some(([x, y, z]) => world.getBlock(x, y, z) !== AIR)) continue;
    for (const [x, y, z, material] of cells) world.setBlock(x, y, z, material);
  }
}
