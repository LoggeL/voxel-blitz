// Map template cache: the pristine voxels of every map this browser has been
// sent, keyed by the server's template fingerprint (shared/world/serialize.js
// mapFingerprint). The admission frame announces the cached fingerprints, so
// the server answers a rejoin, rematch room or second match on the same map
// with a V3 *reference* frame (a few bytes plus the changed cells) instead of
// the whole map (Frontier: 2 MB, ~0.5 MB deflated).
//
// Templates live in memory for the page session and persist in Cache Storage
// (one synthetic same-origin entry per fingerprint, newest last, at most
// `limit`). Both halves also keep to a byte budget, oldest evicted first:
// a server whose Frontier generator changed sends a new template under a new
// fingerprint, and that template (2 MB) pushes the stale one out instead of
// stale copies piling up across deploys. Every template is verified against its fingerprint when it is
// received and when it is read back, so a damaged entry is dropped instead of
// announced. Storage is optional: private windows, blocked storage or a
// non-secure origin simply keep the in-memory half.

import { MAP_FINGERPRINT_PATTERN, isMapFrame, mapFingerprint, parseMapFrame } from '../../../shared/world/serialize.js';

const CACHE_NAME = 'vb-map-templates-v1';
const KEY_PREFIX = '/__vb-map-template/';
/** Persisted templates (Frontier is the only large one; arenas are a few kB). */
const PERSIST_LIMIT = 6;
/** Fingerprints announced per admission (server/protocol/admission.js MAX_ADMISSION_MAP_CACHE). */
const ANNOUNCE_LIMIT = 8;
/** Template bytes kept (memory and storage): one Frontier (2.0 MB) plus the arenas. */
export const MAP_CACHE_BYTE_BUDGET = 3 * 1024 * 1024;

export class MapCache {
  constructor({ storage = (typeof caches !== 'undefined' ? caches : null), limit = PERSIST_LIMIT,
    byteBudget = MAP_CACHE_BYTE_BUDGET } = {}) {
    this.storage = storage;
    this.limit = limit;
    this.byteBudget = byteBudget;
    /** fingerprint -> template bytes (V1/V2 serialization), most recent last. */
    this.templates = new Map();
    this._loading = null;
    /** True once persisted templates are in memory (or there is no storage). */
    this.ready = !storage;
    this.stats = { loaded: 0, dropped: 0, evicted: 0, received: 0, stored: 0, references: 0, storageErrors: 0 };
  }

  /** Read persisted templates into memory once; never rejects. */
  load() {
    this._loading ??= this._load().catch(() => { this.stats.storageErrors++; })
      .finally(() => { this.ready = true; });
    return this._loading;
  }

  async _load() {
    if (!this.storage) return;
    const cache = await this.storage.open(CACHE_NAME);
    // Newest first: entries past the count or byte budget are deleted
    // unread and unhashed (hashing 2 MB costs the main thread ~5 ms).
    const keys = (await cache.keys()).reverse();
    const kept = [];
    let bytesKept = 0;
    for (const t of this.templates.values()) bytesKept += t.length;
    for (const request of keys) {
      const fingerprint = new URL(request.url).pathname.slice(KEY_PREFIX.length);
      if (kept.length >= this.limit) {
        this.stats.evicted++;
        await cache.delete(request);
        continue;
      }
      const response = await cache.match(request);
      const bytes = response ? new Uint8Array(await response.arrayBuffer()) : null;
      if (bytes?.length && (kept.length || this.templates.size) && bytesKept + bytes.length > this.byteBudget) {
        this.stats.evicted++;
        await cache.delete(request);
      } else if (MAP_FINGERPRINT_PATTERN.test(fingerprint) && bytes?.length && mapFingerprint(bytes) === fingerprint) {
        kept.push([fingerprint, bytes]);
        bytesKept += bytes.length;
        this.stats.loaded++;
      } else {
        this.stats.dropped++;
        await cache.delete(request);
      }
    }
    // Oldest first, then anything remembered while the read ran (newer).
    const current = this.templates;
    this.templates = new Map(kept.reverse().filter(([fingerprint]) => !current.has(fingerprint)));
    for (const [fingerprint, bytes] of current) this.templates.set(fingerprint, bytes);
    for (const stale of this._evict()) await cache.delete(KEY_PREFIX + stale);
  }

  /** Fingerprints to announce in the admission frame, newest first. */
  fingerprints() {
    return [...this.templates.keys()].reverse().slice(0, ANNOUNCE_LIMIT);
  }

  /** Template bytes for a fingerprint, or null. */
  get(fingerprint) {
    const bytes = this.templates.get(fingerprint) || null;
    if (bytes) this.stats.references++;
    return bytes;
  }

  /**
   * Keep the template a V3 frame carries (no-op for references and legacy
   * frames). Verifies it against the frame's fingerprint first; persists it
   * in the background. Returns the stored fingerprint or null. Never throws.
   */
  remember(frame) {
    try {
      if (!isMapFrame(frame)) return null;
      const { fingerprint, template } = parseMapFrame(frame);
      if (!template || mapFingerprint(template) !== fingerprint) return null;
      // A copy: the frame's buffer belongs to the socket message.
      const bytes = template.slice();
      this.templates.delete(fingerprint);
      this.templates.set(fingerprint, bytes);
      this.stats.received++;
      this._persist(fingerprint, bytes, this._evict());
      return fingerprint;
    } catch {
      return null;
    }
  }

  /** Drop a template everywhere (a reference it could not serve). */
  forget(fingerprint) {
    this.templates.delete(fingerprint);
    this._withCache(cache => cache.delete(KEY_PREFIX + fingerprint));
  }

  /** Drop the oldest templates beyond the byte budget (never the newest); returns their fingerprints. */
  _evict() {
    let bytes = 0;
    for (const t of this.templates.values()) bytes += t.length;
    const evicted = [];
    for (const [fingerprint, t] of this.templates) {
      if (bytes <= this.byteBudget || this.templates.size <= 1) break;
      this.templates.delete(fingerprint);
      bytes -= t.length;
      evicted.push(fingerprint);
      this.stats.evicted++;
    }
    return evicted;
  }

  _persist(fingerprint, bytes, evicted = []) {
    this._withCache(async (cache) => {
      for (const stale of evicted) await cache.delete(KEY_PREFIX + stale);
      const key = KEY_PREFIX + fingerprint;
      await cache.delete(key);
      await cache.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
      this.stats.stored++;
      const keys = await cache.keys();
      for (const stale of keys.slice(0, Math.max(0, keys.length - this.limit))) await cache.delete(stale);
    });
  }

  _withCache(task) {
    if (!this.storage) return;
    // Writes queue behind the initial read so a load never resurrects a deletion.
    this._writes = (this._writes || this.load())
      .then(() => this.storage.open(CACHE_NAME))
      .then(task)
      .catch(() => { this.stats.storageErrors++; });
  }
}

/** The page's map cache (session admission and the live boot share it). */
export const mapCache = new MapCache();
