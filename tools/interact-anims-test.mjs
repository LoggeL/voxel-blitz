// Hold-to-use interaction animations (docs/conquest.md "Interaction
// animations"): the client state machine per kind (enter, work, the finishing
// beat or a quick cancel, the redraw), the wire `interaction` the server puts
// on every row (S&D, Bastion, Conquest revive / repair / map-event points),
// the third-person pose read from it, the first-person hands on the real rig
// and the planted charges in the world. Presentation only: no server timing
// is touched here.
import assert from 'node:assert/strict';
import { INTERACT_KINDS, interactKindOfVerb } from '../shared/interact-anim.js';
import { DAM_EVENT } from '../shared/map-events/dam.js';
import { fixtureMapEvent } from '../shared/map-events/fixture.js';
import { InteractAnim, INTERACT_ANIM, rowInteraction } from '../public/js/session/interact-anim.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { ConquestRoles } from '../server/modes/conquest/roles.js';
import { ConquestPolicy } from '../server/modes/conquest.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { makeAvatar, updateAvatarStancePose, updateAvatarWeaponPose } from '../public/js/avatar/avatar.js';
import { AVATAR_INTERACT, interactKneels, poseAvatarInteract, unposeAvatarInteract } from '../public/js/avatar/avatar-interact.js';
import { chargeBlink, chargeLedOn } from '../public/js/fx/charge-model.js';
import { plantedCharges } from '../public/js/fx/interact-props.js';
import { encodeMapEventRow, MAP_EVENT_PHASE } from '../shared/conquest-map-events.js';
import { installGlobals } from './lib/install-globals.mjs';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const R = INTERACT_ANIM;

// ------------------------------------------------------------ state machine --
/** Run a scripted hold: [ms, interaction|null, held] steps; returns each frame. */
const run = (anim, steps) => steps.map(([ms, interaction, held = true, opts = {}]) => ({ ms, ...anim.update(ms, { interaction, held, alive: true, ...opts }) }));
for (const kind of INTERACT_KINDS) {
  const hold = (p) => ({ kind, progress: p });
  const f = run(new InteractAnim(), [[0, null, false], [100, hold(0.02)], [100 + R.enterMs / 2, hold(0.1)], [100 + R.enterMs + 5, hold(0.2)],
    [1000, hold(0.96)], [1050, null], [1050 + R.finishMs[kind] / 2, null], [1050 + R.finishMs[kind] + 5, null],
    [1050 + R.finishMs[kind] + R.exitMs + 10, null]]);
  const [idle, start, mid, work, late, done, beat, out, back] = f;
  ok(idle.phase === 'idle' && !idle.weaponHidden && idle.level === 0, `${kind}: idle, the gun out`);
  ok(start.phase === 'enter' && start.weaponHidden && start.level < 0.05, `${kind}: the first served frame lowers the gun`);
  ok(mid.phase === 'enter' && mid.level > 0.3 && mid.level < 0.7, `${kind}: the hands rise over ${R.enterMs} ms`);
  ok(work.phase === 'work' && work.level === 1 && work.kind === kind, `${kind}: working at full level`);
  ok(late.progress === 0.96 && late.workS > 0.8, `${kind}: the loop clock runs from the start of the hold`);
  ok(done.phase === 'finish' && done.done && done.progress === 1, `${kind}: a hold that ran out ends in the finishing beat at once`);
  ok(beat.phase === 'finish' && beat.finish > 0.4 && beat.finish < 0.6, `${kind}: the beat runs ${R.finishMs[kind]} ms`);
  ok(out.phase === 'exit' && out.weaponHidden, `${kind}: then the hands go`);
  ok(back.phase === 'idle' && back.redraw && !back.weaponHidden, `${kind}: after ${R.exitMs} ms the gun draws again`);
  ok(kind === 'hack' ? work.dip === 0 : work.dip === R.dip[kind], `${kind}: the camera dips ${R.dip[kind]} m standing`);
}
{
  const hold = { kind: 'plant', progress: 0.5 };
  const released = run(new InteractAnim(), [[0, hold], [400, hold], [420, hold, false], [420 + R.cancelMs + 5, null, false]]);
  ok(released[2].phase === 'exit' && !released[2].done, 'a released key cancels at once, the server row still running');
  ok(released[3].phase === 'idle' && released[3].redraw && R.cancelMs < R.exitMs, `the cancel drops the hands in ${R.cancelMs} ms`);
  const late = run(new InteractAnim(), [[0, hold], [400, hold], [450, null], [400 + R.graceMs - 20, null], [400 + R.graceMs + 20, null]]);
  ok(late[3].phase === 'work' && late[4].phase === 'exit' && !late[4].done, `a row missing for under ${R.graceMs} ms keeps the work, longer cancels`);
  const broken = run(new InteractAnim(), [[0, hold], [300, { kind: 'plant', progress: 0.6 }], [320, null], [500, null]]);
  ok(broken[3].phase === 'exit' && !broken[3].done, 'a hold the server broke (hit, moved away) cancels short of the end');
  const anim = new InteractAnim();
  run(anim, [[0, hold], [300, hold]]);
  ok(anim.update(310, { interaction: hold, held: true, alive: false }).phase === 'idle' && !anim.frame.redraw, 'death drops the hands with no redraw');
  const again = run(new InteractAnim(), [[0, hold], [250, hold], [300, hold, false], [330, hold]]);
  ok(again[3].phase === 'enter' && again[3].level > 0.5, 'a new hold mid-drop rises from where the hands are');
  const calm = run(new InteractAnim(), [[0, hold, true, { reducedMotion: true }], [400, hold, true, { reducedMotion: true }]]);
  ok(calm[1].dip === 0 && calm[1].level === 1, 'reduced motion: no camera dip, the hands still work');
  const low = run(new InteractAnim(), [[0, hold, true, { crouched: true }], [400, hold, true, { crouched: true }]]);
  ok(Math.abs(low[1].dip - R.dip.plant / 4) < 1e-9, 'crouched or prone: a quarter of the dip');
}

// ------------------------------------------------------------------- wire --
{
  ok(['Plant charge', 'Defuse charge'].map(interactKindOfVerb).join() === 'plant,defuse', 'map-event verbs: plant, defuse');
  ok(interactKindOfVerb('USE') === 'hack' && interactKindOfVerb('Upload data') === 'hack', 'any other point verb is the hack (tablet) style');
  ok(DAM_EVENT.points.every(p => ['plant', 'defuse'].includes(interactKindOfVerb(p.verb)))
    && interactKindOfVerb(fixtureMapEvent({ anchor: { x: 0, y: 0, z: 0 } }).points[0].verb) === 'plant', 'every registered point animates as plant or defuse');
  const base = { id: 'p1', name: 'A', x: 1, y: 2, z: 3, yaw: 0, pitch: 0, hp: 100, state: 'alive' };
  const rows = makeSnapshot([{ ...base, interaction: { kind: 'revive', progress: 0.4567 } }, { ...base, id: 'p2', interaction: { kind: 'plant', site: 'a', progress: 0.2 } },
    { ...base, id: 'p3', interaction: { kind: 'dance', progress: 1 } }, { ...base, id: 'p4' }], [], [], 0).players;
  ok(rows[0].interaction?.kind === 'revive' && rows[0].interaction.progress === 0.457, 'the row carries a Conquest revive (progress to 0.001)');
  ok(rows[1].interaction.kind === 'plant' && rows[1].interaction.site === 'a' && rows[2].interaction === null && rows[3].interaction === null, 'S&D kinds as before, unknown kinds drop');
  ok(JSON.stringify(rows[0].interaction).length <= 48, 'an active hold costs under 48 bytes on its row (null otherwise, as before)');
  const remote = rowInteraction({ ...rows[0] });
  ok(remote?.kind === 'revive' && remote.progress === 0.457, 'third person reads the hold from the remote row');
  ok(rowInteraction({ ...rows[0], state: 'dead' }) === null && rowInteraction({ ...rows[0], vehicleId: 'v1' }) === null, 'no pose for a dead or seated row');
  // Conquest: the fresh revive or repair session, else the held map-event point (its verb names the kind).
  const roles = { now: 1000, rules: { supportIntentStaleMs: 350 }, _state: () => roles.state };
  roles.state = { session: { type: 'revive', lastIntentAt: 900, display: 0.5 } };
  ok(ConquestRoles.prototype.actionInteraction.call(roles, {}).kind === 'revive', 'a fresh revive session is the row interaction');
  roles.state.session.lastIntentAt = 600;
  ok(ConquestRoles.prototype.actionInteraction.call(roles, {}) === null, 'a stale session (key released) drops it at once');
  roles.state = { session: { type: 'repair', lastIntentAt: 990, display: 0.7 } };
  ok(ConquestRoles.prototype.actionInteraction.call(roles, {}).progress === 0.7, 'a repair carries the hull share');
  const policy = { mapEvents: { instances: [1], points: { heldBy: () => ({ verb: 'DEFUSE CHARGE', progress: 0.3 }) } }, roles: { actionInteraction: () => null } };
  ok(ConquestPolicy.prototype.interactionOf.call(policy, { id: 'p1' }).kind === 'defuse', 'a held dam point is a defuse');
  policy.mapEvents.instances = [];
  ok(ConquestPolicy.prototype.interactionOf.call(policy, { id: 'p1' }) === null, 'no events, no session: no interaction');
}

// ---------------------------------------------------------- third person --
{
  // Avatar labels use canvas; geometry and all pose transforms remain real Three.js.
  const restore = installGlobals({ document: { createElement: () => ({ getContext: () => new Proxy({}, { get: (o, k) => o[k] ?? (() => {}) }) }) } });
  const av = makeAvatar('t1', 'T', 'alpha');
  const step = (hold, frames) => {
    for (let i = 0; i < frames; i++) {
      updateAvatarWeaponPose(av, { weapon: 'rifle', crouching: interactKneels(hold), dt: 1 / 60, blend: 1 });
      unposeAvatarInteract(av);
      updateAvatarStancePose(av, { blend: 0.2 });
      poseAvatarInteract(av, hold, 1 / 60, i / 60);
    }
  };
  const torso0 = av.torso.rotation.x;
  step({ kind: 'plant', progress: 0.4 }, 40);
  ok(av.interactLevel > 0.95 && av.crouchPose > 0.9 && !av.weaponModel.root.visible, 'a planter kneels, the gun stowed');
  ok(av.interactProps.group.visible && av.interactProps.charge.root.visible, 'the charge shows in his hands');
  const hand = av.rHand.getWorldPosition(new THREE.Vector3());
  ok(hand.y < 0.6 && hand.z < -0.2, `his hands reach the floor in front (${hand.y.toFixed(2)} m)`);
  ok(av.torso.rotation.x - torso0 > 0.3, 'the torso leans over the work');
  step({ kind: 'plant', progress: 0.4 }, 400);
  ok(av.torso.rotation.x - torso0 < AVATAR_INTERACT.plant.lean + 0.3, 'the lean never builds up over a long hold');
  step(null, 40);
  ok(av.interactLevel < 0.02 && !av.interactProps.group.visible, 'a cancel eases back to the gun');
  step({ kind: 'hack', progress: 0.2 }, 30);
  ok(!interactKneels({ kind: 'hack' }) && av.interactProps.tablet.visible, 'hack stands with the tablet');
  restore();
}

// ---------------------------------------------------------- first person --
{
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 100);
  const rig = new ViewmodelRig(camera);
  rig.setWeapon('rifle');
  const anim = new InteractAnim();
  for (let i = 0; i < 30; i++) rig.update(1 / 60, { speed: 0, grounded: true });
  for (const kind of INTERACT_KINDS) {
    let frame;
    anim.reset();
    for (let at = 0; at < 600; at += 16) { frame = anim.update(at, { interaction: { kind, progress: at / 2000 }, held: true }); rig.update(1 / 60, { interact: frame, nowMs: at }); }
    ok(rig._interactHands.root.visible && !rig.content.visible && rig._interactHands.kind === kind, `${kind}: the hands up, the gun stowed`);
  }
  const hands = rig._interactHands;
  ok(hands.pliers.visible === false && hands.tablet.visible, 'per kind props: the tablet for hack, no pliers');
  anim.reset();
  let frame;
  for (let at = 0; at <= 900; at += 16) { frame = anim.update(at, { interaction: at < 400 ? { kind: 'revive', progress: 0.5 } : null, held: at < 400 }); rig.update(1 / 60, { interact: frame }); }
  ok(frame.phase === 'idle' && !hands.root.visible && rig.content.visible, 'after a cancel the gun is back');
  rig.dispose();
}

// ------------------------------------------------------------ world props --
{
  ok(chargeBlink(30000).periodMs > chargeBlink(8000).periodMs && chargeBlink(8000).periodMs > chargeBlink(2000).periodMs, 'the LED blinks faster as the fuse runs down');
  ok(chargeBlink(null).periodMs === chargeBlink(30000).periodMs, 'an unknown fuse blinks slowly');
  ok(chargeLedOn(0, 20000) && !chargeLedOn(600, 20000), 'phase-locked to the clock');
  const snd = plantedCharges({ mode: 'snd', bomb: { state: 'planted', x: 1, y: 2, z: 3, explodeAt: 41000 } }, 'dust2', 1000);
  ok(snd.length === 1 && snd[0].big && snd[0].armed && snd[0].leftMs === 40000, 'S&D: the planted bomb with its fuse');
  ok(plantedCharges({ mode: 'snd', bomb: { state: 'dropped', x: 1, y: 2, z: 3 } }, 'dust2')[0].armed === false
    && plantedCharges({ mode: 'snd', bomb: { state: 'carried', x: null } }, 'dust2').length === 0
    && plantedCharges({ mode: 'snd', bomb: { state: 'exploded', x: 1, y: 2, z: 3 } }, 'dust2').length === 0, 'dropped: unlit; carried or blown: none');
  const damIndex = 0;
  const row = encodeMapEventRow(damIndex, { phase: 'armed', progress: 0, team: 'alpha', leftMs: 12000, extra: [2, 0] });
  const dam = plantedCharges({ mode: 'conquest', conquest: { ev: [row] } }, 'redrock', null, [DAM_EVENT]);
  ok(dam.length === 1 && dam[0].key === 'dam:east' && dam[0].leftMs === 12000, 'Redrock: only the armed charge of the mask, with the fuse');
  ok(plantedCharges({ mode: 'conquest', conquest: { ev: [encodeMapEventRow(0, { phase: 'idle' })] } }, 'redrock', null, [DAM_EVENT]).length === 0
    && MAP_EVENT_PHASE.armed > 0, 'an idle dam shows no charge');
}

console.log(`interact anims: ${checks} checks ok`);
