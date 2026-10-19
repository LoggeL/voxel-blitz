// Shared keyboard preferences for gameplay, settings, and their on-screen hints.
export const KEYBINDINGS_PREF_KEY = 'vb-keybindings-v1';
/** What weapon slot keys 1-4 raise in Conquest, in KIT_DIGIT_ROLES order. */
const KIT_SLOT_CAPTIONS = ['primary', 'sidearm', 'gadget', 'melee'];
export const KEYBINDING_ACTIONS = Object.freeze([
  ['forward', 'Move forward', ['KeyW']], ['back', 'Move backward', ['KeyS']],
  ['left', 'Strafe left', ['KeyA']], ['right', 'Strafe right', ['KeyD']],
  ['leanLeft', 'Lean left (hold)', ['KeyQ']], ['leanRight', 'Lean right (hold)', ['KeyE']],
  ['jump', 'Jump / vault / stand up', ['Space']],
  ['sprint', 'Sprint / steady aim', ['ShiftLeft', 'ShiftRight']],
  ['crouch', 'Crouch (hold)', ['ControlLeft', 'ControlRight', 'KeyC']],
  ['prone', 'Prone (toggle)', ['KeyX']], ['interact', 'Interact / plant / defuse / repair', ['KeyT']],
  ['fire', 'Fire (keyboard alternative)', []], ['ads', 'Aim down sights', ['KeyF']],
  ['reload', 'Reload', ['KeyR']], ['quickMelee', 'Quick pickaxe hit', ['KeyV']],
  ['dropWeapon', 'Drop weapon (TTT)', ['KeyL']],
  ['medkit', 'Medkit / cancel healing', ['KeyJ']], ['grenade', 'Throw ready grenade (tap / hold to aim)', ['KeyG']],
  ['grenadeType', 'Grenade pouch (tap: next / hold: pouch)', ['KeyH']],
  ['grenadePrevious', 'Previous grenade type', []], ['grenadeCancel', 'Pin back held grenade', []],
  // Quick keys ready one type and begin the hold. Unbound by default: digits are weapon
  // slots and keyCodeLabel names the physical code, not the layout's printed key.
  ['grenadeFrag', 'Quick grenade: frag', []], ['grenadeClaymore', 'Quick grenade: claymore', []],
  ['grenadePulse', 'Quick grenade: pulse', []], ['grenadeMolotov', 'Quick grenade: molotov', []],
  ['grenadeSmoke', 'Quick grenade: smoke', []], ['grenadeAtMine', 'Quick grenade: AT mine (Conquest)', []],
  ['zoom', 'Scope zoom', ['KeyZ']],
  ['weaponWheel', 'Weapon wheel (hold)', ['KeyK']], ['buy', 'Buy menu / armory', ['KeyB']],
  ['build', 'Build mode (Bastion)', ['KeyN']],
  ['scoreboard', 'Scoreboard (hold)', ['Tab']],
  // Conquest. KeyY is the physical key printed Z on QWERTZ keyboards.
  ['spot', 'Spot enemy (Conquest)', ['KeyY']], ['bigMap', 'Full map (Conquest)', ['KeyM']],
  ['previousWeapon', 'Previous weapon', []], ['nextWeapon', 'Next weapon', []],
  // Conquest reads slot keys 1-4 kit-relative (KIT_DIGIT_ROLES in shared/conquest-kits.js);
  // slots 5-10 do nothing there. Seated, slot keys pick the seat's weapons.
  ...Array.from({ length: 10 }, (_, i) => [`slot${i + 1}`,
    `Weapon slot ${i + 1}${KIT_SLOT_CAPTIONS[i] ? ` (Conquest: ${KIT_SLOT_CAPTIONS[i]})` : ''}`, [`Digit${(i + 1) % 10}`]]),
  ['spectatePrevious', 'Spectate previous player', ['ArrowLeft', 'KeyQ'], 'spectator'],
  ['spectateNext', 'Spectate next player', ['ArrowRight', 'KeyE'], 'spectator'],
  ['skipReplay', 'Skip killcam replay', ['Space'], 'replay'],
  // Seated in a Conquest vehicle these replace prone / crouch / lean on the same keys.
  ['vehicleCountermeasure', 'Vehicle countermeasure (flares / smoke)', ['KeyX'], 'vehicle'],
  ['vehicleCamera', 'Vehicle free look (hold)', ['KeyC'], 'vehicle'],
  // V is the infantry quick melee, which no seat uses.
  ['vehicleView', 'Vehicle camera view (chase / cockpit / ...)', ['KeyV'], 'vehicle'],
  ['vehicleWeaponNext', 'Next vehicle weapon', ['KeyQ'], 'vehicle'],
  // Titanfall (docs/titanfall.md §8.2). Separate key spaces: on foot the pilot keys
  // replace lean (Q/E) only in titanfall; seated in a titan the titan keys replace the
  // vehicle and infantry keys. Capture-phase controllers consume them.
  ['pilotTactical', 'Pilot tactical: grapple / stim / cloak (Titanfall)', ['KeyQ'], 'pilot'],
  ['callTitan', 'Call titan (Titanfall)', ['KeyE'], 'pilot'],
  ['titanDash', 'Titan dash', ['Space'], 'titan'],
  ['titanDefensive', 'Titan defensive (hold)', ['KeyQ'], 'titan'],
  ['titanTactical', 'Titan tactical', ['KeyE'], 'titan'],
  ['titanOrdnance', 'Titan ordnance', ['KeyG'], 'titan'],
  ['titanCore', 'Titan core', ['KeyV'], 'titan'],
  ['titanSmoke', 'Titan electric smoke', ['KeyC'], 'titan'],
  ['titanEject', 'Titan eject (triple tap while doomed)', ['KeyX'], 'titan'],
  ['titanMelee', 'Titan melee', ['KeyF'], 'titan'],
  ['titanView', 'Titan camera (cockpit / chase)', ['KeyH'], 'titan'],
].map(([id, label, codes, context = 'gameplay']) => Object.freeze({ id, label, codes: Object.freeze(codes), context })));
const ACTIONS = new Map(KEYBINDING_ACTIONS.map(action => [action.id, action]));
const listeners = new Set();
// Titanfall's capture-phase controllers consume their keys before Input and the seated
// VehicleController see them, so those keys must not double up with gameplay keys that are
// live at the same time: on foot the pilot keys replace only lean; seated in a titan the
// titan keys must leave the walker's movement, fire, reload, interact and slot keys alone.
const PILOT_SHARES = new Set(['leanLeft', 'leanRight']);
const TITAN_CLASHES = new Set(['forward', 'back', 'left', 'right', 'sprint', 'fire', 'reload', 'interact',
  ...Array.from({ length: 10 }, (_, i) => `slot${i + 1}`)]);
const shadows = (a, b) => b.context === 'gameplay'
  && ((a.context === 'pilot' && !PILOT_SHARES.has(b.id)) || (a.context === 'titan' && TITAN_CLASHES.has(b.id)));
const overlaps = (a, b) => a.context === b.context || shadows(a, b) || shadows(b, a)
  || [a.id, b.id].some(id => id === 'scoreboard' || id === 'buy');
let storageKey = KEYBINDINGS_PREF_KEY;
let cachedRaw;
let cachedBindings;

export function defaultKeybindings() {
  return Object.fromEntries(KEYBINDING_ACTIONS.map(action => [action.id, [...action.codes]]));
}

export function isBindableCode(code) {
  return typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Numpad(Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash)$/.test(code);
}

export function normalizeKeybindings(value) {
  const result = defaultKeybindings();
  const saved = new Set();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const action of KEYBINDING_ACTIONS) {
      const codes = value[action.id];
      if (Array.isArray(codes) && codes.length <= 3 && codes.every(isBindableCode)) {
        result[action.id] = [...new Set(codes)];
        saved.add(action.id);
      }
    }
  }
  // A damaged preference must never make one press trigger two combat actions.
  // Saved choices claim their keys first, so the default of an action added
  // after the save (Q/E lean) yields to a key the player already assigned.
  // Titanfall's pilot/titan keys come last, so they never take a key from any other mode.
  const accepted = [];
  const titanfallKey = action => action.context === 'pilot' || action.context === 'titan';
  for (const [titanfall, claimSaved] of [[false, true], [false, false], [true, true], [true, false]]) {
    for (const action of KEYBINDING_ACTIONS) {
      if (titanfallKey(action) !== titanfall || saved.has(action.id) !== claimSaved) continue;
      result[action.id] = result[action.id].filter(code => {
        if (accepted.some(other => other.code === code && overlaps(action, other.action))) return false;
        accepted.push({ action, code });
        return true;
      });
    }
  }
  return result;
}

export function readKeybindings() {
  let raw = null;
  try { raw = localStorage.getItem(storageKey); } catch (_) {}
  if (!cachedBindings || cachedRaw !== raw) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {}
    cachedRaw = raw;
    cachedBindings = normalizeKeybindings(parsed);
  }
  return Object.fromEntries(Object.entries(cachedBindings).map(([id, codes]) => [id, [...codes]]));
}

function publish(bindings) {
  const raw = JSON.stringify(bindings);
  try { localStorage.setItem(storageKey, raw); cachedRaw = raw; } catch (_) {}
  cachedBindings = bindings;
  for (const listener of listeners) listener(readKeybindings());
  return readKeybindings();
}

export function setKeybinding(actionId, code) {
  const action = ACTIONS.get(actionId);
  if (!action || (code !== null && !isBindableCode(code))) {
    return { ok: false, error: 'Choose a letter, number, arrow, modifier, or navigation key. Escape is reserved for menus.' };
  }
  const bindings = readKeybindings();
  // A Titanfall pilot/titan key never blocks a key for the other modes' actions: it yields
  // (as in normalizeKeybindings) and that Titanfall action is left unbound instead.
  const titanfallAction = a => a.context === 'pilot' || a.context === 'titan';
  const yields = other => titanfallAction(other) && !titanfallAction(action);
  const conflict = code && KEYBINDING_ACTIONS.find(other => other.id !== actionId
    && overlaps(other, action) && !yields(other) && bindings[other.id].includes(code));
  if (conflict) return { ok: false, conflict: conflict.id, error: `${keyCodeLabel(code)} is assigned to ${conflict.label}. Clear or change that action first.` };
  if (code) {
    for (const other of KEYBINDING_ACTIONS) {
      if (other.id !== actionId && yields(other) && overlaps(other, action)) bindings[other.id] = bindings[other.id].filter(c => c !== code);
    }
  }
  bindings[actionId] = code ? [code] : [];
  return { ok: true, bindings: publish(bindings) };
}

export function resetKeybindings() { return publish(defaultKeybindings()); }
export function subscribeKeybindings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function matchesBinding(event, actionId, bindings = (cachedBindings || readKeybindings())) {
  return !!bindings[actionId]?.includes(event?.code);
}
export function keyCodeLabel(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit/.test(code)) return code.slice(5);
  const labels = { ShiftLeft: 'LEFT SHIFT', ShiftRight: 'RIGHT SHIFT', ControlLeft: 'LEFT CTRL', ControlRight: 'RIGHT CTRL', AltLeft: 'LEFT ALT', AltRight: 'RIGHT ALT', Space: 'SPACE', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
  return labels[code] || code.replace(/^Numpad/, 'NUM ').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}
export function bindingLabel(actionId, bindings = (cachedBindings || readKeybindings())) {
  return bindings[actionId]?.map(keyCodeLabel).join(' / ') || 'UNBOUND';
}
export function isTypingTarget(target) {
  return !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '') || target.isContentEditable === true);
}

// Separate guest and account caches, including on shared browsers.
export function useKeybindingAccount(userId) {
  storageKey = userId ? `${KEYBINDINGS_PREF_KEY}:${userId}` : KEYBINDINGS_PREF_KEY;
  cachedBindings = null;
  cachedRaw = undefined;
  for (const listener of listeners) listener(readKeybindings());
}
export function replaceKeybindings(value) { return publish(normalizeKeybindings(value)); }
