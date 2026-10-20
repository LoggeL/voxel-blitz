// Pit escape for surface-navigation bots (Frontier).
//
// The 2.5D surface graph keeps at most one layer per 4-voxel cell and checks
// each edge along the line between cell centres, so a body in a trench two or
// three voxels wide (Ridge Bunkers) or a fresh shell crater walks a route whose
// next node sits on the rim above its head, along a line that meets a wall
// higher than a vault: it presses into that wall until the trap watchdog
// redeploys it (and never, while the pit lies inside a capture zone). When the
// stuck watchdog fires and the route's next point (or its start node) stands
// UNSTICK_RULES.pitDepth or more above the feet, pitEscape floods the voxel
// floor the body stands on (the player physics' rules: one-voxel steps, short
// drops) for the nearest spot from which the ordinary vault (findVault, 2.05 m
// reach) lands at least that high on surface the graph knows. The bot walks
// there and vaults out (BotManager.followEscape).

import { findVault } from '../shared/player-movement.js';

export const UNSTICK_RULES = Object.freeze({
  /** m: the route's start node this far above the feet marks a pit under the graph. */
  pitDepth: 1.5,
  /** Flood limits: voxel cells and flat radius (m) searched for a vault spot. */
  escapeCells: 400,
  escapeRadius: 12,
  /** ms an escape is followed before the watchdog may plan another. */
  escapeMs: 6000,
  /** m: the stand spot counts as reached this close (flat). */
  escapeArrive: 0.4,
  /** m: a path cell a voxel above the feet is hopped onto from this close (flat). */
  hopReach: 1.6,
});

const DIRS8 = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]);

/** Feet height of a standable voxel cell near feet height `y` (step up `up`, drop 3), or NaN. */
function feetAt(solidAt, x, z, y, up = 1) {
  for (let fy = y + up; fy >= y - 3; fy--) {
    if (solidAt(x, fy - 1, z) && !solidAt(x, fy, z) && !solidAt(x, fy + 1, z)) return fy;
  }
  return NaN;
}

/**
 * A way out of a pit the surface graph does not cover, or null (`next`: the
 * route's next point, when the body follows one):
 * {stand, path, yaw, to} (walk the cell centres of `path` to `stand`, face `yaw`, vault to `to`).
 */
export function pitEscape(nav, solidAt, p, next = null) {
  const r = UNSTICK_RULES;
  if (!nav || !Number.isFinite(p?.y)) return null;
  const start = nav.startNode(p);
  if (start < 0) return null;
  const rimY = Math.max(nav.height[start], Number.isFinite(next?.y) ? next.y : -Infinity);
  if (rimY - p.y < r.pitDepth) return null;
  const component = nav.component[start];
  const x0 = Math.floor(p.x), z0 = Math.floor(p.z), y0 = Math.floor(p.y + 0.05);
  const feet0 = feetAt(solidAt, x0, z0, y0, 0);
  if (!Number.isFinite(feet0)) return null;
  const seen = new Map([[`${x0},${z0}`, feet0]]);
  const queue = [[x0, z0, feet0, -1]];
  for (let head = 0; head < queue.length && head < r.escapeCells; head++) {
    const [x, z, fy] = queue[head];
    const from = { x: x + 0.5, y: fy, z: z + 0.5 };
    for (const [dx, dz] of DIRS8) {
      const vault = findVault(solidAt, from, { x: dx, z: dz }, fy, null, 1);
      if (!vault || vault.to.y < fy + 1.5 || vault.to.y < rimY - 1.2) continue;
      // The landing must be ground the graph routes from, in the start's region.
      const node = nav.nodeAt(vault.to, 1);
      if (node < 0 || Math.abs(nav.height[node] - vault.to.y) > 1.2 || nav.component[node] !== component) continue;
      // Cell centres from the body to the stand spot (the flood's own path).
      const path = [];
      for (let i = head; i > 0; i = queue[i][3]) path.unshift({ x: queue[i][0] + 0.5, y: queue[i][2], z: queue[i][1] + 0.5 });
      return { stand: from, path: path.length ? path : [from], yaw: Math.atan2(-dx, -dz), to: vault.to };
    }
    for (const [dx, dz] of DIRS8.slice(0, 4)) {
      const nx = x + dx, nz = z + dz, key = `${nx},${nz}`;
      if (seen.has(key) || Math.hypot(nx - x0, nz - z0) > r.escapeRadius) continue;
      const nf = feetAt(solidAt, nx, nz, fy);
      seen.set(key, nf);
      // Floor that steps up by more than one voxel is the rim, found by the vault check above.
      if (!Number.isFinite(nf) || nf > fy + 1) continue;
      queue.push([nx, nz, nf, head]);
    }
  }
  return null;
}
