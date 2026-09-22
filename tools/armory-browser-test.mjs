// ARMORY in a real (muted, headless) browser: one dialog, four tabs, real
// file-backed career, desktop and mobile layouts, screenshots per tab.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROGRESSION_BRANCHES, PROGRESSION_TREE } from '../shared/career.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const BANNED = /credit|buy|purchase|price|shop/i;
const LEVEL_BRANCHES = PROGRESSION_BRANCHES.filter(branch => branch.track === 'level').map(branch => branch.id);
const FILTER_COUNTS = [...LEVEL_BRANCHES.map(id => [id, PROGRESSION_TREE.filter(item => item.branch === id).length]),
  ['all', PROGRESSION_TREE.filter(item => LEVEL_BRANCHES.includes(item.branch)).length]];
const VIEWPORTS = [[1440, 900, false], [1280, 720, false], [390, 844, true], [360, 780, true]];
const TABS = ['loadout', 'weapons', 'progress', 'mastery'];

const directory = await mkdtemp(path.join(tmpdir(), 'vb-armory-browser-'));
const guest = randomBytes(32).toString('hex');
await writeFile(path.join(directory, `${guest}.json`), JSON.stringify({ xp: 1100, credits: 825, kills: 64, matches: 12,
  mastery: { rifle: { kills: 40, headshots: 9 }, smg: { kills: 12, headshots: 2 } },
  owned: ['amber', 'rookie', 'arctic'], equipped: { theme: 'arctic', title: 'rookie' } }));
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory } });
let browser;
try {
  const url = `http://127.0.0.1:${await server.port}/?debug=1&headless=1`;
  browser = await launchCdpSession(url);
  const page = browser.page;
  const js = value => JSON.stringify(value);
  const $click = selector => page.evaluate(`document.querySelector(${js(selector)}).click()`);
  const key = async (name, code, keyCode) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode });
  };
  const viewport = (width, height, mobile) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await page.send('Network.setCookie', { name: 'vb-career', value: guest, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-menu-preview')?.textContent.includes('LEVEL 4')`);
  await mkdir('.artifacts/armory', { recursive: true });
  const screenshot = async name => {
    await page.evaluate(`document.activeElement?.blur?.()`).catch(() => {});
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const result = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/armory/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  const noOverflow = async label => {
    const result = await page.evaluate(`(() => {
      const shop = document.getElementById('career-shop'), menu = document.getElementById('menu');
      const wide = el => el && el.scrollWidth > el.clientWidth + 1;
      const offenders = shop.open ? [...shop.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width && r.height && (r.right > innerWidth + 1 || r.left < -1) && !el.closest('.vb-journey, #armory-weapon-rail, .vb-tree, [hidden]');
      }).slice(0, 4).map(el => el.className || el.tagName) : [];
      return { shop: shop.open && wide(shop), menu: wide(menu), doc: document.documentElement.scrollWidth > innerWidth + 1, offenders };
    })()`);
    assert.deepEqual(result, { shop: false, menu: false, doc: false, offenders: [] }, `${label}: no horizontal overflow`);
  };
  const bannedFree = async label => {
    const text = await page.evaluate(`document.getElementById('career-shop').textContent`);
    assert.doesNotMatch(text, BANNED, `${label}: no store vocabulary in the armory`);
  };
  const closeVisible = async label => {
    assert.equal(await page.evaluate(`(() => { const r = document.getElementById('career-close').getBoundingClientRect();
      return r.width > 0 && r.y >= 0 && r.bottom <= innerHeight; })()`), true, `${label}: BACK stays visible`);
  };
  const openTab = async tab => {
    await $click(`#armory-tab-${tab}`);
    await page.waitFor(`document.getElementById('armory-tab-${tab}').getAttribute('aria-selected') === 'true' && !document.getElementById('armory-panel-${tab}').hidden`);
  };
  const waitSettled = () => page.evaluate(`new Promise(resolve => setTimeout(resolve, 350))`);

  for (const [width, height, mobile] of VIEWPORTS) {
    const size = `${width}x${height}`;
    await viewport(width, height, mobile);
    await page.evaluate(`document.getElementById('menu').scrollTop = 0`);
    await page.waitFor(`Array.from(document.images).every(img => img.complete)`);
    const menu = await page.evaluate(`(() => {
      const open = document.getElementById('career-open');
      return { label: open.querySelector('.vb-nav-label')?.textContent || open.textContent, workshop: !!document.getElementById('workshop-open'),
        popup: open.getAttribute('aria-haspopup'),
        actions: ['play-btn', 'browse-lobbies-btn', 'create-lobby-btn', 'create-duel-btn', 'training-btn', 'account-open', 'career-open', 'career-menu-preview'].map(id => {
          const r = document.getElementById(id).getBoundingClientRect(); return { id, x: r.x, y: r.y, bottom: r.bottom, width: r.width };
        }) };
    })()`);
    assert.equal(menu.label.trim(), 'ARMORY', `${size}: the career entry reads ARMORY`);
    assert.equal(menu.popup, 'dialog');
    assert.equal(menu.workshop, false, `${size}: no separate workshop entry`);
    // Every main-menu action, ARMORY and the career card included, stays on screen.
    if (width >= 760) for (const action of menu.actions) {
      assert.ok(action.width > 0 && action.y >= 0 && action.bottom <= height, `${size}: ${action.id} stays inside the viewport: ${JSON.stringify(action)}`);
    }
    if (width === 390) assert.equal(await page.evaluate(`(() => {const r = document.getElementById('account-mobile-open').getBoundingClientRect(); return r.y > 0 && r.bottom < innerHeight;})()`), true, 'mobile registration CTA is visible in the initial viewport');
    await noOverflow(`${size} menu`);
    await screenshot(`main-${size}`);

    await $click('#career-open');
    await page.waitFor(`document.getElementById('career-shop').open && document.querySelector('.vb-career-stats').textContent.includes('LEVEL 4') && document.querySelector('.vb-armory-slot')`);
    assert.equal(await page.evaluate(`document.getElementById('armory-tab-loadout').getAttribute('aria-selected')`), 'true', `${size}: ARMORY opens on LOADOUT`);
    assert.equal(await page.evaluate(`document.getElementById('career-shop').dataset.tab`), 'loadout');
    await waitSettled();
    await noOverflow(`${size} loadout`);
    await closeVisible(`${size} loadout`);
    await bannedFree(`${size} loadout`);
    await screenshot(`loadout-${size}`);

    // Callsign slot -> Vanguard. Mobile pushes the options view first.
    await $click('[data-slot="title"]');
    await page.waitFor(`document.querySelector('[data-option="vanguard"]')?.getClientRects().length > 0`);
    if (mobile) {
      assert.equal(await page.evaluate(`document.querySelector('.vb-armory-loadout').dataset.view`), 'options', `${size}: slot tap pushes the options view`);
      await screenshot(`loadout-options-${size}`);
    }
    const equipped = await page.evaluate(`document.querySelector('[data-option="vanguard"]').dataset.state`);
    const target = equipped === 'equipped' ? 'rookie' : 'vanguard';
    const name = target === 'vanguard' ? 'Vanguard' : 'Rookie';
    await $click(`[data-option="${target}"]`);
    await page.waitFor(`document.getElementById('armory-status').textContent === '${name} equipped'`, { label: `${size} ${name} equipped` });
    const status = await page.evaluate(`(() => { const s = document.getElementById('armory-status'), r = s.getBoundingClientRect();
      return { inInspector: !!s.closest('#armory-inspector'), shown: r.height > 0 && r.bottom <= innerHeight + 1 && r.y >= 0 }; })()`);
    assert.equal(status.inInspector, true, `${size}: status lives in the inspector`);
    assert.equal(status.shown, true, `${size}: equip status is on screen (inspector or mobile bottom bar)`);
    assert.equal(await page.evaluate(`document.querySelector('[data-option="${target}"]').dataset.state`), 'equipped');
    assert.equal(await page.evaluate(`document.querySelector('.vb-career-title-name').textContent.includes(${js(name)})`), true);
    assert.equal(await page.evaluate(`document.getElementById('career-menu-preview').textContent.includes(${js(name)})`), true, 'menu card follows the equipped callsign');
    if (mobile) {
      await $click('.vb-armory-back');
      await page.waitFor(`document.querySelector('.vb-armory-loadout').dataset.view === 'slots'`);
    }

    // Tabs: click and arrow keys.
    await page.evaluate(`document.getElementById('armory-tab-loadout').focus()`);
    await key('ArrowRight', 'ArrowRight', 39);
    await page.waitFor(`document.getElementById('armory-tab-weapons').getAttribute('aria-selected') === 'true' && document.activeElement?.id === 'armory-tab-weapons'`, { label: `${size} arrow to WEAPONS` });
    await key('End', 'End', 35);
    await page.waitFor(`document.getElementById('armory-tab-mastery').getAttribute('aria-selected') === 'true'`, { label: `${size} End to MASTERY` });
    await key('Home', 'Home', 36);
    await page.waitFor(`document.getElementById('armory-tab-loadout').getAttribute('aria-selected') === 'true'`, { label: `${size} Home to LOADOUT` });

    for (const tab of TABS.slice(1)) {
      await openTab(tab);
      if (tab === 'weapons') await page.waitFor(`document.querySelectorAll('#armory-weapon-rail [data-weapon]').length === ${WEAPON_IDS.length} && document.querySelector('[data-optic]')`, { label: `${size} bench` });
      if (tab === 'progress') await page.waitFor(`document.querySelectorAll('#progression-tree [data-cosmetic]').length > 0`);
      if (tab === 'mastery') await page.waitFor(`document.querySelectorAll('#armory-mastery-grid [data-weapon-mastery]').length === ${WEAPON_IDS.length}`, { label: `${size} 13 mastery cards` });
      await waitSettled();
      await page.evaluate(`document.getElementById('armory-panel-${tab}').scrollTop = 0`);
      await noOverflow(`${size} ${tab}`);
      await closeVisible(`${size} ${tab}`);
      await bannedFree(`${size} ${tab}`);
      await screenshot(`${tab}-${size}`);
    }
    // Back stays visible while the panel (or, on mobile, the dialog) scrolls.
    await page.evaluate(`(() => { const p = document.getElementById('armory-panel-mastery'); p.scrollTop = p.scrollHeight;
      const d = document.getElementById('career-shop'); d.scrollTop = d.scrollHeight; })()`);
    await closeVisible(`${size} scrolled`);
    if (mobile) {
      assert.equal(await page.evaluate(`document.getElementById('armory-inspector').dataset.sheet`), 'closed', `${size}: a tab switch closes the sheet`);
      await page.evaluate(`document.querySelector('.vb-armory-sheet-toggle').click()`);
      await page.waitFor(`document.getElementById('armory-inspector').dataset.sheet === 'open'`);
      await waitSettled();
      await noOverflow(`${size} sheet`);
      await screenshot(`sheet-${size}`);
      await page.evaluate(`document.querySelector('.vb-armory-sheet-toggle').click()`);
    }
    await $click('#career-close');
    await page.waitFor(`!document.getElementById('career-shop').open`);
  }

  // PROGRESS filters with derived counts; a journey chip clears a hiding filter.
  await viewport(1440, 900, false);
  await $click('#career-menu-preview');
  await page.waitFor(`document.getElementById('career-shop').open && document.getElementById('armory-tab-progress').getAttribute('aria-selected') === 'true'`, { label: 'menu card opens PROGRESS' });
  await page.waitFor(`document.querySelectorAll('#progression-tree [data-cosmetic]').length === ${FILTER_COUNTS.at(-1)[1]}`);
  for (const [filter, count] of FILTER_COUNTS) {
    await $click(`[data-filter="${filter}"]`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#progression-tree [data-cosmetic]').length`), count, `${filter} filter shows ${count}`);
    assert.equal(await page.evaluate(`document.querySelector('[data-filter="${filter}"]').getAttribute('aria-pressed')`), 'true');
    assert.equal(await page.evaluate(`document.querySelector('.vb-tree-summary').textContent.endsWith('/ ${count} UNLOCKED')`), true);
  }
  assert.ok(await page.evaluate(`document.querySelectorAll('[data-upcoming]').length`) <= 3, 'at most three upcoming unlocks');
  await $click('[data-filter="weapons"]');
  const chip = await page.evaluate(`(() => { const hidden = [...document.querySelectorAll('[data-journey]')].map(c => c.dataset.journey)
    .find(id => !document.querySelector('#progression-tree [data-node="' + id + '"]')); return hidden || null; })()`);
  assert.ok(chip, 'the level journey holds a reward outside the WEAPONS filter');
  await $click(`[data-journey="${chip}"]`);
  await page.waitFor(`document.querySelector('[data-filter="all"]').getAttribute('aria-pressed') === 'true'
    && document.querySelector('#progression-tree [data-tree-node="${chip}"]')?.getAttribute('aria-selected') === 'true'
    && document.getElementById('armory-inspector').dataset.featuredItem === '${chip}'`, { label: 'journey chip reveals its node' });
  assert.match(await page.evaluate(`document.querySelector('.vb-armory-earn').textContent`), /\+25 XP/);

  // Controls that switch tabs hand keyboard focus into the new panel, never to <body>.
  const press = selector => page.evaluate(`(() => { const c = document.querySelector(${js(selector)}); c.focus(); c.click(); })()`);
  const focused = (test, label) => page.waitFor(`(() => { const a = document.activeElement; return !!a && a !== document.body && (${test}); })()`, { label });
  await openTab('progress');
  await page.waitFor(`document.querySelector('.vb-goal-card[data-goal=mastery]')`, { label: 'a mastery goal card' });
  const goal = await page.evaluate(`document.querySelector('.vb-goal-card[data-goal=mastery]').dataset.target`);
  await press('.vb-goal-card[data-goal=mastery]');
  await focused(`a.closest('#armory-panel-mastery') && a.dataset.masteryNode === ${js(goal)}`, 'mastery goal lands on its reward');
  await openTab('loadout');
  await press('.vb-armory-weapon-row[data-weapon-row=smg]');
  await focused(`a.closest('#armory-weapon-rail') && a.dataset.weapon === 'smg'`, 'LOADOUT weapon row lands on the rail');
  await openTab('mastery');
  await page.evaluate(`(() => { const card = document.querySelector('.vb-mastery-card[data-weapon-mastery=rifle]');
    if (card.getAttribute('aria-expanded') !== 'true') card.click(); })()`);
  await page.waitFor(`document.querySelector('#armory-mastery-detail [data-open-weapon=rifle]')`);
  await press('#armory-mastery-detail [data-open-weapon=rifle]');
  await focused(`a.closest('#armory-weapon-rail') && a.dataset.weapon === 'rifle'`, 'TUNE IN WEAPONS lands on the rail');

  // WEAPONS: a reflex sight on the rifle saves on select and survives a reload.
  await openTab('weapons');
  await page.waitFor(`document.querySelector('#armory-weapon-rail [data-weapon="rifle"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-optic="reflex"]')`);
  const before = await page.evaluate(`document.querySelector('[data-optic="reflex"]').getAttribute('aria-pressed')`);
  const optic = before === 'true' ? 'standard' : 'reflex';
  await $click(`[data-optic="${optic}"]`);
  assert.equal(await page.evaluate(`document.querySelector('[data-optic="${optic}"]').getAttribute('aria-pressed')`), 'true', 'part selection is optimistic');
  await page.waitFor(`document.getElementById('armory-status').textContent === 'RAPTOR RIFLE setup saved' || /setup saved$/.test(document.getElementById('armory-status').textContent)`, { label: 'rifle setup saved' });
  assert.equal(await page.evaluate(`document.getElementById('armory-action').hidden`), true, 'the bench options are the controls');
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-menu-preview')?.textContent.includes('LEVEL 4')`);
  await $click('#career-open');
  await page.waitFor(`document.getElementById('career-shop').open && document.querySelector('.vb-career-stats').textContent.includes('LEVEL 4')`);
  await openTab('weapons');
  await page.waitFor(`document.querySelector('[data-optic="${optic}"]')?.getAttribute('aria-pressed') === 'true'`, { label: 'saved optic persists across reload' });
  await $click('#career-close');

  // Signed-in strip and account CTAs.
  await page.evaluate(`document.getElementById('account-open').click()`);
  assert.equal(await page.evaluate(`document.getElementById('account-tab-register').getAttribute('aria-pressed')`), 'true', 'prominent account CTA opens registration');
  await page.evaluate(`(() => { const f = document.getElementById('account-form'); f.elements.username.value='ArmoryPilot'; f.elements.password.value='armory browser password'; f.elements.confirmPassword.value='armory browser password'; f.requestSubmit(); })()`);
  await page.waitFor(`document.getElementById('account-recovery-code') && document.getElementById('account-dialog').getAttribute('aria-busy') === 'false'`, { timeoutMs: 20000 });
  await page.evaluate(`document.getElementById('account-code-done').click();document.getElementById('account-close').click()`);
  await page.waitFor(`document.getElementById('career-menu-preview').textContent.includes('LEVEL 4') && document.getElementById('account-nav-open').textContent.includes('ArmoryPilot')`);
  await $click('#career-open');
  await page.waitFor(`document.querySelector('.vb-career-player').textContent === 'ArmoryPilot' && document.getElementById('career-account').textContent === 'MANAGE ACCOUNT'`);
  await waitSettled();
  await screenshot('loadout-signed-in-1440x900');
  await $click('#career-close');

  // Log out: the top navigation opens login, and CONTINUE AS GUEST is wired to Quick Play.
  await page.evaluate(`document.getElementById('account-nav-open').click();document.getElementById('account-logout').click()`);
  await page.waitFor(`!document.getElementById('name-input').readOnly && !document.getElementById('account-logout')`, { label: 'logged out' });
  await page.evaluate(`document.getElementById('account-guest').click();document.getElementById('account-nav-open').click()`);
  assert.equal(await page.evaluate(`document.getElementById('account-tab-login').getAttribute('aria-pressed')`), 'true', 'top navigation opens login');
  await page.evaluate(`document.getElementById('account-guest').click()`);
  // Live play is out of scope for this muted suite: the Quick Play click is caught before it starts a match.
  assert.equal(await page.evaluate(`(() => {
    let started = false;
    const catchPlay = event => { if (event.target.closest?.('#play-btn')) { started = true; event.stopPropagation(); event.preventDefault(); } };
    document.addEventListener('click', catchPlay, true);
    try { const guest = document.getElementById('menu-continue-guest'); if (guest.hidden || !guest.getClientRects().length) return 'hidden'; guest.click(); }
    finally { document.removeEventListener('click', catchPlay, true); }
    return started;
  })()`), true, 'the guest shortcut starts Quick Play');
  assert.deepEqual(page.errors.filter(error => !/favicon|pointer.?lock/i.test(error)), []);
  console.log(`Armory browser: ${VIEWPORTS.map(([w, h]) => `${w}x${h}`).join('/')} menu and four tabs without overflow, LOADOUT callsign equip, tab keys, PROGRESS filters (${FILTER_COUNTS.map(([id, n]) => `${id} ${n}`).join(', ')}) and journey jump, tab-switch focus landing, WEAPONS save-on-select across reload, 13 mastery cards, banned-word, signed-in, login-nav and guest Quick Play shortcut checks passed.`);
} finally {
  await browser?.close(); await stopServer(server); await rm(directory, { recursive: true, force: true });
}
