// Server controllers of the Conquest map events (docs/conquest.md "Map
// events"): event id -> MapEventController subclass. Each event owns exactly
// its two slot lines (import, map entry); the comment lines between slots
// stay untouched so branches that each fill one merge without conflicts. An
// event without a controller runs the inert base class.

// slot dam:
// import { DamController } from './dam.js';
// slot depot:
import { DepotController } from './depot.js';
// slot weir:
// import { WeirController } from './weir.js';
// slot relay:
import { RelayController } from './relay.js';
// slot elevator:
import { ElevatorController } from './elevator.js';
// slot quarry:
// import { QuarryController } from './quarry.js';
// slot comeback:
import { ComebackController } from './comeback.js';
// slot airdrop:
import { AirdropController } from './airdrop.js';
// end of import slots

export const MAP_EVENT_CONTROLLERS = Object.freeze({
  // slot dam:
  // dam: DamController,
  // slot depot:
  depot: DepotController,
  // slot weir:
  // weir: WeirController,
  // slot relay:
  relay: RelayController,
  // slot elevator:
  elevator: ElevatorController,
  // slot quarry:
  // quarry: QuarryController,
  // slot comeback:
  comeback: ComebackController,
  // slot airdrop:
  airdrop: AirdropController,
  // end of map slots
});
