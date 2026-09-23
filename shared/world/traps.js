// Traitor traps: map-authored buttons that only traitors can use during the
// live phase of TTT. Every trap is data; `server/modes/ttt-traps.js` runs the
// effects, `public/js/engine/ttt-traps.js` draws the buttons for traitors.
//
// Trap: { id, name, detail, button:{x,y,z,face}, uses?, cooldownMs?, effect }
// `button` is the integer standing cell in front of the wall-mounted button;
// `face` names the wall the plate hangs on ('x-'|'x+'|'z-'|'z+'). A trap with
// `uses` is spent after that many activations; `cooldownMs` gates repeats.
//
// Effects (all server-side):
//   explosion  {x,y,z,radius,damage,terrainRadius,terrainPower,maxDestroyedBlocks}
//   lava|flood {region,durationMs}   air cells become lava/water, then restore
//   door_lock  {region,durationMs}   air cells become iron (a barricade)
//   collapse   {region,durationMs}   solid cells become air, then restore
//   electrify  {regions,durationMs,damage,intervalMs}   damage while inside
//   gas        {fields,region,durationMs,damage,intervalMs} smoke + damage
//   fire       {points,durationMs}   molotov-style ground fire
// `region` boxes are inclusive voxel ranges for block effects and continuous
// bounds for damage volumes (a player's feet position is tested).

export const TRAP_RULES = Object.freeze({
  /** Distance from the button's standing point at which the interact key works. */
  useRange: 1.6,
  /** Bots walk to a ready button from this far when an innocent is in the effect. */
  botApproachRange: 28,
  /** A trap kill or hit is reported as this weapon key. */
  weaponKey: 'trap',
});

export const TRAP_EFFECT_KINDS = Object.freeze([
  'explosion', 'lava', 'flood', 'door_lock', 'collapse', 'electrify', 'gas', 'fire',
]);

const box = (minX, minY, minZ, maxX, maxY, maxZ) => ({ minX, minY, minZ, maxX, maxY, maxZ });

export const MAP_TRAPS = Object.freeze({
  // The T room sits under the village (floor y=42); its single entrance is the
  // corridor gap at x 57–58, z 54. Signs: TNT on the south wall, INCINERATOR on
  // the north wall next to the lava pit, T ROOM at the west entrance.
  minecraft_b5: [
    { id: 'tnt', name: 'TNT', detail: 'Sprengt die Minenstation in die Luft',
      button: { x: 59, y: 43, z: 57, face: 'z+' }, uses: 1,
      effect: { kind: 'explosion', x: 45.5, y: 51.2, z: 27.5, radius: 8, damage: 140,
        terrainRadius: 2.5, terrainPower: 200, maxDestroyedBlocks: 40 } },
    { id: 'lava-flood', name: 'Lavaflut', detail: 'Flutet den Dorfplatz 8 Sekunden mit Lava',
      button: { x: 59, y: 43, z: 51, face: 'z-' }, uses: 1,
      effect: { kind: 'lava', region: box(66, 42, 24, 75, 42, 33), durationMs: 8000 } },
    { id: 'lockdown', name: 'Lockdown', detail: 'Verriegelt den T-Raum-Eingang 20 Sekunden',
      button: { x: 59, y: 43, z: 56, face: 'x-' }, cooldownMs: 45000,
      effect: { kind: 'door_lock', region: box(57, 43, 54, 58, 44, 54), durationMs: 20000 } },
  ],
  // The traitor room is the raised hall east of the plant room (floor y=10),
  // entered from the north-east deck through the gap at z 25; the teleport
  // pocket at x 177–179, z 16–19 opens off the antechamber at x 181–183.
  waterworld: [
    { id: 'pool-shock', name: 'Poolstrom', detail: 'Setzt das Ostbecken 12 Sekunden unter Strom',
      button: { x: 193, y: 11, z: 10, face: 'x+' }, cooldownMs: 60000,
      effect: { kind: 'electrify', regions: [box(146, 2, 34, 190, 8.5, 66)],
        durationMs: 12000, damage: 8, intervalMs: 400 } },
    { id: 'chlorine', name: 'Chlorleck', detail: 'Chlorgas auf dem Nordost-Deck vor dem Technikraum',
      button: { x: 185, y: 11, z: 24, face: 'x-' }, cooldownMs: 50000,
      effect: { kind: 'gas', fields: [
        { x: 156.5, y: 11, z: 30.5, radius: 5 }, { x: 170.5, y: 11, z: 30.5, radius: 5 },
        { x: 184.5, y: 11, z: 30.5, radius: 5 }],
      region: box(146, 10, 26, 194, 14, 34), durationMs: 14000, damage: 5, intervalMs: 500 } },
    { id: 'tester', name: 'Tester-Sabotage', detail: 'Die Rutschen-Tester geben 25 Sekunden Stromschläge',
      button: { x: 183, y: 11, z: 22, face: 'x+' }, cooldownMs: 40000,
      effect: { kind: 'electrify', regions: [
        box(122.5, 18.9, 85.3, 126.3, 21.5, 89.9), box(141.1, 21.6, 87.1, 144.9, 24.2, 91.6)],
      durationMs: 25000, damage: 25, intervalMs: 400 } },
  ],
  // The South Tower (x 24–28, z 76–80, floor y=12) has one doorway at (26, 75).
  foundry: [
    { id: 'forge-tap', name: 'Abstich', detail: 'Flutet die Nordschmiede 8 Sekunden mit Schmelze',
      button: { x: 28, y: 13, z: 77, face: 'x+' }, uses: 1,
      effect: { kind: 'lava', region: box(56, 14, 23, 64, 14, 29), durationMs: 8000 } },
    { id: 'crane-charge', name: 'Kranladung', detail: 'Sprengsatz am Zentralkran',
      button: { x: 24, y: 13, z: 76, face: 'x-' }, uses: 1,
      effect: { kind: 'explosion', x: 65.5, y: 14.8, z: 46.5, radius: 8, damage: 130,
        terrainRadius: 2.5, terrainPower: 200, maxDestroyedBlocks: 40 } },
    { id: 'tower-lockdown', name: 'Turm-Lockdown', detail: 'Verriegelt die Turmtür 20 Sekunden',
      button: { x: 28, y: 13, z: 79, face: 'x+' }, cooldownMs: 45000,
      effect: { kind: 'door_lock', region: box(26, 12, 75, 26, 14, 75), durationMs: 20000 } },
  ],
  // The moving truck's cargo box (x 75–85, z 50–54, floor y=15) opens east.
  nuketown: [
    { id: 'bus-bomb', name: 'Busbombe', detail: 'Sprengsatz im Schulbus',
      button: { x: 75, y: 16, z: 50, face: 'z-' }, uses: 1,
      effect: { kind: 'explosion', x: 55.5, y: 17, z: 44.5, radius: 7, damage: 130,
        terrainRadius: 0, terrainPower: 0, maxDestroyedBlocks: 0 } },
    { id: 'fallout', name: 'Fallout', detail: 'Giftiger Nebel über der Straße zwischen den Häusern',
      button: { x: 75, y: 16, z: 54, face: 'z+' }, cooldownMs: 50000,
      effect: { kind: 'gas', fields: [
        { x: 46.5, y: 15, z: 39.5, radius: 5 }, { x: 64.5, y: 15, z: 39.5, radius: 5 },
        { x: 82.5, y: 15, z: 39.5, radius: 5 }],
      region: box(40, 15, 36, 89, 18.5, 41.5), durationMs: 14000, damage: 5, intervalMs: 500 } },
    { id: 'gas-main', name: 'Gasleitung', detail: 'Feuer auf der Veranda des gelben Hauses',
      button: { x: 85, y: 16, z: 50, face: 'z-' }, cooldownMs: 40000,
      effect: { kind: 'fire', points: [{ x: 60.5, y: 15.05, z: 58.5 }], durationMs: 12000 } },
  ],
  // Grill button on the Krusty Krab kitchen deck (back wall z=37), the
  // lifeguard hut's west wall at Goo Lagoon, the Treedome drum at the fields.
  bikini_bottom: [
    { id: 'grill-flare', name: 'Grillbrand', detail: 'Die Grillplatte der Krabbenküche flammt auf und setzt den Speisesaal in Brand.',
      button: { x: 21, y: 16, z: 38, face: 'z-' }, uses: 1,
      effect: { kind: 'fire', points: [{ x: 23.5, y: 15.05, z: 44.5 }, { x: 27.5, y: 15.05, z: 47.5 },
        { x: 24.5, y: 15.05, z: 51.5 }], durationMs: 12000 } },
    { id: 'high-tide', name: 'Flutwelle', detail: 'Die Goo Lagoon läuft über und flutet den Strand für kurze Zeit.',
      button: { x: 36, y: 15, z: 69, face: 'x+' }, cooldownMs: 45000,
      effect: { kind: 'flood', region: box(37, 15, 71, 45, 16, 80), durationMs: 8000 } },
    { id: 'jelly-sting', name: 'Quallenstich', detail: 'Ein Quallenschwarm setzt die Jellyfish Fields 10 Sekunden unter Strom.',
      button: { x: 95, y: 15, z: 74, face: 'x-' }, cooldownMs: 40000,
      effect: { kind: 'electrify', regions: [box(96, 14.5, 68, 112, 17, 81)], durationMs: 10000, damage: 7, intervalMs: 450 } },
  ],
});

export function trapsFor(mapId) {
  return MAP_TRAPS[mapId] ?? [];
}

/** Standing point the interact range is measured from. */
export function trapButtonPoint(trap) {
  return { x: trap.button.x + 0.5, y: trap.button.y, z: trap.button.z + 0.5 };
}

/** The voxel the button plate hangs on. */
export function trapWallCell(trap) {
  const { x, y, z, face } = trap.button;
  return { x: x + (face === 'x+' ? 1 : face === 'x-' ? -1 : 0), y,
    z: z + (face === 'z+' ? 1 : face === 'z-' ? -1 : 0) };
}

export function isTrapRequest(value) {
  return typeof value === 'string' && /^ttt:trap:[a-z0-9-]{1,32}$/.test(value);
}

function inBox(box, x, y, z) {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY
    && z >= box.minZ && z <= box.maxZ;
}

/** Continuous bounds of an inclusive voxel region (a body standing in it counts). */
export function trapRegionBounds(region) {
  return { minX: region.minX, maxX: region.maxX + 1, minY: region.minY - 1, maxY: region.maxY + 1,
    minZ: region.minZ, maxZ: region.maxZ + 1 };
}

/** True when a feet position lies inside the effect's danger volume. */
export function trapEffectContains(effect, x, y, z) {
  switch (effect.kind) {
    case 'explosion':
      return Math.hypot(x - effect.x, y + 1 - effect.y, z - effect.z) < effect.radius;
    case 'lava': case 'flood': case 'collapse': case 'door_lock':
      return inBox(trapRegionBounds(effect.region), x, y, z);
    case 'electrify':
      return effect.regions.some((region) => inBox(region, x, y, z));
    case 'gas':
      return inBox(effect.region, x, y, z);
    case 'fire':
      return effect.points.some((p) => Math.abs(y - p.y) < 1.5 && Math.hypot(x - p.x, z - p.z) < 3.4);
    default:
      return false;
  }
}
