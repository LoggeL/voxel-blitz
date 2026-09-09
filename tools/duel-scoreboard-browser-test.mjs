import assert from 'node:assert/strict';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';
const server = startServer(); let browser;
try {
 const port = await server.port;
 browser = await launchCdpSession(`http://127.0.0.1:${port}/`);
 const result = await browser.page.evaluate(`(async () => {
  document.body.innerHTML = '<div id="test-hud"></div>';
  const { MatchHud } = await import('/js/ui/match-hud.js');
  const { LobbySettings } = await import('/js/ui/lobby-settings.js');
  const hud = new MatchHud(); hud.build(document.getElementById('test-hud'));
  const players = [{id:'a',name:'Host',kills:3,hp:100},{id:'b',name:'Guest',kills:2,hp:100}];
  const match = {mode:'duel',phase:'live',killLimit:5,scores:{a:3,b:2}};
  hud.setMatchState(match, players[0], players, 1000);
  const visible = ['alpha','bravo'].every(side => hud.dom[side+'Block'].getBoundingClientRect().width > 0);
  const score = [hud.dom.alphaName.textContent,hud.dom.alphaScore.textContent,hud.dom.bravoName.textContent,hud.dom.bravoScore.textContent,hud.dom.phaseLabel.textContent];
  hud.setMatchState({...match,phase:'post',winner:'a',phaseEndsAt:9000},players[0],players,1000);
  const winner = document.getElementById('match-result-title').textContent;
  const settings = new LobbySettings(document.body, value => window.changed = value);
  settings.update({gameMode:'duel',map:'depot',bots:0,phase:'waiting',duelKillLimit:5},true);
  const select = settings.controls.duelKillLimit;
  const initial = select.value;
  select.value='10'; select.dispatchEvent(new Event('change'));
  settings.update({gameMode:'duel',map:'depot',bots:0,phase:'waiting',duelKillLimit:5},false);
  return {visible,score,winner,initial,changed:window.changed.duelKillLimit,locked:select.disabled};
 })()`);
 assert.deepEqual(result,{visible:true,score:['Host','3','Guest','2','FIRST TO 5 KILLS'],winner:'VICTORY',initial:'5',changed:10,locked:true});
 console.log('Browser passed: visible player scoreboard, first-to-5 target, victory overlay, host selector and guest lock.');
} finally { if(browser) await browser.close(); await stopServer(server); }
