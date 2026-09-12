import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAREER_CATALOG } from '../shared/career.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-model-viewer-'));
const earnedGuest = randomBytes(32).toString('hex');
await writeFile(path.join(directory, `${earnedGuest}.json`), JSON.stringify({
  xp: 980100, credits: 0, pvpKills: 10000, kills: 10000, matches: 20,
  mastery: { rifle: { kills: 5000, headshots: 0 }, revolver: { kills: 5000, headshots: 0 }, minigun: { kills: 5000, headshots: 0 } },
  owned: ['amber', 'rookie', 'rifle-overdrive', 'salvager'],
  equipped: { theme: 'amber', title: 'rookie', characterSkin: 'salvager', weaponSkins: { rifle: 'rifle-overdrive' },
    weaponAttachments: { rifle: { optic: 'reflex', grip: 'vertical' } } },
}));
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory, VB_PERSISTENCE: 'file' } });
let browser;
try {
  const url = `http://127.0.0.1:${await server.port}/?debug=1&headless=1`;
  browser = await launchCdpSession(url, { width: 1440, height: 900 });
  const page = browser.page;
  await mkdir('.artifacts/model-viewer', { recursive: true });
  const snapshot = async name => {
    await page.evaluate(`document.activeElement?.blur()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/model-viewer/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  const click = async selector => {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    if (selector === '#career-close' || selector === '#workshop-close') {
      await page.waitFor(`!document.querySelector('.vb-model-viewer')`, { label: 'dialog close cleanup' });
    }
  };
  const hook = async () => {
    await page.waitFor(`document.getElementById('career-open') && document.getElementById('workshop-open')`);
    await page.evaluate(`(async () => {
      const { ModelViewer } = await import('/js/ui/model-viewer.js');
      const show = ModelViewer.prototype.show;
      window.__viewers = [];
      ModelViewer.prototype.show = function(...args) {
        window.__viewer = this;
        if (!window.__viewers.includes(this)) window.__viewers.push(this);
        return show.apply(this, args);
      };
    })()`);
  };
  const ready = skin => page.waitFor(`document.querySelector('.vb-model-stage canvas[data-ready="true"]')?.dataset.skin === ${JSON.stringify(skin)}`);
  const view = () => page.evaluate(`({ yaw: __viewer.yaw, pitch: __viewer.pitch, zoom: __viewer.zoom })`);
  const canvasPoint = () => page.evaluate(`(() => { const r = __viewer.canvas.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`);
  const drag = async (dx, dy) => {
    const { x, y } = await canvasPoint();
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1 });
  };
  const framing = async label => {
    const result = await page.evaluate(`(() => {
      const v = __viewer;
      return { finite: v.camera.position.toArray().every(Number.isFinite),
        inside: v.corners.every(p => { const q = p.clone().project(v.camera); return Math.abs(q.x)<1 && Math.abs(q.y)<1 && q.z>-1 && q.z<1; }),
        touch: getComputedStyle(v.canvas).touchAction,
        size: [v.canvas.clientWidth, v.canvas.clientHeight],
        hiddenHands: !v.gun || ['hand_l','hand_r'].every(n => !v.gun.root.getObjectByName(n)?.visible) };
    })()`);
    assert.equal(result.finite, true, `${label}: finite camera`);
    assert.equal(result.inside, true, `${label}: entire model fits`);
    assert.equal(result.touch, 'none', `${label}: gestures remain in viewer`);
    assert.ok(result.size[0] > 100 && result.size[1] >= 140, `${label}: useful stage size`);
    assert.equal(result.hiddenHands, true, `${label}: no floating viewmodel hands`);
  };
  await hook();
  await page.send('Network.enable');
  await click('#career-open'); await ready('rifle-overdrive');
  assert.equal(await page.evaluate(`document.querySelector('.vb-career-feature [data-featured-item="rifle-overdrive"]').disabled`), true, 'locked skins preview without being equippable');
  const initial = await view();
  await framing('locked rifle');
  await snapshot('collection-desktop');
  await drag(80, 30);
  let moved = await view();
  assert.notEqual(moved.yaw, initial.yaw, 'mouse drag rotates horizontally');
  assert.notEqual(moved.pitch, initial.pitch, 'mouse drag rotates vertically');
  assert.equal(await page.evaluate(`__viewer.pointers.size`), 0, 'mouse release ends drag');
  await click('[data-viewer-action="reset"]');
  assert.deepEqual(await view(), initial, 'reset restores framing');
  const { x, y } = await canvasPoint();
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120 });
  await page.waitFor(`__viewer.zoom > 1`);
  await click('[data-viewer-action="standard"]'); await ready('standard');
  assert.equal(await page.evaluate(`__viewer.gun.root.userData.skin`), 'standard', 'comparison changes actual materials');
  assert.equal((await view()).zoom > 1, true, 'comparison preserves zoom');
  await click('[data-viewer-action="standard"]'); await ready('rifle-overdrive');
  assert.equal(await page.evaluate(`__viewer.gun.root.userData.skin`), 'rifle-overdrive');
  await page.evaluate(`__viewer.canvas.focus()`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  assert.deepEqual(await view(), initial, 'keyboard Home restores view');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  assert.notEqual((await view()).yaw, initial.yaw, 'keyboard rotates model');
  await click('[data-viewer-action="reset"]');
  for (const item of CAREER_CATALOG.filter(item => ['weaponSkin', 'characterSkin'].includes(item.kind))) {
    await click(`[data-inspect="${item.id}"]`); await ready(item.id);
    await framing(item.id);
    assert.equal(await page.evaluate(`__viewer.root.userData.skin`), item.id, `${item.id}: gameplay skin module applied`);
    await click('[data-viewer-action="standard"]'); await ready('standard');
    await click('[data-viewer-action="standard"]'); await ready(item.id);
  }
  await click('[data-inspect="salvager"]'); await ready('salvager');
  await snapshot('character-desktop');
  const inspectPosts = page.events.filter(e => e.method === 'Network.requestWillBeSent' && e.params.request.method === 'POST' && e.params.request.url.includes('/api/career'));
  assert.equal(inspectPosts.length, 0, 'inspection and standard comparison never modify inventory');
  assert.equal(await page.evaluate(`__viewers.filter(v => !v.disposed).length`), 1, 'skin selection reuses one WebGL context');
  await click('[data-filter="sound"]');
  assert.equal(await page.evaluate(`__viewers.every(v => v.disposed)`), true, 'non-model category releases viewer');
  assert.equal(await page.evaluate(`document.querySelectorAll('.vb-model-viewer').length`), 0);
  await click('[data-filter="characterSkin"]'); await ready('salvager');
  for (const [width, height] of [[1280, 720], [390, 844], [360, 800]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.querySelector('.vb-career-feature').scrollIntoView({block:'start'})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await framing(`character ${width}`);
    assert.equal(await page.evaluate(`document.getElementById('career-shop').scrollWidth <= document.getElementById('career-shop').clientWidth`), true, `${width}: no horizontal overflow`);
    await snapshot(`character-${width}`);
    if (width === 390) {
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      const before = await view(); const p = await canvasPoint();
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 0 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + 45, y: p.y + 15, id: 0 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.notEqual((await view()).yaw, before.yaw, 'one finger rotates');
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x - 25, y: p.y, id: 0 }, { x: p.x + 25, y: p.y, id: 1 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x - 50, y: p.y, id: 0 }, { x: p.x + 50, y: p.y, id: 1 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.ok((await view()).zoom > before.zoom, 'two fingers zoom');
      assert.equal(await page.evaluate(`__viewer.pointers.size`), 0, 'touch release ends gesture');
      await click('[data-viewer-action="reset"]');
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  }
  await click('#career-close');
  assert.equal(await page.evaluate(`__viewers.every(v => v.disposed)`), true, 'closing collection releases GPU resources');
  await page.send('Network.setCookie', { name: 'vb-career', value: earnedGuest, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`document.querySelector('.vb-career-stats')?.textContent.includes('LEVEL 100')`, { label: 'earned fixture after reload' });
  await hook();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('#workshop-open'); await ready('rifle-overdrive');
  assert.equal(await page.evaluate(`__viewer.gun.attachmentKey`), 'reflex/vertical', 'armory uses saved attachments with equipped skin');
  await snapshot('armory-desktop');
  for (const id of WEAPON_IDS) {
    await click(`[data-weapon="${id}"]`);
    await page.waitFor(`__viewer.weapon === ${JSON.stringify(id)} && __viewer.canvas.dataset.ready === 'true'`);
    await framing(`armory ${id}`);
    await drag(40, 20); await framing(`rotated ${id}`);
  }
  await click('[data-weapon="rifle"]'); await ready('rifle-overdrive');
  await click('[data-optic="scope4"]');
  assert.equal(await page.evaluate(`__viewer.gun.attachmentKey`), 'scope4/vertical', 'draft attachments shown immediately');
  await click('[data-viewer-action="standard"]'); await ready('standard');
  assert.equal(await page.evaluate(`__viewer.gun.attachmentKey`), 'scope4/vertical', 'standard comparison preserves draft attachments');
  await click('[data-viewer-action="standard"]'); await ready('rifle-overdrive');
  for (const [width, height] of [[1280, 720], [390, 844], [360, 800]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.querySelector('.vb-workshop-center').scrollIntoView({block:'center'})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await framing(`armory ${width}`);
    assert.equal(await page.evaluate(`document.getElementById('weapon-customization').scrollWidth <= document.getElementById('weapon-customization').clientWidth`), true, `${width}: armory fits`);
    await snapshot(`armory-${width}`);
  }
  await click('#workshop-close');
  assert.equal(await page.evaluate(`__viewers.every(v => v.disposed)`), true, 'closing armory releases GPU resources');
  await click('#career-open'); await ready('rifle-overdrive');
  for (let i = 0; i < 3; i++) {
    await click('#career-close'); await click('#career-open'); await ready('rifle-overdrive');
  }
  assert.equal(await page.evaluate(`__viewers.filter(v => !v.disposed).length`), 1, 'reopening has exactly one live viewer');
  await click('#career-close');
  assert.equal(await page.evaluate(`__viewers.every(v => v.disposed && v.gun === null && v.avatar === null)`), true);
  // Closing while the lazy module/show operation is pending must not revive a viewer.
  await page.evaluate(`document.getElementById('career-open').click(); document.getElementById('career-shop').close()`);
  await page.waitFor(`!document.getElementById('career-shop').open && !document.querySelector('.vb-model-viewer')`);
  await page.evaluate(`new Promise(resolve => setTimeout(resolve, 150))`);
  assert.equal(await page.evaluate(`__viewers.filter(v => !v.disposed).length`), 0, 'pending preview stays closed');
  await click('#career-open'); await ready('rifle-overdrive');
  await page.evaluate(`window.__graphicsLoss = __viewer.renderer.getContext().getExtension('WEBGL_lose_context'); __graphicsLoss.loseContext()`);
  await page.waitFor(`__viewer.contextLost && __viewer.canvas.dataset.ready === 'false'`);
  await page.evaluate(`__graphicsLoss.restoreContext()`);
  await page.waitFor(`!__viewer.contextLost && __viewer.canvas.dataset.ready === 'true'`);
  await framing('restored WebGL context');
  await click('#career-close');
  assert.deepEqual(page.errors, [], 'no browser errors');
  console.log('Model viewer: all five skins and twelve weapons, actual material/attachment parity, locked inspection without writes, mouse/touch/pinch/keyboard controls, reset, standard comparison, responsive framing at 1440/1280/390/360px, category changes and close/reopen cleanup passed.');
} catch (error) {
  console.error(server.stderr);
  if (browser) {
    console.error(await browser.page.evaluate(`({ models: Array.from(document.querySelectorAll('.vb-model-stage canvas')).map(c => c.dataset), status: document.querySelector('.vb-workshop-footer')?.textContent, profile: document.querySelector('.vb-career-stats')?.textContent })`));
    console.error(browser.page.errors);
  }
  throw error;
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
