import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const round = (n) => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

/** A bounded, two-second window per room. Includes simulation and broadcast work. */
export class TickTiming {
  constructor() { this.samples = []; }
  record(at, duration, interval) {
    this.samples.push({ at, duration, interval });
    this.samples = this.samples.filter((s) => at - s.at <= 2000).slice(-200);
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
    };
  }
}

/** Process measurements are shared across clients, never reset by a probe. */
export class ServerDiagnostics {
  constructor() {
    this.delay = monitorEventLoopDelay({ resolution: 20 });
    this.delay.enable();
    this.cpu = process.cpuUsage();
    this.at = performance.now();
    this.latest = null;
    this.timer = setInterval(() => {
      const at = performance.now();
      const cpu = process.cpuUsage();
      this.latest = {
        windowMs: round(at - this.at),
        eventLoopP95Ms: this.delay.count ? round(this.delay.percentile(95) / 1e6) : null,
        eventLoopMaxMs: this.delay.count ? round(this.delay.max / 1e6) : null,
        cpuPercent: round(((cpu.user - this.cpu.user + cpu.system - this.cpu.system) / 1000) / (at - this.at) * 100),
      };
      this.cpu = cpu;
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
    };
  }
  dispose() {
    clearInterval(this.timer);
    this.delay.disable();
  }
}
