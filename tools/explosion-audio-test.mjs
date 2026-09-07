import assert from 'node:assert/strict';
import { VoicePool } from '../public/js/audio/voices.js';

class Node {
  constructor() {
    this.gain = { value: 1 };
    this.positionX = this.positionY = this.positionZ = { setValueAtTime() {} };
  }
  connect(target) { return target; }
  disconnect() { this.disconnected = true; }
}

const ctx = {
  currentTime: 0,
  state: 'running',
  createGain: () => new Node(),
  createPanner: () => new Node(),
};
const pool = new VoicePool({ ctx, bus: {}, _registerVoicePool() {} });
const at = (priority = 0) => ({ pos: [0, 0, 0], priority });

try {
  const blast = pool.acquire(at(2), 2.2);
  let blastCleanups = 0;
  pool.addCleanup(blast, () => { blastCleanups++; });
  for (let i = 0; i < 80; i++) pool.acquire(at(), 0.5);
  assert.equal(ctx.currentTime, 0, 'all terrain debris arrives in the same audio frame');
  assert.equal(blast.disconnected, undefined, 'blast survives 80 block impacts in one snapshot');
  assert.equal(blastCleanups, 0, 'live blast source cleanup is not called');
  assert.equal(pool._positional.length, 16, 'positional cap remains bounded');
  assert.equal(pool._voices.length, 16, 'evicted debris also leaves the global pool');
  assert.equal(pool._cleanupTimers.size, 16, 'evicted debris timers are canceled');

  for (let i = 0; i < 100; i++) pool.acquire(null, 0.5);
  assert.equal(blast.disconnected, undefined, 'blast also survives global pool pressure');
  assert.equal(pool._voices.length, 48, 'global cap remains bounded');
  assert.equal(pool._cleanupTimers.size, 48, 'global cleanup timers remain bounded');
  pool.disposeAll();
  assert.equal(blastCleanups, 1, 'blast cleanup runs exactly once on disposal');

  const important = Array.from({ length: 16 }, () => pool.acquire(at(2), 2.2));
  const quiet = pool.acquire(at(), 0.5);
  let quietCleanups = 0;
  pool.addCleanup(quiet, () => { quietCleanups++; });
  assert.ok(important.every((voice) => !voice.disconnected),
    'a full important positional pool rejects lower-priority arrivals');
  assert.equal(quiet.disconnected, true, 'rejected incoming output is disconnected');
  assert.equal(quietCleanups, 1, 'late cleanup registration immediately releases rejected sources');
  assert.equal(pool._positional.length, 16);
  const newBlast = pool.acquire(at(2), 2.2);
  assert.equal(important[0].disconnected, true, 'equal-priority blasts evict the oldest blast');
  assert.ok(important.slice(1).every((voice) => !voice.disconnected));
  assert.equal(newBlast.disconnected, undefined);
  pool.disposeAll();

  const globalImportant = Array.from({ length: 48 }, () => pool.acquire({ priority: 2 }, 2.2));
  assert.equal(pool.acquire(null, 0.5).disconnected, true,
    'an all-important global pool rejects a lower-priority arrival');
  assert.ok(globalImportant.every((voice) => !voice.disconnected));
  const newest = pool.acquire({ priority: 2 }, 2.2);
  assert.equal(globalImportant[0].disconnected, true, 'equal-priority global voices retain FIFO');
  assert.equal(newest.disconnected, undefined);
  assert.equal(pool._voices.length, 48);
  pool.disposeAll();

  const normal = Array.from({ length: 16 }, () => pool.acquire(at(), 0.5));
  pool.acquire(at(), 0.5);
  assert.equal(normal[0].disconnected, true, 'ordinary positional voices retain FIFO');
  assert.ok(normal.slice(1).every((voice) => !voice.disconnected));
  pool.disposeAll();

  const expired = pool.acquire(at(2), 0.5);
  ctx.currentTime = 1.1;
  pool.acquire(at(), 0.5);
  assert.equal(expired.disconnected, true, 'priority never retains an expired blast');
} finally {
  pool.disposeAll();
}
assert.equal(pool._voices.length, 0);
assert.equal(pool._cleanupTimers.size, 0);
console.log('Explosion audio: same-frame debris, priority, FIFO, caps and disposal passed.');
