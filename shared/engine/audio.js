// audio.js — procedural WebAudio primitives.
//
// Every game here synthesises its sound rather than shipping audio files, and
// each had independently rebuilt the same five things: a lazily-created
// context, a noise buffer, one-shot filtered noise bursts, envelope-shaped
// oscillator tones, and looped drones whose pitch and gain track a game value.
// Those live here. The *sound design* — which frequencies, which envelopes —
// stays in the games, because that is the part that differs.

/**
 * Shared context, master bus, and mute.
 *
 * Browsers refuse to start audio before a user gesture, so nothing is created
 * until start() is called from a click or keypress. Every method is a no-op
 * before that, letting games call them unconditionally.
 */
export class AudioKernel {
  constructor({ masterGain = 0.55 } = {}) {
    this.ctx = null;
    this.master = null;
    this.started = false;
    this.muted = false;
    this._masterGain = masterGain;
  }

  /** Create the context and master bus. Safe to call repeatedly. */
  start() {
    if (this.started) return this;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this._masterGain;
    this.master.connect(this.ctx.destination);
    this.started = true;
    return this;
  }

  /**
   * Resume after the browser auto-suspends (tab hidden, or created before a
   * gesture). Cheap to call on every input event.
   */
  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
    return this;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : this._masterGain, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  /**
   * A loop-able buffer of noise.
   *
   * 'white' is flat — bright, good for hats and hiss. 'brown' integrates the
   * signal, rolling off the highs into the low rumble that reads as an engine
   * or wind rather than static. Games keep one and reuse it for every burst;
   * allocating per shot is what makes rapid fire crackle.
   */
  noiseBuffer({ seconds = 2, type = 'white' } = {}) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    if (type === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    } else {
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * One-shot filtered noise with an exponential decay — impacts, gunfire,
   * explosions, footsteps.
   *
   * `sweepTo` ramps the filter cutoff across the burst, which is what turns a
   * flat "shh" into a falling whoosh.
   */
  burst({
    buffer,
    duration = 0.2,
    filterType = 'lowpass',
    frequency = 1000,
    sweepTo = null,
    gain = 0.4,
    Q = null,
    playbackRate = null,
    destination = null,
  }) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    if (playbackRate !== null) src.playbackRate.value = playbackRate;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, t);
    if (Q !== null) filter.Q.value = Q;
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    // Exponential, not linear: loudness is perceived logarithmically, so a
    // linear fade sounds like it stops abruptly. Never ramps to 0 — the
    // exponential ramp is undefined there, hence 0.001.
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src
      .connect(filter)
      .connect(g)
      .connect(destination || this.master);
    // Random offset into the loop so repeated shots don't phase-align.
    src.start(t, Math.random() * Math.max(0, buffer.duration - duration));
    src.stop(t + duration + 0.05);
  }

  /** One-shot oscillator with the same exponential decay — beeps, blips, UI. */
  tone({
    frequency = 440,
    duration = 0.2,
    type = 'sine',
    gain = 0.3,
    when = null,
    destination = null,
  }) {
    if (!this.started) return;
    const t = when ?? this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(destination || this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /**
   * A continuously running noise layer whose filter and gain are steered from
   * gameplay — engine roar, wind, rotor wash.
   *
   * Returns setters that use setTargetAtTime rather than assigning .value:
   * a direct jump every frame produces zipper noise, while an exponential
   * approach glides. `smoothing` is that glide's time constant in seconds.
   */
  drone({ buffer, filterType = 'bandpass', frequency = 400, Q = null, gain = 0 }) {
    if (!this.started) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    if (Q !== null) filter.Q.value = Q;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.master);
    src.start();
    return {
      source: src,
      filter,
      gain: g,
      setFrequency: (value, smoothing = 0.1) =>
        filter.frequency.setTargetAtTime(value, this.ctx.currentTime, smoothing),
      setGain: (value, smoothing = 0.1) =>
        g.gain.setTargetAtTime(value, this.ctx.currentTime, smoothing),
    };
  }

  /** A sub-mixer, for grouping (a music bus you can duck independently). */
  bus({ gain = 1, filterType = null, frequency = 20000 } = {}) {
    if (!this.started) return null;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (filterType) {
      const filter = this.ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = frequency;
      g.connect(filter).connect(this.master);
      return { input: g, gain: g, filter };
    }
    g.connect(this.master);
    return { input: g, gain: g, filter: null };
  }
}
