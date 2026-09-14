import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const server = startServer({ failureContext: 'spectator camera browser regression' });
let browser;
try {
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/shared/worlddata.js`, {
    headless: process.env.SPECTATOR_HEADED !== '1',
  });
  const { page } = browser;
  // Expose the composition root in this disposable browser's response only.
  // Load the real HTML document so pointer-lock eligibility is tested too.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/js/main.js*', requestStage: 'Response' }] });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/?headless=1&shader=0` });
  let paused;
  for (let attempt = 0; attempt < 100 && !paused; attempt++) {
    paused = page.events.find(event => event.method === 'Fetch.requestPaused');
    if (!paused) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(paused, 'game module response intercepted');
  const { requestId } = paused.params;
  const response = await page.send('Fetch.getResponseBody', { requestId });
  const source = response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body;
  await page.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
    body: Buffer.from(source + '\nwindow.testGame = game;').toString('base64') });
  await page.send('Fetch.disable');
  await page.waitFor('!!window.testGame');
  await page.evaluate(`void testGame.session.begin({ mode: 'create', gameMode: 'training', map: 'killhouse', bots: 0, name: 'Spectator QA' })`);
  await page.waitFor(`document.getElementById('lobby-ready-btn')?.offsetWidth > 0`,
    { timeoutMs: 30_000, label: 'spectator test lobby' });
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`!document.getElementById('lobby-start-btn')?.disabled`);
  await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
  await page.waitFor(`window.testGame?.running && testGame.playersCache.length > 1`,
    { timeoutMs: 45_000, label: 'running game and target avatars' });

  const initial = await page.evaluate(`(() => {
    const game = testGame;
    // Freeze a recorded wire snapshot and drive a deterministic death through the
    // same reconciliation method used by live ticks. Keep the real frame loop.
    window.snapshot = structuredClone(game.net.latestSnapshots.at(-1));
    game.handleTick = () => {};
    snapshot.match.mode = 'fun';
    snapshot.match.phase = 'live';
    snapshot.events = [];
    const self = snapshot.players.find(row => row.id === game.myId);
    self.state = 'dead'; self.hp = 0; self.respawnAt = null;
    snapshot.snapSeq++;
    game.consumeAuthoritativeSnapshot(snapshot);
    game.killcam.stop();
    game.hud.closeSettings();
    game.session.syncGameplayInput();
    window.firstPersonUpdates = 0;
    const updateCamera = game.player.updateCamera.bind(game.player);
    game.player.updateCamera = (...args) => { firstPersonUpdates++; return updateCamera(...args); };
    // Attempt real pointer lock before using the repository's headless input path.
    game.input.fallback = false;
    game.input._requestFullscreen = () => {};
    window.readCamera = () => {
      const row = game.spectator.candidates.find(row => row.id === game.spectator.targetId)?.row || self;
      const p = game.camera.position;
      return { position: p.toArray(), quaternion: game.camera.quaternion.toArray(),
        distance: Math.hypot(p.x - row.x, p.y - row.y - 1.35, p.z - row.z),
        target: game.spectator.targetId, firstPersonUpdates, alive: game.player.alive,
        yaw: game.player.view.yaw, pitch: game.player.view.pitch,
        viewmodel: game.rig.root.visible, ownBody: game.ownBody.group.visible,
        spectatorEnabled: game.input._spectatorEnabled, gameplayEnabled: game.session.gameplayInputEnabled,
        locked: document.pointerLockElement === game.input.canvas, fov: game.camera.fov };
    };
    return { target: game.spectator.targetId, alive: game.player.alive };
  })()`);
  assert.equal(initial.alive, false);
  const lockAttempt = await page.evaluate(`(async () => {
    testGame.hud.closeSettings();
    testGame.session.syncGameplayInput();
    try {
      await testGame.input.canvas.requestPointerLock();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { success: document.pointerLockElement === testGame.input.canvas };
    } catch (error) { return { success: false, error: String(error) }; }
  })()`);
  const pointerLockAvailable = lockAttempt.success;
  if (!pointerLockAvailable) {
    console.log('Browser pointer lock unavailable; testing the headless mouse path:', lockAttempt.error || 'lock released');
    await page.evaluate(`testGame.input.fallback = true; testGame.hud.closeSettings(); testGame.session.syncGameplayInput()`);
  }
  await page.waitFor(`!testGame.rig.root.visible && !testGame.ownBody.group.visible`);
  const before = await page.evaluate('readCamera()');
  assert.ok(before.distance > 0.4, JSON.stringify(before));
  assert.equal(before.firstPersonUpdates, 0);
  assert.equal(before.gameplayEnabled, false);
  assert.equal(before.spectatorEnabled, true);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 280 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 560, y: 360 });
  await page.waitFor(`JSON.stringify(readCamera().quaternion) !== ${JSON.stringify(JSON.stringify(before.quaternion))}`);
  const after = await page.evaluate('readCamera()');
  assert.equal(after.yaw, before.yaw, 'mouse orbit does not change dead-player aim');
  assert.equal(after.pitch, before.pitch, 'mouse orbit does not change dead-player pitch');
  assert.equal(after.firstPersonUpdates, 0, 'the first-person camera never runs while spectating');
  assert.ok(after.distance > 0.4, JSON.stringify(after));

  await mkdir('.artifacts/spectator', { recursive: true });
  for (const [name, width, height] of [['desktop', 1280, 720], ['mobile', 390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/spectator/${name}.png`, Buffer.from(shot.data, 'base64'));
    const state = await page.evaluate('readCamera()');
    assert.equal(state.viewmodel, false);
    assert.equal(state.firstPersonUpdates, 0);
  }

  await page.evaluate(`testGame.spectator.cycle(1)`);
  await page.waitFor(`readCamera().target !== ${JSON.stringify(before.target)} && testGame.spectator._cameraSeeded`);
  const cycled = await page.evaluate('readCamera()');
  assert.ok(cycled.distance > 0.4 && cycled.distance <= 4.600001, JSON.stringify(cycled));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`testGame.hud.settingsOpen && !testGame.input._spectatorEnabled`);
  await page.evaluate(`testGame.session.resumeFromSettings()`);
  await page.waitFor(`testGame.input._spectatorEnabled && !testGame.hud.settingsOpen`);
  if (pointerLockAvailable) await page.waitFor(`document.pointerLockElement === testGame.input.canvas`);
  await page.evaluate(`(() => {
    snapshot.players = snapshot.players.filter(row => row.id === testGame.myId);
    snapshot.snapSeq++;
    testGame.consumeAuthoritativeSnapshot(snapshot);
  })()`);
  await page.waitFor(`testGame.spectator.targetId === null`);
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`);
  const empty = await page.evaluate('readCamera()');
  assert.equal(empty.firstPersonUpdates, 0, 'no living targets never restores first-person camera');
  assert.ok(empty.distance > 0.4, JSON.stringify(empty));
  await page.evaluate(`(() => {
    const self = snapshot.players[0];
    self.state = 'alive'; self.hp = 100;
    snapshot.snapSeq++;
    testGame.consumeAuthoritativeSnapshot(snapshot);
  })()`);
  await page.waitFor(`testGame.player.alive && !testGame.spectator.active && firstPersonUpdates > 0`);
  assert.equal(await page.evaluate('testGame.input._spectatorEnabled'), false);
  assert.deepEqual(page.errors, []);
  console.log('Spectator browser passed: running game, mouse orbit, isolated dead-player aim, desktop/mobile renders, cycling, pause/resume, empty targets and respawn.');
  console.log(JSON.stringify({ pointerLockAvailable, before, after, cycled, empty }));
} finally {
  await browser?.close();
  await stopServer(server);
}
