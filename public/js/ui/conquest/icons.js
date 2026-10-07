/**
 * Vector glyphs for the Conquest UI (kill feed, minimap, deploy screen and
 * vehicle panel). 24x24 view boxes, filled with currentColor, so every icon
 * takes the team-relative colour of its container. No external assets.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export const ICON_PATHS = Object.freeze({
  // Mounted weapons.
  shell: 'M2 10.5h11l3-2h4.5a1.5 1.5 0 0 1 0 3V12.5a1.5 1.5 0 0 1 0 3H16l-3-2H2zM5 9h2v6H5z',
  mg: 'M2 11h14v2H2zM16 9.5h3l3 1.5-3 1.5h-3zM4 13h3l-1 4H4zM9 13h2v2H9zM3 8h5v3H3z',
  rocket: 'M3 11h11l4-2.5h1.5L22 12l-2.5 3.5H18L14 13H3zM3 9l3 2H3zM3 15l3-2H3z',
  missile: 'M2 11.2h14l3.5-1.2L22 12l-2.5 2-3.5-1.2H2zM5 8.5l3 2.7H5zM5 15.5l3-2.7H5zM13 9.5l2 1.7h-2zM13 14.5l2-1.7h-2z',
  autocannon: 'M2 10h9v4H2zM11 11h9v2h-9zM20 10.3h2v3.4h-2zM4 14h3v3H4z',
  roadkill: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 3.2a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6zm0 3.3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  restricted: 'M3 9h18v6H3zM6 9l-3 6h3l3-6zM12 9l-3 6h3l3-6zM18 9l-3 6h3l3-6zM5 15h2v5H5zM17 15h2v5h-2z',
  // Hulls (side profiles, facing right).
  jeep: 'M3 11l2-4h8l2 4h5a1 1 0 0 1 1 1v3h-2.2a2.5 2.5 0 0 0-4.6 0H9.8a2.5 2.5 0 0 0-4.6 0H3zM7 8.2L5.9 11H9V8.2zM10.5 8.2V11h3l-1.2-2.8zM7.5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM16.5 14.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  tank: 'M7 8h7l1 2h7v1.6h-7.2L14 13H6zM2 13h19l-2 4.5H4zM5 14.6a1 1 0 1 0 0 .1zM8.5 14.5h1v1h-1zM12 14.5h1v1h-1zM15.5 14.5h1v1h-1z',
  helicopter: 'M2 5h20v1.4H2zM11.3 6.4h1.4v2H11.3zM6 9h10a4 4 0 0 1 0 8H9l-2-2H4l-2-3h4zM17 10.5h2.2a2.6 2.6 0 0 1 0 3.5H17zM8 17.5h9v1.3H8z',
  transport: 'M1 5h11v1.3H1zM12 5h11v1.3H12zM5.5 6.3h1.2v2H5.5zM17.3 6.3h1.2v2h-1.2zM3 8.5h16l3 3.5v3.5H5L2 12zM6 10h2.5v2H6zM10 10h2.5v2H10zM5 15.5h14v1.4H5z',
  plane: 'M2 11.2l4-.2 3-5h2.2l-1.4 5H17l2.5-3H21l-1 3.4L22 12l-2 .6 1 3.4h-1.5L17 13H9.8l1.4 5H9l-3-5-4-.2z',
  // Kits.
  assault: 'M10.5 3h3v5h5v3h-5v10h-3V11h-5V8h5z',
  engineer: 'M14.5 3a4.5 4.5 0 0 0-4.3 5.9L3 16.1 5.9 19l7.2-7.2A4.5 4.5 0 0 0 19 6.5l-2.7 2.7-2.4-.6-.6-2.4L16 3.5a4.5 4.5 0 0 0-1.5-.5z',
  support: 'M4 7h16v12H4zM8 4h8v3h-2V6h-4v1H8zM11 9.5h2V12h2.5v2H13v2.5h-2V14H8.5v-2H11z',
  recon: 'M12 5C6.5 5 3 12 3 12s3.5 7 9 7 9-7 9-7-3.5-7-9-7zm0 2.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4zm0 2.2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  // Markers.
  hq: 'M4 20V9l8-5 8 5v11h-5v-6H9v6z',
  squad: 'M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6L12 16.2 6.6 19.3l1.3-6-4.6-4.1 6.1-.6z',
  revive: 'M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z',
  repair: 'M14.5 3a4.5 4.5 0 0 0-4.3 5.9L3 16.1 5.9 19l7.2-7.2A4.5 4.5 0 0 0 19 6.5l-2.7 2.7-2.4-.6-.6-2.4L16 3.5a4.5 4.5 0 0 0-1.5-.5z',
  lock: 'M12 2l2.5 5H20l-4.3 3.7L17.5 17 12 13.5 6.5 17l1.8-6.3L4 7h5.5z',
  flares: 'M12 2c2 4 5 6 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.8 1.2 2.8 2.2 3.2C10.8 8 11 5 12 2z',
  smoke: 'M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.5a4.75 4.75 0 0 1 .5 9.5z',
});

/** Kill-feed glyph per kill key; unknown keys return null (caller decides). */
export const KILL_KEY_ICONS = Object.freeze({
  tankAP: 'shell', tankHE: 'shell', coaxMG: 'mg', hmg: 'mg', doorMinigun: 'mg', planeCannon: 'autocannon',
  chinCannon: 'autocannon', helicopterRocket: 'rocket', aaMissile: 'missile', vehicle: 'roadkill', restricted: 'restricted',
});

/** A fresh inline SVG element for one glyph (DOM only). */
export function svgIcon(documentRef, name, className = 'vb-cq-icon') {
  const d = ICON_PATHS[name];
  if (!d || !documentRef?.createElementNS) return null;
  const svg = documentRef.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = documentRef.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

const pathCache = new Map();
/** Canvas Path2D for a glyph (browser only); cached per name. */
export function iconPath2D(name) {
  if (typeof Path2D !== 'function' || !ICON_PATHS[name]) return null;
  let path = pathCache.get(name);
  if (!path) { path = new Path2D(ICON_PATHS[name]); pathCache.set(name, path); }
  return path;
}

/** Draw a glyph centred at (x, y) with the given pixel size on a 2D context. */
export function drawIcon(context, name, x, y, size, fill) {
  const path = iconPath2D(name);
  if (!path || !context) return false;
  context.save();
  context.translate(x - size / 2, y - size / 2);
  context.scale(size / 24, size / 24);
  context.fillStyle = fill;
  context.fill(path);
  context.restore();
  return true;
}
