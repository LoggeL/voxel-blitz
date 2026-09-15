/**
 * Background asset scheduler. Tasks are named units of loading (a dynamic
 * import, a sample bank decode, a prefetch) that run one after another once
 * the menu is interactive. require() waits for exactly the tasks a caller
 * needs, in order, and mirrors the outstanding ones as stages of the staged
 * loading screen. Progress is only ever real work reported by the loader.
 * DOM-free so the ordering contract runs under Node.
 */
const clamp01 = (value) => Math.max(0, Math.min(1, value));

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class AssetScheduler {
  constructor({ onChange = null, now = nowMs, warn = (...args) => console.warn(...args) } = {}) {
    this.tasks = [];
    this._byId = new Map();
    this._onChange = typeof onChange === 'function' ? onChange : null;
    this._now = now;
    this._warn = warn;
    this._background = null;
  }

  /** Declare a task; `load(report)` returns a promise and may report {done,total|fraction,detail}. */
  define(id, { label = String(id).toUpperCase(), weight = 1, load } = {}) {
    if (typeof load !== 'function') throw new TypeError(`asset task ${id} needs a load() function`);
    if (this._byId.has(id)) throw new Error(`asset task ${id} is already defined`);
    const task = {
      id, label, weight: Math.max(0, weight), load,
      status: 'pending', promise: null, fraction: 0, detail: '', error: null,
      startedAt: 0, ms: 0, value: undefined, listeners: new Set(),
    };
    this.tasks.push(task);
    this._byId.set(id, task);
    return task;
  }

  get(id) { return this._byId.get(id) || null; }

  /** Snapshot for the menu indicator, the profiler and tests. */
  get status() {
    let done = 0, failed = 0;
    let active = null;
    for (const task of this.tasks) {
      if (task.status === 'done') done++;
      else if (task.status === 'failed') failed++;
      else if (task.status === 'active' && !active) active = task;
    }
    return {
      done, failed, total: this.tasks.length,
      idle: done + failed === this.tasks.length,
      active: active ? { id: active.id, label: active.label, detail: active.detail, fraction: active.fraction } : null,
      tasks: Object.fromEntries(this.tasks.map((task) => [task.id, task.status])),
      timings: Object.fromEntries(this.tasks.filter((task) => task.ms).map((task) => [task.id, task.ms])),
    };
  }

  /** Ids from the list that have not finished loading. */
  outstanding(ids) {
    return ids.filter((id) => this.get(id)?.status !== 'done');
  }

  /** Weighted 0..1 progress across the listed tasks; done counts full, failed counts empty. */
  fraction(ids) {
    let total = 0, value = 0;
    for (const id of ids) {
      const task = this.get(id);
      if (!task) continue;
      total += task.weight;
      value += task.weight * (task.status === 'done' ? 1
        : task.status === 'active' ? clamp01(task.fraction) : 0);
    }
    return total > 0 ? value / total : 1;
  }

  /** Start one task (idempotent while it runs or after success; a failure is retried). */
  start(id) {
    const task = this._byId.get(id);
    if (!task) return Promise.reject(new Error(`unknown asset task ${id}`));
    if (task.promise) return task.promise;
    task.status = 'active';
    task.fraction = 0;
    task.error = null;
    task.startedAt = this._now();
    this._changed();
    const report = ({ done, total, fraction, detail } = {}) => {
      if (task.status !== 'active') return;
      if (Number.isFinite(fraction)) task.fraction = clamp01(fraction);
      else if (Number.isFinite(done) && Number.isFinite(total) && total > 0) task.fraction = clamp01(done / total);
      if (typeof detail === 'string') task.detail = detail;
      for (const listener of task.listeners) listener(task);
      this._changed();
    };
    const promise = Promise.resolve().then(() => task.load(report)).then((value) => {
      task.status = 'done';
      task.fraction = 1;
      task.value = value;
      task.ms = Math.round(this._now() - task.startedAt);
      for (const listener of task.listeners) listener(task);
      this._changed();
      return value;
    }, (error) => {
      task.status = 'failed';
      task.error = error;
      task.promise = null;
      task.ms = Math.round(this._now() - task.startedAt);
      this._warn(`[vb] asset task ${id} failed:`, error);
      for (const listener of task.listeners) listener(task);
      this._changed();
      throw error;
    });
    task.promise = promise;
    return promise;
  }

  /** Load every task in definition order, one at a time. A failure never stops the queue. */
  startAll() {
    return this._background ??= (async () => {
      for (const task of this.tasks) {
        try { await this.start(task.id); } catch { /* reported by start() */ }
      }
    })();
  }

  /**
   * Wait for the listed tasks in order. When a loading screen is given and
   * some are outstanding, they become its stages (followed by `trailing`
   * stages the caller reports itself, e.g. mesh sectors). Resolves to the
   * task values by id; rejects with the first task failure.
   */
  async require(ids, { loading = null, trailing = [] } = {}) {
    const outstanding = new Set(this.outstanding(ids));
    const staged = loading && outstanding.size > 0;
    if (staged) {
      loading.setPlan([
        ...ids.filter((id) => outstanding.has(id)).map((id) => {
          const task = this.get(id);
          return { id, label: task?.label || id, weight: task?.weight ?? 1 };
        }),
        ...trailing,
      ]);
    }
    const values = {};
    for (const id of ids) {
      const task = this.get(id);
      const shown = staged && outstanding.has(id) && task;
      const forward = shown ? () => loading.step(id, { fraction: task.fraction, detail: task.detail }) : null;
      if (shown) {
        loading.step(id, { status: 'active', fraction: task.fraction, detail: task.detail });
        task.listeners.add(forward);
      }
      try {
        values[id] = await this.start(id);
        if (shown) loading.step(id, { status: 'done' });
      } catch (error) {
        if (shown) loading.step(id, { status: 'failed' });
        throw error;
      } finally {
        if (shown) task.listeners.delete(forward);
      }
    }
    return values;
  }

  _changed() {
    if (!this._onChange) return;
    try { this._onChange(this.status); } catch (error) { this._warn('[vb] asset status listener failed:', error); }
  }
}
