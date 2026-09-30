import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'vb-grenade-launcher-'));
const outputRoot = path.resolve('docs/design/grenade-launcher');
const server = startServer({ cwd: process.cwd(),
  env: { VB_DATA_DIR: dataDir, VB_PERSISTENCE: 'file' } });
let browser;

const viewports = [
  { name: 'desktop', width: 1280, height: 720,
    states: ['held', 'scoped', 'firing', 'reload-open', 'reload-eject', 'reload-load',
      'reload-charge', 'mgl-flight', 'mgl-bounce', 'mgl-blast'] },
  { name: 'mobile', width: 390, height: 844,
    states: ['held', 'scoped', 'firing', 'reload-open', 'reload-eject', 'reload-load',
      'reload-charge', 'mgl-flight', 'mgl-bounce', 'mgl-blast'] },
  { name: 'landscape', width: 844, height: 390,
    states: ['held', 'scoped', 'firing', 'reload-open', 'reload-eject', 'reload-load',
      'reload-charge'] },
];

try {
  const base = `http://127.0.0.1:${await server.port}`;
  browser = await launchCdpSession(`${base}/weapon-capture.html?weapon=mgl&state=held&ammo=3`,
    { width: 1280, height: 720 });
  const page = browser.page;
  const checks = { captures: {}, dynamic: null };

  async function capture(viewport, state, ammo = 3, suffix = '') {
    const name = `${state.startsWith('mgl-') ? state : `mgl-${state}`}${suffix}`;
    const dir = path.join(outputRoot, `after-${viewport.name}`);
    await mkdir(dir, { recursive: true });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.name === 'mobile',
    });
    const url = `${base}/weapon-capture.html?weapon=mgl&state=${state}&ammo=${ammo}`;
    await page.send('Page.navigate', { url });
    await page.waitFor(`location.href === ${JSON.stringify(url)} &&
      document.documentElement.dataset.captureReady === 'true' &&
      window.__vbWeaponCapture?.state === ${JSON.stringify(state)} &&
      window.__vbWeaponCapture?.ammo === ${ammo}`,
    { timeoutMs: 30000, label: `${viewport.name}/${name}` });
    const metrics = await page.evaluate('window.__vbWeaponCapture');
    assert.equal(metrics.weapon, 'mgl');
    assert.equal(metrics.modelAsset, 'skipjack');
    assert.equal(metrics.modelFinite, true, `${name}: finite model transforms`);
    assert.equal(metrics.reserveSlots, 3);
    const expectedReserve = state === 'reload-charge' ? 2 : Math.max(0, ammo - 1);
    assert.equal(metrics.visibleReserve, expectedReserve,
      `${name}: reserve follows authoritative magazine including chambered round`);
    assert.ok(metrics.modelStructure.originalOliveParts > 0,
      `${name}: legacy olive receiver is present for the hide regression`);
    assert.equal(metrics.modelStructure.visibleOriginalOliveParts, 0,
      `${name}: legacy olive receiver is hidden`);
    for (const key of ['rearArmor', 'rearReceiver', 'upperStockRail']) {
      assert.equal(metrics.modelStructure[key], true, `${name}: new chassis ${key}`);
    }
    if (state === 'mgl-flight') {
      assert.equal(metrics.fx.projectiles, 1);
      assert.ok(metrics.fx.trails > 0, 'flight has an active shell ribbon');
    }
    if (state === 'mgl-bounce') {
      assert.ok(metrics.fx.bounces > 0, 'real voxel contact produces a bounce');
      assert.ok(metrics.fx.particles > 0, 'real bounce spawns impact sparks');
    }
    if (state === 'mgl-blast') {
      assert.equal(metrics.fx.projectiles, 0, 'authority explosion removes the shell');
      assert.ok(metrics.fx.blasts > 0, 'authority explosion drives pooled blast');
    }
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(screenshot.data, 'base64');
    assert.ok(bytes.length > 10_000, `${name}: screenshot should contain real rendering`);
    await writeFile(path.join(dir, `${name}.png`), bytes);
    checks.captures[`${viewport.name}/${name}`] = { bytes: bytes.length,
      reserve: metrics.visibleReserve, fx: metrics.fx };
  }

  if (process.env.MGL_LIVE_ONLY !== '1') {
    for (const viewport of viewports) {
      for (const state of viewport.states) {
        const ammo = state === 'reload-charge' ? 0 : 3;
        await capture(viewport, state, ammo);
      }
    }
    for (const ammo of [2, 0]) {
      await capture(viewports[0], 'held', ammo, `-ammo-${ammo}`);
    }

  // Exercise the same ViewmodelRig and Effects classes that the live game uses.
  // Static stills alone cannot catch an open cassette left behind after reload.
    checks.dynamic = await page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
    const { Effects } = await import('/js/weapons/effects.js');
    const rig = new ViewmodelRig(new THREE.PerspectiveCamera());
    rig.setWeapon('mgl');
    const skipjack = rig._models.mgl.extra.userData.skipjack;
    const pose = { speed: 0, vaulting: false, grounded: true, aimSwayScale: 0 };
    const run = (frames) => { for (let i = 0; i < frames; i++) rig.update(0.01, pose); };
    const finite = () => {
      rig._models.mgl.root.updateMatrixWorld(true);
      let okay = true;
      rig._models.mgl.root.traverse((part) => {
        if (!part.matrixWorld.elements.every(Number.isFinite)) okay = false;
      });
      return okay;
    };
    rig.setSkipjack({ mag: 2, magSize: 3 });
    const before = skipjack.rounds.filter((round) => round.visible).length;
    rig.reload(1, 'magswap');
    run(110);
    const completed = skipjack.cassette.visible &&
      skipjack.cassette.position.distanceTo(skipjack.cassette.userData.homePosition) < 1e-6 &&
      Math.abs(skipjack.cassette.rotation.y) < 1e-6 && skipjack.reload === null && finite();
    rig.setSkipjack({ mag: 3, magSize: 3 });
    rig.reload(1, 'magswap');
    run(40);
    rig.setSkipjack({ mag: 1, magSize: 3 });
    const cancelled = rig.cancelReload() && skipjack.cassette.visible &&
      skipjack.cassette.position.distanceTo(skipjack.cassette.userData.homePosition) < 1e-6 &&
      Math.abs(skipjack.cassette.rotation.y) < 1e-6 &&
      skipjack.rounds.filter((round) => round.visible).length === 0 && finite();
    rig.setWeapon('rifle');
    rig.setWeapon('mgl');
    rig.setSkipjack({ mag: 3, magSize: 3 });
    run(100);
    const shotSamples = [];
    const fireFirst = rig.fire();
    for (let i = 0; i < 55; i++) {
      rig.update(0.01, pose);
      shotSamples.push({ feed: skipjack.feed.rotation.z,
        bolt: rig._models.mgl.bolt.position.z });
    }
    const firstFeed = skipjack.feed.rotation.z;
    const fireSecond = rig.fire();
    for (let i = 0; i < 55; i++) {
      rig.update(0.01, pose);
      shotSamples.push({ feed: skipjack.feed.rotation.z,
        bolt: rig._models.mgl.bolt.position.z });
    }
    const maxFeedStep = Math.max(...shotSamples.slice(1).map((row, i) =>
      Math.abs(row.feed - shotSamples[i].feed)));
    const maxBoltStep = Math.max(...shotSamples.slice(1).map((row, i) =>
      Math.abs(row.bolt - shotSamples[i].bolt)));
    const shotRecovery = fireFirst && fireSecond && firstFeed > 0.8 &&
      skipjack.feed.rotation.z > firstFeed + 0.8 &&
      shotSamples.some((row) => Math.abs(row.bolt) > 0.005) &&
      maxFeedStep < 0.35 && maxBoltStep < 0.04 &&
      Math.abs(rig._models.mgl.bolt.position.z) < 1e-6 && finite();
    rig.dispose();

    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    const fx = new Effects(scene, camera, () => 0);
    let maxTrails = 0;
    for (let i = 0; i < 24; i++) {
      const pid = 'stress-' + i;
      fx.projectileLaunch({ pid, type: 'mgl', o: [0, 1.6, -2], v: [0, 0, -32] });
      fx.update(1 / 60);
      maxTrails = Math.max(maxTrails, fx.projectiles._mglTrailCount);
      fx.projectileExplode({ pid, type: 'mgl', x: 0, y: 1.4, z: -6, radius: 4.5 });
    }
    for (let i = 0; i < 180; i++) fx.update(1 / 60);
    const bounded = fx.projectiles.projectiles.size === 0 &&
      fx.projectiles._mglTrailCount === 0 && fx.projectiles.blasts.length === 0;
    fx.dispose();
    return { before, completed, cancelled, shotRecovery, maxFeedStep,
      maxBoltStep, maxTrails, bounded, disposed: fx._disposed };
  })()`);
    assert.equal(checks.dynamic.before, 1, 'mag 2 has one visible reserve shell');
    assert.equal(checks.dynamic.completed, true, 'reload completes with finite seated cassette');
    assert.equal(checks.dynamic.cancelled, true, 'cancel restores authoritative shell count and pose');
    assert.equal(checks.dynamic.shotRecovery, true,
      'two shots at the 115 RPM cadence advance and settle the feed without a pose jump');
    assert.ok(checks.dynamic.maxTrails > 0, 'stress test exercised shell trails');
    assert.equal(checks.dynamic.bounded, true, 'shell trails and blasts retire after repeated shots');
    assert.equal(checks.dynamic.disposed, true, 'production Effects facade disposes its pools');
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
  }

  // Enter the real Killhouse training session, then press its visible touch
  // FIRE control. Read the server tick rather than trusting local recoil.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__mglWire = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const message = JSON.parse(event.data);
            if (message.t !== 'tick') return;
            const ownId = window.__vb?.stats?.localId;
            const self = message.players?.find((row) => row.id === ownId);
            window.__mglWire.push({ mag: self?.mag?.[14] ?? null,
              launches: (message.events || []).filter((row) =>
                row.kind === 'projectileLaunch' && row.type === 'mgl').length });
            if (window.__mglWire.length > 300) window.__mglWire.shift();
          } catch {}
        });
      }
    };
  ` });
  const liveUrl = `${base}/?debug=1&headless=1&touch=1&weapon=mgl`;
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  await page.send('Page.navigate', { url: liveUrl });
  await page.waitFor(`location.href === ${JSON.stringify(liveUrl)} &&
    document.getElementById('training-btn')?.disabled === false`,
  { timeoutMs: 120000, label: 'Killhouse training assets and menu' });
  await page.evaluate(`document.getElementById('training-btn').click()`);
  await page.waitFor(`window.__vb?.stats.running && window.__vb.stats.alive &&
    window.__vb.stats.weapon === 'mgl' && window.__vb.stats.lastSnapAgeMs < 1000 &&
    !window.__vb.stats.settingsOpen &&
    document.getElementById('touch-fire')?.getBoundingClientRect().width > 0 &&
    window.__mglWire?.some((row) => Number.isInteger(row.mag))`,
  { timeoutMs: 45000, label: 'authoritative Killhouse MGL session' });
  const liveDir = path.join(outputRoot, 'after-desktop');
  const liveShot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(liveDir, 'mgl-killhouse-live.png'),
    Buffer.from(liveShot.data, 'base64'));
  const liveBefore = await page.evaluate(`({
    mag: window.__mglWire.filter((row) => Number.isInteger(row.mag)).at(-1)?.mag,
    weapon: window.__vb.stats.weapon, map: document.getElementById('match-map-chip')?.textContent,
    running: window.__vb.stats.running,
  })`);
  assert.equal(liveBefore.weapon, 'mgl');
  assert.ok(liveBefore.mag > 0, 'server reports a loaded launcher');
  await page.waitFor(`window.__vb.stats.spawnProtected === false`,
    { timeoutMs: 15000, label: 'spawn protection clears before the live shot' });
  // Dispatch to the actual touch control listener. CDP's emulated finger also
  // synthesizes compatibility mouse events, which can release the shared fire
  // hold in the baseline input implementation before a rendered frame sees it.
  const firePointer = 9381;
  await page.evaluate(`(() => {
    const fire = document.getElementById('touch-fire');
    const rect = fire.getBoundingClientRect();
    fire.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerType: 'touch', pointerId: ${firePointer},
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  })()`);
  try {
    await page.waitFor(`window.__mglWire.some((row) => row.mag !== null &&
      row.mag < ${liveBefore.mag}) && window.__mglWire.some((row) => row.launches > 0)`,
    { timeoutMs: 15000, label: 'server-confirmed MGL ammunition use and projectile launch' });
  } catch (error) {
    console.error('Live shot diagnostics:', await page.evaluate(`({
      stats: window.__vb?.stats, wire: window.__mglWire?.slice(-12),
      input: { activeElement: document.activeElement?.id,
        firePressed: document.getElementById('touch-fire')?.getAttribute('aria-pressed'),
        elementAtCenter: document.elementFromPoint(640, 360)?.id,
        settingsOpen: window.__vb?.stats?.settingsOpen },
    })`));
    throw error;
  } finally {
    await page.evaluate(`(() => {
      const fire = document.getElementById('touch-fire');
      fire.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerType: 'touch', pointerId: ${firePointer},
      }));
    })()`);
  }
  checks.live = { ...liveBefore,
    magAfter: await page.evaluate(`window.__mglWire.filter((row) => Number.isInteger(row.mag)).at(-1)?.mag`),
    confirmedLaunches: await page.evaluate(`window.__mglWire.reduce((sum, row) => sum + row.launches, 0)`),
  };
  assert.ok(checks.live.magAfter < checks.live.mag, 'server ammunition decreases after touch FIRE');
  assert.ok(checks.live.confirmedLaunches > 0, 'server publishes the MGL projectile');
  assert.equal(page.errors.length, 0, page.errors.join('\n'));
  checks.browserErrors = [...page.errors];
  checks.cleanupSuccessful = process.env.MGL_LIVE_ONLY === '1' ? null
    : checks.dynamic.bounded && checks.dynamic.disposed;

  await writeFile(path.join(outputRoot, 'browser-validation.json'),
    `${JSON.stringify(checks, null, 2)}\n`);
  console.log(`Grenade launcher browser QA passed: ${Object.keys(checks.captures).length} captures`);
} catch (error) {
  if (browser) console.error('Browser errors:', browser.page.errors);
  throw error;
} finally {
  await browser?.close();
  await stopServer(server);
  await rm(dataDir, { recursive: true, force: true });
}
