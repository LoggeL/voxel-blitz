import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !outputPath) throw new Error('Usage: node tools/compare-ttk.mjs BEFORE.json AFTER.json OUTPUT_DIR');
const before = JSON.parse(readFileSync(beforePath)), after = JSON.parse(readFileSync(afterPath));
for (const key of ['samples', 'hp', 'armor', 'maxSeconds', 'seed', 'distances']) {
  if (JSON.stringify(before.options[key]) !== JSON.stringify(after.options[key]))
    throw new Error(`Incompatible comparison setting: ${key}`);
}
if (before.tickMs !== after.tickMs || JSON.stringify(before.scenarios) !== JSON.stringify(after.scenarios))
  throw new Error('Incompatible simulation tick/scenarios');
const key = row => [row.weapon, row.variant || 'base', row.scenario, row.distance].join(':');
const left = new Map([...before.rows, ...before.variants].map(row => [key(row), row]));
const right = [...after.rows, ...after.variants];
if (left.size !== right.length) throw new Error('Different row counts');
const metrics = ['p10Ms', 'medianMs', 'p90Ms', 'killRate', 'firstImpactKillRate', 'meanShots', 'meanHits', 'meanReloads'];
const comparison = right.map(row => {
  const previous = left.get(key(row));
  if (!previous) throw new Error(`Missing baseline ${key(row)}`);
  return { weapon: row.weapon, name: row.name, variant: row.variant || 'base', distance: row.distance, scenario: row.scenario,
    before: Object.fromEntries(metrics.map(m => [m, previous[m]])),
    after: Object.fromEntries(metrics.map(m => [m, row[m]])),
    deltaMs: row.medianMs !== null && previous.medianMs !== null ? row.medianMs - previous.medianMs : null };
});
const sourceChanges = [...new Set([...Object.keys(before.sourceSha256), ...Object.keys(after.sourceSha256)])]
  .filter(path => before.sourceSha256[path] !== after.sourceSha256[path]);
const blast = after.rocketBlast.samples.map(row => ({ distance: row.distance,
  before: before.rocketBlast.samples.find(p => p.distance === row.distance)?.damage ?? null, after: row.damage }));
const out = resolve(outputPath); mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'comparison.json'), JSON.stringify({ beforePath: resolve(beforePath), afterPath: resolve(afterPath),
  options: after.options, sourceChanges, rows: comparison, blast }, null, 2) + '\n');
const fmt = ms => ms === null ? 'n. e.' : (ms / 1000).toFixed(2);
let report = '# Waffenbalance: vorher → nachher\n\n';
report += `Je Stand ${after.totalFights.toLocaleString('de-DE')} Durchläufe, gleiche Distanzen und Seeds, ${after.options.hp} HP, ${after.options.armor} Rüstung. `;
report += 'Werte: TTK-Median in Sekunden, ab verarbeitetem Abzug. Stehendes Ziel, fertiges ADS, Rückstoß und Flugbahn perfekt kompensiert. Keine Aussage über Reaktions-/Netzlaufzeit oder tatsächliche Match-TTK. `n. e.` bedeutet: Quantil innerhalb der Zeitgrenze nicht erreicht.\n\n';
const weapon = (result, id) => result.weapons.find(w => w.id === id);
const parameter = (label, a, b) => `- ${label}: ${a} → ${b}\n`;
report += parameter('Revolver-Fernschaden', weapon(before, 'revolver').damage[1], weapon(after, 'revolver').damage[1]);
report += parameter('Shotgun-Falloff (m)', `${weapon(before, 'shotgun').falloffStart} bis ${weapon(before, 'shotgun').damage[2]}`, `${weapon(after, 'shotgun').falloffStart} bis ${weapon(after, 'shotgun').damage[2]}`);
report += parameter('Minigun-Hitzebonus (%)', before.minigunRules.maxDamageBonus * 100, after.minigunRules.maxDamageBonus * 100);
report += parameter('Flammenwerfer-Basisschaden nah/fern', weapon(before, 'flamethrower').damage.slice(0, 2).join('/'), weapon(after, 'flamethrower').damage.slice(0, 2).join('/'));
report += parameter('Raketen-Schadensradius (m)', before.rocketBlast.rules.damageRadius, after.rocketBlast.rules.damageRadius);
report += parameter('Raketen-Schadensexponent', before.rocketBlast.rules.damageFalloffExponent ?? 1.22, after.rocketBlast.rules.damageFalloffExponent ?? 1.22) + '\n';
for (const scenario of after.scenarios) {
  report += `## ${scenario.label}\n\n| Waffe | ${after.options.distances.map(d => `${d} m`).join(' | ')} |\n|---|${after.options.distances.map(() => '---:').join('|')}|\n`;
  for (const weapon of after.weapons) {
    const rows = comparison.filter(row => row.weapon === weapon.id && row.variant === 'base' && row.scenario === scenario.id);
    report += `| ${weapon.name} | ${after.options.distances.map(d => { const r = rows.find(r => r.distance === d); return `${fmt(r.before.medianMs)} → ${fmt(r.after.medianMs)}`; }).join(' | ')} |\n`;
  }
  for (const variant of ['ready', 'hot']) {
    const rows = comparison.filter(row => row.weapon === 'minigun' && row.variant === variant && row.scenario === scenario.id);
    if (rows.length) report += `| Minigun ${variant} | ${after.options.distances.map(d => { const r = rows.find(r => r.distance === d); return `${fmt(r.before.medianMs)} → ${fmt(r.after.medianMs)}`; }).join(' | ')} |\n`;
  }
  report += '\n';
}
report += '## Rakete: Splash-Schaden nach Abstand zum Einschlag\n\n';
const rules = after.rocketBlast.rules;
report += `Direkttreffer: ${before.rocketBlast.direct.damage.toFixed(1)} → ${after.rocketBlast.direct.damage.toFixed(1)} Schaden. Druckradius ${rules.knockbackRadius ?? rules.damageRadius} m, Zerstörungsradius ${rules.terrainRadius} m. `;
report += `Abstand zum Schadensmesspunkt des Spielers, nicht zum Rand seiner Hitbox. Neuer Splash vor Rundung: ${(rules.damage * after.damageScale).toFixed(1)} × max(0, 1 − Abstand/${rules.damageRadius})^${rules.damageFalloffExponent ?? 1.22}. Das ist eine Potenzfunktion mit festem Nullpunkt am Radiusrand.\n\n`;
report += '| Abstand | Vorher | Nachher |\n|---|---:|---:|\n';
for (const row of blast) report += `| ${row.distance.toFixed(2)} m | ${row.before?.toFixed(2)} | ${row.after.toFixed(2)} |\n`;
report += '\n## Vergleichsprüfung\n\nQuellenunterschiede zwischen den Läufen:\n\n';
for (const path of sourceChanges) report += `- \`${path}\`\n`;
report += '\n`comparison.json` enthält zusätzlich P10, P90, Killrate, sofort tödliche Einschläge, Schuss-/Trefferzahlen und Differenzen.\n';
writeFileSync(resolve(out, 'comparison.md'), report);
console.log(`Compared ${comparison.length} cells. Source changes: ${sourceChanges.join(', ')}. Output: ${out}`);
