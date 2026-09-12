import * as THREE from '../vendor/three.module.js';
import { CAREER_CATALOG } from '../../../shared/career.js';
import { buildGun, disposeGunModels } from '../guns/assemble.js';
import { MaterialCache } from '../guns/kit.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { makeAvatar, disposeAvatar } from '../avatar/avatar.js';
import { applyGunCosmetics, applyAvatarCosmetics } from './skins.js';

const canvas = document.getElementById('preview');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1200, 800, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x111924);
scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x443022, 2.5));
for (const [color, intensity, position] of [[0xffdda9,5,[2,4,3]],[0x8ab9ff,4,[-3,2,-2]],[0xffffff,2,[-2,0,3]]]) {
  const light = new THREE.DirectionalLight(color,intensity); light.position.set(...position); scene.add(light);
}
const camera = new THREE.PerspectiveCamera(35, 1.5, 0.01, 30);
scene.add(camera);
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.55,0.08,48),new THREE.MeshStandardMaterial({color:0x293341,metalness:.65,roughness:.45}));
scene.add(pedestal);
let gun = null, cache = null, avatar = null, rig = null;
let standard = false, firstPerson = false;
const items = CAREER_CATALOG.filter(item => ['weaponSkin','characterSkin'].includes(item.kind));
const select = document.getElementById('asset');
for (const item of items) { const option = document.createElement('option');option.value=item.id;option.textContent=item.name;select.append(option); }
const params = new URLSearchParams(location.search);
select.value = items.some(item=>item.id===params.get('id')) ? params.get('id') : items[0].id;
standard = params.get('standard') === '1'; firstPerson = params.get('view') === 'firstperson';
function render() {
  if(gun) {disposeGunModels([gun],cache);gun=null;cache=null;}
  if(avatar) {disposeAvatar(avatar);avatar.group.removeFromParent();avatar=null;}
  if(rig) {rig.dispose();rig=null;}
  const item=items.find(entry=>entry.id===select.value);
  const loadout={weaponSkins:{},characterSkin:'standard',signature:'standard',sound:'standard'};
  if(!standard) {if(item.weapon)loadout.weaponSkins[item.weapon]=item.id;else loadout.characterSkin=item.id;}
  camera.position.set(0,0,0);camera.rotation.set(0,0,0);camera.fov=35;
  if(item.kind==='weaponSkin' && firstPerson) {
    pedestal.visible=false;camera.fov=70;rig=new ViewmodelRig(camera);rig.setCosmetics(loadout);rig.setWeapon(item.weapon);
    rig.update(0.016,{});
    for(let i=0;i<90;i++)rig.update(1/60,{});
    camera.position.set(0,0,0);
  } else if(item.kind==='weaponSkin') {
    cache=new MaterialCache();gun=buildGun(item.weapon,cache);applyGunCosmetics(gun,item.weapon,loadout);
    gun.root.traverse(object=>{if(object.name==='hand_r'||object.name==='hand_l')object.visible=false;});
    scene.add(gun.root);
    const bounds=new THREE.Box3().setFromObject(gun.root),center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
    gun.root.position.sub(center);
    const width=Math.max(size.z,size.x,size.y);
    camera.position.set(width*(item.weapon === 'rifle' ? -1.35 : 1.35),width*.48,width*.68);camera.lookAt(0,0,0);
    pedestal.visible=false;
  } else {
    avatar=makeAvatar('cosmetic-preview','OPERATOR',null);
    // A fixed neutral undersuit makes standard/skin comparisons independent of ID color.
    avatar.suitMaterial.color.setHex(0x465361);avatar.darkMaterial.color.setHex(0x222c37);
    applyAvatarCosmetics(avatar,loadout);avatar.tag.visible=avatar.hpSpr.visible=false;
    avatar.weaponModel.root.visible=false;
    if(firstPerson) {avatar.group.rotation.y=Math.PI;}
    scene.add(avatar.group);camera.position.set(2.5,1.8,-4);camera.lookAt(0,1.0,0);
    pedestal.visible=true;pedestal.position.set(0,-.04,0);pedestal.scale.set(1.3,1,1.3);
  }
  camera.updateProjectionMatrix();renderer.render(scene,camera);
  document.getElementById('name').textContent=standard ? `${item.name} / STANDARD` : item.name;
  document.getElementById('details').textContent=`${item.rarity.toUpperCase()} · LEVEL ${item.level} · ${item.detail}`;
  document.getElementById('standard').textContent=standard?'SHOW SKIN':'SHOW STANDARD';
  document.getElementById('view').textContent=firstPerson?'INSPECT VIEW':item.weapon?'FIRST PERSON':'BACK VIEW';
  document.getElementById('status').textContent='Rendered from the live game model. Cosmetic changes preserve weapon handling and hitboxes.';
  canvas.dataset.ready='true';canvas.dataset.skin=standard?'standard':item.id;
}
select.addEventListener('change',render);
document.getElementById('standard').addEventListener('click',()=>{standard=!standard;render();});
document.getElementById('view').addEventListener('click',()=>{firstPerson=!firstPerson;render();});
document.getElementById('export').addEventListener('click',()=>{const a=document.createElement('a');a.download=`${select.value}${standard?'-standard':''}.png`;a.href=canvas.toDataURL('image/png');a.click();});
render();
