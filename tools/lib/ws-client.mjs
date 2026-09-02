import WebSocket from 'ws';

import { abortError } from './async.mjs';

const DEFAULT_FRAME_TIMEOUT_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 750;

function timeoutValue(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

function errorFrom(reason) {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export class SocketTracker {
  #clients = new Set();
  #peakOpenSockets = 0;
  #disposed = false;

  register(client) {
    if (this.#disposed) throw new Error('socket tracker is disposed');
    this.#clients.add(client);
  }

  unregister(client) {
    this.#clients.delete(client);
  }

  noteOpen() {
    this.#peakOpenSockets = Math.max(this.#peakOpenSockets, this.openSocketCount());
  }

  openSocketCount() {
    let count = 0;
    for (const client of this.#clients) {
      if (client.ws?.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }

  get peakOpenSockets() {
    return this.#peakOpenSockets;
  }

  get size() {
    return this.#clients.size;
  }

  reset() {
    if (this.#disposed) throw new Error('socket tracker is disposed');
    this.#peakOpenSockets = this.openSocketCount();
  }

  async closeAll() {
    const clients = Array.from(this.#clients);
    const results = await Promise.allSettled(clients.map((client) => client.close()));
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'one or more sockets did not close');
  }

  async dispose() {
    if (this.#disposed) return;
    const clients = Array.from(this.#clients);
    const results = await Promise.allSettled(clients.map((client) => client.dispose()));
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'one or more sockets could not be disposed');
    this.#clients.clear();
    this.#disposed = true;
  }
}

export class Client {
  constructor(port, label, {
    host = '127.0.0.1',
    name = label,
    frameTimeout = DEFAULT_FRAME_TIMEOUT_MS,
    handshakeTimeout = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    closeTimeout = DEFAULT_CLOSE_TIMEOUT_MS,
    closeReason = 'smoke complete',
    includeInteract = false,
    tracker = null,
  } = {}) {
    this.port = port;
    this.host = host;
    this.label = label;
    this.name = name;
    this.frameTimeout = timeoutValue(frameTimeout, 'frameTimeout');
    this.handshakeTimeout = timeoutValue(handshakeTimeout, 'handshakeTimeout');
    this.closeTimeout = timeoutValue(closeTimeout, 'closeTimeout');
    this.closeReason = closeReason;
    this.includeInteract = includeInteract;
    this.tracker = tracker;
    this.ws = null;
    this.frames = [];
    this.sentAt = [];
    this.events = [];
    this.ticks = [];
    this.sequence = 0;
    this.closeInfo = null;
    this.socketError = null;
    this.welcome = null;
    this.map = null;
    this.mapBytes = 0;
    this.id = null;
    this.waiters = new Set();
    this.disposed = false;
    tracker?.register(this);
  }

  mark() {
    return this.sequence;
  }

  framesAfter(mark = 0) {
    return this.frames.filter((frame) => frame.seq > mark);
  }

  jsonAfter(mark = 0) {
    return this.framesAfter(mark)
      .filter((frame) => frame.kind === 'json')
      .map((frame) => frame.value);
  }

  #notifyWaiters() {
    for (const waiter of Array.from(this.waiters)) waiter();
  }

  #recordFrame(frame) {
    frame.seq = ++this.sequence;
    frame.at = Date.now();
    this.frames.push(frame);
    if (frame.kind === 'binary' && this.map === null) {
      this.map = frame.value;
      this.mapBytes = frame.value.byteLength;
    } else if (frame.kind === 'json') {
      const message = frame.value;
      if (message?.t === 'welcome') {
        this.welcome = message;
        this.id = message.id;
      } else if (message?.t === 'ev') {
        this.events.push(message);
      } else if (message?.t === 'tick') {
        this.ticks.push(message);
        for (const event of message.events || []) this.events.push(event);
      }
    }
    this.#notifyWaiters();
  }

  async connect(firstFrame, signal) {
    if (this.disposed) throw new Error(`${this.label} is disposed`);
    if (this.ws) throw new Error(`${this.label} was connected twice`);
    const ws = new WebSocket(`ws://${this.host}:${this.port}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.on('open', () => this.tracker?.noteOpen());
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#recordFrame({ kind: 'binary', value: Buffer.from(data) });
        return;
      }
      const raw = String(data);
      let value;
      try { value = JSON.parse(raw); } catch { value = null; }
      this.#recordFrame({ kind: value === null ? 'invalid-json' : 'json', value, raw });
    });
    ws.on('error', (error) => {
      this.socketError = error;
      this.#notifyWaiters();
    });
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: String(reason) };
      this.#notifyWaiters();
    });

    await this.#waitForOpen(signal);
    if (firstFrame !== undefined) {
      if (typeof firstFrame === 'string' || Buffer.isBuffer(firstFrame)) this.sendRaw(firstFrame);
      else this.send(firstFrame);
    }
    return this;
  }

  #waitForOpen(signal) {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolveOpen, rejectOpen) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error(`${this.label} open timeout`)),
        this.frameTimeout,
      );
      const onOpen = () => finish(null);
      const onError = (error) => finish(new Error(`${this.label} failed to open: ${error.message}`));
      const onClose = (code, reason) => finish(
        new Error(`${this.label} closed before open (${code} ${String(reason)})`),
      );
      const onAbort = () => finish(abortError(signal, `${this.label} open aborted`));
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.ws?.removeListener('open', onOpen);
        this.ws?.removeListener('error', onError);
        this.ws?.removeListener('close', onClose);
        if (error) rejectOpen(error);
        else resolveOpen();
      };
      this.ws.once('open', onOpen);
      this.ws.once('error', onError);
      this.ws.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async join({
    name = this.name,
    firstFrame = { t: 'join', name },
    timeoutMs = this.handshakeTimeout,
    signal,
  } = {}) {
    const mark = this.mark();
    await this.connect(firstFrame, signal);
    const { welcome } = await this.waitForHandshake(mark, timeoutMs, signal);
    return welcome;
  }

  async waitForHandshake(after = 0, timeoutMs = this.handshakeTimeout, signal) {
    timeoutValue(timeoutMs, 'timeoutMs');
    const deadline = Date.now() + timeoutMs;
    const welcomeFrame = await this.waitForJsonFrame(
      (message) => message?.t === 'welcome',
      'welcome frame',
      after,
      timeoutMs,
      signal,
    );
    const remaining = Math.max(1, deadline - Date.now());
    const mapFrame = await this.waitForFrame(
      (frame) => frame.kind === 'binary',
      'binary map frame',
      after,
      remaining,
      signal,
    );
    if (welcomeFrame.seq >= mapFrame.seq) {
      throw new Error(`${this.label} received its binary map before its welcome frame`);
    }
    this.welcome = welcomeFrame.value;
    this.id = welcomeFrame.value.id;
    this.map = mapFrame.value;
    this.mapBytes = mapFrame.value.byteLength;
    return {
      welcome: welcomeFrame.value,
      map: mapFrame.value,
      welcomeFrame,
      mapFrame,
    };
  }

  sendRaw(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.label} socket is not open`);
    }
    this.sentAt.push(Date.now());
    this.ws.send(payload);
  }

  send(value) {
    this.sendRaw(JSON.stringify(value));
  }

  input(seq, overrides = {}) {
    const keys = {
      f: !!overrides.forward,
      b: !!overrides.back,
      l: !!overrides.left,
      r: !!overrides.right,
      jump: !!overrides.jump,
      sprint: !!overrides.sprint,
      crouch: !!overrides.crouch,
    };
    if (this.includeInteract) keys.interact = !!overrides.interact;
    this.send({
      t: 'input',
      seq,
      keys,
      yaw: overrides.yaw ?? 0,
      pitch: overrides.pitch ?? 0,
      weapon: overrides.weapon ?? 0,
      wantFire: !!overrides.fire,
      wantAds: !!overrides.ads,
      reload: !!overrides.reload,
      throwGrenade: !!overrides.throwGrenade,
      grenadeCharge: overrides.throwGrenade ? (overrides.grenadeCharge ?? 0) : undefined,
      grenadeType: overrides.throwGrenade ? (overrides.grenadeType ?? 0) : undefined,
      grenadeCook: overrides.throwGrenade ? (overrides.grenadeCook ?? 0) : undefined,
    });
  }

  #findFrame(predicate, after = 0) {
    return this.frames.find((frame) => frame.seq > after && predicate(frame));
  }

  waitForFrame(predicate, description, after = 0, timeoutMs = this.frameTimeout, signal) {
    let existing;
    try {
      existing = this.#findFrame(predicate, after);
    } catch (error) {
      return Promise.reject(errorFrom(error));
    }
    if (existing) return Promise.resolve(existing);
    if (this.closeInfo) {
      return Promise.reject(new Error(
        `${this.label} closed before ${description} (${this.closeInfo.code} ${this.closeInfo.reason})`,
      ));
    }
    return new Promise((resolveFrame, rejectFrame) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error(`${this.label} timeout waiting for ${description}`)),
        timeoutValue(timeoutMs, 'timeoutMs'),
      );
      const onAbort = () => finish(abortError(signal, `${this.label} wait aborted`));
      const inspect = () => {
        let frame;
        try {
          frame = this.#findFrame(predicate, after);
        } catch (error) {
          finish(errorFrom(error));
          return;
        }
        if (frame) {
          finish(null, frame);
          return;
        }
        if (this.closeInfo) {
          finish(new Error(
            `${this.label} closed before ${description} (${this.closeInfo.code} ${this.closeInfo.reason})`,
          ));
        }
      };
      const finish = (error, frame) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(inspect);
        if (error) rejectFrame(error);
        else resolveFrame(frame);
      };
      this.waiters.add(inspect);
      signal?.addEventListener('abort', onAbort, { once: true });
      inspect();
      if (signal?.aborted) onAbort();
    });
  }

  waitForJsonFrame(predicate, description, after = 0, timeoutMs = this.frameTimeout, signal) {
    return this.waitForFrame(
      (frame) => frame.kind === 'json' && predicate(frame.value),
      description,
      after,
      timeoutMs,
      signal,
    );
  }

  async waitForJson(predicate, description, after = 0, timeoutMs = this.frameTimeout, signal) {
    const frame = await this.waitForJsonFrame(predicate, description, after, timeoutMs, signal);
    return frame.value;
  }

  waitForClose(description = 'socket close', timeoutMs = this.frameTimeout, signal) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolveClose, rejectClose) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error(`${this.label} timeout waiting for ${description}`)),
        timeoutValue(timeoutMs, 'timeoutMs'),
      );
      const onAbort = () => finish(abortError(signal, `${this.label} close wait aborted`));
      const inspect = () => {
        if (this.closeInfo) finish(null, this.closeInfo);
      };
      const finish = (error, info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.delete(inspect);
        if (error) rejectClose(error);
        else resolveClose(info);
      };
      this.waiters.add(inspect);
      signal?.addEventListener('abort', onAbort, { once: true });
      inspect();
      if (signal?.aborted) onAbort();
    });
  }

  maxSentInOneSecond() {
    let max = 0;
    let left = 0;
    for (let right = 0; right < this.sentAt.length; right++) {
      while (left < right && this.sentAt[right] - this.sentAt[left] >= 1_000) left++;
      max = Math.max(max, right - left + 1);
    }
    return max;
  }

  async close({
    code = 1_000,
    reason = this.closeReason,
    timeoutMs = this.closeTimeout,
    signal,
  } = {}) {
    const ws = this.ws;
    if (!ws) return null;
    timeoutValue(timeoutMs, 'timeoutMs');
    let closeError = null;
    try {
      if (ws.readyState !== WebSocket.CLOSED) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.close(code, reason); } catch {}
        } else if (ws.readyState === WebSocket.CONNECTING) {
          try { ws.terminate(); } catch {}
        }
        try {
          await this.waitForClose('cleanup close', timeoutMs, signal);
        } catch {
          try { ws.terminate(); } catch {}
          try {
            await this.waitForClose('terminated cleanup close', timeoutMs, signal);
          } catch (error) {
            closeError = errorFrom(error);
          }
        }
      }
      if (!this.closeInfo && !closeError) {
        closeError = new Error(`${this.label} closed without close information`);
      }
    } finally {
      ws.removeAllListeners();
      this.waiters.clear();
    }
    if (closeError) throw closeError;
    return this.closeInfo;
  }

  reset() {
    if (this.disposed) throw new Error(`${this.label} is disposed`);
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      throw new Error(`${this.label} cannot reset an active socket`);
    }
    this.ws?.removeAllListeners();
    this.ws = null;
    this.frames.length = 0;
    this.sentAt.length = 0;
    this.events.length = 0;
    this.ticks.length = 0;
    this.sequence = 0;
    this.closeInfo = null;
    this.socketError = null;
    this.welcome = null;
    this.map = null;
    this.mapBytes = 0;
    this.id = null;
    this.waiters.clear();
  }

  async dispose() {
    if (this.disposed) return this.closeInfo;
    const info = await this.close();
    this.tracker?.unregister(this);
    this.disposed = true;
    return info;
  }
}
