import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-blender-'));
const out = path.resolve('.artifacts/blender-integration');
await mkdir(out, { recursive: true });
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory, VB_PERSISTENCE: 'file' } });
let browser;
try {
  const base = `http://127.0.0.1:${await server.port}`;
  browser = await launchCdpSession(`${base}/avatar-capture.html?weapon=rifle&view=front`, { width: 1200, height: 1000 });
  const page = browser.page;
  const capture = async (route, name) => {
    await page.send('Page.navigate', { url: base + route });
    await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 20000, label: name });
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  for (const view of ['front', 'profile', 'ads-profile', 'crouched-profile', 'prone-profile']) {
    await capture(`/avatar-capture.html?weapon=rifle&view=${view}`, `rivet-${view}`);
    const metrics = await page.evaluate('window.__vbAvatarCapture');
    assert.ok(metrics.gripError < 1e-6, `${view}: palm on grip`);
    assert.ok(metrics.weaponInFrame, `${view}: weapon in frame`);
  }
  for (const team of ['alpha', 'bravo']) await capture(`/avatar-capture.html?weapon=rifle&view=front&team=${team}`, `rivet-${team}`);
  for (const state of ['held', 'scoped', 'firing']) await capture(`/weapon-capture.html?weapon=rifle&state=${state}`, `kestrel-${state}`);
  await capture('/avatar-capture.html?weapon=sniper&view=front', 'rivet-sniper-front');
  const sniperMetrics = await page.evaluate('window.__vbAvatarCapture');
  assert.ok(sniperMetrics.gripError < 1e-6, 'sniper front: palm on grip');
  assert.ok(sniperMetrics.weaponInFrame, 'sniper front: weapon in frame');
  for (const state of ['held', 'scoped', 'firing']) await capture(`/weapon-capture.html?weapon=sniper&state=${state}`, `peregrine-${state}`);
  await capture('/avatar-capture.html?weapon=lmg&view=profile', 'rivet-lmg-profile');
  const lmgMetrics = await page.evaluate('window.__vbAvatarCapture');
  assert.ok(lmgMetrics.gripError < 1e-6, 'lmg profile: palm on grip');
  assert.ok(lmgMetrics.weaponInFrame, 'lmg profile: weapon in frame');
  for (const weapon of ['rifle', 'revolver', 'knife']) await capture(`/weapon-capture.html?weapon=${weapon}&state=held`, `hands-${weapon}-held`);
  await capture('/weapon-capture.html?weapon=revolver&state=reload-open', 'hands-revolver-reload-open');
  for (const state of ['held', 'scoped', 'firing', 'reload-open', 'reload-eject', 'reload-load', 'reload-charge']) {
    await capture(`/weapon-capture.html?weapon=lmg&state=${state}`, `bison-${state}`);
  }
  const checks = await page.evaluate(`(async () => {
    const T = await import('/js/vendor/three.module.js');
    const { makeAvatar, disposeAvatar, updateAvatarWeaponPose, updateAvatarStancePose,
      setAvatarTeam, setAvatarOpacity, setAvatarFlash } = await import('/js/avatar/avatar.js');
    const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
    const { MaterialCache } = await import('/js/guns/kit.js');
    const { applyAvatarCosmetics, applyGunCosmetics } = await import('/js/cosmetics/skins.js');
    const { makeFirstPersonBody, disposeFirstPersonBody } = await import('/js/player/first-person-body.js');
    const { applyAttachmentModel } = await import('/js/guns/attachment-model.js');
    const { WEAPON_IDS } = await import('/shared/combatmath.js');
    const { createBlenderParts } = await import('/js/engine/blender-assets.js');
    const { ARM, ViewmodelArms } = await import('/js/guns/viewmodel-arms.js');
    const { disposeObjectTrees } = await import('/js/engine/dispose.js');
    const must = (value, message) => { if (!value) throw new Error(message); };
    const restParts=createBlenderParts('rivet');
    must(restParts,'runtime character available');
    for(const [name,part] of Object.entries(restParts)) {
      const bounds=new T.Box3().setFromObject(part);
      must([...bounds.min.toArray(),...bounds.max.toArray()].every(v=>Number.isFinite(v)&&Math.abs(v)<.65), 'local joint bounds '+name);
    }
    disposeObjectTrees(Object.values(restParts));
    const a = makeAvatar('blender-a','A'), b = makeAvatar('blender-b','B');
    must(a.torso.userData.blenderAsset === 'rivet', 'RIVET loaded, no fallback');
    must(a.weaponModel._model.body.userData.blenderAsset === 'kestrel', 'KESTREL loaded, no fallback');
    updateAvatarWeaponPose(a,{weapon:'sniper',blend:1});
    must(a.weaponModel._model.body.userData.blenderAsset === 'peregrine', 'PEREGRINE loaded, no fallback');
    must(a.weaponModel._model.body.userData.sightHeight === 0.205, 'PEREGRINE keeps the 0.205 sight line');
    updateAvatarWeaponPose(a,{weapon:'lmg',blend:1});
    must(a.weaponModel._model.body.userData.blenderAsset === 'bison', 'BISON loaded, no fallback');
    updateAvatarWeaponPose(a,{weapon:'lmg',reloading:true,dt:1,blend:1});
    must(a.weaponModel._model.extra.userData.reloadPart.rotation.x < -0.5, 'third-person belt reload opens the feed cover');
    updateAvatarWeaponPose(a,{weapon:'rifle',blend:1});
    must(a.weaponModel._model.body.userData.blenderAsset === 'kestrel', 'rifle slot restored');
    let poses = 0;
    for (const weapon of WEAPON_IDS) for (const pitch of [-1.3,0,1.3])
      for (const ads of [false,true]) for (const proneT of [0,.5,1]) for (const crouching of [false,true]) {
        updateAvatarWeaponPose(a,{weapon,pitch,ads,proneT,crouching,dt:1/60,blend:1});
        updateAvatarStancePose(a,{blend:1}); a.group.updateMatrixWorld(true);
        const anchor = a.weaponModel.handPose.grip;
        const target = a.weaponModel.modelRoot.localToWorld(new T.Vector3(anchor.x,anchor.y,anchor.z));
        must(a.rHand.getWorldPosition(new T.Vector3()).distanceTo(target)<1e-6, 'runtime grip '+weapon);
        must(a.group.matrixWorld.elements.every(Number.isFinite), 'finite pose');
        poses++;
      }
    setAvatarTeam(a,'alpha'); setAvatarTeam(b,'bravo');
    must(a.suitMaterial.color.getHex()===0x38bdf8 && b.suitMaterial.color.getHex()===0xfb923c,'independent team colors');
    setAvatarOpacity(a,.2); setAvatarFlash(a,.4);
    a.torso.traverse(o => { if(o.isMesh) must(o.material.opacity===.2,'all imported material fades'); });
    b.torso.traverse(o => { if(o.isMesh) must(o.material.opacity===1,'other player opacity intact'); });
    const geometries = new Set(), maps = new Set();
    b.group.traverse(o => { if(o.geometry?.userData.pageOwned) geometries.add(o.geometry);
      for(const m of [].concat(o.material||[])) if(m.map?.userData.pageOwned) maps.add(m.map); });
    let geometryDisposed=0, textureDisposed=0;
    for(const g of geometries) g.addEventListener('dispose',()=>geometryDisposed++);
    for(const t of maps) t.addEventListener('dispose',()=>textureDisposed++);
    for(let i=0;i<4;i++) { applyAvatarCosmetics(a,{characterSkin:i%2?'standard':'salvager'}); }
    disposeAvatar(a);
    must(geometryDisposed===0 && textureDisposed===0,'disposing one avatar preserves shared geometry and maps');
    const cache = new MaterialCache(), gun = buildGun('rifle',cache);
    must(gun.body.userData.blenderAsset==='kestrel','first person KESTREL');
    const handR = gun.root.getObjectByName('hand_r'), handL = gun.root.getObjectByName('hand_l');
    must(handR?.userData.blenderAsset==='hands' && handL?.userData.blenderAsset==='hands','first person HANDS gloves');
    must(handR.children.length===6 && handL.children.length===6,'six material primitives per glove');
    must(handR.scale.x===1 && handL.scale.x===-1,'support glove is the mirrored right hand');
    const gloveMaterials = handR.children.map(m=>m.material);
    const leather = gloveMaterials.find(m=>m.userData.partMaterial==='glove leather');
    must(leather?.map?.name==='textures/worn-rubber.jpg' && leather.userData.paletteColor===0x22252a,'glove leather keeps its delivered map and skin-palette key');
    must(gloveMaterials.find(m=>m.userData.partMaterial==='webbing')?.userData.paletteColor===0xb09a72,'wrist strap keyed to the cuff palette');
    const bare = gloveMaterials.find(m=>m.userData.partMaterial==='skin');
    must(bare && bare.color.getHex()!==0xffffff && bare.map,'bare fingertips keep their tint and map');
    gun.root.updateMatrixWorld(true);
    const palm = handR.getWorldPosition(new T.Vector3());
    must(palm.y<-0.05 && palm.y>-0.12 && Math.abs(palm.x)<0.03 && palm.z<-0.05 && palm.z>-0.15,'fist wraps the pistol grip');
    const cuff = new T.Box3().setFromObject(handL);
    must(cuff.max.z>-0.34,'the support glove ends at its cuff, where the arm takes over');
    const fistBox = new T.Box3().setFromObject(handR);
    must(fistBox.max.y<0.05,'fist stays under the receiver, clear of the sight line');
    // The arms are delivered geometry too: each segment must arrive in its own
    // joint frame, or the runtime chain would hang them off the wrong end.
    const armParts = createBlenderParts('hands',{names:['forearm','upperarm','shoulder']});
    must(armParts?.forearm && armParts.upperarm && armParts.shoulder,'HANDS delivers the arm segments');
    const armBox = name => new T.Box3().setFromObject(armParts[name]);
    const fore = armBox('forearm'), upper = armBox('upperarm'), shoulderPart = armBox('shoulder');
    must(fore.min.z<0 && fore.max.z>ARM.forearm,'the forearm spans wrist to elbow');
    must(upper.min.z<0 && upper.max.z>ARM.upperArm,'the upper arm spans elbow to shoulder');
    must(shoulderPart.min.z<0 && shoulderPart.max.z>0,'the shoulder cap covers its joint');
    must(Math.max(Math.hypot(fore.min.x,fore.min.y),Math.hypot(fore.max.x,fore.max.y))<0.09,
      'the forearm stays slim enough to never sweep across the screen');
    disposeObjectTrees(Object.values(armParts));
    const armRig = new T.Group(), arms = new ViewmodelArms(armRig);
    armRig.add(gun.root);
    arms.update(gun,0,true);
    must(arms._blenderReady,'the runtime mounts the delivered arm segments, not the offline boxes');
    for(const side of ['l','r']) for(const part of ['forearm','upperarm','shoulder']) {
      const node = arms.root.getObjectByName('arm_'+part+'_'+side);
      must(node?.children[0]?.userData.blenderAsset==='hands','arm_'+part+'_'+side+' is HANDS geometry');
      must(node.children[0].scale.x===(side==='l'?-1:1),'arm_'+part+'_'+side+' mirrors onto its own side');
    }
    const wristGap = arms.root.getObjectByName('arm_forearm_r').getWorldPosition(new T.Vector3())
      .distanceTo(handR.getWorldPosition(new T.Vector3()));
    must(wristGap<0.12,'the forearm starts inside the glove cuff, leaving no gap at the wrist');
    armRig.remove(gun.root);
    arms.dispose();
    applyAttachmentModel(gun,'rifle',{optic:'reflex',grip:'vertical'});
    must(!gun.body.getObjectByName('factory-optic').visible,'replacement optic hides authored sight');
    applyAttachmentModel(gun,'rifle',{optic:'standard',grip:'standard'});
    must(gun.body.getObjectByName('factory-optic').visible,'standard optic restored');
    const mag = new T.Box3().setFromObject(gun.mag).getCenter(new T.Vector3());
    gun.mag.position.y=-.5; gun.root.updateMatrixWorld(true);
    must(Math.abs(new T.Box3().setFromObject(gun.mag).getCenter(new T.Vector3()).y-mag.y+.5)<1e-6,'authored magazine moves with reload group');
    applyGunCosmetics(gun,'rifle',{weaponSkins:{rifle:'rifle-overdrive'}});
    must(gun.root.userData.skin==='rifle-overdrive','weapon cosmetic attached');
    const sniper = buildGun('sniper', cache);
    must(sniper.body.userData.blenderAsset === 'peregrine', 'first person PEREGRINE');
    must(sniper.body.userData.sightHeight === 0.205, 'sniper sight line at 0.205');
    const rounds = sniper.extra.userData.cartridges;
    must(rounds.length === 3, 'three stripper rounds');
    must(rounds.every(r => r.parent === sniper.extra && r.visible === false), 'stripper rounds hidden under extra');
    applyAttachmentModel(sniper,'sniper',{optic:'reflex',grip:'vertical'});
    must(!sniper.body.getObjectByName('factory-optic').visible, 'replacement optic hides authored sight');
    applyAttachmentModel(sniper,'sniper',{optic:'standard',grip:'standard'});
    must(sniper.body.getObjectByName('factory-optic').visible,'standard sniper optic restored');
    const lmg = buildGun('lmg', cache);
    must(lmg.body.userData.blenderAsset === 'bison', 'first person BISON');
    must(lmg.body.userData.sightHeight === 0.155, 'lmg sight line at 0.155');
    const cover = lmg.extra.userData.reloadPart, lead = lmg.extra.userData.beltLead;
    must(cover && cover.parent === lmg.extra && cover.children.length >= 8, 'feed cover leaves re-hung under extra');
    must(Math.abs(cover.position.y - 0.145) < 1e-6 && Math.abs(cover.position.z + 0.206) < 1e-6, 'feed cover pivots on the authored hinge pin');
    const coverTop = new T.Box3().setFromObject(cover).max.y;
    must(coverTop <= 0.152 + 1e-4, 'closed feed cover stays under the 0.155 sight line');
    must(lead && lead.parent === lmg.extra && lead.children.length === 2, 'belt lead (cases and links) under extra');
    must(lead.visible && lead.position.equals(lead.userData.homePosition), 'belt lead rests at its tray home');
    const leadBounds = new T.Box3().setFromObject(lead);
    must(leadBounds.max.y <= coverTop && leadBounds.min.y >= 0.12, 'belt lead lies inside the feed tray');
    const { WeaponActions } = await import('/js/guns/actions.js');
    const belt = new WeaponActions();
    belt.startReload(0, 4.2, 'magswap', lmg.T);
    belt.update(0.45 * 4.2, 0, lmg, lmg.T);
    must(cover.rotation.x < -1.1 && !lmg.mag.visible && !lead.visible, 'mid reload: cover open, box and spent lead gone');
    belt.update(0.90 * 4.2, 0, lmg, lmg.T);
    must(cover.rotation.x < -0.2 && lmg.mag.visible && lead.visible && lead.position.distanceTo(lead.userData.homePosition) < 1e-3, 'fresh lead laid before the cover slams');
    belt.update(0.955 * 4.2, 0, lmg, lmg.T);
    must(Math.abs(cover.rotation.x) < 0.07 && lmg.bolt.position.z > 0.05, 'cover shut, charging handle pulled');
    belt.update(4.2, 0, lmg, lmg.T);
    must(cover.rotation.x === 0 && lmg.bolt.position.z === 0 && lead.visible && lead.position.equals(lead.userData.homePosition), 'belt reload resets every part');
    belt.dispose(lmg);
    // TORCH (RX-8 HAVOC) rear load: the exported template must hang its breech
    // gate on the authored hinge inside the scene graph — an orphaned gate group
    // or a hinge-misplaced leaf is exactly the redo regression this block pins.
    const rocket = buildGun('rocket', cache);
    must(rocket.body.userData.blenderAsset === 'torch', 'first person TORCH');
    must(rocket.body.userData.sightHeight === 0.175, 'rocket sight line at 0.175');
    const rocketReload = rocket.extra.userData.rocketReload, gate = rocketReload?.gate;
    must(gate, 'TORCH exposes its rocketReload gate under extra');
    must(gate.name === 'rocket_rear_breech', 'TORCH gate is named rocket_rear_breech');
    must(gate.parent === rocket.extra && rocket.root.getObjectByName('rocket_rear_breech') === gate,
      'TORCH gate group hangs inside the rocket scene graph');
    must(Math.abs(gate.position.x + 0.104) < 1e-6 && Math.abs(gate.position.y - 0.075) < 1e-6 && Math.abs(gate.position.z + 0.135) < 1e-6,
      'TORCH gate hinge pins at (-0.104, 0.075, -0.135), the vertical side pin the template exported');
    must(rocketReload.hinge.equals(gate.position) && rocketReload.swing === 1.75 && Math.abs(rocketReload.rearZ + 0.06) < 1e-9,
      'TORCH rocketReload exposes the hinge, the 1.75 rad swing and the -0.06 round-path reference');
    must(gate.children.length === 3 && gate.children.every((leaf) => leaf.position.lengthSq() < 1e-12),
      'TORCH gate leaves are hinge-local under the swing group');
    const round = rocket.extra.userData.reloadRounds, rearZ = rocketReload.rearZ;
    const actions = new WeaponActions();
    actions.startReload(0, 1, 'magswap', rocket.T);
    const rocketHandL = rocket.root.getObjectByName('hand_l');
    const rocketGrab = () => gate.localToWorld(new T.Vector3(0.1044, 0.05, 0.1783));
    const rocketHand = () => rocketHandL.getWorldPosition(new T.Vector3());
    actions.update(0.30, 0, rocket, rocket.T);
    rocket.root.updateMatrixWorld(true);
    must(rocketHandL.visible === true && rocketHand().distanceTo(rocketGrab()) < 0.05,
      'the support hand pulls the venturi clamp open');
    actions.update(0.35, 0, rocket, rocket.T);
    must(gate.position.equals(rocketReload.hinge) && gate.rotation.y < -1.7 && gate.rotation.x === 0,
      'rocket breech swings open sideways on its side pin (no slide, tail out to -x)');
    actions.update(0.42, 0, rocket, rocket.T);
    must(round.visible === true && round.position.y > rocket.T.muzzle[1] - 0.5
      && round.position.z > rearZ + 0.3,
      'new rocket is staged up at the tube mouth rather than rising from below the frame');
    actions.update(0.50, 0, rocket, rocket.T);
    must(round.visible === true, 'a complete new rocket is drawn');
    must(round.position.x > 0.25,
      'new rocket loads on the gate-free (+x) flank, clear of the swung back clamp');
    actions.update(0.55, 0, rocket, rocket.T);
    rocket.root.updateMatrixWorld(true);
    must(rocketHand().distanceTo(round.getWorldPosition(new T.Vector3()).add(new T.Vector3(-0.04, -0.04, 0.075))) < 0.05,
      'the support hand carries the rocket toward the tube mouth');
    actions.update(0.68, 0, rocket, rocket.T);
    must(Math.abs(round.position.x) < 1e-9, 'new rocket aligns with the tube');
    must(round.position.y === rocket.T.muzzle[1], 'rocket round rides the bore axis height');
    must(round.position.z - 0.245 > rearZ + 0.12,
      'the aligned nose parks ahead of the swung back-clamp ring zone, never inside its collar');
    const alignedZ = round.position.z;
    actions.update(0.81, 0, rocket, rocket.T);
    must(round.position.z < alignedZ - 0.4, 'rocket is inserted forward along the bore axis');
    actions.update(0.88, 0, rocket, rocket.T);
    must(gate.rotation.y < -1.5, 'the hand swings the rear breech shut after seating the rocket');
    actions.update(0.90, 0, rocket, rocket.T);
    rocket.root.updateMatrixWorld(true);
    must(rocketHand().distanceTo(rocketGrab()) < 0.05,
      'the support hand returns to close and latch the venturi clamp');
    actions.update(0.91, 0, rocket, rocket.T);
    must(gate.rotation.y > -0.5 && gate.rotation.y < 0, 'rocket rear breech slams shut over the seated round');
    actions.update(0.93, 0, rocket, rocket.T);
    must(Math.abs(rocket.bolt.rotation.x) < 1e-9, 'rocket arming lever cocks home on the closing cue');
    actions.update(0.94, 0, rocket, rocket.T);
    must(round.visible === false, 'seated rocket is inside the tube');
    must(gate.rotation.y === 0 && gate.position.equals(rocketReload.hinge), 'rocket rear breech latches closed on its pin');
    // Cancelling mid-reload, while the round is staged and the breech stands open,
    // restores the complete rest pose.
    actions.cancelReload(rocket);
    actions.startReload(0, 1, 'magswap', rocket.T);
    actions.update(0.50, 0, rocket, rocket.T);
    must(round.visible === true, 'a complete new rocket is drawn');
    actions.cancelReload(rocket);
    must(round.visible === false && gate.rotation.y === 0 && gate.position.equals(rocketReload.hinge)
      && rocket.bolt.rotation.x === 0
      && round.children.every((child) => child.visible)
      && round.position.equals(round.userData.homePosition),
      'cancelled rocket reload restores the TORCH rest pose');
    actions.dispose();
    const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
    const skipjackRig = new ViewmodelRig(new T.PerspectiveCamera());
    skipjackRig.setWeapon('mgl');
    const skipjack = skipjackRig._models.mgl.extra.userData.skipjack;
    must(skipjack?.rounds.length === 3, 'SKIPJACK provides three reserve slots for the ammo upgrade');
    const { TIMERS, HANDS } = await import('/js/guns/defs.js');
    const skipjackDoc = await (await fetch('/assets/blender/skipjack.gltf')).json();
    for (const key of ['grip', 'support']) {
      const mount = skipjackDoc.nodes.find(n => n.name === key).translation;
      const hand = HANDS.mgl[key];
      must(new T.Vector3(...mount).distanceTo(new T.Vector3(hand.x, hand.y, hand.z)) < 1e-6,
        'SKIPJACK '+key+' hand follows the reference model anchor');
    }
    const sight = skipjackDoc.nodes.find(n => n.name === 'sight').translation;
    must(Math.abs(sight[1] + TIMERS.mgl.adsOffset.y) < 1e-6 &&
      Math.abs(sight[1] - skipjackRig._models.mgl.body.userData.sightHeight) < 1e-6,
      'SKIPJACK compact optic and ADS use the same height');
    const skipjackSource = createBlenderParts('skipjack');
    skipjackSource.body.updateMatrixWorld(true);
    const sightRay = new T.Raycaster(new T.Vector3(0, sight[1], .4), new T.Vector3(0, 0, -1), 0, 2);
    const sightBlockers = sightRay.intersectObject(skipjackSource.body, true)
      .filter(hit => !hit.object.material?.name?.includes('optic glass'));
    must(sightBlockers.length === 0, 'SKIPJACK sight ray clears the actual exported housing');
    disposeObjectTrees(Object.values(skipjackSource));
    const skipjackMaps = new Set();
    skipjackRig._models.mgl.body.traverse(o => {
      for (const material of [].concat(o.material || [])) if (material.map) skipjackMaps.add(material.map.name);
    });
    must(skipjackMaps.has('textures/palette/skipjack-olive-armor.jpg') &&
      skipjackMaps.has('textures/palette/skipjack-dark-steel.jpg'),
      'SKIPJACK receiver delivers its two dedicated surface textures');
    must(skipjack.rounds.every(r => r.children.some(mesh => mesh.material?.map?.name ===
      'textures/palette/skipjack-shell.jpg')), 'all SKIPJACK rounds use the shell surface texture');
    for (const [ammo, expected] of [[4,'111'],[3,'011'],[2,'001'],[1,'000'],[0,'000']]) {
      skipjackRig.setSkipjack({mag:ammo,magSize:Math.max(3,ammo)});
      must(skipjack.rounds.map(r=>Number(r.visible)).join('') === expected,
        'SKIPJACK chambered round leaves only external reserve '+ammo);
    }
    skipjackRig.setSkipjack({mag:3,magSize:3});
    const beforeShot=skipjack.rounds.map(r=>r.position.clone());
    must(skipjackRig.fire(), 'SKIPJACK fires its chambered round');
    must(skipjack.rounds.every((r,i)=>r.position.equals(beforeShot[i])),
      'firing does not pull an external round toward the barrel');
    // Real runtime swaps: sample the running cassette animation, not a static pose.
    const pose = { speed: 0, vaulting: false, grounded: true, aimSwayScale: 0 };
    const slots = () => skipjack.rounds.map(r=>Number(r.visible)).join('');
    const run = (seconds) => { for (let t = 0; t < seconds - 1e-9; t += 0.01) skipjackRig.update(0.01, pose); };
    const cassette = skipjack.cassette, home = cassette.userData.homePosition;
    const swapCheck = (mag, magSize, expected) => {
      for (let i = 0; i < 40; i++) skipjackRig.update(0.05, pose);
      skipjackRig.setSkipjack({mag, magSize});
      skipjackRig.reload(1, 'magswap');
      const seen = [];
      let swung = 0;
      for (const until of [0.30, 0.50, 0.62, 0.86, 0.97]) {
        run(until - (seen.length ? [0.30, 0.50, 0.62, 0.86, 0.97][seen.length - 1] : 0));
        skipjackRig.setSkipjack({mag: Math.min(mag, 1), magSize}); // authority mid-swap
        seen.push(cassette.visible ? slots() : 'away');
        swung = Math.max(swung, Math.abs(cassette.rotation.y));
      }
      must(seen.join(',') === expected, 'SKIPJACK swap ' + mag + '/' + magSize + ' slots ' + seen.join(',') + ' (want ' + expected + ')');
      must(swung > 0.6, 'the cassette swings open on its front hinge');
      run(0.1);
      must(cassette.position.equals(home) && cassette.rotation.y === 0 && skipjack.reload === null,
        'a finished swap leaves the cassette seated');
    };
    swapCheck(2, 3, '001,away,011,011,011');  // tactical: chamber kept, 2 fresh
    swapCheck(0, 3, '000,away,011,011,001');  // empty: the rack strips one fresh round
    swapCheck(1, 4, '000,away,111,111,111');  // upgraded tactical swap
    skipjackRig.setSkipjack({mag:3,magSize:3});
    skipjackRig.reload(1, 'magswap');
    run(0.40);
    skipjackRig.setSkipjack({mag:1,magSize:3});
    skipjackRig.cancelReload();
    must(cassette.visible && cassette.position.equals(home) && cassette.rotation.y === 0 &&
      slots() === '000',
      'a cancelled swap seats the cassette and shows the authoritative reserve');
    skipjackRig.setSkipjack({mag:3,magSize:3});
    skipjackRig.reload(1, 'magswap');
    run(0.40);
    skipjackRig.setWeapon('rifle');
    skipjackRig.setSkipjack({mag:1,magSize:3});
    skipjackRig.setWeapon('mgl');
    must(cassette.position.equals(home) && cassette.rotation.y === 0 && cassette.visible &&
      slots() === '000' && skipjackRig._models.mgl.bolt.position.z === 0,
      'a weapon swap mid-reload leaves no open cassette, rack or stale reserve');
    skipjackRig.dispose();
    // SKUA (GV-4 RIPTIDE): the wrapper must re-hang the cassette's spare disc as the
    // reload round and the catch horns on their authored hinges.
    const glaive = buildGun('glaive', cache);
    must(glaive.body.userData.blenderAsset === 'skua', 'first person SKUA');
    must(glaive.body.userData.sightHeight === 0.150, 'glaive sight line at 0.150');
    const spare = glaive.extra.userData.reloadRounds, glaiveParts = glaive.extra.userData.glaive;
    must(spare && spare.name === 'glaive_spare_disc' && glaiveParts?.spare === spare,
      'SKUA reloadRounds holds the cassette spare disc');
    must(spare.parent === glaive.extra && spare.children.length > 0
      && spare.position.distanceTo(new T.Vector3(0, -0.072, -0.165)) < 1e-3
      && spare.position.equals(spare.userData.homePosition),
      'SKUA spare disc sits on its authored cassette pivot');
    must(glaiveParts.horns.length === 2 && glaiveParts.horns.every(({ pivot, side }) =>
      Math.abs(pivot.position.x - 0.05 * side) < 1e-3 && Math.abs(pivot.position.z + 0.335) < 1e-3),
      'SKUA catch horns hang on their (+-0.05, 0, -0.335) hinges');
    must(glaiveParts.disc && glaiveParts.flywheel, 'SKUA exposes the seated disc and flywheel pivots');
    disposeGunModels([gun,sniper,lmg,rocket,glaive],cache);
    const grenadeParts = createBlenderParts('grenades');
    must(Object.keys(grenadeParts).join() === 'frag,limpet,pulse,molotov,smoke', 'five authored throwables');
    for (const [id, part] of Object.entries(grenadeParts)) {
      must(part.userData.blenderAsset === 'grenades', 'GRENADES tag on '+id);
      const bounds = new T.Box3().setFromObject(part);
      must(bounds.min.y > -0.1 && bounds.max.y < 0.32, 'held-frame height '+id);
      must(Math.abs(bounds.min.x) < 0.11 && bounds.max.x < 0.11, 'held-frame width '+id);
      must(bounds.min.x < 0 && bounds.max.x > 0 && bounds.min.z < 0 && bounds.max.z > 0, 'held frame spans the origin '+id);
    }
    disposeObjectTrees(Object.values(grenadeParts));
    const { ProjectileFX } = await import('/js/weapons/projectiles.js');
    const fx = new ProjectileFX(new T.Scene(), () => 0, { camera: new T.PerspectiveCamera() });
    for (const type of ['frag','limpet','pulse','molotov','smoke']) {
      const { group, capMaterial } = fx._buildVisual(type);
      let authored = null;
      group.traverse(o => { if (o.userData.blenderAsset === 'grenades' && !authored) authored = o; });
      must(authored, 'thrown '+type+' uses the authored body');
      must(capMaterial, 'thrown '+type+' keeps its fuse indicator');
      const size = new T.Box3().setFromObject(authored).getSize(new T.Vector3());
      must(size.x > 0.14 && size.x < 0.45 && size.y < 0.62, 'thrown '+type+' world scale '+size.toArray());
      disposeObjectTrees([group]);
    }
    fx.dispose();
    const body=makeFirstPersonBody();
    must(body.group.userData.blenderAsset==='rivet','matching local body'); disposeFirstPersonBody(body);
    disposeAvatar(b);
    return {poses, sharedGeometries:geometries.size, sharedTextures:maps.size};
  })()`);
  await page.send('Page.navigate', { url: `${base}/?debug=1&headless=1&weapon=rifle` });
  await page.waitFor(`window.__vb && document.getElementById('create-lobby-btn')`, { timeoutMs: 20000 });
  await page.evaluate(`(async () => {
    const { AvatarRoster } = await import('/js/avatar/avatar-roster.js');
    const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
    const sync=AvatarRoster.prototype.sync, setWeapon=ViewmodelRig.prototype.setWeapon;
    AvatarRoster.prototype.sync=function(...args){window.__assetRoster=this;return sync.apply(this,args);};
    ViewmodelRig.prototype.setWeapon=function(...args){window.__assetRig=this;return setWeapon.apply(this,args);};
  })()`);
  // triggerCreate returns early while the menu gates play on the match asset
  // set (15 GLTF templates + shared textures decode on a cold cache): the click
  // may only land once the gate lifts.
  await page.waitFor(`document.getElementById('create-lobby-btn').disabled === false`,
    { timeoutMs: 120000, label: 'match asset set' });
  await page.evaluate(`document.getElementById('create-lobby-btn').click()`);
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await page.evaluate(`(() => { const select=document.getElementById('game-mode-select');
    select.value='training';select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await page.waitFor(`document.getElementById('map-select').value === 'killhouse'`);
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`document.getElementById('lobby-start-btn').disabled === false`);
  await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
  await page.waitFor(`!!(__vb.stats.running && __vb.stats.avatars === 17 && window.__assetRig && window.__assetRoster)`,
    { timeoutMs: 30000, label: 'training with imported models' });
  checks.training = await page.evaluate(`({ targets:__assetRoster.size,
    allRivet:[...__assetRoster._avatars.values()].every(a=>a.torso.userData.blenderAsset==='rivet'),
    rifle:__assetRig._cur.body.userData.blenderAsset, textures:__vb.stats.textures,
    drawCalls:__vb.stats.drawCalls, ownBodyVisible:__vb.stats.ownBodyVisible })`);
  assert.equal(checks.training.allRivet, true);
  assert.equal(checks.training.rifle, 'kestrel');
  assert.equal(checks.training.ownBodyVisible, true);
  const match = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(out, 'training.png'), Buffer.from(match.data, 'base64'));
  // GRENADES line-up: the five thrown props as ProjectileFX builds them in world.
  await page.send('Page.navigate', { url: `${base}/weapon-feel-preview.html` });
  await page.waitFor(`document.documentElement.dataset.previewReady === 'true'`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
  checks.thrown = await page.evaluate(`(async () => {
    const T = await import('/js/vendor/three.module.js');
    const { ProjectileFX } = await import('/js/weapons/projectiles.js');
    const renderer = new T.WebGLRenderer({ antialias: true }); renderer.setSize(1280, 640);
    Object.assign(renderer.domElement.style, { position: 'fixed', inset: '0', zIndex: '1000' });
    document.body.append(renderer.domElement);
    const scene = new T.Scene(); scene.background = new T.Color(0x2b3a48);
    const camera = new T.PerspectiveCamera(40, 2, .01, 200); camera.position.set(0, 1.05, 2.3); camera.lookAt(0, 1, 0);
    scene.add(camera, new T.HemisphereLight(0xd0e7ff, 0x514132, 2.4));
    const key = new T.DirectionalLight(0xffeed6, 3); key.position.set(-3, 6, 4); scene.add(key);
    const floor = new T.Mesh(new T.PlaneGeometry(80, 80), new T.MeshStandardMaterial({ color: 0x4a5c6b }));
    floor.rotation.x = -Math.PI / 2; scene.add(floor);
    const fx = new ProjectileFX(scene, () => 0, { camera });
    const types = ['frag', 'limpet', 'pulse', 'molotov', 'smoke'];
    const sizes = {};
    types.forEach((type, i) => {
      fx.launch({ pid: 'p' + i, type, o: [(i - 2) * .55, 1, 0], v: [0, 0, 0], fuse: 5000,
        n: type === 'limpet' ? [0, 0, 1] : undefined });
    });
    fx.update(.001, {});
    types.forEach((type, i) => {
      const p = fx.projectiles.get('p' + i);
      p.group.rotation.set(0, 0, 0); p.group.position.set((i - 2) * .55, 1, 0);
      let authored = null; p.group.traverse(o => { if (o.userData.blenderAsset === 'grenades' && !authored) authored = o; });
      sizes[type] = authored ? new T.Box3().setFromObject(authored).getSize(new T.Vector3()).toArray().map(v => +v.toFixed(3)) : null;
    });
    renderer.render(scene, camera); renderer.getContext().finish();
    return { sizes, gl: renderer.getContext().getError() };
  })()`);
  assert.equal(checks.thrown.gl, 0);
  for (const [type, size] of Object.entries(checks.thrown.sizes)) {
    assert.ok(size && size[0] > 0.14 && size[0] < 0.45 && size[1] < 0.62, `thrown ${type} authored at world scale`);
  }
  const lineup = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(out, 'grenades-world.png'), Buffer.from(lineup.data, 'base64'));
  assert.equal(page.errors.length, 0, page.errors.join('\n'));
  await writeFile(path.join(out, 'validation.json'), JSON.stringify(checks, null, 2)+'\n');
  console.log('Blender integration:', checks);
} catch (error) {
  if (browser) console.error('Browser errors:', browser.page.errors);
  throw error;
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
