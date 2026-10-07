/** Yield between small batches so loading paint, network and cancellation run. */
export async function buildInitialMesh(store, {
  isActive = () => true,
  onProgress = () => {},
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  now = () => performance.now(),
} = {}) {
  const rows = store.initialChunks ? store.initialChunks() : Array.from({ length: store.width * store.depth }, (_, i) => [i % store.width, Math.floor(i / store.width)]);
  const total = rows.length;
  let done = 0;
  onProgress(done, total);
  // Let the preceding loading state reach the screen before doing heavy work.
  await yieldControl();
  if (!isActive()) return false;
  let batchStart = now();
  for (const [x, z] of rows) {
      if (!isActive()) return false;
      store.rebuildChunk(x, z);
      onProgress(++done, total);
      if (done < total && now() - batchStart >= 8) {
        await yieldControl();
        batchStart = now();
      }
  }
  if (store.loadQueue) store.loadQueue.length = 0;
  return isActive();
}
