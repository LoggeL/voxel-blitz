/** Decode before blending over an opaque image. Rapid changes keep only the latest request. */
export class CrossfadeImage {
  constructor(root, image = null) {
    this.root = root;
    this.image = image || root.appendChild(document.createElement('img'));
    this.image.classList.add('vb-crossfade-base');
    this.image.alt = '';
    this.request = null;
    this.current = '';
    this.disposed = false;
  }

  set(src, alt = '') {
    this.image.alt = alt;
    // Older DOM implementations can still display the map without animation.
    if (typeof this.image.decode !== 'function') {
      this.image.src = src;
      this.current = src;
      return;
    }
    if (this.request?.src === src) return;
    this.request = { src };
    if (!this.running) void this._drain();
  }

  async _drain() {
    this.running = true;
    while (!this.disposed && this.request.src !== this.current) {
      const request = this.request;
      const incoming = document.createElement('img');
      incoming.alt = '';
      incoming.setAttribute('aria-hidden', 'true');
      incoming.className = 'vb-crossfade-incoming';
      incoming.src = request.src;
      this.root.dataset.loading = 'true';
      try { await incoming.decode(); } catch {
        if (this.request !== request) continue;
        break; // A failed asset never replaces the last good image.
      }
      if (this.disposed) break;
      if (this.request !== request) continue;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (this.current && !reducedMotion) {
        this.root.appendChild(incoming);
        this.overlay = incoming;
        this.animation = incoming.animate([
          { opacity: 0, transform: 'scale(1.025)' },
          { opacity: 1, transform: 'scale(1)' },
        ], { duration: 650, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' });
        try { await this.animation.finished; } catch { /* disposal cancels the blend */ }
      }
      if (this.disposed) break;
      this.image.src = request.src;
      this.current = request.src;
      this.root.dataset.image = request.src;
      // Keep the decoded overlay until the base element has decoded the same
      // resource too, so the handoff cannot expose an empty frame.
      try { await this.image.decode(); } catch { /* incoming was already decoded */ }
      this.animation?.cancel();
      this.animation = null;
      incoming.remove();
      this.overlay = null;
    }
    this.root.dataset.loading = 'false';
    this.running = false;
  }

  dispose() {
    this.disposed = true;
    this.animation?.cancel();
    this.overlay?.remove();
  }
}
