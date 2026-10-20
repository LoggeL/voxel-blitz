// Per-recipient tick text (server/protocol/snapshot.js serializeTick/tickTextFor):
// each recipient gets JSON.stringify(tick) with every other player row stripped
// of OWNER_ONLY_FIELDS, and its own row byte-identical to the full row.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { OWNER_ONLY_FIELDS, serializeTick, tickTextFor } from '../server/protocol/snapshot.js';

const strip = row => Object.fromEntries(Object.entries(row).filter(([key]) => !OWNER_ONLY_FIELDS.has(key)));
const expected = (tick, selfId) => JSON.stringify({ ...tick,
  players: tick.players.map(row => row && typeof row === 'object' && row.id !== selfId ? strip(row) : row) });

let tick = null;
const engine = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: getMapMeta('frontier'),
  broadcast: snapshot => { tick = snapshot; } });
const bots = attachBots(engine, 8);
let checked = 0, saved = 0;
for (let i = 0; i < 60 * 8; i++) {
  engine.step(TICK_MS);
  if (i % 11) continue;
  const serialized = serializeTick(tick);
  assert.equal(serialized.text, expected(tick, null), `tick ${i}: the shared text strips every row`);
  for (const row of tick.players) {
    const text = tickTextFor(serialized, row.id);
    assert.equal(text, expected(tick, row.id), `tick ${i}: ${row.id} gets its own full row`);
    assert.ok(text.includes(JSON.stringify(row)), `tick ${i}: ${row.id}'s own row is byte-identical`);
    checked++;
  }
  assert.equal(tickTextFor(serialized, 'nobody'), serialized.text, 'a recipient without a row gets the shared text');
  saved += JSON.stringify(tick).length - serialized.text.length;
}
assert.ok(checked > 0 && saved > 0, 'owner-only fields leave the shared text');
bots.dispose?.();

// Edge rows: no owner fields, null, undefined values and a tick without players.
const odd = { t: 'tick', now: 1, skip: undefined, fn: () => 0, players: [{ id: 'a', x: 1 }, null, { id: 'b', medkit: { ack: 2 }, x: undefined, credits: 5 }], events: [] };
const oddText = serializeTick(odd);
assert.equal(oddText.text, expected(odd, null));
assert.equal(tickTextFor(oddText, 'b'), JSON.stringify(odd));
assert.equal(tickTextFor(oddText, 'a'), expected(odd, 'a'));
const bare = { t: 'tick', now: 2 };
assert.equal(tickTextFor(serializeTick(bare), 'a'), JSON.stringify(bare));

console.log(`ok - snapshot owner fields: ${checked} recipient texts exact, ${Math.round(saved / Math.max(1, checked / 8))} B saved per tick (8 bots)`);
process.exit(0);
