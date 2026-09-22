import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { SkinLayer } from '../public/js/cosmetics/skin-layer.js';
import { CosmeticAudio, cosmeticSoundUrl } from '../public/js/audio/cosmetics.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { applyGunCosmetics, applyAvatarCosmetics } from '../public/js/cosmetics/skins.js';
import { makeAvatar, setAvatarTeam, setAvatarOpacity, disposeAvatar, TEAM_AVATAR_COLORS } from '../public/js/avatar/avatar.js';
import { CAREER_CATALOG } from '../shared/career.js';
import { KillcamHistory } from '../public/js/player/killcam-history.js';
import { CombatFeedback } from '../public/js/combat/feedback.js';

const source=new THREE.MeshStandardMaterial({color:0x123456});
const a=new THREE.Mesh(new THREE.BoxGeometry(),source),b=new THREE.Mesh(new THREE.BoxGeometry(),source);
const layer=new SkinLayer();layer.tint(a,{[0x123456]:0x654321});
assert.notEqual(a.material,b.material);assert.equal(b.material.color.getHex(),0x123456);
const extra=layer.group(a);layer.box(extra,[.1,.1,.1],[0,0,0],0xffffff);
let cloneDisposals=0;a.material.addEventListener('dispose',()=>cloneDisposals++);
layer.clear();layer.clear();assert.equal(a.material,source);assert.equal(a.children.length,0);assert.equal(cloneDisposals,1);

for(const item of CAREER_CATALOG.filter(i=>i.kind==='weaponSkin')) {
 const cache=new MaterialCache(),controlCache=new MaterialCache();
 const model=buildGun(item.weapon,cache),control=buildGun(item.weapon,controlCache);
 const originalChildren=model.body.children.length, muzzle=model.muzzleMarker.position.clone(),sight=model.body.userData.sightHeight;
 const own=new Map();model.root.traverse(o=>{if(o.material)own.set(o,o.material);});
 const other=new Map();control.root.traverse(o=>{if(o.material)other.set(o,o.material.color?.getHex());});
 applyGunCosmetics(model,item.weapon,{weaponSkins:{[item.weapon]:item.id}});
 assert.equal(model.root.userData.skin,item.id);assert.deepEqual(model.muzzleMarker.position,muzzle);assert.equal(model.body.userData.sightHeight,sight);
 for(const [object,color] of other)assert.equal(object.material.color?.getHex(),color,'other rig remains unchanged');
 applyGunCosmetics(model,item.weapon,{weaponSkins:{}});
 assert.equal(model.body.children.length,originalChildren);
 for(const [object,material] of own)assert.equal(object.material,material,'standard restores original material identity');
 disposeGunModels([model],cache);disposeGunModels([control],controlCache);
}
// BLOCKWORKS pickaxe tiers repaint only the eight sprite roles; the enchant glint is an
// owned additive overlay on cloned geometry, so clearing it never frees the page-owned sprite.
{
 const pickTiers=CAREER_CATALOG.filter(i=>i.kind==='weaponSkin'&&i.weapon==='knife');
 assert.deepEqual(pickTiers.map(i=>i.id),['pickaxe-timber','pickaxe-cobble','pickaxe-gilded','pickaxe-deep-diamond','pickaxe-ashforged','pickaxe-runebound']);
 assert.ok(pickTiers.every(i=>i.collection==='Blockworks'));
 const cache=new MaterialCache(),model=buildGun('knife',cache);
 const roleMeshes=[];model.body.traverse(o=>{if(o.userData.pickaxeRole)roleMeshes.push(o);});
 assert.equal(roleMeshes.length,8,'eight role meshes');
 const base=new Map(roleMeshes.map(o=>[o,o.material.color.getHex()]));
 const owned=()=>roleMeshes.every(o=>o.geometry.userData.pageOwned===true);
 assert.ok(owned(),'the cached sprite geometry is page-owned');
 for(const item of pickTiers){
  applyGunCosmetics(model,'knife',{weaponSkins:{knife:item.id}});
  assert.ok(owned(),`${item.id} never strips the shared page-owned flag`);
  const heads=roleMeshes.filter(o=>o.userData.pickaxeRole.startsWith('head'));
  assert.ok(heads.every(o=>o.material.color.getHex()!==base.get(o)),`${item.id} repaints every head role`);
  const hand=model.root.getObjectByName('hand_r');let handTouched=false;
  hand.traverse(o=>{if(o.material&&!cache.sharedMaterials.has(o.material)&&!o.material.userData.paletteColor)handTouched=true;});
  assert.equal(handTouched,false,`${item.id} leaves the glove alone`);
  const glints=[];model.body.traverse(o=>{if(o.name.startsWith('runebound_glint_'))glints.push(o);});
  if(item.id==='pickaxe-runebound'){
   assert.equal(glints.length,8,'runebound overlays every role');
   assert.ok(glints.every(o=>o.material.isShaderMaterial&&o.material.userData.cosmeticGlow&&o.material.blending===THREE.AdditiveBlending
    &&!o.geometry.userData.pageOwned&&typeof o.onBeforeRender==='function'),'glint is an owned additive overlay');
   glints[0].onBeforeRender();assert.ok(glints[0].material.uniforms.uTime.value>0,'glint reads page time per draw');
  } else assert.equal(glints.length,0,`${item.id} has no glint`);
  if(item.id==='pickaxe-deep-diamond'){
   const hi=roleMeshes.find(o=>o.userData.pickaxeRole==='head-highlight').material;
   assert.ok(hi.emissiveIntensity>0&&hi.emissive.getHex()!==0&&hi.userData.cosmeticGlow,'diamond highlights carry a faint inner light');
  }
 }
 applyGunCosmetics(model,'knife',{weaponSkins:{}});
 assert.ok(roleMeshes.every(o=>o.material.color.getHex()===base.get(o)&&o.geometry.attributes.position.array.length>0),'standard restores the iron palette');
 assert.ok(owned(),'reset keeps the sprite geometry page-owned');
 // A second Runebound pick torn down must never free the sprite geometry the first one still draws.
 let freed=0;for(const o of roleMeshes)o.geometry.addEventListener('dispose',()=>freed++);
 const otherCache=new MaterialCache(),other=buildGun('knife',otherCache);
 applyGunCosmetics(other,'knife',{weaponSkins:{knife:'pickaxe-runebound'}});
 disposeGunModels([other],otherCache);
 assert.equal(freed,0,'disposing another Runebound pick leaves the shared sprite geometry alone');
 assert.ok(owned(),'and the shared geometry stays page-owned');
 disposeGunModels([model],cache);
}
// Use the real operator skeleton; only the nameplate canvas needs a DOM stand-in.
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
 get: (object, key) => object[key] ?? (() => {}),
}) }) };
for (const id of ['salvager','revenant']) {
 const avatar=makeAvatar('operator-1','TEST','alpha');
 const original=new Map();avatar.group.traverse(o=>original.set(o,{parent:o.parent,material:o.material}));
 applyAvatarCosmetics(avatar,{characterSkin:id});
 let added=0;avatar.group.traverse(o=>{if(o.isMesh&&!original.has(o))added++;});
 assert.ok(added>0 && added<=30,`${id} has bounded real detail geometry`);
 for(const [object,saved] of original)assert.equal(object.parent,saved.parent,'skin does not reparent animated joints');
 setAvatarTeam(avatar,'bravo');
 assert.equal(avatar.suitMaterial.color.getHex(),TEAM_AVATAR_COLORS.bravo.suit);
 const suitUsers=[...original].filter(([,saved])=>saved.material===avatar.suitMaterial);
 assert.ok(suitUsers.length>0);
 for(const [object] of suitUsers)assert.equal(object.material,avatar.suitMaterial,'team cloth remains live');
 setAvatarOpacity(avatar,.25);
 for(const mat of avatar.fadeMaterials)assert.equal(mat.opacity,.25,'new skin fades with avatar');
 applyAvatarCosmetics(avatar,{characterSkin:'standard'});
 for(const [object,saved] of original)assert.equal(object.material,saved.material,'character reset restores original material');
 disposeAvatar(avatar);
}
delete globalThis.document;
assert.equal(cosmeticSoundUrl('../../private','death'),null);assert.equal(cosmeticSoundUrl('arcade','unknown'),null);
let starts=0,stops=0;
const nodes=[];
const ctx={state:'running',currentTime:10,
 createBufferSource(){const s={connect(){return this;},disconnect(){},start(){starts++;},stop(){stops++;}};nodes.push(s);return s;},
 createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){}},connect(){return this;},disconnect(){}};},
 decodeAudioData:async()=>({duration:20})};
const audio=new CosmeticAudio({ctx,bus:{}},{storage:()=>({getItem:()=>null})});
assert.equal(audio.play('arcade','kill'),false,'not loaded, no delayed replay');
for(const cue of ['kill','death','victory'])audio.buffers.set(cosmeticSoundUrl('arcade',cue),{duration:20});
assert.equal(audio.play('arcade','kill'),true);assert.equal(starts,1);
audio.play('arcade','kill');assert.equal(starts,2);assert.equal(stops,1,'multi kill replaces old cue');
audio.play('arcade','victory');audio.play('arcade','kill');assert.equal(starts,3,'late final kill cannot replace victory');
audio.stop();assert.equal(audio.voices.size,0);ctx.state='suspended';assert.equal(audio.play('arcade','death'),false);ctx.state='running';
audio.storage=()=>({getItem:()=> '0'});assert.equal(audio.play('arcade','kill'),true);assert.equal(starts,3,'muted custom kill suppresses default fallback');
audio.storage=()=>({getItem:()=>null});audio.play('arcade','victory');
let deathCard;
const feedback=Object.assign(Object.create(CombatFeedback.prototype),{
 _disposed:false,_presentedDeaths:new WeakSet(),onLocalDeath(){},effects:{gore(){}},
 sfx:{deathSelf(){},stopCosmetics:cue=>audio.stop(cue),playCosmetic:(id,cue)=>audio.play(id,cue)},
 hud:{setPainImpulse(){},setDeathBrutality(){},setDead(...args){deathCard=args;}},
 getMyId:()=> 'self',getPlayersCache:()=>[],player:{},
});
const killerLoadout={signature:'sovereign',sound:'arcade'};
feedback.presentLocalDeath('departed-killer',{headshot:false},{cosmetics:killerLoadout});
assert.equal(deathCard[3],killerLoadout,'kill event retains the signature after the killer leaves');
assert.equal(audio.voices.has('victory'),true,'late final death preserves the victory cue');
feedback.presentLocalRespawn();
assert.equal(audio.voices.has('victory'),true,'respawn cleanup does not replace match music');
audio.clear();assert.equal(audio.buffers.size,0);
const history=new KillcamHistory();const cosmetics={weaponSkins:{rifle:'rifle-overdrive'},characterSkin:'salvager'};
history.record({serverNow:1,players:[{id:'p',x:0,y:0,z:0,yaw:0,pitch:0,cosmetics}]});
cosmetics.weaponSkins.rifle='standard';assert.equal(history.frames[0].players[0].cosmetics.weaponSkins.rifle,'rifle-overdrive','replay owns independent skin snapshot');
console.log('Cosmetics runtime: isolated materials, reversible layers, weapon anchors, bounded audio, mute/suspend behavior, and replay copies passed.');
