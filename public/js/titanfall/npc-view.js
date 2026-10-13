// Attrition minions on the client (docs/titanfall.md §10; WP8). The server sends
// them compactly in `match.titanfall.npc` = [[serial, kind, team, x, y, z, yaw,
// hp100, flags]] (flags: 1 moving, 2 firing, 4 crouched, 8 dead); this module
// turns those rows into synthetic remote rows for its own AvatarRoster, so the
// minions walk, aim, flinch, die and fall apart exactly like player avatars
// (the stock avatar, weapon, gore and corpse paths), and dresses each body:
// GRUNTS as helmeted riflemen in muted team fatigues, SPECTRES as gunmetal
// robots with a single glowing team-coloured eye.
//
// Client-module contract (titanfall-client.js): init(app, client), tick(snapshot, dt),
// frame(dt, ctx), onEvent(event), dispose(). Everything shown comes from the rows
// and the hit/kill/shoot events (R9); the module computes no gameplay state.
import { AvatarRoster } from '../avatar/avatar-roster.js';
import { refreshAvatarMaterialLists } from '../avatar/avatar.js';
import { SkinLayer } from '../cosmetics/skin-layer.js';
import { imagegenMap } from '../engine/blender-assets.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { getBlock as worldGetBlock } from '../../../shared/worlddata.js';
import { nowMs } from '../util/math.js';

/** Wire kind codes (server/sim/titanfall/grunts.js GRUNT_RULES.kinds[*].code). */
export const NPC_KINDS = Object.freeze(['grunt', 'spectre']);
export const NPC_NAMES = Object.freeze({ grunt: 'GRUNT', spectre: 'SPECTRE' });
const NPC_WEAPONS = Object.freeze({ grunt: 'rifle', spectre: 'smg' });
const FLAG = Object.freeze({ moving: 1, firing: 2, crouch: 4, dead: 8 });
/** Presentation delay behind the newest row when the net clock is unavailable (ms). */
const FALLBACK_DELAY_MS = 100;
const SAMPLES = 8;
/** A firing flash/pose holds this long after a shoot event (ms). */
const FIRE_HOLD_MS = 140;
/**
 * A dead row turns dead once the presented time reaches its snapshot (as player
 * rows do in netclient.interpolate), plus this long for its hit/kill events to
 * drain: the death then carries the bullet's direction and overkill.
 */
const DEATH_EVENT_GRACE_MS = 120;
/** New minion bodies built per rendered frame (a squad spawn spreads over frames). */
const MAX_BUILDS_PER_FRAME = 1;
/** Beyond this camera distance (m) a minion drops its role details and its shadow. */
const FAR_LOD_M = 90;
/** Role groups that are small details (hidden far); helmets, robot heads and chassis stay. */
const DETAIL_GROUPS = new Set(['grunt_kit', 'grunt_band', 'spectre_arm', 'spectre_shin']);

/**
 * Looks per kind and team. Grunts: muted team fatigues (the team still reads at
 * range), olive armour, a helmet with a team stripe, the operator visor glowing
 * in the team colour, a radio pack. Spectres: team-tinted gunmetal (cool blue
 * steel / warm bronze steel) on the large body panels, a team chest and back
 * plate, a dark frame and one team-coloured eye.
 */
export const NPC_LOOKS = Object.freeze({
  grunt: Object.freeze({
    alpha: Object.freeze({ suit: 0x3f7fb4, dark: 0x2a3a4c, armor: 0x4d553f, accent: 0x5cc8ff, glow: 0x7fe0ff }),
    bravo: Object.freeze({ suit: 0xb8662c, dark: 0x4a3226, armor: 0x4d553f, accent: 0xff9a3c, glow: 0xffc070 }),
  }),
  spectre: Object.freeze({
    alpha: Object.freeze({ suit: 0xa3b4c6, dark: 0x5d7690, frame: 0x262c33, armor: 0x5b636c, accent: 0x38bdf8, glow: 0x6fd8ff }),
    bravo: Object.freeze({ suit: 0xbfa992, dark: 0x8a6f58, frame: 0x2e2824, armor: 0x655e57, accent: 0xfb923c, glow: 0xffb066 }),
  }),
});

/** Decode one `match.titanfall.npc` row, or null. */
export function decodeNpcRow(row) {
  if (!Array.isArray(row) || row.length < 8) return null;
  const serial = row[0] | 0, flags = row[8] | 0;
  const values = [row[3], row[4], row[5], row[6]].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return { serial, id: `tfg${serial}`, kind: NPC_KINDS[row[1] | 0] ?? 'grunt', team: row[2] ? 'bravo' : 'alpha',
    x: values[0], y: values[1], z: values[2], yaw: values[3], hp: Math.max(0, Math.min(100, row[7] | 0)),
    moving: !!(flags & FLAG.moving), firing: !!(flags & FLAG.firing), crouch: !!(flags & FLAG.crouch), dead: !!(flags & FLAG.dead) };
}

const isNpcId = id => typeof id === 'string' && id.startsWith('tfg');

/**
 * Grunt goggles: the operator's own visor (and the signal line glowing on it)
 * take the team glow. Both materials belong to this avatar alone.
 */
function tintVisor(avatar, glow) {
  const visor = avatar.visorMaterial;
  const tint = material => {
    if (!material?.color) return;
    material.color.setHex(glow);
    if (material.emissive) { material.emissive.setHex(glow); material.emissiveIntensity = 0.6; }
    material.userData.cosmeticGlow = true;
    material.needsUpdate = true;
  };
  tint(visor);
  avatar.head?.traverse(object => {
    if (!object.isMesh || Array.isArray(object.material) || object.userData?.cosmetic) return;
    const material = object.material;
    if (material === visor || material?.userData?.cosmetic) return;
    if (material?.emissive && material.emissive.getHex() !== 0 && (material.emissiveIntensity ?? 1) > 0) tint(material);
  });
}
const glowMaterial = (layer, color) => {
  const material = layer.material(color, { emissive: color, emissiveIntensity: 1.6, roughness: 0.35, metalness: 0.1, flatShading: false });
  // The hit flash owns the emissive channel of ordinary materials; glows keep theirs.
  material.userData.cosmeticGlow = true;
  return material;
};

/**
 * The imported Rivet operator carries its palette in photo textures (petrol suit,
 * rescue-orange armour), which swallow a multiplied team colour. Minion bodies
 * are this module's own avatars, so their per-avatar suit/dark materials and the
 * cloned orange armour switch to the neutral ceramic scan and take the team
 * colours outright (the originals stay recorded in avatar._npcRivet).
 */
function repaintRivet(avatar, look) {
  const neutral = imagegenMap('ivory-armor');
  if (!neutral) return;
  const saved = avatar._npcRivet ??= new Map();
  const paint = (material, color) => {
    if (!material?.color) return;
    if (!saved.has(material)) saved.set(material, { map: material.map, color: material.color.getHex() });
    material.map = neutral;
    material.color.setHex(color);
    material.needsUpdate = true;
  };
  if (avatar.suitMaterial?.map) paint(avatar.suitMaterial, look.suit);
  if (avatar.darkMaterial?.map) paint(avatar.darkMaterial, look.dark);
  avatar.group.traverse(object => {
    if (!object.isMesh || Array.isArray(object.material)) return;
    const material = object.material;
    if (material?.name === 'Armor | rescue orange' && material !== avatar.suitMaterial) paint(material, look.accent);
  });
}

/**
 * Dress one stock avatar as `kind` on `team` (idempotent per kind/team). The
 * extra parts ride the avatar's own joints, so they animate, flinch and fall
 * apart with the body; the role layer is disposed with the avatar.
 */
export function applyNpcLook(avatar, kind, team) {
  const key = `${kind}:${team}`;
  if (!avatar || avatar.tfNpcLook === key) return;
  const look = NPC_LOOKS[kind]?.[team] ?? NPC_LOOKS.grunt.alpha;
  avatar._roleLayer?.clear();
  for (const mesh of avatar._npcHidden ?? []) mesh.visible = true;
  avatar._npcHidden = [];
  avatar.tfNpcLook = key;
  avatar._npcFar = undefined;
  avatar.suitMaterial.color.setHex(look.suit);
  avatar.darkMaterial.color.setHex(look.dark);
  avatar.armorMaterial?.color?.setHex(look.armor);
  repaintRivet(avatar, look);
  const layer = avatar._roleLayer = new SkinLayer();
  const m = {
    suit: layer.material(look.suit, { roughness: 0.75, metalness: 0.1 }),
    dark: layer.material(look.dark, { roughness: 0.8, metalness: 0.15 }),
    armor: layer.material(look.armor, { roughness: 0.7, metalness: 0.2 }),
    accent: layer.material(look.accent, { roughness: 0.5, metalness: 0.15 }),
    glow: glowMaterial(layer, look.glow),
  };
  const hide = object => { if (object) { object.visible = false; avatar._npcHidden.push(object); } };
  if (kind === 'spectre') {
    m.metal = layer.material(look.suit, { roughness: 0.32, metalness: 0.75 });
    m.frame = layer.material(look.frame ?? look.dark, { roughness: 0.45, metalness: 0.6 });
    avatar.skinMaterial?.color?.setHex(0x3a3f46);
    // A robot head replaces the human one: the stock head meshes hide.
    for (const child of [...avatar.head.children]) if (child.isMesh) hide(child);
    const head = layer.group(avatar.head, 'spectre_head');
    layer.box(head, [0.27, 0.25, 0.29], [0, 0.02, 0], m.metal);
    layer.box(head, [0.29, 0.06, 0.31], [0, 0.135, 0.005], m.frame);           // brow cap
    layer.box(head, [0.22, 0.13, 0.05], [0, -0.06, -0.135], m.frame);          // jaw plate
    layer.box(head, [0.16, 0.10, 0.03], [0, 0.03, -0.152], m.frame);           // eye socket
    layer.cylinder(head, 0.045, 0.03, [0, 0.03, -0.168], m.glow, { segments: 10 }); // the eye
    for (const x of [-0.15, 0.15]) layer.box(head, [0.04, 0.12, 0.12], [x, 0.0, 0.02], m.frame); // sensor pods
    layer.box(head, [0.018, 0.22, 0.018], [0.1, 0.24, 0.07], m.frame);          // antenna
    layer.box(head, [0.03, 0.03, 0.03], [0.1, 0.355, 0.07], m.accent);
    layer.box(head, [0.1, 0.14, 0.1], [0, -0.18, 0.01], m.frame);              // neck
    // Chassis: the pack and pouches give way to a spine rail and chest plating.
    hide(avatar.pack);
    hide(avatar.pouches);
    const torso = layer.group(avatar.torso, 'spectre_chassis');
    layer.box(torso, [0.46, 0.22, 0.05], [0, 0.12, -0.2], m.accent);           // team chest plate
    layer.box(torso, [0.3, 0.07, 0.02], [0, 0.15, -0.229], m.metal);           // plate inset
    for (const y of [-0.02, -0.08, -0.14]) layer.box(torso, [0.34, 0.035, 0.04], [0, y, -0.18], m.frame); // ribs
    layer.box(torso, [0.4, 0.26, 0.04], [0, 0.08, 0.215], m.accent);           // team back plate
    layer.box(torso, [0.09, 0.5, 0.07], [0, -0.02, 0.17], m.frame);            // spine rail
    for (const y of [0.14, 0.0, -0.14]) layer.box(torso, [0.18, 0.05, 0.05], [0, y, 0.2], m.metal);
    for (const x of [-0.3, 0.3]) layer.box(torso, [0.12, 0.1, 0.24], [x, 0.24, 0], m.metal); // shoulder caps
    for (const [arm, side] of [[avatar.lArm, -1], [avatar.rArm, 1]]) {
      const g = layer.group(arm, 'spectre_arm');
      layer.box(g, [0.05, 0.22, 0.05], [side * 0.06, -0.17, 0.07], m.frame);  // piston
      layer.box(g, [0.14, 0.04, 0.2], [0, -0.06, 0], m.accent);
    }
    for (const leg of [avatar.lLeg, avatar.rLeg]) {
      const knee = leg.userData?.joints?.knee ?? leg;
      const g = layer.group(knee, 'spectre_shin');
      layer.box(g, [0.05, 0.24, 0.05], [0, -0.14, 0.1], m.frame);
      layer.box(g, [0.15, 0.08, 0.06], [0, -0.02, -0.12], m.metal);
    }
  } else {
    // Grunt: helmet with a team stripe and goggles, radio pack, armbands.
    const head = layer.group(avatar.head, 'grunt_helmet');
    layer.box(head, [0.38, 0.13, 0.39], [0, 0.135, 0.005], m.armor);
    layer.box(head, [0.4, 0.035, 0.41], [0, 0.075, 0.005], m.dark);            // rim
    layer.box(head, [0.06, 0.02, 0.34], [0, 0.205, 0.01], m.accent);          // stripe
    tintVisor(avatar, look.glow);                                               // team goggles
    const torso = layer.group(avatar.torso, 'grunt_kit');
    layer.box(torso, [0.3, 0.34, 0.13], [0, 0.0, 0.25], m.armor);              // radio pack
    layer.box(torso, [0.2, 0.06, 0.02], [0, 0.1, 0.32], m.accent);
    layer.box(torso, [0.018, 0.48, 0.018], [0.11, 0.38, 0.27], m.dark);        // whip antenna
    for (const [arm, side] of [[avatar.lArm, -1], [avatar.rArm, 1]]) {
      const g = layer.group(arm, 'grunt_band');
      layer.box(g, [0.175, 0.045, 0.195], [0, -0.13, 0], side < 0 ? m.accent : m.dark);
    }
  }
  for (const material of layer.materials) material.transparent = true;
  refreshAvatarMaterialLists(avatar);
}

// ---- module state ------------------------------------------------------------------------

let app = null;
let roster = null;
/** id → { serial, kind, team, buf: [{ t, x, y, z, yaw, hp, moving, crouch }], deadAt, dead, deadFed, gone, lastSeen, fireUntil } */
const tracks = new Map();
const named = new Set();
let latestT = null;
const remotes = new Map();

function ensureRoster() {
  if (roster || !app?.liveAvatarsGroup) return roster;
  const getBlock = typeof app?.vehicleView?.getBlock === 'function' ? app.vehicleView.getBlock : worldGetBlock;
  roster = new AvatarRoster({ scene: app.liveAvatarsGroup, getBlock,
    gore: (event, options) => app?.effects?.gore?.(event, options), getMyId: () => null });
  return roster;
}

/** Kill-feed names: the combat HUD learns every minion id once. */
function rememberNames(list) {
  const fresh = list.filter(entry => !named.has(entry.id));
  if (!fresh.length) return;
  for (const entry of fresh) named.add(entry.id);
  try { app?.hud?.combat?.setNames?.(fresh.map(entry => ({ id: entry.id, name: NPC_NAMES[entry.kind] }))); } catch { /* HUD optional */ }
}

export function init(appRef) {
  app = appRef ?? null;
}

/** Per authoritative snapshot: buffer each minion row by server time. */
export function tick(snapshot) {
  const rows = snapshot?.match?.titanfall?.npc;
  if (!Array.isArray(rows)) return;
  const t = Number.isFinite(snapshot.serverNow) ? snapshot.serverNow : Number.isFinite(snapshot.now) ? snapshot.now : nowMs();
  latestT = t;
  const seen = new Set(), fresh = [];
  for (const raw of rows) {
    const row = decodeNpcRow(raw);
    if (!row) continue;
    seen.add(row.id);
    let track = tracks.get(row.id);
    if (!track) {
      track = { serial: row.serial, kind: row.kind, team: row.team, buf: [], deadAt: null, dead: false, deadFed: false, gone: false, lastSeen: t, fireUntil: 0 };
      tracks.set(row.id, track);
      fresh.push(row);
    }
    const last = track.buf.at(-1);
    if (!last || t > last.t) {
      track.buf.push({ t, x: row.x, y: row.y, z: row.z, yaw: row.yaw, hp: row.hp, moving: row.moving, crouch: row.crouch });
      if (track.buf.length > SAMPLES) track.buf.shift();
    }
    if (row.firing) track.fireUntil = Math.max(track.fireUntil, nowMs() + FIRE_HOLD_MS);
    // The death shows when the presented time reaches this snapshot (frame()), not on arrival.
    if (row.dead && track.deadAt == null) track.deadAt = t;
    track.lastSeen = t;
    track.gone = false;
  }
  for (const [id, track] of tracks) if (!seen.has(id)) track.gone = true;
  rememberNames(fresh);
}

const lerpAngle = (a, b, u) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * u;

/** The track's pose at server time `t` (interpolated, clamped to the newest sample). */
function sample(track, t) {
  const buf = track.buf;
  if (!buf.length) return null;
  if (!(t > buf[0].t)) return { ...buf[0], speed: 0 };
  for (let i = buf.length - 1; i > 0; i--) {
    const a = buf[i - 1], b = buf[i];
    if (t >= a.t) {
      const span = b.t - a.t, u = span > 0 ? Math.min(1, (t - a.t) / span) : 1;
      const speed = span > 0 ? Math.hypot(b.x - a.x, b.z - a.z) / (span / 1000) : 0;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, yaw: lerpAngle(a.yaw, b.yaw, u),
        hp: b.hp, moving: b.moving, crouch: b.crouch, speed };
    }
  }
  return { ...buf.at(-1), speed: 0 };
}

/** Synthetic remote row in the AvatarRoster shape. */
function remoteRow(id, track, pose, now) {
  const weapon = NPC_WEAPONS[track.kind] ?? 'rifle';
  const firing = now < track.fireUntil && !track.dead;
  return { id, name: NPC_NAMES[track.kind], team: track.team, x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw,
    pitch: 0, hp: track.dead ? 0 : pose.hp, state: track.dead ? 'dead' : 'alive', weapon: WEAPON_IDS.indexOf(weapon),
    owned: [weapon], firing, ads: firing, crouch: !!pose.crouch && !pose.moving, grounded: true, vaulting: false,
    moveSpeed: pose.moving ? Math.min(6, pose.speed) : 0, proneT: 0, leanT: 0, reloading: false, charge: 0,
    vehicleId: null, swimming: false };
}

/** Per rendered frame: interpolate, sync the roster, dress new bodies, hide the name tags. */
export function frame(dt, ctx = {}) {
  if (!tracks.size && !roster) return;
  const r = ensureRoster();
  if (!r) return;
  const presented = app?.net?.presentedServerTime?.(typeof performance !== 'undefined' ? performance.now() : nowMs());
  const t = Number.isFinite(presented) ? presented
    : Number.isFinite(ctx?.nowMs) ? ctx.nowMs - FALLBACK_DELAY_MS : (latestT ?? 0) - FALLBACK_DELAY_MS;
  const now = nowMs();
  remotes.clear();
  const built = r._avatars;
  let builds = 0;
  for (const [id, track] of tracks) {
    if (!track.dead && track.deadAt != null && t >= track.deadAt + DEATH_EVENT_GRACE_MS) track.dead = true;
    // A row that left the wire: once its death has been shown (or it was removed alive), drop it.
    if (track.gone && (track.deadAt == null || track.deadFed) && t > track.lastSeen + 250) { tracks.delete(id); continue; }
    const pose = sample(track, t);
    if (!pose) continue;
    // Spread new bodies over frames: a squad of four is never built in one frame.
    if (built && !built.has(id) && !track.dead && ++builds > MAX_BUILDS_PER_FRAME) continue;
    remotes.set(id, remoteRow(id, track, pose, now));
    if (track.dead) track.deadFed = true;
  }
  r.sync(remotes, Math.max(0, Math.min(0.1, Number(dt) || 0)), now);
  const eye = ctx?.camera?.position ?? null;
  for (const avatar of r._avatars?.values?.() ?? []) {
    const track = tracks.get(avatar.id);
    if (!track) continue;
    applyNpcLook(avatar, track.kind, track.team);
    if (eye) setNpcLod(avatar, avatar.group.position.distanceTo(eye) > FAR_LOD_M);
  }
  r.hideLabels();
}

/** Far minions: role details hidden and no shadow (switched on band changes only). */
function setNpcLod(avatar, far) {
  if (avatar._npcFar === far) return;
  avatar._npcFar = far;
  for (const group of avatar._roleLayer?.groups ?? []) if (DETAIL_GROUPS.has(group.name)) group.visible = !far;
  avatar.group.traverse(object => {
    if (!object.isMesh) return;
    object.userData.npcCastShadow ??= object.castShadow;
    object.castShadow = far ? false : object.userData.npcCastShadow;
  });
}

/** Hits flinch the body, kills drop it, shots raise the gun. */
export function onEvent(event) {
  if (!event || typeof event.kind !== 'string') return;
  if (event.kind === 'hit' && isNpcId(event.victim)) {
    ensureRoster()?.hit(event.victim, event);
  } else if (event.kind === 'kill' && isNpcId(event.victim)) {
    const track = tracks.get(event.victim);
    if (track) track.dead = true;
    ensureRoster()?.death(event.victim, undefined, event);
  } else if (event.kind === 'shoot' && isNpcId(event.id)) {
    const track = tracks.get(event.id);
    if (track) track.fireUntil = nowMs() + FIRE_HOLD_MS;
  }
}

export function dispose() {
  roster?.dispose();
  roster = null;
  tracks.clear();
  named.clear();
  remotes.clear();
  latestT = null;
  app = null;
}

/** Test/capture hook: the live roster and tracks. */
export function debugState() { return { roster, tracks, remotes }; }
