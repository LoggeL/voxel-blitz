import { readKeybindings, replaceKeybindings, subscribeKeybindings, useKeybindingAccount } from './keybindings.js';

/** Serial writes and identity checks prevent delayed requests crossing accounts. */
export class AccountKeybindings {
  constructor({ request = fetch, retryMs = 3000 } = {}) {
    this.request = request;
    this.retryMs = retryMs;
    this.generation = 0;
    this.unsubscribe = subscribeKeybindings(() => {
      if (this.applying || !this.userId) return;
      this.revision++;
      this.dirty = true;
      if (this.loaded) this.save();
    });
  }

  async api(method, userId, keybindings) {
    const response = await this.request('/api/account/keybindings', {
      method, credentials: 'same-origin', signal: AbortSignal.timeout(8000),
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'X-VB-Account': '1' },
        body: JSON.stringify({ userId, keybindings }) } : {}),
    });
    if (!response.ok) throw new Error('Keybindings could not be synchronized');
    const payload = await response.json();
    if (payload.userId !== userId) throw new Error('Keybindings account changed');
    return payload;
  }

  apply(operation) {
    this.applying = true;
    try { operation(); } finally { this.applying = false; }
  }

  async setAccount(userId) {
    if (this.userId === userId) return;
    const guest = !this.userId ? readKeybindings() : null;
    this.userId = userId;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.revision = 0;
    this.dirty = false;
    this.loaded = false;
    this.saving = false;
    this.apply(() => useKeybindingAccount(userId));
    if (userId) await this.load(generation, guest);
  }

  async load(generation, guest) {
    try {
      const payload = await this.api('GET', this.userId);
      if (generation !== this.generation) return;
      if (!this.dirty) this.apply(() => replaceKeybindings(payload.keybindings ?? guest ?? readKeybindings()));
      this.loaded = true;
      this.dirty ||= payload.keybindings === null;
      await this.save();
    } catch {
      if (generation === this.generation) this.timer = setTimeout(() => this.load(generation, guest), this.retryMs);
    }
  }

  async save() {
    if (this.saving || !this.loaded || !this.dirty || !this.userId) return;
    clearTimeout(this.timer);
    this.saving = true;
    const generation = this.generation;
    const revision = this.revision;
    try {
      await this.api('POST', this.userId, readKeybindings());
      if (generation !== this.generation) return;
      this.dirty = revision !== this.revision;
      this.saving = false;
      if (this.dirty) await this.save();
    } catch {
      if (generation !== this.generation) return;
      this.saving = false;
      this.timer = setTimeout(() => this.save(), this.retryMs);
    }
  }

  dispose() {
    ++this.generation;
    clearTimeout(this.timer);
    this.unsubscribe();
  }
}
