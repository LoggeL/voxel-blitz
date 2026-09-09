import { ConnectionDiagnostics, CONNECTION_CHECK_MS, formatConnectionReport } from '../engine/connection-diagnostics.js';

const el = (tag, parent, text = '', className = '') => {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  parent.append(node);
  return node;
};

/** Settings view; recording survives tab changes and resuming the match. */
export class ConnectionSettings {
  constructor() {
    this.getNet = () => null;
    this.getContext = () => ({});
    this.check = new ConnectionDiagnostics({ onChange: () => this.update() });
    this.onVisibility = () => this.check.visibility(this.document.hidden);
    this.lastUpdate = '';
  }

  configure({ getNet, getContext } = {}) {
    // A new admission must not continue the previous connection's recording.
    if (this.check.running && getNet?.() !== this.check.net) this.check.finish('disconnected');
    this.getNet = typeof getNet === 'function' ? getNet : () => null;
    this.getContext = typeof getContext === 'function' ? getContext : () => ({});
    this.update(true);
  }

  mount(parent) {
    if (this.root) return this.root;
    this.document = document;
    this.root = el('section', parent, '', 'vb-connection-check');
    el('h3', this.root, 'CHECK YOUR CONNECTION');
    el('p', this.root, 'Record 60 seconds while the lag happens. Start here, then resume playing. Come back for the results.', 'vb-connection-intro');
    this.status = el('p', this.root, '', 'vb-connection-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.progress = el('progress', this.root);
    this.progress.max = 60;
    this.progress.value = 0;
    this.progress.setAttribute('aria-label', 'Connection check progress');
    const actions = el('div', this.root, '', 'vb-connection-actions');
    this.startBtn = el('button', actions, 'CHECK CONNECTION', 'vb-btn');
    this.stopBtn = el('button', actions, 'STOP CHECK', 'vb-btn');
    this.copyBtn = el('button', actions, 'COPY REPORT', 'vb-btn');
    for (const button of [this.startBtn, this.stopBtn, this.copyBtn]) button.type = 'button';
    this.startBtn.id = 'settings-connection-start';
    this.stopBtn.hidden = true;
    this.copyBtn.disabled = true;
    const cards = el('dl', this.root, '', 'vb-connection-metrics');
    this.values = {};
    for (const [key, label] of Object.entries({ browserRtt: 'BROWSER PING', serverRtt: 'SERVER PING', frameMs: 'FRAME TIME', serverTickP95: 'SERVER TICK' })) {
      const card = el('div', cards);
      el('dt', card, label);
      this.values[key] = el('dd', card, 'Unavailable');
    }
    el('p', this.root, 'Ping shows the median. Frame time and server tick show p95: 95% of samples were at or below that value.', 'vb-connection-caption');
    this.findings = el('ul', this.root, '', 'vb-connection-findings');
    this.details = el('details', this.root, '', 'vb-connection-report');
    this.details.hidden = true;
    el('summary', this.details, 'View report');
    this.reportText = el('textarea', this.details);
    this.reportText.readOnly = true;
    this.reportText.rows = 8;
    this.reportText.setAttribute('aria-label', 'Connection diagnostic report');
    this.copyStatus = el('p', this.root, '', 'vb-connection-caption');
    this.copyStatus.setAttribute('role', 'status');
    el('p', this.root, 'The report stays in this browser tab until you copy it. It includes the game host, room code and browser version.', 'vb-connection-caption');
    this.startBtn.addEventListener('click', () => {
      this.copyStatus.textContent = '';
      this.check.start(this.getNet(), this.getContext(), document.hidden);
      this.update(true);
    });
    this.stopBtn.addEventListener('click', () => this.check.finish('stopped'));
    this.copyBtn.addEventListener('click', () => { void this.copy(); });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.update(true);
    return this.root;
  }

  frame(at, settingsOpen) { this.check.frame(at, settingsOpen); }

  update(force = false) {
    if (!this.root) return;
    const running = this.check.running;
    const report = this.check.report;
    const seconds = running ? Math.min(60, Math.floor((this.check.now() - this.check.startedAt) / 1000)) : 0;
    const connected = !!this.getNet()?.isOpen();
    const key = `${running}:${seconds}:${report?.startedUtc}:${report?.reason}:${connected}`;
    if (!force && key === this.lastUpdate) return;
    this.lastUpdate = key;
    this.startBtn.disabled = running || !connected;
    this.startBtn.textContent = report ? 'RUN AGAIN' : 'CHECK CONNECTION';
    this.stopBtn.hidden = !running;
    this.copyBtn.disabled = !report;
    this.progress.hidden = !running;
    this.progress.value = seconds;
    this.status.textContent = running
      ? `Recording ${seconds} / ${CONNECTION_CHECK_MS / 1000} s. You can resume the game.`
      : report ? `${report.reason === 'complete' ? 'Check complete' : report.reason === 'disconnected' ? 'Connection closed. Partial report saved' : 'Check stopped. Partial report saved'} (${Math.round(report.durationMs / 1000)} s).`
        : connected ? 'Ready when the lag happens.' : 'Join a match to check its connection.';
    const metrics = report?.metrics || (running ? this.check.metrics() : {});
    for (const [key, node] of Object.entries(this.values)) {
      const stats = metrics[key];
      node.textContent = stats ? `${Math.round(key.endsWith('Rtt') ? stats.median : stats.p95)} ms` : 'Unavailable';
    }
    this.findings.replaceChildren();
    if (report) for (const finding of report.findings) el('li', this.findings, finding);
    this.details.hidden = !report;
    if (report) this.reportText.value = formatConnectionReport(report);
    else { this.reportText.value = ''; this.details.open = false; }
  }

  async copy() {
    if (!this.check.report) return;
    const text = formatConnectionReport(this.check.report);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      this.copyStatus.textContent = 'Report copied.';
    } catch {
      this.details.open = true;
      this.reportText.focus();
      this.reportText.select();
      this.copyStatus.textContent = 'Automatic copy is unavailable. Copy the selected report manually.';
    }
  }

  dispose() {
    this.check.dispose();
    this.document?.removeEventListener('visibilitychange', this.onVisibility);
    this.document = null;
    this.root?.remove();
    this.root = null;
  }
}
