/** Yield between small batches so loading paint, network and cancellation run. */
export async function buildInitialMesh(store, {
  isActive = () => true,
  onProgress = () => {},
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  now = () => performance.now(),
} = {}) {
  const total = store.width * store.depth;
  let done = 0;
  onProgress(done, total);
  // Let the preceding loading state reach the screen before doing heavy work.
  await yieldControl();
  if (!isActive()) return false;
  let batchStart = now();
  for (let z = 0; z < store.depth; z++) {
    for (let x = 0; x < store.width; x++) {
      if (!isActive()) return false;
      store.rebuildChunk(x, z);
      onProgress(++done, total);
      if (done < total && now() - batchStart >= 8) {
        await yieldControl();
        batchStart = now();
      }
    }
  }
  return isActive();
}
