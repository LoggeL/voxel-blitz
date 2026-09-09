import assert from 'node:assert/strict';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ cwd: new URL('..', import.meta.url).pathname, failureContext: 'condition browser test' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/js/ui/hud-support.js`);
  const result = await browser.page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { CombatPostProcess } = await import('/js/engine/combat-post-process.js');
    const { HUD } = await import('/js/ui/hud.js');
    const { displaySettings } = await import('/js/ui/display-settings.js');
    document.body.innerHTML = '';
    const hud = new HUD(); hud.buildHUD(); hud.openSettings();
    const toggle = document.getElementById('settings-reducedMotion');
    if (!toggle) throw new Error('Missing reduced motion control');
    toggle.value = '1'; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    const persisted = localStorage.getItem('vb-display-reducedMotion') === '1';
    const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
    renderer.setSize(320, 180);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x708090);
    const camera = new THREE.PerspectiveCamera(75, 320/180, 0.1, 100);
    const post = new CombatPostProcess(renderer); post.setSize(320, 180);
    const gl = renderer.getContext();
    const render = (panic, pain, time, reducedMotion) => {
      post.reducedMotion = reducedMotion;
      const success = post.render(scene, camera, { panic, pain, time });
      const bytes = new Uint8Array(320 * 180 * 4);
      gl.readPixels(0, 0, 320, 180, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      if (!success || gl.getError() !== gl.NO_ERROR) throw new Error('Condition shader failed');
      return bytes;
    };
    const calm = render(0, 0, 1, false), stressed = render(1, 1, 1, false);
    const pixel = (data, x, y) => Array.from(data.slice((y*320+x)*4, (y*320+x)*4+3));
    let clearCenter = true;
    for (let y = 75; y < 105; y++) for (let x = 145; x < 175; x++) {
      if (pixel(calm,x,y).join() !== pixel(stressed,x,y).join()) clearCenter = false;
    }
    const edgeChanged = pixel(calm,5,5).join() !== pixel(stressed,5,5).join();
    const stillA = render(1,1,1,displaySettings().reducedMotion);
    const stillB = render(1,1,2,displaySettings().reducedMotion);
    const reducedStill = stillA.every((byte,index) => byte === stillB[index]);
    const settingsEnabled = displaySettings().reducedMotion && post.uniforms.motion.value === 0;
    toggle.value = '0'; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    const pulseA = render(1,1,1,displaySettings().reducedMotion);
    const pulseB = render(1,1,2,displaySettings().reducedMotion);
    const pulseEnabled = pulseA.some((byte,index) => byte !== pulseB[index]);
    post.dispose(); renderer.dispose(); hud.dispose();
    return { persisted, settingsEnabled, clearCenter, edgeChanged, reducedStill, pulseEnabled };
  })()`);
  for (const [check, passed] of Object.entries(result)) assert.equal(passed, true, check);
  assert.deepEqual(browser.page.errors, []);
  console.log('ok - live WebGL shader, unchanged center pixels, peripheral feedback, settings persistence and reduced-motion freeze');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
