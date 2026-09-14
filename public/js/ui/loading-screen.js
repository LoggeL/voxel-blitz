/**
 * One modal owns startup, admission and arena preparation. Progress is only
 * ever derived from real work: module and asset requests during startup,
 * completed mesh sectors during arena preparation. No timed progress.
 */
const STEP_STATUSES = new Set(['pending', 'active', 'done', 'failed']);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export class LoadingScreen {
  constructor(root) {
    this.root = root;
    this.title = root.querySelector('#loading-title');
    this.status = root.querySelector('#loading-status');
    this.context = root.querySelector('#loading-context');
    this.progress = root.querySelector('progress');
    this.count = root.querySelector('#loading-count');
    this.percent = root.querySelector('#loading-percent');
    this.steps = root.querySelector('#loading-steps');
    this.action = root.querySelector('#loading-action');
    this.onCancel = null;
    this.plan = [];
    this.startedAt = 0;
    this.action.addEventListener('click', () => this.onCancel?.());
    root.addEventListener('cancel', event => {
      event.preventDefault();
      this.onCancel?.();
    });
    // The HTML is visible even before modules arrive; upgrade it to a modal.
    if (root.open) root.close();
  }

  show(stage, { title, status, context, onCancel = this.onCancel, image } = {}) {
    this.root.dataset.stage = stage;
    this.root.setAttribute('aria-busy', stage === 'error' ? 'false' : 'true');
    this.title.textContent = title || (stage === 'boot' ? 'GEARING UP' : 'PREPARING ARENA');
    this.status.textContent = status || 'Loading game…';
    this.context.textContent = context || (stage === 'boot' ? 'WELCOME TO VOXEL BLITZ' : 'DEPLOYMENT');
    this.onCancel = onCancel;
    this.action.hidden = !onCancel;
    this.action.textContent = stage === 'error' ? 'RELOAD GAME' : 'CANCEL';
    this.progress.hidden = stage === 'error';
    this.progress.removeAttribute('value');
    this.count.textContent = '';
    if (this.percent) this.percent.textContent = '';
    this.clearPlan();
    if (image) {
      // CSS resolves relative URLs against the stylesheet, so use the page URL.
      const url = new URL(image, this.root.ownerDocument.baseURI).href;
      this.root.style.setProperty('--loading-image', `url("${url}")`);
    }
    else if (stage === 'boot' || stage === 'connect') this.root.style.removeProperty('--loading-image');
    if (!this.root.open) this.root.showModal();
  }

  update(status) { this.status.textContent = status; }

  /** Sector progress for arena preparation: done out of the actual column count. */
  advance(done, total) {
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
    this.progress.value = Math.max(0, Math.min(1, done / total));
    this.count.textContent = `${Math.min(total, Math.max(0, done))} / ${total} SECTORS`;
    if (this.percent) this.percent.textContent = `${Math.round(this.progress.value * 100)}%`;
  }

  /**
   * Declare the weighted stages of the current screen. Each step reports its
   * own real progress through step(); the rail shows the weighted total.
   */
  setPlan(steps, { startedAt = nowMs() } = {}) {
    this.startedAt = startedAt;
    this.plan = steps.map(({ id, label, weight = 1 }) => ({
      id, label, weight: Math.max(0, weight), status: 'pending', fraction: 0, detail: '',
    }));
    this.renderPlan();
    this.renderTotal();
  }

  clearPlan() {
    this.plan = [];
    this.startedAt = 0;
    if (this.steps) {
      this.steps.hidden = true;
      if (typeof this.steps.replaceChildren === 'function') this.steps.replaceChildren();
    }
  }

  /**
   * Report a step: status, done/total (items or bytes) and a short detail.
   * Marking a step active also marks every earlier pending step done, so a
   * stage that produced no progress events never lingers as pending.
   */
  step(id, { status, done, total, fraction, detail, label } = {}) {
    const entry = this.plan.find((candidate) => candidate.id === id);
    if (!entry) return false;
    if (STEP_STATUSES.has(status)) {
      entry.status = status;
      if (status === 'active') {
        for (const earlier of this.plan) {
          if (earlier === entry) break;
          if (earlier.status === 'pending' || earlier.status === 'active') { earlier.status = 'done'; earlier.fraction = 1; }
        }
      }
      if (status === 'done') entry.fraction = 1;
      if (status === 'pending') entry.fraction = 0;
    }
    if (Number.isFinite(fraction)) entry.fraction = Math.max(0, Math.min(1, fraction));
    else if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
      entry.fraction = Math.max(0, Math.min(1, done / total));
    }
    if (typeof label === 'string') entry.label = label;
    if (typeof detail === 'string') entry.detail = detail;
    if (entry.status === 'active' && entry.detail) this.count.textContent = entry.detail;
    this.renderPlan();
    this.renderTotal();
    return true;
  }

  /** Weighted completion of the declared plan, 0..1 (null without a plan). */
  get planFraction() {
    const weight = this.plan.reduce((sum, entry) => sum + entry.weight, 0);
    if (!this.plan.length || weight <= 0) return null;
    return this.plan.reduce((sum, entry) => sum + entry.weight * entry.fraction, 0) / weight;
  }

  renderTotal() {
    const fraction = this.planFraction;
    if (fraction === null) return;
    this.progress.value = fraction;
    if (this.percent) this.percent.textContent = `${Math.round(fraction * 100)}%`;
  }

  renderPlan() {
    const list = this.steps;
    if (!list || typeof list.replaceChildren !== 'function' || !this.plan.length) return;
    const doc = this.root.ownerDocument;
    list.hidden = false;
    list.replaceChildren(...this.plan.map((entry) => {
      const item = doc.createElement('li');
      item.dataset.status = entry.status;
      item.dataset.step = entry.id;
      const label = doc.createElement('span');
      label.className = 'vb-loading-step-label';
      label.textContent = entry.label;
      const detail = doc.createElement('span');
      detail.className = 'vb-loading-step-detail';
      detail.textContent = entry.status === 'done' ? 'READY'
        : entry.status === 'failed' ? 'UNAVAILABLE'
          : entry.status === 'active' ? (entry.detail || `${Math.round(entry.fraction * 100)}%`) : '';
      item.append(label, detail);
      return item;
    }));
  }

  /** Elapsed startup time for the profiler and the footer. */
  elapsedMs(now = nowMs()) {
    return this.startedAt ? Math.max(0, now - this.startedAt) : 0;
  }

  hide() {
    this.root.close();
    this.root.setAttribute('aria-busy', 'false');
    this.onCancel = null;
    this.clearPlan();
  }

  fail(message) {
    this.show('error', { title: 'UNABLE TO DEPLOY', status: message,
      onCancel: () => location.reload() });
  }
}

export { formatBytes };

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export const loadingScreen = typeof document !== 'undefined' && typeof document.getElementById === 'function'
  && document.getElementById('loading-screen')
  ? new LoadingScreen(document.getElementById('loading-screen')) : null;
