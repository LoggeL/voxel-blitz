import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'vb-grenade-launcher-'));
const outputRoot = path.resolve('docs/design/grenade-launcher/refinement');
const server = startServer({ cwd: process.cwd(),
  env: { VB_DATA_DIR: dataDir, VB_PERSISTENCE: 'file' } });
let browser;

const viewports = [
  { name: 'desktop', width: 1280, height: 720,
    states: ['held', 'scoped', 'firing', 'shot-lift', 'shot-slide', 'reload-open', 'reload-eject', 'reload-load',
      'reload-charge', 'reload-incoming', 'reload-lift', 'reload-slide', 'reload-seated',
      'mgl-flight', 'mgl-bounce', 'mgl-blast'] },
  { name: 'mobile', width: 390, height: 844,
    states: ['held', 'scoped', 'firing', 'shot-lift', 'shot-slide', 'reload-open', 'reload-eject', 'reload-load',
      'reload-charge', 'reload-incoming', 'reload-lift', 'reload-slide', 'reload-seated',
      'mgl-flight', 'mgl-bounce', 'mgl-blast'] },
  { name: 'landscape', width: 844, height: 390,
    states: ['held', 'scoped', 'firing', 'shot-lift', 'shot-slide', 'reload-open', 'reload-eject', 'reload-load',
      'reload-charge', 'reload-incoming', 'reload-lift', 'reload-slide', 'reload-seated'] },
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
    const emptyReloadReserve = {
      'reload-charge': 3, 'reload-incoming': 3, 'reload-lift': 3,
      'reload-slide': 3, 'reload-seated': 2,
    };
    const expectedReserve = emptyReloadReserve[state] ?? Math.max(0, ammo - 1);
    assert.equal(metrics.visibleReserve, expectedReserve,
      `${name}: reserve follows authoritative magazine including chambered round`);
    assert.ok(metrics.modelStructure.originalOliveParts > 0,
      `${name}: legacy olive receiver is present for the hide regression`);
    assert.equal(metrics.modelStructure.visibleOriginalOliveParts, 0,
      `${name}: legacy olive receiver is hidden`);
    for (const key of ['rearArmor', 'rearReceiver', 'upperStockRail', 'stockBridge']) {
      assert.equal(metrics.modelStructure[key], true, `${name}: new chassis ${key}`);
    }
    assert.ok(metrics.roundState?.every((round) => round.position.every(Number.isFinite)),
      `${name}: all shell transforms finite`);
    assert.ok(metrics.cassetteState?.position.every(Number.isFinite) &&
      metrics.cassetteState.rotation.slice(0, 3).every(Number.isFinite),
    `${name}: cassette transform finite`);
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
      reserve: metrics.visibleReserve, rounds: metrics.roundState,
      cassette: metrics.cassetteState, fx: metrics.fx };
  }

  if (process.env.MGL_LIVE_ONLY !== '1') {
    for (const viewport of viewports) {
      for (const state of viewport.states) {
        const ammo = Object.hasOwn({ 'reload-charge': true, 'reload-incoming': true,
          'reload-lift': true, 'reload-slide': true, 'reload-seated': true }, state)
          ? 0 : 3;
        await capture(viewport, state, ammo);
      }
    }
    for (const ammo of [2, 0]) {
      await capture(viewports[0], 'held', ammo, `-ammo-${ammo}`);
    }
    checks.inspection = {};
    for (const angle of ['hero', 'front', 'left', 'right', 'rear', 'top']) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
      });
      const url = `${base}/weapon-capture.html?weapon=mgl&state=held&ammo=3&angle=${angle}`;
      await page.send('Page.navigate', { url });
      await page.waitFor(`location.href === ${JSON.stringify(url)} &&
        document.documentElement.dataset.captureReady === 'true' &&
        window.__vbWeaponCapture?.angle === ${JSON.stringify(angle)}`,
      { timeoutMs: 30000, label: `MGL stock inspection ${angle}` });
      const inspection = await page.evaluate('window.__vbWeaponCapture');
      assert.equal(inspection.inspectionVisibleReserve, 2,
        `${angle}: isolated inspection model honors authoritative mag 3`);
      assert.ok(inspection.inspectionBounds.size.every((value) =>
        Number.isFinite(value) && value > 0), `${angle}: model bounds finite`);
      const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
      const bytes = Buffer.from(screenshot.data, 'base64');
      assert.ok(bytes.length > 10_000, `${angle}: inspection model rendered`);
      await writeFile(path.join(outputRoot, `after-angle-${angle}.png`), bytes);
      checks.inspection[angle] = { bytes: bytes.length,
        visibleReserve: inspection.inspectionVisibleReserve };
    }
    const key = (state) => checks.captures[`desktop/mgl-${state}`];
    assert.equal(key('reload-incoming').reserve, 3,
      'fresh cassette arrives with three physical shells');
    assert.equal(key('reload-seated').reserve, 2,
      'empty reload chambers one and leaves two visible in the cassette');
    const moved = (state, index) => Math.hypot(...key(state).rounds[index].position.map(
      (value, axis) => value - key('reload-incoming').rounds[index].position[axis]));
    assert.ok(moved('reload-lift', 0) > 0.005,
      'first new shell lifts out of the full cassette');
    assert.ok(moved('reload-slide', 0) > moved('reload-lift', 0) + 0.01,
      'the same shell travels forward into the chamber');
    const shotMoved = (state) => Math.hypot(...key(state).rounds[1].position.map(
      (value, axis) => value - key('held').rounds[1].position[axis]));
    assert.ok(shotMoved('shot-lift') > 0.01 &&
      shotMoved('shot-slide') > shotMoved('shot-lift') + 0.01,
    'a fired round physically advances the next reserve shell');

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
    rig.setSkipjack({ mag: 2, magSize: 3 });
    for (let i = 0; i < 55; i++) {
      rig.update(0.01, pose);
      shotSamples.push({ feed: skipjack.feed.rotation.z,
        bolt: rig._models.mgl.bolt.position.z,
        moving: skipjack.rounds[1].position.distanceTo(skipjack.rounds[1].userData.homePosition),
        nextRise: skipjack.rounds[2].position.y });
    }
    const afterFirst = skipjack.rounds.map((round) => Number(round.visible)).join('');
    const firstFeed = skipjack.feed.rotation.z;
    const fireSecond = rig.fire();
    rig.setSkipjack({ mag: 1, magSize: 3 });
    for (let i = 0; i < 55; i++) {
      rig.update(0.01, pose);
      shotSamples.push({ feed: skipjack.feed.rotation.z,
        bolt: rig._models.mgl.bolt.position.z,
        moving: skipjack.rounds[2].position.distanceTo(skipjack.rounds[2].userData.homePosition),
        nextRise: skipjack.rounds[2].position.y });
    }
    const afterSecond = skipjack.rounds.map((round) => Number(round.visible)).join('');
    const maxFeedStep = Math.max(...shotSamples.slice(1).map((row, i) =>
      Math.abs(row.feed - shotSamples[i].feed)));
    const maxBoltStep = Math.max(...shotSamples.slice(1).map((row, i) =>
      Math.abs(row.bolt - shotSamples[i].bolt)));
    const roundTravel = Math.max(...shotSamples.map((row) => row.moving));
    const shotRecovery = fireFirst && fireSecond && firstFeed > 0.8 &&
      skipjack.feed.rotation.z > firstFeed + 0.8 &&
      shotSamples.some((row) => Math.abs(row.bolt) > 0.005) &&
      roundTravel > 0.04 && afterFirst === '001' && afterSecond === '000' &&
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
    return { before, completed, cancelled, shotRecovery, afterFirst, afterSecond,
      roundTravel, maxFeedStep, maxBoltStep, maxTrails, bounded, disposed: fx._disposed };
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
    window.__mglEvents = { launches: [], explosions: [], blocks: [] };
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
            for (const event of message.events || []) {
              if (event.kind === 'projectileLaunch' && event.type === 'mgl' &&
                event.id === ownId) window.__mglEvents.launches.push(event);
              if (event.kind === 'projectileExplode' && event.type === 'mgl')
                window.__mglEvents.explosions.push(event);
              if (event.kind === 'block' && event.v === 0 && event.from > 0)
                window.__mglEvents.blocks.push(event);
            }
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
  await mkdir(liveDir, { recursive: true });
  const liveShot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(liveDir, 'mgl-killhouse-live.png'),
    Buffer.from(liveShot.data, 'base64'));
  // The full desktop frame is captured above. A smaller live viewport keeps
  // the headless software renderer responsive enough to drain event snapshots.
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 640, height: 360, deviceScaleFactor: 1, mobile: false,
  });
  const liveBefore = await page.evaluate(`({
    mag: window.__mglWire.filter((row) => Number.isInteger(row.mag)).at(-1)?.mag,
    weapon: window.__vb.stats.weapon, map: document.getElementById('match-map-chip')?.textContent,
    running: window.__vb.stats.running, feet: window.__vb.stats.feet,
    yaw: window.__vb.stats.yaw, pitch: window.__vb.stats.pitch,
  })`);
  assert.equal(liveBefore.weapon, 'mgl');
  assert.ok(liveBefore.mag > 0, 'server reports a loaded launcher');
  await page.waitFor(`window.__vb.stats.spawnProtected === false`,
    { timeoutMs: 15000, label: 'spawn protection clears before the live shot' });
  await page.evaluate(`(async () => {
    const world = await import('/shared/worlddata.js');
    window.__mglWorld = world;
    const feet = window.__vb.stats.feet;
    const limits = { x0: Math.max(0, Math.floor(feet.x) - 6),
      x1: Math.min(world.SX - 1, Math.floor(feet.x) + 6),
      y0: Math.max(1, Math.floor(feet.y) - 1),
      y1: Math.min(world.SY - 1, Math.floor(feet.y) + 9),
      z0: Math.max(0, Math.floor(feet.z) - 37),
      z1: Math.min(world.SZ - 1, Math.floor(feet.z) + 3) };
    window.__mglBlockRegion = limits;
    window.__mglCountBlocks = () => {
      let count = 0;
      for (let y = limits.y0; y <= limits.y1; y++)
        for (let z = limits.z0; z <= limits.z1; z++)
          for (let x = limits.x0; x <= limits.x1; x++)
          if (world.getBlock(x, y, z) !== world.AIR) count++;
      return count;
    };
    const { Effects } = await import('/js/weapons/effects.js');
    const original = Effects.prototype.explodeBlock;
    window.__mglDebris = { calls: 0, particles: 0, materials: [] };
    Effects.prototype.explodeBlock = function (...args) {
      const before = this.impacts.particlesSpawned;
      const result = original.apply(this, args);
      window.__mglDebris.calls++;
      window.__mglDebris.particles += this.impacts.particlesSpawned - before;
      window.__mglDebris.materials.push(args[3]);
      return result;
    };
  })()`);
  const blocksBefore = await page.evaluate('window.__mglCountBlocks()');
  // Dispatch to the actual touch control listener. CDP's emulated finger also
  // synthesizes compatibility mouse events, which can release the shared fire
  // hold in the baseline input implementation before a rendered frame sees it.
  let launched = false;
  try {
    for (let attempt = 0; attempt < 6 && !launched; attempt++) {
      const pointerId = 9381 + attempt;
      await page.evaluate(`(() => {
        const fire = document.getElementById('touch-fire');
        const rect = fire.getBoundingClientRect();
        fire.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerType: 'touch', pointerId: ${pointerId},
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        }));
      })()`);
      try {
        await page.waitFor(`window.__mglWire.some((row) => row.mag !== null &&
          row.mag < ${liveBefore.mag}) && window.__mglEvents.launches.length > 0`,
        { timeoutMs: 4500, label: `server-confirmed MGL shot attempt ${attempt + 1}` });
        launched = true;
      } catch (error) {
        if (attempt === 5) throw error;
      } finally {
        await page.evaluate(`(() => {
          const fire = document.getElementById('touch-fire');
          fire.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true, pointerType: 'touch', pointerId: ${pointerId},
          }));
        })()`);
      }
    }
  } catch (error) {
    console.error('Live shot diagnostics:', await page.evaluate(`({
      stats: window.__vb?.stats, wire: window.__mglWire?.slice(-12),
      events: window.__mglEvents,
      input: { activeElement: document.activeElement?.id,
        firePressed: document.getElementById('touch-fire')?.getAttribute('aria-pressed'),
        elementAtCenter: document.elementFromPoint(640, 360)?.id,
        settingsOpen: window.__vb?.stats?.settingsOpen },
    })`));
    throw error;
  }
  checks.live = { ...liveBefore,
    blocksBefore,
    magAfter: await page.evaluate(`window.__mglWire.filter((row) => Number.isInteger(row.mag)).at(-1)?.mag`),
    confirmedLaunches: await page.evaluate(`window.__mglWire.reduce((sum, row) => sum + row.launches, 0)`),
  };
  await page.waitFor(`window.__mglEvents.explosions.some((event) =>
    window.__mglEvents.launches.some((launch) => launch.pid === event.pid))`,
  { timeoutMs: 10000, label: 'server-confirmed MGL detonation' });
  try {
    await page.waitFor(`window.__mglEvents.blocks.length > 0 &&
      window.__mglDebris.calls > 0 &&
      window.__mglEvents.blocks.every((block) =>
        window.__mglWorld.getBlock(block.x, block.y, block.z) === window.__mglWorld.AIR)`,
    { timeoutMs: 20000, label: 'client applies authoritative block AIR and material debris' });
  } catch (error) {
    console.error('Client breach diagnostics:', await page.evaluate(`({
      blocks: window.__mglEvents.blocks.slice(0, 5),
      readback: window.__mglEvents.blocks.slice(0, 5).map((block) =>
        window.__mglWorld.getBlock(block.x, block.y, block.z)),
      debris: window.__mglDebris,
      explosions: window.__mglEvents.explosions,
      stats: { chunks: window.__vb.stats.chunks, lastSnapAgeMs: window.__vb.stats.lastSnapAgeMs },
    })`));
    throw error;
  }
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  const breachShot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(liveDir, 'mgl-killhouse-breach.png'),
    Buffer.from(breachShot.data, 'base64'));
  checks.live.destruction = await page.evaluate(`({
    blocksAfter: window.__mglCountBlocks(),
    blockRegion: window.__mglBlockRegion,
    ownLaunches: window.__mglEvents.launches,
    explosions: window.__mglEvents.explosions,
    removedBlocks: window.__mglEvents.blocks,
    localBlockReadback: window.__mglEvents.blocks.map((block) => ({
      x: block.x, y: block.y, z: block.z,
      value: window.__mglWorld.getBlock(block.x, block.y, block.z),
    })),
    debris: window.__mglDebris,
  })`);
  assert.ok(checks.live.destruction.removedBlocks.length > 0,
    'server removes destructible Killhouse voxels after an MGL blast');
  assert.ok(checks.live.destruction.removedBlocks.every((block) =>
    block.v === 0 && block.from > 0), 'block events retain source material');
  assert.ok(checks.live.destruction.localBlockReadback.every((block) => block.value === 0),
    'client world applies the authoritative AIR changes');
  const region = checks.live.destruction.blockRegion;
  const removedInRegion = checks.live.destruction.removedBlocks.filter((block) =>
    block.x >= region.x0 && block.x <= region.x1 &&
    block.y >= region.y0 && block.y <= region.y1 &&
    block.z >= region.z0 && block.z <= region.z1);
  if (removedInRegion.length) assert.ok(checks.live.destruction.blocksAfter < blocksBefore,
    'local Killhouse map loses solid blocks in the sampled breach region');
  assert.ok(checks.live.destruction.debris.calls > 0 &&
    checks.live.destruction.debris.particles > 0,
  'production block FX creates material-aware debris');
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
