import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const server = startServer();
let browser;
try {
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/`);
  const page = browser.page;
  await page.evaluate(`(async () => {
    await import('/js/main.js');
    document.body.innerHTML = '<div id="hud" style="display:block"></div>';
    const { MatchHud } = await import('/js/ui/match-hud.js');
    const { Scoreboard } = await import('/js/ui/scoreboard.js');
    window.sentApprovals = [];
    window.resultHud = new MatchHud(); resultHud.build(document.getElementById('hud'));
    resultHud.result.onContinue = id => sentApprovals.push(id);
    new Scoreboard().build(document.getElementById('hud'));
    window.roster = Array.from({ length: 64 }, (_, i) => ({
      id: String(i), name: i === 0 ? 'LOGGY' : 'PLAYER ' + (i + 1),
      kills: 64 - i, deaths: i, team: i % 2 ? 'bravo' : 'alpha', hp: 100,
    }));
    window.resultMatch = { mode: 'tdm', map: 'foundry', phase: 'post', winner: 'alpha',
      scores: { alpha: 40, bravo: 28 }, phaseEndsAt: null, results: roster,
      continuation: { id: 'round-1', approved: [], eligible: 5, required: 2, ratio: 0.4 } };
    resultHud.setMatchState(resultMatch, roster[0], roster, 1000);
  })()`);
  for (const [width, height] of [[1280, 800], [390, 844], [844, 390], [320, 568]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // Let the entrance animation settle before checking hit targets and bounds.
    await page.evaluate('Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))');
    const state = await page.evaluate(`(() => {
      const button = document.getElementById('match-result-approve');
      const b = button.getBoundingClientRect();
      const board = document.getElementById('match-result-scoreboard');
      const panel = document.querySelector('.vb-match-result-panel').getBoundingClientRect();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      return { title: document.getElementById('match-result-title').textContent,
        approvals: document.getElementById('match-result-approvals').textContent,
        countdown: document.getElementById('match-result-countdown').textContent,
        rows: board.querySelectorAll('tbody tr').length,
        self: board.querySelector('.vb-me .vb-sb-name').textContent,
        scrollable: [...board.querySelectorAll('.vb-result-roster')].some(r => r.scrollHeight > r.clientHeight),
        fits: panel.left >= 0 && panel.right <= innerWidth && panel.top >= 0 && panel.bottom <= innerHeight,
        clickable: document.elementFromPoint(x, y) === button, x, y,
        duplicateIds: [...document.querySelectorAll('[id]')].length !== new Set([...document.querySelectorAll('[id]')].map(e => e.id)).size };
    })()`);
    assert.equal(state.title, 'VICTORY');
    assert.equal(state.rows, 64);
    assert.equal(state.self, 'LOGGYYOU');
    assert.equal(state.countdown, 'WAITING FOR APPROVALS');
    assert.equal(state.approvals, '0 / 5 PLAYERS APPROVED · 2 REQUIRED (40%)');
    for (const key of ['fits', 'scrollable', 'clickable']) assert.equal(state[key], true, `${width}x${height}: ${key}`);
    assert.equal(state.duplicateIds, false);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: state.x, y: state.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.x, y: state.y, button: 'left', clickCount: 1 });
    assert.equal(await page.evaluate('sentApprovals.at(-1)'), 'round-1');
    await mkdir('.artifacts/round-continuation', { recursive: true });
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/round-continuation/result-${width}x${height}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  const state = await page.evaluate(`(() => {
    resultMatch = { ...resultMatch, phaseEndsAt: 6000,
      continuation: { ...resultMatch.continuation, approved: ['0', '1'] } };
    resultHud.setMatchState(resultMatch, roster[0], roster, 1000);
    const approved = document.getElementById('match-result-approve').disabled;
    const countdown = document.getElementById('match-result-countdown').textContent;
    const votes = sentApprovals.length;
    document.getElementById('match-result-approve').click();
    const duplicateSent = sentApprovals.length !== votes;
    resultHud.setMatchState({ ...resultMatch, phase: 'live' }, roster[0], roster, 6000);
    const hidden = document.getElementById('match-result-screen').getAttribute('aria-hidden');
    resultHud.setMatchState({ ...resultMatch, mode: 'snd', round: 2, winner: null, roundWinner: 'bravo' }, roster[0], roster, 2000);
    const round = [document.getElementById('match-result-title').textContent,
      document.getElementById('match-result-eyebrow').textContent,
      document.getElementById('match-result-countdown').textContent];
    const duelPlayers = roster.slice(0, 2);
    resultHud.setMatchState({ ...resultMatch, mode: 'duel', winner: '0', killLimit: 5, results: duelPlayers }, duelPlayers[0], duelPlayers, 2000);
    const board = document.getElementById('match-result-scoreboard');
    const duel = { title: board.querySelector('h2').textContent,
      columns: board.querySelectorAll('th').length,
      cells: [...board.querySelectorAll('tbody tr')].map(row => row.children.length) };
    return { approved, countdown, duplicateSent, hidden, round, duel };
  })()`);
  assert.deepEqual(state, { approved: true, countdown: 'NEXT MATCH IN 0:05', duplicateSent: false,
    hidden: 'true', round: ['DEFEAT', 'ROUND 2 COMPLETE', 'NEXT ROUND IN 0:04'],
    duel: { title: '1V1 DUEL', columns: 6, cells: [6, 6] } });

  // Use the same five-player fixture as the ImageGen reference for visual comparison.
  await page.evaluate(`(() => {
    window.designRoster = [
      { id: '0', name: 'LOGGY', team: 'alpha', kills: 18, deaths: 9, ping: 24 },
      { id: '1', name: 'NOVA', team: 'alpha', kills: 14, deaths: 10, ping: 32 },
      { id: '2', name: 'RIFT', team: 'alpha', kills: 8, deaths: 9, ping: 41 },
      { id: '3', name: 'ECHO', team: 'bravo', kills: 16, deaths: 21, ping: 28 },
      { id: '4', name: 'VEX', team: 'bravo', kills: 12, deaths: 19, ping: 36 },
    ].map(row => ({ ...row, hp: 100, state: 'alive' }));
    window.designMatch = { mode: 'tdm', map: 'foundry', phase: 'post', winner: 'alpha',
      scores: { alpha: 40, bravo: 28 }, phaseEndsAt: null, results: designRoster,
      continuation: { id: 'design-round', approved: ['1'], eligible: 5, required: 2, ratio: 0.4 } };
    resultHud.setMatchState(designMatch, designRoster[0], designRoster, 1000);
  })()`);
  for (const [label, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const design = await page.evaluate(`(() => {
      const board = document.getElementById('match-result-scoreboard');
      board.scrollTop = 0;
      const a = board.querySelector('.vb-sb-alpha').getBoundingClientRect();
      const b = board.querySelector('.vb-sb-bravo').getBoundingClientRect();
      const meter = document.getElementById('match-result-meter');
      const fill = meter.firstElementChild.getBoundingClientRect();
      const marker = meter.lastElementChild.getBoundingClientRect();
      const bounds = meter.getBoundingClientRect();
      return { sideBySide: Math.abs(a.top - b.top) < 1 && b.left > a.left,
        stacked: Math.abs(a.left - b.left) < 1 && b.top > a.top,
        progress: meter.getAttribute('aria-valuenow'),
        pingKeepsUnit: getComputedStyle(board.querySelector('.vb-sb-ping')).whiteSpace === 'nowrap',
        fillRatio: fill.width / bounds.width, thresholdRatio: (marker.left - bounds.left) / bounds.width,
        allPlayersVisible: board.scrollHeight <= board.clientHeight + 1,
        horizontalOverflow: board.scrollWidth > board.clientWidth + 1 };
    })()`);
    assert.equal(design[label === 'desktop' ? 'sideBySide' : 'stacked'], true);
    assert.equal(design.progress, '20');
    assert.equal(design.pingKeepsUnit, true);
    assert.ok(Math.abs(design.fillRatio - 0.2) < 0.01);
    assert.ok(Math.abs(design.thresholdRatio - 0.4) < 0.01);
    assert.equal(design.allPlayersVisible, true, `${label}: both teams fit the reference fixture`);
    assert.equal(design.horizontalOverflow, false);
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/round-continuation/design-${label}-waiting.png`, Buffer.from(screenshot.data, 'base64'));
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const countdownState = await page.evaluate(`(() => {
    resultHud.setMatchState({ ...designMatch, phaseEndsAt: 6000,
      continuation: { ...designMatch.continuation, approved: ['0', '1'] } }, designRoster[0], designRoster, 1000);
    return [document.getElementById('match-result-meter').getAttribute('aria-valuenow'),
      document.getElementById('match-result-countdown').textContent];
  })()`);
  assert.deepEqual(countdownState, ['40', 'NEXT MATCH IN 0:05']);
  const countdownShot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('.artifacts/round-continuation/design-desktop-countdown.png', Buffer.from(countdownShot.data, 'base64'));
  assert.deepEqual(page.errors, []);
  console.log('Round result browser passed: full scoreboard, four viewport sizes, real button clicks, server approvals/countdown, S&D rounds, duel columns, reset.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
