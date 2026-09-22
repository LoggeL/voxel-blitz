/** Helpers shared by the Career and Armory dialogs. */

/** Fetch a career endpoint and read its JSON body. A reverse-proxy error page,
 * a truncated body, a dropped connection or a timeout becomes `fallback`
 * instead of raw parser or network text in the dialog status line. Server
 * errors still arrive through `payload.error` for the caller to show. */
export async function careerFetch(url, init, fallback) {
  try {
    const response = await fetch(url, init);
    return { response, payload: await response.json() };
  } catch {
    throw new Error(fallback);
  }
}

/** The data attribute that identifies the focused control inside `container`,
 * as `[key, value]`, so the same control can be focused again after a rebuild. */
export function focusedKey(container, keys) {
  const active = globalThis.document?.activeElement;
  if (!active || !container.contains(active)) return null;
  const key = keys.find(name => active.dataset?.[name] !== undefined);
  return key ? [key, active.dataset[key]] : null;
}

/** Rebuilding a list detaches the focused button and drops keyboard focus to
 * <body>. Focus the first enabled rebuilt twin among `candidates`; leave focus
 * alone when it already sits on a live control inside `container`. */
export function restoreFocus(container, candidates) {
  const active = globalThis.document?.activeElement;
  if (active && active.isConnected !== false && active !== document.body && container.contains(active)) return true;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const [key, value] = candidate;
    const match = [...container.querySelectorAll('button')].find(button => button.dataset[key] === value && !button.disabled);
    if (match) { match.focus({ preventScroll: true }); return true; }
  }
  return false;
}
