import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { OPTICS, GRIPS, ATTACHMENT_SLOTS, normalizeWeaponLoadout, weaponWithAttachments } from '../shared/weapon-attachments.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { clampPitch } from '../public/js/util/math.js';
import { PlayerEntity } from '../server/sim/player.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { isScopeActive, nextScopeZoom } from '../public/js/guns/scope-state.js';
import { CareerService } from '../server/career.js';
import { startServer, stopServer } from './lib/server-process.mjs';

import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { applyAttachmentModel } from '../public/js/guns/attachment-model.js';

for(const id of WEAPON_IDS) {
  const cache = new MaterialCache(), model = buildGun(id,cache);
  const muzzle = model.muzzleMarker.position.clone();
  for(const optic of ATTACHMENT_SLOTS[id].optics) for(const grip of ATTACHMENT_SLOTS[id].grips) {
    applyAttachmentModel(model,id,{optic,grip});
    assert.deepEqual(model.muzzleMarker.position,muzzle,'Mounting accessories never moves the ballistic muzzle');
    model.body.traverse(o=>{if(o.name==='factory-optic')assert.equal(o.visible,optic==='standard');});
  }
  disposeGunModels([model],cache);
}

const base = JSON.stringify(WEAPONS), selection = {optic:'scope4',grip:'vertical',counter:'standard'};
for(const id of WEAPON_IDS) for(const optic of ATTACHMENT_SLOTS[id].optics) for(const grip of ATTACHMENT_SLOTS[id].grips) {
  const def = weaponWithAttachments(WEAPONS[id],{optic,grip});
  assert.ok(Number.isFinite(def.handling.ergonomics));
  assert.equal(def.damage,WEAPONS[id].damage);assert.equal(def.magSize,WEAPONS[id].magSize);
  if(def.mode!=='melee')assert.equal(def.recoil.pitch,def.handling.verticalRecoil);
}
assert.equal(JSON.stringify(WEAPONS),base,'Attachment combinations cannot mutate the roster');
assert.deepEqual(normalizeWeaponLoadout({knife:selection,rifle:{optic:'javascript:bad',grip:'wrong'}}),{});
const configured = weaponWithAttachments(WEAPONS.rifle,selection);
assert.equal(configured.handling.ergonomics,64);assert.equal(configured.recoil.pitch,0.51);
assert.equal(configured.zoom,4);assert.equal(isScopeActive({weapon:'rifle',scoped:configured.scoped,ads:1}),true);
assert.equal(nextScopeZoom(configured,4),2);assert.equal(nextScopeZoom(configured,2),4);
assert.equal(isScopeActive({weapon:'sniper',scoped:false,ads:1}),false);
const noop=()=>{};
const client=new WeaponState({rig:{setWeapon:noop,fire:noop,reload:noop,pumpAnim:noop,boltAnim:noop,ads:noop},audio:{draw:noop,reloadClick:noop,fire:noop},effects:{shoot:noop},network:{isCurrentGeneration:()=>true,isRunning:()=>true},feedback:{addExhaustion:noop,addRecoil:noop}});
client.setLoadout({rifle:selection});const entity=new PlayerEntity('test','test',{x:1,y:1,z:1},false);entity.weaponLoadout={rifle:selection};
assert.deepEqual(client.def,entity.def,'Client prediction and server combat use identical configuration');
client.reconcileServer({weapon:0,attachments:{optic:'standard',grip:'standard'}});assert.equal(client.def,WEAPONS.rifle);client.dispose();

const measurements=[];
// A real mouse delta must reach view and movement immediately, regardless of
// weapon ergonomics, ADS or render rate. Only the weapon takes time to catch up.
for (const id of WEAPON_IDS) for (const fps of [30, 60, 144]) for (const ads of [0, 1]) {
  let delta = { dx: 0, dy: 0 };
  const input = new Proxy({
    consumeDelta: () => { const value = delta; delta = { dx: 0, dy: 0 }; return value; },
    getKeys: () => ({ forward: true }), setGameplayEnabled: noop,
    wantAdsHeld: !!ads, wantFireHeld: false,
  }, { get: (o, k) => o[k] ?? (() => false) });
  const physics = { pos: { x: 1, y: 1, z: 1 }, vel: { x: 0, y: 0, z: 0 },
    grounded: true, _crouching: false, step: () => false, eyeY: () => 2.62, setMapMeta: noop };
  const player = new LocalPlayer({ input, physics }); player.setGameplayInputEnabled(true);
  const weapon = { def: WEAPONS[id], slot: WEAPON_IDS.indexOf(id), adsT: ads };
  player.update(0, 0, { weapon });
  const scale = ads ? 0.4 : 1;
  player._lookScale = scale;
  delta = { dx: -Math.PI / scale, dy: -0.5 / scale };
  player.update(1 / fps, 1000 / fps, { weapon });
  assert.equal(player.view.yaw, Math.PI, `${id}: entire 180-degree flick is accepted in one frame`);
  assert.equal(player.view.pitch, 0.5, `${id}: diagonal look is independent of weapon speed`);
  assert.ok(Math.abs(player.wishDir.x) < 1e-8 && player.wishDir.z > 0.999,
    `${id}: forward immediately follows the new view`);
  const initialLag = Math.abs(player.weaponAim.yaw);
  assert.ok(initialLag > 2.8, `${id}: the weapon remains behind after the flick`);
  let acquired = null;
  for (let i = 2; i <= fps * 8; i++) {
    player.update(1 / fps, i * 1000 / fps, { weapon });
    assert.equal(player.view.yaw, Math.PI, 'The weapon cannot rotate the player after mouse release');
    assert.equal(player.view.pitch, 0.5);
    if (Math.hypot(player.weaponAim.yaw, player.weaponAim.pitch) >= Math.PI / 180) acquired = null;
    else if (acquired === null) acquired = i / fps;
  }
  assert.ok(acquired, `${id}: weapon catches up to the freely chosen view`);
  measurements.push({ weapon: id, fps, ads, view180Frames: 1, weaponAcquireSeconds: acquired });
  // Pitch still stops at the anatomical limit; yaw is free even on a hitch or
  // a frame with no weapon simulation time.
  for (const dt of [0, 0.2]) for (const sign of [-1, 1]) {
    const before = player.view.yaw;
    delta = { dx: sign * 100 / scale, dy: sign * 100 / scale };
    player.update(dt, 9000, { weapon });
    assert.ok(Math.abs(player.view.yaw - (before - sign * 100)) < 1e-8);
    assert.equal(player.view.pitch, clampPitch(-sign * 100));
    assert.equal(Math.sign(player.view.pitch), -sign);
  }
  player.dispose();
}
for (const ads of [0, 1]) {
  const sample = (id, fps) => measurements.find(x => x.weapon === id && x.fps === fps && x.ads === ads);
  assert.ok(sample('minigun', 60).weaponAcquireSeconds > sample('smg', 60).weaponAcquireSeconds * 3);
  for (const id of WEAPON_IDS) {
    const times = [30, 60, 144].map(fps => sample(id, fps).weaponAcquireSeconds);
    assert.ok(Math.max(...times) - Math.min(...times) < 0.1, `${id}, ADS ${ads}: settling differs across frame rates: ${times}`);
  }
}

const directory=await mkdtemp(path.join(tmpdir(),'vb-customization-'));let server;const sockets=[];
try {
  server=startServer({cwd:process.cwd(),env:{VB_PERSISTENCE:'file',VB_DATA_DIR:directory}});let url=`http://127.0.0.1:${await server.port}`;
  const get=await fetch(url+'/api/career');const cookie=get.headers.get('set-cookie').split(';')[0];await get.json();
  const post=(weapon,attachments,extra={})=>fetch(url+'/api/career/attachments',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-VB-Career':'1',...extra},body:JSON.stringify({weapon,attachments})});
  assert.equal((await post('rifle',selection,{'X-VB-Career':'0'})).status,403);
  assert.equal((await post('knife',selection)).status,400);
  assert.equal((await post('rifle',{...selection,damage:999})).status,400);
  let response=await post('rifle',selection);assert.equal(response.status,200);assert.deepEqual((await response.json()).equipped.weaponAttachments.rifle,selection);
  response=await post('sniper',{optic:'scope10',grip:'precision'});assert.equal(response.status,200);
  assert.deepEqual((await response.json()).equipped.weaponAttachments.rifle,selection,'Saving another weapon preserves the first');
  const connect=async(cookies,forged=false)=>{
    const ws=new WebSocket(url.replace('http:','ws:'),{headers:cookie?{cookie:cookies}:{}});sockets.push(ws);
    return await new Promise((resolve,reject)=>{
      let welcome;
      const timeout=setTimeout(()=>reject(new Error('Admission timed out')),10000);
      ws.on('error',reject);ws.on('open',()=>ws.send(JSON.stringify({t:'join',name:'AttachmentTest',bots:0,...(forged?{weaponLoadout:{rifle:{optic:'reflex',grip:'angled'}}}:{})})));
      ws.on('message',(bytes,binary)=>{if(binary)return;const msg=JSON.parse(bytes);if(msg.t==='error'){clearTimeout(timeout);reject(new Error(msg.msg));}if(msg.t==='welcome')welcome=msg;if(msg.t==='tick'&&welcome){clearTimeout(timeout);resolve({...welcome,firstAttachments:msg.players.find(p=>p.id===welcome.id)?.attachments});}});
    });
  };
  await assert.rejects(connect(cookie,true),/Malformed quick-play/);
  const joined=await connect(cookie);assert.deepEqual(joined.weaponLoadout.rifle,selection,'Admission uses the saved profile');
  assert.deepEqual(joined.firstAttachments,selection,'Actual server snapshots carry the admitted setup');
  const other=await connect('');assert.deepEqual(other.weaponLoadout,{},'Another player keeps the default loadout');
  for(const ws of sockets)ws.close();
  await stopServer(server);server=null;
  const persisted=new CareerService({directory});
  assert.deepEqual(persisted.profile(cookie.split('=')[1]).equipped.weaponAttachments.rifle,selection);
  const previous=JSON.stringify(persisted.profile(cookie.split('=')[1]));const flush=persisted.flush;persisted.flush=()=>{throw new Error('disk unavailable');};
  await assert.rejects(persisted.saveAttachments(cookie.split('=')[1],'rifle',{optic:'standard',grip:'standard'}),/disk unavailable/);
  assert.equal(JSON.stringify(persisted.profile(cookie.split('=')[1])),previous,'Failed persistence rolls back the attempted setup');
  persisted.flush=flush;persisted.dispose();
} finally {for(const ws of sockets)ws.terminate();if(server)await stopServer(server);await rm(directory,{recursive:true,force:true});}
await mkdir('.artifacts/weapon-customization',{recursive:true});await writeFile('.artifacts/weapon-customization/measurements.json',JSON.stringify(measurements,null,2));
console.log('Weapon customization: compatible combinations, scope switching, client/server parity, free look and weapon lag at 30/60/144 Hz, no delayed player rotation, HTTP validation, profile isolation, join authority and persistence rollback passed.');
console.table(measurements.filter(row => row.fps === 60));
