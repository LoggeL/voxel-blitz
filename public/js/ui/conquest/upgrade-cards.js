/**
 * Deploy-screen VEHICLES tab model and the vehicle panel's upgrade badge
 * (design docs/design/conquest/upgrades/, variant A). Every name, number and
 * level comes from shared/vehicle-upgrades.js; the career level is the one the
 * server announced (`kit_unlocks`), so a chip shows locked exactly when the
 * server would refuse it.
 */
import { upgradeTypes, upgradesFor, upgradeFromCode, upgradeUnlocked, vehicleUpgrade } from '../../../../shared/vehicle-upgrades.js';

/** Tail of every upgrade hint: the effect rides the hull only while its owner drives it. */
export const UPGRADE_APPLIES = 'APPLIES WHILE YOU DRIVE OR PILOT';
const STOCK_HINT = 'NO UPGRADE · THE HULL AS ISSUED';

/** XP a career level starts at (shared/career.js: level = 1 + floor(sqrt(xp / 100))). */
const levelXp = level => (Math.max(1, level) - 1) ** 2 * 100;

/**
 * The picks the deploy intent may send: stored choices reduced to known
 * upgrades open at `level` (a stored locked pick drives stock, like a stored
 * locked class falls back to the Assault).
 */
export function upgradeChoice(selection = null, level = 1) {
  const out = {};
  for (const [type, id] of Object.entries(selection || {})) {
    if (vehicleUpgrade(type, id) && upgradeUnlocked(type, id, level)) out[type] = id;
  }
  return out;
}

/**
 * One card per hull type (UPGRADE_MENU_ORDER): `{type, label, selected,
 * spawn, options}`; `options` start with STOCK, then every upgrade of the
 * type with `unlocked`, `unlockLevel`, `lockText` ('LV 6') and, with a
 * career view, `progress` toward the unlock. `spawnType` marks the hull the
 * picked spawn would put the player in.
 */
export function upgradeCards(selection = null, level = 1, { labels = {}, career = null, spawnType = null } = {}) {
  const choice = upgradeChoice(selection, level);
  const xp = Number.isFinite(career?.xp) ? career.xp : null;
  return upgradeTypes().map(type => {
    const selected = choice[type] ?? null;
    const options = [{ id: null, label: 'STOCK', short: 'STOCK', hint: STOCK_HINT, unlocked: true, unlockLevel: 1, lockText: '', selected: selected === null }];
    for (const upgrade of upgradesFor(type)) {
      const unlocked = upgradeUnlocked(type, upgrade.id, level);
      const need = levelXp(upgrade.unlockLevel);
      options.push({ id: upgrade.id, label: upgrade.label, short: upgrade.short, hint: upgrade.hint, unlocked, unlockLevel: upgrade.unlockLevel,
        lockText: unlocked ? '' : `LV ${upgrade.unlockLevel}`, selected: selected === upgrade.id,
        progress: !unlocked && xp !== null ? { xp, need, fraction: Math.max(0, Math.min(1, xp / need)) } : null });
    }
    return { type, label: labels[type] || type.toUpperCase(), selected, spawn: type === spawnType, options };
  });
}

/** Info line of an upgrade option on its hull card: '<HULL> · <UPGRADE> — <hint> · APPLIES …'. */
export function upgradeInfoText(card, option) {
  if (!card || !option) return '';
  if (!option.unlocked) return `${card.label} · ${option.label} · UNLOCKS AT LV ${option.unlockLevel} — ${option.hint}`;
  return option.id ? `${card.label} · ${option.label} — ${option.hint} · ${UPGRADE_APPLIES}` : `${card.label} · ${option.label} — ${option.hint}`;
}

/** Vehicle panel badge of a row's `upg` (the driver's upgrade), or null when stock. */
export function upgradeBadge(row) {
  const upgrade = row ? upgradeFromCode(row.type, row.upg) : null;
  return upgrade ? { key: `upgrade:${upgrade.id}`, label: upgrade.short, tone: 'upgrade', title: upgrade.label } : null;
}

/** Refusal text of a locked upgrade (`deploy_refused {reason:'locked', vehicle, upgrade, level}`). */
export function upgradeRefusedText(refused, labels = {}) {
  const upgrade = vehicleUpgrade(refused?.vehicle, refused?.upgrade);
  const name = upgrade ? `${labels[refused.vehicle] || String(refused.vehicle).toUpperCase()} ${upgrade.label}` : 'UPGRADE';
  return `${name} LOCKED${Number.isFinite(refused?.level) ? ` · LV ${refused.level}` : ''}`;
}
