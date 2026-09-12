import { WEAPONS } from '../../../shared/combatmath.js';
import { ModelViewer } from './model-viewer.js';

export class WeaponPreview extends ModelViewer {
  show(id, selection, loadout = {}) {
    super.show({ weapon: id, attachments: selection, loadout, label: WEAPONS[id]?.name || id });
  }
}
