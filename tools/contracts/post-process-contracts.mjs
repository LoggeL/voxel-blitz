import {
  CombatPostProcess,
  normalizePostProcessState,
  postProcessBufferSize,
  recommendedPostProcessPixelRatio,
} from '../../public/js/engine/combat-post-process.js';

export function runPostProcessContracts(ok) {
  const normalized = normalizePostProcessState({
    panic: 4,
    pain: -2,
    scopeActive: true,
    reducedMotion: true,
    time: -1,
  });
  ok(normalized.panic === 1 && normalized.pain === 0 && normalized.scopeActive === 1 &&
      normalized.motion === 0 && normalized.time === 0,
  'combat shader normalizes condition inputs and reduced-motion state');

  const full = postProcessBufferSize(1280, 720, 2, 1.35);
  const lowMemory = postProcessBufferSize(1280, 720, 2,
    recommendedPostProcessPixelRatio(4));
  ok(full.width === 1728 && full.height === 972 && full.pixelRatio === 1.35 &&
      lowMemory.width === 1280 && lowMemory.height === 720 && lowMemory.pixelRatio === 1,
  'combat shader bounds its render target and scales down on low-memory devices');

  const renderer = {
    targets: [],
    renders: 0,
    info: { autoReset: true, resets: 0, reset() { this.resets++; } },
    setRenderTarget(target) { this.targets.push(target); },
    render() { this.renders++; },
  };
  const post = new CombatPostProcess(renderer, { maxPixelRatio: 1.25 });
  try {
    post.setSize(800, 450, 2);
    const rendered = post.render({}, {}, { time: 2, panic: 0.4, pain: 0.7 });
    ok(rendered && renderer.renders === 2 && renderer.targets.length === 2 &&
        renderer.targets[0] === post.target && renderer.targets[1] === null &&
        post.stats.frames === 1 && post.stats.bufferWidth === 1000 &&
        post.uniforms.panic.value === 0.4 && post.uniforms.pain.value === 0.7 &&
        renderer.info.autoReset === false && renderer.info.resets === 1,
    'combat shader owns one scene pass and one bounded full-screen pass per frame');
  } finally {
    post.dispose();
  }
  ok(renderer.info.autoReset === true,
    'combat shader restores renderer statistics ownership on disposal');

  let shouldFail = true;
  const fallbackRenderer = {
    renders: 0,
    setRenderTarget() {},
    render() {
      this.renders++;
      if (shouldFail) {
        shouldFail = false;
        throw new Error('synthetic shader failure');
      }
    },
  };
  const fallback = new CombatPostProcess(fallbackRenderer);
  try {
    const rendered = fallback.render({}, {});
    ok(!rendered && !fallback.stats.enabled && fallback.stats.fallbacks === 1 &&
        fallbackRenderer.renders === 2 && /synthetic/.test(fallback.stats.lastError),
    'combat shader fails open to the direct scene renderer');
  } finally {
    fallback.dispose();
  }
}
