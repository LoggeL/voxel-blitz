import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CAREER_CATALOG } from '../shared/career.js';
import { COSMETIC_AUDIO_CHANNELS } from '../public/js/audio/cosmetics.js';

const publicRoot = new URL('../public/', import.meta.url);
let previews = 0, sounds = 0;
for (const item of CAREER_CATALOG) {
  if (item.preview) {
    const png = await fs.readFile(new URL(item.preview.slice(1), publicRoot));
    assert.equal(png.subarray(1, 4).toString(), 'PNG', `${item.id} has real preview artwork`);
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 800);
    previews++;
  }
  if (item.kind !== 'sound') continue;
  const folder = new URL(item.audio.slice(1), publicRoot);
  const manifest = JSON.parse(await fs.readFile(new URL('sources.json', folder), 'utf8'));
  assert.equal(manifest.kit, item.id);
  assert.deepEqual(manifest.assets.map(a => a.cue).sort(), ['death', 'kill', 'victory']);
  for (const asset of manifest.assets) {
    const audio = await fs.readFile(new URL(`${asset.cue}.ogg`, folder));
    assert.equal(audio.subarray(0, 4).toString(), 'OggS');
    const opus = audio.indexOf('OpusHead');
    assert.ok(opus >= 0, `${item.id}/${asset.cue} uses Opus`);
    assert.equal(audio[opus + 9], 1, 'mono');
    assert.equal(createHash('sha256').update(audio).digest('hex'), asset.sha256, 'manifest describes the shipped bytes');
    assert.equal(audio.length, asset.bytes);
    assert.equal(asset.source.http_status, 200);
    assert.equal(asset.source.provider, 'ElevenLabs Sound Effects');
    assert.ok(asset.metrics.decoded_duration_seconds <= COSMETIC_AUDIO_CHANNELS[asset.cue].seconds);
    assert.ok(asset.metrics.decoded_duration_seconds > (asset.cue === 'victory' ? 2.5 : 0.15));
    assert.ok(asset.metrics.sample_peak <= .75);
    assert.equal(asset.metrics.clipped_samples, 0);
    sounds++;
  }
}
assert.equal(previews, 5);
assert.equal(sounds, 9);
console.log('Cosmetics assets: five rendered previews and nine ElevenLabs Opus cues match catalog paths, provenance hashes and bounded signal metrics.');
