import { AIR, BEDROCK, CONCRETE, METAL, STONE, PALE, RUST, ACCENT, GLASS, WOOD,
  GROUND, SX, SZ, SY } from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';
import { REACTOR_LAYOUT } from './reactor-layout.js';

/** Reactor 9 is authored for staged core defense, independently of every PvP map. */
export function generateReactorInto(world, blocks, heights, layout = REACTOR_LAYOUT) {
  blocks.fill(AIR);
  heights.fill(GROUND);
  fillBox(world, 0, 0, 0, SX - 1, GROUND - 1, SZ - 1, BEDROCK);
  paintFloor(world, 0, 0, SX - 1, SZ - 1, GROUND, CONCRETE);
  for (const [x0,z0,x1,z1] of [[0,0,3,SZ-1],[SX-4,0,SX-1,SZ-1],[0,0,SX-1,3],[0,SZ-4,SX-1,SZ-1]]) {
    fillBox(world,x0,GROUND,z0,x1,SY-1,z1,BEDROCK);
  }
  // Protected ring and radial service roads keep paths intact after demolition.
  paintFloor(world, 51, 42, 76, 67, GROUND, BEDROCK);
  paintFloor(world, 60, 20, 68, 84, GROUND, BEDROCK);
  paintFloor(world, 20, 50, 107, 58, GROUND, BEDROCK);
  for (const z of [43,65]) paintFloor(world,53,z,74,z,GROUND,PALE);
  for (const x of [52,75]) paintFloor(world,x,44,x,64,GROUND,PALE);
  for (const x of [61,66]) for (let z=22;z<83;z+=5) world.setBlock(x,GROUND,z,ACCENT);
  for (let x=24;x<106;x+=5) for (const z of [51,56]) world.setBlock(x,GROUND,z,ACCENT);
  // The visible reactor stands on a flush, indestructible dais. Its damage
  // volume is a separate authoritative objective, rendered by BastionWorld.
  paintFloor(world,61,51,66,56,GROUND,BEDROCK);
  for (const [x,z] of [[59,49],[68,49],[59,58],[68,58]]) {
    fillBox(world,x,GROUND+1,z,x,GROUND+1,z,METAL);
    world.setBlock(x,GROUND+2,z,ACCENT);
  }
  // Outer generator buildings form readable, different skyline silhouettes.
  building(world,23,12,49,27,8);
  building(world,83,10,104,24,6);
  building(world,27,73,47,87,5);
  building(world,83,69,107,86,7);
  for (const [x,z,h] of [[33,18,17],[43,18,14],[94,16,13]]) {
    fillBox(world,x,GROUND+8,z,x+2,GROUND+h,z+2,METAL);
    fillBox(world,x,GROUND+h-2,z,x+2,GROUND+h-2,z+2,ACCENT);
  }
  // Three dog-leg ingress galleries. Solid baffles hide the staging points.
  fillBox(world,53,GROUND+1,4,54,GROUND+7,19,BEDROCK);
  fillBox(world,54,GROUND+1,17,70,GROUND+7,19,BEDROCK);
  fillBox(world,82,GROUND+1,4,83,GROUND+7,27,BEDROCK);
  fillBox(world,53,GROUND+8,4,83,GROUND+8,19,BEDROCK);
  fillBox(world,4,GROUND+1,36,18,GROUND+7,38,BEDROCK);
  fillBox(world,17,GROUND+1,38,19,GROUND+7,56,BEDROCK);
  fillBox(world,4,GROUND+1,69,28,GROUND+7,70,BEDROCK);
  fillBox(world,4,GROUND+8,36,19,GROUND+8,69,BEDROCK);
  fillBox(world,108,GROUND+1,40,110,GROUND+7,58,BEDROCK);
  fillBox(world,109,GROUND+1,58,123,GROUND+7,60,BEDROCK);
  fillBox(world,102,GROUND+1,25,123,GROUND+7,27,BEDROCK);
  fillBox(world,108,GROUND+8,26,123,GROUND+8,60,BEDROCK);
  // Colored lintels and tall gantries distinguish the three approaches.
  gantry(world,72,25,80,25,6);
  gantry(world,25,59,25,67,6);
  gantry(world,100,30,100,38,6);
  // Half-cover islands with wide bypasses. Breachers can remove the center
  // wall while runners take the adjacent, already open route.
  for (const [x,z,axis] of [[62,35,'x'],[39,52,'z'],[88,47,'z']]) {
    for (let n=0;n<5;n++) {
      const px=x+(axis==='x'?n:0), pz=z+(axis==='z'?n:0);
      fillBox(world,px,GROUND+1,pz,px,GROUND+2,pz,CONCRETE);
      world.setBlock(px,GROUND+3,pz,WOOD);
    }
  }
  for (const [x,z] of [[47,40],[79,36],[46,62],[79,62],[33,43],[96,58],[53,73],[72,74]]) {
    fillBox(world,x,GROUND+1,z,x+3,GROUND+1,z+2,RUST);
    fillBox(world,x+1,GROUND+2,z,x+2,GROUND+2,z+1,WOOD);
    world.setBlock(x,GROUND+2,z+2,PALE);
  }
  // A pair of short observation decks. Steps face the courtyard and their
  // sight lines cover a flank without overlooking every entrance.
  for (const [x,z] of [[31,31],[87,61]]) {
    fillBox(world,x,GROUND+1,z,x+8,GROUND+3,z+7,CONCRETE);
    paintFloor(world,x,z,x+8,z+7,GROUND+3,METAL);
    for(let i=0;i<3;i++) fillBox(world,x+3,GROUND+1,z+8+i,x+5,GROUND+3-i,z+8+i,CONCRETE);
    fillBox(world,x,GROUND+4,z,x+8,GROUND+4,z,METAL);
  }
  // Coolant tanks break the long north/east sight lines. Solid shells with
  // wide bypasses on every side; the accent band reads at a distance.
  for (const [x,z] of [[50,30],[84,44]]) {
    fillBox(world,x-1,GROUND+1,z-1,x+1,GROUND+4,z+1,STONE);
    fillBox(world,x-1,GROUND+5,z-1,x+1,GROUND+5,z+1,METAL);
    for(let n=-1;n<=1;n++) { world.setBlock(x+n,GROUND+3,z-1,ACCENT); world.setBlock(x+n,GROUND+3,z+1,ACCENT); }
  }
  // Breachable ruin walls give breachers extra targets and split bot lanes.
  for (const [x,z] of [[54,44],[55,44],[57,44],[57,45],[57,46],[70,40],[71,40],[73,40]]) {
    fillBox(world,x,GROUND+1,z,x,GROUND+2,z,RUST);
  }
  // Low pipe gantry across the western approach, legs clear of the route.
  gantry(world,30,50,38,50,6);
  // Transformer yard south-east: cabinets block sight without blocking paths.
  for (const [x,z] of [[100,64],[102,65],[100,66]]) {
    fillBox(world,x,GROUND+1,z,x,GROUND+3,z,METAL);
    world.setBlock(x,GROUND+4,z,ACCENT);
  }
  // Extra crate stacks near the northern road and the defender line.
  for (const [x,z] of [[60,28],[70,60]]) {
    fillBox(world,x,GROUND+1,z,x+3,GROUND+1,z+2,RUST);
    fillBox(world,x+1,GROUND+2,z,x+2,GROUND+2,z+1,WOOD);
    world.setBlock(x,GROUND+2,z+2,PALE);
  }
  // Service alcove for the mid-wave resupply run, south of the core.
  fillBox(world,56,GROUND+1,85,72,GROUND+5,86,RUST);
  fillBox(world,56,GROUND+6,75,72,GROUND+6,86,METAL);
  for(const x of [56,72]) fillBox(world,x,GROUND+1,76,x,GROUND+5,76,METAL);
  paintFloor(world,61,76,67,81,GROUND,BEDROCK);
  for(const x of [61,67]) paintFloor(world,x,76,x,81,GROUND,ACCENT);
  // Every stage objective stands on an indestructible 7x7 pad; the shared
  // protection pass then armours spawns, defender points and vehicle routes.
  for (const s of layout.stages) {
    const ox = Math.floor(s.objective.x), oz = Math.floor(s.objective.z);
    paintFloor(world, ox - 3, oz - 3, ox + 3, oz + 3, GROUND, BEDROCK);
  }
  protectLayout(world, layout);
}

/**
 * Protection pass shared by every Bastion map (a copy lives in each generator):
 * indestructible pads under every authored point, a cleared and armoured strip
 * along every vehicle route, and an accent outline around each build zone.
 */
function protectLayout(world, layout) {
  const G = GROUND;
  const pad = (p, r) => paintFloor(world, Math.floor(p.x) - r, Math.floor(p.z) - r, Math.floor(p.x) + r, Math.floor(p.z) + r, G, BEDROCK);
  for (const lane of layout.lanes) pad(lane.entry, 1);
  for (const s of layout.stages) {
    for (const p of [...s.spawns, ...s.defenders, s.supply]) pad(p, 1);
    for (let i = 1; i < s.vehicleRoute.length; i++) {
      const a = s.vehicleRoute[i - 1], b = s.vehicleRoute[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(len / 0.5));
      for (let n = 0; n <= steps; n++) {
        const t = Math.min(1, n / steps), cx = Math.floor(a.x + (b.x - a.x) * t), cz = Math.floor(a.z + (b.z - a.z) * t);
        paintFloor(world, cx - 2, cz - 2, cx + 2, cz + 2, G, BEDROCK);
        for (let y = G + 1; y <= G + 4; y++) for (let z = cz - 2; z <= cz + 2; z++) for (let x = cx - 2; x <= cx + 2; x++) {
          if (world.getBlock(x, y, z) !== BEDROCK) world.setBlock(x, y, z, AIR);
        }
      }
    }
    const { minX, maxX, minZ, maxZ } = s.buildZone;
    for (let x = minX; x <= maxX; x++) for (const z of [minZ, maxZ]) if (world.getBlock(x, G, z) === CONCRETE) world.setBlock(x, G, z, ACCENT);
    for (let z = minZ; z <= maxZ; z++) for (const x of [minX, maxX]) if (world.getBlock(x, G, z) === CONCRETE) world.setBlock(x, G, z, ACCENT);
  }
}

function building(world,x0,z0,x1,z1,h) {
  fillBox(world,x0,GROUND+1,z0,x1,GROUND+h,z1,RUST);
  fillBox(world,x0+1,GROUND+1,z0+1,x1-1,GROUND+h-1,z1-1,AIR);
  fillBox(world,x0,GROUND+h,z0,x1,GROUND+h,z1,METAL);
  for(const x of [x0,x1]) for(const z of [z0,z1]) fillBox(world,x,GROUND+1,z,x,GROUND+h,z,METAL);
  fillBox(world,x0+3,GROUND+3,z1,x1-3,GROUND+4,z1,GLASS);
  fillBox(world,x0+3,GROUND+1,z1,x0+5,GROUND+2,z1,AIR);
  for(let x=x0+3;x<x1-2;x+=5) fillBox(world,x,GROUND+h+1,z0+3,x+2,GROUND+h+2,z0+6,STONE);
}

function gantry(world,x0,z0,x1,z1,h) {
  for(const [x,z] of [[x0,z0],[x1,z1]]) fillBox(world,x,GROUND+1,z,x,GROUND+h,z,METAL);
  fillBox(world,x0,GROUND+h,z0,x1,GROUND+h,z1,ACCENT);
}
