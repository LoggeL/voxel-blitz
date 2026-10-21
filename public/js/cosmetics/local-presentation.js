// Local-only career presentation: the HUD accent (theme) and crosshair shape
// (reticle) live on the document root. The menu applies careerView.equipped;
// a live match applies the authoritative self snapshot row's reticle.
import { treeNode } from '../../../shared/career.js';

export const DEFAULT_ACCENT = treeNode('amber')?.color || '#ffb347';

const docRoot = () => globalThis.document?.documentElement ?? null;

/** Set `--career-accent` from a theme id; unknown or non-theme ids fall back to amber. */
export function applyTheme(themeId) {
  const item = treeNode(themeId);
  const color = item?.kind === 'theme' && item.color ? item.color : DEFAULT_ACCENT;
  const root = docRoot();
  if (root && root.style.getPropertyValue('--career-accent') !== color) root.style.setProperty('--career-accent', color);
  return color;
}

/** Set `:root[data-reticle]` from a reticle id; 'standard' and unknown ids remove it. */
export function applyReticle(reticleId) {
  const item = treeNode(reticleId);
  const shape = item?.kind === 'reticle' && item.reticle ? item.reticle : null;
  const root = docRoot();
  if (root) {
    if (shape) { if (root.dataset.reticle !== shape) root.dataset.reticle = shape; }
    else delete root.dataset.reticle;
  }
  return shape;
}

export function applyLocalPresentation(equipped) {
  return { accent: applyTheme(equipped?.theme), reticle: applyReticle(equipped?.reticle) };
}

/** Back to the stylesheet defaults: amber accent, standard crosshair. */
export function resetLocalPresentation() {
  const root = docRoot();
  if (!root) return;
  root.style.removeProperty('--career-accent');
  delete root.dataset.reticle;
}
