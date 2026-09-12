import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { PostgresStore } from '../server/persistence/postgres.js';
import { postgresFixture } from './lib/postgres-fixture.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const fixture = await postgresFixture();
const guest = randomBytes(32).toString('hex');
const username = 'PostgresPilot';
const password = 'postgres browser fixture password';
let server, browser, other, seed, inspection;
const fill = (page, values) => page.evaluate(`(() => {
  for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
    const input = document.querySelector('#account-form [name="' + name + '"]');
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`);
const start = async () => {
  server = startServer({ cwd: process.cwd(), env: { DATABASE_URL: fixture.connectionString, VB_PERSISTENCE: 'postgres' }, stopTimeout: 15000 });
  return `http://127.0.0.1:${await server.port}/?headless=1&debug=1`;
};
try {
  seed = await PostgresStore.open({ connectionString: fixture.connectionString });
  await seed.transaction(client => seed.writeProfile(client, guest, { xp: 900, credits: 1200, kills: 17, matches: 4,
    owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie' } }));
  await seed.close(); seed = null;
  const url = await start();
  assert.equal((await (await fetch(new URL('/healthz', url))).json()).persistence, 'postgres');
  browser = await launchCdpSession(url);
  const page = browser.page;
  await page.send('Network.setCookie', { name: 'vb-career', value: guest, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('career-menu-preview')?.textContent.includes('1,200 CREDITS')`);
  await page.evaluate(`document.getElementById('account-open').click()`);
  assert.equal(await page.evaluate(`document.getElementById('account-tab-register').getAttribute('aria-pressed')`), 'true');
  await fill(page, { username, password, confirmPassword: password });
  await page.evaluate(`document.getElementById('account-form').requestSubmit()`);
  await page.waitFor(`!!document.getElementById('account-recovery-code')`, { timeoutMs: 20000 });
  await page.evaluate(`document.getElementById('account-code-done').click(); document.getElementById('account-close').click(); document.getElementById('career-open').click()`);
  await page.waitFor(`document.querySelector('.vb-career-stats')?.textContent.includes('1200 CREDITS')`);
  await page.evaluate(`document.querySelector('[data-item="arctic"]').click()`);
  await page.waitFor(`document.querySelector('.vb-career-status').textContent === 'Arctic equipped'`);
  await page.evaluate(`document.querySelector('[data-item="pathfinder"]').click()`);
  await page.waitFor(`document.querySelector('.vb-career-status').textContent === 'Pathfinder equipped'`);
  assert.equal(await page.evaluate(`document.querySelector('.vb-career-stats').textContent.includes('950 CREDITS')`), true);

  inspection = new Client({ connectionString: fixture.connectionString }); await inspection.connect();
  const account = (await inspection.query('SELECT id FROM vb_accounts WHERE username=$1', [username])).rows[0];
  const persisted = (await inspection.query('SELECT xp,credits,kills,matches,owned,equipped FROM vb_careers WHERE account_id=$1', [account.id])).rows[0];
  assert.equal(Number(persisted.xp), 900); assert.equal(Number(persisted.credits), 950);
  assert.deepEqual(persisted.equipped, { theme: 'arctic', title: 'pathfinder' });
  assert.equal((await inspection.query('SELECT account_id FROM vb_career_claims WHERE guest_id=$1', [guest])).rows[0].account_id, account.id);
  await inspection.end(); inspection = null;
  await browser.close(); browser = null;
  await stopServer(server); server = null;
  await fixture.restart();

  const restarted = await start();
  other = await launchCdpSession(restarted);
  const remote = other.page;
  await remote.waitFor(`document.getElementById('account-nav-open')`);
  await remote.evaluate(`document.getElementById('account-nav-open').click()`);
  await fill(remote, { username, password });
  await remote.evaluate(`document.getElementById('account-form').requestSubmit()`);
  await remote.waitFor(`document.getElementById('name-input').readOnly && document.getElementById('career-menu-preview').textContent.includes('950 CREDITS')`, { timeoutMs: 20000 });
  await remote.evaluate(`document.getElementById('account-close').click()`);
  await remote.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await remote.waitFor(`Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)`);
  await mkdir('.artifacts/armory', { recursive: true });
  for (const [name, action] of [['postgres-main', ''], ['postgres-career', `document.getElementById('career-open').click()`]]) {
    if (action) await remote.evaluate(action);
    await remote.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const shot = await remote.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/armory/${name}.png`, Buffer.from(shot.data, 'base64'));
  }
  await remote.evaluate(`document.getElementById('career-close').click(); document.getElementById('play-btn').click()`);
  await remote.waitFor(`window.__vb?.stats?.running`, { timeoutMs: 30000 });
  assert.equal(await remote.evaluate(`getComputedStyle(document.querySelector('#crosshair .ch-arm')).backgroundColor`), 'rgb(114, 230, 255)');
  assert.match(await remote.evaluate(`document.getElementById('career-badge').textContent`), /Pathfinder/i);
  assert.deepEqual(remote.errors.filter(error => !/favicon|pointer.?lock/i.test(error)), []);
  console.log('PostgreSQL browser: prominent registration, guest claim, two purchases, SQL readback, container/server restart, independent-device login and in-match cosmetics passed.');
} finally {
  await inspection?.end().catch(() => {});
  await seed?.close().catch(() => {});
  await other?.close(); await browser?.close(); await stopServer(server);
  await fixture.close();
}
