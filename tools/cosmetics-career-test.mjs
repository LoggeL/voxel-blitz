import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CAREER_CATALOG, careerItemState, careerView, cosmeticLoadout, normalizeCosmeticLoadout,
  equipCareerItem, reconcileCareerUnlocks, defaultCosmeticLoadout } from '../shared/career.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { emptyProfile, validateProfile } from '../server/persistence/career-profile.js';
import { CareerService } from '../server/career.js';
import { GameEngine } from '../server/game.js';

const directory = mkdtempSync(path.join(tmpdir(), 'vb-cosmetics-career-'));
const id = () => randomBytes(32).toString('hex');
let career = new CareerService({ directory });
const legacy = { xp: 19600, credits: 87, kills: 1500, matches: 23,
  owned: ['amber', 'rookie', 'arctic'], equipped: { theme: 'arctic', title: 'rookie' } };
try {
  const guest = id();
  writeFileSync(path.join(directory, `${guest}.json`), JSON.stringify(legacy));
  const migrated = career.profile(guest);
  for (const key of ['xp', 'credits', 'kills', 'matches']) assert.equal(migrated[key], legacy[key]);
  assert.equal(migrated.equipped.theme, 'arctic');
  assert.deepEqual(migrated.mastery, {}, 'historical kills cannot be invented as weapon attribution');
  assert.equal(migrated.pvpKills, 0);
  assert.equal(migrated.wins, 0);
  assert.ok(migrated.owned.includes('ignition') && migrated.owned.includes('arcade'), 'old profiles receive earned level rewards');
  assert.ok(!migrated.owned.includes('rifle-overdrive'), 'legacy level alone does not grant mastery rewards');

  for (const item of CAREER_CATALOG.filter(item => item.unlock === 'earned')) {
    const profile = emptyProfile();
    profile.xp = (item.level - 1) ** 2 * 100 - 1;
    if (item.masteryKills) profile.mastery[item.weapon] = { kills: item.masteryKills, headshots: 0 };
    if (item.pvpKills) profile.pvpKills = item.pvpKills;
    reconcileCareerUnlocks(profile);
    assert.ok(!profile.owned.includes(item.id), `${item.id} needs the exact level boundary`);
    profile.xp++;
    if (item.masteryKills) profile.mastery[item.weapon].kills--;
    if (item.pvpKills) profile.pvpKills--;
    reconcileCareerUnlocks(profile);
    if (item.masteryKills || item.pvpKills) assert.ok(!profile.owned.includes(item.id), `${item.id} needs both gates`);
    if (item.masteryKills) profile.mastery[item.weapon].kills++;
    if (item.pvpKills) profile.pvpKills++;
    reconcileCareerUnlocks(profile);
    assert.ok(profile.owned.includes(item.id));
    assert.equal(careerItemState(profile, item).eligible, true);
    assert.equal(profile.credits, 0, 'earned cosmetics never require a credit payment');
    assert.equal(reconcileCareerUnlocks(profile).length, 0, 'grants are idempotent');
    equipCareerItem(profile, item);
    assert.equal(careerItemState(profile, item).equipped, true);
  }

  const rifle = CAREER_CATALOG.find(item => item.id === 'rifle-overdrive');
  assert.throws(() => career.purchase(guest, rifle.id, true), /requirements/);
  career.award(guest, { pvpKills: 249, mastery: { rifle: { kills: 249, headshots: 47 } } });
  assert.ok(!career.profile(guest).owned.includes(rifle.id));
  career.award(guest, { pvpKills: 1, mastery: { rifle: { kills: 1, headshots: 1 } } });
  assert.ok(career.profile(guest).owned.includes(rifle.id));
  const equipped = career.purchase(guest, rifle.id, true);
  assert.equal(equipped.credits, legacy.credits);
  assert.equal(equipped.equipped.weaponSkins.rifle, rifle.id);
  equipped.mastery.rifle.kills = 0;
  equipped.equipped.weaponSkins.rifle = 'forged';
  assert.equal(career.profile(guest).mastery.rifle.kills, 250, 'views do not mutate authoritative mastery');
  assert.equal(career.profile(guest).equipped.weaponSkins.rifle, rifle.id);
  assert.throws(() => validateProfile({ ...careerView(career.profile(guest)), equipped: { ...career.profile(guest).equipped,
    weaponSkins: { revolver: rifle.id } } }), /cosmetics/, 'wrong weapon slots are rejected in persistence');
  const forged = { ...emptyProfile(), owned: ['amber', 'rookie', rifle.id], equipped: { ...emptyProfile().equipped, weaponSkins: { rifle: rifle.id } } };
  assert.throws(() => equipCareerItem(forged, rifle), /not been earned/);
  assert.deepEqual(cosmeticLoadout(forged), defaultCosmeticLoadout(), 'forged ownership cannot bypass earned gates');
  assert.deepEqual(normalizeCosmeticLoadout({ weaponSkins: { revolver: rifle.id, rifle: 'https://evil/skin' }, sound: 'ignition', signature: 'overdrive' }), defaultCosmeticLoadout());
  const beforeInvalid = careerView(career.profile(guest));
  assert.throws(() => career.award(guest, { mastery: { rifle: { kills: 0, headshots: 1 } } }), /mastery/);
  assert.throws(() => career.award(guest, { xp: Infinity }), /reward/);
  assert.deepEqual(careerView(career.profile(guest)), beforeInvalid, 'invalid rewards are atomic');

  const account = `account:${randomBytes(16).toString('hex')}`;
  const request = { headers: { cookie: `vb-career=${guest}` } };
  assert.equal(career.adoptGuest(request, { id: account.slice(8) }), true);
  assert.deepEqual(careerView(career.profile(account)), beforeInvalid, 'file guest claim preserves every cosmetic and mastery field');
  assert.equal(career.profile(guest), null);
  career.dispose();
  career = new CareerService({ directory });
  assert.deepEqual(careerView(career.profile(account)), beforeInvalid, 'new fields survive restart');
  career.purchase(account, 'standard', true, () => true, { slot: 'weaponSkin', weapon: 'rifle' });
  assert.deepEqual(career.profile(account).equipped.weaponSkins, {});
  assert.throws(() => career.purchase(account, 'standard', true, () => true, { slot: 'weaponSkin', weapon: '__proto__' }), /valid cosmetic/);

  const combatId = id(), client = { id: 'p1', profileId: combatId };
  let last;
  const engine = new GameEngine({ mode: 'gungame', broadcast(snapshot) { last = snapshot; career.observe(client, snapshot); } });
  client.room = { engine };
  engine.addClient('p1', 'Player');
  engine.addClient('p2', 'Human');
  const player = engine.entities.get('p1'), victim = engine.entities.get('p2');
  const acceptedWeapon = WEAPON_IDS[player.weapon];
  engine.killPlayer(victim, player, acceptedWeapon, true);
  engine.step();
  assert.notEqual(WEAPON_IDS[player.weapon], acceptedWeapon, 'Gun Game advances the selected weapon immediately');
  assert.deepEqual(career.profile(combatId).mastery[acceptedWeapon], { kills: 1, headshots: 1 }, 'mastery credits the kill weapon, not the next Gun Game stage');
  assert.equal(career.profile(combatId).pvpKills, 1);
  career.observe(client, last);
  assert.equal(career.profile(combatId).pvpKills, 1, 'duplicate frames award nothing');
  const snapshot = patch => ({ ...last, now: last.now += 1000, events: [], ...patch });
  victim.bot = true;
  career.observe(client, snapshot({ events: [{ kind: 'kill', killer: 'p1', victim: 'p2', w: acceptedWeapon, hs: true }] }));
  assert.equal(career.profile(combatId).kills, 2, 'bots retain normal lower-value career rewards');
  assert.equal(career.profile(combatId).pvpKills, 1, 'bots cannot farm PvP unlocks');
  assert.equal(career.profile(combatId).mastery[acceptedWeapon].kills, 1);
  victim.bot = false;
  victim.team = 'alpha';
  career.observe(client, snapshot({ players: [{ id: 'p1', team: 'alpha', state: 'alive' }], events: [{ kind: 'kill', killer: 'p1', victim: 'p2', w: 'rifle' }] }));
  career.observe(client, snapshot({ events: [{ kind: 'kill', killer: 'p1', victim: 'p1', w: 'rifle' }] }));
  career.observe(client, snapshot({ match: { mode: 'training', phase: 'live' }, events: [{ kind: 'kill', killer: 'p1', victim: 'p2', w: 'rifle' }] }));
  assert.equal(career.profile(combatId).pvpKills, 1, 'team kills, suicides and training award no mastery');

  const matchId = id(), matchClient = { id: 'p1', profileId: matchId, room: { engine } };
  player.input = { keys: { f: true } };
  let now = 0;
  const tick = (phase, winner = null) => career.observe(matchClient, { t: 'tick', now: now += 1000,
    players: [{ id: 'p1', team: 'alpha', state: 'alive' }], events: [], match: { mode: 'snd', phase, winner } });
  for (let i = 0; i < 8; i++) tick('live');
  tick('post'); tick('post');
  assert.equal(career.profile(matchId).wins, 0, 'S&D round wins are not match wins');
  for (let i = 0; i < 4; i++) tick('live');
  tick('post', 'alpha'); tick('post', 'alpha');
  assert.equal(career.profile(matchId).wins, 1);
  assert.equal(career.profile(matchId).matches, 1);

  career.purchase(account, rifle.id, true);
  let owner = account;
  career.accounts = { identity: () => owner ? { id: owner.slice(8) } : null };
  const meta = { id: 'owner', admittedProfileId: account, profileId: account, authRequest: { headers: {} } };
  const clients = new Map([[meta.id, meta]]);
  const frame = () => ({ t: 'tick', players: [{ id: meta.id }], events: [{ kind: 'kill', killer: meta.id, victim: 'other' }] });
  const view = career.decorateSnapshot(frame(), clients);
  assert.equal(view.players[0].cosmetics.weaponSkins.rifle, rifle.id);
  assert.equal(view.events[0].cosmetics.weaponSkins.rifle, rifle.id);
  career.purchase(account, 'standard', true, () => true, { slot: 'weaponSkin', weapon: 'rifle' });
  assert.deepEqual(career.decorateSnapshot(frame(), clients).players[0].cosmetics.weaponSkins, {}, 'equipping refreshes existing online snapshots');
  career.purchase(account, rifle.id, true);
  const pendingKill = { kind: 'kill', killer: meta.id, victim: 'other' };
  meta.room = { engine: { tickEvents: [pendingKill] } };
  career.detachClient(meta);
  clients.delete(meta.id);
  assert.equal(career.decorateSnapshot({ t: 'tick', players: [], events: [pendingKill] }, clients).events[0].cosmetics.weaponSkins.rifle, rifle.id,
    'kill signature is carried by the event after its owner disconnects');
  clients.set(meta.id, meta);
  owner = null;
  assert.deepEqual(career.decorateSnapshot(frame(), clients).players[0].cosmetics, defaultCosmeticLoadout(), 'session revocation clears cosmetics on live sockets');
  assert.equal(meta.profileId, null);

  let reads = 0;
  const database = await CareerService.create({ directory, store: { loadClaims: async () => [], assertAvailable() {},
    readProfile: async () => { reads++; throw new Error('unavailable'); } } });
  database.cacheLoadout(account, career.profile(account));
  await assert.rejects(database.readProfile(account), /unavailable/);
  assert.equal(database.loadouts.has(account), false, 'failed profile reads invalidate cached cosmetics');
  for (let i = 0; i < 20; i++) database.decorateSnapshot(frame(), clients);
  assert.equal(reads, 1, 'snapshot decoration does not query persistence');
  console.log('Cosmetics career: migration, all unlock boundaries, forged equipment, persistence, guest claim, real Gun Game attribution, bot exclusion, match wins, online refresh and revocation passed.');

  if (process.argv.includes('--postgres')) {
    const { postgresFixture } = await import('./lib/postgres-fixture.mjs');
    const { PostgresStore } = await import('../server/persistence/postgres.js');
    const { Client } = await import('pg');
    const fixture = await postgresFixture();
    let admin, store;
    try {
      // Seed the deployed v1 schema verbatim to prove an upgrade, not only a new install.
      admin = new Client({ connectionString: fixture.connectionString });
      await admin.connect();
      const schema = readFileSync(new URL('../server/persistence/schema.sql', import.meta.url), 'utf8');
      await admin.query(schema);
      await admin.query('INSERT INTO vb_schema_migrations(version,checksum) VALUES (1,$1)', [createHash('sha256').update(schema).digest('hex')]);
      const pgGuest = id();
      await admin.query('INSERT INTO vb_careers(id,xp,credits,kills,matches,owned,equipped) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [pgGuest, legacy.xp, legacy.credits, legacy.kills, legacy.matches, JSON.stringify(legacy.owned), JSON.stringify(legacy.equipped)]);
      store = await PostgresStore.open({ connectionString: fixture.connectionString });
      assert.deepEqual((await admin.query('SELECT version FROM vb_schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2]);
      assert.deepEqual(await store.readProfile(pgGuest), validateProfile(legacy), 'PostgreSQL upgrades preserve old profiles and grant level rewards');
      const delta = { pvpKills: 250, mastery: { rifle: { kills: 250, headshots: 51 }, revolver: { kills: 5, headshots: 0 } }, wins: 4 };
      const receipt = randomUUID();
      await store.applyProgress(pgGuest, delta, { operationId: receipt });
      await store.applyProgress(pgGuest, { ...delta, mastery: { revolver: delta.mastery.revolver, rifle: delta.mastery.rifle } }, { operationId: receipt });
      assert.equal((await store.readProfile(pgGuest)).mastery.rifle.kills, 250, 'SQL receipt dedupe covers mastery regardless of JSON key order');
      const pgView = await store.purchase(pgGuest, rifle.id, true);
      assert.equal(pgView.equipped.weaponSkins.rifle, rifle.id);
      assert.equal(pgView.credits, legacy.credits);
      await assert.rejects(store.purchase(pgGuest, 'revenant', false), /requirements/);
      const pgAccount = `account:${randomBytes(16).toString('hex')}`;
      await admin.query('INSERT INTO vb_accounts(id,username,password,recovery_hash,auth_version,created_at_ms,updated_at_ms) VALUES($1,$2,$3,$4,1,1,1)',
        [pgAccount.slice(8), 'CosmeticTester', '{}', 'a'.repeat(64)]);
      const claim = await store.claimGuest(pgGuest, pgAccount, emptyProfile());
      assert.deepEqual(careerView(claim.profile), pgView, 'SQL guest claim carries current committed mastery and equipment');
      await store.close(); store = await PostgresStore.open({ connectionString: fixture.connectionString });
      assert.deepEqual(careerView(await store.readProfile(pgAccount)), pgView, 'new SQL fields survive restart');
      assert.equal(await store.readProfile(pgGuest), null);
      const cleared = await store.purchase(pgAccount, 'standard', true, () => true, { slot: 'weaponSkin', weapon: 'rifle' });
      assert.deepEqual(cleared.equipped.weaponSkins, {});
      console.log('Cosmetics PostgreSQL: real v1-to-v2 migration, durable automatic grants, mastery receipts, equip/reset, guest transfer and restart passed.');
    } finally {
      await store?.close();
      await admin?.end();
      await fixture.close();
    }
  }
} finally {
  career.dispose();
  rmSync(directory, { recursive: true, force: true });
}
