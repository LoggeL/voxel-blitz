/** Shared bounds for presentation buffering and authoritative hit rewind. */
// The buffer must cover at least one 60 Hz step (16.7 ms) plus arrival jitter
// so remote players interpolate between two real snapshots instead of
// extrapolating; 30 ms is the floor, noisy links adapt up to 180 ms.
export const NETWORK_PRESENTATION = Object.freeze({
  minBufferMs: 30,
  maxBufferMs: 180,
  defaultBufferMs: 40,
  maxExtrapolationMs: 75,
  minViewAgeMs: 25,
  maxViewAgeMs: 450,
  defaultViewAgeMs: 60,
});
