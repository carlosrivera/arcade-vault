// audio.js — STRIKEVECTOR sound design: engine roar keyed to throttle/speed,
// cannon, missile launch whoosh, lock tone, explosion noise bursts.
//
// The WebAudio plumbing lives in the shared kernel; what remains here is the
// tuning that makes it sound like a fighter.

import { AudioKernel } from '#engine/audio.js';

export class Audio {
  constructor() {
    this.kernel = new AudioKernel({ masterGain: 0.55 });
  }

  get started() {
    return this.kernel.started;
  }

  start() {
    if (this.kernel.started) return;
    const k = this.kernel.start();

    // Brown noise: the low-frequency rumble an engine needs. White noise here
    // reads as hiss, not thrust.
    this.noiseBuf = k.noiseBuffer({ seconds: 2, type: 'brown' });

    // Engine: bandpassed rumble, pitch and gain following thrust.
    this.engine = k.drone({
      buffer: this.noiseBuf,
      filterType: 'bandpass',
      frequency: 120,
      Q: 0.8,
    });

    // Wind: the same noise, high-passed, keyed to airspeed rather than throttle.
    this.wind = k.drone({
      buffer: this.noiseBuf,
      filterType: 'highpass',
      frequency: 1400,
    });

    // Lock tone: a continuous oscillator held silent until the seeker is armed.
    this.tone = k.ctx.createOscillator();
    this.tone.type = 'square';
    this.tone.frequency.value = 780;
    this.toneGain = k.ctx.createGain();
    this.toneGain.gain.value = 0;
    this.tone.connect(this.toneGain).connect(k.master);
    this.tone.start();
  }

  updateEngine(throttle, ab, speed) {
    if (!this.kernel.started) return;
    this.engine.setGain(0.06 + throttle * 0.16 + (ab ? 0.14 : 0), 0.2);
    this.engine.setFrequency(120 + throttle * 260 + (ab ? 180 : 0), 0.25);
    this.wind.setGain(Math.min(0.14, speed / 9000), 0.4);
  }

  /** @param {'off'|'locking'|'locked'} mode */
  setLockTone(mode) {
    if (!this.kernel.started) return;
    const ctx = this.kernel.ctx;
    const g = mode === 'locked' ? 0.05 : mode === 'locking' ? 0.025 : 0;
    this.toneGain.gain.setTargetAtTime(g, ctx.currentTime, mode === 'off' ? 0.1 : 0.02);
    if (mode === 'locking') {
      // Warble while searching; steady once locked.
      this.tone.frequency.setTargetAtTime(
        600 + Math.sin(performance.now() / 90) * 160,
        ctx.currentTime,
        0.03,
      );
    } else {
      this.tone.frequency.setTargetAtTime(780, ctx.currentTime, 0.05);
    }
  }

  burst(dur, filterType, freq, gain, sweepTo) {
    this.kernel.burst({
      buffer: this.noiseBuf,
      duration: dur,
      filterType,
      frequency: freq,
      gain,
      sweepTo,
      playbackRate: 0.7 + Math.random() * 0.6,
    });
  }

  gun() {
    this.burst(0.09, 'lowpass', 2200, 0.5);
  }
  missile() {
    this.burst(1.4, 'lowpass', 500, 0.4, 90);
  }
  explosion(scale = 1) {
    this.burst(1.2 + scale * 0.4, 'lowpass', 700, 0.7, 60);
  }
  warningBeep() {
    this.kernel.tone({ frequency: 950, duration: 0.22, type: 'sine', gain: 0.09 });
  }
}
