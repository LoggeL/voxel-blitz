// Three shared, deterministic room responses. Voices own only cheap filters
// and sends; no shot allocates or regenerates an impulse response.
export const ENVIRONMENT_PROFILES = Object.freeze([
  Object.freeze({ name: 'outdoor', decay: 0.24, delay: 0.009, cutoff: 6500 }),
  Object.freeze({ name: 'room', decay: 0.86, delay: 0.022, cutoff: 4600 }),
  Object.freeze({ name: 'tunnel', decay: 1.9, delay: 0.046, cutoff: 3200 }),
]);

function impulse(context, profile, seed) {
  const frames = Math.ceil(context.sampleRate * profile.decay);
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let random = (seed + channel * 7919) >>> 0;
    let smooth = 0;
    for (let i = 0; i < frames; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const noise = random / 2147483648 - 1;
      smooth += (noise - smooth) * 0.42;
      // A short fade avoids adding a second sharp muzzle transient. -60 dB
      // at the declared decay keeps the response's full tail finite.
      const t = i / context.sampleRate;
      data[i] = smooth * Math.min(1, t / 0.007) * Math.exp(-6.91 * t / profile.decay);
    }
  }
  return buffer;
}

export function buildEnvironmentGraph(context, bus) {
  const nodes = [];
  const inputs = ENVIRONMENT_PROFILES.map((profile, index) => {
    const input = context.createGain();
    const convolver = context.createConvolver();
    convolver.normalize = true;
    convolver.buffer = impulse(context, profile, 5101 + index * 31337);
    const damp = context.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = profile.cutoff;
    damp.Q.value = 0.5;
    input.connect(convolver).connect(damp).connect(bus);
    nodes.push(input, convolver, damp);
    return input;
  });
  return { inputs, nodes, dispose() {
    for (const node of nodes) node.disconnect();
  } };
}

/** Preserve direction through an opening without making a far sound seem near. */
export function acousticPosition(sample, source, listener) {
  const apparent = sample.apparentPosition;
  if (!apparent || !listener) return source;
  const direction = apparent.map((v, axis) => v - listener[axis]);
  const length = Math.hypot(...direction);
  if (length < 0.01) return source;
  const distance = Math.max(length, sample.pathLength || 0,
    Math.hypot(...source.map((v, axis) => v - listener[axis])));
  return listener.map((v, axis) => v + direction[axis] / length * distance);
}

function setParam(param, value, now, immediate) {
  param.cancelScheduledValues(now);
  if (immediate) param.setValueAtTime(value, now);
  else param.setTargetAtTime(value, now, 0.035);
}

/** Input remains dry for local weapons, with only an added room response. */
export function buildEnvironmentVoice(context, input, panner, graph, bus) {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 22000;
  filter.Q.value = 0.5;
  const gain = context.createGain();
  input.connect(filter).connect(gain);
  const spatial = panner || gain;
  if (panner) gain.connect(panner);
  spatial.connect(bus);
  // This delay is only on the reflection branch. Existing sound travel time
  // belongs to the source scheduler and is never applied twice to direct sound.
  const preDelay = context.createDelay(0.1);
  spatial.connect(preDelay);
  const sends = graph.inputs.map(destination => {
    const send = context.createGain();
    send.gain.value = 0;
    preDelay.connect(send).connect(destination);
    return send;
  });
  return { filter, gain, preDelay, sends, sample: null,
    update(sample, { self = false, immediate = false } = {}) {
      this.sample = sample;
      const now = context.currentTime;
      setParam(filter.frequency, self ? 22000 : sample.lowpassHz, now, immediate);
      setParam(gain.gain, self ? 1 : sample.gain, now, immediate);
      setParam(preDelay.delayTime, sample.preDelaySeconds, now, immediate);
      // Interpolate fixed responses rather than changing a convolver buffer in
      // flight. This keeps moving across a doorway or destroying a roof smooth.
      const decay = sample.decaySeconds;
      const large = Math.max(0, Math.min(1, (decay - 0.86) / (1.9 - 0.86)));
      const small = Math.max(0, Math.min(1, (0.86 - decay) / (0.86 - 0.24)));
      const weights = [small, 1 - small - large, large];
      for (let i = 0; i < sends.length; i++) {
        setParam(sends[i].gain, sample.wet * weights[i], now, immediate);
      }
    },
    dispose() {
      filter.disconnect();
      gain.disconnect();
      preDelay.disconnect();
      for (const send of sends) send.disconnect();
    },
  };
}
