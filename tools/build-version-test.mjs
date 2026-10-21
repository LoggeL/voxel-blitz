// Version tag: server/version.js labels the build with the package.json version and a
// commit (GIT_SHA / SOURCE_COMMIT) or a stable code hash, and the server answers
// /api/version with it. node tools/build-version-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInfo, codeHash } from '../server/version.js';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const local = buildInfo({});
assert.equal(local.version, pkg.version, 'the version is package.json\'s');
assert.match(local.build, /^[0-9a-f]{7}$/, 'without a commit the build id is a 7-hex code hash');
assert.equal(local.build, codeHash(), 'the code hash is stable');
assert.equal(local.label, `v${pkg.version} · ${local.build}`);
assert.equal(buildInfo({ SOURCE_COMMIT: '33FEE820abcdef' }).build, '33fee82', 'a deploy commit wins');
assert.equal(buildInfo({ GIT_SHA: 'not a sha' }).build, local.build, 'a malformed commit falls back to the hash');

const server = await startServer({ env: { GIT_SHA: '', SOURCE_COMMIT: '' } });
try {
  const port = await server.port;
  await waitForHttp(port);
  const info = await (await fetch(`http://127.0.0.1:${port}/api/version`)).json();
  assert.deepEqual(info, { ...local }, '/api/version serves the build info');
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.build, local.build, '/healthz names the build');
} finally {
  await stopServer(server);
}
console.log(`build-version-test: ${local.label} ok`);
