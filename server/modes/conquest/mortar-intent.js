/**
 * The Conquest `mortar` intent (`{t:'conquest', mortar:1}`): a living Support
 * who deployed with the MORTAR gadget (KITS.support.gadgets[1]) places his
 * mortar and mans it (server/sim/mortars.js). Every other kit or a downed body
 * is refused with a `mortar` event (ConquestPolicy.conquestIntent only
 * passes the intent on in the live phase).
 */
import { kitDeployable } from '../../../shared/conquest-kits.js';
import { MORTAR_RULES } from '../../../shared/mortar-rules.js';

export function mortarIntent(policy, entity) {
  const mortars = policy.engine?.vehicles?.mortars;
  if (!mortars || !entity) return false;
  if (kitDeployable(policy.roles.kitOf(entity) ?? 'assault', policy.roles.gadgetOf(entity)) !== MORTAR_RULES.type) {
    mortars._refuse(entity, 'kit');
    return false;
  }
  if (policy.roles.isDown?.(entity) === true) { mortars._refuse(entity, 'state'); return false; }
  return mortars.deploy(entity).ok === true;
}
