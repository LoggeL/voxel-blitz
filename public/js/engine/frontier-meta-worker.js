// A battlefield's map metadata (terrain-derived spawns, flags, pads and
// landmarks) needs the full heightfield build, ~0.2-0.3 s of main-thread
// work. The menu derives it here in the background (Frontier at boot,
// Redrock Canyon when a lobby picks it); map-meta-prewarm.js primes
// shared/world/metadata.js with the result, so joining skips it.
import { createFrontierMetadata } from '../../../shared/world/frontier-layout.js';

self.onmessage = async (event) => {
  try {
    if (event.data?.map === 'redrock') {
      const { createRedrockMetadata } = await import('../../../shared/world/redrock-sites/layout.js');
      self.postMessage({ type: 'meta', meta: createRedrockMetadata() });
      return;
    }
    self.postMessage({ type: 'meta', meta: createFrontierMetadata() });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};
