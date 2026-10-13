// Titanfall client lifecycle (docs/titanfall.md §8.1, §13 "Client cleanup"):
//   - lazy loading: no module of public/js/titanfall/ is in the static import graph of the boot
//     page or the match runtime, so other modes never download or parse it; vehicle-view.js and
//     projectiles.js know it only through their install hooks
//   - the hooks: without the titanfall client a titan row is not presented and no projectile view
//     is installed; titan-presentation.js installs both on evaluation, create() installs them and
//     dispose() removes them again
//   - leaving titanfall: dispose() removes the titan hulls from VehicleView first, then frees the
//     titan part geometry cache, the titan blueprints and the warm-up group; a second titanfall
//     match builds its titans again; other vehicle types keep their caches
//   - the loadout screen hides the stock spectator/respawn overlay and the death note while the
//     player is held for DEPLOY (staged at join, dead, queued), as Conquest's deploy screen does
//   - warm-up preparation: the portrait kit links once and is freed with the UI; the hidden
//     pilot-weapon warm-up models live only in the browser path (prepare)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); };

// ---- static graph -----------------------------------------------------------------------------
const IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const fileFor = url => (url.startsWith('/shared/') ? path.join(ROOT, url) : path.join(ROOT, 'public', url));
function staticGraph(entries) {
  const seen = new Map();
  const visit = (url, from) => {
    if (seen.has(url)) return;
    seen.set(url, from);
    let source;
    try { source = readFileSync(fileFor(url), 'utf8'); } catch { return; }
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(url), spec)), url);
    }
  };
  for (const entry of entries) visit(entry, null);
  return seen;
}

await check('lazy loading: no titanfall module in the static boot or match-runtime graph', () => {
  const graph = staticGraph(['/js/boot.js', '/js/main.js', '/js/boot/match-runtime.js']);
  assert.ok(graph.has('/js/engine/vehicle-view.js') && graph.has('/js/weapons/projectiles.js'), 'the graph reaches the hooked modules');
  const titanfall = [...graph].filter(([url]) => url.startsWith('/js/titanfall/')).map(([url, from]) => `${url} <- ${from}`);
  assert.deepEqual(titanfall, [], 'static titanfall imports');
  const runtime = readFileSync(path.join(ROOT, 'public/js/boot/match-runtime.js'), 'utf8');
  assert.match(runtime, /import\(\s*['"]\.\.\/titanfall\/titanfall-client\.js['"]\s*\)/, 'match-runtime keeps the dynamic loader');
  for (const file of ['public/js/engine/vehicle-view.js', 'public/js/weapons/projectiles.js']) {
    assert.doesNotMatch(readFileSync(path.join(ROOT, file), 'utf8'), /from\s+['"][^'"]*\/titanfall\//, `${file} has no titanfall import`);
  }
});

// ---- hooks before the titanfall client --------------------------------------------------------
const dom = installFakeDom({ width: 1280, height: 720 });
const THREE = await import('../public/js/vendor/three.module.js');
const vehicleView = await import('../public/js/engine/vehicle-view.js');
const projectiles = await import('../public/js/weapons/projectiles.js');
const assemble = await import('../public/js/vehicles/voxel-model/assemble.js');
const common = await import('../public/js/vehicles/models/common.js');
const titanRow = (id = 't1', type = 'titan_ion') => ({ id, type, team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, hp: 100 });
const jeepRow = { id: 'j1', type: 'jeep', team: 'alpha', x: 6, y: 10, z: 0, yaw: 0, hp: 100 };

await check('hooks: other modes run without titanfall code (titan rows skipped, no projectile views)', () => {
  assert.equal(vehicleView.walkerPresentationInstalled(), false);
  const previous = projectiles.setModeProjectileViews(null);
  assert.equal(previous, null, 'no projectile views installed');
  const view = new vehicleView.VehicleView({ getBlock: () => 0 });
  view.sync([titanRow(), jeepRow], [], { id: 'me', team: 'alpha' });
  assert.deepEqual([...view.items.keys()], ['j1'], 'the jeep is presented, the titan row is not');
  assert.throws(() => vehicleView.VEHICLE_MODEL_FACTORIES.titan_ion({ team: 'alpha' }), /no walker presentation/);
  view.dispose();
});

const baseGeometry = assemble.vehicleGeometryCacheSize();
const baseBlueprints = common.blueprintCount();
const titanfallClient = await import('../public/js/titanfall/titanfall-client.js');
const presentation = await import('../public/js/titanfall/titan-presentation.js');
const loadout = await import('../public/js/titanfall/titan-loadout.js');

await check('hooks: evaluating the titanfall client installs the walker presentation and the projectile views', () => {
  assert.equal(vehicleView.walkerPresentationInstalled(), true);
  const views = projectiles.setModeProjectileViews(null);
  assert.ok(views?.has('archer') && views.has('t203') && !views.has('rocket'), 'titanfall views only');
  projectiles.setModeProjectileViews(views);
  presentation.uninstall();
  assert.equal(vehicleView.walkerPresentationInstalled(), false, 'uninstall');
  assert.equal(projectiles.setModeProjectileViews(null), null, 'uninstall drops the views');
});

const makeApp = () => {
  const spectator = { calls: [], setSuppressed(on) { this.calls.push(!!on); } };
  return {
    myId: 'me', net: { on: () => () => {}, sendTitanfall: () => true }, vehicleView: new vehicleView.VehicleView({ getBlock: () => 0 }),
    liveAvatarsGroup: new THREE.Group(), liveEffectsGroup: new THREE.Group(), hud: { spectator },
    roster: { setPresentation() {} }, session: { gameplayInputEnabled: true, setOverlayBlock() {}, restoreGameplayFocus() {} },
    input: { exit() {}, requestLock() {} }, matchState: { phase: 'live' },
  };
};

await check('lifecycle: create installs, dispose removes the hulls, uninstalls and frees the titan caches', () => {
  for (const round of [1, 2]) {
    const app = makeApp();
    const client = titanfallClient.create(app);
    assert.equal(vehicleView.walkerPresentationInstalled(), true, `round ${round}: installed by create`);
    app.vehicleView.sync([titanRow(), jeepRow], [], { id: 'me', team: 'alpha' });
    assert.deepEqual([...app.vehicleView.items.keys()].sort(), ['j1', 't1'], `round ${round}: titan and jeep presented`);
    app.vehicleView.update(1 / 60, null);
    assert.ok(assemble.vehicleGeometryCacheSize() > baseGeometry + 5 && common.blueprintCount() > baseBlueprints, `round ${round}: titan geometry cached`);
    const nonTitan = assemble.vehicleGeometryCacheSize();
    let disposedTitanGeometry = 0;
    app.vehicleView.items.get('t1').root.traverse(node => {
      if (node.geometry?.userData?.cached) node.geometry.addEventListener('dispose', () => { disposedTitanGeometry++; });
    });
    client.dispose();
    assert.equal(vehicleView.walkerPresentationInstalled(), false, `round ${round}: uninstalled by dispose`);
    assert.equal(projectiles.setModeProjectileViews(null), null, `round ${round}: no projectile views after dispose`);
    assert.deepEqual([...app.vehicleView.items.keys()], ['j1'], `round ${round}: the titan hull left VehicleView before its geometry went`);
    assert.ok(disposedTitanGeometry > 0, `round ${round}: the cached titan geometry was disposed`);
    assert.ok(assemble.vehicleGeometryCacheSize() < nonTitan, `round ${round}: titan entries dropped from the geometry cache`);
    assert.ok(common.blueprintCount() <= baseBlueprints + 1, `round ${round}: titan blueprints forgotten (the jeep's stays)`);
    app.vehicleView.dispose();
  }
});

await check('deploy cover: the stock spectator overlay and death note hide while held for DEPLOY', async () => {
  const contract = await import('../shared/titan-contract.js');
  const { titanfallHudFixtures, FIXTURE_NOW, pilotRow } = await import('../public/js/capture/titanfall-hud-fixtures.js');
  const ui = await import('../public/js/titanfall/titan-ui.js');
  const base = titanfallHudFixtures().find(f => f.id === 'pilot-ready');
  const DF = contract.TITANFALL_PLAYER_FLAGS;
  const app = makeApp();
  let current = { ...base, self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW - 50, tf: { flags: DF.deploy | DF.staged } }) };
  const client = { snapshot: () => current.snapshot, selfRow: () => current.self, selfTf: () => contract.decodeTitanfallPlayer(current.self),
    selfFrame: () => contract.decodeTitanfallSelf(current.tfs) };
  const step = () => { ui.tick(current.snapshot, 0); ui.frame(1 / 60, { nowMs: FIXTURE_NOW }); };
  const spectator = app.hud.spectator;
  ui.init(app, client);
  step();
  assert.equal(ui.debugState().loadoutOpen, true, 'staged: the loadout is open');
  assert.equal(spectator.calls.at(-1), true, 'staged: spectator overlay suppressed');
  assert.equal(document.body.dataset.titanfallDeploy, '', 'staged: death note hidden through titanfall.css');
  current = base;
  step();
  assert.equal(spectator.calls.at(-1), false, 'alive: overlay released');
  assert.equal(document.body.dataset.titanfallDeploy, undefined);
  current = { ...base, self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW + 2500, tf: { flags: DF.deploy } }) };
  step();
  assert.equal(spectator.calls.at(-1), true, 'death: suppressed behind the loadout');
  current = { ...base, self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW + 2500, tf: { flags: DF.deploy | DF.deployQueued } }) };
  step();
  assert.equal(spectator.calls.at(-1), true, 'queued DEPLOY: still suppressed (the titanfall dead panel counts down)');
  current = { ...current, snapshot: { ...base.snapshot, match: { ...base.snapshot.match, phase: 'post' } } };
  step();
  assert.equal(spectator.calls.at(-1), false, 'match end: the stock overlays return');
  current = { ...base, self: pilotRow({ state: 'dead', hp: 0, respawnAt: FIXTURE_NOW + 2500, tf: { flags: DF.deploy } }) };
  step();
  assert.equal(spectator.calls.at(-1), true);
  ui.dispose();
  assert.equal(spectator.calls.at(-1), false, 'dispose releases the overlay');
  assert.equal(document.body.dataset.titanfallDeploy, undefined, 'dispose clears the attribute');
  const css = readFileSync(path.join(ROOT, 'public/styles/titanfall.css'), 'utf8');
  assert.match(css, /body\[data-titanfall-deploy\] :is\(#deathnote, #deathrecap\) \{ visibility: hidden !important; \}/);
  app.vehicleView.dispose();
});

await check('warm-up: the portrait kit and pilot-weapon warm-up are prepared and released', async () => {
  assert.equal(typeof loadout.warmTitanPortraits, 'function');
  assert.equal(typeof loadout.disposeTitanPortraits, 'function');
  loadout.disposeTitanPortraits();   // idempotent without a kit
  const pilot = await import('../public/js/titanfall/pilot-client.js');
  const { WEAPON_IDS } = await import('../shared/combatmath.js');
  assert.ok(pilot.PILOT_WARMUP_WEAPONS.length >= 10 && pilot.PILOT_WARMUP_WEAPONS.every(id => WEAPON_IDS.includes(id)), 'every pilot weapon is a real id');
  for (const id of ['chargerifle', 'archer', 'thunderbolt', 'mgl', 'kraber']) assert.ok(pilot.PILOT_WARMUP_WEAPONS.includes(id), `${id} warmed`);
  const titanfallMain = readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
  assert.ok(titanfallMain.indexOf('this.titanfall.prepare?.()') > titanfallMain.indexOf('titanfallClient.create(this)')
    && titanfallMain.indexOf('this.titanfall.prepare?.()') < titanfallMain.indexOf('rt.warmShaders('), 'main.js awaits prepare() before warmShaders');
});

dom.restore();
console.log(`Titanfall client lifecycle: ${checks.length} checks passed (lazy graph, install hooks, create/dispose cache release, deploy cover, warm-up prep).`);
