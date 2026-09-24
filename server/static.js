// Static file handler for /public. Zero dependencies outside node core.
// Exports an async callback(req, res) -> Promise<boolean(handled).
// When it resolves false the caller owns the response (index.js answers 404 JSON);
// when true the response has been fully written and must not be touched again.
//
// Single source of truth for shared sim modules: the client imports
// '/shared/…' (resolved from public/js/* relative paths). Those requests are
// served from the repo-root shared/ directory — public/shared duplicates are
// gone, so server and browser always run byte-identical code.
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Absolute filesystem root every served path must stay inside. */
export const PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
/** Repo root — hosts the canonical shared/ modules. */
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const INDEX_HTML = 'index.html';

// Text, module and geometry payloads shrink three to five times; images and
// audio are already compressed. Compressed bodies are cached in memory per
// (path, size, mtime) so a reload never re-encodes an unchanged file.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.gltf', '.bin', '.json', '.map', '.svg', '.wasm']);
const COMPRESS_MIN_BYTES = 1024;
const COMPRESS_MAX_BYTES = 24 * 1024 * 1024;
const encodedBodies = new Map();
let encodedBytes = 0;
const ENCODED_CACHE_LIMIT = 64 * 1024 * 1024;

/** Weak validator from size and mtime: cheap, and stable across restarts. */
function etagFor(stats) {
  return `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
}

function pickEncoding(req) {
  const accept = String(req.headers?.['accept-encoding'] || '').toLowerCase();
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

async function encodedBody(filePath, stats, encoding) {
  const key = `${encoding}:${filePath}:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
  const hit = encodedBodies.get(key);
  if (hit) return hit;
  const raw = await readFile(filePath);
  const body = encoding === 'br'
    ? await brotliAsync(raw, { params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    } })
    : await gzipAsync(raw, { level: 6 });
  // Drop stale encodings of the same file, then bound the cache.
  for (const existing of encodedBodies.keys()) {
    if (existing.startsWith(`${encoding}:${filePath}:`)) {
      encodedBytes -= encodedBodies.get(existing).length;
      encodedBodies.delete(existing);
    }
  }
  while (encodedBytes + body.length > ENCODED_CACHE_LIMIT && encodedBodies.size) {
    const oldest = encodedBodies.keys().next().value;
    encodedBytes -= encodedBodies.get(oldest).length;
    encodedBodies.delete(oldest);
  }
  encodedBodies.set(key, body);
  encodedBytes += body.length;
  return body;
}

function matchesEtag(req, etag) {
  const header = req.headers?.['if-none-match'];
  if (!header) return false;
  return String(header).split(',').some((candidate) => {
    const value = candidate.trim();
    return value === etag || value === '*' || value.replace(/^W\//, '') === etag.replace(/^W\//, '');
  });
}

/**
 * Serve a GET/HEAD request from public/ (with shared/ fallback), or resolve
 * false when this handler declines the request (wrong method, traversal
 * attempt, unknown extension, missing file). Nothing is ever written to `res`
 * on false.
 */
export async function staticHandler(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;

  const filePath = resolveWithinRoot(req.url || '/');
  if (!filePath) return false;

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext];
  if (!contentType) return false;

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;

  const etag = etagFor(stats);
  const baseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': cacheControlFor(filePath),
    'ETag': etag,
    'Vary': 'Accept-Encoding',
  };
  if (matchesEtag(req, etag)) {
    if (typeof res.writeHead === 'function') res.writeHead(304, baseHeaders);
    if (typeof res.end === 'function') res.end();
    return true;
  }

  const encoding = COMPRESSIBLE.has(ext) && stats.size >= COMPRESS_MIN_BYTES && stats.size <= COMPRESS_MAX_BYTES
    ? pickEncoding(req) : null;
  if (encoding) {
    let body;
    try {
      body = await encodedBody(filePath, stats, encoding);
    } catch {
      return false;
    }
    if (req.aborted || res.destroyed) return true;
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, { ...baseHeaders, 'Content-Encoding': encoding, 'Content-Length': body.length });
    }
    if (typeof res.end === 'function') res.end(method === 'HEAD' ? undefined : body);
    return true;
  }

  if (method === 'HEAD') {
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, { ...baseHeaders, 'Content-Length': stats.size });
    }
    if (typeof res.end === 'function') res.end();
    return true;
  }

  const body = createReadStream(filePath);
  try {
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        body.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        body.off('open', onOpen);
        reject(err);
      };
      body.once('open', onOpen);
      body.once('error', onError);
    });
  } catch {
    body.destroy();
    return false;
  }

  if (req.aborted || res.destroyed) {
    body.destroy();
    return true;
  }
  if (typeof res.writeHead === 'function') {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': stats.size });
  }
  try {
    await pipeline(body, res);
  } catch (err) {
    if (isClientAbort(req, err)) return true;
    throw err;
  }
  return true;
}

function isClientAbort(req, err) {
  return req.aborted ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'EPIPE' ||
    err?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/**
 * Map a raw request target to an absolute file path that is guaranteed to
 * stay inside PUBLIC_ROOT (or inside PROJECT_ROOT/shared for the shared-
 * module alias), or null. Root '/' maps to public/index.html. Returns null
 * when neither candidate exists on disk.
 */
function resolveWithinRoot(target) {
  let pathname;
  const q = target.indexOf('?');
  if (q >= 0) target = target.slice(0, q);
  try {
    pathname = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/') || pathname.includes('\0')) return null;
  pathname = pathname.replace(/\\/g, '/');
  if (pathname.split('/').includes('..')) return null;
  const resolved = path.resolve(PUBLIC_ROOT, '.' + pathname);
  const rel = path.relative(PUBLIC_ROOT, resolved);
  // Validate before the directory-index branch, including encoded trailing slashes.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel === '' || pathname.endsWith('/')) {
    const idx = path.join(resolved, INDEX_HTML);
    return existsSync(idx) ? idx : null;
  }
  if (existsSync(resolved)) return resolved;
  // Fallback: '/shared/<rest>' maps onto the canonical repo-root shared/.
  const parts = rel.split(path.sep);
  if (parts[0] === 'shared' && parts.length > 1) {
    const alt = path.join(PROJECT_ROOT, 'shared', ...parts.slice(1));
    // Guard the alias against traversal just like the primary root.
    const altRel = path.relative(path.join(PROJECT_ROOT, 'shared'), alt);
    if (!altRel.startsWith('..') && !path.isAbsolute(altRel) && existsSync(alt)) return alt;
  }
  return null;
}

/** Cache policy: vendored bundles are content-frozen. Everything else may be
 *  kept but must be revalidated on every use (no-cache + ETag), so a changed
 *  module body is always fetched while an unchanged one costs one 304. */
function cacheControlFor(filePath) {
  const rel = filePath.slice(PUBLIC_ROOT.length).split(path.sep).join('/');
  const parts = rel.split('/');
  if (parts.includes('vendor')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}
