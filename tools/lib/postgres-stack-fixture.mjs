import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { docker } from './postgres-fixture.mjs';

/** A real Compose stack, with credentials confined to a temporary env file. */
export async function postgresStackFixture() {
  const project = `vb-pg-stack-${process.pid}-${randomBytes(4).toString('hex')}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'vb-postgres-stack-'));
  const envFile = path.join(directory, 'stack.env');
  await writeFile(envFile, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\nPORT=0\nBIND_ADDRESS=127.0.0.1\n`, { mode: 0o600 });
  const compose = (...args) => docker('compose', '--project-name', project, '--env-file', envFile, ...args);
  const fixture = {
    project, directory, envFile, compose,
    async baseUrl() { return 'http://' + (await compose('port', 'game', '8070')).split('\n')[0]; },
    async ready() {
      for (let attempt = 0; attempt < 240; attempt++) {
        try {
          const base = await this.baseUrl();
          const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) });
          if (response.ok && (await response.json()).persistence === 'postgres') return base;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('PostgreSQL Compose stack did not become healthy');
    },
    async close() {
      await compose('down', '--volumes', '--remove-orphans');
      await docker('image', 'rm', `${project}-game`).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
  try {
    await compose('up', '--detach', '--build', '--wait', '--wait-timeout', '120');
    await fixture.ready();
    return fixture;
  } catch (error) { await fixture.close(); throw error; }
}
