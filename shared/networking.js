/** Shared bounds for presentation buffering and authoritative hit rewind. */
export const NETWORK_PRESENTATION = Object.freeze({
  minBufferMs: 65,
  maxBufferMs: 180,
  defaultBufferMs: 80,
  maxExtrapolationMs: 75,
  minViewAgeMs: 50,
  maxViewAgeMs: 450,
  defaultViewAgeMs: 100,
});
