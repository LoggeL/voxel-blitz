// Diagnostics must not touch the live buffer's mutable channel view. Some
// browsers apply audio fingerprint protection when that view is requested.
const peaks = new WeakMap();

export function auditBufferPeak(buffer) {
  if (!buffer) return 0;
  if (!peaks.has(buffer)) {
    const data = new Float32Array(buffer.length);
    buffer.copyFromChannel(data, 0);
    let peak = 0;
    for (const value of data) peak = Math.max(peak, Math.abs(value));
    peaks.set(buffer, peak);
  }
  return peaks.get(buffer);
}

export function recordedTailComplete(source, sampleRate) {
  if (source.disconnectedAt == null) return true;
  const expectedEnd = source.at + source.duration / source.rate;
  if (source.disconnectedAt >= expectedEnd) return true;
  // Native `ended` can report the start of the 128-frame block containing the
  // last sample. That is valid only after a natural end, with no explicit stop.
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(expectedEnd)) * 8;
  return source.endedAt != null && source.stopAt == null
    && source.disconnectedAt >= source.endedAt
    && expectedEnd - source.disconnectedAt <= 128 / sampleRate + epsilon;
}
