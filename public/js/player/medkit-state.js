/** Predict presentation only. Health and kit consumption always come from snapshots. */
export class MedkitState {
  constructor() {
    this.nextId = 0;
    this.ack = 0;
    this.pendingId = 0;
    this.canceledThrough = 0;
    this.cancelQueued = false;
    this.remaining = 1;
    this.active = false;
    this.progress = 0;
  }

  begin() {
    if (this.active || this.remaining !== 1) return false;
    this.pendingId = ++this.nextId;
    this.cancelQueued = false;
    this.active = true;
    this.progress = 0;
    return true;
  }

  cancel() {
    if (!this.active && !this.pendingId) return;
    this.canceledThrough = this.nextId;
    this.cancelQueued = true;
    this.pendingId = 0;
    this.active = false;
    this.progress = 0;
  }

  reconcile(row) {
    if (!row) return;
    this.ack = Math.max(this.ack, row.ack || 0);
    this.nextId = Math.max(this.nextId, this.ack);
    this.remaining = row.remaining === 1 ? 1 : 0;
    if (this.pendingId > this.ack) return;
    this.pendingId = 0;
    this.active = !!row.active && this.ack > this.canceledThrough;
    this.progress = this.active ? Math.max(0, Math.min(1, row.progress || 0)) : 0;
  }
}
