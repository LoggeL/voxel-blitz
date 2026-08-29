import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  createBrowserProfile,
  executableBrowser,
  removeBrowserProfile,
} from './browser-capture.mjs';
import { startServer, stopServer, waitForHttp } from './server-process.mjs';

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

/** Parse the common capture CLI plus a flow-specific set of string selectors. */
export function parseCaptureArgs(argv, {
  defaultOutDir,
  selectors,
  validate = () => {},
}) {
  const options = {
    all: false,
    list: false,
    outDir: defaultOutDir,
    baseUrl: null,
    browser: null,
    width: 1600,
    height: 800,
  };
  for (const name of Object.values(selectors)) options[name] = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const selector = selectors[arg];
    if (arg === '--all') options.all = true;
    else if (arg === '--list') options.list = true;
    else if (selector) options[selector] = optionValue(argv, index++, arg);
    else if (arg === '--out-dir') options.outDir = path.resolve(optionValue(argv, index++, arg));
    else if (arg === '--base-url') options.baseUrl = optionValue(argv, index++, arg);
    else if (arg === '--browser') options.browser = path.resolve(optionValue(argv, index++, arg));
    else if (arg === '--width') options.width = Number(optionValue(argv, index++, arg));
    else if (arg === '--height') options.height = Number(optionValue(argv, index++, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.width) || options.width < 320) throw new Error('invalid --width');
  if (!Number.isInteger(options.height) || options.height < 180) throw new Error('invalid --height');
  const selection = Object.values(selectors).filter((name) => options[name]);
  if (options.all && selection.length) {
    throw new Error(`--all cannot be combined with ${selection.map((name) => `--${name}`).join(' or ')}`);
  }
  if (options.list && (options.all || selection.length)) {
    throw new Error('--list cannot be combined with capture selection');
  }
  if (options.baseUrl) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('--base-url must use http or https');
    }
    options.baseUrl = url.href;
  }
  validate(options);
  return options;
}

async function waitForBaseUrl(baseUrl, route) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(new URL(route, baseUrl), {
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`capture server did not become ready: ${baseUrl}`);
}

/** Own the browser/profile/static-server lifecycle for a deterministic capture matrix. */
export async function runCaptureFlow({
  options,
  projectRoot,
  route,
  profilePrefix,
  failureContext,
  shots,
  captureShot,
  formatShot,
}) {
  const browser = await executableBrowser(options.browser);
  const profileDir = await createBrowserProfile(profilePrefix);
  let server = null;
  let baseUrl = options.baseUrl;
  try {
    if (!baseUrl) {
      server = startServer({
        cwd: projectRoot,
        entry: 'tools/capture-server.mjs',
        failureContext,
      });
      const port = await server.port;
      await waitForHttp(port, { path: route });
      baseUrl = `http://127.0.0.1:${port}`;
    } else {
      await waitForBaseUrl(baseUrl, route);
    }

    await mkdir(options.outDir, { recursive: true });
    const rendered = [];
    const dimensions = { width: options.width, height: options.height };
    for (const shot of shots) {
      const capture = captureShot({
        browser,
        profileDir,
        baseUrl,
        outDir: options.outDir,
        dimensions,
        shot,
      });
      const result = server ? await Promise.race([capture, server.unexpectedExit]) : await capture;
      rendered.push(result);
      console.log(`${formatShot(shot)} -> ${result.output} (${result.bytes} bytes)`);
    }
    return rendered;
  } finally {
    await stopServer(server);
    await removeBrowserProfile(profileDir);
  }
}
