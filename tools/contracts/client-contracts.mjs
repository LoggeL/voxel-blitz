import { runAudioContracts } from './audio-contracts.mjs';
import { runHudContracts } from './hud-contracts.mjs';
import { runInputContracts } from './input-contracts.mjs';
import { runNetClientContracts } from './netclient-contracts.mjs';
import { runViewmodelContracts } from './viewmodel-contracts.mjs';
import { runCombatFeedbackContracts } from './combat-feedback-contracts.mjs';

function installGlobals(values) {
  const saved = new Map();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

export async function runClientContracts(ok) {
  runCombatFeedbackContracts(ok);
  await runInputContracts(ok, installGlobals);
  await runViewmodelContracts(ok, installGlobals);
  await runAudioContracts(ok, installGlobals);
  await runHudContracts(ok, installGlobals);
  await runNetClientContracts(ok, installGlobals);
}
