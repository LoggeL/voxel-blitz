/**
 * Yield between small batches so loading paint, network and cancellation run.
 * `radius` limits a streaming store (Frontier) to the chunks around the spawn;
 * the rest of its working set streams in nearest first once play has begun
 * (ChunkStore.update drains loadQueue). `sliceMs` is the work per batch.
 */
export async function buildInitialMesh(store, {
  isActive = () => true,
  onProgress = () => {},
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  now = () => performance.now(),
  radius = Infinity,
  sliceMs = 8,
} = {}) {
  const rows = store.initialChunks ? store.initialChunks({ radius }) : Array.from({ length: store.width * store.depth }, (_, i) => [i % store.width, Math.floor(i / store.width)]);
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
      if (done < total && now() - batchStart >= sliceMs) {
        await yieldControl();
        batchStart = now();
      }
  }
  // Chunks outside the spawn ring stay queued for ChunkStore.update.
  if (store.loadQueue) store.loadQueue = store.chunks && store.chunkKey
    ? store.loadQueue.filter(row => !store.chunks.has(store.chunkKey(row.x, row.z))) : [];
  return isActive();
}
