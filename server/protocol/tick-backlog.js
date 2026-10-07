// Per-client backpressure for tick snapshots. Every tick is a complete state
// snapshot except three per-tick delta fields: `blocks` (voxel replacements),
// `blockDamage` (changed damage rows) and `events`. When a client's socket is
// behind (its earlier snapshots are still being compressed or written), the
// tick is not queued behind them; its deltas are held and merged into the next
// snapshot the client is sent, whose state fields are the newest. A lagging
// client thus receives fewer, fresher snapshots instead of a growing backlog
// that delays everything behind it (pongs, pings) until the hard queue limit
// drops the socket. The wire format is unchanged: a merged snapshot is an
// ordinary tick whose delta arrays cover several ticks.

/** Snapshots allowed in flight (sent, not yet handed to the OS) per client. */
export const MAX_TICKS_IN_FLIGHT = 3;

const damageKey = row => `${row.x},${row.y},${row.z}`;

/** Accumulate one skipped tick's deltas into `held` (null starts a new hold). */
export function holdTickDeltas(held, tick) {
  held ??= { blocks: [], blockDamage: new Map(), events: [], ticks: 0 };
  if (Array.isArray(tick.blocks)) for (const row of tick.blocks) held.blocks.push(row);
  // Damage rows are absolute per voxel: a later row for the same voxel wins.
  if (Array.isArray(tick.blockDamage)) for (const row of tick.blockDamage) {
    const key = damageKey(row);
    held.blockDamage.delete(key);
    held.blockDamage.set(key, row);
  }
  if (Array.isArray(tick.events)) for (const event of tick.events) held.events.push(event);
  held.ticks++;
  return held;
}

/** The tick to send carrying the held deltas first, in order, then its own. */
export function mergeHeldDeltas(held, tick) {
  if (!held) return tick;
  const merged = holdTickDeltas({ blocks: held.blocks, blockDamage: held.blockDamage, events: held.events, ticks: held.ticks }, tick);
  return { ...tick, blocks: merged.blocks, blockDamage: [...merged.blockDamage.values()], events: merged.events };
}

/**
 * Decide for one client and one tick: returns the snapshot to send now (the
 * tick, possibly carrying held deltas) or null when the tick was held. The
 * caller reports completion of each sent tick through `tickSettled`.
 */
export function coalesceTick(client, tick) {
  if ((client.ticksInFlight ?? 0) >= MAX_TICKS_IN_FLIGHT) {
    client.heldTick = holdTickDeltas(client.heldTick ?? null, tick);
    client.skippedTicks = (client.skippedTicks ?? 0) + 1;
    return null;
  }
  const out = mergeHeldDeltas(client.heldTick ?? null, tick);
  client.heldTick = null;
  return out;
}

/** A tick send was handed to the socket (counts until tickSettled). */
export function tickSent(client) {
  client.ticksInFlight = (client.ticksInFlight ?? 0) + 1;
}

/** A tick send completed (written or failed). */
export function tickSettled(client) {
  client.ticksInFlight = Math.max(0, (client.ticksInFlight ?? 0) - 1);
}

/** Held deltas belong to the world they were made in: drop them on a map change. */
export function resetHeldTicks(client) {
  client.heldTick = null;
}
