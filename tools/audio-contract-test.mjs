import assert from 'node:assert/strict';
import { runAudioContracts } from './contracts/audio-contracts.mjs';

function installGlobals(values) {
  const saved = new Map();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

let checks = 0;
await runAudioContracts((condition, message) => { assert.ok(condition, message); checks++; }, installGlobals);
console.log(`Audio lifecycle contracts: ${checks} checks passed.`);
