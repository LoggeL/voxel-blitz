import assert from 'node:assert/strict';
import { createMapState, GROUND, AIR } from '../shared/worlddata.js';
import { DEFAULT_BLOCK_TILES, TILE_PAINTERS } from '../public/js/engine/atlas.js';
import { MINING_HITS, GRENADE_RESISTANCE } from '../shared/world/blocks.js';
const world = createMapState('nuketown');
const bytes = world.serializeWorld();
assert.deepEqual(createMapState('nuketown', bytes).serializeWorld(), bytes);
for (const type of new Set(bytes.subarray(6))) {
  assert.ok(DEFAULT_BLOCK_TILES[type], `texture for ${type}`);
  if(type!==AIR) {
    assert.ok(MINING_HITS[type]>0, `mining for ${type}`);
    assert.ok(GRENADE_RESISTANCE[type]>0, `blast resistance for ${type}`);
  }
  for(const tile of Object.values(DEFAULT_BLOCK_TILES[type])) assert.ok(TILE_PAINTERS[tile]);
}
// Traverse standing positions, allowing a one-voxel jump up or down. This catches
// sealed doors, blocked stairs, isolated gardens and furniture across corridors.
const free=(x,y,z)=>world.getBlock(x,y,z)===AIR&&world.getBlock(x,y+1,z)===AIR;
const stand=(x,y,z)=>y>=15&&y<36&&free(x,y,z)&&world.getBlock(x,y-1,z)!==AIR;
const key=(x,y,z)=>`${x},${y},${z}`;
const queue=[[43,GROUND+1,83]], seen=new Set([key(...queue[0])]);
for(let i=0;i<queue.length;i++) {
  const [x,y,z]=queue[i];
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) for(const dy of [0,1,-1]) {
    const X=x+dx,Y=y+dy,Z=z+dz,k=key(X,Y,Z);
    if(X<22||X>104||Z<6||Z>88||seen.has(k)||!stand(X,Y,Z)) continue;
    if(dy===1&&!free(x,y+1,z)) continue;
    seen.add(k);queue.push([X,Y,Z]);
  }
}
for(const [name,x,y,z] of [
  ['yellow living room',59,15,68],['green living room',68,15,27],
  ['yellow bedroom',63,21,69],['green bedroom',64,21,26],
  ['yellow balcony',60,21,78],['green balcony',67,21,17],
  ['yellow garage',80,15,68],['green garage',47,15,27],
  ['bus aisle',55,16,44],['truck cargo',82,16,52],
]) assert.ok(seen.has(key(x,y,z)), `${name} is reachable`);
for(const spawn of [...world.meta.spawns.fun,...world.meta.spawns.tdm.alpha,...world.meta.spawns.tdm.bravo]) {
  assert.ok(seen.has(key(Math.floor(spawn.x),Math.floor(spawn.y),Math.floor(spawn.z))), 'spawn connects to map');
}
for(const site of world.meta.sites) for(let x=site.minX;x<=site.maxX;x++) for(let z=site.minZ;z<=site.maxZ;z++) {
  assert.ok(seen.has(key(x,15,z)), `site ${site.id} floor remains clear ${x},${z}`);
}
console.log(`Nuketown: serialization, materials and ${seen.size} connected standing positions verified.`);
