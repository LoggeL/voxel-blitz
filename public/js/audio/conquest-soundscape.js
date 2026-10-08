/**
 * Conquest ambient soundscape (presentation only). Conquest had no ambient
 * audio; this adds, on its own ambience bus into the shared master:
 *
 *  - a far-off battle bed (two streamed stereo loops crossfaded by match
 *    activity: contested flags plus recent kills and blasts),
 *  - valley wind (bed + gusty layer by the weather preset's wind, a ridge
 *    whistle with height) and occasional gust swells,
 *  - positional zones: the river along FRONTIER_PLAN.river (rapids at the
 *    fords and bridges), songbirds at Kestrel Farm (A) and St. Aldric (B) that
 *    fall silent near combat and scatter after a close blast, crows, the
 *    St. Aldric church bell (three tolls at match start and end), the Kessler
 *    Works drone with steam and clanks (E), and fire crackle at the nearest
 *    burnt-out wreck prop,
 *  - off-map artillery booms for ConquestAmbience's salvo flashes, delayed by
 *    distance / 343 m/s, and sparse radio chatter near the own HQ or aboard a
 *    vehicle.
 *
 * Long beds play through two crossfading media elements from a fetched Blob (never decoded to PCM); one-shots
 * use the decoded Conquest bank (sfx.conquestAudio()). Zones are mixed with a
 * distance gain and a stereo pan instead of HRTF voices, so the ambience never
 * takes one of the 24 positional voices from gunfire. Without a running
 * context, a media element or the bank, the soundscape stays silent.
 */
import { CONQUEST_STREAMS } from './conquest-bank.js';
import { FRONTIER_PLAN } from '../../../shared/conquest-contract.js';

/** Wind factor per weather preset (same values as ConquestAmbience's WEATHER looks). */
const WEATHER_WIND = Object.freeze({ golden: 1.6, mist: 0.8, overcast: 2.2 });
const site = id => FRONTIER_PLAN.flags.find(flag => flag.id === id);

export const SOUNDSCAPE = Object.freeze({
  level: 0.85, fadeIn: 3, smoothing: 0.6, pauseAfter: 4,
  battle: Object.freeze({ low: 0.5, high: 0.55, base: 0.2, flagWeight: 0.5, decayPerSecond: 0.05,
    events: Object.freeze({ kill: 0.08, vehicle_destroyed: 0.2, projectileExplode: 0.03, flag_captured: 0.15, flag_neutralized: 0.1 }) }),
  wind: Object.freeze({ bed: 0.28, bedPerWind: 0.12, gusty: 0.4, ridgeFrom: 38, ridgeTo: 62, ridge: 0.42, aircraftFrom: 70,
    gustEvery: Object.freeze([14, 36]), gust: 0.45 }),
  river: Object.freeze({ range: 70, level: 0.55, rapidsRange: 45, rapids: 0.6 }),
  birds: Object.freeze({ range: 100, level: 0.55, combatRadius: 90, recover: 25, scatterRadius: 70,
    crowEvery: Object.freeze([16, 42]), crowRange: 150, crow: 0.5 }),
  bell: Object.freeze({ every: Object.freeze([80, 190]), range: 520, level: 0.55, tolls: 3, tollSpacing: 4.6, startWindow: 20 }),
  industrial: Object.freeze({ range: 120, level: 0.6, every: Object.freeze([8, 22]), oneShot: 0.55 }),
  wreck: Object.freeze({ range: 35, level: 0.45 }),
  artillery: Object.freeze({ level: 0.75, range: 900, floor: 0.15, max: 4 }),
  radio: Object.freeze({ every: Object.freeze([14, 34]), hqRange: 80, level: 0.32 }),
  maxOneShots: 10,
});

const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const falloff = (distance, range, power = 1.5) => Math.pow(clamp01(1 - distance / range), power);

/** Nearest point on a polyline of [x, z] points: { distance, x, z }. */
export function nearestOnPolyline(x, z, points) {
  let best = { distance: Infinity, x, z };
  for (let i = 1; i < (points?.length || 0); i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const dx = bx - ax, dz = bz - az, len = dx * dx + dz * dz;
    const t = len > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / len) : 0;
    const px = ax + dx * t, pz = az + dz * t, distance = Math.hypot(x - px, z - pz);
    if (distance < best.distance) best = { distance, x: px, z: pz };
  }
  return best;
}

/**
 * Pure: target gain and pan of every streamed bed for a listener state.
 * `state` = { pos:[x,y,z], fwd:[x,y,z], wind, intensity, calm:{A,B}, wrecks:[{x,y,z}] }.
 */
export function soundscapeTargets(state) {
  const S = SOUNDSCAPE;
  const pos = state.pos;
  const fwd = state.fwd || [0, 0, -1];
  const rx = -fwd[2], rz = fwd[0], rl = Math.hypot(rx, rz) || 1;
  const panTo = (x, z) => {
    const dx = x - pos[0], dz = z - pos[2], d = Math.hypot(dx, dz);
    return d < 1 ? 0 : Math.max(-0.85, Math.min(0.85, ((dx * rx + dz * rz) / rl / d) * 0.85));
  };
  const wind = clamp01((state.wind ?? 1.6) / 2.2);
  const height = pos[1];
  const ridge = clamp01((height - S.wind.ridgeFrom) / (S.wind.ridgeTo - S.wind.ridgeFrom));
  const aloft = clamp01((height - S.wind.aircraftFrom) / 60);
  const intensity = clamp01(state.intensity);
  const targets = {
    battleLow: { gain: S.battle.low * (1 - 0.45 * intensity), pan: 0 },
    battleHigh: { gain: S.battle.high * intensity, pan: 0 },
    windBed: { gain: (S.wind.bed + S.wind.bedPerWind * wind) * (1 + 0.5 * aloft), pan: 0 },
    windGusty: { gain: S.wind.gusty * wind * (0.6 + 0.4 * Math.max(ridge, aloft)), pan: 0 },
    windRidge: { gain: S.wind.ridge * Math.max(ridge, aloft * 0.8) * (0.5 + 0.5 * wind), pan: 0 },
  };
  const river = FRONTIER_PLAN.river;
  const bank = nearestOnPolyline(pos[0], pos[2], river.points);
  const fromWater = Math.max(0, bank.distance - river.width / 2);
  targets.river = { gain: S.river.level * falloff(fromWater, S.river.range, 2), pan: panTo(bank.x, bank.z) };
  let rapids = { gain: 0, pan: 0 };
  for (const crossing of FRONTIER_PLAN.crossings) {
    const d = Math.hypot(pos[0] - crossing.x, pos[2] - crossing.z);
    const gain = S.river.rapids * falloff(d, S.river.rapidsRange, 2) * (crossing.kind === 'ford' ? 1 : 0.6);
    if (gain > rapids.gain) rapids = { gain, pan: panTo(crossing.x, crossing.z) };
  }
  targets.rapids = rapids;
  for (const [key, id] of [['birdsFarm', 'A'], ['birdsVillage', 'B']]) {
    const flag = site(id);
    const d = Math.hypot(pos[0] - flag.x, pos[2] - flag.z);
    targets[key] = { gain: S.birds.level * falloff(d, S.birds.range) * clamp01(state.calm?.[id] ?? 1) * (1 - aloft), pan: panTo(flag.x, flag.z) };
  }
  const works = site('E');
  targets.industrial = { gain: S.industrial.level * falloff(Math.hypot(pos[0] - works.x, pos[2] - works.z), S.industrial.range),
    pan: panTo(works.x, works.z) };
  let wreck = { gain: 0, pan: 0 };
  for (const w of state.wrecks || []) {
    const d = Math.hypot(pos[0] - w.x, (pos[1] - (w.y ?? pos[1])) * 0.5, pos[2] - w.z);
    const gain = S.wreck.level * falloff(d, S.wreck.range, 2);
    if (gain > wreck.gain) wreck = { gain, pan: panTo(w.x, w.z) };
  }
  targets.wreckFire = wreck;
  return targets;
}

function positionOf(ev) {
  if (Array.isArray(ev?.pos) && ev.pos.length >= 3) return ev.pos;
  if (Number.isFinite(ev?.x) && Number.isFinite(ev?.z)) return [ev.x, ev.y ?? 0, ev.z];
  if (Array.isArray(ev?.o) && ev.o.length >= 3) return ev.o;
  return null;
}

/** Equal-power crossfade (s) between the two media elements of a streamed bed at its loop point. */
export const STREAM_CROSSFADE = 0.6;

/**
 * Media-element bed (browser only). The compressed file is fetched once into a
 * Blob, so the elements can seek and restart without Range requests or a
 * re-fetch, and only the Opus bytes (not decoded PCM) stay in memory.
 * Media elements do not loop sample-accurately (`loop = true` can leave a gap
 * or click at the seam), so two elements share the Blob and hand over with an
 * equal-power crossfade shortly before the playing one ends. The beds are
 * noise-like, so the overlap of the end and the start is inaudible.
 */
function defaultStream(ctx, url) {
  if (typeof Audio !== 'function' || typeof ctx?.createMediaElementSource !== 'function'
    || typeof fetch !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
  const output = ctx.createGain();
  const fadeIn = new Float32Array(32), fadeOut = new Float32Array(32);
  for (let i = 0; i < 32; i++) {
    fadeIn[i] = Math.sin((i / 31) * Math.PI / 2);
    fadeOut[i] = Math.cos((i / 31) * Math.PI / 2);
  }
  let objectUrl = null, disposed = false, wanted = false, active = 0;
  const voices = [0, 1].map(index => {
    const element = new Audio();
    element.preload = 'auto';
    const source = ctx.createMediaElementSource(element);
    const gain = ctx.createGain();
    gain.gain.value = index === 0 ? 1 : 0;
    source.connect(gain).connect(output);
    const voice = { element, source, gain, handing: false };
    // timeupdate fires every 15-250 ms, also while the tab is hidden.
    element.addEventListener?.('timeupdate', () => { if (index === active) handover(); });
    // A missed handover (throttled timers): restart from the top rather than fall silent.
    element.addEventListener?.('ended', () => {
      if (index !== active || !wanted || disposed) return;
      element.currentTime = 0;
      element.play()?.catch?.(() => {});
    });
    return voice;
  });
  const ramp = (param, curve) => {
    const now = ctx.currentTime;
    try {
      param.cancelScheduledValues(now);
      param.setValueCurveAtTime(curve, now, STREAM_CROSSFADE);
    } catch { param.value = curve[curve.length - 1]; }
  };
  function handover() {
    const from = voices[active];
    const { duration, currentTime } = from.element;
    if (!wanted || disposed || from.handing || !(duration > STREAM_CROSSFADE * 4)) return;
    if (currentTime < duration - STREAM_CROSSFADE - 0.3) return;
    from.handing = true;
    active = 1 - active;
    const to = voices[active];
    to.handing = false;
    to.element.currentTime = 0;
    Promise.resolve(to.element.play()).then(() => {
      ramp(to.gain.gain, fadeIn);
      ramp(from.gain.gain, fadeOut);
      setTimeout(() => { if (voices[active] !== from) { from.element.pause(); from.handing = false; } }, (STREAM_CROSSFADE + 0.4) * 1000);
    }).catch(() => {
      // Autoplay refused: keep the old element and let it loop on its own.
      active = 1 - active;
      from.handing = false;
      from.element.loop = true;
    });
  }
  const ready = fetch(url).then(response => (response.ok ? response.blob() : null)).then(blob => {
    if (!blob || disposed) return;
    objectUrl = URL.createObjectURL(blob);
    for (const voice of voices) voice.element.src = objectUrl;
  }).catch(() => { /* stays silent */ });
  const start = () => {
    if (!objectUrl || disposed || !wanted) return undefined;
    voices.forEach((voice, index) => {
      voice.gain.gain.cancelScheduledValues?.(ctx.currentTime);
      voice.gain.gain.value = index === active ? 1 : 0;
    });
    return voices[active].element.play();
  };
  return {
    voices, source: output,
    // A rejected play() (autoplay policy) lets the soundscape retry a few seconds later.
    play: () => { wanted = true; return objectUrl ? start() : ready.then(start); },
    pause: () => {
      wanted = false;
      for (const voice of voices) { voice.element.pause(); voice.handing = false; }
    },
    dispose: () => {
      disposed = true;
      wanted = false;
      for (const voice of voices) {
        try { voice.element.pause(); voice.element.removeAttribute('src'); voice.element.load(); } catch { /* gone */ }
        try { voice.source.disconnect(); voice.gain.disconnect(); } catch { /* gone */ }
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

export class ConquestSoundscape {
  /**
   * @param {{ audio: {engine, getBuffer, pick}, weather?: string, wrecks?: Array<{x,y,z}>,
   *   random?: Function, createStream?: Function }} options `audio` is sfx.conquestAudio();
   *   `wrecks` the ConquestAmbience wreck props.
   */
  constructor({ audio = null, weather = 'golden', wrecks = [], random = Math.random, createStream = defaultStream } = {}) {
    this.audio = audio;
    this.wind = WEATHER_WIND[weather] ?? WEATHER_WIND.golden;
    this.wrecks = Array.isArray(wrecks) ? wrecks.filter(w => Number.isFinite(w?.x) && Number.isFinite(w?.z)) : [];
    this.random = typeof random === 'function' ? random : Math.random;
    this.createStream = createStream;
    this.ctx = null;
    this.bus = null;
    this.beds = new Map();
    this.oneShots = 0;
    this.groupShots = new Map();
    this.combat = 0;
    this.calm = { A: 1, B: 1 };
    this.timers = { gust: this._between(SOUNDSCAPE.wind.gustEvery), crow: this._between(SOUNDSCAPE.birds.crowEvery),
      bell: this._between(SOUNDSCAPE.bell.every), industrial: this._between(SOUNDSCAPE.industrial.every),
      radio: this._between(SOUNDSCAPE.radio.every) };
    this.phase = null;
    this.started = false;
    this.age = 0;
    this.listener = null;
    this.targets = null;
    this.played = [];
    this.disposed = false;
  }

  _between([lo, hi]) { return lo + (hi - lo) * this.random(); }

  _ready() {
    const engine = this.audio?.engine;
    const ctx = engine?.ctx;
    if (this.disposed || !ctx || ctx.state !== 'running' || !engine.bus) return null;
    if (this.ctx !== ctx) {
      this._teardown();
      this.ctx = ctx;
      this.bus = ctx.createGain();
      this.bus.gain.value = 0;
      this.bus.connect(engine.bus);
      this.bus.gain.setTargetAtTime(SOUNDSCAPE.level, ctx.currentTime, SOUNDSCAPE.fadeIn / 3);
    }
    return ctx;
  }

  /** Battle activity and bird calm from authoritative events (positions where they carry one). */
  handleEvent(ev) {
    if (this.disposed || !ev || typeof ev.kind !== 'string') return;
    const bump = SOUNDSCAPE.battle.events[ev.kind];
    if (bump) this.combat = Math.min(1, this.combat + bump);
    const pos = positionOf(ev);
    if (!pos) return;
    const blast = ev.kind === 'projectileExplode' || ev.kind === 'vehicle_destroyed';
    if (!blast && ev.kind !== 'shoot' && ev.kind !== 'kill') return;
    for (const id of ['A', 'B']) {
      const flag = site(id);
      const d = Math.hypot(pos[0] - flag.x, pos[2] - flag.z);
      if (d > SOUNDSCAPE.birds.combatRadius) continue;
      if (blast && d <= SOUNDSCAPE.birds.scatterRadius && this.calm[id] > 0.5) {
        this._oneShot('cq.amb.scatter', [flag.x, pos[1], flag.z], { gain: 0.7 });
      }
      this.calm[id] = 0;
    }
  }

  /** One distant artillery shot at `pos` (ConquestAmbience salvo flash); the boom follows at 343 m/s. */
  artillery(pos) {
    const listener = this.listener;
    if (!Array.isArray(pos) || !listener) return false;
    const distance = Math.hypot(pos[0] - listener[0], pos[1] - listener[1], pos[2] - listener[2]);
    const gain = SOUNDSCAPE.artillery.level * Math.max(SOUNDSCAPE.artillery.floor, 1 - distance / SOUNDSCAPE.artillery.range);
    // The distance gain above is the whole attenuation: no second _oneShot range fade (salvos land past 600 m).
    return this._oneShot('cq.amb.artillery', pos, { gain, delay: distance / 343, rate: 0.9 + this.random() * 0.15,
      range: Infinity, cap: SOUNDSCAPE.artillery.max });
  }

  /**
   * Per frame: `camera` (THREE camera: position and matrixWorld), `match` (the
   * snapshot match for flag activity and match start/end), `selfTeam`, `inVehicle`.
   */
  update(dt, camera, { match = null, selfTeam = null, inVehicle = false } = {}) {
    if (this.disposed) return;
    const step = Math.max(0, Math.min(0.25, Number(dt) || 0));
    const p = camera?.position;
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return;
    const e = camera.matrixWorld?.elements;
    const fwd = e ? [-e[8], -e[9], -e[10]] : [0, 0, -1];
    this.listener = [p.x, p.y, p.z];
    this._fwd = fwd;
    this._step = step;
    this.combat = Math.max(0, this.combat - SOUNDSCAPE.battle.decayPerSecond * step);
    for (const id of ['A', 'B']) this.calm[id] = Math.min(1, this.calm[id] + step / SOUNDSCAPE.birds.recover);
    const flags = Array.isArray(match?.conquest?.flags) ? match.conquest.flags : [];
    const active = flags.filter(t => Array.isArray(t) && t[3] && t[3] !== 'idle').length / Math.max(1, FRONTIER_PLAN.flags.length);
    const intensity = clamp01(SOUNDSCAPE.battle.base + SOUNDSCAPE.battle.flagWeight * active + this.combat);
    this.targets = soundscapeTargets({ pos: this.listener, fwd, wind: this.wind, intensity, calm: this.calm, wrecks: this.wrecks });
    const ctx = this._ready();
    if (!ctx) return;
    for (const [key, target] of Object.entries(this.targets)) this._bed(key, target, ctx);
    this._events(step, match, selfTeam, inVehicle);
  }

  _bed(key, target, ctx) {
    let bed = this.beds.get(key);
    const audible = target.gain > 0.002;
    if (!bed) {
      if (!audible || !CONQUEST_STREAMS[key]) return;
      let stream = null;
      try { stream = this.createStream(ctx, CONQUEST_STREAMS[key]); } catch { stream = null; }
      if (!stream) { this.beds.set(key, { failed: true }); return; }
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      stream.source.connect(gain);
      if (pan) gain.connect(pan).connect(this.bus); else gain.connect(this.bus);
      bed = { stream, gain, pan, playing: false, quietFor: 0, retryAt: 0 };
      this.beds.set(key, bed);
    }
    if (bed.failed) return;
    const now = ctx.currentTime;
    bed.gain.gain.setTargetAtTime(target.gain, now, SOUNDSCAPE.smoothing);
    bed.pan?.pan.setTargetAtTime(target.pan, now, 0.2);
    if (audible) {
      bed.quietFor = 0;
      if (!bed.playing && now >= bed.retryAt) {
        bed.playing = true;
        try {
          Promise.resolve(bed.stream.play()).catch(() => { bed.playing = false; bed.retryAt = (this.ctx?.currentTime || 0) + 3; });
        } catch { bed.playing = false; bed.retryAt = now + 3; }
      }
    } else if (bed.playing && (bed.quietFor += this._step || 0) > SOUNDSCAPE.pauseAfter) {
      bed.playing = false;
      try { bed.stream.pause(); } catch { /* gone */ }
    }
  }

  _events(step, match, selfTeam, inVehicle) {
    const S = SOUNDSCAPE;
    const pos = this.listener;
    const phase = match?.phase ?? null;
    this.age += step;
    // Match-start tolls once the bell has decoded (the bank loads in the background), never late.
    if (!this.started && phase && phase !== 'post') {
      if (this.age > SOUNDSCAPE.bell.startWindow) this.started = true;
      else if (this.audio?.pick?.('cq.amb.bell')) { this.started = true; this._tolls(); }
    }
    if (phase === 'post' && this.phase !== 'post' && this.started) this._tolls();
    this.phase = phase;
    const t = this.timers;
    for (const key of Object.keys(t)) t[key] -= step;
    const wind = clamp01(this.wind / 2.2);
    if (t.gust <= 0) {
      t.gust = this._between(S.wind.gustEvery) / Math.max(0.4, wind);
      const angle = this.random() * Math.PI * 2;
      this._oneShot('cq.amb.gust', [pos[0] + Math.cos(angle) * 20, pos[1], pos[2] + Math.sin(angle) * 20], { gain: S.wind.gust * wind });
    }
    if (t.crow <= 0) {
      t.crow = this._between(S.birds.crowEvery);
      for (const id of ['A', 'B']) {
        const flag = site(id);
        if (this.calm[id] > 0.3 && Math.hypot(pos[0] - flag.x, pos[2] - flag.z) <= S.birds.crowRange) {
          this._oneShot('cq.amb.crow', [flag.x + (this.random() - 0.5) * 50, pos[1] + 8, flag.z + (this.random() - 0.5) * 50],
            { gain: S.birds.crow, range: S.birds.crowRange });
          break;
        }
      }
    }
    if (t.bell <= 0) {
      t.bell = this._between(S.bell.every);
      const church = site('B');
      if (Math.hypot(pos[0] - church.x, pos[2] - church.z) <= S.bell.range) this._oneShot('cq.amb.bell', [church.x, 40, church.z], { gain: S.bell.level, range: S.bell.range });
    }
    if (t.industrial <= 0) {
      t.industrial = this._between(S.industrial.every);
      const works = site('E');
      if (Math.hypot(pos[0] - works.x, pos[2] - works.z) <= S.industrial.range) {
        const group = this.random() < 0.5 ? 'cq.amb.steam' : 'cq.amb.creak';
        this._oneShot(group, [works.x + (this.random() - 0.5) * 30, pos[1], works.z + (this.random() - 0.5) * 30],
          { gain: S.industrial.oneShot, range: S.industrial.range });
      }
    }
    if (t.radio <= 0) {
      t.radio = this._between(S.radio.every);
      const hq = FRONTIER_PLAN.hqs[selfTeam];
      const nearHq = hq && Math.hypot(pos[0] - hq.x, pos[2] - hq.z) <= S.radio.hqRange;
      if (nearHq || inVehicle) this._oneShot(this.random() < 0.25 ? 'cq.amb.squelch' : 'cq.amb.radio', null, { gain: S.radio.level });
    }
  }

  /** Three church-bell tolls (match start and end), heard across the valley. */
  _tolls() {
    const church = site('B');
    for (let i = 0; i < SOUNDSCAPE.bell.tolls; i++) {
      this._oneShot('cq.amb.bell', [church.x, 40, church.z], { gain: SOUNDSCAPE.bell.level, range: Infinity,
        delay: i * SOUNDSCAPE.bell.tollSpacing, floor: 0.35 });
    }
  }

  /** One decoded take through a distance gain and pan (null pos: in the head). */
  _oneShot(group, pos, { gain = 1, delay = 0, rate = 1, range = 600, floor = 0, cap = SOUNDSCAPE.maxOneShots } = {}) {
    const ctx = this.ctx && this.ctx === this.audio?.engine?.ctx && this.ctx.state === 'running' ? this.ctx : this._ready();
    if (!ctx || !this.bus || this.oneShots >= SOUNDSCAPE.maxOneShots || (this.groupShots.get(group) || 0) >= cap) return false;
    const slot = this.audio?.pick?.(group);
    const buffer = slot ? this.audio.getBuffer(slot) : null;
    if (!buffer) return false;
    let level = gain, panValue = 0;
    if (Array.isArray(pos) && this.listener) {
      const [lx, ly, lz] = this.listener;
      const d = Math.hypot(pos[0] - lx, pos[1] - ly, pos[2] - lz);
      level = gain * Math.max(floor, Number.isFinite(range) ? falloff(d, range, 1) : 1);
      panValue = this._panTo(pos);
    }
    if (level <= 0.002) return false;
    const source = ctx.createBufferSource();
    const amp = ctx.createGain();
    const pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    source.buffer = buffer;
    source.playbackRate.value = rate;
    amp.gain.value = level;
    source.connect(amp);
    if (pan) { pan.pan.value = panValue; amp.connect(pan).connect(this.bus); } else amp.connect(this.bus);
    this.oneShots++;
    this.groupShots.set(group, (this.groupShots.get(group) || 0) + 1);
    source.onended = () => {
      this.oneShots = Math.max(0, this.oneShots - 1);
      this.groupShots.set(group, Math.max(0, (this.groupShots.get(group) || 1) - 1));
      try { source.disconnect(); amp.disconnect(); pan?.disconnect(); } catch { /* gone */ }
    };
    try { source.start(ctx.currentTime + Math.max(0, delay)); } catch { source.onended(); return false; }
    this.played.push(group);
    if (this.played.length > 64) this.played.shift();
    return true;
  }

  _panTo(pos) {
    const fwd = this._fwd || [0, 0, -1];
    const [lx, , lz] = this.listener;
    const rx = -fwd[2], rz = fwd[0], rl = Math.hypot(rx, rz) || 1;
    const dx = pos[0] - lx, dz = pos[2] - lz, d = Math.hypot(dx, dz);
    return d < 1 ? 0 : Math.max(-0.85, Math.min(0.85, ((dx * rx + dz * rz) / rl / d) * 0.85));
  }

  _teardown() {
    for (const bed of this.beds.values()) {
      if (bed.failed) continue;
      try { bed.stream.dispose(); } catch { /* gone */ }
      try { bed.stream.source.disconnect(); bed.gain.disconnect(); bed.pan?.disconnect(); } catch { /* gone */ }
    }
    this.beds.clear();
    try { this.bus?.disconnect(); } catch { /* gone */ }
    this.bus = null;
    this.ctx = null;
    this.oneShots = 0;
    this.groupShots.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const ctx = this.ctx;
    if (ctx && this.bus && ctx.state === 'running' && typeof setTimeout === 'function') {
      // A short fade so leaving the match does not click, then release the streams.
      try { this.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.08); } catch { /* gone */ }
      setTimeout(() => this._teardown(), 350);
      return;
    }
    this._teardown();
  }
}
