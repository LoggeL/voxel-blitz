import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

// Matches the approved ImageGen D reference: 30 humans, 6 bots, 9 approvals.
const teams = {
  alpha: [['LOGGY', 7, 3, 24], ['NOVA', 5, 3, 32], ['RIFT', 4, 2, 41], ['PIXEL', 4, 2, 18],
    ['AXIS', 3, 2, 29], ['FLINT', 3, 2, 37], ['ONYX', 2, 2, 44], ['FROST', 2, 2, 21],
    ['KODA', 2, 1, 35], ['LUMEN', 1, 1, 27], ['SPARK', 1, 1, 40], ['JUNO', 1, 1, 22],
    ['VALE', 1, 1, 31], ['REEF', 0, 1, 46], ['WISP', 0, 1, 25]],
  bravo: [['ECHO', 6, 4, 28], ['VEX', 4, 3, 36], ['RAZE', 3, 3, 20], ['GHOST', 2, 3, 33],
    ['EMBER', 2, 3, 42], ['NEXUS', 2, 2, 26], ['BOLT', 1, 2, 38], ['ORBIT', 1, 2, 30],
    ['VIPER', 1, 2, 23], ['TRACE', 1, 2, 39], ['SHADE', 1, 2, 34], ['MOSS', 1, 2, 43],
    ['DUSK', 0, 1, 19], ['KITE', 0, 1, 45], ['ASH', 0, 1, 47]],
};
const roster = Object.entries(teams).flatMap(([team, rows]) => [
  ...rows.map(([name, kills, deaths, ping]) => ({ id: name, name, team, kills, deaths, ping, bot: false, state: 'alive' })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `${team}-bot-${i}`, name: `BOT-0${i + (team === 'alpha' ? 1 : 4)}`,
    team, kills: team === 'alpha' && i === 0 ? 2 : 1, deaths: team === 'alpha' ? 1 : i === 0 ? 3 : 2, bot: true, state: 'alive' })),
]);
const approved = ['NOVA', 'RIFT', 'PIXEL', 'FLINT', 'FROST', 'ECHO', 'VEX', 'RAZE', 'EMBER'];
const server = startServer();
let browser;
try {
  browser = await launchCdpSession(`http://127.0.0.1:${await server.port}/`);
  const page = browser.page;
  await mkdir('.artifacts/round-continuation', { recursive: true });
  const shot = async name => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/round-continuation/large-${name}.png`, Buffer.from(data, 'base64'));
  };
  const click = async selector => {
    const { x, y } = await page.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!e.contains(document.elementFromPoint(x, y))) throw new Error('Target is obscured: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  };
  await page.evaluate(`(async () => {
    await import('/js/main.js');
    document.body.innerHTML = '<div id="hud" style="display:block"></div>';
    const { MatchHud } = await import('/js/ui/match-hud.js');
    window.resultHud = new MatchHud(); resultHud.build(document.getElementById('hud'));
    window.roster = ${JSON.stringify(roster)};
    window.match = { mode: 'tdm', map: 'foundry', phase: 'post', winner: 'alpha',
      scores: { alpha: 40, bravo: 28 }, phaseEndsAt: null, results: roster,
      continuation: { id: 'large-round', approved: ${JSON.stringify(approved)}, eligible: 30, required: 12, ratio: 0.4 } };
    window.renderResult = (next = match, self = roster[0]) => resultHud.setMatchState(next, self, roster, 1000);
    renderResult();
    await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})));
  })()`);
  for (const [width, height] of [[1586, 992], [1280, 800], [390, 844], [844, 390], [320, 568]]) {
    const label = `${width}x${height}`;
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const state = await page.evaluate(`(() => {
      const board = document.getElementById('match-result-scoreboard');
      const panel = document.querySelector('.vb-match-result-panel').getBoundingClientRect();
      const groups = [...board.querySelectorAll('.vb-result-bots')];
      const rosters = [...board.querySelectorAll('.vb-result-roster')];
      const footer = document.querySelector('.vb-match-result-footer').getBoundingClientRect();
      const br = board.getBoundingClientRect();
      return {
        counts: document.getElementById('match-result-roster-count').textContent,
        teamCounts: [...board.querySelectorAll('h3 span')].map(e => e.textContent),
        humanRows: rosters.map(e => e.querySelectorAll('tbody tr').length),
        botRows: groups.map(e => e.querySelectorAll('tbody tr').length),
        closed: groups.every(e => !e.open),
        approvals: document.getElementById('match-result-approvals').textContent,
        needed: document.getElementById('match-result-needed').textContent,
        progress: document.getElementById('match-result-meter').getAttribute('aria-valuenow'),
        checked: board.querySelectorAll('.vb-sb-vote.is-approved').length,
        botChecks: board.querySelectorAll('[data-bot="true"] .is-approved').length,
        botControls: board.querySelectorAll('[data-bot="true"] :is(button, input)').length,
        fits: panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
        footerOutside: footer.top >= br.bottom && footer.bottom <= panel.bottom,
        noHorizontalOverflow: [board, ...rosters].every(e => e.scrollWidth <= e.clientWidth + 1),
        humanHeights: rosters.map(e => e.clientHeight),
        humanArea: rosters.every(e => e.clientHeight >= 46),
        allHumansVisible: rosters.every(e => e.scrollHeight <= e.clientHeight + 1),
      };
    })()`);
    await shot(label);
    assert.equal(state.counts, '30 PLAYERS + 6 BOTS');
    assert.deepEqual(state.teamCounts, ['15 PLAYERS + 3 BOTS', '15 PLAYERS + 3 BOTS']);
    assert.deepEqual(state.humanRows, [15, 15]);
    assert.deepEqual(state.botRows, [3, 3]);
    assert.equal(state.approvals, '9 / 30 PLAYERS APPROVED · 12 REQUIRED (40%)');
    assert.equal(state.needed, '3 MORE NEEDED');
    assert.equal(state.progress, '30');
    assert.equal(state.checked, 9);
    assert.equal(state.botChecks, 0);
    assert.equal(state.botControls, 0);
    for (const key of ['closed', 'fits', 'footerOutside', 'noHorizontalOverflow', 'humanArea']) {
      assert.equal(state[key], true, `${label}: ${key} ${JSON.stringify(state)}`);
    }
    if (height >= 800 && width > 700) assert.equal(state.allHumansVisible, true, `${label}: all 30 humans visible`);
    for (const team of ['alpha', 'bravo']) {
      await click(`.vb-sb-${team} .vb-result-bots summary`);
      assert.equal(await page.evaluate(`document.querySelector('.vb-sb-${team} .vb-result-bots').open`), true);
      const botFits = await page.evaluate(`(() => {
        const e = document.querySelector('.vb-sb-${team} .vb-result-bot-roster');
        const r = e.getBoundingClientRect(), card = e.closest('.vb-scoreboard-team').getBoundingClientRect();
        e.scrollTop = e.scrollHeight;
        const last = e.querySelector('tbody tr:last-child').getBoundingClientRect();
        return { fits: e.clientHeight >= 24 && r.bottom <= card.bottom && last.bottom <= r.bottom + 1,
          height: e.clientHeight, bottom: r.bottom, cardBottom: card.bottom, lastBottom: last.bottom };
      })()`);
      if (!botFits.fits) await shot(`${label}-${team}-expanded`);
      assert.equal(botFits.fits, true, `${label}: ${team} bot scores accessible ${JSON.stringify(botFits)}`);
      await click(`.vb-sb-${team} .vb-result-bots summary`);
    }
  }

  // Frequent vote/timer snapshots must preserve expanded groups and both scroll positions.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await click('.vb-sb-alpha .vb-result-bots summary');
  const retained = await page.evaluate(`(() => {
    const group = document.querySelector('.vb-sb-alpha .vb-result-bots');
    const humans = document.querySelector('.vb-sb-bravo .vb-result-roster');
    const bots = group.querySelector('.vb-result-bot-roster');
    humans.scrollTop = 120; bots.scrollTop = 40;
    const positions = [humans.scrollTop, bots.scrollTop];
    const heading = humans.querySelector('th').getBoundingClientRect();
    const footerTop = document.querySelector('.vb-match-result-footer').getBoundingClientRect().top;
    renderResult({ ...match, continuation: { ...match.continuation, approved: [...match.continuation.approved, 'AXIS'] } });
    return {
      sameNodes: document.querySelector('.vb-sb-alpha .vb-result-bots') === group && document.querySelector('.vb-sb-bravo .vb-result-roster') === humans,
      open: group.open, positions, after: [humans.scrollTop, bots.scrollTop],
      headingPinned: Math.abs(heading.top - humans.getBoundingClientRect().top) <= 1,
      headingTop: heading.top, rosterTop: humans.getBoundingClientRect().top,
      headingPosition: getComputedStyle(humans.querySelector('th')).position,
      footerStable: document.querySelector('.vb-match-result-footer').getBoundingClientRect().top === footerTop,
      votes: document.querySelectorAll('.vb-sb-vote.is-approved').length,
    };
  })()`);
  assert.equal(retained.sameNodes, true);
  assert.equal(retained.open, true);
  assert.equal(retained.positions[0], 120);
  assert.deepEqual(retained.after, retained.positions);
  assert.equal(retained.headingPinned, true, JSON.stringify(retained));
  assert.equal(retained.footerStable, true);
  assert.equal(retained.votes, 10);
  await shot('mobile-bots-expanded');

  await page.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false });
  const botScroll = await page.evaluate(`(() => {
    const group = document.querySelector('.vb-sb-alpha .vb-result-bots');
    const bots = group.querySelector('.vb-result-bot-roster');
    bots.scrollTop = 40;
    const before = bots.scrollTop;
    renderResult({ ...match, phaseEndsAt: 6000, continuation: { ...match.continuation,
      approved: [...match.continuation.approved, 'LOGGY', 'AXIS', 'ONYX'] } });
    group.querySelector('summary').focus();
    return { before, after: bots.scrollTop, open: group.open,
      sameNode: bots === document.querySelector('.vb-sb-alpha .vb-result-bot-roster') };
  })()`);
  assert.ok(botScroll.before > 0);
  assert.deepEqual(botScroll, { before: botScroll.before, after: botScroll.before, open: true, sameNode: true });
  for (const open of [false, true]) {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    }
    assert.equal(await page.evaluate(`document.querySelector('.vb-sb-alpha .vb-result-bots').open`), open, 'keyboard toggles bot scores');
  }

  // The UI treats bot rows as ineligible even if it receives an invalid approval id.
  const botState = await page.evaluate(`(() => {
    const bot = roster.find(p => p.bot);
    renderResult({ ...match, continuation: { ...match.continuation, approved: [...match.continuation.approved, bot.id] } }, bot);
    return [document.getElementById('match-result-approve').disabled,
      document.querySelectorAll('[data-bot="true"] .is-approved').length];
  })()`);
  assert.deepEqual(botState, [true, 0]);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1586, height: 992, deviceScaleFactor: 1, mobile: false });
  const countdown = await page.evaluate(`(() => {
    renderResult({ ...match, phaseEndsAt: 6000, continuation: { ...match.continuation,
      approved: [...match.continuation.approved, 'LOGGY', 'AXIS', 'ONYX'] } });
    return [document.getElementById('match-result-countdown').textContent,
      document.getElementById('match-result-meter').getAttribute('aria-valuenow'),
      document.getElementById('match-result-needed').textContent,
      document.getElementById('match-result-approve').disabled];
  })()`);
  assert.deepEqual(countdown, ['NEXT MATCH IN 0:05', '40', 'READY', true]);
  await shot('desktop-countdown');

  // S&D has an extra status column; long names must still fit narrow screens.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: false });
  const snd = await page.evaluate(`(() => {
    renderResult({ ...match, mode: 'snd', round: 2, winner: null, roundWinner: 'alpha',
      results: roster.map(p => ({ ...p, name: p.name + '_LONG_PLAYER_NAME' })),
      continuation: { ...match.continuation, id: 'new-round' } });
    const rosters = [...document.querySelectorAll('.vb-result-roster')];
    return { closed: [...document.querySelectorAll('.vb-result-bots')].every(e => !e.open),
      fits: rosters.every(e => e.scrollWidth <= e.clientWidth + 1),
      cells: rosters[0].querySelector('tbody tr').children.length };
  })()`);
  assert.deepEqual(snd, { closed: true, fits: true, cells: 7 });
  await shot('snd-320x568');
  assert.deepEqual(page.errors, []);
  console.log('Large round result browser passed: 30 humans + 6 bots, five viewports, vote status, accessible bot groups, stable scroll, 12-vote countdown, S&D narrow layout.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
