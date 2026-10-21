// Keyboard helpers for the armory: roving tabindex over a list of controls, ARIA
// tree navigation and focus restoration by `data-focus-key` across re-renders.

/** Rendered and reachable: not hidden, and not inside a collapsed <details>. */
const visible = element => !element.closest('[hidden], details:not([open]) > :not(summary)');
const items = (container, selector) => [...container.querySelectorAll(selector)].filter(visible);

/** Exactly one item in the group is tabbable: `active`, else the current one, else the first. */
export function rovingSync(container, selector, active = null) {
  const list = items(container, selector);
  const current = active && list.includes(active) ? active
    : list.find(item => item.getAttribute('aria-selected') === 'true' || item.getAttribute('aria-current') === 'true'
      || item.getAttribute('aria-pressed') === 'true') || list[0];
  for (const item of container.querySelectorAll(selector)) item.tabIndex = item === current ? 0 : -1;
  return current || null;
}

const STEP = {
  horizontal: { ArrowLeft: -1, ArrowRight: 1 },
  vertical: { ArrowUp: -1, ArrowDown: 1 },
  both: { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 },
};

/** Arrow keys, Home and End move focus inside the group; `onMove(item)` follows. */
export function rovingKeys(container, selector, { orientation = 'both', onMove = null } = {}) {
  container.addEventListener('keydown', event => {
    const origin = event.target.closest?.(selector);
    if (!origin || !container.contains(origin)) return;
    const list = items(container, selector);
    const at = list.indexOf(origin);
    let next = null;
    if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list.at(-1);
    else if (STEP[orientation][event.key]) next = list[Math.min(list.length - 1, Math.max(0, at + STEP[orientation][event.key]))];
    if (!next) return;
    event.preventDefault();
    rovingSync(container, selector, next);
    next.focus();
    onMove?.(next);
  });
}

/** ARIA tree keys: Up/Down walk visible items, Right enters the side lane, Left returns to the parent. */
export function treeKeys(root, { onMove = null } = {}) {
  const selector = '[role=treeitem]';
  root.addEventListener('keydown', event => {
    const origin = event.target.closest?.(selector);
    if (!origin || !root.contains(origin)) return;
    const list = items(root, selector);
    const at = list.indexOf(origin);
    let next = null;
    if (event.key === 'ArrowDown') next = list[at + 1];
    else if (event.key === 'ArrowUp') next = list[at - 1];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list.at(-1);
    else if (event.key === 'ArrowRight') next = [...origin.children].find(child => child.getAttribute('role') === 'group')?.querySelector(selector);
    else if (event.key === 'ArrowLeft') next = origin.parentElement?.closest(selector);
    else return;
    event.preventDefault();
    if (!next) return;
    rovingSync(root, selector, next);
    next.focus();
    onMove?.(next);
  });
}

/** The focused element's key inside `root`, read before a re-render. */
export function focusKey(root) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (!active || !root.contains(active)) return null;
  return active.closest('[data-focus-key]')?.dataset.focusKey || null;
}

/** Focus the element carrying `key` after a re-render; no scroll jump. */
export function restoreFocus(root, key) {
  if (!key) return false;
  const target = [...root.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === key);
  if (!target || !visible(target)) return false;
  target.focus({ preventScroll: true });
  return true;
}
