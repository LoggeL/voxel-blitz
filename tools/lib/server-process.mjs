import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { abortError, sleep, withTimeout } from './async.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_PORT_PATTERN = /voxel-blitz listening on (?:https?:\/\/[^:\s]+)?:(\d+)\b/;
const NEVER = new Promise(() => {});

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function portMatcher(pattern) {
  if (!(pattern instanceof RegExp)) throw new TypeError('portPattern must be a RegExp');
  const matcher = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  return (output) => {
    const match = matcher.exec(output);
    if (!match) return null;
    const value = Number(match.groups?.port ?? match[1]);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error('server advertised an invalid listening port');
    }
    return value;
  };
}

function appendOutput(current, chunk, limit) {
  return (current + chunk).slice(-limit);
}

export function serverFailure(server, info, context = server.failureContext) {
  const reason = info.error
    ? info.error.message
    : `code=${String(info.code)} signal=${info.signal || 'none'}`;
  const output = server.stderr.trim() || server.stdout.trim();
  return new Error(`server exited before ${context} completed (${reason})${output ? `\n${output}` : ''}`);
}

/** Test servers never inherit the developer's persistence: an inherited
 * DATABASE_URL is dropped and file mode writes to a throwaway data directory
 * unless the caller passes DATABASE_URL or VB_DATA_DIR itself.
 */
function testServerEnv(env) {
  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  const ownedDataDir = env.VB_DATA_DIR === undefined
    ? mkdtempSync(path.join(os.tmpdir(), 'vb-test-data-'))
    : null;
  return {
    ownedDataDir,
    env: {
      ...childEnv,
      NODE_ENV: 'test',
      VB_PERSISTENCE: env.DATABASE_URL ? 'postgres' : 'file',
      ...(ownedDataDir ? { VB_DATA_DIR: ownedDataDir } : {}),
      ...env,
      PORT: '0',
    },
  };
}

export function startServer({
  cwd = REPO_ROOT,
  command = process.execPath,
  entry = 'server/index.js',
  args,
  env = {},
  portPattern = DEFAULT_PORT_PATTERN,
  portTimeout = 8_000,
  portTimeoutMessage = 'server did not advertise its listening port',
  ringBuffer = 8_000,
  failureContext = 'smoke',
  stopTimeout = 2_000,
  stopSignal = 'SIGTERM',
  killSignal = 'SIGKILL',
  ipc = false,
} = {}) {
  positiveInteger(portTimeout, 'portTimeout');
  positiveInteger(ringBuffer, 'ringBuffer');
  positiveInteger(stopTimeout, 'stopTimeout');
  const parsePort = portMatcher(portPattern);
  const { env: childEnv, ownedDataDir } = testServerEnv(env);
  const child = spawn(command, args ?? [entry], {
    cwd,
    env: childEnv,
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const server = {
    child,
    ownedDataDir,
    stopping: false,
    stdout: '',
    stderr: '',
    readyPort: null,
    failureContext,
    stopTimeout,
    stopSignal,
    killSignal,
  };

  let resolveExit;
  let exitSettled = false;
  server.exit = new Promise((resolve) => { resolveExit = resolve; });
  const settleExit = (info) => {
    if (exitSettled) return;
    exitSettled = true;
    server.exitInfo = info;
    resolveExit(info);
  };
  child.once('error', (error) => settleExit({ error, code: null, signal: null }));
  child.once('exit', (code, signal) => settleExit({ error: null, code, signal }));

  let resolvePort;
  let rejectPort;
  let portSettled = false;
  server.port = new Promise((resolve, reject) => {
    resolvePort = resolve;
    rejectPort = reject;
  });
  // A spawn failure can reject before the caller reaches server.port.
  server.port.catch(() => {});
  server.readyTimer = setTimeout(() => {
    if (portSettled) return;
    portSettled = true;
    rejectPort(new Error(portTimeoutMessage));
  }, portTimeout);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    server.stdout = appendOutput(server.stdout, chunk, ringBuffer);
    if (portSettled) return;
    let port;
    try {
      port = parsePort(server.stdout);
    } catch (error) {
      portSettled = true;
      clearTimeout(server.readyTimer);
      rejectPort(error);
      return;
    }
    if (port === null) return;
    portSettled = true;
    clearTimeout(server.readyTimer);
    server.readyPort = port;
    resolvePort(port);
  });
  child.stderr.on('data', (chunk) => {
    server.stderr = appendOutput(server.stderr, chunk, ringBuffer);
  });
  server.exit.then((info) => {
    if (portSettled) return;
    portSettled = true;
    clearTimeout(server.readyTimer);
    rejectPort(serverFailure(server, info));
  });

  server.unexpectedExit = server.exit.then((info) => {
    if (server.stopping) return NEVER;
    throw serverFailure(server, info);
  });
  // Keep an early child failure from becoming an unhandled rejection while the
  // caller is still awaiting the advertised port.
  server.unexpectedExit.catch(() => {});

  if (ipc) {
    let requestId = 0;
    // Fixture entries answer { requestId, command } with { requestId, result | error }.
    server.request = (command, { timeout = 5_000 } = {}) => {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const receive = (message) => {
          if (message?.requestId !== id) return;
          clearTimeout(timer);
          child.off('message', receive);
          if (message.error) reject(new Error(message.error));
          else resolve(message.result);
        };
        const timer = setTimeout(() => {
          child.off('message', receive);
          reject(new Error(`fixture ${command} timed out`));
        }, timeout);
        child.on('message', receive);
        child.send({ requestId: id, command });
      });
    };
  }
  return server;
}

export async function stopServer(server, {
  timeout = server?.stopTimeout,
  stopSignal = server?.stopSignal,
  killSignal = server?.killSignal,
} = {}) {
  if (!server) return null;
  positiveInteger(timeout, 'timeout');
  server.stopping = true;
  const { child } = server;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(stopSignal); } catch {}
  }
  try {
    return await withTimeout(server.exit, timeout, `server did not stop after ${stopSignal}`);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(killSignal); } catch {}
    }
    return await withTimeout(server.exit, timeout, `server did not stop after ${killSignal}`);
  } finally {
    clearTimeout(server.readyTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    // Removed only after exit so a shutdown flush cannot recreate the directory.
    if (server.ownedDataDir) {
      await rm(server.ownedDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

export async function waitForHttp(port, {
  host = '127.0.0.1',
  path = '/index.html',
  attempts = 40,
  requestTimeout = 500,
  interval = 50,
  signal,
} = {}) {
  positiveInteger(attempts, 'attempts');
  positiveInteger(requestTimeout, 'requestTimeout');
  positiveInteger(interval, 'interval');
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw abortError(signal, 'HTTP readiness wait aborted');
    try {
      const controller = new AbortController();
      const requestTimer = setTimeout(() => controller.abort(), requestTimeout);
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      try {
        const response = await fetch(`http://${host}:${port}${path}`, {
          signal: controller.signal,
        });
        await response.body?.cancel();
        if (response.ok) return;
      } finally {
        clearTimeout(requestTimer);
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal, 'HTTP readiness wait aborted');
    }
    await sleep(interval, signal);
  }
  throw new Error('server did not serve HTTP after advertising readiness');
}
