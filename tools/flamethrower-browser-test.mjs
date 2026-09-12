// Presentation fixture: burn/HP/panic come from a production server hit, then
// stay pinned at that snapshot while capturing the real game at several sizes.
// Simulation, wire and lifecycle tests live in flamethrower-test.mjs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PlayerEntity } from '../server/sim/player.js';
import { FlameSystem } from '../server/sim/fire.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const owner = new PlayerEntity('a','Attacker',{x:0,y:1,z:4});
const victim = new PlayerEntity('b','Target',{x:0,y:1,z:0});
const flames = new FlameSystem();
const ctx = { entities:new Map([['a',owner],['b',victim]]), canDamage:()=>true,
  solidAt:()=>false, pushEvent(){}, killPlayer(){ assert.fail('single hit cannot kill'); } };
flames.launch(owner,[owner.x,owner.eyeY,owner.z],{x:0,y:0,z:-1},ctx);
flames.step(0.2,ctx);
const row = makeSnapshot([victim],[],[],0).players[0];
assert.equal(row.panic,1); assert.ok(row.burning > 0);
const fixture = { hp:row.hp, burning:row.burning, panic:row.panic, pain:row.pain };
const output = process.env.FLAME_CAPTURE_DIR || '.artifacts/flamethrower-support';
const server = startServer();
let browser;
try {
  const port = await server.port; await waitForHttp(port);
  for (const { touch, sizes } of [
    { touch: false, sizes: [[1280,720]] },
    { touch: true, sizes: [[844,390],[390,844]] },
  ]) {
    browser = await launchCdpSession(`http://127.0.0.1:${port}/?debug=1&headless=1${touch ? '&touch=1' : ''}`);
    const page = browser.page;
    await page.waitFor(`!!document.getElementById('training-btn')`);
    await page.evaluate(`document.getElementById('training-btn').click()`);
    await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
    await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
    await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled === false`);
    await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
    await page.waitFor(`window.__vb?.stats.running && window.__vb.stats.lastSnapAgeMs < 1000`);
    await page.evaluate(`(async () => {
      const { LocalPlayer } = await import('/js/player/local-player.js');
      const { CombatPostProcess } = await import('/js/engine/combat-post-process.js');
      const { setDisplaySetting } = await import('/js/ui/display-settings.js');
      setDisplaySetting('showPanicMeter',true);
      const reconcile = LocalPlayer.prototype.reconcile;
      const render = CombatPostProcess.prototype.render;
      window.flameFixture = ${JSON.stringify(fixture)};
      LocalPlayer.prototype.reconcile = function(me,...args) {
        return reconcile.call(this, {...me,...window.flameFixture}, ...args);
      };
      CombatPostProcess.prototype.render = function(scene,camera,state) {
        window.burnPresentation = { burning:state.burning, panic:state.panic, motion:!this.reducedMotion };
        return render.call(this,scene,camera,{...state,time:2});
      };
      window.restoreFlameFixture = () => { LocalPlayer.prototype.reconcile = reconcile; CombatPostProcess.prototype.render = render; };
    })()`);
    await page.waitFor(`window.__vb.stats.panic === 1 && window.burnPresentation?.burning === 1`);
    await mkdir(output,{recursive:true});
    for (const [width,height] of sizes) {
      await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      const frame = await page.evaluate('window.__vb.stats.shader.frames');
      await page.waitFor(`window.__vb.stats.shader.frames > ${frame+4} && window.__vb.stats.shader.bufferWidth === ${width}`);
      const state = await page.evaluate(`({panic:window.__vb.stats.panic,post:window.burnPresentation,
        meter:document.getElementById('panic-meter').getAttribute('aria-valuenow'),
        shader:window.__vb.stats.shader,overflow:document.documentElement.scrollWidth > innerWidth,
        phaseErrors:JSON.parse(document.documentElement.dataset.vbStats || '{}').phaseErrs})`);
      assert.equal(state.panic,1); assert.equal(state.post.burning,1);
      assert.equal(state.meter,'100');
      assert.equal(state.shader.fallbacks,0); assert.equal(state.overflow,false);
      assert.equal(state.phaseErrors,null);
      const shot = await page.send('Page.captureScreenshot',{format:'png'});
      await writeFile(`${output}/burning-${width}x${height}.png`,Buffer.from(shot.data,'base64'));
      console.log(`ok - ${width}x${height}: authoritative hit fixture reaches HUD and burning shader; no overflow/fallback`);
    }
    await page.evaluate(`window.flameFixture = {burning:0,panic:0,pain:0}`);
    await page.waitFor(`window.__vb.stats.panic === 0 && window.burnPresentation?.burning === 0`);
    await page.evaluate(`window.restoreFlameFixture()`);
    assert.deepEqual(page.errors,[]);
    console.log('ok - extinguishing clears the live burning presentation');
    await browser.close(); browser = null;
  }
} finally { if(browser) await browser.close(); await stopServer(server); }
