// Decode the shipped Ogg Opus bank in real Chromium without playing any audio.
// Uses only OfflineAudioContext, the muted CDP helper and a titan capture slot.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from '../lib/cdp-session.mjs';
import { startServer, stopServer } from '../lib/server-process.mjs';
import { TITAN_AUDIO_URLS } from '../../public/js/audio/titan-bank.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
let slot;
while (!slot) {
  for (const suffix of ['', '2', '3']) {
    const candidate = `${root}.titan-capture.lock${suffix}`;
    try { await mkdir(candidate); slot = candidate; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!slot) await new Promise(resolve => setTimeout(resolve, 2000));
}
let server, session;
process.once('exit', () => rmSync(slot, { recursive: true, force: true }));
try {
  server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'titan audio decode' });
  const port = await server.port;
  // A same-origin text page avoids loading unrelated weapon models or creating a GL context.
  session = await launchCdpSession(`http://127.0.0.1:${port}/assets/audio/titan/CREDITS.txt`, { width: 64, height: 64 });
  await session.page.waitFor('document.readyState === "complete"', { timeoutMs: 20000 });
  const files = await session.page.evaluate(`(async () => {
    const { TITAN_AUDIO_URLS } = await import('/js/audio/titan-bank.js');
    const ctx = new OfflineAudioContext(1, 1, 48000), rows = [];
    for (const url of TITAN_AUDIO_URLS) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      let peak = 0;
      for (const value of buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(value));
      rows.push({ url, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate, peak });
    }
    return rows;
  })()`);
  assert.equal(files.length, TITAN_AUDIO_URLS.length);
  for (const file of files) {
    assert.equal(file.channels, 1, file.url);
    assert.equal(file.sampleRate, 48000, file.url);
    assert.ok(file.duration > 0 && file.peak > 0 && file.peak < 1, file.url);
  }
  assert.deepEqual(session.page.errors, []);
  const out = process.argv[2];
  if (out) await writeFile(out, JSON.stringify({ playback: false, context: 'OfflineAudioContext', files }, null, 2) + '\n');
  console.log(`Titan audio: ${files.length} shipped Opus files decoded in Chromium, mono 48 kHz, finite non-silent peaks below 0 dBFS. No playback.`);
} finally {
  await session?.close();
  if (server) await stopServer(server);
  await rm(slot, { recursive: true, force: true });
}
