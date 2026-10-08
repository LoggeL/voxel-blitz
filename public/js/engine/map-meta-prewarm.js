// Background derivation of Frontier's map metadata (see frontier-meta-worker.js).
// Main-thread callers of getMapMeta('frontier') before it lands simply build
// it themselves; both paths run the same shared code and give equal data.
import { primeFrontierMetadata } from '../../../shared/world/metadata.js';

let pending = null;
/** 'idle' | 'running' | 'primed' | 'failed' (debug and the join profile read it). */
export let frontierMetadataPrewarm = 'idle';

/** Start the worker once per page; resolves true when the metadata was primed. */
export function prewarmFrontierMetadata() {
  if (pending) return pending;
  frontierMetadataPrewarm = 'running';
  pending = new Promise((resolve) => {
    let worker = null;
    try {
      if (typeof Worker !== 'function') throw new Error('no workers');
      worker = new Worker(new URL('./frontier-meta-worker.js', import.meta.url), { type: 'module', name: 'frontier-meta' });
    } catch { frontierMetadataPrewarm = 'failed'; resolve(false); return; }
    const finish = (primed) => { worker.terminate(); frontierMetadataPrewarm = primed ? 'primed' : 'failed'; resolve(primed); };
    worker.onmessage = (event) => {
      const primed = event.data?.type === 'meta' && !!primeFrontierMetadata(event.data.meta);
      finish(primed);
    };
    worker.onerror = (event) => { event.preventDefault?.(); finish(false); };
    worker.postMessage({ type: 'build' });
  });
  return pending;
}
