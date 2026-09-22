// LobbyManager unit contracts driven through fake transport callbacks:
// reconnect grace, lobbyConfig shape, chat limits, ping coalescing, password
// attempt limits and the shared admission text sanitizers.
import assert from 'node:assert/strict';
import { LobbyManager, PASSWORD_FAILURE_LIMIT } from '../server/lobby.js';
import { CHAT_MAX_LENGTH, sanitizeChatText, sanitizeName } from '../server/protocol/admission.js';
import { NetClient } from '../public/js/engine/netclient.js';

const sent = [];
const closed = [];
const lobby = new LobbyManager({
  sendJson: (meta, frame) => { sent.push({ id: meta.id, frame }); return true; },
  sendFrame: () => true,
  closeClient: (meta, code) => { closed.push({ id: meta.id, code }); },
});
const framesFor = (id, t) => sent.filter(entry => entry.id === id && entry.frame.t === t).map(entry => entry.frame);

/** Run `fn` while capturing the timers it schedules instead of arming them. */
function captureTimers(fn) {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (callback, ms) => {
    timers.push({ callback, ms });
    return realSetTimeout(() => {}, 0);
  };
  try { fn(); } finally { globalThis.setTimeout = realSetTimeout; }
  return timers;
}

try {
  // Name and chat sanitizing share one invisible-character rule.
  assert.equal(sanitizeName('  Ali​ce\u0007  von   Hier ', 3), 'Alice von Hier');
  assert.equal(sanitizeName('A'.repeat(40), 1), 'A'.repeat(16), 'names clamp to 16 characters');
  assert.equal(sanitizeName('‮\u0000 ', 7), 'Rookie7', 'empty names fall back to Rookie plus ordinal');
  assert.equal(sanitizeName(42), 'Rookie', 'non-string names fall back without an ordinal');
  assert.equal(sanitizeChatText('  hi\u0000 there‮ \n'), 'hi there');
  assert.equal(sanitizeChatText('x'.repeat(500)).length, CHAT_MAX_LENGTH);
  assert.equal(sanitizeChatText(12), '');

  // lobbyConfig carries exactly the admission welcome's fields, including the
  // per-connection career data the client would otherwise lose.
  const mastery = { rifle: { kills: 12, headshots: 3 } };
  const weaponLoadout = { rifle: { optic: 'standard' } };
  const host = { id: 'host', mastery, weaponLoadout };
  assert.equal(await lobby.create(host, 'Host', 0, 'fun', 'foundry'), true);
  const room = host.room;
  const welcome = framesFor('host', 'welcome')[0];
  assert.ok(welcome.mastery && welcome.weaponLoadout, 'admission welcome carries career data');
  assert.equal(lobby.configure(host, { gameMode: 'fun', map: 'depot', bots: 0 }), true);
  const config = framesFor('host', 'lobbyConfig').at(-1);
  assert.deepEqual(Object.keys(config).filter(key => key !== 't').sort(),
    Object.keys(welcome).filter(key => key !== 't').sort(), 'lobbyConfig has the welcome key set');
  assert.deepEqual(config.mastery, welcome.mastery, 'map changes keep StatTrak mastery');
  assert.deepEqual(config.weaponLoadout, welcome.weaponLoadout);

  // An older server's lobbyConfig without mastery must not wipe the client's.
  const client = new NetClient();
  client._onText(JSON.stringify({ ...welcome, t: 'welcome' }));
  client.latestLobbyState = { phase: 'waiting' };
  client.id = welcome.id;
  client._onText(JSON.stringify({ ...config, mastery: undefined, weaponLoadout: undefined }));
  assert.deepEqual(client._pendingLobbyConfig.mastery, welcome.mastery, 'client keeps admission mastery');
  assert.deepEqual(client._pendingLobbyConfig.weaponLoadout, welcome.weaponLoadout);
  client.close();

  // Ready changes report the real remaining cooldown.
  assert.equal(lobby.ready(host, true), true);
  sent.length = 0;
  assert.equal(lobby.ready(host, false), false);
  assert.match(framesFor('host', 'error')[0].msg, /^Please wait [12] seconds? before changing ready status$/);

  // Chat: sanitized, room-scoped, burst of three, then one line per second.
  const peer = { id: 'peer' };
  assert.equal(await lobby.join(peer, 'Peer', room.code), true);
  const outsider = { id: 'outsider' };
  assert.equal(await lobby.create(outsider, 'Outsider', 0, 'fun', 'foundry'), true);
  sent.length = 0;
  assert.equal(lobby.chat(peer, '\u0007hello​ world '), true);
  assert.deepEqual(framesFor('host', 'chat')[0], { t: 'chat', id: 'peer', name: 'Peer', text: 'hello world' });
  assert.equal(framesFor('outsider', 'chat').length, 0, 'chat never leaves the room');
  assert.equal(lobby.chat(peer, '​ \u0000'), false, 'invisible-only lines are dropped');
  assert.equal(lobby.chat(peer, 'two'), true);
  assert.equal(lobby.chat(peer, 'three'), true);
  assert.equal(lobby.chat(peer, 'four'), false, 'a fourth line inside the burst is dropped');
  assert.equal(closed.some(entry => entry.id === 'peer'), false, 'throttled chat keeps the socket');
  room.members.get('peer').chatRefillAt -= 1000;
  assert.equal(lobby.chat(peer, 'later'), true, 'one line refills per second');
  assert.equal(lobby.chat(host, 'host line'), true, 'limits are per member');

  // Ping-only refreshes coalesce into one roster frame per room and window.
  sent.length = 0;
  const pingTimers = captureTimers(() => {
    for (let i = 0; i < 6; i++) { lobby.updatePing(host); lobby.updatePing(peer); }
  });
  assert.equal(pingTimers.length, 1, 'one pending ping refresh per room');
  assert.equal(framesFor('host', 'lobbyState').length, 0, 'pings do not broadcast immediately');
  room.pingBroadcastTimer = null;
  pingTimers[0].callback();
  assert.equal(framesFor('host', 'lobbyState').length, 1);
  assert.equal(framesFor('peer', 'lobbyState').length, 1);

  // Reconnect grace: an emptied room survives unlisted and without a host,
  // a rejoin cancels expiry and takes over hosting, and expiry destroys it.
  lobby.leave(peer);
  const graceTimers = captureTimers(() => lobby.leave(host, { reconnectable: true }));
  assert.equal(graceTimers.length, 1);
  assert.equal(graceTimers[0].ms, 30_000);
  assert.equal(lobby.rooms.get(room.code), room, 'the room survives a transport drop');
  assert.equal(room.host, '');
  assert.equal(lobby.list().some(entry => entry.code === room.code), false, 'empty rooms stay unlisted');
  const returning = { id: 'returning' };
  assert.equal(await lobby.join(returning, 'Returning', room.code), true);
  assert.equal(room.expiryTimer, null, 'a rejoin cancels expiry');
  assert.equal(room.host, 'returning', 'the first returning player hosts');
  const expiry = captureTimers(() => lobby.leave(returning, { reconnectable: true }));
  expiry[0].callback();
  assert.equal(room.destroyed, true);
  assert.equal(lobby.rooms.has(room.code), false, 'expiry destroys the room');
  lobby.leave(outsider);

  // Password rooms allow typos but refuse one requester's guessing once the window's limit is hit.
  const secretHost = { id: 'secret-host' };
  assert.equal(await lobby.create(secretHost, 'Secret', 0, 'fun', 'foundry', 'Room pass 42!'), true);
  const secretRoom = secretHost.room;
  const guesser = '203.0.113.7';
  for (let i = 0; i < 3; i++) {
    assert.equal(await lobby.join({ id: `typo-${i}`, remoteAddress: guesser }, 'Typo', secretRoom.code, 'wrong'), false);
  }
  assert.equal(await lobby.join({ id: 'friend', remoteAddress: guesser }, 'Friend', secretRoom.code, 'Room pass 42!'), true,
    'the correct password still works after a few typos');
  for (let i = 3; i < PASSWORD_FAILURE_LIMIT; i++) {
    assert.equal(await lobby.join({ id: `typo-${i}`, remoteAddress: guesser }, 'Typo', secretRoom.code, `guess-${i}`), false);
  }
  sent.length = 0;
  assert.equal(await lobby.join({ id: 'locked', remoteAddress: guesser }, 'Locked', secretRoom.code, 'Room pass 42!'), false);
  assert.match(framesFor('locked', 'error')[0].msg, /Too many incorrect lobby passwords/);
  assert.equal(closed.at(-1).code, 4003);
  assert.equal(await lobby.join({ id: 'other-friend', remoteAddress: '198.51.100.4' }, 'Other', secretRoom.code, 'Room pass 42!'), true,
    "a stranger's wrong guesses never lock other requesters out of the room");
  secretRoom.passwordFailures.get(guesser).until = 0;
  assert.equal(await lobby.join({ id: 'after-window', remoteAddress: guesser }, 'Later', secretRoom.code, 'Room pass 42!'), true,
    'the limit resets after its window');
} finally {
  lobby.stop();
}
console.log('Lobby manager: sanitizers, lobbyConfig shape, ready cooldown, chat limits, ping coalescing, reconnect grace and password limits passed.');
