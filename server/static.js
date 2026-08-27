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
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

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
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
};

const INDEX_HTML = 'index.html';

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

  if (method === 'HEAD') {
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'Cache-Control': cacheControlFor(filePath),
      });
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
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': cacheControlFor(filePath),
    });
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
  const resolved = path.resolve(PUBLIC_ROOT, '.' + pathname);
  const rel = path.relative(PUBLIC_ROOT, resolved);
  if (rel === '' || pathname.endsWith('/')) {
    const idx = path.join(resolved, INDEX_HTML);
    return existsSync(idx) ? idx : null;
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
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

/** Cache policy: vendored bundles are content-frozen; everything else must
 *  NEVER be stored — stale module bodies silently break iterations. */
function cacheControlFor(filePath) {
  const rel = filePath.slice(PUBLIC_ROOT.length).split(path.sep).join('/');
  const parts = rel.split('/');
  if (parts.includes('vendor')) return 'public, max-age=31536000, immutable';
  return 'no-store';
}
