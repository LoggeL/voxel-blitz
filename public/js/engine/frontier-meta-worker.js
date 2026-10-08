// Frontier's map metadata (terrain-derived spawns, flags, pads and landmarks)
// needs the full heightfield build, ~0.2 s of main-thread work. The menu
// derives it here in the background; map-meta-prewarm.js primes
// shared/world/metadata.js with the result, so joining Frontier skips it.
import { createFrontierMetadata } from '../../../shared/world/frontier-layout.js';

self.onmessage = () => {
  try {
    self.postMessage({ type: 'meta', meta: createFrontierMetadata() });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};
