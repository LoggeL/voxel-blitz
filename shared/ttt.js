import { isTrapRequest } from './world/traps.js';
import { POWERUP_RULES } from './powerups.js';
export const DEFAULT_TRAITOR_PERCENT = 25;
export const TTT_TRAITOR_PERCENTS = Object.freeze([10, 15, 20, 25, 30, 35, 40, 45, 50]);
export function tttTraitorCount(players, percent = DEFAULT_TRAITOR_PERCENT) {
  if (players < 2) return 0;
  return Math.min(players - 1, Math.max(1, Math.floor(players * percent / 100)));
}
export const TTT_WEAPONS = Object.freeze(['rifle', 'smg', 'shotgun', 'sniper', 'revolver', 'lmg']);
export const TTT_GRENADES = Object.freeze(['frag', 'smoke', 'molotov']);
export const TTT_GRENADE_CAP = 2;
export const TTT_C4 = Object.freeze({ fuseMs:45000, damage:320, damageRadius:12, selfDamage:1,
  knockback:12, terrainRadius:3, terrainPower:240, maxDestroyedBlocks:96, concussMs:0, concussPanic:0 });
export const TTT_GADGET_RULES = Object.freeze({ radarMs: 30000, teleportCooldownMs: 20000, teleportUses: 3 });
const seconds = ms => ms / 1000;
export const TTT_SHOP = Object.freeze({
  radar: { name: 'Radar', category: 'Aufklärung', detail: 'Lebenszeichen durch Wände',
    description: `Startet sofort. Markiert lebende Spieler mit Entfernung im Sichtfeld. Neue Positionen alle ${seconds(TTT_GADGET_RULES.radarMs)} Sekunden; rote Kontakte sind deine Mitstreiter.`, price: 1, permanent: true },
  disguiser: { name: 'Disguiser', category: 'Täuschung', detail: 'Verbirg deine Identität',
    description: 'Blendet deinen Namen und deine Gesundheitsanzeige über dem Charakter aus. Du bleibst sichtbar. Nach dem Kauf aktiv; hier jederzeit umschaltbar.', price: 1, permanent: true },
  fakebody: { name: 'Fake-Leiche', category: 'Täuschung', detail: 'Deine Leiche, ohne zu sterben',
    description: 'Legt eine täuschend echte Leiche von dir ab. Identifizieren zeigt dich als unschuldig; dein Scoreboard-Status bleibt lebend. Eine Ladung pro Runde.', price: 1, permanent: true },
  teleporter: { name: 'Teleporter', category: 'Flucht', detail: 'Dein geheimer Rückweg',
    description: `Merke einen sicheren Bodenpunkt und springe bis zu ${TTT_GADGET_RULES.teleportUses}-mal zurück. ${seconds(TTT_GADGET_RULES.teleportCooldownMs)} Sekunden Pause pro Sprung. Blockierte oder besetzte Ziele kosten keine Ladung.`, price: 1, permanent: true },
  c4: { name:'C4', category:'Sabotage', detail:`Eine Ladung · ${seconds(TTT_C4.fuseMs)} Sekunden`,
    description:`Platziere eine Zeitbombe am Boden. Explodiert nach ${seconds(TTT_C4.fuseMs)} Sekunden mit bis zu ${TTT_C4.damage} Schaden in ${TTT_C4.damageRadius} Metern Radius. Deckung schützt; auch Traitor und du selbst können sterben. Eine Ladung pro Runde.`,price:1,permanent:true },
  armor: { name: 'Rüstung', category: 'Versorgung', detail: `+${POWERUP_RULES.armorAmount} Rüstung`,
    description: `Fängt Schaden ab. Maximal ${POWERUP_RULES.maxArmor} Rüstung; bei voller Rüstung bleibt dein Credit erhalten.`, price: 1 },
  health: { name: 'Heilung', category: 'Versorgung', detail: `+${POWERUP_RULES.healthAmount} Lebenspunkte`,
    description: `Sofortige Heilung bis maximal ${POWERUP_RULES.maxHealth} HP. Nur bei Verletzung verfügbar.`, price: 1 },
  ammo: { name: 'Munition', category: 'Versorgung', detail: 'Reservemunition auffüllen',
    description: 'Füllt die Reserve deiner getragenen Waffe auf. Das Magazin musst du selbst nachladen.', price: 1 },
});
export const TTT_EQUIPMENT_ACTIONS = Object.freeze(['disguise-on', 'disguise-off', 'teleport-mark', 'teleport-return', 'c4-place', 'fakebody-place']);
export function isTttRequest(value) {
  return typeof value === 'string' && (/^ttt:(pickup|inspect):[0-9]+$/.test(value) || isTrapRequest(value)
    || value === 'ttt:drop' || (value.startsWith('ttt:')
      && (Object.hasOwn(TTT_SHOP, value.slice(4)) || TTT_EQUIPMENT_ACTIONS.includes(value.slice(4)))));
}
