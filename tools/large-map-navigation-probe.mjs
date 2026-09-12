import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(process.env.VB_PROBE_ROOT || '.');
const moduleAt = file => import(pathToFileURL(path.join(root, file)));
const [{ GameEngine }, { attachBots }, { createMapState }, { mulberry32 }] = await Promise.all([
  moduleAt('server/game.js'), moduleAt('server/bots.js'), moduleAt('shared/worlddata.js'), moduleAt('shared/noise.js'),
]);
const seconds = Number(process.env.VB_PROBE_SECONDS || 60);
const output = [];
const originalRandom = Math.random;
for (const map of ['harbor', 'canyon']) for (const kind of ['tdm', 'site-a', 'site-b']) {
  Math.random = mulberry32(12345);
  const world = createMapState(map), geometry = createHash('sha256').update(world.serializeWorld()).digest('hex');
  const start = performance.now();
  const events = { shots: 0, kills: 0 };
  const game = new GameEngine({ world, mode: 'tdm', broadcast(frame) {
    for (const event of frame.events) {
      if (event.kind === 'shoot') events.shots++;
      if (event.kind === 'kill') events.kills++;
    }
  } });
  game.now = 1000;
  let target;
  if (kind !== 'tdm') {
    const site = world.meta.sites[kind === 'site-a' ? 0 : 1];
    target = { x: (site.minX + site.maxX) / 2, y: site.y, z: (site.minZ + site.maxZ) / 2 };
    game.mode.canFire = () => false;
    game.mode.botGoal = () => ({ kind: 'defend', target, interact: false });
  }
  game.addClient('human', 'Probe');
  const bots = attachBots(game, 31);
  const tracks = new Map([...game.entities].filter(([, player]) => player.bot).map(([id, player]) => [id, { initial: { x: player.x, z: player.z }, last: { x: player.x, z: player.z },
    distance: 0, fightingTicks: 0, visited: new Set(), reached: false, windows: [], window: { x: player.x, z: player.z, distance: 0 } }]));
  for (let tick = 0; tick < seconds * 20; tick++) {
    game.step(50);
    for (const brain of bots.brains) {
      const player = game.entities.get(brain.id), track = tracks.get(brain.id);
      const moved = Math.hypot(player.x - track.last.x, player.z - track.last.z);
      if (moved < 5) { track.distance += moved; track.window.distance += moved; }
      track.last = { x: player.x, z: player.z };
      track.visited.add(`${Math.floor(player.x / 4)},${Math.floor(player.z / 4)}`);
      if (brain.state === 'fight') track.fightingTicks++;
      if (target && Math.hypot(player.x - target.x, player.z - target.z) < 4.2) track.reached = true;
      if ((tick + 1) % 100 === 0) {
        track.windows.push({ distance: track.window.distance,
          displacement: Math.hypot(player.x - track.window.x, player.z - track.window.z), fighting: brain.state === 'fight' });
        track.window = { x: player.x, z: player.z, distance: 0 };
      }
    }
  }
  const rows = [...tracks].map(([id, track]) => ({ id, distance: +track.distance.toFixed(1), cells: track.visited.size,
    fightSeconds: +(track.fightingTicks / 20).toFixed(1), reached: track.reached,
    circlingWindows: track.windows.filter(window => !window.fighting && window.distance > 6 && window.displacement < 2).length,
    stalledWindows: track.windows.filter(window => !window.fighting && window.distance < 1 && !track.reached).length,
    x: +track.last.x.toFixed(2), z: +track.last.z.toFixed(2) }));
  const result = { map, kind, seconds, geometry, elapsedMs: Math.round(performance.now() - start), ...events,
    players: game.entities.size, bots: rows.length,
    reached: rows.filter(row => row.reached).length, engagingBots: rows.filter(row => row.fightSeconds > 1).length,
    circlingWindows: rows.reduce((sum, row) => sum + row.circlingWindows, 0),
    stalledWindows: rows.reduce((sum, row) => sum + row.stalledWindows, 0),
    meanVisitedCells: +(rows.reduce((sum, row) => sum + row.cells, 0) / rows.length).toFixed(1), rows };
  output.push(result);
  console.error(JSON.stringify({ ...result, rows: undefined }));
  bots.dispose(); game.stop();
}
Math.random = originalRandom;
console.log(JSON.stringify(output, null, 2));
