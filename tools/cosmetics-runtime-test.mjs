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
