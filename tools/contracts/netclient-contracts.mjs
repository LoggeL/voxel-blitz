import { deeplyFrozen } from '../lib/assert.mjs';

export async function runNetClientContracts(ok, installGlobals) {
  // NetClient: admission frames normalize mode-map pairs, inbound state is
  // owned defensively, and gameplay frames remain guarded by socket state.
  {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instances = [];

      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.binaryType = '';
        FakeWebSocket.instances.push(this);
      }
      send(data) {
        if (this.readyState !== FakeWebSocket.OPEN) {
          throw new Error('send while fake socket is not open');
        }
        this.sent.push(data);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }
      message(data) {
        this.onmessage?.({ data });
      }
      close(code, reason) {
        this.readyState = FakeWebSocket.CLOSED;
        this.closeArgs = [code, reason];
        this.onclose?.();
      }
    }

    const restore = installGlobals({ WebSocket: FakeWebSocket });
    try {
      const { NetClient } = await import('../../public/js/engine/netclient.js');
      const connect = async (
        name,
        opts,
        expectedFrame,
        welcomeMode = 'fun',
        welcomeMap = 'foundry'
      ) => {
        const client = new NetClient();
        const maps = [];
        client.onMap = (bytes) => maps.push([...bytes]);
        const pending = client.connect('ws://voxel.test/ws', name, opts);
        const ws = FakeWebSocket.instances.at(-1);
        ws.open();
        ok(ws.binaryType === 'arraybuffer'
          && JSON.stringify(JSON.parse(ws.sent[0])) === JSON.stringify(expectedFrame),
        `${opts?.mode || 'quick'} sends the exact normalized initial admission frame`);

        ws.message(JSON.stringify({
          t: 'welcome',
          id: 17,
          name,
          mapBytes: 3,
          tickRate: 20,
          spawn: [1, 2, 3],
          lobby: opts?.mode === 'quick' || !opts
            ? null
            : { code: 'ZX9Q2', role: opts.mode === 'create' ? 'host' : 'guest' },
          phase: opts?.mode === 'quick' || !opts ? 'live' : 'waiting',
          gameMode: welcomeMode,
          map: welcomeMap,
        }));
        ws.message(Uint8Array.of(7, 8, 9).buffer);
        const welcome = await pending;
        ok(welcome.id === 17
          && welcome.gameMode === welcomeMode
          && welcome.map === welcomeMap
          && client.welcome === welcome
          && Object.isFrozen(welcome)
          && maps.length === 1
          && maps[0].join(',') === '7,8,9',
        `${opts?.mode || 'quick'} stores its mode-map welcome and pairs exactly one binary map`);
        return { client, ws };
      };

      const quick = await connect('QUICK', null, {
        t: 'join', name: 'QUICK', bots: 0,
      });
      quick.client.close();

      const compatible = await connect('HOST', {
        mode: 'create',
        bots: 4,
        gameMode: 'tdm',
        map: 'depot',
      }, {
        t: 'create',
        name: 'HOST',
        bots: 4,
        gameMode: 'tdm',
        map: 'depot',
      }, 'tdm', 'depot');
      compatible.client.close();

      const incompatible = await connect('HOST2', {
        mode: 'create',
        bots: 2,
        gameMode: 'snd',
        map: 'depot',
      }, {
        t: 'create',
        name: 'HOST2',
        bots: 2,
        gameMode: 'snd',
        map: 'foundry',
      }, 'snd', 'foundry');
      incompatible.client.close();

      const joined = await connect('GUEST', {
        mode: 'join',
        bots: 7,
        lobby: 'ZX9Q2',
        gameMode: 'tdm',
        map: 'depot',
      }, {
        t: 'join', name: 'GUEST', lobby: 'ZX9Q2',
      }, 'snd', 'citadel');

      const sentBeforeBuy = joined.ws.sent.length;
      joined.client.buyWeapon('smg');
      joined.client.buyWeapon('laser');
      joined.client.buyWeapon(null);
      ok(joined.ws.sent.length === sentBeforeBuy + 1
        && JSON.stringify(JSON.parse(joined.ws.sent.at(-1)))
          === JSON.stringify({ t: 'buy', weapon: 'smg' }),
      'NetClient sends one exact buy frame and rejects unknown weapon ids');

      joined.client.sendInput({
        keys: {
          forward: false,
          back: false,
          left: false,
          right: false,
          jump: false,
          crouch: false,
          sprint: false,
          interact: true,
        },
        yaw: 0.25,
        pitch: -0.1,
        weapon: 0,
        wantFire: false,
        wantAds: false,
        reload: false,
        viewAge: 80,
        throwGrenade: true,
        grenadeCharge: 0.6254,
      });
      const inputFrame = JSON.parse(joined.ws.sent.at(-1));
      ok(JSON.stringify(inputFrame) === JSON.stringify({
        t: 'input',
        seq: 1,
        keys: {
          f: false,
          b: false,
          l: false,
          r: false,
          jump: false,
          sprint: false,
          crouch: false,
          interact: true,
        },
        yaw: 0.25,
        pitch: -0.1,
        weapon: 0,
        wantFire: false,
        wantAds: false,
        reload: false,
        viewAge: 80,
        throwGrenade: true,
        grenadeCharge: 0.625,
      }),
      'NetClient sends the exact nested held-interaction and clamped grenade-charge frame');

      const emitted = [];
      joined.client.on('lobby', (state) => emitted.push(state));
      joined.ws.message(JSON.stringify({
        t: 'lobbyState',
        code: 'ZX9Q2',
        host: 17,
        phase: 'waiting',
        bots: 2,
        gameMode: 'snd',
        map: 'citadel',
        members: [
          null,
          5,
          { id: 17, name: 'GUEST', ready: true, bot: false, team: 'alpha' },
        ],
      }));
      const lobby = joined.client.latestLobbyState;
      ok(emitted.length === 1
        && lobby.selfId === 17
        && lobby.gameMode === 'snd'
        && lobby.map === 'citadel'
        && lobby.members.length === 1
        && lobby.members[0].name === 'GUEST'
        && Object.isFrozen(lobby)
        && Object.isFrozen(lobby.members)
        && Object.isFrozen(lobby.members[0]),
      'NetClient stores mode-map lobby state, filters malformed members, and freezes replacements');
      let mutationBlocked = false;
      try {
        lobby.members[0].name = 'MUTATED';
      } catch {
        mutationBlocked = true;
      }
      ok(mutationBlocked && lobby.members[0].name === 'GUEST',
        'frozen lobby members defensively reject consumer mutation');

      joined.ws.message(JSON.stringify({
        t: 'lobbyState',
        code: 'ZX9Q2',
        host: 17,
        phase: 'live',
        bots: 0,
        gameMode: 'snd',
        map: 'citadel',
        members: { invalid: true },
      }));
      ok(joined.client.latestLobbyState.phase === 'live'
        && joined.client.latestLobbyState.gameMode === 'snd'
        && joined.client.latestLobbyState.map === 'citadel'
        && joined.client.latestLobbyState.members.length === 0
        && joined.client.latestLobbyState !== lobby,
      'each lobbyState fully replaces prior state and defaults malformed members to empty');

      const firstOwned = ['revolver'];
      const firstBomb = { state: 'carried', site: null };
      const firstInteraction = { kind: 'plant', site: 'A', progress: 0.2 };
      joined.ws.message(JSON.stringify({
        t: 'tick',
        now: 1000,
        tick: 1,
        players: [{
          id: 23,
          name: 'RIVAL',
          team: 'bravo',
          hp: 100,
          state: 'alive',
          ads: true,
          crouch: true,
          mag: [6, 30, 8, 20, 50, 5],
          reserve: [4, 3, 3, 3, 3, 3],
          reloading: false,
          panic: 0.2,
          exhaustion: 0.3,
          pain: 0.4,
          spawnProtected: true,
          respawnAt: null,
          credits: 1900,
          owned: firstOwned,
          bomb: firstBomb,
          interaction: firstInteraction,
          grenades: 2,
          x: 2,
          y: 3,
          z: 4,
          yaw: 0,
          pitch: 0,
        }],
        events: [],
        match: {
          mode: 'snd',
          map: 'citadel',
          phase: 'prep',
          scores: { alpha: 4, bravo: 3 },
          bomb: {
            state: 'carried', carrier: '23', site: null,
            x: 2, y: 3, z: 4, explodeAt: null,
          },
        },
      }));
      joined.ws.message(JSON.stringify({
        t: 'tick',
        now: 1050,
        tick: 2,
        players: [{
          id: 23,
          name: 'RIVAL',
          team: 'bravo',
          hp: 100,
          state: 'alive',
          ads: false,
          crouch: false,
          mag: [5, 29, 8, 20, 50, 5],
          reserve: [4, 3, 3, 3, 3, 3],
          reloading: true,
          panic: 0.1,
          exhaustion: 0.2,
          pain: 0.25,
          spawnProtected: false,
          respawnAt: null,
          credits: 650,
          owned: ['revolver', 'smg'],
          bomb: { state: 'dropped', site: null },
          interaction: { kind: 'plant', site: 'A', progress: 0.8 },
          x: 4,
          y: 3,
          z: 4,
          yaw: 0.5,
          pitch: 0.1,
        }],
        events: [],
        match: {
          mode: 'snd',
          map: 'citadel',
          phase: 'live',
          scores: { alpha: 4, bravo: 3 },
          bomb: {
            state: 'dropped', carrier: null, site: null,
            x: 4, y: 3, z: 4, explodeAt: null,
          },
        },
      }));
      const view = joined.client.interpolate(performance.now());
      const rival = view.players.get(23);
      ok(rival.team === 'bravo'
        && rival.ads === true
        && rival.crouch === true
        && rival.mag[0] === 6
        && rival.reserve[1] === 3
        && rival.reloading === false
        && rival.panic === 0.2
        && rival.exhaustion === 0.3
        && rival.pain === 0.4
        && rival.spawnProtected === true
        && rival.respawnAt === null
        && rival.credits === 1900
        && rival.owned.join(',') === 'revolver'
        && rival.bomb.state === 'carried'
        && rival.interaction.progress === 0.2
        && rival.grenades === 2,
      'interpolation preserves the complete newest remote gameplay state alongside transforms');
      const retainedRival = joined.client.latestSnapshots[0].players[0];
      ok(Object.isFrozen(rival)
        && Object.isFrozen(rival.mag)
        && Object.isFrozen(rival.reserve)
        && Object.isFrozen(rival.owned)
        && Object.isFrozen(rival.bomb)
        && Object.isFrozen(rival.interaction)
        && Object.isFrozen(joined.client.latestSnapshots[0])
        && Object.isFrozen(joined.client.latestSnapshots[0].players)
        && Object.isFrozen(retainedRival)
        && Object.isFrozen(retainedRival.owned)
        && Object.isFrozen(retainedRival.bomb)
        && Object.isFrozen(retainedRival.interaction),
      'interpolated and retained player output objects are recursively frozen');
      const mutationThrows = (mutate) => {
        try {
          mutate();
        } catch (error) {
          return error instanceof TypeError;
        }
        return false;
      };
      ok(mutationThrows(() => rival.owned.push('sniper'))
        && mutationThrows(() => rival.mag.push(99))
        && mutationThrows(() => { rival.reserve[0] = 99; })
        && mutationThrows(() => { rival.bomb.state = 'exploded'; })
        && mutationThrows(() => { rival.interaction.progress = 1; }),
      'ESM consumers cannot mutate frozen interpolation output');
      const pristine = joined.client.interpolate(performance.now()).players.get(23);
      ok(pristine.owned.join(',') === 'revolver'
        && pristine.bomb.state === 'carried'
        && pristine.interaction.progress === 0.2
        && joined.client.latestSnapshots[0].players[0].owned.join(',') === 'revolver'
        && joined.client.latestSnapshots[0].players[0].bomb.state === 'carried'
        && joined.client.latestSnapshots[0].players[0].interaction.progress === 0.2,
      'rejected consumer mutations leave subsequent interpolation and retained snapshots pristine');
      ok(joined.client.latestMatch.phase === 'live'
        && joined.client.latestMatch.mode === 'snd'
        && deeplyFrozen(joined.client.latestMatch),
      'NetClient stores the newest immutable match replacement independently of render delay');

      const sentBeforeClose = joined.ws.sent.length;
      joined.client.close();
      joined.client.buyWeapon('rifle');
      joined.client.sendInput({ interact: true });
      ok(joined.ws.sent.length === sentBeforeClose
        && joined.client.welcome === null
        && joined.client.latestLobbyState === null
        && joined.client.latestMatch === null
        && joined.client.latestSnapshots.length === 0,
      'NetClient close clears stored session state and gates input and buy frames');
    } finally {
      restore();
    }
  }

  // Timing and sampling stay pure: stable links reduce buffer latency, noisy
  // links expand it, and packet gaps never extrapolate into teleport smears.
  {
    const { NetworkTiming } = await import('../../public/js/engine/network-timing.js');
    const { sampleRemoteTransform } = await import('../../public/js/engine/snapshot-smoothing.js');
    const stable = new NetworkTiming({ tickRate: 20 });
    for (let at = 0; at <= 2000; at += 50) stable.recordArrival(at);
    const stableDelay = stable.interpolationDelayMs;
    stable.beginPing(7, 100);
    stable.resolvePong(7, 142);
    stable.beginPing(8, 200);
    stable.resolvePong(8, 250);
    ok(stableDelay < 80
      && stable.readModel.pingMs >= 42
      && stable.readModel.pingMs <= 50
      && stable.readModel.pingHistory.join(',') === '42,50',
    'stable packet timing converges below the old fixed buffer and records measured RTT history');

    const mappedFirst = stable.mapServerTime(100, 1000);
    const mappedCompressed = stable.mapServerTime(150, 1012);
    ok(mappedCompressed - mappedFirst >= 48 && mappedCompressed - mappedFirst <= 52,
      'server-clock mapping preserves the 50 ms simulation step across compressed packet arrivals');

    const noisy = new NetworkTiming({ tickRate: 20 });
    let at = 0;
    for (const spacing of [50, 95, 12, 88, 24, 105, 18, 82, 30, 110, 16, 90]) {
      at += spacing;
      noisy.recordArrival(at);
    }
    ok(noisy.interpolationDelayMs > stableDelay && noisy.readModel.jitterMs > 20,
      'arrival jitter expands the adaptive buffer instead of forcing visible packet hitches');

    const previous = { x: 0, y: 2, z: 0, yaw: 0, pitch: 0, state: 'alive' };
    const current = { x: 0.4, y: 2, z: 0, yaw: 0.1, pitch: 0.05, state: 'alive' };
    const interpolated = sampleRemoteTransform(previous, current, 25, 0, 50);
    const extrapolated = sampleRemoteTransform(previous, current, 500, 0, 50);
    const teleported = sampleRemoteTransform(previous, { ...current, x: 20 }, 25, 0, 50);
    ok(Math.abs(interpolated.x - 0.2) < 1e-9
      && extrapolated.x <= 1.01
      && teleported.x === 20,
    'remote sampling interpolates normally, caps packet-gap extrapolation, and snaps discontinuities');
  }
}
