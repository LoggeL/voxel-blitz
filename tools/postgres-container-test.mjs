import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { postgresStackFixture } from './lib/postgres-stack-fixture.mjs';
import { docker } from './lib/postgres-fixture.mjs';

const execute = promisify(execFile);
let stack;
try {
  stack = await postgresStackFixture();
  let base = await stack.baseUrl();
  let cookie = '';
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-VB-Account': '1', 'X-VB-Career': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.ok(response.ok, `${route}: ${response.status}`);
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  };
  const user = (await request('/api/account/register', { username: 'ContainerAccount', password: 'Container-only test password 123' })).user;
  await request('/api/career');
  await stack.compose('exec', '-T', 'db', 'psql', '-U', 'voxel', '-d', 'voxel', '-v', 'ON_ERROR_STOP=1', '-c',
    `UPDATE vb_careers SET xp=900, credits=500 WHERE id='account:${user.id}'`);
  const purchased = await request('/api/career/purchase', { item: 'arctic' });
  assert.equal(purchased.credits, 400);
  assert.equal(purchased.equipped.theme, 'arctic');
  const gameId = await stack.compose('ps', '-q', 'game'), dbId = await stack.compose('ps', '-q', 'db');
  const db = JSON.parse(await docker('inspect', dbId))[0];
  assert.equal(db.NetworkSettings.Ports['5432/tcp'], null, 'database port is not published');
  assert.equal(Object.keys(db.NetworkSettings.Networks).length, 1, 'database joins only the private network');
  const network = JSON.parse(await docker('network', 'inspect', `${stack.project}_database`))[0];
  assert.equal(network.Internal, true);
  assert.ok(db.Mounts.some(mount => mount.Type === 'volume' && mount.Name === `${stack.project}_postgres-data`));
  assert.equal(JSON.parse(await docker('inspect', gameId))[0].Config.User, 'node');
  const files = await stack.compose('exec', '-T', 'game', 'node', '-e', "console.log(JSON.stringify(require('fs').readdirSync('/app/data')))");
  assert.deepEqual(JSON.parse(files), [], 'production PostgreSQL game writes no legacy JSON');
  await stack.compose('restart', 'game'); base = await stack.ready();
  assert.equal((await request('/api/account')).user.id, user.id);
  assert.deepEqual(await request('/api/career'), purchased);
  await stack.compose('restart', 'db'); base = await stack.ready();
  assert.equal((await request('/api/account')).user.id, user.id);
  assert.deepEqual(await request('/api/career'), purchased, 'Compose database volume survives restart');
  const protocol = await execute(process.execPath, ['tools/container-smoke.mjs'], { env: { ...process.env, BASE_URL: base } });
  console.log(protocol.stdout.trim());
  console.log('POSTGRESQL CONTAINER TESTS: ALL OK (private network, healthchecks, named volume, non-root app, HTTP/WS and committed account/career after app/database restart).');
} finally { await stack?.close(); }
