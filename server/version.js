// Game version for the menu tag and /api/version: the package.json version
// plus a short build id. The id is the deploy's commit when the environment
// names one (GIT_SHA / SOURCE_COMMIT), else a content hash of the code that
// ships (server/, shared/, public/js, public/styles, index.html), so every
// deploy that changes code shows a new id without git inside the image.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CODE_PATHS = ['server', 'shared', 'public/js', 'public/styles', 'public/style.css', 'public/index.html'];

function codeFiles(rel, out) {
  let entries;
  try { entries = readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch { out.push(rel); return out; }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) codeFiles(child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Short hex hash of the shipped code (stable for identical trees). */
export function codeHash(paths = CODE_PATHS) {
  const hash = createHash('sha256');
  for (const rel of paths.flatMap(p => codeFiles(p, []))) {
    let bytes;
    try { bytes = readFileSync(path.join(ROOT, rel)); } catch { continue; }
    hash.update(rel).update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex').slice(0, 7);
}

function packageVersion() {
  try { return String(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
}

function envCommit(env) {
  const raw = String(env.GIT_SHA || env.SOURCE_COMMIT || '').trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 7).toLowerCase() : null;
}

/** `{ version, build, label }`, computed once at startup. */
export function buildInfo(env = process.env) {
  const version = packageVersion();
  const build = envCommit(env) || codeHash();
  return Object.freeze({ version, build, label: `v${version} · ${build}` });
}
