// Career network calls as functions over a host object ({profile, requestVersion,
// render, accounts?, disposed?}), so the store can be exercised without a dialog.

const CAREER_HEADERS = Object.freeze({ 'Content-Type': 'application/json', 'X-VB-Career': '1' });

/** Accepted authority reaches runtime cosmetics through one event. */
export function announceCareer(profile) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vb-career-change', { detail: profile }));
}

/** An account switch between choosing and sending must never write to the new identity. */
async function confirmSession(host) {
  const accountId = host.accounts.user?.id || null;
  await host.accounts.refresh();
  if ((host.accounts.user?.id || null) !== accountId)
    throw new Error('Your session changed. Choose the item again after checking your career.');
}

/** Latest request wins: a stale or post-dispose response resolves to null. */
async function exchange(host, url, body) {
  const version = host.requestVersion = (host.requestVersion || 0) + 1;
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    ...(body ? { headers: { ...CAREER_HEADERS }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  if (version !== host.requestVersion || host.disposed) return null;
  if (!response.ok) throw new Error(payload.error || 'Career unavailable');
  host.profile = payload;
  host.render();
  announceCareer(payload);
  return payload;
}

/** GET the career, or equip `item` (a catalog id, or 'standard' with `reset` {slot, weapon?}). */
export async function careerRequest(host, item = null, equipOnly = false, reset = {}) {
  // No await without accounts: the request version is taken in the same tick, as before.
  if (item && host.accounts) await confirmSession(host);
  return exchange(host, item ? '/api/career/equip' : '/api/career', item ? { item, equipOnly, ...reset } : null);
}

/** Save one weapon's optic, grip and counter. Same session and version discipline as equip. */
export async function careerSaveAttachments(host, weapon, attachments) {
  if (host.accounts) await confirmSession(host);
  return exchange(host, '/api/career/attachments', { weapon, attachments });
}
