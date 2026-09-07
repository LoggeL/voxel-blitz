import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameplayUiFlow } from '../public/js/session/gameplay-ui.js';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// LocalPlayer also owns an input gate. Session must repair an independent
// disable even when its own cached enabled flag has not changed.
let enabled = false;
let open = false;
let enables = 0;
let disables = 0;
let economyWrites = 0;
const gameplay = { running: true, alive: true, matchState: { mode: 'snd', phase: 'prep' }, selfRow: { state: 'alive' } };
const lifecycle = { liveActive: true, phase: 'live', disconnected: false, tornDown: false };
const flow = new GameplayUiFlow({
  gameplay,
  lifecycle,
  hud: {
    settingsOpen: false,
    isBuyMenuOpen: () => open,
    toggleBuyMenu: (next) => { open = next; },
    setBuyMenuState: () => { economyWrites++; },
  },
  input: { setGameplayEnabled: (next) => { enabled = next; }, consumeBuyMenuRequest() {}, requestLock() {} },
  unlockAudio() {},
  onInputEnabled: () => { enables++; },
  onInputDisabled: () => { disables++; },
});
flow.syncInput();
enabled = false;
flow.restoreFocus();
assert.equal(enabled, true);
assert.equal(enables, 1, 'repairing the shared input gate does not duplicate a local-player edge');
open = true;
flow.syncInput();
assert.equal(enabled, false);
gameplay.matchState.phase = 'live';
flow.syncBuyMenuState();
assert.equal(open, false);
assert.equal(enabled, true);
assert.equal(economyWrites, 0, 'session admission does not duplicate MatchHud economy updates');
lifecycle.disconnected = true;
flow.syncBuyMenuState();
assert.equal(enabled, false);
assert.equal(disables, 2);
console.log('ok - input gate repair, buy-phase exit and disconnect preserve lifecycle edges');

const server = startServer({ cwd: root, failureContext: 'HUD refactor contracts' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  // A same-origin text document allows real module/DOM tests without starting
  // a second game, WebGL renderer, audio graph, or live network session.
  browser = await launchCdpSession(`http://127.0.0.1:${port}/js/ui/hud-support.js`);
  const results = await browser.page.evaluate(`(async () => {
    const { HUD } = await import('/js/ui/hud.js');
    const { GameplayUiFlow } = await import('/js/session/gameplay-ui.js');
    const hud = new HUD();
    document.body.innerHTML = '';
    hud.buildHUD();
    const state = {
      hp: 100, alive: true, wid: 'rifle', wname: 'VK-77 RAPTOR',
      mag: 30, reserve: 6, infiniteMagazines: false, grenades: [2, 1, 1],
      grenadeType: 0, grenadeCharge: 0, grenadeCharging: false, grenadeCook01: 0,
      charge01: null, heat01: null, fuel01: null, reloading01: null,
      crosshairConeDeg: 1.35, crosshairHitRadius: 0, panic: 0, pain: 0,
      yawDeg: 0, adsT01: 0, breath01: 1,
    };
    hud.setState(state);
    await new Promise(requestAnimationFrame);
    hud.apply();
    const countMutations = (target, action) => {
      const observer = new MutationObserver(() => {});
      observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: true });
      action();
      const records = observer.takeRecords();
      observer.disconnect();
      return records.length;
    };
    const idleMutations = countMutations(hud.root('hud'), () => {
      for (let i = 0; i < 240; i++) hud.setState(state);
    });
    const counts = state.grenades;
    counts[0] = 0;
    hud.setState({ mag: 1, hp: 25, grenades: counts, grenadeType: 1 });
    const changedState = hud.dom.mag.textContent === '1'
      && hud.dom.mag.classList.contains('vb-low')
      && hud.dom.hpf.style.width === '25%'
      && hud.dom.grenadeTypeChips[0].classList.contains('is-empty')
      && hud.dom.grenadeTypeChips[1].classList.contains('is-selected');
    hud.setState({ ...state, hp: 100, mag: 30, grenadeType: 0 });
    hud.buildHUD();
    const rebuiltState = hud.dom.mag.textContent === '30'
      && hud.dom.hpf.style.width === '100%'
      && hud.dom.grenadeTypeChips[0].classList.contains('is-selected');

    const self = { id: 'self', name: 'SELF', hp: 100, state: 'alive', credits: 2000, owned: ['revolver'], team: 'alpha' };
    const match = { mode: 'snd', phase: 'prep', map: 'citadel', scores: { alpha: 0, bravo: 0 } };
    hud.setMatchState(match, self, [self], 1000);
    const closedBuyMutations = countMutations(hud.buyDom.root, () => {
      for (let i = 0; i < 50; i++) hud.setBuyMenuState({ credits: 2000 + i, owned: self.owned });
    });
    hud.toggleBuyMenu(true);
    const openedCurrentBalance = hud.buyDom.credVal.textContent.replace(/\\D/g, '') === '2049';
    const openBuyMutations = countMutations(hud.buyDom.root, () => {
      for (let i = 0; i < 50; i++) hud.setBuyMenuState({ credits: 2049, owned: [...self.owned] });
    });
    hud.setBuyMenuState({ credits: 0 });
    const purchaseGuard = hud.buyDom.cards.smg.buyBtn.disabled;
    const names = hud.nameFor('self') === 'SELF';

    const chaosSelf = { ...self, owned: ['rifle'], chaosUpgrades: { rifle: 2 } };
    const chaosMatch = { ...match, mode: 'chaos', phase: 'live' };
    hud.setMatchState(chaosMatch, chaosSelf, [chaosSelf], 2000);
    const flow = new GameplayUiFlow({
      hud,
      gameplay: { running: true, alive: true, matchState: chaosMatch, selfRow: chaosSelf },
      lifecycle: { liveActive: true, phase: 'live', disconnected: false, tornDown: false },
      input: { setGameplayEnabled() {}, consumeBuyMenuRequest() {}, requestLock() {}, exit() {} },
      unlockAudio() {},
    });
    hud.toggleBuyMenu(true);
    hud.openSettings();
    flow.resumeFromSettings();
    // Reopen before any replacement snapshot can refresh the economy.
    flow.toggleBuyMenuFromInput();
    const pauseResumeEconomy = hud.isBuyMenuOpen()
      && hud.buyDom.credVal.textContent.replace(/\\D/g, '') === '2000'
      && hud.buyDom.cards.rifle.priceBadge.textContent === '2 / 3 INSTALLED'
      && hud.buy._buyMenuState.owned.includes('rifle');
    hud.dispose();
    return { idleMutations, changedState, rebuiltState, closedBuyMutations,
      openedCurrentBalance, openBuyMutations, purchaseGuard, names, pauseResumeEconomy };
  })()`);
  assert.equal(results.idleMutations, 0, '240 unchanged gameplay frames must not mutate HUD DOM');
  assert.equal(results.closedBuyMutations, 0, 'closed shops retain state without repainting cards');
  assert.equal(results.openBuyMutations, 0, 'identical authority updates must not repaint an open shop');
  for (const key of ['changedState', 'rebuiltState', 'openedCurrentBalance', 'purchaseGuard', 'names', 'pauseResumeEconomy']) {
    assert.equal(results[key], true, key);
  }
  console.log('ok - browser HUD mutation and rebuild contracts', JSON.stringify(results));
} finally {
  await browser?.close();
  await stopServer(server);
}
