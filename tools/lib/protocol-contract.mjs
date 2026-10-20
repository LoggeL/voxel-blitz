export const PLAYER_KEYS = 'ads,adsT,armor,bomb,breathExhausted,breathReleasedFor,breathReserve,burning,charge,concussedMs,cosmetics,credits,crouch,deaths,deploying,exhaustion,firing,grenadeHandling,grenades,grounded,hp,id,impulse,interaction,kills,leanT,mag,medkit,minigun,moveSpeed,name,owned,pain,panic,ping,pitch,proneT,reloadAck,reloadState,reloading,reserve,respawnAt,scopeZoom,score,spawnProtected,state,swimming,team,teleport,vaulting,vehicleId,vehicleSeatId,weapon,x,y,yaw,z';

/**
 * Owner-only row keys (server/protocol/snapshot.js OWNER_ONLY_FIELDS): on the socket only the
 * recipient's own row carries them; authoritative in-process snapshots keep them on every row.
 */
export const OWNER_ONLY_PLAYER_KEYS = 'breathExhausted,breathReleasedFor,breathReserve,concussedMs,credits,exhaustion,grenades,impulse,medkit,reloadAck,reloadState,reserve,teleport';
const OWNER_ONLY = new Set(OWNER_ONLY_PLAYER_KEYS.split(','));
/** A sorted row key list as a socket recipient sees it on someone else's row. */
export const remoteRowKeys = keys => keys.split(',').filter(key => !OWNER_ONLY.has(key)).join(',');

export const MATCH_KEYS = 'attackers,bomb,defenders,map,mode,phase,phaseEndsAt,round,roundWinner,scores,winner';

/** Conquest player rows add `cq` (decodeConquestPlayer) and `cqs` (decodeConquestStats); other modes never carry them. */
export const CONQUEST_PLAYER_EXTRA_KEYS = 'cq,cqs';
/** `cqc` = [seq, commKindIndex, responderId | null, vehicleId?] only while the player has a live comm rose request (shared/conquest-comms.js). */
export const CONQUEST_PLAYER_OPTIONAL_KEYS = 'cqc';
export const CONQUEST_PLAYER_KEYS = [...PLAYER_KEYS.split(','), ...CONQUEST_PLAYER_EXTRA_KEYS.split(',')].sort().join(',');
/** `cq` = [kitIndex, squadId, down, spotted, restrictedDs, lockProgress100, actionProgress100, chute?]; `cqs` = [objective, vehicles, revives, captures].
 * The 8th entry (parachute 1 / ejection seat 2, shared/parachute.js) only rides rows of bodies under a canopy. */
export const CONQUEST_CQ_LENGTH = 7;
export const CONQUEST_CQ_MAX_LENGTH = 8;
export const CONQUEST_CQS_LENGTH = 4;

/** Conquest matches add `conquest`; during `post` the controller also adds continuation and results. */
export const CONQUEST_MATCH_KEYS = [...MATCH_KEYS.split(','), 'conquest'].sort().join(',');
/** Live `match.conquest` (statics come from mapMeta.conquest via decodeConquestMatch); `wx` is the weather (v6, on by default). */
export const CONQUEST_STATE_KEYS = 'bleed,endsAt,flags,maxTickets,squads,tickets,v,wx';
/** `wx` = [from, to, blend100, etaS, windDeg, wet100, next] (shared/conquest-weather.js). */
export const CONQUEST_WEATHER_TUPLE_LENGTH = 7;
/** Post-match `match.conquest` adds the 10 s ticket graph [[tMs, alpha, bravo], ...]. */
export const CONQUEST_POST_STATE_KEYS = [...CONQUEST_STATE_KEYS.split(','), 'ticketGraph'].sort().join(',');
/** Contract v6: `match.conquest.br` = [stage, integrity100, fallAt?] rides only once the Iron Bridge is damaged (shared/conquest-bridge.js). */
export const CONQUEST_BRIDGE_KEY = 'br';
/**
 * `flags[i]` = [id, control100, owner, state, atk, def]; `squads[i]` = [team, squadId, leaderId, orderFlag?]
 * (contract v6: the order flag id rides as a 4th entry only while the squad has an order).
 */
export const CONQUEST_FLAG_TUPLE_LENGTH = 6;
export const CONQUEST_SQUAD_TUPLE_LENGTH = 3;
export const CONQUEST_SQUAD_TUPLE_MAX_LENGTH = 4;
/** 400 B before contract v6; the weather tuple `wx` adds about 26 B. */
export const CONQUEST_MATCH_BUDGET_BYTES = 440;

/** Conquest contract v3 (classes): `cq[0]` indexes this kit list (0-3 kept from v2, new kits appended, so cq[0] <= 8). */
// v6: squad orders and the comm rose, the Recon gadgets, the Support MORTAR (`mortar` intent and event, deployable `mortar` hull rows with `own`), and ribbons and medals (`ribbon` / `medal` events, the `ribbon` score reason, results rows `cqr` / `cqm` / `cqp` / `cxp`), and vehicle upgrades (deploy `upgrades` map, row `upg`, locked `deploy_refused` with `vehicle` / `upgrade` / `level`), and the mobile AA (`aa` pad hull, `medium` armour class, `flak35` proximity-fused flak), and the patrol boat (`boat` pad hull after `aa`, `bow` mount, Frontier `waterways`), and dynamic weather (`match.conquest.wx` tuple, `weather_strike` event), and the Iron Bridge collapse (`match.conquest.br` tuple, `bridge` event, `bridge_destroyed` score reason).
export const CONQUEST_CONTRACT = Object.freeze({ version: 7 });
export const CONQUEST_KIT_IDS = 'assault,engineer,support,recon,medic,pyro,grenadier,raider,marksman';
/** Event kinds added by the classes update: the Medic aura `heal {id, by, hp}` and `kit_unlocks {id, level, unlocked, newly}`. */
export const CONQUEST_CLASS_EVENT_KINDS = 'heal,kit_unlocks';

/** Titanfall (docs/titanfall.md §3): player rows add `tf`; the self-only `{t:'tfs', s, d}` frame; matches add `titanfall`. */
export const TITANFALL_PLAYER_EXTRA_KEYS = 'tf';
export const TITANFALL_PLAYER_KEYS = [...PLAYER_KEYS.split(','), ...TITANFALL_PLAYER_EXTRA_KEYS.split(',')].sort().join(',');
export const TITANFALL_SELF_KEYS = 'd,s,t';
export const TITANFALL_MATCH_KEYS = [...MATCH_KEYS.split(','), 'titanfall'].sort().join(',');
/** Live `match.titanfall` = {v, endsAt, scoreLimit, sc: [alpha, bravo], bat: [[id, x10, y10, z10]], bay: [alpha, bravo, cap],
 *  npc: [[serial, kind, team, x, y, z, yaw, hp100, flags]] (WP8 minions)}. */
export const TITANFALL_STATE_KEYS = 'bat,bay,endsAt,npc,sc,scoreLimit,v';
/** Titan vehicle rows add `tw`, `own`, `ab`. */
export const TITAN_ROW_EXTRA_KEYS = 'ab,own,tw';
/** `tf` 8, `tfs.d` 12, `tw` 6, `ab` 4; titan mount rows are 6-tuples (conquest stays 5). */
export const TITANFALL_TF_LENGTH = 8;
export const TITANFALL_TFS_LENGTH = 13;
export const TITAN_TW_LENGTH = 6;
export const TITAN_AB_LENGTH = 4;
export const TITAN_MOUNT_TUPLE_LENGTH = 6;
export const TITANFALL_MATCH_BUDGET_BYTES = 400;
export const TITANFALL_CONTRACT = Object.freeze({ version: 1 });

/** Structural integrity events (docs/structural-physics.md): sorted keys per kind. */
export const STRUCTURE_EVENT_KEYS = Object.freeze({
  creak: 'at,b,fall,id,kind,n,o,t',
  collapse: 'at,b,g,id,k,kind,land,n,o,p,t,v,w',
  collapseLand: 'at,id,kind,n,r,speed,t,x,y,z',
  crumble: 'at,b,id,kind,n,o,t',
});
