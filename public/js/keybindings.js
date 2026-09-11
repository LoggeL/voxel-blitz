// Shared keyboard preferences for gameplay, settings, and their on-screen hints.
export const KEYBINDINGS_PREF_KEY = 'vb-keybindings-v1';
export const KEYBINDING_ACTIONS = Object.freeze([
  ['forward', 'Move forward', ['KeyW']], ['back', 'Move backward', ['KeyS']],
  ['left', 'Strafe left', ['KeyA']], ['right', 'Strafe right', ['KeyD']],
  ['jump', 'Jump / vault / stand up', ['Space']],
  ['sprint', 'Sprint / steady aim', ['ShiftLeft', 'ShiftRight']],
  ['crouch', 'Crouch (hold)', ['ControlLeft', 'ControlRight', 'KeyC']],
  ['prone', 'Prone (toggle)', ['KeyX']], ['interact', 'Interact / plant / defuse / repair', ['KeyE']],
  ['fire', 'Fire (keyboard alternative)', []], ['ads', 'Aim down sights', ['KeyF']],
  ['reload', 'Reload', ['KeyR']], ['quickMelee', 'Quick pickaxe hit', ['KeyV']],
  ['medkit', 'Medkit / cancel healing', ['KeyJ']], ['grenade', 'Throw grenade (hold / release)', ['KeyG']],
  ['grenadeType', 'Next grenade type', ['KeyH']], ['zoom', 'Scope zoom', ['KeyZ']],
  ['weaponWheel', 'Weapon wheel (hold)', ['KeyQ']], ['buy', 'Buy menu / armory', ['KeyB']],
  ['scoreboard', 'Scoreboard (hold)', ['Tab']],
  ['previousWeapon', 'Previous weapon', []], ['nextWeapon', 'Next weapon', []],
  ...Array.from({ length: 10 }, (_, i) => [`slot${i + 1}`, `Weapon slot ${i + 1}`, [`Digit${(i + 1) % 10}`]]),
  ['spectatePrevious', 'Spectate previous player', ['ArrowLeft', 'KeyQ'], 'spectator'],
  ['spectateNext', 'Spectate next player', ['ArrowRight', 'KeyE'], 'spectator'],
  ['skipReplay', 'Skip killcam replay', ['Space'], 'replay'],
].map(([id, label, codes, context = 'gameplay']) => Object.freeze({ id, label, codes: Object.freeze(codes), context })));
const ACTIONS = new Map(KEYBINDING_ACTIONS.map(action => [action.id, action]));
const listeners = new Set();
const overlaps = (a, b) => a.context === b.context || [a.id, b.id].some(id => id === 'scoreboard' || id === 'buy');
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const action of KEYBINDING_ACTIONS) {
    const codes = value[action.id];
    if (Array.isArray(codes) && codes.length <= 3 && codes.every(isBindableCode)) {
      result[action.id] = [...new Set(codes)];
    }
  }
  // A damaged preference must never make one press trigger two combat actions.
  const accepted = [];
  for (const action of KEYBINDING_ACTIONS) {
    result[action.id] = result[action.id].filter(code => {
      if (accepted.some(other => other.code === code && overlaps(action, other.action))) return false;
      accepted.push({ action, code });
      return true;
    });
  }
  return result;
}

export function readKeybindings() {
  let raw = null;
  try { raw = localStorage.getItem(KEYBINDINGS_PREF_KEY); } catch (_) {}
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
  try { localStorage.setItem(KEYBINDINGS_PREF_KEY, raw); cachedRaw = raw; } catch (_) {}
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
  const conflict = code && KEYBINDING_ACTIONS.find(other => other.id !== actionId
    && overlaps(other, action) && bindings[other.id].includes(code));
  if (conflict) return { ok: false, conflict: conflict.id, error: `${keyCodeLabel(code)} is assigned to ${conflict.label}. Clear or change that action first.` };
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
