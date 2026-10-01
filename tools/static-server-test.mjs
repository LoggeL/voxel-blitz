// Static delivery contract: compressed modules and geometry, ETag revalidation,
// immutable vendor bundles, HEAD parity, and the traversal guard.
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import zlib from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';

// Count real zlib work while retaining its native callback/compression behavior.
const originalBrotli = zlib.brotliCompress;
let brotliJobs = 0;
zlib.brotliCompress = (...args) => { brotliJobs++; return originalBrotli(...args); };
syncBuiltinESMExports();
const { staticHandler } = await import('../server/static.js');
zlib.brotliCompress = originalBrotli;
syncBuiltinESMExports();

const server = http.createServer(async (req, res) => {
  if (await staticHandler(req, res)) return;
  res.writeHead(404); res.end('nope');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
// Raw requests: fetch() would transparently decode gzip/br bodies.
const get = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: { get: (name) => res.headers[name.toLowerCase()] ?? null },
      arrayBuffer: async () => Buffer.concat(chunks),
    }));
  });
  req.on('error', reject);
  req.end();
});

try {
  const beforeBurst = brotliJobs;
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => get('/js/vendor/three.core.js', { 'accept-encoding': 'br' })));
  assert.equal(brotliJobs - beforeBurst, 1, 'simultaneous cold requests share one Brotli compression job');
  const originalCore = readFileSync(new URL('../public/js/vendor/three.core.js', import.meta.url));
  for (const response of concurrent) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'br');
    assert.deepEqual(brotliDecompressSync(Buffer.from(await response.arrayBuffer())), originalCore);
  }
  await get('/js/vendor/three.core.js', { 'accept-encoding': 'br' });
  assert.equal(brotliJobs - beforeBurst, 1, 'completed compression remains cached after the burst');
  // Module bodies arrive gzip- or brotli-encoded and decode to the exact file.
  const original = readFileSync(new URL('../public/js/main.js', import.meta.url));
  for (const [encoding, decode] of [['gzip', gunzipSync], ['br', brotliDecompressSync]]) {
    const res = await get('/js/main.js', { 'accept-encoding': encoding });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), encoding);
    assert.equal(res.headers.get('vary'), 'Accept-Encoding');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.ok(res.headers.get('etag')?.startsWith('W/"'), 'weak validator present');
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.length < original.length / 2, `${encoding} shrinks the module (${body.length} < ${original.length / 2})`);
    assert.deepEqual(decode(body), original, `${encoding} round-trips`);
  }
  // Geometry compresses too; images and audio are passed through untouched.
  const bin = await get('/assets/blender/hands.gltf', { 'accept-encoding': 'gzip' });
  assert.equal(bin.headers.get('content-encoding'), 'gzip');
  const image = await get('/assets/ui/armory/menu-hero.webp', { 'accept-encoding': 'gzip, br' });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-encoding'), null, 'webp is not re-encoded');
  assert.equal(image.headers.get('content-length'), String(readFileSync(new URL('../public/assets/ui/armory/menu-hero.webp', import.meta.url)).length));

  // The original announcer WAVs must reach the browser's decoder unchanged.
  for (const cue of ['doublekill', 'triplekill', 'multikill', 'ultrakill', 'monsterkill', 'rampage', 'godlike']) {
    const path = `/assets/audio/announcer/quake/${cue}.wav`;
    const audio = await get(path, { 'accept-encoding': 'gzip, br' });
    assert.equal(audio.status, 200, `${cue} is served`);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.equal(audio.headers.get('content-encoding'), null);
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), readFileSync(new URL(`../public${path}`, import.meta.url)));
  }

  // Clients without compression support get the identity body with its length.
  const plain = await get('/js/main.js', { 'accept-encoding': 'identity' });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(plain.headers.get('content-length'), String(original.length));
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), original);

  for (const [accepted, expected] of [
    ['br;q=0, gzip;q=1', 'gzip'],
    ['br;q=0.2, gzip;q=0.8', 'gzip'],
    ['gzip;q=0.2, br;q=0.8', 'br'],
    ['br;q=0, gzip;q=0', null],
    ['identity;q=1, gzip;q=0.5', null],
    ['*;q=1, br;q=0', 'gzip'],
    ['BR;Q=0, GZIP;Q=1', 'gzip'],
  ]) {
    const negotiated = await get('/js/main.js', { 'accept-encoding': accepted });
    assert.equal(negotiated.status, 200, `an acceptable representation exists for ${accepted}`);
    assert.equal(negotiated.headers.get('content-encoding'), expected, `honors encoding quality: ${accepted}`);
    const encoded = Buffer.from(await negotiated.arrayBuffer());
    const decoded = expected === 'br' ? brotliDecompressSync(encoded) : expected === 'gzip' ? gunzipSync(encoded) : encoded;
    assert.deepEqual(decoded, original);
  }
  for (const file of ['/js/main.js', '/assets/ui/armory/menu-hero.webp']) {
    const refused = await get(file, { 'accept-encoding': '*;q=0, identity;q=0' });
    assert.equal(refused.status, 406, 'refusing all available encodings never receives an unacceptable body');
    assert.equal((await refused.arrayBuffer()).byteLength, 0);
  }

  // A matching validator costs one 304 and no body, with or without compression.
  const etag = plain.headers.get('etag');
  for (const encoding of ['identity', 'gzip']) {
    const revalidated = await get('/js/main.js', { 'if-none-match': etag, 'accept-encoding': encoding });
    assert.equal(revalidated.status, 304, `304 on a fresh validator (${encoding})`);
    assert.equal(revalidated.headers.get('etag'), etag);
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0);
  }
  const stale = await get('/js/main.js', { 'if-none-match': 'W/"deadbeef"' });
  assert.equal(stale.status, 200, 'a stale validator gets the new body');

  // Shared simulation modules are served from the repo root with the same contract.
  const shared = await get('/shared/modes.js', { 'accept-encoding': 'gzip' });
  assert.equal(shared.status, 200);
  assert.equal(shared.headers.get('content-encoding'), 'gzip');
  assert.equal(shared.headers.get('cache-control'), 'no-cache');

  // Vendored bundles stay immutable; HEAD mirrors GET headers without a body.
  const vendor = await get('/js/vendor/three.module.js', { 'accept-encoding': 'gzip' }, 'HEAD');
  assert.equal(vendor.status, 200);
  assert.equal(vendor.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(vendor.headers.get('content-encoding'), 'gzip');
  assert.equal((await vendor.arrayBuffer()).byteLength, 0);

  // The page itself and its generated preload block are served fresh.
  const index = await get('/', { 'accept-encoding': 'br' });
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('content-encoding'), 'br');
  const html = brotliDecompressSync(Buffer.from(await index.arrayBuffer())).toString();
  assert.match(html, /<link rel="modulepreload" href="\.\/js\/main\.js">/);
  assert.match(html, /<meta name="vb-module-count" content="\d+">/);

  // Traversal and unknown types still fall through to the caller's 404.
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/shared/../server/index.js', '/js/', '/README.md']) {
    const res = await get(path, { 'accept-encoding': 'gzip' });
    assert.equal(res.status, 404, `${path} is refused`);
  }
  console.log('static server: shared cold compression, encoding quality/refusal, ETag revalidation, identity fallback, immutable vendor, HEAD parity and traversal guard passed');
} finally {
  server.close();
}
