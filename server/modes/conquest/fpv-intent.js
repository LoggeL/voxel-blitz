/**
 * The Conquest `fpv` intent (`{t:'conquest', fpv:1}`) and the policy's FPV
 * hooks. A living Engineer who deployed with the FPV gadget
 * (KITS.engineer.gadgets[2]) launches a drone, or cuts the link of the one he
 * flies (server/sim/fpv-drones.js). Every other kit or a downed body is
 * refused with an `fpv` event (ConquestPolicy.conquestIntent only passes the
 * intent on in the live phase).
 */
import { kitDeployable } from '../../../shared/conquest-kits.js';
import { FPV_RULES } from '../../../shared/fpv-rules.js';

const systemOf = policy => policy.engine?.vehicles?.fpv ?? null;

export function fpvIntent(policy, entity) {
  const fpv = systemOf(policy);
  if (!fpv || !entity) return false;
  if (kitDeployable(policy.roles.kitOf(entity) ?? 'assault', policy.roles.gadgetOf(entity)) !== FPV_RULES.type) {
    fpv._refuse(entity, 'kit');
    return false;
  }
  if (policy.roles.isDown?.(entity) === true) { fpv._refuse(entity, 'state'); return false; }
  return fpv.toggle(entity).ok === true;
}

/** A fresh loadout: the FPV Engineer's drones (FPV_RULES.drones), and any drone in the air goes. */
export function fpvLoadout(policy, entity, issued) {
  systemOf(policy)?.onLoadout(entity, !!issued && kitDeployable(issued.kit, issued.gadget) === FPV_RULES.type);
}

/** While `entity` flies a drone his hands are on the controller: no weapon fires. */
export function fpvOperating(policy, entity) {
  return !!systemOf(policy)?.linkedDrone(entity);
}

/** `cqf` on the player row: drones left, only for an FPV Engineer. */
export function fpvField(policy, entity) {
  const left = systemOf(policy)?.dronesLeft(entity?.id);
  return Number.isInteger(left) ? left : undefined;
}

/** Death, leaving or a team change: the drone goes with its operator. */
export function fpvRemoveOwner(policy, id) {
  systemOf(policy)?.removeOwner(id);
}

export function fpvRename(policy, priorId, nextId) {
  systemOf(policy)?.rename(priorId, nextId);
}

/** Support aura (roles._resupply): one drone back, at most every FPV_RULES.resupplyMs. */
export function fpvResupply(policy, entity, now) {
  return systemOf(policy)?.resupply(entity, now) === true;
}
