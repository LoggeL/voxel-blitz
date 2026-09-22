// MenuHistory state machine in Node: a fake session history with async,
// coalescing traversals drives open/close batching, pending traversals,
// ?lobby= URL preservation, Back past a pending close, Forward into a
// dismissed layer and disposal. The Chromium flow lives in
// menu-history-browser-test.mjs; this suite covers the edges it cannot.
import assert from 'node:assert/strict';
import { MenuHistory } from '../public/js/ui/menu-history.js';

const STATE_KEY = 'voxelBlitzMenu';

function fakeBrowser(href = 'https://voxel.test/') {
  const entries = [{ state: null, url: href }];
  let index = 0;
  let queued = 0;
  const listeners = new Set();
  const calls = { push: 0, go: [] };
  const resolve = (url) => new URL(url, entries[index].url).href;
  const history = {
    get state() { return entries[index].state; },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ state: structuredClone(state), url: url == null ? entries[index].url : resolve(url) });
      index++;
      calls.push++;
    },
    replaceState(state, _title, url) {
      entries[index] = { state: structuredClone(state), url: url == null ? entries[index].url : resolve(url) };
    },
    // Traversals are asynchronous; a second one queued before delivery
    // coalesces into a single popstate, like a fast double Back.
    go(delta) {
      calls.go.push(delta);
      queued += delta;
    },
  };
  return {
    history,
    location: { get href() { return entries[index].url; } },
    addEventListener(type, fn) { if (type === 'popstate') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'popstate') listeners.delete(fn); },
    calls,
    entries,
    get index() { return index; },
    get listenerCount() { return listeners.size; },
    back() { queued -= 1; },
    forward() { queued += 1; },
    /** Deliver the queued traversal as one popstate. */
    flush() {
      if (!queued) return false;
      index = Math.max(0, Math.min(entries.length - 1, index + queued));
      queued = 0;
      const event = { type: 'popstate', state: entries[index].state };
      for (const fn of [...listeners]) fn(event);
      return true;
    },
    path() { return entries[index].state?.[STATE_KEY]?.path ?? null; },
  };
}

const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function layer(menu, key, log) {
  return {
    open() { menu.open(key, () => { log.push(key); menu.close(key); }); },
    close() { menu.close(key); },
  };
}

let checks = 0;
const check = (fn) => { fn(); checks++; };

// The existing entry is marked in place; opening and closing adds one step.
{
  const browser = fakeBrowser();
  const menu = new MenuHistory(browser);
  const dismissed = [];
  const settings = layer(menu, 'settings', dismissed);
  check(() => {
    assert.equal(browser.entries.length, 1, 'constructor does not add a step at the main menu');
    assert.deepEqual(browser.path(), [], 'constructor marks the current entry as the menu root');
    assert.equal(browser.listenerCount, 1);
  });
  settings.open();
  settings.open();
  await settle();
  check(() => {
    assert.equal(browser.calls.push, 1, 'opening a layer twice pushes one entry');
    assert.equal(browser.path().length, 1);
  });
  settings.close();
  await settle();
  check(() => assert.deepEqual(browser.calls.go, [-1], 'an ordinary close walks back its own entry'));
  browser.flush();
  await settle();
  check(() => {
    assert.equal(browser.index, 0);
    assert.deepEqual(browser.path(), []);
    assert.deepEqual(dismissed, [], 'an ordinary close never re-runs the layer dismiss');
  });

  // Forward reaches the closed layer's stale entry; it is skipped, not reopened.
  browser.forward();
  browser.flush();
  await settle();
  check(() => assert.deepEqual(browser.calls.go, [-1, -1], 'Forward onto a closed layer walks back again'));
  browser.flush();
  await settle();
  check(() => {
    assert.equal(browser.index, 0);
    assert.deepEqual(dismissed, []);
    assert.equal(browser.calls.push, 1, 'the closed layer is not pushed again');
  });
  menu.dispose();
  check(() => assert.equal(browser.listenerCount, 0, 'dispose removes the popstate listener'));
}

// Back dismisses only the top layer; Forward into it skips without reopening.
{
  const browser = fakeBrowser();
  const menu = new MenuHistory(browser);
  const dismissed = [];
  const lobby = layer(menu, 'lobby', dismissed);
  const invite = layer(menu, 'invite', dismissed);
  lobby.open();
  await settle();
  invite.open();
  await settle();
  check(() => {
    assert.equal(browser.calls.push, 2);
    assert.equal(browser.path().length, 2);
  });
  browser.back();
  browser.flush();
  await settle();
  check(() => {
    assert.deepEqual(dismissed, ['invite'], 'browser Back dismisses only the top layer');
    assert.deepEqual(menu.layers.map((entry) => entry.key), ['lobby']);
    assert.equal(browser.path().length, 1);
    assert.deepEqual(browser.calls.go, [], 'a dismiss during popstate does not traverse again');
  });
  browser.forward();
  browser.flush();
  await settle();
  check(() => assert.deepEqual(browser.calls.go, [-1], 'Forward into a dismissed layer walks back'));
  browser.flush();
  await settle();
  check(() => {
    assert.deepEqual(dismissed, ['invite'], 'Forward never runs a second dismiss');
    assert.deepEqual(menu.layers.map((entry) => entry.key), ['lobby']);
    assert.equal(browser.path().length, 1);
    assert.equal(browser.calls.push, 2, 'the dismissed layer is not reopened');
  });
  menu.dispose();
}

// A dismiss that cascades into its parent walks back to the root without
// copying the popped entry's lobby URL onto it.
{
  const browser = fakeBrowser('https://voxel.test/');
  const menu = new MenuHistory(browser);
  const dismissed = [];
  menu.open('lobby', () => dismissed.push('lobby'));
  await settle();
  browser.history.replaceState(browser.history.state, '', '/?lobby=XYZ');
  menu.open('invite', () => { dismissed.push('invite'); menu.close('lobby'); });
  await settle();
  browser.back();
  browser.flush();
  await settle();
  check(() => {
    assert.deepEqual(dismissed, ['invite'], 'a cascaded close is not reported as a dismiss');
    assert.deepEqual(browser.calls.go, [-1], 'the cascaded close walks back its own entry');
  });
  browser.flush();
  await settle();
  check(() => {
    assert.equal(browser.index, 0);
    assert.equal(browser.location.href, 'https://voxel.test/',
      'a close during popstate does not carry the popped lobby URL to the root entry');
    assert.deepEqual(menu.layers, []);
  });
  menu.dispose();
}

// Closes in one tick batch into a single traversal.
{
  const browser = fakeBrowser();
  const menu = new MenuHistory(browser);
  const dismissed = [];
  const a = layer(menu, 'a', dismissed);
  const b = layer(menu, 'b', dismissed);
  a.open();
  b.open();
  await settle();
  check(() => assert.equal(browser.calls.push, 2, 'layers opened in one tick each get an entry'));
  b.close();
  a.close();
  await settle();
  check(() => assert.deepEqual(browser.calls.go, [-2], 'closes in one tick share one traversal'));
  browser.flush();
  await settle();
  check(() => {
    assert.equal(browser.index, 0);
    assert.deepEqual(browser.path(), []);
    assert.deepEqual(dismissed, []);
  });
  menu.dispose();
}

// A layer opened during a pending traversal is pushed after arrival.
{
  const browser = fakeBrowser();
  const menu = new MenuHistory(browser);
  const dismissed = [];
  const settings = layer(menu, 'settings', dismissed);
  const loadout = layer(menu, 'loadout', dismissed);
  settings.open();
  await settle();
  settings.close();
  await settle();
  loadout.open();
  await settle();
  check(() => {
    assert.deepEqual(browser.calls.go, [-1]);
    assert.equal(browser.calls.push, 1, 'no push while a traversal is still pending');
  });
  browser.flush();
  await settle();
  check(() => {
    assert.equal(browser.calls.push, 2, 'the serialized open is pushed after arrival');
    assert.deepEqual(browser.path(), menu.layers.map((entry) => entry.id));
    assert.deepEqual(menu.layers.map((entry) => entry.key), ['loadout']);
    assert.deepEqual(dismissed, []);
  });
  menu.dispose();
}

// A close whose callback rewrote the URL (?lobby=) keeps that URL after
// traversing back to the older entry, also when the edit lands while the
// traversal is pending.
{
  const browser = fakeBrowser('https://voxel.test/');
  const menu = new MenuHistory(browser);
  const dismissed = [];
  const join = layer(menu, 'join', dismissed);
  join.open();
  await settle();
  browser.history.replaceState(browser.history.state, '', '/?lobby=XYZ');
  join.close();
  await settle();
  browser.flush();
  await settle();
  check(() => {
    assert.equal(browser.index, 0);
    assert.equal(browser.location.href, 'https://voxel.test/?lobby=XYZ',
      'admission URL survives the walk back to the pre-menu entry');
    assert.deepEqual(browser.path(), [], 'the preserved URL keeps the menu marker');
  });

  join.open();
  await settle();
  join.close();
  await settle();
  browser.history.replaceState(browser.history.state, '', '/');
  const leave = layer(menu, 'leave', dismissed);
  leave.open();
  leave.close();
  await settle();
  browser.flush();
  await settle();
  check(() => assert.equal(browser.location.href, 'https://voxel.test/',
    'a URL edit during the pending traversal is the one preserved'));
  menu.dispose();
}

// A further Back during an ordinary close passes its target: the remaining
// layer is dismissed instead of the closed one being reopened.
{
  const browser = fakeBrowser();
  const menu = new MenuHistory(browser);
  const dismissed = [];
  const lobby = layer(menu, 'lobby', dismissed);
  const invite = layer(menu, 'invite', dismissed);
  lobby.open();
  await settle();
  invite.open();
  await settle();
  invite.close();
  await settle();
  browser.back();
  browser.flush();
  await settle();
  check(() => {
    assert.equal(browser.index, 0);
    assert.deepEqual(dismissed, ['lobby'], 'the extra Back dismisses the next layer');
    assert.deepEqual(menu.layers, []);
    assert.equal(browser.calls.push, 2, 'the closed layer is not reopened');
    assert.deepEqual(browser.path(), []);
  });
  menu.dispose();
}

// Disposed or history-less instances are inert.
{
  const browser = fakeBrowser();
  const menu = new MenuHistory(browser);
  const dismissed = [];
  const settings = layer(menu, 'settings', dismissed);
  settings.open();
  await settle();
  menu.dispose();
  browser.back();
  browser.flush();
  settings.open();
  await settle();
  check(() => {
    assert.deepEqual(dismissed, [], 'popstate after dispose dismisses nothing');
    assert.equal(browser.calls.push, 1, 'open after dispose is ignored');
  });
  const inert = new MenuHistory({ history: {}, addEventListener() { throw new Error('unused'); } });
  inert.open('settings', () => {});
  await settle();
  check(() => {
    assert.equal(inert.enabled, false);
    assert.deepEqual(inert.layers, [], 'without the History API no layer is tracked');
  });
}

// Another tab's (or a stale page's) menu marker is not treated as ours.
{
  const browser = fakeBrowser();
  browser.history.replaceState({ keep: 1, [STATE_KEY]: { owner: 'other', path: [7, 8] } }, '');
  const menu = new MenuHistory(browser);
  check(() => {
    assert.deepEqual(menu._path(), []);
    assert.equal(browser.history.state.keep, 1, 'unrelated history state is preserved');
  });
  menu.dispose();
}

console.log(`menu history test passed (${checks} checks)`);
