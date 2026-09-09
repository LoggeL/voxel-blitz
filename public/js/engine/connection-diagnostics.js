import { NETWORK_PRESENTATION } from '../../../shared/networking.js';

export const CONNECTION_CHECK_MS = 60_000;
const REPLY_DEADLINE_MS = 5000;
const MAX_SNAPSHOT_SAMPLES = 2400;
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = (value) => Math.round(value * 100) / 100;

export function summarize(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    min: round(sorted[0]),
    median: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

/** Owns one bounded recording. Uses raw timestamps, independent of HUD smoothing. */
export class ConnectionDiagnostics {
  constructor({ now = () => performance.now(), date = () => new Date(), onChange = () => {},
    setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (timer) => clearInterval(timer) } = {}) {
    Object.assign(this, { now, date, onChange, setTimer, clearTimer });
    this.running = false;
    this.report = null;
    this.unsubs = [];
  }

  start(net, context = {}, hidden = false) {
    if (this.running || !net?.isOpen()) return false;
    this.net = net;
    this.context = { ...context };
    this.startedAt = this.now();
    this.startedUtc = this.date().toISOString();
    this.samples = [];
    this.snapshots = [];
    this.lastSnapshot = null;
    this.snapshotVisibilityChanged = false;
    this.snapshotsDropped = 0;
    this.expectedSnapshotMs = finite(net.welcome?.tickRate) && net.welcome.tickRate > 0
      ? 1000 / net.welcome.tickRate : null;
    this.serverRtts = [];
    this.lastServerSequence = null;
    this.frames = [];
    this.playFrames = [];
    this.pending = new Map();
    this.sent = 0;
    this.lastFrameAt = null;
    this.hidden = hidden;
    this.hiddenAt = hidden ? this.startedAt : null;
    this.hiddenMs = 0;
    this.running = true;
    this.report = null;
    this.unsubs = [
      net.on('diagnosticProbe', (probe) => {
        if (!this._withinWindow(probe.atMs)) return;
        this.pending.set(probe.nonce, probe.atMs);
        this.sent++;
      }),
      net.on('latency', (sample) => this._sample(sample)),
      net.on('tick', (snapshot) => this._snapshot(snapshot)),
      net.on('close', () => this.finish('disconnected')),
    ];
    net.setDiagnosticsEnabled(true);
    this.timer = this.setTimer(() => {
      if (this._withinWindow(this.now())) this.onChange();
    }, 250);
    this.onChange();
    return true;
  }

  _withinWindow(at) {
    if (!this.running) return false;
    if (at - this.startedAt >= CONNECTION_CHECK_MS) {
      this.finish('complete');
      return false;
    }
    return true;
  }

  _sample({ nonce, atMs, server }) {
    if (!this._withinWindow(atMs)) return;
    const sentAt = this.pending.get(nonce);
    if (!finite(sentAt)) return;
    this.pending.delete(nonce);
    const rttMs = atMs - sentAt;
    if (!finite(rttMs)) return;
    const stats = this.net.networkStats;
    this.samples.push({
      atMs: round(atMs - this.startedAt), rttMs: round(rttMs),
      hidden: this.hidden,
      jitterMs: finite(stats?.jitterMs) ? stats.jitterMs : null,
      bufferMs: finite(stats?.bufferMs) ? stats.bufferMs : null,
      queuedBytes: finite(this.net.ws?.bufferedAmount) ? this.net.ws.bufferedAmount : null,
      server: server || null,
    });
    // Server RTT is from its preceding control-frame probe, not this JS echo.
    // Ignore duplicate/stale measurements; never turn missing data into zero.
    if (finite(server?.serverRttMs) && finite(server?.serverPingSequence)
      && finite(server?.serverPingAgeMs) && server.serverPingAgeMs <= 3000
      && sentAt - server.serverPingAgeMs >= this.startedAt
      && server.serverPingSequence !== this.lastServerSequence) {
      this.serverRtts.push(server.serverRttMs);
      this.lastServerSequence = server.serverPingSequence;
    }
  }

  _snapshot({ recvLocalMs, serverNow }) {
    if (!finite(recvLocalMs) || !this._withinWindow(recvLocalMs) || recvLocalMs < this.startedAt) return;
    const previous = this.lastSnapshot;
    const serverAtMs = finite(serverNow) ? serverNow : null;
    const arrivalGapMs = previous ? recvLocalMs - previous.recvLocalMs : null;
    const serverStepMs = previous && serverAtMs !== null && previous.serverAtMs !== null
      ? serverAtMs - previous.serverAtMs : null;
    const sample = {
      atMs: round(recvLocalMs - this.startedAt), serverAtMs,
      arrivalGapMs: finite(arrivalGapMs) ? round(arrivalGapMs) : null,
      serverStepMs: finite(serverStepMs) ? round(serverStepMs) : null,
      hidden: this.hidden,
      foregroundInterval: !!previous && !previous.hidden && !this.hidden && !this.snapshotVisibilityChanged,
    };
    this.snapshotVisibilityChanged = false;
    this.lastSnapshot = { recvLocalMs, serverAtMs, hidden: this.hidden };
    if (this.snapshots.length < MAX_SNAPSHOT_SAMPLES) this.snapshots.push(sample);
    else this.snapshotsDropped++;
  }

  visibility(hidden, at = this.now()) {
    if (!this._withinWindow(at) || this.hidden === hidden) return;
    if (this.hiddenAt !== null) this.hiddenMs += at - this.hiddenAt;
    this.hidden = hidden;
    this.hiddenAt = hidden ? at : null;
    this.lastFrameAt = null;
    this.snapshotVisibilityChanged = true;
  }

  frame(at, settingsOpen = false) {
    if (!this._withinWindow(at) || this.hidden) return;
    if (this.lastFrameAt !== null && at > this.lastFrameAt && this.frames.length < 30_000) {
      const gap = at - this.lastFrameAt;
      this.frames.push(gap);
      if (!settingsOpen) this.playFrames.push(gap);
    }
    this.lastFrameAt = at;
  }

  metrics() {
    const values = (select) => this.samples.map(select).filter(finite);
    const rtts = values((s) => s.rttMs);
    const foregroundSnapshots = this.snapshots.filter((s) => s.foregroundInterval);
    const snapshotIntervals = foregroundSnapshots.filter((s) => finite(s.arrivalGapMs));
    const buffers = values((s) => s.bufferMs);
    return {
      browserRtt: summarize(rtts), serverRtt: summarize(this.serverRtts),
      rttVariation: summarize(rtts.slice(1).map((rtt, i) => Math.abs(rtt - rtts[i]))),
      frameMs: summarize(this.frames), playFrameMs: summarize(this.playFrames),
      framesOver50Ms: this.frames.filter((n) => n > 50).length,
      snapshotJitter: summarize(values((s) => s.jitterMs)),
      interpolationBuffer: summarize(values((s) => s.bufferMs)),
      bufferNearMaxPercent: buffers.length
        ? round(buffers.filter((n) => n >= NETWORK_PRESENTATION.maxBufferMs - 10).length / buffers.length * 100) : null,
      snapshotArrivalGap: summarize(foregroundSnapshots.map((s) => s.arrivalGapMs)),
      snapshotServerStep: summarize(foregroundSnapshots.map((s) => s.serverStepMs)),
      snapshotCompressedPercent: snapshotIntervals.length && this.expectedSnapshotMs !== null
        ? round(snapshotIntervals.filter((s) => s.arrivalGapMs < this.expectedSnapshotMs * 0.25).length / snapshotIntervals.length * 100) : null,
      serverTickP95: summarize(values((s) => s.server?.tick?.p95Ms)),
      serverTickMax: summarize(values((s) => s.server?.tick?.maxMs)),
      serverTickIntervalMax: summarize(values((s) => s.server?.tick?.intervalMaxMs)),
      serverEventLoopP95: summarize(values((s) => s.server?.process?.eventLoopP95Ms)),
      serverEventLoopMax: summarize(values((s) => s.server?.process?.eventLoopMaxMs)),
      serverCpu: summarize(values((s) => s.server?.process?.cpuPercent)),
      clientQueuedBytes: summarize(values((s) => s.queuedBytes)),
      serverQueuedBytes: summarize(values((s) => s.server?.queuedBytes)),
    };
  }

  finish(reason = 'stopped') {
    if (!this.running) return this.report;
    const at = Math.min(this.now(), this.startedAt + CONNECTION_CHECK_MS);
    if (this.hiddenAt !== null) this.hiddenMs += at - this.hiddenAt;
    this.hiddenAt = null;
    this.running = false;
    this.net.setDiagnosticsEnabled(false);
    this.clearTimer(this.timer);
    for (const off of this.unsubs) off();
    this.unsubs = [];
    const overdue = [...this.pending.values()].filter((sentAt) => at - sentAt >= REPLY_DEADLINE_MS).length;
    this.report = {
      schema: 'voxel-blitz-connection-check-v1',
      startedUtc: this.startedUtc, durationMs: round(at - this.startedAt), reason,
      context: this.context,
      serverVersion: this.samples.find((s) => typeof s.server?.version === 'string')?.server.version ?? null,
      hiddenMs: round(this.hiddenMs),
      probes: { sent: this.sent, received: this.samples.length,
        repliesOver5s: this.samples.filter((s) => s.rttMs >= REPLY_DEADLINE_MS).length,
        unansweredOver5s: overdue, pendingAtFinish: this.pending.size - overdue },
      metrics: this.metrics(), samples: this.samples,
      snapshotTiming: { expectedIntervalMs: this.expectedSnapshotMs, dropped: this.snapshotsDropped, samples: this.snapshots },
    };
    this.report.findings = connectionFindings(this.report);
    this.pending.clear();
    this.net = null;
    this.onChange();
    return this.report;
  }

  dispose() {
    this.onChange = () => {};
    this.finish('stopped');
  }
}

export function connectionFindings(report) {
  const m = report.metrics;
  const findings = [];
  if (report.reason !== 'complete') findings.push(`Partial check (${report.reason}). Repeat for a full 60 seconds.`);
  if (report.hiddenMs > 0) findings.push('The game was in the background. Keep the tab visible and repeat; background scheduling can delay replies.');
  if (!m.browserRtt || m.browserRtt.count < 10) findings.push('Too few replies for a useful comparison. Repeat while connected.');
  if (!m.serverRtt || !m.serverTickP95) findings.push('Some server measurements are unavailable. This report cannot isolate server delays.');
  if (!m.playFrameMs) findings.push('No gameplay frame sample. Resume the game while the check runs.');
  if (m.frameMs?.p95 > 35 || m.framesOver50Ms > 5) findings.push('Frame stalls were observed. Compare lower graphics settings or another browser on the same connection.');
  if (m.serverTickMax?.max > 50 || m.serverEventLoopMax?.max > 80) findings.push('Server timing spikes were observed. Share the report so the operator can compare server load at this time.');
  if (m.browserRtt?.p95 >= 150 || m.serverRtt?.p95 >= 150 || m.rttVariation?.mean > 25) {
    findings.push('High or variable latency was observed. Compare LAN, paused uploads/downloads, and a phone hotspot on this device.');
  }
  if (m.interpolationBuffer?.count >= 10 &&
      (m.bufferNearMaxPercent >= 50 || m.interpolationBuffer.median >= NETWORK_PRESENTATION.maxBufferMs - 10)) {
    findings.push(`The snapshot buffer stayed near its ${NETWORK_PRESENTATION.maxBufferMs} ms limit. This adds presentation delay for remote players and buffered events. Compare snapshot arrival gaps and server steps, then repeat over LAN and the direct server route.`);
  }
  const expected = report.snapshotTiming?.expectedIntervalMs;
  if (m.snapshotArrivalGap?.count >= 20 && expected > 0 && m.snapshotCompressedPercent >= 10
    && m.snapshotArrivalGap.p95 > expected * 1.75) {
    findings.push('Snapshots arrived in bursts with longer gaps between them. Transport buffering and browser scheduling can both cause this; the report does not identify which one.');
  }
  if (m.snapshotServerStep?.count >= 20 && expected > 0 && m.snapshotServerStep.median > expected * 1.5) {
    findings.push('Server timestamps advanced by more than the advertised snapshot interval. Check the actual broadcast rate and skipped snapshots before adjusting the buffer.');
  }
  if (report.probes.unansweredOver5s || report.probes.repliesOver5s) findings.push('Some replies were missing or late. This is not a packet-loss measurement; compare the route while the issue occurs.');
  if (!findings.length) findings.push('No clear issue in this sample. Repeat during the lag and compare reports.');
  return findings;
}

export function formatConnectionReport(report) {
  const metric = (name, s, unit = 'ms') => `${name}: ${s ? `median ${s.median}, p95 ${s.p95}, max ${s.max} ${unit} (${s.count} samples)` : 'unavailable'}`;
  const m = report.metrics;
  return [
    'VOXEL BLITZ CONNECTION CHECK',
    `UTC: ${report.startedUtc} | Duration: ${round(report.durationMs / 1000)} s | ${report.reason}`,
    `Host: ${report.context.host || 'unavailable'} | Room: ${report.context.room || 'unavailable'}`,
    `Mode: ${report.context.mode || 'unavailable'} | Map: ${report.context.map || 'unavailable'}`,
    `Server version: ${report.serverVersion || 'unavailable'}`,
    `Browser: ${report.context.browser || 'unavailable'}`,
    `Background: ${round(report.hiddenMs / 1000)} s`,
    '', metric('Browser application RTT', m.browserRtt), metric('Server WebSocket RTT', m.serverRtt),
    metric('RTT variation (absolute consecutive difference)', m.rttVariation),
    metric('Frame time (foreground)', m.frameMs), metric('Frame time (settings closed)', m.playFrameMs),
    `Frames over 50 ms: ${m.framesOver50Ms}`,
    metric('Snapshot arrival jitter', m.snapshotJitter), metric('Interpolation buffer', m.interpolationBuffer),
    `Buffer near maximum: ${finite(m.bufferNearMaxPercent) ? `${m.bufferNearMaxPercent}% of probes` : 'unavailable'}`,
    metric('Snapshot arrival gap (foreground)', m.snapshotArrivalGap),
    metric('Snapshot server-clock step (foreground)', m.snapshotServerStep),
    `Advertised snapshot interval: ${report.snapshotTiming?.expectedIntervalMs ?? 'unavailable'} ms | Compressed arrival gaps: ${finite(m.snapshotCompressedPercent) ? `${m.snapshotCompressedPercent}%` : 'unavailable'}`,
    metric('Server tick p95 (2 s windows)', m.serverTickP95),
    metric('Server tick max (2 s windows)', m.serverTickMax),
    metric('Server tick interval max (2 s windows)', m.serverTickIntervalMax),
    metric('Event-loop delay p95 (1 s windows, 20 ms resolution)', m.serverEventLoopP95),
    metric('Event-loop delay max (1 s windows)', m.serverEventLoopMax),
    metric('Process CPU (100% = one core)', m.serverCpu, '%'),
    metric('Client send queue', m.clientQueuedBytes, 'bytes'), metric('Server send queue', m.serverQueuedBytes, 'bytes'),
    `Probes: ${report.probes.sent} sent, ${report.probes.received} replies, ${report.probes.repliesOver5s} replies over 5 s, ${report.probes.unansweredOver5s} unanswered over 5 s, ${report.probes.pendingAtFinish} still pending at finish`,
    '', ...report.findings,
    '', 'RTTs include processing and transport delays. Server RTT probes are separate from browser echoes.',
    'WebSocket/TCP retransmissions hide network packet loss. Missing replies are not a packet-loss percentage.',
    'A traceroute to a proxied hostname stops at the proxy, not the game process. No route trace was run by this check.',
    'Server windows overlap; their percentiles are not percentiles of all individual ticks. Frame samples are capped at 30,000.',
    `Snapshot timestamps use separate client and server clocks; subtract consecutive values, not the two clocks. Raw snapshots are capped at ${MAX_SNAPSHOT_SAMPLES}; ${report.snapshotTiming?.dropped ?? 0} omitted. Background intervals are excluded from snapshot summaries.`,
    '', 'RAW REPORT', JSON.stringify(report, null, 2),
  ].join('\n');
}
