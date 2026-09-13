export const TTT_WEAPONS = Object.freeze(['rifle', 'smg', 'shotgun', 'sniper', 'revolver', 'lmg']);
export const TTT_GADGET_RULES = Object.freeze({ radarMs: 30000, teleportCooldownMs: 20000, teleportUses: 3 });
export const TTT_SHOP = Object.freeze({
  radar: { name: 'Radar', category: 'Aufklärung', detail: 'Lebenszeichen durch Wände',
    description: 'Startet sofort. Markiert lebende Spieler mit Entfernung im Sichtfeld. Neue Positionen alle 30 Sekunden; rote Kontakte sind deine Mitstreiter.', price: 1, permanent: true },
  disguiser: { name: 'Disguiser', category: 'Täuschung', detail: 'Verbirg deine Identität',
    description: 'Blendet deinen Namen und deine Gesundheitsanzeige über dem Charakter aus. Du bleibst sichtbar. Nach dem Kauf aktiv; hier jederzeit umschaltbar.', price: 1, permanent: true },
  teleporter: { name: 'Teleporter', category: 'Flucht', detail: 'Dein geheimer Rückweg',
    description: 'Merke einen sicheren Bodenpunkt und springe bis zu 3-mal zurück. 20 Sekunden Pause pro Sprung. Blockierte oder besetzte Ziele kosten keine Ladung.', price: 1, permanent: true },
  armor: { name: 'Rüstung', category: 'Versorgung', detail: '+50 Rüstung',
    description: 'Fängt Schaden ab. Maximal 100 Rüstung; bei voller Rüstung bleibt dein Credit erhalten.', price: 1 },
  health: { name: 'Heilung', category: 'Versorgung', detail: '+35 Lebenspunkte',
    description: 'Sofortige Heilung bis maximal 100 HP. Nur bei Verletzung verfügbar.', price: 1 },
  ammo: { name: 'Munition', category: 'Versorgung', detail: 'Reservemunition auffüllen',
    description: 'Füllt die Reserve deiner getragenen Waffe auf. Das Magazin musst du selbst nachladen.', price: 1 },
});
export const TTT_EQUIPMENT_ACTIONS = Object.freeze(['disguise-on', 'disguise-off', 'teleport-mark', 'teleport-return']);
export function isTttRequest(value) {
  return typeof value === 'string' && (/^ttt:pickup:[0-9]+$/.test(value)
    || value === 'ttt:drop' || (value.startsWith('ttt:')
      && (Object.hasOwn(TTT_SHOP, value.slice(4)) || TTT_EQUIPMENT_ACTIONS.includes(value.slice(4)))));
}
