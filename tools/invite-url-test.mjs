import assert from 'node:assert/strict';
import { PregameFlow } from '../public/js/session/pregame.js';

for (const mode of ['join', 'create', 'quick']) {
  let phase = 'menu';
  let options;
  const location = { href: 'https://example.test/play?debug=1&lobby=ABCDE#arena' };
  const state = { navigation: 'preserved' };
  const history = { state, replaceState(next, _, url) {
    assert.equal(next, state);
    location.href = new URL(url, location.href).href;
  } };
  const net = { on: () => () => {}, close() {}, connect: async (_, name, opts) => {
    assert.equal(new URL(location.href).searchParams.has('lobby'), false, 'code consumed before connecting');
    options = opts;
    return { lobby: { code: 'ABCDE' }, phase: 'waiting' };
  } };
  const flow = new PregameFlow({
    hud: { showJoinState() {}, showLobby() {}, updateLobby() {}, showLobbyStatus() {} },
    makeNet: () => net, getPhase: () => phase, setPhase: value => { phase = value; },
    isTornDown: () => false, unlockAudio: async () => {}, connectUrl: () => 'ws://example.test',
    closeNet() {}, writeName() {}, enterMenu() {}, detachGameplay() {}, enterLive() {}, location, history,
  });
  flow.replaceNet();
  await flow.begin({ mode, code: 'abcde', name: 'Test' });
  if (mode === 'join') {
    assert.equal(options.lobby, 'ABCDE', 'network admission retains the consumed code');
    flow._presentLobby(flow.attempt, { code: 'ABCDE', phase: 'waiting' });
    assert.equal(new URL(location.href).searchParams.has('lobby'), false, 'guest lobby updates do not restore code');
  }
  // A host lobby can still expose its share URL, but entering gameplay consumes it.
  location.href = 'https://example.test/play?debug=1&lobby=ABCDE#arena';
  const attempt = flow.attempt;
  attempt.mapBytes = new Uint8Array();
  attempt.lobbyState = { phase: 'live' };
  assert.equal(flow.maybeEnterLive(attempt), true);
  assert.equal(location.href, 'https://example.test/play?debug=1#arena');
  assert.equal(flow._rejoin.code, 'ABCDE', 'reconnection retains room code in memory');
}
console.log('INVITE URL: OK');
