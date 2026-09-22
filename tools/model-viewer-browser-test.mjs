import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAREER_CATALOG, xpForLevel } from '../shared/career.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-model-viewer-'));
const earnedGuest = randomBytes(32).toString('hex');
// Level 100 with revolver and minigun mastery but no rifle mastery: the rifle skin stays locked.
await writeFile(path.join(directory, `${earnedGuest}.json`), JSON.stringify({
  xp: xpForLevel(100), credits: 0, pvpKills: 10000, kills: 10000, matches: 20,
  mastery: { revolver: { kills: 5000, headshots: 0 }, minigun: { kills: 5000, headshots: 0 } },
  owned: ['amber', 'rookie', 'salvager'],
  equipped: { theme: 'amber', title: 'rookie', characterSkin: 'salvager', weaponSkins: {},
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
    if (selector === '#career-close') await page.waitFor(`!document.querySelector('.vb-model-viewer')`, { label: 'dialog close cleanup' });
  };
  const hook = async () => {
    await page.waitFor(`!!document.getElementById('career-open')`);
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
  const ready = skin => page.waitFor(`document.querySelector('.vb-model-stage canvas[data-ready="true"]')?.dataset.skin === ${JSON.stringify(skin)}`, { label: `viewer shows ${skin}` });
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
    assert.equal(result.touch, 'pan-y', `${label}: vertical swipes scroll the page, sideways drags rotate`);
    assert.ok(result.size[0] > 100 && result.size[1] >= 140, `${label}: useful stage size ${result.size}`);
    assert.equal(result.hiddenHands, true, `${label}: no floating viewmodel hands`);
  };
  const noOverflow = async label => assert.equal(await page.evaluate(`document.getElementById('career-shop').scrollWidth <= document.getElementById('career-shop').clientWidth && document.documentElement.scrollWidth <= innerWidth`), true, `${label}: no horizontal overflow`);
  const openSheet = () => page.evaluate(`(() => { const i = document.getElementById('armory-inspector');
    if (matchMedia('(max-width: 640px)').matches && i.dataset.sheet !== 'open') i.querySelector('.vb-armory-sheet-toggle').click(); })()`);
  const careerPosts = () => page.events.filter(e => e.method === 'Network.requestWillBeSent' && e.params.request.method === 'POST' && e.params.request.url.includes('/api/career'));

  await hook();
  await page.send('Network.enable');
  // LOADOUT opens on the equipped operator skin: the standard model loads in 3D.
  await click('#career-open'); await ready('standard');
  assert.equal(await page.evaluate(`document.getElementById('armory-tab-loadout').getAttribute('aria-selected')`), 'true');
  assert.equal(await page.evaluate(`document.querySelector('.vb-armory-stage [data-ready="true"]')?.dataset.model`), 'character', 'the viewer loads in LOADOUT');
  await click('[data-option="salvager"]'); await ready('salvager');
  assert.equal(await page.evaluate(`document.getElementById('armory-inspector').dataset.featuredItem`), 'salvager');
  assert.equal(await page.evaluate(`document.getElementById('armory-action').disabled && !document.getElementById('armory-action').dataset.item`), true, 'locked skins preview without being equippable');
  const initial = await view();
  await framing('locked operator skin');
  await snapshot('loadout-desktop');
  await drag(80, 30);
  const moved = await view();
  assert.notEqual(moved.yaw, initial.yaw, 'mouse drag rotates horizontally');
  assert.equal(moved.pitch, initial.pitch, 'vertical travel never tilts the model');
  assert.equal(await page.evaluate(`__viewer.pointers.size`), 0, 'mouse release ends drag');
  await click('[data-viewer-action="reset"]');
  assert.deepEqual(await view(), initial, 'reset restores framing');
  const { x, y } = await canvasPoint();
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120 });
  await page.waitFor(`__viewer.zoom > 1`);
  await click('[data-viewer-action="standard"]'); await ready('standard');
  assert.equal((await view()).zoom > 1, true, 'comparison preserves zoom');
  await click('[data-viewer-action="standard"]'); await ready('salvager');
  await page.evaluate(`__viewer.canvas.focus()`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  assert.deepEqual(await view(), initial, 'keyboard Home restores view');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  assert.notEqual((await view()).yaw, initial.yaw, 'keyboard rotates model');
  await click('[data-viewer-action="reset"]');

  // Every skin in the catalog inspects from the unlock tree with its real gameplay module.
  await click('#armory-tab-progress');
  await page.waitFor(`!!document.querySelector('#progression-tree [data-tree-node]')`);
  for (const item of CAREER_CATALOG.filter(item => ['weaponSkin', 'characterSkin'].includes(item.kind))) {
    await click(`#progression-tree [data-tree-node="${item.id}"]`); await ready(item.id);
    await framing(item.id);
    assert.equal(await page.evaluate(`__viewer.root.userData.skin`), item.id, `${item.id}: gameplay skin module applied`);
    if (item.kind === 'weaponSkin') assert.equal(await page.evaluate(`__viewer.gun.root.userData.skin`), item.id, `${item.id}: actual gun materials`);
    await click('[data-viewer-action="standard"]'); await ready('standard');
    await click('[data-viewer-action="standard"]'); await ready(item.id);
  }
  await click('#progression-tree [data-tree-node="salvager"]'); await ready('salvager');
  await snapshot('character-desktop');
  assert.equal(careerPosts().length, 0, 'inspection and standard comparison never modify inventory');
  assert.equal(await page.evaluate(`__viewers.filter(v => !v.disposed).length`), 1, 'every preview reuses one WebGL context');
  await click('#progression-tree [data-tree-node="arctic"]');
  await page.waitFor(`document.querySelector('.vb-armory-stage-viewer').hidden && document.querySelector('.vb-armory-stage').dataset.kind === 'theme'`);
  await click('#progression-tree [data-tree-node="salvager"]'); await ready('salvager');
  for (const [width, height] of [[1280, 720], [390, 844], [360, 800]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await openSheet();
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.evaluate(`__viewer.render()`);
    await framing(`character ${width}`);
    await noOverflow(`character ${width}`);
    await snapshot(`character-${width}`);
    if (width === 390) {
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      const before = await view(); const p = await canvasPoint();
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 0 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + 45, y: p.y + 4, id: 0 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.notEqual((await view()).yaw, before.yaw, 'one finger rotates sideways');
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x - 25, y: p.y, id: 0 }, { x: p.x + 25, y: p.y, id: 1 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x - 50, y: p.y, id: 0 }, { x: p.x + 50, y: p.y, id: 1 }] });
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.ok((await view()).zoom > before.zoom, 'two fingers zoom');
      assert.equal(await page.evaluate(`__viewer.pointers.size`), 0, 'touch release ends gesture');
      await click('[data-viewer-action="reset"]');
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('#career-close');
  assert.equal(await page.evaluate(`__viewers.every(v => v.disposed)`), true, 'closing the armory releases GPU resources');

  // WEAPONS at level 100 without rifle mastery.
  await page.send('Network.setCookie', { name: 'vb-career', value: earnedGuest, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-menu-preview')?.textContent.includes('LEVEL 100')`, { label: 'earned fixture after reload' });
  await hook();
  await page.send('Network.enable');
  await click('#career-open'); await ready('salvager');
  await click('#armory-tab-weapons');
  await page.waitFor(`document.querySelector('#armory-weapon-rail [data-weapon="rifle"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-skin-option="rifle-overdrive"]')`);
  assert.deepEqual(await page.evaluate(`(() => { const o = document.querySelector('[data-skin-option="rifle-overdrive"]'); return [o.dataset.locked, o.getAttribute('aria-disabled'), o.dataset.state]; })()`),
    ['true', 'true', 'next'], 'rifle-overdrive stays locked (next up, mastery missing) at level 100 without rifle mastery');
  assert.match(await page.evaluate(`document.querySelector('[data-skin-option="rifle-overdrive"]').textContent`), /SPECIALIST/);
  await page.waitFor(`__viewer.weapon === 'rifle' && __viewer.gun?.attachmentKey === 'reflex/vertical'`, { label: 'saved attachments applied' });
  assert.equal(await page.evaluate(`document.getElementById('armory-action').hidden`), true, 'the bench options are the controls');
  await snapshot('weapons-desktop');
  for (const id of WEAPON_IDS) {
    await click(`#armory-weapon-rail [data-weapon="${id}"]`);
    await page.waitFor(`__viewer.weapon === ${JSON.stringify(id)} && __viewer.canvas.dataset.ready === 'true'`, { label: `bench ${id}` });
    await framing(`bench ${id}`);
    await drag(40, 20); await framing(`rotated ${id}`);
  }
  await click('#armory-weapon-rail [data-weapon="rifle"]');
  await page.waitFor(`__viewer.weapon === 'rifle' && __viewer.canvas.dataset.ready === 'true'`);
  const postsBefore = careerPosts().length;
  await click('[data-optic="scope4"]');
  await page.waitFor(`__viewer.gun.attachmentKey === 'scope4/vertical'`, { label: 'picked optic shown immediately' });
  await page.waitFor(`/setup saved$/.test(document.getElementById('armory-status').textContent)`, { label: 'scope4 saved on select' });
  const saves = careerPosts().slice(postsBefore);
  assert.equal(saves.length, 1, 'one debounced save');
  assert.match(saves[0].params.request.url, /\/api\/career\/attachments$/);
  await click('[data-viewer-action="standard"]'); await ready('standard');
  assert.equal(await page.evaluate(`__viewer.gun.attachmentKey`), 'scope4/vertical', 'standard comparison preserves the setup');
  await click('[data-viewer-action="standard"]');
  for (const [width, height] of [[1280, 720], [390, 844], [360, 800]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await openSheet();
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.evaluate(`__viewer.render()`);
    await framing(`bench ${width}`);
    await noOverflow(`bench ${width}`);
    await snapshot(`weapons-${width}`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('#career-close');
  assert.equal(await page.evaluate(`__viewers.every(v => v.disposed)`), true, 'closing releases the bench viewer');
  await click('#career-open'); await ready('salvager');
  for (let i = 0; i < 3; i++) {
    await click('#career-close'); await click('#career-open'); await ready('salvager');
  }
  assert.equal(await page.evaluate(`__viewers.filter(v => !v.disposed).length`), 1, 'reopening has exactly one live viewer');
  await click('#career-close');
  assert.equal(await page.evaluate(`__viewers.every(v => v.disposed && v.gun === null && v.avatar === null)`), true);
  // Closing while the lazy module/show operation is pending must not revive a viewer.
  await page.evaluate(`document.getElementById('career-open').click(); document.getElementById('career-shop').close()`);
  await page.waitFor(`!document.getElementById('career-shop').open && !document.querySelector('.vb-model-viewer')`);
  await page.evaluate(`new Promise(resolve => setTimeout(resolve, 150))`);
  assert.equal(await page.evaluate(`__viewers.filter(v => !v.disposed).length`), 0, 'pending preview stays closed');
  await click('#career-open'); await ready('salvager');
  await page.evaluate(`window.__graphicsLoss = __viewer.renderer.getContext().getExtension('WEBGL_lose_context'); __graphicsLoss.loseContext()`);
  await page.waitFor(`__viewer.contextLost && __viewer.canvas.dataset.ready === 'false'`);
  await page.evaluate(`__graphicsLoss.restoreContext()`);
  await page.waitFor(`!__viewer.contextLost && __viewer.canvas.dataset.ready === 'true'`);
  await framing('restored WebGL context');
  await click('#career-close');
  assert.deepEqual(page.errors, [], 'no browser errors');
  console.log('Model viewer: LOADOUT 3D, all five skins from the tree, locked inspection without writes, sideways drag/touch/pinch/keyboard, reset and standard comparison, WEAPONS bench for every weapon with scope4 save-on-select, locked rifle skin at level 100, responsive framing at 1280/390/360px and close/reopen cleanup passed.');
} catch (error) {
  console.error(server.stderr);
  if (browser) {
    console.error(await browser.page.evaluate(`({ models: Array.from(document.querySelectorAll('.vb-model-stage canvas')).map(c => ({ ...c.dataset })), status: document.getElementById('armory-status')?.textContent, profile: document.querySelector('.vb-career-stats')?.textContent })`).catch(() => null));
    console.error(browser.page.errors);
  }
  throw error;
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
