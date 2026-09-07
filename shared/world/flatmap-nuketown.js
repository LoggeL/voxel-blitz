import {
  AIR, GRASS, SAND, WOOD, LEAVES, CONCRETE, METAL, PLANK, GLASS, PALE, BRICK,
  YELLOW_SIDING, TEAL_SIDING, ASPHALT, ROOF, BUS_YELLOW, TRUCK_RED, GROUND,
} from './blocks.js';
import { generateFlatBase, fillBox, paintFloor } from './flatmaps.js';
import { addNeighborhoodLandmarks } from './setpiece-nuketown.js';

/** Classic test-town layout. All cover, furniture and architecture are authoritative voxels. */
export function generateNuketownInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  const box = (x,y,z,X,Y,Z,t) => fillBox(world,x,GROUND+y,z,X,GROUND+Y,Z,t);
  const floor = (x,z,X,Z,t) => paintFloor(world,x,z,X,Z,GROUND,t);
  // Desert apron with a low perimeter: no industrial arena walls against the sky.
  box(0,1,0,127,25,95,AIR);
  floor(0,0,127,95,SAND);
  floor(23,7,104,88,GRASS);
  for (const x of [21,105]) box(x,1,6,x,4,89,PALE);
  for (const z of [5,89]) box(21,1,z,105,4,z,PALE);
  floor(24,38,103,57,CONCRETE);
  floor(24,40,103,55,ASPHALT);
  for (let x=27;x<102;x+=9) floor(x,47,x+4,47,BUS_YELLOW);
  // Rounded end of the cul-de-sac.
  for(let z=28;z<=67;z++) for(let x=87;x<=103;x++) {
    if ((x-87)**2+(z-47.5)**2<19**2) world.setBlock(x,GROUND,z,ASPHALT);
  }
  floor(42,33,57,39,CONCRETE);
  floor(70,56,85,62,CONCRETE);
  house(world, false);
  house(world, true);
  bus(box, 47, 42);
  truck(box, 68, 49);
  car(box, 87, 34, TEAL_SIDING);
  car(box, 31, 53, TRUCK_RED);
  // Backyards, sheds, planting beds and barbecue patios.
  for (const flip of [false,true]) {
    const b = orientedBox(world,flip);
    b(36,0,73,47,0,80,CONCRETE);
    b(30,1,77,37,4,84,PALE); b(31,1,78,36,3,83,AIR);
    b(32,1,77,34,3,77,AIR); b(29,5,76,38,5,85,ROOF);
    // Picnic table with benches, grill, red propane bottle and garden beds.
    b(40,2,76,45,2,78,PLANK); b(41,1,77,41,1,77,METAL); b(44,1,77,44,1,77,METAL);
    b(40,1,74,45,1,74,PLANK); b(40,1,80,45,1,80,PLANK);
    b(48,1,78,48,2,78,METAL); b(47,3,77,49,3,79,METAL); b(50,1,79,50,2,79,TRUCK_RED);
    for(let x=61;x<91;x+=7) {
      b(x,1,86,x+4,1,87,BRICK); b(x+1,2,86,x+3,2,86,LEAVES);
      b(x+2,3,86,x+2,3,86,x%2?BUS_YELLOW:TRUCK_RED);
    }
    // Picket fences frame the garden; side routes stay four metres wide.
    for(let x=25;x<=101;x+=3) b(x,1,88,x,3,88,PALE);
    b(25,2,88,101,2,88,PALE);
    for(let z=62;z<85;z+=3) { b(26,1,z,26,3,z,PALE); b(100,1,z,100,3,z,PALE); }
    b(26,2,62,26,2,84,PALE); b(100,2,62,100,2,84,PALE);
    // Shrubs and a shade tree clear of the spawn strip.
    b(90,1,74,93,2,78,LEAVES);
    b(95,1,80,95,7,80,WOOD); b(92,6,78,98,8,82,LEAVES); b(93,9,79,97,9,81,LEAVES);
    // Mailbox and hydrant by each front path.
    b(45,1,59,45,2,59,WOOD); b(44,3,59,46,3,60,PALE);
    b(29,1,59,29,2,59,TRUCK_RED); b(28,2,59,30,2,59,TRUCK_RED);
  }
  // Entrance sign frame, sandbag-free garden cover, and stacked moving crates.
  box(28,1,32,28,6,32,WOOD); box(39,1,32,39,6,32,WOOD);
  box(28,4,32,39,7,32,TEAL_SIDING);
  for (const [x,z] of [[65,52],[80,44],[83,45],[40,42]]) {
    box(x,1,z,x+2,2,z+2,PLANK); box(x,3,z,x+1,3,z+1,PLANK);
  }
  polishNeighborhood(world);
  addNeighborhoodLandmarks(world);
}

function polishNeighborhood(world) {
  for (const flip of [false, true]) {
    const b = orientedBox(world, flip);
    // Stepping stones and a patio border make each garden read as a lived-in
    // place. These are floor inlays, including through the rear spawn strip.
    for (let z = 63; z <= 84; z += 3) b(28,0,z,30,0,z+1,CONCRETE);
    for (let x = 40; x <= 55; x += 3) b(x,0,82,x+1,0,83,PALE);
    b(36,0,73,47,0,73,BRICK); b(36,0,73,36,0,80,BRICK);
    // Flush zebra markings at each end of the street, plus driveway tyre wear.
    for (let z = 41; z <= 45; z += 2) b(36,0,z,39,0,z,PALE);
    b(78,0,57,78,0,62,ASPHALT); b(83,0,57,83,0,62,ASPHALT);
    // Garden shed: timber facade, braced door surround, window and roof vent.
    b(30,1,77,31,4,77,PLANK); b(35,1,77,37,4,77,PLANK);
    b(32,4,77,34,4,77,WOOD);
    b(37,2,80,37,3,82,GLASS);
    b(32,6,80,34,6,81,METAL);
    b(33,7,80,33,7,81,PALE);
    // A workbench and stacked seed boxes occupy the shed's rear wall.
    b(31,1,83,35,1,83,WOOD); b(31,2,83,35,2,83,PLANK);
    b(31,3,83,32,3,83,TEAL_SIDING);
    // Raised trellis along the existing side fence, clear of the garden route.
    for (let z = 65; z <= 74; z += 3) {
      b(100,4,z,100,5,z,WOOD);
      b(100,5,z+1,100,5,z+1,LEAVES);
    }
    b(100,6,65,100,6,74,WOOD);
    // Roof hardware and window shutters give the two houses more depth.
    b(76,7,65,78,7,67,METAL); b(76,8,65,78,8,65,PALE);
    b(85,7,71,87,7,74,METAL);
    for (const x of [51,57,65,71]) {
      b(x,3,61,x,4,61,flip?YELLOW_SIDING:TEAL_SIDING);
      b(x,9,61,x,10,61,flip?YELLOW_SIDING:TEAL_SIDING);
    }
    // Living-room rug and kitchen splashback are flush, preserving stair and
    // door clearance. The garage has a tool board above its existing bench.
    b(55,0,69,62,0,74,TRUCK_RED);
    b(55,0,69,62,0,69,PALE); b(55,0,74,62,0,74,PALE);
    b(55,0,70,55,0,73,PALE); b(62,0,70,62,0,73,PALE);
    b(66,4,76,72,4,76,TEAL_SIDING);
    for (const x of [77,79,81]) {
      b(x,3,76,x,4,76,TRUCK_RED);
      b(x,4,76,x,4,76,PALE);
    }
    b(78,3,75,79,3,75,METAL);
    b(66,5,75,68,5,75,PLANK);
    // A bedside cabinet and wall artwork sit away from upper-floor routes.
    b(71,7,74,72,8,75,PLANK); b(72,9,75,72,9,75,PALE);
    b(65,9,76,68,10,76,TEAL_SIDING);
    b(66,9,76,67,9,76,BUS_YELLOW);
  }
}

function orientedBox(world, flip) {
  return (x,y,z,X,Y,Z,t) => flip
    ? fillBox(world,127-X,GROUND+y,95-Z,127-x,GROUND+Y,95-z,t)
    : fillBox(world,x,GROUND+y,z,X,GROUND+Y,Z,t);
}

function house(world,flip) {
  const b=orientedBox(world,flip), siding=flip?TEAL_SIDING:YELLOW_SIDING;
  // Two floors with a street-facing bedroom and a rear balcony.
  b(49,0,61,74,0,76,PLANK);
  b(49,1,61,74,12,76,siding); b(50,1,62,73,11,75,AIR);
  b(49,6,61,74,6,76,PLANK);
  b(49,1,61,74,1,61,BRICK); b(49,1,76,74,1,76,BRICK);
  for(const y of [6,12]) b(48,y,60,75,y,77,PALE);
  for(const x of [49,74]) { b(x,1,61,x,12,61,PALE); b(x,1,76,x,12,76,PALE); }
  // Doorways are three cells wide and four cells tall.
  b(59,1,61,62,4,61,AIR); b(59,1,76,62,4,76,AIR);
  for(const z of [61,76]) for(const x of [52,66]) {
    b(x-1,2,z,x+5,5,z,PALE); b(x,3,z,x+4,4,z,GLASS);
    b(x+2,3,z,x+2,4,z,PALE);
    b(x-1,8,z,x+5,11,z,PALE); b(x,9,z,x+4,10,z,AIR);
  }
  // Side kitchen door gives the garage a direct connection.
  b(74,1,66,74,4,69,AIR);
  b(49,3,67,49,4,71,GLASS);
  // Stairwell: a broad voxel stair, with open headroom across both floors.
  b(51,6,66,54,6,74,AIR);
  for(let i=0;i<6;i++) b(51,1,66+i,54,i+1,66+i,PLANK);
  b(51,6,72,54,6,74,PLANK);
  // Partition separates living room from kitchen, with a generous connecting door.
  b(64,1,64,64,5,75,PALE); b(64,1,68,64,4,71,AIR);
  // Living room: sofa, armchair, coffee table, television and bookcase.
  b(55,1,73,58,1,74,TRUCK_RED); b(55,2,74,58,2,74,TRUCK_RED);
  b(55,2,73,55,2,73,TRUCK_RED); b(58,2,73,58,2,73,TRUCK_RED);
  b(60,1,72,61,1,73,TEAL_SIDING); b(61,2,72,61,2,73,TEAL_SIDING);
  b(56,1,70,58,1,71,PLANK);
  b(59,1,64,62,1,64,WOOD); b(60,2,64,61,3,64,METAL);
  b(50,1,63,50,4,65,PLANK); b(50,2,64,50,3,64,TRUCK_RED);
  // Kitchen cabinets, tiled floor, cooker and refrigerator.
  b(65,0,62,73,0,75,PALE);
  for(let x=65;x<=73;x++) for(let z=62;z<=75;z++) if((x+z)%2===0) b(x,0,z,x,0,z,CONCRETE);
  b(66,1,74,72,2,75,TEAL_SIDING); b(66,3,74,72,3,75,PALE);
  b(69,3,74,70,3,74,METAL); b(72,1,62,73,4,63,PALE);
  b(67,2,65,70,2,66,PLANK); b(67,1,65,67,1,65,WOOD); b(70,1,66,70,1,66,WOOD);
  // Upper bedroom: bed, pillows, wardrobe and desk beside the firing window.
  b(66,7,71,70,7,74,WOOD); b(66,8,71,70,8,74,TEAL_SIDING);
  b(66,9,74,70,9,74,WOOD); b(67,9,73,69,9,73,PALE);
  b(72,7,68,73,10,70,PLANK); b(57,8,62,60,8,63,PLANK);
  b(57,7,62,57,7,62,WOOD); b(60,7,63,60,7,63,WOOD);
  b(59,7,65,60,7,65,TRUCK_RED);
  // Rear balcony with an external staircase, a second upper-floor route.
  b(59,7,76,62,10,76,AIR); b(56,6,77,66,6,79,PLANK);
  b(56,7,79,58,7,79,PALE); b(63,7,79,66,7,79,PALE);
  for(let i=0;i<6;i++) b(60,1,85-i,62,i+1,85-i,PLANK);
  // Low attached garage: open front, workbench, tool wall, side garden exit.
  b(75,1,63,87,5,76,PALE); b(76,1,64,86,4,75,AIR);
  b(77,1,63,85,4,63,AIR); b(82,1,76,85,3,76,AIR);
  b(74,6,62,88,6,77,ROOF); b(77,1,74,80,2,75,PLANK);
  b(77,3,76,81,4,76,METAL);
  // Stepped pitched roof, deep eaves, chimney and aerial anchor.
  for(let i=0;i<5;i++) {
    b(48,13+i,60+i,75,13+i,60+i,ROOF);
    b(48,13+i,77-i,75,13+i,77-i,ROOF);
    b(49,13+i,61+i,49,13+i,76-i,siding);
    b(74,13+i,61+i,74,13+i,76-i,siding);
  }
  b(48,18,65,75,18,72,ROOF);
  b(69,13,70,71,20,72,BRICK); b(68,21,69,72,21,73,PALE);
}

function bus(b,x,z) {
  b(x,1,z,x+17,1,z+5,METAL); b(x,2,z,x+17,5,z+5,BUS_YELLOW);
  b(x+1,2,z+1,x+16,5,z+4,AIR);
  b(x,6,z,x+17,6,z+5,BUS_YELLOW);
  for(const dz of [0,5]) {
    b(x,3,z+dz,x+17,3,z+dz,METAL);
    for(let i=2;i<15;i+=3) b(x+i,4,z+dz,x+i+1,5,z+dz,GLASS);
    for(const dx of [3,13]) b(x+dx,1,z+dz,x+dx+1,2,z+dz,METAL);
  }
  b(x,4,z+1,x,5,z+4,GLASS);
  b(x+17,4,z+1,x+17,5,z+4,GLASS);
  b(x-1,2,z,x-1,2,z+5,PALE);
  b(x-1,3,z+1,x-1,3,z+1,PALE); b(x-1,3,z+4,x-1,3,z+4,PALE);
  b(x+1,2,z+5,x+2,4,z+5,AIR);
  for(let i=4;i<16;i+=3) { b(x+i,2,z+1,x+i,3,z+1,PLANK); b(x+i,2,z+4,x+i,3,z+4,PLANK); }
}

function truck(b,x,z) {
  b(x,1,z,x+17,1,z+6,METAL);
  b(x,2,z,x+5,4,z+6,TRUCK_RED); b(x+1,4,z+1,x+4,5,z+5,GLASS);
  b(x,6,z,x+5,6,z+6,TRUCK_RED);
  b(x+6,2,z,x+17,7,z+6,PALE); b(x+7,2,z+1,x+17,6,z+5,AIR);
  b(x+6,4,z,x+17,5,z,TRUCK_RED); b(x+6,4,z+6,x+17,5,z+6,TRUCK_RED);
  b(x+7,1,z+1,x+17,1,z+5,PLANK);
  for(const dx of [2,13,15]) for(const dz of [0,6]) b(x+dx,1,z+dz,x+dx+1,2,z+dz,METAL);
  b(x-1,2,z,x-1,2,z+6,PALE);
  b(x+18,1,z+1,x+20,1,z+5,PLANK);
  b(x+9,2,z+1,x+11,3,z+2,PLANK);
}

function car(b,x,z,color) {
  b(x,1,z,x+9,2,z+4,color); b(x+3,3,z,x+6,3,z+4,GLASS);
  b(x+3,4,z,x+6,4,z+4,color);
  for(const dx of [1,7]) for(const dz of [0,4]) b(x+dx,1,z+dz,x+dx+1,1,z+dz,METAL);
  b(x-1,1,z,x-1,1,z+4,PALE); b(x+10,1,z,x+10,1,z+4,PALE);
}
