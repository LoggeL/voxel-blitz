import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { CHAOS_UPGRADES } from '../shared/chaos.js';
import { GRENADE_TYPE_IDS } from '../shared/grenade-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = (condition, message) => { if (!condition) throw new Error(message); console.log(`ok - ${message}`); };
async function click(page, id) {
  const point = await page.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el?.scrollIntoView({block:'center'}); const r = el?.getBoundingClientRect(); return r?.width && r?.height ? {x:r.left+r.width/2,y:r.top+r.height/2} : null; })()`);
  check(point, `visible #${id}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...point, button:'left', buttons:type === 'mousePressed' ? 1 : 0, clickCount:1 });
}
async function key(page, key, code) {
  for (const type of ['keyDown','keyUp']) await page.send('Input.dispatchKeyEvent', {type,key,code});
}
async function select(page, id, value) {
  await page.evaluate(`(() => { const el=document.getElementById(${JSON.stringify(id)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
}
async function fireShot(page, label) {
  const self = `window.__qaMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.id===window.__vb.stats.localId)`;
  await page.waitFor(`(${self})?.state==='alive'`, { label: 'alive shooter' });
  if (await page.evaluate(`(() => {const p=${self};return p.mag[p.weapon]===0;})()`)) {
    await key(page,'r','KeyR');
  }
  await page.waitFor(`(() => {const p=${self};return p?.mag[p.weapon]>0&&!p.reloading;})()`, { label: 'loaded shooter' });
  const before = await page.evaluate(`(() => {const p=${self};return {weapon:p.weapon,mag:p.mag[p.weapon]};})()`);
  await page.waitFor(`(() => {const el=document.querySelector('[data-action="fire"]');const r=el?.getBoundingClientRect();return r?.width>0 && r?.height>0 && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el;})()`, { label: 'fire control ready' });
  const point = await page.evaluate(`(() => {const r=document.querySelector('[data-action="fire"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await page.send('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
  try {
    await page.waitFor(`(${self})?.mag[${before.weapon}]<${before.mag}`, { label });
  } finally {
    await page.send('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
  }
  check(true, label);
}
async function screenshot(page, filename) {
  const result=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},15000);
  await writeFile(filename,Buffer.from(result.data,'base64'));
}
async function main() {
  const expectedItems = [...WEAPON_IDS, ...GRENADE_TYPE_IDS];
  check(expectedItems.length === Object.keys(CHAOS_UPGRADES).length && expectedItems.every(id => CHAOS_UPGRADES[id]?.length === 3), 'every weapon and grenade has three Chaos upgrades');
  const server=startServer({cwd:root,failureContext:'chaos browser smoke'});
  let browser;
  try {
    const port=await server.port; await waitForHttp(port);
    browser=await launchCdpSession(`http://127.0.0.1:${port}/?debug=1&headless=1&touch=1`);
    const page=browser.page;
    await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__qaSockets=[];window.__qaMessages=[];const NativeSocket=window.WebSocket;window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.__qaSockets.push(this);this.addEventListener('message',event=>{if(typeof event.data==='string'){try{window.__qaMessages.push(JSON.parse(event.data))}catch{}}});}};`});
    await page.send('Page.reload');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await page.waitFor(`document.getElementById('create-lobby-btn') && !document.getElementById('menu').classList.contains('hidden')`,{label:'menu'});
    await click(page,'create-lobby-btn');
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden')==='false'`,{label:'waiting lobby'});
    await select(page,'game-mode-select','chaos');
    await page.waitFor(`document.getElementById('lobby-mode-val').textContent.includes('CHAOS')`,{label:'authoritative chaos mode'});
    await select(page,'bot-count','0');
    await page.waitFor(`window.__qaMessages.filter(m=>m.t==='lobbyState').at(-1)?.bots===0`,{label:'zero bots'});
    await click(page,'lobby-ready-btn');
    await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled===false`,{label:'ready to start'});
    await click(page,'lobby-start-btn');
    await page.waitFor(`window.__vb?.stats?.running && window.__vb.stats.ringLen>0`,{timeoutMs:30000,label:'live chaos'});
    await fireShot(page,'shooting consumes authoritative ammo before opening shop');
    await key(page,'b','KeyB');
    await page.waitFor(`document.getElementById('buy-menu')?.getAttribute('aria-hidden')==='false'`,{label:'B opens shop'});
    check(await page.evaluate(`(() => {const ids=${JSON.stringify(expectedItems)};return document.querySelectorAll('#buy-grid .vb-buy-card').length===ids.length && ids.every(id=>{const descriptions=[...document.querySelectorAll('#buy-card-'+id+' .vb-chaos-stage span')];return descriptions.length===3&&descriptions.every(el=>el.textContent.length>10);});})()`),`all ${expectedItems.length} items and ${expectedItems.length * 3} upgrade descriptions render`);
    await page.waitFor(`(() => {const images=[...document.querySelectorAll('#buy-grid .vb-chaos-weapon-image')];return images.length===${expectedItems.length}&&images.every(image=>image.complete&&image.naturalWidth>0&&image.naturalHeight>0);})()`,{label:'all weapon and grenade artwork loads'});
    check(await page.evaluate(`['flamethrower','minigun'].every(id=>document.querySelector('#buy-card-'+id+' img').getAttribute('src')==='./assets/weapons/hud/'+id+'-illustrated.png')`),'both heavy weapons use their illustrated artwork');
    check(await page.evaluate(`['frag','limpet','pulse'].every(id=>document.querySelector('#buy-card-'+id+' img').getAttribute('src')==='./assets/grenades/hud/'+id+(id==='limpet'?'.svg':'.png'))`),'grenade cards show their distinct artwork');
    check(await page.evaluate(`document.getElementById('buy-credits-val').textContent==='$ 600'`),'starting balance is $600');
    const focused=[];
    for(let index=0;index<=expectedItems.length;index++) {
      await key(page,'Tab','Tab');
      focused.push(await page.evaluate(`document.activeElement.id`));
    }
    check(expectedItems.every(id=>focused.includes('buy-btn-'+id))&&focused.includes('buy-close-btn'),'Tab reaches every upgrade and keeps focus inside the shop');
    await page.evaluate(`document.querySelector('.vb-buy-panel').scrollTop=0`);
    const layout=await page.evaluate(`(() => {const panel=document.querySelector('.vb-buy-panel');const r=panel.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:panel.scrollWidth>panel.clientWidth+1};})()`);
    check(layout.fits&&!layout.overflow,'desktop shop fits viewport without horizontal overflow');
    await screenshot(page,'/tmp/voxel-chaos-shop.png');
    await click(page,'buy-btn-flamethrower');
    await page.waitFor(`document.getElementById('buy-credits-val').textContent==='$ 300' && document.getElementById('buy-price-flamethrower').textContent==='1 / 3 INSTALLED'`,{label:'authoritative flamethrower tier one purchase'});
    check(await page.evaluate(`document.getElementById('buy-btn-flamethrower').disabled`),'unaffordable flamethrower second tier is disabled');
    await key(page,'Escape','Escape');
    await page.waitFor(`document.getElementById('buy-menu')?.getAttribute('aria-hidden')==='true' && !window.__vb.stats.settingsOpen`,{label:'Escape closes the shop without opening settings'});
    await fireShot(page,'shooting resumes after buying a flamethrower upgrade');
    await key(page,'b','KeyB');
    await page.waitFor(`document.getElementById('buy-menu')?.getAttribute('aria-hidden')==='false'`,{label:'B reopens shop'});
    check(await page.evaluate(`document.getElementById('buy-price-flamethrower').textContent==='1 / 3 INSTALLED' && document.getElementById('buy-credits-val').textContent==='$ 300'`),'reopening preserves the confirmed upgrade and balance');
    await click(page,'buy-btn-minigun');
    await page.waitFor(`document.getElementById('buy-credits-val').textContent==='$ 0' && document.getElementById('buy-price-minigun').textContent==='1 / 3 INSTALLED'`,{label:'authoritative minigun tier one purchase'});
    await screenshot(page,'/tmp/voxel-chaos-shop-new-weapons.png');
    await page.evaluate(`window.__qaSockets.at(-1).send(JSON.stringify({t:'buy',weapon:'chaos:flamethrower:1'}))`);
    await page.waitFor(`window.__qaMessages.some(m=>JSON.stringify(m).includes('Purchase unavailable'))`,{label:'stale purchase rejected'});
    check(await page.evaluate(`document.getElementById('buy-credits-val').textContent==='$ 0' && ['flamethrower','minigun'].every(id=>document.getElementById('buy-price-'+id).textContent==='1 / 3 INSTALLED')`),'duplicate request leaves authoritative money and both new weapon levels unchanged');
    await page.evaluate(`document.getElementById('buy-card-frag').scrollIntoView({block:'center'})`);
    await screenshot(page,'/tmp/voxel-chaos-shop-grenades.png');
    await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await page.waitFor(`innerWidth===390`,{label:'mobile width'});
    const mobile=await page.evaluate(`(() => {const panel=document.querySelector('.vb-buy-panel');panel.scrollTop=0;const r=panel.getBoundingClientRect();return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:panel.scrollWidth>panel.clientWidth+1};})()`);
    check(mobile.fits&&!mobile.overflow,'390px shop fits viewport without horizontal overflow');
    await screenshot(page,'/tmp/voxel-chaos-shop-mobile.png');
    await page.evaluate(`document.getElementById('buy-card-frag').scrollIntoView({block:'start'})`);
    await screenshot(page,'/tmp/voxel-chaos-shop-mobile-grenades.png');
    await click(page,'buy-close-btn');
    await page.waitFor(`document.getElementById('buy-menu')?.getAttribute('aria-hidden')==='true' && window.__vb.stats.running && !window.__vb.stats.settingsOpen`,{label:'close returns to gameplay'});
    await fireShot(page,'shooting resumes after upgrading and closing shop');
    check(await page.evaluate(`!document.documentElement.dataset.vbLastError`)&&page.errors.length===0,`no browser runtime errors: ${page.errors.join('; ')}`);
    console.log('CHAOS BROWSER SMOKE: OK');
  } catch(error) {
    if(browser) { await screenshot(browser.page,'/tmp/voxel-chaos-shop-failure.png').catch(()=>{}); console.error(await browser.page.evaluate(`JSON.stringify({stats:window.__vb?.stats,messages:window.__qaMessages?.slice(-3)})`).catch(()=>'')); }
    throw error;
  } finally { await browser?.close(); await stopServer(server); }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
