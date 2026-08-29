/**
 * DUNESWEEPER - Procedural sound design.
 * Zero external audio files. 100% synthesized.
 *
 * WebAudio plumbing lives in the shared kernel; this file is the tuning that
 * makes an excavation sound like sand, stone and old brass.
 */

import { AudioKernel } from '#engine/audio.js';

export class AudioManager {
  constructor() {
    // Unity master: these sounds were mixed against a direct destination
    // connection, so any master attenuation would quietly rebalance them all.
    this.kernel = new AudioKernel({ masterGain: 1.0 });
    this.isMuted = false;
    this.ambient = null;
    this.isUnlocked = false;

    // Pentatonic scale — any subset sounds consonant in any order, so the
    // cascade chime can follow the flood-fill without ever landing sour.
    this.pentatonic = [
      261.63, // C4
      293.66, // D4
      329.63, // E4
      392.0, // G4
      440.0, // A4
      523.25, // C5
      587.33, // D5
      659.25, // E5
      783.99, // G5
      880.0, // A5
    ];
  }

  get ctx() {
    return this.kernel.ctx;
  }

  /** Browsers block audio until a gesture, so every sound path calls this first. */
  ensureContext() {
    this.kernel.start().resume();
    if (!this.noise) this.noise = this.kernel.noiseBuffer({ seconds: 2, type: 'white' });
    this.isUnlocked = true;
  }

  toggleMute() {
    this.isMuted = this.kernel.toggleMute();
    return this.isMuted;
  }

  /** Guard shared by every play method: muted, or no context yet. */
  _ready() {
    if (this.isMuted) return false;
    this.ensureContext();
    return !!this.kernel.ctx;
  }

  /** Sand excavation dig & crumble. */
  playDig() {
    if (!this._ready()) return;
    // Friction: bandpassed noise falling in pitch as the sand settles.
    this.kernel.burst({
      buffer: this.noise,
      duration: 0.12,
      filterType: 'bandpass',
      frequency: 1400,
      sweepTo: 400,
      Q: 3.0,
      gain: 0.35,
    });
    // Body: a short low thud so the dig has weight under the hiss.
    this.kernel.tone({ frequency: 160, sweepTo: 50, duration: 0.08, type: 'triangle', gain: 0.2 });
  }

  /** Melodic ascending cascade chime, one step per revealed cell. */
  playCascade(stepIndex = 0) {
    if (!this._ready()) return;
    const noteIdx = Math.min(stepIndex, this.pentatonic.length - 1);
    this.kernel.tone({
      frequency: this.pentatonic[noteIdx],
      duration: 0.35,
      type: 'sine',
      gain: 0.18,
    });
  }

  /** Flag stake planted (rising) or removed (falling). */
  playFlag(isPlacing = true) {
    if (!this._ready()) return;
    this.kernel.tone({
      frequency: isPlacing ? 380 : 260,
      sweepTo: isPlacing ? 520 : 180,
      duration: 0.09,
      type: isPlacing ? 'triangle' : 'sine',
      gain: 0.25,
    });
  }

  /** Ancient relic discovered — C major arpeggio. */
  playRelicFound() {
    if (!this._ready()) return;
    const chord = [523.25, 659.25, 783.99, 1046.5];
    const start = this.kernel.ctx.currentTime;
    chord.forEach((frequency, i) => {
      this.kernel.tone({
        frequency,
        duration: 0.6,
        type: 'sine',
        gain: 0.22,
        when: start + i * 0.09,
      });
    });
  }

  /** Trap triggered — sawtooth boom collapsing to a sub thud. */
  playTrapHit() {
    if (!this._ready()) return;
    this.kernel.tone({
      frequency: 140,
      sweepTo: 30,
      duration: 0.45,
      type: 'sawtooth',
      gain: 0.45,
    });
  }

  /** Archaeologist brush — soft high noise sweeping down. */
  playBrush() {
    if (!this._ready()) return;
    this.kernel.burst({
      buffer: this.noise,
      duration: 0.22,
      filterType: 'highpass',
      frequency: 2000,
      sweepTo: 800,
      gain: 0.2,
    });
  }

  /**
   * Ancient compass scan. Hand-built rather than kernel.tone(): the ping
   * sweeps up and then back down, and a two-stage glide is one shape past
   * what a single sweepTo can express.
   */
  playCompass() {
    if (!this._ready()) return;
    const ctx = this.kernel.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1760, t + 0.15);
    osc.frequency.exponentialRampToValueAtTime(440, t + 0.35);
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    osc.connect(gain).connect(this.kernel.master);
    osc.start(t);
    osc.stop(t + 0.38);
  }

  /** Victory fanfare — notes overlap slightly so it reads as one phrase. */
  playVictory() {
    if (!this._ready()) return;
    const notes = [
      { f: 523.25, d: 0.15 },
      { f: 659.25, d: 0.15 },
      { f: 783.99, d: 0.15 },
      { f: 1046.5, d: 0.45 },
    ];
    let delay = 0;
    const start = this.kernel.ctx.currentTime;
    for (const n of notes) {
      this.kernel.tone({
        frequency: n.f,
        duration: n.d,
        type: 'triangle',
        gain: 0.3,
        when: start + delay,
      });
      delay += n.d * 0.85;
    }
  }

  /** Background desert wind drone. */
  startDesertAmbience() {
    this.ensureContext();
    if (!this.kernel.ctx || this.ambient) return;
    this.ambient = this.kernel.drone({
      buffer: this.noise,
      filterType: 'lowpass',
      frequency: 280,
      gain: this.isMuted ? 0 : 0.04,
    });
  }
}
