import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';

const execute = promisify(execFile);
export const docker = async (...args) => (await execute('docker', args, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Owns only randomly named resources created for this invocation. */
export async function postgresFixture() {
  const name = `vb-postgres-test-${process.pid}-${randomBytes(4).toString('hex')}`;
  const volume = `${name}-data`;
  const directory = await mkdtemp(path.join(tmpdir(), 'vb-postgres-'));
  const password = randomBytes(24).toString('hex');
  const envFile = path.join(directory, 'postgres.env');
  await writeFile(envFile, `POSTGRES_DB=voxel\nPOSTGRES_USER=voxel\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
  let ownsVolume = false, ownsContainer = false;
  const fixture = {
    name, volume, directory,
    async ready() {
      for (let attempt = 0; attempt < 120; attempt++) {
        let probe;
        try {
          const port = JSON.parse(await docker('inspect', name))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
          this.connectionString = `postgresql://voxel:${password}@127.0.0.1:${port}/voxel`;
          probe = new Client({ connectionString: this.connectionString, connectionTimeoutMillis: 500 });
          await probe.connect();
          await probe.query('SELECT 1');
          return;
        } catch { await delay(250); }
        finally { await probe?.end().catch(() => {}); }
      }
      throw new Error('Test PostgreSQL did not become ready');
    },
    async restart() { await docker('restart', name); await this.ready(); },
    async close() {
      if (ownsContainer) await docker('rm', '-f', name);
      if (ownsVolume) await docker('volume', 'rm', volume);
      await rm(directory, { recursive: true, force: true });
    },
  };
  try {
    await docker('volume', 'create', volume); ownsVolume = true;
    await docker('run', '--detach', '--name', name, '--env-file', envFile,
      '--publish', '127.0.0.1::5432', '--volume', `${volume}:/var/lib/postgresql`, 'postgres:18-alpine');
    ownsContainer = true;
    await fixture.ready();
    return fixture;
  } catch (error) { await fixture.close(); throw error; }
}
