import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'vb-accounts-browser-'));
const guest = randomBytes(32).toString('hex');
await writeFile(path.join(directory, guest + '.json'), JSON.stringify({ xp: 150, credits: 150, kills: 6, matches: 0,
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie' } }));
const server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory }, failureContext: 'accounts browser test' });
const username = 'Account_UI_Player_20';
const password = 'browser test password one';
const secondPassword = 'browser test password two';
const recoveredPassword = 'browser test password three';
let browser, other;
const open = page => page.evaluate(`document.getElementById('account-open').focus(); document.getElementById('account-open').click()`);
const fill = (page, values) => page.evaluate(`(() => { const values = ${JSON.stringify(values)}; for (const [name, value] of Object.entries(values)) {
  const input = document.querySelector('#account-form [name="' + name + '"]');
  if (!input) throw new Error('Missing account field: ' + name);
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
} })()`);
const submit = async page => {
  await page.evaluate(`document.getElementById('account-form').requestSubmit()`);
  await page.waitFor(`document.getElementById('account-dialog').getAttribute('aria-busy') === 'false'`, { timeoutMs: 20000 });
};
const assertGuest = async page => {
  assert.equal(await page.evaluate(`document.getElementById('name-input').readOnly`), false);
  assert.equal(await page.evaluate(`document.getElementById('play-btn').disabled`), false, 'guest Quick Play remains available');
};
try {
  const port = await server.port; await waitForHttp(port);
  const url = `http://127.0.0.1:${port}/?headless=1&debug=1`;
  browser = await launchCdpSession(url);
  const page = browser.page;
  await page.send('Network.setCookie', { name: 'vb-career', value: guest, url, httpOnly: true, sameSite: 'Strict' });
  await page.send('Page.reload');
  await page.waitFor(`document.getElementById('account-open') && document.getElementById('play-btn') && document.querySelector('.vb-career-stats')?.textContent.includes('150 CREDITS')`);
  await assertGuest(page);
  await page.evaluate(`document.getElementById('name-input').value = 'GuestPilot'; document.getElementById('name-input').dispatchEvent(new Event('input', { bubbles: true }));`);
  await open(page);
  await page.evaluate(`document.getElementById('account-guest').click()`);
  assert.equal(await page.evaluate(`document.getElementById('account-dialog').open`), false, 'guest choice closes the optional dialog');
  await page.waitFor(`document.activeElement.id === 'account-open'`, { label: 'account opener focus restored' });
  assert.equal(await page.evaluate(`document.activeElement.id`), 'account-open', 'closing restores focus to the account button');
  await open(page);
  await page.evaluate(`document.getElementById('account-tab-register').click()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await page.evaluate(`document.getElementById('account-dialog').scrollWidth <= document.getElementById('account-dialog').clientWidth`), true, '390px registration form fits without horizontal overflow');
  await mkdir('.artifacts/accounts', { recursive: true });
  const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile('.artifacts/accounts/register-390.png', Buffer.from(screenshot.data, 'base64'));
  await fill(page, { username, password, confirmPassword: 'mismatched long password' });
  await submit(page);
  assert.match(await page.evaluate(`document.getElementById('account-feedback').textContent`), /do not match/);
  await fill(page, { confirmPassword: password });
  await page.evaluate(`window.accountEvents = []; window.addEventListener('vb-account-change', event => window.accountEvents.push(event.detail)); document.getElementById('account-form').requestSubmit();`);
  assert.equal(await page.evaluate(`document.getElementById('account-submit').disabled`), true, 'pending registration cannot be submitted twice');
  await page.waitFor(`!!document.getElementById('account-recovery-code') && document.getElementById('account-dialog').getAttribute('aria-busy') === 'false'`, { timeoutMs: 20000, label: 'registered recovery code' });
  const recoveryCode = await page.evaluate(`document.getElementById('account-recovery-code').textContent`);
  assert.ok(recoveryCode.length >= 40);
  assert.equal(await page.evaluate(`window.accountEvents.every(event => !('recoveryCode' in event))`), true);
  assert.equal(await page.evaluate(`document.getElementById('name-input').value`), username);
  assert.equal(await page.evaluate(`document.getElementById('name-input').readOnly`), true, 'signed-in player name is the account username');
  assert.equal(await page.evaluate(`document.cookie.includes('vb-account')`), false, 'session cookie is HttpOnly');
  await page.evaluate(`document.getElementById('account-code-done').click();`);
  assert.equal(await page.evaluate(`!!document.getElementById('account-recovery-code')`), false, 'recovery reveal is removed after saving');
  await page.evaluate(`document.getElementById('account-close').click(); document.getElementById('career-open').click();`);
  await page.waitFor(`document.querySelector('.vb-career-stats').textContent.includes('150 CREDITS')`);
  await page.evaluate(`document.querySelector('[data-item="arctic"]').click()`);
  await page.waitFor(`document.querySelector('.vb-career-status').textContent === 'Arctic equipped'`);
  await page.evaluate(`document.getElementById('career-close').click()`);
  console.log('Accounts browser: optional guest path, registration, validation, private recovery reveal, account name and guest-career adoption passed.');

  // A completely separate browser profile represents another device.
  other = await launchCdpSession(url);
  const remote = other.page;
  await remote.waitFor(`document.getElementById('account-open') && document.getElementById('play-btn')`);
  await assertGuest(remote);
  await open(remote); await fill(remote, { username, password }); await submit(remote);
  await remote.waitFor(`document.getElementById('name-input').readOnly && getComputedStyle(document.documentElement).getPropertyValue('--career-accent').trim() === '#72e6ff'`);
  assert.equal(await remote.evaluate(`document.querySelector('.vb-career-stats').textContent.includes('50 CREDITS')`), true, 'purchased career follows login on a different device');
  await fill(remote, { currentPassword: 'incorrect existing password', newPassword: secondPassword, confirmPassword: secondPassword });
  await submit(remote);
  assert.match(await remote.evaluate(`document.getElementById('account-feedback').textContent`), /password/i);
  await fill(remote, { currentPassword: password }); await submit(remote);
  assert.equal(await remote.evaluate(`document.getElementById('account-feedback').textContent`), 'Password changed.');
  await remote.evaluate(`document.getElementById('account-logout').click()`);
  await remote.waitFor(`!document.getElementById('name-input').readOnly && !document.getElementById('account-logout')`);
  await fill(remote, { username, password }); await submit(remote);
  assert.match(await remote.evaluate(`document.getElementById('account-feedback').textContent`), /password/i, 'previous password no longer works');
  await remote.evaluate(`document.getElementById('account-tab-recover').click()`);
  await fill(remote, { username, recoveryCode, newPassword: recoveredPassword, confirmPassword: recoveredPassword }); await submit(remote);
  await remote.waitFor(`!!document.getElementById('account-recovery-code')`, { timeoutMs: 20000 });
  const replacementCode = await remote.evaluate(`document.getElementById('account-recovery-code').textContent`);
  assert.notEqual(replacementCode, recoveryCode, 'account recovery rotates its single-use code');
  await remote.evaluate(`document.getElementById('account-code-done').click(); document.getElementById('account-logout').click();`);
  await remote.waitFor(`!document.getElementById('name-input').readOnly`);
  await remote.evaluate(`document.getElementById('account-tab-recover').click()`);
  await fill(remote, { username, recoveryCode, newPassword: secondPassword, confirmPassword: secondPassword }); await submit(remote);
  assert.equal(await remote.evaluate(`!!document.getElementById('account-recovery-code')`), false, 'used recovery code cannot be reused');
  assert.match(await remote.evaluate(`document.getElementById('account-feedback').textContent`), /recovery|code/i);
  await remote.evaluate(`document.getElementById('account-tab-login').click()`);
  await fill(remote, { username, password: recoveredPassword }); await submit(remote);
  await remote.waitFor(`document.getElementById('name-input').readOnly`);
  await remote.send('Page.reload');
  await remote.waitFor(`document.getElementById('name-input')?.readOnly && document.querySelector('.vb-career-stats')?.textContent.includes('50 CREDITS')`);
  console.log('Accounts browser: independent-device career sync, password change, session revocation, recovery rotation and login persistence passed.');

  // The first browser's old session was revoked. Career must refresh the
  // identity too, so it never labels the new guest balance as account progress.
  await page.evaluate(`document.getElementById('career-open').click()`);
  await page.waitFor(`!document.getElementById('name-input').readOnly`);
  await page.waitFor(`document.querySelector('.vb-career-account p').textContent.includes('Guest career')`);
  assert.equal(await page.evaluate(`document.getElementById('name-input').value`), 'GuestPilot', 'session expiry restores the previous guest callsign');
  await page.evaluate(`document.getElementById('career-close').click()`);
  await open(page);
  await page.evaluate(`document.getElementById('account-guest').click()`);
  assert.equal(await page.evaluate(`document.getElementById('account-strip').scrollWidth <= document.getElementById('account-strip').clientWidth`), true, '390px account strip fits');
  assert.equal(await page.evaluate(`document.getElementById('menu').scrollWidth <= document.getElementById('menu').clientWidth`), true, 'account strip does not overflow the main menu');
  await assertGuest(page);
  const warningView = await page.evaluate(`(async () => {
    const { AccountMenu } = await import('/js/ui/account-menu.js');
    const fixture = new AccountMenu(); fixture.dialog.id = 'account-warning-fixture';
    fixture.user = { id: 'fixture', username: 'Fixture' }; fixture.mode = 'account';
    fixture.warning = 'Account created. Your guest progress transfer is pending.';
    fixture.recoveryCode = 'private-fixture-recovery-code'; fixture.render();
    const warningVisible = fixture.dialog.querySelector('#account-warning').textContent.includes('pending');
    const recoveryPreserved = fixture.dialog.querySelector('#account-recovery-code').textContent === fixture.recoveryCode;
    fixture.warning = ''; fixture.syncWarning();
    const warningCleared = !fixture.dialog.querySelector('#account-warning');
    fixture.dispose();
    return { warningVisible, recoveryPreserved, warningCleared };
  })()`);
  assert.deepEqual(warningView, { warningVisible: true, recoveryPreserved: true, warningCleared: true }, 'a storage warning is visible alongside the one-time recovery reveal and clears after recovery');
  const errors = [...page.errors, ...remote.errors].filter(text => !/favicon|pointer.?lock|Failed to load resource.*(?:400|401|409)/i.test(text));
  assert.deepEqual(errors, [], 'account flow has no unexpected browser errors');
  console.log('Accounts browser: expired-session refresh, guest-name restoration and narrow account/menu layout passed.');
} finally {
  await other?.close(); await browser?.close(); await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
