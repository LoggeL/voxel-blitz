// Node-only checks for the shared test harness in tools/lib: spawned test
// servers stay isolated from the developer's persistence, IPC fixtures answer
// requests, and the browser/global helpers behave like the copies they replaced.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clickById } from './lib/browser-helpers.mjs';
import { installGlobals } from './lib/install-globals.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
// Callers may run from anywhere; the helper still spawns from the repo root.
process.chdir(os.tmpdir());

// A stand-in server: reports its environment, advertises a port, answers IPC
// and writes into its data directory on shutdown like the career flush does.
const STUB = `
const fs = require('node:fs');
const env = process.env;
console.log(JSON.stringify({ cwd: process.cwd(), NODE_ENV: env.NODE_ENV, PORT: env.PORT,
  DATABASE_URL: env.DATABASE_URL ?? null, VB_PERSISTENCE: env.VB_PERSISTENCE,
  VB_DATA_DIR: env.VB_DATA_DIR ?? null, ipc: typeof process.send === 'function' }));
console.log('voxel-blitz listening on :4321');
process.on('message', ({ requestId, command }) => {
  if (command === 'echo') process.send({ requestId, result: { pong: true } });
  else if (command === 'fail') process.send({ requestId, error: 'fixture refused' });
});
process.on('SIGTERM', () => {
  fs.writeFileSync(require('node:path').join(env.VB_DATA_DIR, 'flushed.json'), '{}');
  process.exit(0);
});
setInterval(() => {}, 1_000);
`;

async function withStub(options, inspect) {
  const server = startServer({ args: ['-e', STUB], failureContext: 'harness stub', ...options });
  try {
    assert.equal(await server.port, 4321);
    const report = JSON.parse(server.stdout.split('\n')[0]);
    await inspect(server, report);
  } finally {
    await stopServer(server);
  }
  return server;
}

const inheritedUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgres://developer@127.0.0.1:5432/voxel';
try {
  // An inherited DATABASE_URL and the repo's ./data never reach a test server.
  let ownedDir;
  const isolated = await withStub({}, (server, report) => {
    assert.equal(realpathSync(report.cwd), root, 'default cwd is the repo root');
    assert.equal(report.NODE_ENV, 'test');
    assert.equal(report.PORT, '0');
    assert.equal(report.DATABASE_URL, null, 'inherited DATABASE_URL is dropped');
    assert.equal(report.VB_PERSISTENCE, 'file');
    assert.ok(report.VB_DATA_DIR, 'file persistence gets a data directory');
    assert.notEqual(path.resolve(root, report.VB_DATA_DIR), path.join(root, 'data'));
    assert.ok(report.VB_DATA_DIR.startsWith(os.tmpdir()), 'data directory is a temp directory');
    assert.equal(report.ipc, false, 'IPC stays off unless requested');
    assert.equal(server.request, undefined);
    ownedDir = server.ownedDataDir;
    assert.equal(ownedDir, report.VB_DATA_DIR);
    assert.ok(existsSync(ownedDir));
  });
  assert.equal(isolated.exitInfo.code, 0, 'stub flushed and exited on SIGTERM');
  assert.equal(existsSync(ownedDir), false, 'owned data directory is removed after the shutdown flush');

  // Caller-supplied persistence wins and a caller-owned directory is kept.
  const callerDir = mkdtempSync(path.join(os.tmpdir(), 'vb-harness-caller-'));
  try {
    const kept = await withStub({ env: { VB_DATA_DIR: callerDir } }, (server, report) => {
      assert.equal(report.VB_DATA_DIR, callerDir);
      assert.equal(report.VB_PERSISTENCE, 'file');
      assert.equal(server.ownedDataDir, null);
    });
    assert.equal(kept.exitInfo.code, 0);
    assert.ok(existsSync(path.join(callerDir, 'flushed.json')), 'caller data directory survives stopServer');

    const fixtureUrl = 'postgres://fixture@127.0.0.1:5999/voxel_test';
    await withStub({ env: { DATABASE_URL: fixtureUrl, VB_DATA_DIR: callerDir } }, (server, report) => {
      assert.equal(report.DATABASE_URL, fixtureUrl, 'an explicit DATABASE_URL is passed through');
      assert.equal(report.VB_PERSISTENCE, 'postgres');
    });
  } finally {
    rmSync(callerDir, { recursive: true, force: true });
  }
} finally {
  if (inheritedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = inheritedUrl;
}

// IPC requests resolve, reject with the fixture's error, and time out.
await withStub({ ipc: true }, async (server, report) => {
  assert.equal(report.ipc, true);
  assert.deepEqual(await server.request('echo'), { pong: true });
  await assert.rejects(server.request('fail'), /fixture refused/);
  await assert.rejects(server.request('ignored', { timeout: 100 }), /fixture ignored timed out/);
  assert.equal(server.child.listenerCount('message'), 0, 'settled requests remove their listeners');
});

// The real browser fixtures boot the production server and answer over IPC.
for (const entry of ['tools/lib/ttt-browser-fixture.mjs', 'tools/lib/powerup-browser-fixture.mjs']) {
  const fixture = startServer({ entry, ipc: true, portTimeout: 10_000, failureContext: entry });
  try {
    assert.ok(Number.isInteger(await fixture.port), `${entry} advertises its port`);
    await assert.rejects(fixture.request('stage'), /No live room engine/, `${entry} refuses commands before a room starts`);
  } finally {
    await stopServer(fixture);
  }
  assert.equal(existsSync(fixture.ownedDataDir), false, `${entry} data directory is removed`);
}

// clickById: the page-side probe honours visibility and requireEnabled.
async function clickWith(element, options) {
  const events = [];
  const page = {
    async evaluate(expression) {
      const document = { getElementById: () => element };
      return new Function('document', `return ${expression}`)(document);
    },
    async send(method, params) { events.push({ method, ...params }); },
  };
  await clickById(page, 'target', options);
  return events;
}
const button = (rect, disabled = false) => ({
  disabled, scrolled: null,
  scrollIntoView(options) { this.scrolled = options; },
  getBoundingClientRect: () => rect,
});
const visible = button({ left: 10, top: 20, width: 40, height: 10 });
const events = await clickWith(visible);
assert.deepEqual(events.map(event => [event.type, event.x, event.y]),
  [['mousePressed', 30, 25], ['mouseReleased', 30, 25]]);
assert.equal(visible.scrolled.behavior, 'instant');
await assert.rejects(clickWith(button({ left: 0, top: 0, width: 0, height: 0 })), /visible #target/);
await assert.rejects(clickWith(null), /visible #target/);
assert.equal((await clickWith(button({ left: 0, top: 0, width: 4, height: 4 }, true))).length, 2,
  'disabled elements are clickable unless requireEnabled is set');
await assert.rejects(clickWith(button({ left: 0, top: 0, width: 4, height: 4 }, true), { requireEnabled: true }),
  /target is visible and enabled/);

// installGlobals restores original descriptors and removes new globals.
const probe = Symbol('probe');
globalThis.harnessExisting = probe;
const restore = installGlobals({ harnessExisting: 1, harnessAdded: 2 });
assert.equal(globalThis.harnessExisting, 1);
assert.equal(globalThis.harnessAdded, 2);
restore();
assert.equal(globalThis.harnessExisting, probe);
assert.equal('harnessAdded' in globalThis, false);
delete globalThis.harnessExisting;

console.log('Test harness: server persistence isolation, repo-root cwd, IPC fixtures, clickById and installGlobals passed.');
