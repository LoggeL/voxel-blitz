export const MAX_REMOTE_RECORDS = 32;

export function boundedMapSet(map, key, value) {
  if (!map.has(key) && map.size >= MAX_REMOTE_RECORDS) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}
