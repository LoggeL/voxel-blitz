import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { COMBAT_DAMAGE_SCALE } from '../shared/combat-balance.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { DISTANCES, SCENARIOS, simulateFight, summarize } from './lib/ttk-simulation.mjs';
import { blastProfile } from './lib/blast-simulation.mjs';
import { MINIGUN } from '../shared/minigun.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opts = { samples: 256, hp: 100, armor: 0, maxSeconds: 20, seed: 120926,
  distances: DISTANCES, out: resolve(root, '.artifacts/ttk/current') };
const numeric = { '--samples': 'samples', '--hp': 'hp', '--armor': 'armor',
  '--max-seconds': 'maxSeconds', '--seed': 'seed' };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help') {
    console.log('node tools/simulate-ttk.mjs [--samples 256] [--hp 100] [--armor 0] [--max-seconds 20] [--seed 120926] [--distances 5,10,20,40,80,120] [--out PATH]');
    process.exit(0);
  }
  if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}`);
  if (numeric[arg]) opts[numeric[arg]] = Number(args[++i]);
  else if (arg === '--distances') opts.distances = args[++i].split(',').map(Number);
  else if (arg === '--out') opts.out = resolve(args[++i]);
  else throw new Error(`Unknown argument ${arg}`);
}
if (!Number.isInteger(opts.samples) || opts.samples < 1 || opts.samples > 10000
  || !Number.isSafeInteger(opts.seed) || !opts.distances.length) throw new Error('Invalid samples, seed or distances');
// Validate every numeric option before creating output or starting the sweep.
for (const distance of opts.distances) simulateFight({ weapon: 'rifle', distance,
  hp: opts.hp, armor: opts.armor, maxSeconds: opts.maxSeconds });

function sourceManifest() {
  const files = [];
  function collect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/\.m?js$/.test(path)) files.push(path);
    }
  }
  collect(resolve(root, 'server')); collect(resolve(root, 'shared'));
  files.push(fileURLToPath(import.meta.url), resolve(root, 'tools/lib/ttk-simulation.mjs'));
  files.push(resolve(root, 'tools/lib/blast-simulation.mjs'));
  return Object.fromEntries(files.sort().map(path => [relative(root, path),
    createHash('sha256').update(readFileSync(path)).digest('hex')]));
}
const manifest = sourceManifest();
const started = Date.now();
let totalFights = 0;
const rows = [], variants = [], chargeThresholds = [];
function run(weapon, distance, scenario, extra = {}) {
  const count = scenario.perfect || WEAPONS[weapon].flame || WEAPONS[weapon].melee ? 1 : opts.samples;
  const fights = Array.from({ length: count }, (_, i) => simulateFight({
    weapon, distance, scenario: scenario.id, seed: opts.seed + i, hp: opts.hp,
    armor: opts.armor, maxSeconds: opts.maxSeconds, ...extra }));
  totalFights += fights.length;
  return { weapon, name: WEAPONS[weapon].name, distance, scenario: scenario.id,
    ...summarize(fights), ...(count === 1 ? { sample: fights[0] } : {}) };
}
for (const weapon of WEAPON_IDS) {
  for (const distance of opts.distances) {
    for (const scenario of SCENARIOS) rows.push(run(weapon, distance, scenario));
    if (weapon === 'minigun') {
      for (const state of ['ready', 'hot']) for (const scenario of SCENARIOS.filter(s => s.ads))
        variants.push({ ...run(weapon, distance, scenario, { minigun: state }), variant: state });
    }
    if (weapon === 'knife' && distance <= 3)
      variants.push({ ...run(weapon, distance, SCENARIOS[0], { backstab: true }), variant: 'backstab' });
    if (weapon === 'lance') for (const scenario of SCENARIOS.filter(s => s.perfect)) {
      const maxTicks = Math.ceil(WEAPONS.lance.charge.holdMaxMs / TICK_MS);
      let low = 1, high = maxTicks + 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const chargeMs = mid * TICK_MS;
        const fight = simulateFight({ weapon, distance, scenario: scenario.id, hp: opts.hp,
          armor: opts.armor, chargeMs, maxSeconds: Math.max(0.05, chargeMs / 1000) });
        totalFights++;
        if (fight.killMs !== null) high = mid;
        else low = mid + 1;
      }
      chargeThresholds.push({ distance, scenario: scenario.id,
        minChargeMs: low <= maxTicks ? low * TICK_MS : null });
    }
  }
  console.log(`Simulated ${WEAPONS[weapon].name}`);
}
if (JSON.stringify(manifest) !== JSON.stringify(sourceManifest()))
  throw new Error('Combat source changed during the sweep. Rerun for a consistent snapshot.');
const result = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  gitStatus: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim(),
  options: opts, tickMs: TICK_MS, damageScale: COMBAT_DAMAGE_SCALE,
  totalFights, durationMs: Date.now() - started, sourceSha256: manifest,
  weapons: WEAPON_IDS.map(id => WEAPONS[id]), minigunRules: MINIGUN,
  rocketBlast: blastProfile(), scenarios: SCENARIOS, rows, variants, chargeThresholds };
mkdirSync(opts.out, { recursive: true });
writeFileSync(resolve(opts.out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const fmt = ms => ms === null ? `>${opts.maxSeconds} s / kein Treffer` : `${(ms / 1000).toFixed(2)} s`;
let report = `# Waffen-TTK\n\nStand: ${result.gitHead}. ${result.generatedAt}. ${totalFights} Durchläufe.\n\n`;
report += `${opts.hp} HP, ${opts.armor} Rüstung, ${TICK_MS} ms Server-Tick, Schadensfaktor ${COMBAT_DAMAGE_SCALE}. `;
report += 'TTK ab verarbeitetem Abzug; Waffe ausgerüstet, ADS bereits erreicht, Minigun startet kalt, Railgun mit voller Ladung. ';
report += 'Stehendes Ziel, freies Schussfeld, perfekte Rückstoß- und Flugbahnkompensation. Keine Reaktionszeit, Bewegung, Deckung, Netzlatenz, Upgrades oder Power-ups. ';
report += 'Streuung verwendet echte Hitboxen, Bloom und Schusserschöpfung; Kopf/Körper bezeichnet den Zielpunkt, Streuung kann andere Zonen treffen. ';
report += 'Projektile, Nachladen, Hitze und Nachbrennen laufen über die Serverfunktionen. ';
report += 'Leeres Magazin wird sofort nachgeladen; die Schrotflinte unterbricht die Nachladung, sobald eine Patrone sitzt. ';
report += '20 Hz begrenzen das Timing auf 50-ms-Schritte. Eingabe wird zum frühesten erlaubten Tick angenommen.\n\n';
report += `Pro zufälligem Szenario ${opts.samples} reproduzierbare Seeds. Deterministische Szenarien einmal. `;
report += `Median und P90 zählen auch erfolglose Versuche (Abbruch nach ${opts.maxSeconds} s) mit; unbekannte Quantile bleiben leer. `;
report += 'Der Simulationslauf selbst verändert keine Gameplay-Werte.\n\n';
for (const scenario of SCENARIOS) {
  report += `## ${scenario.label}: TTK-Median\n\n| Waffe | ${opts.distances.map(d => `${d} m`).join(' | ')} |\n|---|${opts.distances.map(() => '---:').join('|')}|\n`;
  for (const weapon of WEAPON_IDS) report += `| ${WEAPONS[weapon].name} | ${opts.distances.map(distance => fmt(rows.find(r => r.weapon === weapon && r.scenario === scenario.id && r.distance === distance).medianMs)).join(' | ')} |\n`;
  report += '\n';
}
report += '## Sonderzustände\n\n| Waffe / Zustand | Szenario | Distanz | Median | P90 | Killrate |\n|---|---|---:|---:|---:|---:|\n';
for (const row of variants) report += `| ${row.name} / ${row.variant} | ${row.scenario} | ${row.distance} m | ${fmt(row.medianMs)} | ${fmt(row.p90Ms)} | ${(row.killRate * 100).toFixed(1)} % |\n`;
report += '\n## Railgun: minimale tödliche Ladezeit im Strahlkern\n\n| Distanz | Körper | Kopf |\n|---|---:|---:|\n';
for (const distance of opts.distances) report += `| ${distance} m | ${['ideal-body', 'ideal-head'].map(scenario => fmt(chargeThresholds.find(r => r.distance === distance && r.scenario === scenario).minChargeMs)).join(' | ')} |\n`;
report += '\n`results.json` enthält je Zelle P10, Median, P90, Killrate, sofort tödliche erste Einschläge, Schuss-/Trefferzahlen und Quellcode-Hashes. Schusszahl bei Projektilen zählt alle bis zum Kill abgefeuerten Geschosse einschließlich noch fliegender Geschosse.\n';
writeFileSync(resolve(opts.out, 'summary.md'), report);
const blast = result.rocketBlast;
let blastReport = '# Raketen-Explosionsschaden\n\n';
blastReport += 'Abstand vom Einschlag zum Schadensmesspunkt (Spielerfuß + 1,05 m), keine Deckung, 100 HP, keine Rüstung. Ein einzelner realer Server-Explosionsaufruf pro Messpunkt.\n\n';
blastReport += `Direkttreffer: ${blast.direct.damage.toFixed(2)} Schaden. Durch feste Deckung bei 3 m: ${blast.covered.damage.toFixed(2)} Schaden.\n\n`;
blastReport += '| Abstand | Splash-Schaden | Rest-HP |\n|---|---:|---:|\n';
for (const row of blast.samples) blastReport += `| ${row.distance.toFixed(2)} m | ${row.damage.toFixed(2)} | ${row.hpLeft.toFixed(2)} |\n`;
writeFileSync(resolve(opts.out, 'rocket-blast.md'), blastReport);
console.log(`${totalFights} fights in ${((Date.now() - started) / 1000).toFixed(1)} s. Results: ${opts.out}`);
