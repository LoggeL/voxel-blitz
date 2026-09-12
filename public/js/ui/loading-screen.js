/** One modal owns startup, admission and arena preparation. No timed progress. */
export class LoadingScreen {
  constructor(root) {
    this.root = root;
    this.title = root.querySelector('#loading-title');
    this.status = root.querySelector('#loading-status');
    this.context = root.querySelector('#loading-context');
    this.progress = root.querySelector('progress');
    this.count = root.querySelector('#loading-count');
    this.action = root.querySelector('#loading-action');
    this.onCancel = null;
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
    if (image) {
      // CSS resolves relative URLs against the stylesheet, so use the page URL.
      const url = new URL(image, this.root.ownerDocument.baseURI).href;
      this.root.style.setProperty('--loading-image', `url("${url}")`);
    }
    else if (stage === 'boot' || stage === 'connect') this.root.style.removeProperty('--loading-image');
    if (!this.root.open) this.root.showModal();
  }

  update(status) { this.status.textContent = status; }

  advance(done, total) {
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return;
    this.progress.value = Math.max(0, Math.min(1, done / total));
    this.count.textContent = `${Math.min(total, Math.max(0, done))} / ${total} SECTORS`;
  }

  hide() {
    this.root.close();
    this.root.setAttribute('aria-busy', 'false');
    this.onCancel = null;
  }

  fail(message) {
    this.show('error', { title: 'UNABLE TO DEPLOY', status: message,
      onCancel: () => location.reload() });
  }
}

export const loadingScreen = typeof document !== 'undefined' && document.getElementById('loading-screen')
  ? new LoadingScreen(document.getElementById('loading-screen')) : null;
