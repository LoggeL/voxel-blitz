// Titanfall client registry (docs/titanfall.md §8.1, WP0, frozen). main.js loads
// it only for titanfall matches (match-runtime.js loadTitanfallClient) and calls
// `create(app)`; the returned client is the only titanfall object main.js knows.
//
// Every registered module exports the client-module contract
//   init?(app, client)   once, right after create (app = the main.js game object)
//   tick(snapshot, dt)   per consumed authoritative snapshot (dt: server seconds since the last one)
//   frame(dt, ctx)       per rendered frame, ctx = { camera, nowMs }
//   onEvent(event)       per gameplay event (main.js onGameplayEvent)
//   dispose()            leave the match: drop DOM, listeners, meshes, timers and module state
// and keeps its per-match state at module level, cleared by dispose(). The
// registry fans every call out in this order, isolating one module's error from
// the others. It also injects public/styles/titanfall.css on create and removes
// it on dispose, so public/index.html is never edited.
import { decodeTitanfallPlayer, decodeTitanfallSelf } from '../../../shared/titan-contract.js';
import * as pilotClient from './pilot-client.js';
import * as titanPredict from './titan-predict.js';
import * as titanTransit from './titan-transit.js';
import * as titanCockpitFx from './titan-cockpit-fx.js';
import * as titanPresentation from './titan-presentation.js';
import * as titanUi from './titan-ui.js';
import * as pilotProjectileViews from './pilot-projectile-views.js';
import * as titanProjectileViews from './titan-projectile-views.js';
import * as npcView from './npc-view.js';

/** Registered modules, fan-out order. */
export const TITANFALL_CLIENT_MODULES = Object.freeze([
  Object.freeze(['pilot', pilotClient]),                    // WP1
  Object.freeze(['predict', titanPredict]),                 // WP2
  // Embark/disembark camera moves: after the seat/pilot camera, before anything projects with it.
  Object.freeze(['transit', titanTransit]),
  Object.freeze(['cockpitFx', titanCockpitFx]),             // own-titan hit log for the cockpit damage
  Object.freeze(['presentation', titanPresentation]),       // WP5
  Object.freeze(['ui', titanUi]),                           // WP6
  Object.freeze(['pilotProjectiles', pilotProjectileViews]),// WP4
  Object.freeze(['titanProjectiles', titanProjectileViews]),// WP5
  Object.freeze(['npcs', npcView]),                         // WP8
]);
export const TITANFALL_CLIENT_HOOKS = Object.freeze(['tick', 'frame', 'onEvent', 'dispose']);
export const TITANFALL_CSS_ID = 'titanfall-styles';
export const TITANFALL_CSS_HREF = new URL('../../styles/titanfall.css', import.meta.url).href;

function injectStyles() {
  if (typeof document === 'undefined' || !document.head) return null;
  const existing = document.getElementById(TITANFALL_CSS_ID);
  if (existing) return existing;
  const link = document.createElement('link');
  link.id = TITANFALL_CSS_ID;
  link.rel = 'stylesheet';
  link.href = TITANFALL_CSS_HREF;
  document.head.appendChild(link);
  return link;
}

/**
 * The per-match titanfall client. Besides the fan-out it holds the newest
 * authoritative self state (player row, decoded `tf`, `tfs` frame) for its modules.
 */
export function create(app) {
  let disposed = false;
  let selfFrame = null, selfTf = null, selfRow = null, snapshot = null;
  const report = (name, hook, error) => {
    if (typeof app?.phaseError === 'function') app.phaseError(`titanfall:${name}.${hook}`, error);
    else if (typeof console !== 'undefined') console.error(error);
  };
  const fan = (hook, ...args) => {
    for (const [name, mod] of TITANFALL_CLIENT_MODULES) {
      if (typeof mod[hook] !== 'function') continue;
      try { mod[hook](...args); } catch (error) { report(name, hook, error); }
    }
  };
  const onSelf = frame => { selfFrame = frame; };
  const unsubscribe = typeof app?.net?.on === 'function' ? app.net.on('tfs', onSelf) : null;
  if (app?.net?.latestTitanfallSelf) selfFrame = app.net.latestTitanfallSelf;
  const styles = injectStyles();

  const client = Object.freeze({
    app,
    /** Newest raw `{t:'tfs', s, d}` frame, or null. */
    selfFrameRaw: () => selfFrame,
    /** Newest decoded `tfs` frame (decodeTitanfallSelf), or null. */
    selfFrame: () => decodeTitanfallSelf(selfFrame),
    /** The local player's newest row and its decoded `tf`. */
    selfRow: () => selfRow,
    selfTf: () => selfTf,
    snapshot: () => snapshot,
    /** AT lock progress 0..1 from tfs[11] (main.js lockReady feed). */
    lockProgress: () => (Array.isArray(selfFrame?.d) ? (selfFrame.d[11] | 0) / 100 : 0),
    /** Seated-send input bits (§3.6), ORed over the modules that export titanHold(). */
    titanHold() {
      let bits = 0;
      for (const [name, mod] of TITANFALL_CLIENT_MODULES) {
        if (typeof mod.titanHold !== 'function') continue;
        try { bits |= mod.titanHold() | 0; } catch (error) { report(name, 'titanHold', error); }
      }
      return bits & 63;
    },
    /** AvatarRoster hook (§4.2): pose and shade one remote pilot avatar. */
    avatarState(row, avatar, dt) {
      let posed = null;
      try { posed = pilotClient.avatarState?.(row, avatar, dt) ?? null; } catch (error) { report('pilot', 'avatarState', error); }
      // A pilot that just left a titan vaults out of its hatch (titan-transit.js).
      try { titanTransit.avatarState(row, avatar); } catch (error) { report('transit', 'avatarState', error); }
      return posed;
    },
    tick(next, dt = 0) {
      if (disposed || !next) return;
      snapshot = next;
      const id = app?.myId;
      selfRow = Array.isArray(next.players) ? next.players.find(row => row?.id === id) || null : null;
      selfTf = decodeTitanfallPlayer(selfRow);
      fan('tick', next, dt);
    },
    frame(dt, ctx = {}) { if (!disposed) fan('frame', dt, ctx); },
    onEvent(event) { if (!disposed && event) fan('onEvent', event); },
    dispose() {
      if (disposed) return;
      disposed = true;
      fan('dispose');
      unsubscribe?.();
      app?.roster?.setPresentation?.(null);
      styles?.remove?.();
      selfFrame = selfTf = selfRow = snapshot = null;
      // Leave titanfall: no titan hull may still be drawn when its cached geometry goes, then the
      // stock views drop the titanfall hooks and the page-lifetime GPU caches are freed.
      const view = app?.vehicleView;
      for (const [id, item] of view?.items ?? []) if (item?.walker) { try { view.remove(id); } catch (error) { report('presentation', 'remove', error); } }
      titanPresentation.uninstall();
      try { titanPresentation.releaseCaches(); } catch (error) { report('presentation', 'releaseCaches', error); }
    },
    /** Load-time preparation the shader warm-up depends on (portrait programs, ...): awaited before warmShaders. */
    async prepare() {
      const jobs = [];
      for (const [name, mod] of TITANFALL_CLIENT_MODULES) {
        if (typeof mod.prepare !== 'function') continue;
        jobs.push(Promise.resolve().then(() => mod.prepare(app, client)).catch(error => report(name, 'prepare', error)));
      }
      await Promise.all(jobs);
    },
  });

  titanPresentation.install();
  app?.roster?.setPresentation?.(client);
  for (const [name, mod] of TITANFALL_CLIENT_MODULES) {
    if (typeof mod.init !== 'function') continue;
    try { mod.init(app, client); } catch (error) { report(name, 'init', error); }
  }
  return client;
}
