import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createBrowserProfile,
  executableBrowser,
  removeBrowserProfile,
} from './browser-capture.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(label, timeoutMs) {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.errors = [];
    this.closed = false;

    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
        else pending.resolve(message.result || {});
        return;
      }
      this.events.push(message);
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params?.exceptionDetails;
        this.errors.push(detail?.exception?.description || detail?.text || 'browser exception');
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        this.errors.push(message.params.entry.text || 'browser log error');
      }
    });
    const rejectPending = (message) => this._rejectPending(new Error(message));
    socket.addEventListener('close', () => rejectPending('CDP socket closed'));
    socket.addEventListener('error', () => rejectPending('CDP socket failed'));
  }

  _rejectPending(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 5_000) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(`CDP ${method}`, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text || 'browser evaluation failed');
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeoutMs = 20_000, intervalMs = 100, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    if (lastError) throw new Error(`${label}: ${lastError.message}`);
    throw timeoutError(label, timeoutMs);
  }

  close() {
    this._rejectPending(new Error('CDP session closed'));
    try { this.socket.close(); } catch {}
  }
}

async function readDebugPort(profileDir, child, timeoutMs = 10_000) {
  const activePort = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('browser exited before opening its debugging port');
    }
    try {
      const [port] = String(await readFile(activePort, 'utf8')).trim().split(/\r?\n/);
      const number = Number(port);
      if (Number.isInteger(number) && number > 0) return number;
    } catch {}
    await sleep(50);
  }
  throw timeoutError('browser debugging port', timeoutMs);
}

async function pageTarget(port, expectedUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(500),
      });
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' &&
        (target.url === expectedUrl || target.url.startsWith(expectedUrl)));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(50);
  }
  throw timeoutError('browser page target', timeoutMs);
}

/** Launch one disposable Chromium page behind a compact CDP interface. */
export async function launchCdpSession(url, {
  browser: explicitBrowser = null,
  width = 1280,
  height = 720,
} = {}) {
  const browser = await executableBrowser(explicitBrowser);
  const profileDir = await createBrowserProfile('voxel-blitz-cdp-');
  const child = spawn(browser, [
    '--headless=new',
    '--mute-audio',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-component-update',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let connection = null;
  try {
    const port = await readDebugPort(profileDir, child);
    const target = await pageTarget(port, url);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    connection = new CdpConnection(socket);
    await connection.send('Runtime.enable');
    await connection.send('Log.enable');
    await connection.send('Page.enable');
    return {
      page: connection,
      async close() {
        connection?.close();
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM'); } catch {}
          await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            sleep(2_000),
          ]);
        }
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch {}
        }
        await removeBrowserProfile(profileDir);
      },
    };
  } catch (error) {
    connection?.close();
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    await removeBrowserProfile(profileDir);
    throw error;
  }
}
