// Real DOM contracts for per-frame HUD writes and authoritative updates.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = startServer({ cwd: root, failureContext: 'HUD runtime contracts' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/js/ui/hud-support.js`);
  const result = await browser.page.evaluate(`(async () => {
    const { HUD } = await import('/js/ui/hud.js');
    const { NetworkHud } = await import('/js/ui/network-hud.js');
    const { setDisplaySetting } = await import('/js/ui/display-settings.js');
    let checks = 0;
    const expect = (condition, label) => {
      if (!condition) throw new Error(label);
      checks++;
    };
    const mutations = (target, action) => {
      const observer = new MutationObserver(() => {});
      observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
      action();
      const count = observer.takeRecords().length;
      observer.disconnect();
      return count;
    };
    document.body.innerHTML = '';
    const hud = new HUD();
    hud.buildHUD();
    const m = hud.gameplay.match.dom;
    const self = { id: 'a', name: 'SELF', kills: 1, deaths: 0, score: 0,
      hp: 100, state: 'alive', team: 'alpha', credits: 800, owned: [] };
    const opponent = { id: 'b', name: 'OTHER', kills: 2, deaths: 0, hp: 100,
      state: 'alive', team: 'bravo' };
    const players = [self, opponent];
    const match = { mode: 'fun', phase: 'live', map: 'foundry' };
    const paint = (now = 1000) => hud.setMatchState(match, self, players, now);
    paint();
    const idleMatchMutations = mutations(document.getElementById('hud'), () => {
      for (let frame = 0; frame < 240; frame++) paint(1000 + frame * 16);
    });
    expect(idleMatchMutations === 0, 'unchanged live FFA frames must not mutate HUD DOM');
    self.kills = 4;
    opponent.kills = 0;
    self.credits = 12000;
    match.map = 'killhouse';
    paint();
    expect(m.phaseLabel.textContent === '#1 · 4 KILLS', 'in-place kill changes update the live rank');
    expect(m.mapBadge.textContent === 'KILLHOUSE', 'in-place map changes update the map badge');
    expect(m.creditsVal.textContent.replace(/\\D/g, '') === '12000', 'in-place credits update');

    Object.assign(match, { mode: 'snd', phase: 'prep', round: 2,
      phaseEndsAt: 10000, scores: { alpha: 1, bravo: 2 }, attackers: 'alpha' });
    paint();
    expect(m.clock.textContent === '0:09' && m.phaseLabel.textContent === 'R2 · BUY', 'SND prep clock and round');
    expect(m.alphaRole.classList.contains('vb-role-attack'), 'SND attack role styling');
    const idleSndMutations = mutations(document.getElementById('hud'), () => {
      for (let frame = 0; frame < 120; frame++) paint(1000 + frame);
    });
    expect(idleSndMutations === 0, 'unchanged rounded SND clock does not rewrite text nodes');
    match.scores.alpha = 3;
    match.phase = 'live';
    self.interaction = { kind: 'plant', site: 'b', progress: 0.25 };
    paint(2000);
    expect(m.alphaScore.textContent === '3' && m.clock.textContent === '0:08', 'live team scores and phase clock update');
    expect(m.interactFill.style.width === '25%' && m.interactLabel.textContent === 'PLANTING BOMB [SITE B]...', 'live interaction progress');
    self.interaction.progress = 0.61;
    match.bomb = { state: 'planted', site: 'b', explodeAt: 5000 };
    match.attackers = 'bravo';
    paint(2300);
    expect(m.clock.textContent === '2.7s' && m.clock.classList.contains('vb-clock-urgent'), 'planted fuse uses authoritative server time');
    expect(m.interactFill.style.width === '61%' && m.alphaRole.classList.contains('vb-role-defend'), 'in-place interaction and side changes');
    paint(2400);
    expect(m.clock.textContent === '2.6s', 'unchanged snapshot still advances the fuse');
    self.hp = 0;
    self.state = 'dead';
    paint(2400);
    expect(m.interactBar.style.display === 'none' && m.interactFill.style.width === '0%', 'death clears an active interaction');
    expect(m.playerStatus.querySelector('.is-dead') !== null, 'in-place death updates player status');

    self.hp = 100;
    self.state = 'alive';
    delete self.interaction;
    Object.assign(match, { mode: 'duel', scores: { a: 6, b: 1 }, killLimit: 7 });
    paint();
    expect(m.alphaName.textContent === 'SELF' && m.alphaRole.textContent === 'YOU' && m.alphaScore.textContent === '6', 'duel participant and authoritative score');
    expect(m.alphaRole.className === 'vb-team-role' && m.bravoRole.className === 'vb-team-role', 'SND role colors clear on duel');
    expect(!m.clock.classList.contains('vb-clock-urgent') && m.clock.style.display === 'none', 'bomb urgency clears on mode exit');
    match.scores.a = 7;
    self.name = 'RENAMED';
    paint();
    expect(m.alphaScore.textContent === '7' && m.alphaName.textContent === 'RENAMED', 'in-place duel score and name update');
    match.mode = 'gungame';
    self.score = 2;
    paint();
    expect(m.phaseLabel.textContent.startsWith('WEAPON 3 / '), 'Gun Game weapon level follows live score');
    match.mode = 'training';
    paint();
    expect(m.header.style.display === 'none', 'training hides the match header');

    Object.assign(match, { mode: 'ttt', phase: 'prep', waiting: { have: 1, need: 3 } });
    paint();
    expect(m.header.parentNode.dataset.tttUnarmed === 'true' && m.phaseLabel.textContent === 'WARTE AUF SPIELER (1/3)', 'TTT unarmed and waiting status');
    self.owned.push('rifle');
    match.waiting.have = 2;
    paint();
    expect(m.header.parentNode.dataset.tttUnarmed === 'false' && m.phaseLabel.textContent === 'WARTE AUF SPIELER (2/3)', 'in-place ownership and waiting changes');
    match.phase = 'live';
    delete match.waiting;
    self.ttt = { role: 'traitor' };
    paint(3000);
    expect(m.clock.textContent === '0:07' && m.phaseLabel.textContent === 'TRAITOR', 'TTT live clock and role');
    expect(document.getElementById('killfeed').dataset.ttt === 'true', 'TTT killfeed privacy attribute');

    Object.assign(match, { mode: 'bastion', bastion: { core: { name: 'CORE', hp: 100, maxHp: 100 },
      stage: { kind: 'extract', name: 'FINAL', holdEndsAt: 15000 }, credits: 800,
      alive: 2, remaining: 2, ready: 1, defenders: 1 } });
    paint(1000);
    expect(m.phaseLabel.classList.contains('vb-bastion-urgent'), 'Bastion extraction becomes urgent');
    match.mode = 'tdm';
    match.scores = { alpha: 2, bravo: 4 };
    paint();
    expect(!m.phaseLabel.classList.contains('vb-bastion-urgent') && m.coreBar.hidden, 'Bastion warning and objective bar clear on mode exit');
    expect(m.alphaName.textContent === 'ALPHA' && m.alphaRole.textContent === '' && m.bravoScore.textContent === '4', 'TDM team display restores');
    hud.gameplay.match.reset();
    expect(m.header.parentNode.dataset.mode === 'fun' && m.header.parentNode.dataset.tttUnarmed === 'false', 'reset clears match privacy state');

    const state = { hp: 100, alive: true, wid: 'sniper', wname: 'SNIPER',
      mag: 5, reserve: 3, grenades: [2, 1, 1], grenadeType: 0, grenadeReady: 0,
      yawDeg: 0, adsT01: 1, scopeActive: true, scopeZoom: 4,
      crosshairX: 0.6, crosshairY: 0.4, breath01: 1, panic: 0, pain: 0 };
    hud.setState(state);
    await new Promise(requestAnimationFrame);
    hud.setState(state);
    const scope = hud.gameplay.dom.scope;
    const idleScopeMutations = mutations(scope, () => {
      for (let frame = 0; frame < 240; frame++) hud.setState(state);
    });
    expect(idleScopeMutations === 0, 'unchanged scoped frames do not rewrite scope attributes');
    state.crosshairX = 0.7;
    hud.setState(state);
    expect(scope.style.getPropertyValue('--scope-aim-x') === '20vw', 'scope follows changed authoritative aim');
    hud.gameplay.resetScope();
    hud.setState(state);
    expect(scope.classList.contains('active') && scope.style.opacity === '1', 'scope restores after another controller resets presentation');
    scope.classList.add('exiting');
    scope.style.opacity = '0.5';
    scope.style.transform = 'scale(1.02)';
    state.alive = false;
    hud.setState(state);
    expect(!scope.classList.contains('active') && !scope.classList.contains('exiting')
      && scope.style.opacity === '' && scope.style.transform === '', 'death hides scope and clears transition residue');
    hud.dispose();

    for (const setting of ['showPing', 'showFps', 'showNetwork']) setDisplaySetting(setting, true);
    const net = new NetworkHud();
    net.build(document.body);
    Object.defineProperties(net.root, { offsetTop: { value: 8 }, offsetHeight: { value: 70 } });
    const stats = { pingMs: 35, jitterMs: 2, bufferMs: 50, pingHistory: [31, 91, 161] };
    const frameStats = { ready: true, renderedFps: 60, targetFps: 60,
      limit: { label: 'DISPLAY LIMIT', detail: '60 Hz display' } };
    net.update(1 / 60, stats, 1000, frameStats);
    const idleNetworkMutations = mutations(document.documentElement, () => {
      for (let sample = 0; sample < 40; sample++) net.update(1 / 60, stats, 1250 + sample * 250, frameStats);
    });
    expect(idleNetworkMutations === 0, 'unchanged telemetry samples do not mutate DOM, including fractional bar heights');
    stats.pingMs = 180;
    stats.pingHistory[2] = 40;
    frameStats.limit.label = 'CPU LIMIT';
    net.update(1 / 60, stats, 12000, frameStats);
    expect(net.ping.textContent === 'PING 180 MS' && net.root.classList.contains('vb-net-bad') && net.limit.textContent === 'CPU LIMIT', 'in-place telemetry changes update diagnostics');
    expect(net.bars.at(-1).className === '' && parseFloat(net.bars.at(-1).style.height) < 8, 'in-place history changes update the bar');
    net.reset();
    expect(!net.root.classList.contains('vb-net-warn') && !net.root.classList.contains('vb-net-bad') && net.ping.textContent === 'PING --', 'reset clears warning classes and samples');
    net.update(1 / 60, stats, 0, { ready: true, renderedFps: 60 });
    expect(net.limit.textContent === '' && net.limit.title === '', 'optional frame-limit metadata may be absent');
    expect(document.documentElement.style.getPropertyValue('--vb-net-meter-clear') === '78px', 'telemetry publishes occupied corner clearance');
    net.dispose();
    expect(document.documentElement.style.getPropertyValue('--vb-net-meter-clear') === '0px', 'dispose clears reserved telemetry space');
    net.build(document.body);
    net.update(1 / 60, null, 0);
    expect(net.fps.textContent === 'FPS 60' && net.ping.textContent === 'PING --', 'rebuilt telemetry paints immediately without stale samples');
    for (const setting of ['showPing', 'showFps', 'showNetwork']) setDisplaySetting(setting, false);
    net.update(1 / 60, stats, 250, frameStats);
    expect(net.root.style.display === 'none' && document.documentElement.style.getPropertyValue('--vb-net-meter-clear') === '0px', 'hidden telemetry clears corner clearance');
    net.dispose();
    return { checks, idleMatchMutations, idleSndMutations, idleScopeMutations, idleNetworkMutations };
  })()`);
  assert.ok(result.checks >= 35, 'all HUD runtime cases completed');
  console.log('HUD runtime test passed', JSON.stringify(result));
} finally {
  await browser?.close();
  await stopServer(server);
}
