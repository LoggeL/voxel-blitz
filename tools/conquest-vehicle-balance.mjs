// Vehicle pack balance report (docs/conquest.md "Vehicle balance"): the
// 2026-10-19 pack (TOW, GUIDED MSL, AT MINE, jet bombs, hijacking) against
// the counters it sits beside, measured headless through the authoritative
// server (tools/lib/vehicle-balance.mjs). Prints one table per section.
//
//   node tools/conquest-vehicle-balance.mjs                       # every section
//   node tools/conquest-vehicle-balance.mjs --only ttk,beam,mine,bomb
//   node tools/conquest-vehicle-balance.mjs --only match --seeds 1,2,3,4,5,6,7,8 --seconds 240
//   node tools/conquest-vehicle-balance.mjs --json out.json
//
// Sections: ttk (hits and seconds to kill per weapon and hull), beam (TOW and
// GUIDED MSL hit rates against moving hulls, ideal operator and bot gunner),
// mine (an AT mine under a driven hull), bomb (a two-bomb pass over a squad),
// match (seeded bot matches: shots, hits, kills, mines, hijacks).
import { writeFileSync } from 'node:fs';
import {
  BALANCE_WEAPONS, HULL_TYPES, SECTORS, damageRig, hitsToKill, meanTimeToKill, beamTrial, targetPath, mineTrial, bombSortie, matchStats,
} from './lib/vehicle-balance.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
const ONLY = new Set(option('only', 'ttk,beam,mine,bomb,match').split(','));
const RUNS = Number(option('runs', 200));
const SEEDS = option('seeds', '1,2,3,4').split(',').map(Number);
const SECONDS = Number(option('seconds', 180));
const report = {};
const fmt = (n, digits = 2) => Number.isFinite(n) ? +n.toFixed(digits) : '∞';

if (ONLY.has('ttk')) {
  // Hits to kill / to disable and seconds to kill (cadence only, every round a hit, no flight time).
  const rig = damageRig(), rows = [];
  for (const spec of Object.values(BALANCE_WEAPONS)) {
    const row = { weapon: spec.label };
    for (const type of HULL_TYPES) {
      for (const sector of type === 'tank' ? ['front', 'side', 'rear'] : ['side']) {
        const r = hitsToKill(spec, type, SECTORS[sector], { rig, runs: type === 'tank' ? RUNS : 40 });
        const key = type === 'tank' ? `tank ${sector}` : type;
        if (!r) { row[key] = '-'; continue; }
        if (r.kill >= 150) { row[key] = '∞'; continue; }
        const ttk = meanTimeToKill(spec, r.counts), onAmmo = r.counts.filter(n => Number.isFinite(meanTimeToKill(spec, [n]))).length / r.counts.length;
        row[key] = `${fmt(r.kill)} / ${fmt(r.disable)} · ${Number.isFinite(ttk) ? `${fmt(ttk, 1)} s` : `${Math.round(onAmmo * 100)}% on ammo`}`;
      }
    }
    rows.push(row);
  }
  console.log('Hits to kill / hits to disable · seconds to kill (one shooter, every round a hit; "x% on ammo" = runs the carried rounds finish)');
  console.table(rows);
  report.ttk = rows;
}

if (ONLY.has('beam')) {
  const cases = [
    ['ideal', 'jeep_at', 'tank', { speed: 0, range: 300 }],
    ['ideal', 'jeep_at', 'tank', { speed: 10, range: 120 }],
    ['ideal', 'jeep_at', 'tank', { speed: 10, range: 300 }],
    ['ideal', 'jeep_at', 'jeep', { speed: 15, range: 120 }],
    ['ideal', 'jeep_at', 'jeep', { speed: 20, range: 120 }],
    ['ideal', 'jeep_at', 'jeep', { kind: 'weave', speed: 18, range: 120, amplitude: 10, period: 4 }],
    ['ideal', 'jeep_at', 'helicopter', { speed: 25, range: 200 }, 30],
    ['ideal', 'helicopter', 'tank', { speed: 10, range: 300 }],
    ['ideal', 'helicopter', 'jeep', { speed: 15, range: 200 }],
    ['ideal', 'helicopter', 'jeep', { speed: 20, range: 300 }],
    ['ideal', 'helicopter', 'helicopter', { speed: 25, range: 250 }, 30],
    ['bot', 'jeep_at', 'tank', { speed: 0, range: 100 }],
    ['bot', 'jeep_at', 'tank', { speed: 8, range: 100 }],
    ['bot', 'jeep_at', 'jeep', { speed: 15, range: 100 }],
    ['bot', 'helicopter', 'tank', { speed: 0, range: 150 }],
    ['bot', 'helicopter', 'tank', { speed: 8, range: 200 }],
    ['bot', 'helicopter', 'jeep', { speed: 0, range: 200 }],
  ];
  const rows = [];
  for (const [operator, shooterType, targetType, path, height] of cases) {
    let hits = 0, settled = 0;
    for (const seed of [1, 2, 3]) {
      const r = beamTrial({ shooterType, targetType, operator, seconds: 60, targetHeight: height ?? 0, seed,
        path: targetPath({ kind: 'crossing', ...path, phase: seed * 1.7 }) });
      hits += r.hits; settled += r.settled;
    }
    rows.push({ operator, missile: shooterType === 'jeep_at' ? 'TOW' : 'GUIDED', target: targetType,
      motion: `${path.kind ?? 'crossing'} ${path.speed} m/s at ${path.range} m`, hits: `${hits}/${settled}`, 'hit %': Math.round(hits / Math.max(1, settled) * 100) });
  }
  console.log('Sight-guided missiles against moving hulls (3 seeds x 60 s; a hit takes 200+ HP)');
  console.table(rows);
  report.beam = rows;
}

if (ONLY.has('mine')) {
  const layouts = {
    tank: {
      'one, centre line': { mines: 1 },
      'one, under a track': { mines: 1, offset: 1.5 },
      'one, at the skirt': { mines: 1, offset: 2.05 },
      'pair on one spot': { mines: 2, spacing: 0 },
      'pair side by side 1.2 m': { mines: 2, spacing: 1.2, across: true, offset: -0.6 },
      'pair in line 3 m': { mines: 2, spacing: 3 },
    },
    jeep: {
      'one, centre line': { mines: 1 },
      'one, under a wheel': { mines: 1, offset: 0.9 },
      'one, beside the wheels': { mines: 1, offset: 1.6 },
    },
  };
  const rows = [];
  for (const type of ['tank', 'jeep']) for (const [layout, o] of Object.entries(layouts[type])) for (const speed of type === 'tank' ? [3, 13] : [8, 24]) {
    const r = mineTrial({ type, speed, ...o });
    rows.push({ hull: type, layout, speed, 'set off': r.detonated, 'HP lost': Math.round(r.lost), disabled: r.disabled, destroyed: r.destroyed, 'tracks broken': r.tracks });
  }
  console.log('AT mines under a driven hull (HP lost within 0.25 s of the blast)');
  console.table(rows);
  report.mine = rows;
}

if (ONLY.has('bomb')) {
  const rows = [];
  for (const [error, spread, react] of [[0, 6, 1.5], [0, 12, 1.5], [6, 8, 1.5], [12, 8, 1.5], [6, 8, 8]]) {
    let dead = 0, blast = 0, burn = 0;
    const runs = 8;
    for (let seed = 1; seed <= runs; seed++) {
      const r = bombSortie({ error, spread, react, squad: 4, seed });
      dead += r.dead; blast += r.kills.blast; burn += r.kills.burn;
    }
    rows.push({ 'stick off target (m)': error, 'squad within (m)': spread, 'stand (s)': react, 'dead of 4': fmt(dead / runs), blast: fmt(blast / runs), burn: fmt(burn / runs) });
  }
  console.log('One two-bomb pass (40 m/s, 60 m AGL, bombs 20 m apart) over a squad of four; survivors run out at 5.5 m/s');
  console.table(rows);
  report.bomb = rows;
}

if (ONLY.has('match')) {
  const sum = {}, extra = { hijacks: 0, hijackOpportunitySeconds: 0, minesLaid: 0, minesDetonated: 0 }, seats = {};
  for (const seed of SEEDS) {
    const r = await matchStats({ seed, seconds: SECONDS });
    for (const [key, row] of Object.entries(r.tally)) { sum[key] ??= {}; for (const [field, n] of Object.entries(row)) sum[key][field] = (sum[key][field] ?? 0) + n; }
    for (const key of Object.keys(extra)) extra[key] += r[key];
    for (const [key, n] of Object.entries(r.seatSeconds)) seats[key] = (seats[key] ?? 0) + n;
  }
  console.log(`Bot matches: ${SEEDS.length} seeds x ${SECONDS} s, 16 normal bots (direct hull hits through the damage model)`);
  console.table(sum);
  console.log(JSON.stringify({ ...extra, botSeatSeconds: seats }));
  report.match = { seeds: SEEDS, seconds: SECONDS, tally: sum, ...extra, botSeatSeconds: seats };
}

const out = option('json', null);
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
