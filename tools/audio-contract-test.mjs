import assert from 'node:assert/strict';
import { runAudioContracts } from './contracts/audio-contracts.mjs';
import { installGlobals } from './lib/install-globals.mjs';

let checks = 0;
await runAudioContracts((condition, message) => { assert.ok(condition, message); checks++; }, installGlobals);
console.log(`Audio lifecycle contracts: ${checks} checks passed.`);
