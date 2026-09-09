import { sfx } from '../audio/sfx.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../audio/samples.js';
import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';

const status = document.getElementById('status');
const volume = document.getElementById('volume');
const distance = document.getElementById('distance');
const charge = document.getElementById('charge');
const decoder = new OfflineAudioContext(1, 1, 48_000);
const timers = new Set();
const holding = new Set();
let loading;
let generation = 0;
let waveformCount = 0;
let waveformFailures = 0;
const featuredCueCount = 28;

for (const [control, suffix, factor] of [[volume, '%', 100], [distance, ' m', 1], [charge, '%', 100]]) {
  control.addEventListener('input', () => {
    document.getElementById(`${control.id}-value`).value = `${Math.round(Number(control.value) * factor)}${suffix}`;
    if (control === volume) {
      sfx.setMasterVolume(Number(volume.value));
      for (const audio of document.querySelectorAll('audio')) audio.volume = Number(volume.value);
    }
  });
}

async function ready() {
  // Unlock is invoked synchronously from the gesture before awaiting loading.
  if (!await sfx.unlock()) throw new Error('The browser could not start audio.');
  loading ||= sfx.loadSamples(BUILTIN_SAMPLE_MANIFEST);
  const result = await loading;
  if (result.failed) {
    loading = null;
    document.getElementById('availability').textContent =
      `${result.loaded} game samples loaded; ${result.failed} are unavailable. Missing cue controls stay disabled.`;
  }
  sfx.setMasterVolume(Number(volume.value));
  sfx.setListener({ pos: [0, 0, 0], fwd: [0, 0, -1] });
  for (const audio of document.querySelectorAll('audio')) audio.pause();
}

function later(callback, milliseconds) {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
  timers.add(timer);
}

function stopLoops() {
  generation++;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  holding.clear();
  for (const button of document.querySelectorAll('[aria-pressed]')) button.setAttribute('aria-pressed', 'false');
  sfx.stopFlame();
  sfx.minigunMotor(0, 0, false);
  sfx.stopPainMoans();
  for (const audio of document.querySelectorAll('audio')) audio.pause();
}

document.getElementById('stop-loops').addEventListener('click', () => {
  stopLoops(); status.textContent = 'Loops stopped.';
});
window.addEventListener('blur', stopLoops);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopLoops(); });

function button(label, action, secondary = false) {
  const element = document.createElement('button');
  element.textContent = label;
  if (secondary) element.className = 'secondary';
  element.addEventListener('click', async () => {
    element.disabled = true;
    const token = generation;
    try { await ready(); if (token === generation) action(); }
    catch (error) { if (token === generation) status.textContent = error.message; }
    finally { element.disabled = false; }
  });
  return element;
}

function flameTick(token) {
  if (token !== generation) return;
  sfx.fire('flamethrower');
  later(() => flameTick(token), 40);
}

function heldFlameButton() {
  const element = document.createElement('button');
  element.textContent = 'Hold flame'; element.setAttribute('aria-pressed', 'false');
  const start = async () => {
    if (holding.has(element)) return;
    stopLoops(); holding.add(element); element.setAttribute('aria-pressed', 'true');
    const token = generation;
    try {
      await ready();
      if (!holding.has(element) || token !== generation) return;
      flameTick(token); status.textContent = 'Flamethrower held. Release to hear the fade.';
    } catch (error) { stopLoops(); status.textContent = error.message; }
  };
  const stop = () => {
    if (!holding.has(element)) return;
    stopLoops(); status.textContent = 'Flamethrower released.';
  };
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); element.setPointerCapture(event.pointerId); void start();
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(event, stop);
  element.addEventListener('keydown', (event) => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault(); if (!event.repeat) void start();
  });
  element.addEventListener('keyup', (event) => {
    if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); stop(); }
  });
  element.addEventListener('blur', stop);
  return element;
}

function playWeapon(weapon, strength = 1) {
  sfx.fire(weapon, { charge: strength });
  status.textContent = `${WEAPONS[weapon].name}: game mix`;
}

function minigunCycle(fireSeconds = 0) {
  stopLoops();
  const token = generation;
  const fireAt = 0.7, coastAt = fireAt + (fireSeconds || 0.4), end = coastAt + 0.4;
  for (let frame = 0; frame <= Math.ceil(end * 20); frame++) {
    const at = frame / 20;
    later(() => {
      if (generation !== token) return;
      const spin = Math.min(1, at / fireAt, Math.max(0, (end - at) / 0.4));
      sfx.minigunMotor(spin, Math.min(0.95, Math.max(0, at - fireAt) / 4.2), true, false);
    }, at * 1000);
  }
  for (let i = 0; i < Math.round(fireSeconds * 20); i++) later(() => {
    if (generation === token) sfx.fire('minigun');
  }, (fireAt + i / 20) * 1000);
  later(() => {
    if (generation !== token) return;
    sfx.minigunMotor(0, 0, false);
    status.textContent = fireSeconds ? 'Minigun: 80 shots finished; rotor coast-down complete.' : 'Minigun: rotor coast-down complete.';
  }, end * 1000);
  status.textContent = fireSeconds
    ? 'Minigun: spin-up, four seconds at 1200 RPM, then coast-down'
    : 'Minigun: mechanical rotor spin-up and coast-down';
}

function card(container, title, description, slot, buttons) {
  const article = document.createElement('article');
  if (slot === 'weapons.minigun.fire') article.id = 'minigun';
  if (slot === 'weapons.knife.fire') article.id = 'pickaxe';
  const heading = document.createElement('h3'); heading.textContent = title;
  const paragraph = document.createElement('p'); paragraph.textContent = description;
  const actions = document.createElement('div'); actions.className = 'actions'; actions.append(...buttons);
  for (const control of buttons) control.disabled = true;
  article.append(heading, paragraph, actions);
  const url = BUILTIN_SAMPLE_MANIFEST[slot];
  const figure = document.createElement('figure');
  const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 95;
  canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${title}: shipped sample waveform`);
  const caption = document.createElement('figcaption'); caption.textContent = 'Reading sample waveform…';
  figure.append(canvas, caption); article.append(figure);
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
  audio.volume = Number(volume.value); audio.src = url;
  audio.setAttribute('aria-label', `${title}: isolated sample`);
  audio.addEventListener('play', () => {
    for (const other of document.querySelectorAll('audio')) if (other !== audio) other.pause();
    stopContinuous();
    status.textContent = `${title}: isolated sample`;
  });
  article.append(audio); container.append(article);
  void waveform(url, canvas, caption).then((available) => {
    if (available) for (const control of buttons) control.disabled = false;
  });
}

function stopContinuous() {
  generation++;
  for (const timer of timers) clearTimeout(timer);
  timers.clear(); holding.clear(); sfx.stopFlame(); sfx.minigunMotor(0, 0, false);
  sfx.stopPainMoans();
  for (const button of document.querySelectorAll('[aria-pressed]')) button.setAttribute('aria-pressed', 'false');
}

async function waveform(url, canvas, caption) {
  let available = false;
  try {
    if (!url) throw new Error('Sample slot is missing.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Sample unavailable (${response.status}).`);
    const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
    const data = buffer.getChannelData(0);
    const pen = canvas.getContext('2d');
    pen.strokeStyle = '#394650'; pen.beginPath(); pen.moveTo(0, 47.5); pen.lineTo(700, 47.5); pen.stroke();
    pen.fillStyle = '#ffa432';
    let peak = 0, sum = 0;
    for (let i = 0; i < data.length; i++) { peak = Math.max(peak, Math.abs(data[i])); sum += data[i] ** 2; }
    for (let x = 0; x < canvas.width; x++) {
      let low = 0, high = 0;
      for (let i = Math.floor(x * data.length / canvas.width); i < (x + 1) * data.length / canvas.width; i++) {
        low = Math.min(low, data[i] || 0); high = Math.max(high, data[i] || 0);
      }
      pen.fillRect(x, 47.5 - high * 44, 1, Math.max(0.6, (high - low) * 44));
    }
    const rms = Math.sqrt(sum / data.length);
    caption.textContent = `0 → ${buffer.duration.toFixed(3)} s · peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS · RMS ${(20 * Math.log10(rms)).toFixed(1)} dBFS · ${buffer.sampleRate / 1000} kHz`;
    waveformCount++;
    available = true;
  } catch (error) {
    caption.textContent = error.message; caption.className = 'error'; waveformFailures++;
  }
  document.documentElement.dataset.waveformCount = String(waveformCount);
  document.documentElement.dataset.waveformFailures = String(waveformFailures);
  if (waveformCount + waveformFailures <= featuredCueCount) {
    document.getElementById('availability').textContent =
      `${waveformCount} of ${featuredCueCount} featured samples available.${waveformFailures ? ` ${waveformFailures} are unavailable; their controls stay disabled.` : ''}`;
    if (waveformCount + waveformFailures === featuredCueCount && status.textContent.includes('waveforms are loading')) {
      status.textContent = 'Choose an available sound to hear its game mix.';
    }
  }
  return available;
}

const painPreview = document.getElementById('pain-moans');
for (const [level, label] of [[0.2, 'Mild pain'], [0.55, 'Moderate pain'], [1, 'Severe pain']]) {
  const article = document.createElement('article');
  const heading = document.createElement('h3'); heading.textContent = label;
  const description = document.createElement('p');
  description.textContent = `${Math.round(level * 100)}% pain, with three varied groans and natural pauses.`;
  article.append(heading, description, button(`${label}: 20 seconds`, () => {
    stopLoops();
    const token = generation, started = performance.now();
    const tick = () => {
      if (token !== generation) return;
      const now = performance.now();
      if (now - started >= 20000) {
        sfx.stopPainMoans(); status.textContent = `${label}: preview finished.`; return;
      }
      sfx.painMoan(level, now);
      later(tick, 50);
    };
    tick(); status.textContent = `${label}: 20 seconds at a steady pain level.`;
  }));
  painPreview.append(article);
}
for (const [tier, label] of [['light', 'Mild pain'], ['medium', 'Moderate pain'], ['heavy', 'Severe pain']]) {
  for (let variant = 1; variant <= 3; variant++) {
    card(painPreview, `${label}, variation ${variant}`, 'Isolated ElevenLabs vocal used by the game.',
      `human.pain.${tier}${variant === 1 ? '' : `.${variant}`}`, []);
  }
}

const hitFeedback = document.getElementById('hit-feedback');
for (const headshot of [false, true]) {
  const label = headshot ? 'Headshot' : 'Body';
  card(hitFeedback, `${label} hit`, headshot ? 'A compact, crisp physical head impact.' : 'A dry body impact with low-mid weight.',
    `ui.hitmark.${headshot ? 'head' : 'body'}`, [
      button(`${label} hit`, () => { sfx.hitmark(headshot); status.textContent = `${label} hit: game mix`; }),
      button(`${label} hit burst`, () => {
        stopLoops(); const token = generation;
        for (let i = 0; i < 20; i++) later(() => {
          if (generation !== token) return;
          sfx.fire('minigun'); sfx.hitmark(headshot);
          if (i === 19) sfx.killConfirm(headshot);
        }, i * 50);
        status.textContent = `${label}: 20 hits at 1200 RPM, with a final kill confirmation`;
      }, true),
    ]);
  card(hitFeedback, `${label} kill`, 'The game plays the hit tick and kill confirmation together.',
    `ui.kill.${headshot ? 'head' : 'body'}`, [
      button(`${label} kill`, () => {
        sfx.hitmark(headshot); sfx.killConfirm(headshot);
        status.textContent = `${label} kill: hit and kill cues together`;
      }),
    ]);
}
card(hitFeedback, 'Incoming body impact', 'A muted physical impact, scaled by received damage.', 'impact.flesh', [
  button('Incoming impact', () => {
    sfx.impact('flesh', 0.45); status.textContent = 'Incoming body impact: maximum game impact gain';
  }),
]);

const explosions = document.getElementById('explosions');
for (const [type, title, description] of [
  ['frag', 'Frag grenade', 'Sharp blast with a short debris tail.'],
  ['limpet', 'Limpet charge', 'A heavier blast for the attached charge.'],
  ['pulse', 'Pulse grenade', 'Electric discharge and pressure wave.'],
  ['rocket', 'Rocket impact', 'A dedicated blast for the rocket launcher.'],
]) {
  card(explosions, title, description, `grenades.${type}.explosion`, [
    button('Detonate', () => {
      const meters = Number(distance.value); sfx.explosion([0, 0, -meters], type);
      status.textContent = `${title}: game mix at ${meters} m`;
    }),
    button('Blast + debris', () => {
      const meters = Number(distance.value); sfx.explosion([0, 0, -meters], type);
      for (let i = 0; i < 32; i++) sfx.impact('stone', 0.1, { pos: [i % 3 - 1, 0, -meters] });
      status.textContent = `${title}: blast plus 32 terrain impacts at ${meters} m`;
    }, true),
  ]);
}

const newCues = document.getElementById('new-cues');
card(newCues, 'Grenade pin', 'The pin pull at the start of a held throw.', 'combat.grenadePin', [
  button('Pull pin', () => { sfx.grenadePin(); status.textContent = 'Grenade pin: game mix'; }),
]);
card(newCues, 'Grenade throw', 'A short arm swing. The strength control changes its gain.', 'combat.grenadeThrow', [
  button('Throw', () => { sfx.grenadeThrow(Number(charge.value)); status.textContent = `Grenade throw: ${Math.round(Number(charge.value) * 100)}% strength`; }),
]);
function pickaxeStrike(broken = false) {
  sfx.fire('knife');
  sfx.mine(3, broken, [0, 0, -Number(distance.value)]);
  status.textContent = broken ? 'Pickaxe: stone contact and loose fragments' : 'Pickaxe: swing and stone contact';
}
card(newCues, WEAPONS.knife.name, 'A weighty air swing. Stone contact and fragments follow accepted mining hits.', 'weapons.knife.fire', [
  button('Swing', () => playWeapon('knife')),
  button('Stone strike', () => pickaxeStrike()),
  button('Break stone', () => pickaxeStrike(true)),
  button('Four-second mining', () => {
    stopLoops(); const token = generation;
    for (let i = 0; i < 8; i++) later(() => {
      if (generation === token) pickaxeStrike(i === 5);
    }, i * 500);
    later(() => {
      if (generation === token) status.textContent = 'Pickaxe: eight swings at 120 RPM; stone broke on the sixth hit.';
    }, 4000);
    status.textContent = 'Pickaxe: four seconds of mining at game cadence';
  }, true),
]);
card(newCues, 'Pickaxe swing, variation 2', 'Alternate air movement used during repeated swings.', 'weapons.knife.fire.2', []);
for (let variant = 1; variant <= 2; variant++) card(newCues, `Pickaxe stone contact, variation ${variant}`,
  'Dry steel contact and stone grit. The game uses one recording per accepted hit.',
  variant === 1 ? 'pickaxe.impact' : 'pickaxe.impact.2', []);
card(newCues, WEAPONS.minigun.name, 'Three dry, weighty discharge variations, with a low mechanical rotor texture.', 'weapons.minigun.fire', [
  button('One shot', () => playWeapon('minigun')),
  button('Rotor only', () => minigunCycle(), true),
  button('Four-second minigun', () => minigunCycle(4), true),
  button('20-shot burst', () => {
    stopLoops(); const token = generation;
    for (let i = 0; i < 20; i++) later(() => {
      if (generation !== token) return;
      sfx.fire('minigun'); sfx.minigunMotor(1, i / 24, true, false);
    }, i * 50);
    later(() => sfx.minigunMotor(0, 0, false), 1000);
    status.textContent = 'Minigun: 20 shots at 1200 RPM with rotor feedback';
  }, true),
]);
for (let variant = 2; variant <= 3; variant++) card(newCues,
  `${WEAPONS.minigun.name}, variation ${variant}`, 'Alternate discharge used automatically during sustained fire.',
  `weapons.minigun.fire.${variant}`, []);
card(newCues, WEAPONS.flamethrower.name, 'One sustained recording with the game’s release fade.', 'weapons.flamethrower.loop', [
  heldFlameButton(), button('Two-second flame', () => {
    stopLoops(); const token = generation; flameTick(token);
    later(() => { if (generation === token) { stopLoops(); status.textContent = 'Flamethrower released after two seconds.'; } }, 2000);
    status.textContent = 'Flamethrower: two-second hold';
  }, true),
]);

let existingBuilt = false;
document.getElementById('existing').addEventListener('toggle', (event) => {
  if (!event.target.open || existingBuilt) return;
  existingBuilt = true;
  const container = document.getElementById('existing-weapons');
  for (const weapon of WEAPON_IDS.filter((id) => !['knife', 'minigun', 'flamethrower'].includes(id))) {
    const charged = ['longarc', 'lance'].includes(weapon);
    card(container, WEAPONS[weapon].name, charged ? 'Compare low, half and full charge.' : 'Existing weapon sample and game mix.',
      `weapons.${weapon}.fire`, charged
        ? [button('Low', () => playWeapon(weapon, 0)), button('Half', () => playWeapon(weapon, 0.5)), button('Full', () => playWeapon(weapon, 1))]
        : [button('Fire', () => playWeapon(weapon))]);
  }
});
