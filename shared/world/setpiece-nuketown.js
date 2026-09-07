import {
  AIR, WOOD, LEAVES, CONCRETE, METAL, PLANK, PALE,
  TEAL_SIDING, BUS_YELLOW, TRUCK_RED, GROUND,
} from './blocks.js';
import { fillBox } from './flatmaps.js';

/** Large suburban objects use the same voxels for rendering, hits and movement. */
export function addNeighborhoodLandmarks(world) {
  for (const flip of [false, true]) {
    const box = (x, y, z, X, Y, Z, type) => flip
      ? fillBox(world, 127-X, GROUND+y, 95-Z, 127-x, GROUND+Y, 95-z, type)
      : fillBox(world, x, GROUND+y, z, X, GROUND+Y, Z, type);
    coveredPorch(box);
    gardenPergola(box);
    swingSet(box);
    gardenTree(box);
  }
  waterTower(world);
}

function coveredPorch(b) {
  // Deep covered entrance, with a four-cell-wide approach to the original door.
  b(55, 0, 57, 66, 0, 60, CONCRETE);
  for (const x of [55, 66]) {
    b(x, 1, 57, x, 5, 57, PALE);
    b(x, 1, 60, x, 5, 60, PALE);
    b(x, 1, 58, x, 1, 59, PLANK);
  }
  b(54, 6, 56, 67, 6, 61, PALE);
  b(55, 7, 57, 66, 7, 60, TEAL_SIDING);
  // Framed gable profile and contrasting fascia, visible from the street.
  for (let inset = 0; inset < 4; inset++) {
    b(55+inset, 7+inset, 57, 55+inset, 7+inset, 60, PALE);
    b(66-inset, 7+inset, 57, 66-inset, 7+inset, 60, PALE);
  }
  b(59, 10, 57, 62, 10, 60, PALE);
  b(55, 2, 60, 57, 2, 60, PLANK);
  b(64, 2, 60, 66, 2, 60, PLANK);
}

function gardenPergola(b) {
  // Covers the existing picnic furniture with a tall, open timber structure.
  for (const x of [39, 49]) for (const z of [73, 81]) {
    b(x, 1, z, x, 7, z, WOOD);
    b(x, 1, z, x, 1, z, PALE);
  }
  for (const z of [73, 81]) b(38, 7, z, 50, 7, z, WOOD);
  for (const x of [39, 49]) b(x, 7, 72, x, 7, 82, WOOD);
  for (let x=38; x<=50; x+=2) b(x, 8, 72, x, 8, 82, PLANK);
  // A patch of trained vines leaves half of the slatted roof open to sunlight.
  b(38, 9, 72, 42, 9, 76, LEAVES);
  b(39, 10, 73, 41, 10, 75, LEAVES);
  b(49, 9, 78, 50, 9, 81, LEAVES);
  // Sideboard and tall outdoor oven occupy the existing grill corner.
  b(47, 1, 77, 49, 3, 79, CONCRETE);
  b(47, 4, 77, 49, 5, 79, PALE);
  b(48, 4, 77, 48, 4, 78, METAL);
  b(48, 6, 79, 48, 10, 79, CONCRETE);
  b(47, 11, 78, 49, 11, 80, PALE);
}

function swingSet(b) {
  b(31, 0, 63, 44, 0, 71, PLANK);
  // Two A-frames and suspended yellow seats. The lawn remains open around it.
  for (const x of [32, 43]) {
    for (let y=1; y<=6; y++) {
      const inset=Math.floor((y-1)/2);
      b(x, y, 64+inset, x, y, 64+inset, TEAL_SIDING);
      b(x, y, 70-inset, x, y, 70-inset, TEAL_SIDING);
    }
    b(x, 4, 65, x, 4, 69, TEAL_SIDING);
  }
  b(32, 7, 67, 43, 7, 67, TEAL_SIDING);
  for (const x of [35, 40]) {
    b(x, 2, 66, x+2, 2, 67, BUS_YELLOW);
    b(x, 3, 67, x, 6, 67, METAL);
    b(x+2, 3, 67, x+2, 6, 67, METAL);
  }
  // Toy chest and a small red wagon parked along the edge of the play surface.
  b(31, 1, 71, 33, 2, 71, TEAL_SIDING);
  b(42, 1, 71, 44, 1, 72, METAL);
  b(42, 2, 71, 44, 2, 72, TRUCK_RED);
  b(44, 3, 72, 44, 4, 72, METAL);
}

function gardenTree(b) {
  b(92, 1, 64, 93, 10, 65, WOOD);
  b(90, 7, 64, 95, 8, 65, WOOD);
  b(92, 8, 62, 93, 9, 68, WOOD);
  const crown = (cx, cy, cz, rx, ry, rz) => {
    for(let y=-ry;y<=ry;y++) for(let z=-rz;z<=rz;z++) for(let x=-rx;x<=rx;x++) {
      if(x*x/(rx*rx)+y*y/(ry*ry)+z*z/(rz*rz) <= 1.15) {
        b(cx+x, cy+y, cz+z, cx+x, cy+y, cz+z, LEAVES);
      }
    }
  };
  crown(90, 11, 64, 4, 3, 4);
  crown(95, 12, 65, 4, 3, 4);
  crown(92, 15, 64, 4, 3, 4);
}

function waterTower(world) {
  const b=(x,y,z,X,Y,Z,type)=>fillBox(world,x,GROUND+y,z,X,GROUND+Y,Z,type);
  // Beyond the west fence, the utility tower makes the street's end recognizable.
  b(5, 0, 39, 17, 0, 53, CONCRETE);
  for(const x of [6,16]) for(const z of [40,52]) {
    b(x, 1, z, x, 15, z, METAL);
    b(x-1, 1, z-1, x+1, 1, z+1, CONCRETE);
  }
  for(const y of [5,10,15]) {
    for(const z of [40,52]) b(6,y,z,16,y,z,METAL);
    for(const x of [6,16]) b(x,y,40,x,y,52,METAL);
  }
  for(let i=0;i<10;i++) {
    for(const z of [40,52]) b(6+i,5+i,z,6+i,5+i,z,PALE);
  }
  for(let y=15;y<=22;y++) for(let z=39;z<=53;z++) for(let x=4;x<=18;x++) {
    const distance=(x-11)**2+(z-46)**2;
    const radius=y>=21?6:y===15?6:7;
    if(distance>radius*radius)continue;
    const type=y===18||y===19?TEAL_SIDING:PALE;
    b(x,y,z,x,y,z,distance<(radius-1)**2&&y>15&&y<22?AIR:type);
  }
  b(7,23,42,15,23,50,TEAL_SIDING);
  b(9,24,44,13,24,48,PALE);
  b(17,1,47,17,15,47,METAL);
  for(let y=2;y<15;y+=2)b(17,y,48,17,y,48,PALE);
}
