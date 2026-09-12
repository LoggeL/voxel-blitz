import assert from 'node:assert/strict';
import { Client } from 'pg';
import { PostgresStore } from '../../server/persistence/postgres.js';
import { CareerService } from '../../server/career.js';
import { CAREER_REWARDS } from '../../shared/career.js';

export async function testRewardDurability(connectionString) {
  let store, blocker, career;
  try {
    store = await PostgresStore.open({ connectionString });
    career = await CareerService.create({ store });
    const guest = 'e'.repeat(64);
    await store.readProfile(guest);
    const player = { id: 'p1', input: {} }, victim = { id: 'p2', bot: false };
    const engine = { entities: new Map([['p1', player], ['p2', victim]]) };
    const client = { id: 'p1', profileId: guest, room: { engine } };
    const snapshot = { t: 'tick', now: 100, match: { mode: 'fun', phase: 'live' }, players: [{ id: 'p1', state: 'alive' }],
      events: [{ kind: 'kill', killer: 'p1', victim: 'p2' }] };
    blocker = new Client({ connectionString }); await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE vb_careers IN ACCESS EXCLUSIVE MODE');
    await store.client.query('SET statement_timeout = 100');
    const query = store.client.query.bind(store.client);
    let timeouts = 0;
    store.client.query = async (...args) => {
      try { return await query(...args); }
      catch (error) { if (error.code === '57014') timeouts++; throw error; }
    };
    const saving = career.observe(client, snapshot);
    const until = Date.now() + 5000;
    while ((!timeouts || store.healthy) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(timeouts, 1, 'exclusive table lock causes a real PostgreSQL statement timeout');
    assert.equal(store.healthy, false, 'delayed reward is not reported healthy');
    let flushed = false;
    const flushing = career.flush().then(() => { flushed = true; });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(flushed, false, 'flush waits for the original reward to commit');
    const queuedRead = store.readProfile(guest);
    await blocker.query('ROLLBACK');
    await saving; await flushing;
    assert.equal((await queuedRead).xp, 25, 'later reads cannot overtake a delayed reward');
    assert.equal(career.observe(client, snapshot), undefined, 'duplicate snapshot stays deduplicated');
    const receipt = (await blocker.query('SELECT id FROM vb_reward_receipts WHERE profile_id=$1', [guest])).rows[0].id;
    const delta = { ...CAREER_REWARDS.kill, kills: 1, matches: 0 };
    await Promise.all(Array.from({ length: 6 }, () => store.applyProgress(guest, delta, { operationId: receipt })));
    assert.equal((await store.readProfile(guest)).xp, 25, 'persisted receipt rejects repeated award attempts');
    await career.observe(client, { ...snapshot, now: 200 });
    const profile = await store.readProfile(guest);
    assert.equal(profile.xp, 50); assert.equal(profile.credits, 20); assert.equal(profile.kills, 2);
    assert.equal((await blocker.query('SELECT count(*) FROM vb_reward_receipts WHERE profile_id=$1', [guest])).rows[0].count, '2');
    assert.equal(store.healthy, true);
    await career.dispose(); await store.close(); store = null;

    store = await PostgresStore.open({ connectionString });
    career = await CareerService.create({ store });
    await blocker.query('ALTER TABLE vb_careers ADD CONSTRAINT test_reject_reward CHECK (kills <= 2) NOT VALID');
    await assert.rejects(career.observe(client, { ...snapshot, now: 300 }), { code: '23514' });
    assert.equal(store.healthy, false);
    assert.throws(() => store.assertAvailable(), /unavailable/);
    await assert.rejects(career.flush(), { code: '23514' });
    await assert.rejects(career.dispose(), { code: '23514' });
    await assert.rejects(store.close(), /reward could not be persisted/); store = null;
    const durable = (await blocker.query('SELECT xp, kills FROM vb_careers WHERE id=$1', [guest])).rows[0];
    assert.deepEqual(durable, { xp: '50', kills: '2' }, 'failed write changes neither progress nor receipt');
    assert.equal((await blocker.query('SELECT count(*) FROM vb_reward_receipts WHERE profile_id=$1', [guest])).rows[0].count, '2');
    await blocker.query('ALTER TABLE vb_careers DROP CONSTRAINT test_reject_reward');
    console.log('PostgreSQL: real reward timeout retries, receipt dedupe, positive control and permanent-error shutdown checks passed.');
  } finally {
    await blocker?.end().catch(() => {});
    await store?.close().catch(() => {});
  }
}
