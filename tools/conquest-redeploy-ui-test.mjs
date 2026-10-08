// In-game menu RESPAWN (Conquest redeploy) presentation: the menu button shows
// only while the game offers it, a click closes the menu without resuming
// (no pointer re-lock: the deploy screen that opens on the death owns the
// mouse) and runs the action, a refused send brings the menu back; the
// `redeploy` kill key reads REDEPLOYED with a vector icon in the feed and on
// the killer card. Fake DOM, no browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

const { document } = installFakeDom({ width: 1440, height: 900 });
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { HUD } = await import('../public/js/ui/hud.js');
const state = await import('../public/js/ui/conquest-hud-state.js');
const { WEAPON_NAMES, isVehicleKillKey } = await import('../public/js/ui/hud-support.js');
const { KILL_KEY_ICONS, ICON_PATHS } = await import('../public/js/ui/conquest/icons.js');
let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };

// --- menu button ------------------------------------------------------------------------
{
  const hud = new HUD();
  let available = false, result = true, runs = 0, resumes = 0;
  hud.setupSettings({ onResume: () => { resumes++; }, respawn: { available: () => available, run: () => { runs++; return result; } } });
  hud.openSettings();
  const button = document.getElementById('settings-respawn-btn');
  check(!!button, 'the in-game menu has a RESPAWN button');
  check(button.hidden && button.style.display === 'none', 'hidden while the game does not offer it');
  hud.closeSettings();
  available = true;
  hud.openSettings();
  check(!button.hidden && button.style.display !== 'none' && !button.disabled, 'shown while alive in a live Conquest match');
  check(button.textContent.includes('RESPAWN') && /death/i.test(button.textContent), 'labelled RESPAWN with its cost');
  const rail = button.parentNode;
  const order = [...rail.children].map(child => child.id).filter(Boolean);
  check(order.indexOf('settings-resume-btn') < order.indexOf('settings-respawn-btn')
    && order.indexOf('settings-respawn-btn') < order.indexOf('settings-leave-btn'), 'it sits between RESUME and QUIT');
  button.click();
  check(runs === 1 && !hud.settingsOpen && resumes === 0, 'a click closes the menu without resuming and runs the redeploy');
  hud.openSettings();
  result = false;
  button.click();
  check(runs === 2 && hud.settingsOpen, 'a send that did not go out brings the menu back');
  available = false;
  button.click();
  check(runs === 2, 'nothing runs once the game no longer offers it');
  hud.closeSettings();
  hud.openSettings();
  check(button.hidden, 'and the button hides again');
  hud.closeSettings();
}

// --- kill key -------------------------------------------------------------------------
{
  check(WEAPON_NAMES.redeploy === 'REDEPLOYED' && isVehicleKillKey('redeploy') && ICON_PATHS[KILL_KEY_ICONS.redeploy],
    'the redeploy key has a name and a vector icon');
  const own = state.killerCard({ kind: 'kill', killer: '', victim: 'me', w: 'redeploy' }, 'me', []);
  check(own.self && own.name === 'REDEPLOYED', 'a self redeploy reads YOU DIED · REDEPLOYED');
  const credited = state.killerCard({ kind: 'kill', killer: 'en9', victim: 'me', w: 'redeploy' }, 'me', [{ id: 'en9', name: 'Rourke', team: 'bravo' }]);
  check(!credited.self && credited.name === 'Rourke' && credited.weaponName === 'REDEPLOYED', 'a credited redeploy names the enemy');
}

// --- wiring ---------------------------------------------------------------------------
{
  const main = await readFile(new URL('../public/js/main.js', import.meta.url), 'utf8');
  check(/sendConquest\(\{ redeploy: 1 \}\)/.test(main), 'main.js sends the redeploy intent');
  check(/redeployAvailable\(\)\s*{\s*return this\.matchState\?\.mode === 'conquest' && this\.matchState\.phase === 'live'/.test(main),
    'the button is offered in live Conquest matches only');
  const session = await readFile(new URL('../public/js/session/session.js', import.meta.url), 'utf8');
  check(/respawn: this\._respawnAction/.test(session), 'Session hands the action to the menu');
}

console.log(`conquest-redeploy-ui-test: OK (${checks} checks)`);
