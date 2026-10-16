#!/usr/bin/env node
/**
 * Charge-weapon render proof using the actual WorldView, character lighting, MuzzleLights
 * and CombatPostProcess from capture.html. Charge is an explicit presentation
 * fixture; weapon shape, materials, animation, exposure and bloom are production
 * code. Images are unmodified framebuffer exports. No account, audio or match.
 *
 * node tools/chargerifle-polish-capture.mjs [--sizes desktop,landscape,portrait]
 *   [--weapon chargerifle|lance] [--qualities high,low]
 *   [--states idle,charge,charged] [--out <directory>]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (key, fallback) => {
  const index = process.argv.indexOf(key);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const list = (key, fallback) => arg(key, fallback).split(',').filter(Boolean);
const SIZES = {
  desktop: { width: 1600, height: 900, mobile: false },
  landscape: { width: 844, height: 390, mobile: true },
  portrait: { width: 390, height: 844, mobile: true },
};
const STATES = { idle: 0, charge: 0.64, charged: 1 };
const sizes = list('--sizes', 'desktop,landscape,portrait');
const qualities = list('--qualities', 'high,low');
const states = list('--states', 'idle,charge,charged');
const weapon = arg('--weapon', 'chargerifle');
const chargeSource = `${weapon}_charge_light`;
const outDir = path.resolve(root, arg('--out', weapon === 'lance'
  ? 'docs/design/voltlance/runtime' : 'docs/design/chargerifle/polish/runtime'));

async function evaluateLong(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, 240000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function main() {
  if (!['chargerifle', 'lance'].includes(weapon)) throw new Error(`unknown weapon: ${weapon}`);
  for (const size of sizes) if (!SIZES[size]) throw new Error(`unknown size: ${size}`);
  for (const quality of qualities) if (!['high', 'low'].includes(quality)) throw new Error(`unknown quality: ${quality}`);
  for (const state of states) if (!(state in STATES)) throw new Error(`unknown state: ${state}`);
  await mkdir(outDir, { recursive: true });
  const report = { generated: new Date().toISOString(), source: 'production WorldView / CombatPostProcess / ViewmodelRig / MuzzleLights',
    fixture: `${weapon} charge read model; settled hip pose; no match or server simulation`, weapon, shots: [], errors: [] };
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: `${weapon} polish capture` });
  try {
    const port = await server.port;
    for (const sizeId of sizes) for (const quality of qualities) {
      const size = SIZES[sizeId];
      const url = `http://127.0.0.1:${port}/capture.html?map=frontier&shot=trenches&quality=${quality}&probe=1`;
      const session = await launchCdpSession('about:blank', size);
      try {
        const page = session.page;
        await page.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1 });
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
          addEventListener('error', event => { window.__cr6StartupError = event.message; });
          addEventListener('unhandledrejection', event => { window.__cr6StartupError = String(event.reason); });
        ` });
        await page.send('Page.navigate', { url });
        await page.waitFor("document.documentElement.dataset.captureReady === 'true' || window.__cr6StartupError", {
          timeoutMs: 240000, label: `${sizeId} ${quality} WorldView`,
        });
        const startupError = await page.evaluate('window.__cr6StartupError || null');
        if (startupError) throw new Error(startupError);
        const metadata = await evaluateLong(page, `(async () => {
          const { scene, camera, worldview, frame } = window.__vbProbe;
          const [{ ViewmodelRig }, { MuzzleLights }, { weaponDisplayModel }, { WEAPONS }] = await Promise.all([
            import('/js/guns/viewmodel.js'), import('/js/engine/muzzle-lights.js'),
            import('/js/guns/weapon-display.js'), import('/shared/combatmath.js'),
          ]);
          camera.fov = 75;
          camera.near = 0.01;
          camera.updateProjectionMatrix();
          const rig = new ViewmodelRig(camera);
          const weapon = ${JSON.stringify(weapon)};
          rig.setWeapon(weapon);
          const modelAsset = rig._cur.body.userData.blenderAsset ?? 'procedural';
          if (weapon === 'lance' && modelAsset !== 'pike') throw new Error('VOLTLANCE capture requires the loaded Blender PIKE asset');
          worldview.addCharacterRoots(rig.root);
          const pool = new MuzzleLights(scene);
          const avatars = new Map();
          const pose = { speed: 0, grounded: true, aimSwayScale: 0, reducedMotion: true };
          for (let i = 0; i < 240; i++) rig.update(1 / 60, pose);
          window.__cr6Capture = async (charge, spill = true, advance = true) => {
            const def = WEAPONS[weapon];
            rig.setCharge(charge);
            rig.setWeaponDisplay(weaponDisplayModel({ wid: weapon, mag: def.magSize, reserve: def.magSize * 3,
              charge01: charge, ready01: 1, reloading01: null }, { mode: weapon === 'lance' ? 'fun' : 'titanfall' }));
            if (advance) rig.update(1 / 60, pose);
            pool.update(spill ? rig.flashLight : null, avatars, camera);
            worldview.presentCharacters({ camera, dt: 0, roster: null, bodyPosition: null });
            frame();
            const png = document.getElementById('capture').toDataURL('image/png');
            const coilNames = weapon === 'lance' ? [0, 1, 2].map(index => 'voltlance_coil_' + index)
              : ['left', 'right'].flatMap(side => [0, 1, 2].map(index => 'chargerifle_cell_' + side + '_' + index));
            const cells = coilNames.map(name => {
              const cell = rig._cur.body.getObjectByName(name);
              if (!cell) throw new Error('Missing charge cell: ' + name);
              const emissive = [];
              cell.traverse(object => {
                for (const material of [].concat(object.material || [])) {
                  if (material.emissiveIntensity > 0) emissive.push(material.emissiveIntensity);
                }
              });
              return { name, emissive: Math.max(0, ...emissive) };
            });
            return { png, charge, spill, modelAsset, source: rig.flashLight?.name,
              sourceIntensity: rig.flashLight?.intensity || 0, lightIntensity: pool.lights[0].intensity,
              lightColor: pool.lights[0].color.getHexString(), lightDistance: pool.lights[0].distance,
              cells, display: rig.weaponDisplayLive };
          };
          await document.fonts.ready;
          return { graphics: window.__vbCapture.graphics, post: window.__vbCapture.post,
            map: window.__vbCapture.map, shot: window.__vbCapture.shot,
            width: innerWidth, height: innerHeight, fov: camera.fov };
        })()`);
        if (quality === 'high' && (!metadata.graphics.hdr || !metadata.graphics.bloomLevels)) throw new Error('high quality did not enable HDR bloom');
        for (const state of states) {
          const result = await evaluateLong(page, `window.__cr6Capture(${STATES[state]})`);
          const { png, ...detail } = result;
          if (STATES[state] > 0 && (!(detail.lightIntensity > 0) || detail.source !== chargeSource)) {
            throw new Error(`${state}: charged ${weapon} did not reach production light pool`);
          }
          if (STATES[state] === 0 && (detail.sourceIntensity !== 0 || detail.lightIntensity !== 0)) {
            throw new Error(`idle ${weapon} retained a charge or shot light`);
          }
          const name = `${sizeId}-${quality}-${state}.png`;
          await writeFile(path.join(outDir, name), Buffer.from(png.split(',')[1], 'base64'));
          report.shots.push({ file: path.relative(root, path.join(outDir, name)), size: sizeId, quality, state, ...metadata, ...detail });
          console.log(`${sizeId} ${quality} ${state}: ${detail.source} intensity=${detail.lightIntensity.toFixed(3)}`);
        }
        // One same-frame ablation proves that scene spill affects the model.
        // Its filename and report explicitly mark this diagnostic variant.
        if (sizeId === 'desktop' && quality === 'high' && states.includes('charged')) {
          const { png, ...detail } = await evaluateLong(page, 'window.__cr6Capture(1, false, false)');
          const name = 'desktop-high-charged-spill-disabled.png';
          await writeFile(path.join(outDir, name), Buffer.from(png.split(',')[1], 'base64'));
          report.shots.push({ file: path.relative(root, path.join(outDir, name)), diagnostic: true, size: sizeId, quality, state: 'charged', ...metadata, ...detail });
        }
        report.errors.push(...page.errors);
      } catch (error) {
        report.errors.push(`${sizeId} ${quality}: ${error.stack || error.message}`);
        report.errors.push(...session.page.errors.map(error => `${sizeId} ${quality}: ${error}`));
      } finally { await session.close(); }
    }
  } finally { await stopServer(server); }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  console.log(`${report.shots.length} unmodified framebuffer captures -> ${path.relative(root, outDir)}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
