import { NETWORK_PRESENTATION } from '../../../shared/networking.js';

const DEFAULT_TICK_RATE = 20;
const ARRIVAL_HISTORY = 48;
const PING_HISTORY = 60;
const MAX_CLOCK_ADJUST_PER_TICK_MS = 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function percentile95(values, scratch) {
  if (!values.length) return 0;
  scratch.length = values.length;
  for (let index = 0; index < values.length; index++) scratch[index] = values[index];
  scratch.sort((a, b) => a - b);
  return scratch[Math.min(scratch.length - 1, Math.floor(scratch.length * 0.95))];
}

/**
 * Owns transport timing only: measured RTT, arrival jitter and the adaptive
 * snapshot-buffer target. It has no WebSocket or rendering dependencies, so
 * deterministic contracts can feed it synthetic packet schedules.
 */
export class NetworkTiming {
  constructor({ tickRate = DEFAULT_TICK_RATE } = {}) {
    this._readModel = {};
    Object.defineProperties(this._readModel, {
      pingMs: { enumerable: true, get: () => Math.round(this.rttMs) },
      jitterMs: { enumerable: true, get: () => Math.round(this.jitterMs) },
      bufferMs: { enumerable: true, get: () => Math.round(this.interpolationDelayMs) },
      pingHistory: { enumerable: true, get: () => this.pingHistory },
    });
    this.reset(tickRate);
  }

  reset(tickRate = DEFAULT_TICK_RATE) {
    this.tickRate = Number.isFinite(tickRate) && tickRate > 0
      ? tickRate
      : DEFAULT_TICK_RATE;
    this.rttMs = 0;
    this.jitterMs = 0;
    this.interpolationDelayMs = NETWORK_PRESENTATION.defaultBufferMs;
    this.pingHistory = Object.freeze([]);
    this._lastArrival = null;
    this._arrivalJitter = [];
    this._jitterScratch = [];
    this._pendingPings = new Map();
    this._serverClockOffsetMs = null;
    this._lastServerTimeMs = null;
    this._lastMappedTimeMs = null;
  }

  get readModel() {
    return this._readModel;
  }

  recordArrival(atMs) {
    if (!Number.isFinite(atMs)) return this.interpolationDelayMs;
    const previous = this._lastArrival;
    this._lastArrival = atMs;
    if (previous === null) return this.interpolationDelayMs;

    const expected = 1000 / this.tickRate;
    const spacing = atMs - previous;
    if (!Number.isFinite(spacing) || spacing < 0 || spacing > 2000) return this.interpolationDelayMs;
    this._arrivalJitter.push(Math.abs(spacing - expected));
    if (this._arrivalJitter.length > ARRIVAL_HISTORY) this._arrivalJitter.shift();

    const robustJitter = percentile95(this._arrivalJitter, this._jitterScratch);
    this.jitterMs = this.jitterMs === 0
      ? robustJitter
      : this.jitterMs * 0.82 + robustJitter * 0.18;
    const target = clamp(
      expected * 1.35 + robustJitter * 2.4,
      NETWORK_PRESENTATION.minBufferMs,
      NETWORK_PRESENTATION.maxBufferMs,
    );
    const response = target > this.interpolationDelayMs ? 0.34 : 0.12;
    this.interpolationDelayMs += (target - this.interpolationDelayMs) * response;
    return this.interpolationDelayMs;
  }

  /**
   * Map the room's fixed-step clock onto the page clock. Packet arrival jitter
   * may move the offset by at most 2 ms per tick, so compressed deliveries do
   * not turn two authoritative 50 ms steps into a visible speed spike.
   */
  mapServerTime(serverAtMs, arrivalAtMs) {
    if (!Number.isFinite(serverAtMs) || !Number.isFinite(arrivalAtMs)) return arrivalAtMs;
    const sampledOffset = arrivalAtMs - serverAtMs;
    if (this._serverClockOffsetMs === null ||
        (this._lastServerTimeMs !== null && serverAtMs < this._lastServerTimeMs)) {
      this._serverClockOffsetMs = sampledOffset;
      this._lastMappedTimeMs = null;
    } else {
      const correction = clamp(
        (sampledOffset - this._serverClockOffsetMs) * 0.08,
        -MAX_CLOCK_ADJUST_PER_TICK_MS,
        MAX_CLOCK_ADJUST_PER_TICK_MS,
      );
      this._serverClockOffsetMs += correction;
    }
    let mapped = serverAtMs + this._serverClockOffsetMs;
    if (this._lastMappedTimeMs !== null && serverAtMs >= this._lastServerTimeMs) {
      mapped = Math.max(this._lastMappedTimeMs, mapped);
    }
    this._lastServerTimeMs = serverAtMs;
    this._lastMappedTimeMs = mapped;
    return mapped;
  }

  beginPing(nonce, atMs) {
    if (!Number.isSafeInteger(nonce) || !Number.isFinite(atMs)) return false;
    for (const [key, sentAt] of this._pendingPings) {
      if (atMs - sentAt > 10_000) this._pendingPings.delete(key);
    }
    this._pendingPings.set(nonce, atMs);
    return true;
  }

  resolvePong(nonce, atMs) {
    const sentAt = this._pendingPings.get(nonce);
    if (!Number.isFinite(sentAt) || !Number.isFinite(atMs)) return null;
    this._pendingPings.delete(nonce);
    const sample = clamp(atMs - sentAt, 0, 5000);
    if (!Number.isFinite(sample)) return null;
    this.rttMs = this.rttMs === 0 ? sample : this.rttMs * 0.74 + sample * 0.26;
    const history = this.pingHistory.slice(-(PING_HISTORY - 1));
    history.push(Math.round(sample));
    this.pingHistory = Object.freeze(history);
    return sample;
  }
}
