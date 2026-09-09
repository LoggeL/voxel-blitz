/** Small, decorative UI glyphs. Labels remain real selectable text. */
const paths = {
  globe: '<circle cx="24" cy="24" r="19"/><ellipse cx="24" cy="24" rx="8" ry="19"/><path d="M5 24h38M9 13h30M9 35h30"/>',
  squad: '<circle cx="24" cy="14" r="7"/><circle cx="9" cy="18" r="5"/><circle cx="39" cy="18" r="5"/><path d="M12 43V32c0-12 24-12 24 0v11ZM3 39V29c0-5 4-7 8-6M45 39V29c0-5-4-7-8-6"/>',
  duel: '<path d="m8 5 8 3 23 27-5 5L9 13ZM4 34l10 10M8 40l7-7M40 5l-8 3-9 11M39 13l-9 10M44 34 34 44M40 40l-7-7"/>',
  arrows: '<path d="m8 12 10 12L8 36m17-24 10 12-10 12"/>',
};
export function addMenuIcon(parent, kind) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 48 48');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('class', 'vb-action-icon');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2.5');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.innerHTML = paths[kind];
  parent.appendChild(icon);
}
