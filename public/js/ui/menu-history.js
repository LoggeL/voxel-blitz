const STATE_KEY = 'voxelBlitzMenu';

function commonDepth(left, right) {
  let depth = 0;
  while (depth < left.length && left[depth] === right[depth]) depth++;
  return depth;
}

/** Browser Back dismisses menu layers through their ordinary close actions. */
export class MenuHistory {
  constructor(browser = typeof window !== 'undefined' ? window : null) {
    this.browser = browser;
    this.history = browser?.history;
    this.layers = [];
    this.nextId = 0;
    this.owner = `${Date.now()}-${Math.random()}`;
    this.pending = null;
    this.disposed = false;
    this.preserveUrl = false;
    this.handlingPop = false;
    this.scheduled = false;
    this.enabled = !!(this.history?.pushState && this.history?.replaceState && this.history?.go);
    this.onPop = () => this._onPop();
    if (this.enabled) {
      // Mark the existing page without adding a step at the main menu.
      this.history.replaceState(this._state([]), '');
      browser.addEventListener('popstate', this.onPop);
    }
  }

  open(key, dismiss) {
    if (!this.enabled || this.disposed || this.layers.some((layer) => layer.key === key)) return;
    this.layers.push({ key, dismiss, id: ++this.nextId });
    if (!this.handlingPop) this.preserveUrl = true;
    this._schedule();
  }

  close(key) {
    const index = this.layers.findIndex((layer) => layer.key === key);
    if (index < 0 || this.disposed) return;
    this.layers.splice(index, 1);
    if (!this.handlingPop) this.preserveUrl = true;
    this._schedule();
  }

  _path() {
    const state = this.history.state?.[STATE_KEY];
    return state?.owner === this.owner && Array.isArray(state.path) ? state.path : [];
  }

  _state(path) {
    return { ...this.history.state, [STATE_KEY]: { owner: this.owner, path } };
  }

  _schedule() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this._sync();
    });
  }

  _sync() {
    if (this.disposed || this.handlingPop) return;
    if (this.pending) {
      if (this.preserveUrl) this.pending.url = this.browser.location.href;
      this.preserveUrl = false;
      return;
    }
    const current = this._path();
    const desired = this.layers.map((layer) => layer.id);
    const depth = commonDepth(current, desired);
    if (current.length > depth) {
      // Batch ordinary closes and serialize a new menu opened during traversal.
      // Keep URL edits made by admission/leave callbacks (especially ?lobby=).
      this.pending = {
        path: current.slice(0, depth),
        url: this.preserveUrl ? this.browser.location.href : null,
      };
      this.preserveUrl = false;
      this.history.go(depth - current.length);
      return;
    }
    this.preserveUrl = false;
    for (let i = depth; i < desired.length; i++) {
      this.history.pushState(this._state(desired.slice(0, i + 1)), '');
    }
  }

  _onPop() {
    if (this.disposed) return;
    if (this.pending) {
      const { path, url } = this.pending;
      this.pending = null;
      const arrived = this._path();
      if (arrived.length === path.length && commonDepth(arrived, path) === path.length) {
        if (url) this.history.replaceState(this.history.state, '', url);
        this._sync();
        return;
      }
      // A further browser Back during an ordinary close may pass its target.
      // Apply that navigation instead of reopening the layers it dismissed.
    }

    const depth = commonDepth(this._path(), this.layers.map((layer) => layer.id));
    const dismissed = this.layers.splice(depth);
    this.handlingPop = true;
    try {
      for (const layer of dismissed.reverse()) layer.dismiss();
    } finally {
      this.handlingPop = false;
      this.preserveUrl = false;
      // Forward can reach a dismissed layer. Skip it without resuming a match
      // or reconnecting to a lobby whose resources have already been released.
      this._sync();
    }
  }

  dispose() {
    this.disposed = true;
    this.browser?.removeEventListener?.('popstate', this.onPop);
    this.layers = [];
  }
}
