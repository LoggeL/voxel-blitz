export const PLAYER_KEYS = 'ads,adsT,armor,bomb,breathExhausted,breathReleasedFor,breathReserve,burning,charge,concussedMs,cosmetics,credits,crouch,deaths,deploying,exhaustion,firing,grenadeHandling,grenades,grounded,hp,id,impulse,interaction,kills,leanT,mag,medkit,minigun,moveSpeed,name,owned,pain,panic,ping,pitch,proneT,reloadAck,reloadState,reloading,reserve,respawnAt,scopeZoom,score,spawnProtected,state,swimming,team,teleport,vaulting,vehicleId,vehicleSeatId,weapon,x,y,yaw,z';

export const MATCH_KEYS = 'attackers,bomb,defenders,map,mode,phase,phaseEndsAt,round,roundWinner,scores,winner';

/** Conquest player rows add `cq` (decodeConquestPlayer) and `cqs` (decodeConquestStats); other modes never carry them. */
export const CONQUEST_PLAYER_EXTRA_KEYS = 'cq,cqs';
export const CONQUEST_PLAYER_KEYS = [...PLAYER_KEYS.split(','), ...CONQUEST_PLAYER_EXTRA_KEYS.split(',')].sort().join(',');
/** `cq` = [kitIndex, squadId, down, spotted, restrictedDs, lockProgress100, actionProgress100, chute?]; `cqs` = [objective, vehicles, revives, captures].
 * The 8th entry (parachute 1 / ejection seat 2, shared/parachute.js) only rides rows of bodies under a canopy. */
export const CONQUEST_CQ_LENGTH = 7;
export const CONQUEST_CQ_MAX_LENGTH = 8;
export const CONQUEST_CQS_LENGTH = 4;

/** Conquest matches add `conquest`; during `post` the controller also adds continuation and results. */
export const CONQUEST_MATCH_KEYS = [...MATCH_KEYS.split(','), 'conquest'].sort().join(',');
/** Live `match.conquest` (statics come from mapMeta.conquest via decodeConquestMatch). */
export const CONQUEST_STATE_KEYS = 'bleed,endsAt,flags,maxTickets,squads,tickets,v';
/** Post-match `match.conquest` adds the 10 s ticket graph [[tMs, alpha, bravo], ...]. */
export const CONQUEST_POST_STATE_KEYS = [...CONQUEST_STATE_KEYS.split(','), 'ticketGraph'].sort().join(',');
/** `flags[i]` = [id, control100, owner, state, atk, def]; `squads[i]` = [team, squadId, leaderId]. */
export const CONQUEST_FLAG_TUPLE_LENGTH = 6;
export const CONQUEST_SQUAD_TUPLE_LENGTH = 3;
export const CONQUEST_MATCH_BUDGET_BYTES = 400;

/** Conquest contract v3 (classes): `cq[0]` indexes this kit list (0-3 kept from v2, new kits appended, so cq[0] <= 8). */
export const CONQUEST_CONTRACT = Object.freeze({ version: 3 });
export const CONQUEST_KIT_IDS = 'assault,engineer,support,recon,medic,pyro,grenadier,raider,marksman';
/** Event kinds added by the classes update: the Medic aura `heal {id, by, hp}` and `kit_unlocks {id, level, unlocked, newly}`. */
export const CONQUEST_CLASS_EVENT_KINDS = 'heal,kit_unlocks';
