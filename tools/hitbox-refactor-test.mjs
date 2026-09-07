import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { playerHitboxes, pointPlayerDistance, rayPlayerHitboxes } from '../shared/player-hitboxes.js';

// Frozen outputs from the pre-refactor implementation. The seeded query inputs
// cover all twelve weapons, standing/crouching/prone, reloads, ADS and motion.
// Each fixture is [pointDistance, ...hits]; hits are null or [t, zone, coreHit, radialDistance].
const expected = JSON.parse(await readFile(new URL('./fixtures/hitbox-queries.json', import.meta.url), 'utf8'));
assert.equal(expected.length, 96, 'every weapon covers all eight crouch/ADS/reload combinations');
let seed = 82315;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);
let contacts = 0;
let misses = 0;
for (let i = 0; i < expected.length; i++) {
  const p = {
    x: random() * 20, y: random() * 5, z: random() * 20, weapon: i % 12,
    yaw: random() * Math.PI * 2, pitch: random() * Math.PI - Math.PI / 2,
    crouch: !!(Math.floor(i / 12) & 1), ads: !!(Math.floor(i / 12) & 2),
    reloading: !!(Math.floor(i / 12) & 4),
    proneT: (i % 5) / 4, moveSpeed: random() * 6,
  };
  const origin = [p.x + random() * 4 - 2, p.y + random() * 2, p.z - 3];
  const direction = { x: p.x - origin[0], y: p.y + random() * 1.8 - origin[1], z: 3 };
  close(pointPlayerDistance(origin, p), expected[i][0]);
  const options = [{}, { radius: 0.18 }, { radius: 0.5, preferCore: true }, { radius: 0.18, minT: 0.5 }];
  for (let j = 0; j < options.length; j++) {
    const hit = rayPlayerHitboxes(origin, direction, p, 1, options[j]);
    const reference = expected[i][j + 1];
    if (!reference) {
      assert.equal(hit, null);
      misses++;
      continue;
    }
    assert.ok(hit);
    close(hit.t, reference[0]);
    assert.equal(hit.zone, reference[1]);
    assert.equal(hit.coreHit, reference[2]);
    close(hit.radialDistance, reference[3]);
    contacts++;
  }

  // Public geometry must stay independently owned across boxes and queries.
  const boxes = playerHitboxes(p);
  const copy = structuredClone(boxes);
  playerHitboxes({ ...p, yaw: p.yaw + 1, proneT: 1 - p.proneT });
  assert.deepEqual(boxes, copy);
}
assert.ok(contacts > 0 && misses > 0);
console.log(`Hitbox refactor: ${contacts} contacts, ${misses} misses, ${expected.length} point distances and independently owned pose geometry match.`);
