// audio.js — procedural WebAudio: engine roar keyed to throttle/speed,
// cannon, missile launch whoosh, lock tone, explosion noise bursts.

export class Audio {
  constructor() {
    this.ctx = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    // ------- engine: brown-ish noise through a bandpass, pitch/gain follow thrust
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    this.engineSrc = this.ctx.createBufferSource();
    this.engineSrc.buffer = buf;
    this.engineSrc.loop = true;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'bandpass';
    this.engineFilter.Q.value = 0.8;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineSrc.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    this.engineSrc.start();

    // ------- wind: high-passed noise keyed to airspeed
    this.windSrc = this.ctx.createBufferSource();
    this.windSrc.buffer = buf;
    this.windSrc.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'highpass';
    this.windFilter.frequency.value = 1400;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.windSrc.start();

    // ------- lock tone oscillator (silent until armed)
    this.tone = this.ctx.createOscillator();
    this.tone.type = 'square';
    this.tone.frequency.value = 780;
    this.toneGain = this.ctx.createGain();
    this.toneGain.gain.value = 0;
    this.tone.connect(this.toneGain).connect(this.master);
    this.tone.start();

    this.noiseBuf = buf;
    this.started = true;
  }

  updateEngine(throttle, ab, speed) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const eng = 0.06 + throttle * 0.16 + (ab ? 0.14 : 0);
    this.engineGain.gain.setTargetAtTime(eng, t, 0.2);
    this.engineFilter.frequency.setTargetAtTime(120 + throttle * 260 + (ab ? 180 : 0), t, 0.25);
    this.windGain.gain.setTargetAtTime(Math.min(0.14, speed / 9000), t, 0.4);
  }

  setLockTone(mode) {
    // 'off' | 'locking' | 'locked'
    if (!this.started) return;
    const g = mode === 'locked' ? 0.05 : mode === 'locking' ? 0.025 : 0;
    this.toneGain.gain.setTargetAtTime(g, this.ctx.currentTime, mode === 'off' ? 0.1 : 0.02);
    if (mode === 'locking') {
      this.tone.frequency.setTargetAtTime(
        600 + Math.sin(performance.now() / 90) * 160,
        this.ctx.currentTime,
        0.03,
      );
    } else {
      this.tone.frequency.setTargetAtTime(780, this.ctx.currentTime, 0.05);
    }
  }

  burst(dur, filterType, freq, gain, sweepTo) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
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
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(950, t);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.09, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.25);
  }
}
