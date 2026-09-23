// Shader warm-up and GLSL failure handling for a live match.
//
// warmShaders() links every program the arena needs while the loading screen
// is still up, with exactly the keys the first live frame asks for:
//   * character roots get their character-light patch first (the frame loop
//     would patch them just before the first render and recompile);
//   * the scene compiles with the post chain's scene target bound (linear
//     output, no tone mapping);
//   * every post pass compiles against the target it draws into, as listed by
//     CombatPostProcess.warmupPasses();
//   * the sun shadow pass links its depth programs (DynamicShadows.warm);
//   * every program is touched once, so the blocking link check runs now. Without
//     KHR_parallel_shader_compile, compileAsync resolves before anything links.
//
// ShaderErrorMonitor replaces three's shader error report. GLSL failures never
// throw, so a broken program silently draws nothing; the monitor logs it like
// three does, records it, and fails open: a broken post pass drops the chain to
// direct rendering, a broken patched material (terrain, voxel-lit props,
// character light) loses its patch and recompiles as the stock material.

import { prepareCharacterTree, setCharacterLightEnabled } from './character-light.js';

export const SHADER_WARMUP_BUDGET_MS = 1500;
/** character-light.js's program cache key (graphics-quality-test pins it). */
export const CHARACTER_LIGHT_KEY = 'character-lit-v1';

function topAncestor(object) {
  let node = object;
  while (node.parent) node = node.parent;
  return node;
}

function defaultNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Compile and link the match's programs. Never waits longer than `budgetMs`:
 * with parallel compile, slower programs keep linking in the background.
 * Returns { ms, programs, patched, linked, timedOut, skipped, failed }.
 */
export async function warmShaders({
  renderer, scene, camera, post = null, characterRoots = [], shadows = null,
  budgetMs = SHADER_WARMUP_BUDGET_MS, now = defaultNow,
} = {}) {
  const started = now();
  const result = { ms: 0, programs: 0, patched: 0, linked: 0, timedOut: false, skipped: false, failed: false };
  if (typeof renderer?.compileAsync !== 'function' || !scene || !camera) {
    result.skipped = true;
    return result;
  }
  const chain = post && !post.failed ? post : null;
  const pending = [];
  try {
    // compile() walks invisible objects too, so hidden gear is patched as well.
    for (const root of characterRoots) if (root) result.patched += prepareCharacterTree(root, false);
    // The shadow pass's depth programs (DynamicShadows on High/Ultra): compileAsync never builds them.
    shadows?.warm?.(renderer, characterRoots);
    renderer.setRenderTarget(chain ? chain.target : null);
    pending.push(renderer.compileAsync(scene, camera));
    for (const root of characterRoots) {
      if (root && topAncestor(root) !== scene) pending.push(renderer.compileAsync(root, camera, scene));
    }
    if (chain) {
      for (const { material, target } of chain.warmupPasses?.() || []) {
        chain.screen.material = material;
        renderer.setRenderTarget(target || null);
        pending.push(renderer.compileAsync(chain.scene, chain.camera));
      }
    }
  } catch (error) {
    result.failed = true;
    console.warn('[vb] shader warm-up failed', error);
  } finally {
    if (chain) chain.screen.material = chain.material;
    renderer.setRenderTarget(null);
  }
  if (pending.length) {
    let timer = 0;
    const budget = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs); });
    const outcome = await Promise.race([Promise.all(pending).then(() => 'ready', () => 'failed'), budget]);
    clearTimeout(timer);
    result.timedOut = outcome === 'timeout';
    if (outcome === 'failed') result.failed = true;
    // Everything reports ready: run the link check (and error report) now
    // instead of on the first live frame. Skipped after a timeout, where it
    // would block on the programs still linking in the background.
    if (outcome === 'ready') {
      for (const program of renderer.info?.programs || []) {
        try {
          program.getUniforms?.();
          result.linked++;
        } catch (error) {
          result.failed = true;
          console.warn('[vb] shader link check failed', error);
        }
      }
    }
  }
  result.programs = renderer.info?.programs?.length || 0;
  result.ms = Math.round(now() - started);
  return result;
}

function shaderReport(gl, shader, kind) {
  const log = (gl.getShaderInfoLog(shader) || '').trim();
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !log) return '';
  const line = Number(/ERROR: 0:(\d+)/.exec(log)?.[1]);
  if (!Number.isFinite(line)) return `${kind}\n\n${log}`;
  const lines = (gl.getShaderSource(shader) || '').split('\n');
  const context = [];
  for (let i = Math.max(line - 6, 0); i < Math.min(line + 6, lines.length); i++) {
    context.push(`${i + 1 === line ? '>' : ' '} ${i + 1}: ${lines[i]}`);
  }
  return `${kind}\n\n${log}\n\n${context.join('\n')}`;
}

/**
 * renderer.debug.onShaderError handler. `getPost` returns the live post chain,
 * `getRoots` the objects whose materials may use a failed program (the world
 * scene and the character roots).
 */
export class ShaderErrorMonitor {
  constructor({ renderer, getPost = () => null, getRoots = () => [] } = {}) {
    this.renderer = renderer;
    this.getPost = getPost;
    this.getRoots = getRoots;
    this.errors = [];      // 'name (type)' per failed program, for window.__vb.stats
    this.stripped = 0;     // materials that lost their patch
    this._seen = new Set();
  }

  /** Setting the callback turns off three's own report; handle() prints it instead. */
  install() {
    if (this.renderer?.debug) {
      this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => (
        this.handle(gl, program, vertexShader, fragmentShader));
    }
    return this;
  }

  /** Name, type and cache key of the three.js program that owns `glProgram`. */
  identify(gl, glProgram, vertexShader, fragmentShader) {
    const owner = (this.renderer?.info?.programs || []).find(p => p.program === glProgram);
    if (owner) return { name: owner.name || 'unnamed', type: owner.type || 'unknown', cacheKey: String(owner.cacheKey ?? '') };
    const source = gl.getShaderSource(fragmentShader) || gl.getShaderSource(vertexShader) || '';
    return {
      name: /#define SHADER_NAME (.*)/.exec(source)?.[1]?.trim() || 'unnamed',
      type: /#define SHADER_TYPE (.*)/.exec(source)?.[1]?.trim() || 'unknown',
      cacheKey: '',
    };
  }

  handle(gl, program, vertexShader, fragmentShader) {
    const { name, type, cacheKey } = this.identify(gl, program, vertexShader, fragmentShader);
    console.error(`THREE.WebGLProgram: Shader Error ${gl.getError()} - VALIDATE_STATUS `
      + `${gl.getProgramParameter(program, gl.VALIDATE_STATUS)}\n\nMaterial Name: ${name}\n`
      + `Material Type: ${type}\n\nProgram Info Log: ${(gl.getProgramInfoLog(program) || '').trim()}\n`
      + `${shaderReport(gl, vertexShader, 'VERTEX')}\n${shaderReport(gl, fragmentShader, 'FRAGMENT')}`);
    const label = `${name} (${type})`;
    const key = cacheKey || label;
    if (!this._seen.has(key)) {
      if (!this.errors.length) console.warn(`[vb] shader program failed: ${label} (window.__vb.stats.shaderErrors)`);
      this._seen.add(key);
      this.errors.push(label);
    }
    const post = this.getPost();
    if (name.startsWith('combat-') && post && !post.failed) {
      post.failed = true;
      post.enabled = false;
      post.fallbacks++;
      post.lastError = `shader compile failed: ${name}`;
    }
    // Stop patching new character materials when the patch itself is broken.
    if (cacheKey.includes(CHARACTER_LIGHT_KEY)) setCharacterLightEnabled(false);
    this.stripped += this.stripPatches(program);
  }

  /**
   * Materials whose current program is the failed one and that carry an
   * onBeforeCompile patch go back to their stock program on the next render.
   * Plain ShaderMaterials have nothing to fall back to and stay recorded only.
   */
  stripPatches(glProgram) {
    const properties = this.renderer?.properties;
    if (!properties?.has || !properties.get) return 0;
    const visited = new Set();
    let count = 0;
    const visit = (material) => {
      if (!material || visited.has(material)) return;
      visited.add(material);
      if (!Object.hasOwn(material, 'onBeforeCompile') || !properties.has(material)) return;
      if (properties.get(material).currentProgram?.program !== glProgram) return;
      delete material.onBeforeCompile;
      delete material.customProgramCacheKey;
      material.needsUpdate = true;
      count++;
    };
    for (const root of this.getRoots() || []) {
      root?.traverse?.((object) => {
        const material = object.material;
        if (Array.isArray(material)) for (let i = 0; i < material.length; i++) visit(material[i]);
        else visit(material);
      });
    }
    return count;
  }
}
