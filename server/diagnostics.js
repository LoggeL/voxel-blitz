import { PerformanceObserver, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const round = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

/** A tick this long (ms, at least twice the tick budget) is logged as a long tick. */
export const LONG_TICK_MS = 25;
/** At most one long-tick line per room per this many ms. */
const LONG_TICK_LOG_MS = 1000;

/**
 * A bounded, two-second window per room. Includes simulation and broadcast work.
 * With `describe` (a function returning the room's label, e.g. mode/map/players),
 * a tick over max(LONG_TICK_MS, 2 x interval budget) is logged through `log`,
 * at most once per second per room, and counted in `longTicks`.
 */
export class TickTiming {
  constructor({ describe = null, budgetMs = null, log = (line) => console.log(line) } = {}) {
    this.samples = [];
    this.describe = typeof describe === 'function' ? describe : null;
    this.budgetMs = budgetMs;
    this.log = log;
    this.longTicks = 0;
    this.loggedAt = -Infinity;
  }
  record(at, duration, interval) {
    // Samples arrive in time order: trim the expired head in place (no
    // per-tick array copies), then keep the newest 200.
    const samples = this.samples;
    samples.push({ at, duration, interval });
    let drop = 0;
    while (drop < samples.length && at - samples[drop].at > 2000) drop++;
    if (samples.length - drop > 200) drop = samples.length - 200;
    if (drop) samples.splice(0, drop);
    if (this.describe && duration >= Math.max(LONG_TICK_MS, 2 * (this.budgetMs?.() ?? 0))) {
      this.longTicks++;
      if (at - this.loggedAt >= LONG_TICK_LOG_MS) {
        this.loggedAt = at;
        try { this.log(`[voxel-blitz] long tick ${duration.toFixed(1)} ms (${this.describe()}, ${this.longTicks} so far)`); } catch { /* never break a tick */ }
      }
    }
  }
  read(at = performance.now()) {
    const samples = this.samples.filter((s) => at - s.at <= 2000);
    if (!samples.length) return null;
    const durations = samples.map((s) => s.duration).sort((a, b) => a - b);
    return {
      samples: samples.length,
      p95Ms: round(durations[Math.ceil(durations.length * 0.95) - 1]),
      maxMs: round(durations.at(-1)),
      intervalMaxMs: round(Math.max(...samples.map((s) => s.interval))),
      longTicks: this.longTicks,
    };
  }
}

/**
 * Process measurements are shared across clients, never reset by a probe.
 * Per one-second window: event-loop delay (5 ms resolution, so an idle loop
 * reads a few ms, not the old 20 ms timer floor), event-loop utilization (the
 * busy share of the one JS thread every room, socket and deflate callback
 * shares), CPU and garbage-collection pauses.
 */
export class ServerDiagnostics {
  constructor() {
    this.delay = monitorEventLoopDelay({ resolution: 5 });
    this.delay.enable();
    this.cpu = process.cpuUsage();
    this.elu = performance.eventLoopUtilization();
    this.gc = { count: 0, totalMs: 0, maxMs: 0 };
    this.gcObserver = null;
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.gc.count++;
          this.gc.totalMs += entry.duration;
          if (entry.duration > this.gc.maxMs) this.gc.maxMs = entry.duration;
        }
      });
      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch { this.gcObserver = null; }
    this.at = performance.now();
    this.latest = null;
    this.timer = setInterval(() => {
      const at = performance.now();
      const cpu = process.cpuUsage();
      const elu = performance.eventLoopUtilization();
      this.latest = {
        windowMs: round(at - this.at),
        eventLoopP95Ms: this.delay.count ? round(this.delay.percentile(95) / 1e6) : null,
        eventLoopMaxMs: this.delay.count ? round(this.delay.max / 1e6) : null,
        eventLoopUtilization: round(performance.eventLoopUtilization(elu, this.elu).utilization),
        cpuPercent: round(((cpu.user - this.cpu.user + cpu.system - this.cpu.system) / 1000) / (at - this.at) * 100),
        gc: this.gcObserver ? { count: this.gc.count, totalMs: round(this.gc.totalMs), maxMs: round(this.gc.maxMs) } : null,
      };
      this.cpu = cpu;
      this.elu = elu;
      this.gc = { count: 0, totalMs: 0, maxMs: 0 };
      this.at = at;
      this.delay.reset();
    }, 1000);
    this.timer.unref();
  }
  read(meta, at = performance.now()) {
    return {
      version,
      serverRttMs: meta.ping ?? null,
      serverPingSequence: meta.pingSequence ?? 0,
      serverPingAgeMs: meta.pingMeasuredAt == null ? null : round(at - meta.pingMeasuredAt),
      tickBudgetMs: meta.room?.engine?.intervalMs ?? null,
      tick: meta.room?.engine?.tickTiming.read(at) ?? null,
      process: this.latest ? { ...this.latest, ageMs: round(at - this.at) } : null,
      queuedBytes: meta.ws.bufferedAmount,
      // Snapshots this socket skipped under backpressure (their deltas rode the next one).
      skippedTicks: meta.skippedTicks ?? 0,
    };
  }
  dispose() {
    clearInterval(this.timer);
    this.delay.disable();
    this.gcObserver?.disconnect();
  }
}
