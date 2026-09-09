import assert from 'node:assert/strict';
import { BLOCK_HP, BLOCK_HARDNESS, METAL, STONE, PLANK, GLASS, AIR } from '../shared/world/blocks.js';
import { bulletMaterialImpact, bulletPower, BULLET_RULES } from '../shared/bullet-material.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot } from '../server/sim/combat.js';

for (let type = 1; type <= 28; type++) {
  assert.ok(BLOCK_HP[type] > 0 && BLOCK_HARDNESS[type] > 0, `material ${type} has HP and hardness`);
}
for (const def of Object.values(WEAPONS).filter(d => !d.projectile && !d.flame && !d.melee)) {
  assert.ok(bulletPower(def) > 0, `${def.id} has bullet penetration`);
}
const impact = (extra = {}) => bulletMaterialImpact({type: STONE, power: 55, damage: 25, hp: 320, ...extra});
assert.ok(impact().damage > 0, 'weak rounds chip hard blocks');
assert.equal(impact().action, 'stop');
assert.ok(impact({power:180}).damage > impact().damage);
assert.equal(impact({power:180}).action, 'penetrate');
assert.equal(impact({hp:1}).action, 'penetrate', 'breaking a weakened block lets the bullet continue');
assert.equal(impact({incidence:.2}).action, 'ricochet');
assert.equal(impact({incidence:.2,bounces:BULLET_RULES.maxRicochets}).action, 'stop');
assert.notEqual(impact({type:GLASS,incidence:.2}).action, 'ricochet');
for (const result of [impact(), impact({power:180}), impact({incidence:.2}), impact({hp:1})]) {
  assert.ok(result.damageScale >= 0 && result.damageScale < 1);
}

function fixture(weapon = 'rifle', blocks = [], direction = [1,0,0], target = [8.5,2.5,.5]) {
  const shooter = new PlayerEntity('s', 'Shooter', {x:.5,y:2,z:.5});
  shooter.weapon = WEAPON_IDS.indexOf(weapon);
  shooter.yaw = Math.atan2(-direction[0],-direction[2]);
  shooter.pitch = Math.asin(direction[1]);
  const victim = new PlayerEntity('v','Victim',{x:target[0],y:target[1],z:target[2]});
  victim.hp = 10000;
  const world = new Map(blocks.map(([x,y,z,type])=>[`${x},${y},${z}`,type]));
  const events = [], deltas = [];
  const ctx = {now:1000, entities:new Map([['s',shooter],['v',victim]]), blockHp:new Map(),
    getBlock:(x,y,z)=>world.get(`${x},${y},${z}`)||AIR,
    solidAt:(x,y,z)=>world.get(`${x},${y},${z}`)||AIR,
    setBlock:(x,y,z,v)=>world.set(`${x},${y},${z}`,v),
    pushBlockDelta:(...args)=>deltas.push(args), pushBlockDamage(){},
    computeConeDeg:()=>0, canDamage:()=>true, pushEvent:e=>events.push(e), killPlayer(){}};
  const fire=()=>fireOneShot(shooter,ctx);
  return {shooter,victim,world,ctx,events,deltas,fire};
}
const clear=fixture();clear.fire();
const covered=fixture('rifle',[[3,3,0,PLANK]]);covered.fire();
assert.ok(covered.victim.hp > clear.victim.hp && covered.victim.hp < 10000,'cover attenuates damage behind it');
const stacked=fixture('rifle',[[3,3,0,PLANK],[5,3,0,PLANK]]);stacked.fire();
assert.ok(stacked.victim.hp > covered.victim.hp,'each layer reduces damage further');
const stone=fixture('rifle',[[3,3,0,STONE],[3,3,1,STONE]]);
stone.fire();
assert.equal(stone.victim.hp,10000,'hard cover stops the first bullet');
assert.ok(stone.ctx.blockHp.get('3,3,0') < BLOCK_HP[STONE]);
assert.equal(stone.ctx.blockHp.has('3,3,1'),false,'neighboring blocks keep independent health');
let count=1;
while(stone.world.get('3,3,0') && count++<100) stone.fire();
assert.equal(stone.world.get('3,3,0'),AIR,'sustained fire eventually destroys stone');
assert.equal(stone.world.get('3,3,1'),STONE);
assert.equal(stone.deltas.length,1,'destruction emitted once');
assert.equal(stone.ctx.blockHp.has('3,3,0'),false,'destroyed HP clears');
const weak=fixture('rifle',[[3,3,0,STONE]]);weak.ctx.blockHp.set('3,3,0',1);weak.fire();
assert.ok(weak.victim.hp<10000,'breaking shot can hit the target behind');
const bounce=fixture('rifle',[[2,3,1,METAL]],[Math.sqrt(.96),0,.2],[7.3,2.5,.12]);
bounce.fire();
const path=bounce.events.find(e=>e.kind==='shoot').paths[0];
assert.equal(path[0].action,'ricochet');
assert.ok(path[1].end[2]<path[1].o[2],'reflected path travels away from the face');
assert.ok(bounce.victim.hp<10000,'reflected bullet can damage a target');
assert.ok(bounce.victim.hp>clear.victim.hp,'ricochet damage is reduced');
assert.ok(path.length<=BULLET_RULES.maxContacts);
console.log('Bullet materials passed: complete material/weapon profiles, chip damage, penetration, stacked cover, independent HP, breaking continuation, ricochet direction and damage.');

// The client renders the resolved polyline, even if its terrain has already changed.
const { TracerFX } = await import('../public/js/weapons/ballistics.js');
const THREE = await import('../public/js/vendor/three.module.js');
const rendered = [], contacts = [];
const fx = Object.create(TracerFX.prototype);
Object.assign(fx, {_direction:new THREE.Vector3(),
  spawnTracer:(o,d,length)=>rendered.push({o:[...o],d:d.clone(),length}),
  onWallImpact:hit=>contacts.push(hit),
  getBlockFn(){throw Error('confirmed paths must not recast changed terrain');}});
fx.resolvedShot({w:'rifle',paths:[path]});
assert.equal(rendered.length,2);
assert.ok(rendered[0].d.z>0 && rendered[1].d.z<0);
assert.equal(contacts.length,1);
rendered.length=0;
fx.resolvedShot({w:'rifle',paths:[path]},{continuationsOnly:true});
assert.equal(rendered.length,1,'local confirmation adds the reflected tracer once');
const {RailBeamFX} = await import('../public/js/weapons/rail-beam.js');
const rails = new RailBeamFX(new THREE.Scene(),()=>{throw Error('confirmed rail must not recast terrain');});
rails.shoot({w:'lance',paths:[path]});
assert.equal(rails.pool.filter(b=>b.group.visible).length,2);
assert.ok(rails.pool[0].length>0 && rails.pool[1].length>0);
rails.dispose();
console.log('Confirmed tracer and rail paths passed: correct reflections and no terrain recast.');

const floor = fixture('lance',[[3,0,0,METAL]],[1,0,0],[8.5,-.5,.5]);
floor.shooter.y = -1;
floor.fire();
assert.equal(floor.world.get('3,0,0'),METAL);
assert.equal(floor.ctx.blockHp.size,0,'the bottom boundary cannot accumulate bullet damage');
assert.equal(floor.victim.hp,10000,'bottom boundary stops penetration');
for(let type=1;type<=28;type++) for(const power of [1,20,55,180,1400]) {
 for(const incidence of [.01,.2,.5,1]) {
  const r=bulletMaterialImpact({type,power,damage:25,hp:BLOCK_HP[type],incidence});
  assert.ok(Number.isFinite(r.damage) && r.damage>0);
  assert.ok(r.power>=0 && r.power<power && r.damageScale>=0 && r.damageScale<1);
 }
}
console.log('Boundary protection and energy monotonicity across all materials passed.');
