// Server controllers of the Conquest map events (docs/conquest.md "Map
// events"): event id -> MapEventController subclass. Each event owns exactly
// its two slot lines (import, map entry); the comment lines between slots
// stay untouched so branches that each fill one merge without conflicts. An
// event without a controller runs the inert base class. Reserved slots
// (sluice, radar, trestle) stay empty until their branch fills them.

// slot dam:
import { DamController } from './dam.js';
// slot depot:
import { DepotController } from './depot.js';
// slot sluice:
import { SluiceController } from './sluice.js';
// slot radar:
import { RADAR_CONTROLLERS } from './radar.js';
// slot trestle:
import { TrestleController } from './trestle.js';
// slot comeback:
import { ComebackController } from './comeback.js';
// end of import slots

export const MAP_EVENT_CONTROLLERS = Object.freeze({
  // slot dam:
  dam: DamController,
  // slot depot:
  depot: DepotController, 'depot-w': DepotController,
  // slot sluice:
  'sluice-north': SluiceController, 'sluice-south': SluiceController,
  // slot radar:
  ...RADAR_CONTROLLERS,
  // slot trestle:
  trestle: TrestleController,
  // slot comeback:
  comeback: ComebackController,
  // end of map slots
});
