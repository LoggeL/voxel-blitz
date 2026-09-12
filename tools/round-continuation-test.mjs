import assert from 'node:assert/strict';
import { RoundContinuation } from '../server/modes/round-continuation.js';
import { GameEngine } from '../server/game.js';
import { LobbyManager } from '../server/lobby.js';
import { GameplayUiFlow } from '../public/js/session/gameplay-ui.js';
import { NetClient } from '../public/js/engine/netclient.js';

for (const count of [1, 2, 3, 4, 5, 6, 10, 16, 30, 64]) {
  let now = 1000;
  const entities = new Map(Array.from({ length: count }, (_, i) => [String(i), { id: String(i) }]));
  entities.set('bot', { id: 'bot', bot: true });
  entities.set('npc', { id: 'npc', npcRole: 'runner' });
  const vote = new RoundContinuation(entities, () => now);
  vote.begin(); vote.sync();
  const required = Math.ceil(count * 0.4);
  assert.equal(vote.required, required);
  assert.equal(vote.endsAt, null);
  for (const id of ['bot', 'npc', 'outsider']) assert.equal(vote.approve(id, vote.id), false);
  assert.equal(vote.approve('0', 'old-round'), false);
  for (let i = 0; i < required; i++) {
    assert.equal(vote.endsAt, null);
    assert.equal(vote.approve(String(i), vote.id), true);
  }
  assert.equal(vote.endsAt, 6000);
  now = 3000;
  assert.equal(vote.approve('0', vote.id), true);
  assert.equal(vote.approved.size, required);
  assert.equal(vote.endsAt, 6000, 'duplicate votes cannot extend the countdown');
  const previous = vote.id;
  vote.begin(); vote.sync();
  assert.notEqual(vote.id, previous);
  assert.equal(vote.approve('0', previous), false);
  assert.equal(vote.endsAt, null);
}

{
  const entities = new Map(Array.from({ length: 30 }, (_, i) => [String(i), { id: String(i) }]));
  for (let i = 0; i < 6; i++) entities.set(`bot-${i}`, { id: `bot-${i}`, bot: true });
  const vote = new RoundContinuation(entities, () => 1000);
  vote.begin(); vote.sync();
  assert.equal(vote.results.length, 36);
  assert.equal(vote.snapshot().eligible, 30);
  assert.equal(vote.required, 12, 'six bots do not increase the human threshold');
  for (let i = 0; i < 6; i++) assert.equal(vote.approve(`bot-${i}`, vote.id), false);
  for (let i = 0; i < 9; i++) vote.approve(String(i), vote.id);
  assert.equal(vote.approved.size, 9);
  assert.equal(vote.endsAt, null, 'the design fixture with 9 of 30 waits for three more humans');
  vote.approve('9', vote.id); vote.approve('10', vote.id);
  assert.equal(vote.endsAt, null);
  vote.approve('11', vote.id);
  assert.equal(vote.endsAt, 6000);
}

{
  let now = 100;
  const entities = new Map(['a', 'b', 'c', 'd', 'e'].map(id => [id, { id, kills: 4 }]));
  const vote = new RoundContinuation(entities, () => now);
  vote.begin(); vote.approve('a', vote.id); vote.approve('b', vote.id);
  assert.equal(vote.endsAt, 5100);
  now = 5100;
  entities.set('f', { id: 'f' }); vote.sync();
  assert.equal(vote.endsAt, null, 'a join that raises the threshold cancels the countdown, even at its deadline');
  vote.approve('c', vote.id);
  assert.equal(vote.endsAt, 10100, 'regained quorum gets a full five seconds');
  entities.delete('a'); vote.sync();
  assert.equal(vote.approved.has('a'), false);
  assert.equal(vote.endsAt, 10100, 'departure keeps the deadline when quorum still holds');
  entities.delete('b'); vote.sync();
  assert.equal(vote.endsAt, null);
  entities.delete('d'); entities.delete('e'); vote.sync();
  assert.equal(vote.endsAt, 10100, 'lower participant count can establish quorum');
  assert.equal(vote.results.length, 5, 'the final scoreboard retains departed players');
  entities.get('c').kills = 90;
  assert.equal(vote.results.find(p => p.id === 'c').kills, 4, 'results preserve the round-end scores');
  entities.clear(); vote.sync();
  assert.equal(vote.endsAt, null, 'empty rooms cannot approve');
}

for (const mode of ['duel', 'tdm', 'gungame', 'snd', 'bastion']) {
  const engine = new GameEngine({ mode, ...(mode === 'bastion' ? { mapMeta: { id: 'reactor' } } : {}) });
  try {
    engine.addClient('human', 'Human'); engine.addClient('guest', 'Guest');
    const policy = engine.mode.policy;
    if (mode === 'duel') {
      const killer = engine.entities.get('human'); killer.kills = 4;
      engine.killPlayer(engine.entities.get('guest'), killer, 'rifle', false);
    } else if (mode === 'bastion') policy.finish(false, 'team');
    else if (mode === 'snd') { policy._startLive(); policy._finishRound('alpha', 'elimination'); }
    else policy._finishMatch(mode === 'tdm' ? 'alpha' : 'human');
    const result = engine.mode.matchSnapshot();
    assert.equal(result.phase, 'post', mode);
    assert.equal(result.phaseEndsAt, null, mode);
    engine.now += 60000; engine.mode.tick();
    assert.equal(engine.mode.phase, 'post', `${mode} must wait indefinitely for approval`);
    assert.equal(engine.mode.canMove(engine.entities.get('human')), false);
    assert.equal(engine.mode.canDamage(null, engine.entities.get('human')), false);
    assert.equal(engine.mode.approveContinuation('human', result.continuation.id), true);
    const deadline = engine.mode.phaseEndsAt;
    assert.equal(deadline, engine.now + 5000);
    engine.now = deadline - 1; engine.mode.tick();
    assert.equal(engine.mode.phase, 'post', mode);
    engine.now = deadline; engine.mode.tick();
    assert.equal(engine.mode.phase, ['snd', 'bastion'].includes(mode) ? 'prep' : 'live', mode);
    assert.equal(engine.mode.matchSnapshot().continuation, undefined);
    assert.equal(engine.mode.approveContinuation('human', result.continuation.id), false);
  } finally { engine.stop(); }
}

const manager = new LobbyManager({ sendJson: () => {}, sendFrame: () => {}, closeClient: () => {} });
try {
  const host = { id: 'host' }, guest = { id: 'guest' }, stranger = { id: 'stranger' };
  await manager.create(host, 'Host', 0, 'duel', 'depot');
  await manager.join(guest, 'Guest', host.room.code);
  assert.equal(manager.approveContinuation(host, 'premature'), false);
  manager.ready(host, true); manager.ready(guest, true); manager.start(host);
  const engine = host.room.engine; engine.stop();
  const killer = engine.entities.get('host'); killer.kills = 4;
  engine.killPlayer(engine.entities.get('guest'), killer, 'rifle', false);
  const id = engine.mode.matchSnapshot().continuation.id;
  assert.equal(manager.approveContinuation(stranger, id), false);
  assert.equal(manager.approveContinuation({ id: 'host', room: host.room, joined: true }, id), false,
    'matching player id without the admitted socket cannot vote');
  assert.equal(manager.approveContinuation(guest, id), true, 'dead guests can approve');
  assert.deepEqual(engine.mode.matchSnapshot().continuation.approved, ['guest']);
  manager.leave(guest);
  assert.equal(engine.mode.matchSnapshot().phaseEndsAt, null, 'disconnect removes the vote');
} finally { manager.stop(); }

{
  let callback, exits = 0, locks = 0, enabled, settings = 0;
  const gameplay = { running: true, alive: true, matchState: { phase: 'live' }, selfRow: { state: 'alive' } };
  const flow = new GameplayUiFlow({
    hud: { setupMatchContinuation: fn => { callback = fn; }, closeSettings() {},
      isBuyMenuOpen: () => false, openSettings: () => { settings++; } },
    input: { setGameplayEnabled: value => { enabled = value; }, consumeBuyMenuRequest() {},
      exit: () => { exits++; }, requestLock: () => { locks++; } },
    gameplay, lifecycle: { phase: 'live', liveActive: true },
    getNet: () => ({ approveContinuation: id => id === 'round' }),
  });
  flow.syncBuyMenuState(); assert.equal(enabled, true);
  gameplay.matchState.phase = 'post'; flow.syncBuyMenuState();
  assert.equal(enabled, false); assert.equal(exits, 1);
  flow.onPointerLockChange(false);
  assert.equal(settings, 0, 'unlocking for the result must not open settings');
  gameplay.alive = false;
  assert.equal(flow.pauseFromKeyboard(), true, 'dead players can still open the menu from results');
  assert.equal(settings, 1);
  gameplay.alive = true;
  flow.syncBuyMenuState(); assert.equal(exits, 1);
  assert.equal(callback('round'), true);
  gameplay.matchState.phase = 'live'; flow.syncBuyMenuState();
  assert.equal(enabled, true); assert.equal(locks, 1);
}

{
  const client = new NetClient(); let frame;
  client.isOpen = () => true; client.ws = { send: text => { frame = JSON.parse(text); } };
  assert.equal(client.approveContinuation('round-token'), true);
  assert.deepEqual(frame, { t: 'continue', roundId: 'round-token' });
  client.isOpen = () => false;
  assert.equal(client.approveContinuation('round-token'), false);
}
console.log('Round continuation passed: thresholds, duplicate/stale/forged votes, joins/disconnects, frozen scores, all five modes, input and wire contract.');
