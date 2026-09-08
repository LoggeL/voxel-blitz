import assert from 'node:assert/strict';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
const server = startServer({ cwd: process.cwd(), failureContext: 'Duel UI' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/js/ui/hud-support.js`);
  const result = await browser.page.evaluate(`(async () => {
    const { HUD } = await import('/js/ui/hud.js');
    const hud = new HUD();
    document.body.innerHTML = '';
    let action;
    hud.buildMenu(value => { action = value; });
    document.getElementById('create-duel-btn').click();
    const state = { code: 'ABCDE', selfId: '1', host: '1', phase: 'waiting', gameMode: 'duel', map: 'depot', bots: 0, members: [{id:'1', name:'Host', ready:true}] };
    hud.showLobby(state, {});
    const waiting = document.getElementById('lobby-start-btn').disabled;
    const loadout = document.getElementById('lobby-weapon-set').textContent;
    const botsDisabled = document.getElementById('bot-count').disabled;
    const link = document.getElementById('lobby-invite-input').value;
    state.members.push({ id:'2', name:'Guest', ready:true });
    hud.updateLobby(state);
    const ready = !document.getElementById('lobby-start-btn').disabled;
    hud.dispose();
    return { action, waiting, loadout, botsDisabled, link, ready };
  })()`);
  assert.equal(result.action.gameMode, 'duel');
  assert.equal(result.action.bots, 0);
  assert.ok(result.waiting && result.ready && result.botsDisabled);
  assert.match(result.loadout, /BASE 1V1 WEAPON SET/);
  assert.equal(new URL(result.link).searchParams.get('lobby'), 'ABCDE');
  console.log('Duel browser checks passed: create action, setup loadout, invite link and readiness.');
} finally { await browser?.close(); await stopServer(server); }
