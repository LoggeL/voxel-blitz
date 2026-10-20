// Background derivation of a battlefield's map metadata (see frontier-meta-worker.js):
// Frontier at menu boot, Redrock Canyon once a lobby picks it. Main-thread
// callers of getMapMeta(id) before it lands simply build it themselves; both
// paths run the same shared code and give equal data.
import { primeBattlefieldMetadata } from '../../../shared/world/metadata.js';

const pending = new Map();
/** 'idle' | 'running' | 'primed' | 'failed' (debug and the join profile read it). */
export let frontierMetadataPrewarm = 'idle';
/** Per battlefield id: the same states as frontierMetadataPrewarm. */
export const battlefieldMetadataPrewarm = {};

const setState = (mapId, state) => {
  battlefieldMetadataPrewarm[mapId] = state;
  if (mapId === 'frontier') frontierMetadataPrewarm = state;
};

/** Start the worker once per page and map; resolves true when the metadata was primed. */
export function prewarmBattlefieldMetadata(mapId = 'frontier') {
  if (mapId !== 'frontier' && mapId !== 'redrock') return Promise.resolve(false);
  if (pending.has(mapId)) return pending.get(mapId);
  setState(mapId, 'running');
  const job = new Promise((resolve) => {
    let worker = null;
    try {
      if (typeof Worker !== 'function') throw new Error('no workers');
      worker = new Worker(new URL('./frontier-meta-worker.js', import.meta.url), { type: 'module', name: `${mapId}-meta` });
    } catch { setState(mapId, 'failed'); resolve(false); return; }
    const finish = (primed) => { worker.terminate(); setState(mapId, primed ? 'primed' : 'failed'); resolve(primed); };
    worker.onmessage = (event) => {
      const primed = event.data?.type === 'meta' && event.data.meta?.id === mapId && !!primeBattlefieldMetadata(event.data.meta);
      finish(primed);
    };
    worker.onerror = (event) => { event.preventDefault?.(); finish(false); };
    worker.postMessage({ type: 'build', map: mapId });
  });
  pending.set(mapId, job);
  return job;
}

/** Frontier's prewarm (menu boot). */
export function prewarmFrontierMetadata() {
  return prewarmBattlefieldMetadata('frontier');
}
