import { musicVolume } from '../audio/music-volume.js';

let nextId = 0;

function syncControl(root) {
  const slider = root.querySelector('[data-music-volume]');
  const output = root.querySelector('output');
  if (!slider || !output) return;
  const value = musicVolume.value;
  const label = value === 0 ? 'MUTED' : `${Math.round(value)}%`;
  slider.value = String(value);
  slider.setAttribute('aria-valuetext', value === 0 ? 'Muted' : `${Math.round(value)} percent`);
  root.style.setProperty('--music-level', `${value}%`);
  root.dataset.muted = String(value === 0);
  output.value = label;
  output.textContent = label;
}

// Query current controls instead of retaining subscriptions to removed menus.
musicVolume.subscribe(() => {
  if (typeof document === 'undefined') return;
  for (const root of document.querySelectorAll('.vb-music-control')) syncControl(root);
});

/** Mount inside each menu/dialog so native modal top layers remain operable. */
export function mountMusicControl(host) {
  if (!host) return null;
  const existing = host.querySelector('.vb-music-control');
  if (existing) { syncControl(existing); return existing; }
  const root = document.createElement('div');
  root.className = 'vb-music-control';
  const label = document.createElement('label');
  const id = `music-volume-${++nextId}`;
  label.htmlFor = id;
  label.textContent = 'MUSIC';
  const output = document.createElement('output');
  output.htmlFor = id;
  const slider = document.createElement('input');
  slider.id = id;
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.dataset.musicVolume = '';
  slider.setAttribute('aria-label', 'Music volume');
  slider.addEventListener('input', () => musicVolume.set(slider.value, { gesture: true }));
  // Keep range navigation local rather than activating a bound gameplay action.
  slider.addEventListener('keydown', event => {
    if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation();
  });
  root.append(label, output, slider);
  host.append(root);
  syncControl(root);
  return root;
}
