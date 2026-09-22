import { runAudioContracts } from './audio-contracts.mjs';
import { runHudContracts } from './hud-contracts.mjs';
import { runInputContracts } from './input-contracts.mjs';
import { runLanceKnifeContracts } from './lance-knife-contracts.mjs';
import { runWeaponWheelContracts } from './weapon-wheel-contracts.mjs';
import { runNetClientContracts } from './netclient-contracts.mjs';
import { runViewmodelContracts } from './viewmodel-contracts.mjs';
import { runCombatFeedbackContracts } from './combat-feedback-contracts.mjs';
import { runPostProcessContracts } from './post-process-contracts.mjs';
import { installGlobals } from '../lib/install-globals.mjs';

export async function runClientContracts(ok) {
  runPostProcessContracts(ok);
  runCombatFeedbackContracts(ok);
  await runInputContracts(ok, installGlobals);
  await runWeaponWheelContracts(ok, installGlobals);
  await runLanceKnifeContracts(ok, installGlobals);
  await runViewmodelContracts(ok, installGlobals);
  await runAudioContracts(ok, installGlobals);
  await runHudContracts(ok, installGlobals);
  await runNetClientContracts(ok, installGlobals);
}
