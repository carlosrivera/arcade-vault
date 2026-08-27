// Fully synthesized WebAudio soundtrack & SFX — no assets.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this._musicTimer = null;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    // ---- engine: two detuned saws + sub, through a lowpass ----
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 400;
    this.engFilter.Q.value = 1.2;
    this.engFilter.connect(this.engGain);
    this.engGain.connect(this.master);
    this.engOscs = [];
    for (const [type, det] of [
      ['sawtooth', -6],
      ['sawtooth', 7],
      ['square', -1205],
    ]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = det;
      o.frequency.value = 55;
      o.connect(this.engFilter);
      o.start();
      this.engOscs.push(o);
    }
    this.subOsc = ctx.createOscillator();
    this.subOsc.type = 'sine';
    this.subOsc.frequency.value = 40;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.subOsc.connect(this.subGain);
    this.subGain.connect(this.master);
    this.subOsc.start();

    // ---- wind: looped noise through bandpass ----
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = buf;
    this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 900;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();

    // ---- music bus ----
    this.musGain = ctx.createGain();
    this.musGain.gain.value = 0.16;
    this.musFilter = ctx.createBiquadFilter();
    this.musFilter.type = 'lowpass';
    this.musFilter.frequency.value = 2600;
    this.musGain.connect(this.musFilter);
    this.musFilter.connect(this.master);

    this._step = 0;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
  }

  // called every frame
  update(speedNorm, throttle, boosting, racing) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 48 + speedNorm * 150;
    for (const o of this.engOscs) o.frequency.setTargetAtTime(base, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(
      280 + speedNorm * 2400 + (boosting ? 1400 : 0),
      t,
      0.08,
    );
    this.engGain.gain.setTargetAtTime(
      racing ? 0.05 + throttle * 0.05 + speedNorm * 0.05 : 0.015,
      t,
      0.12,
    );
    this.subOsc.frequency.setTargetAtTime(base / 2, t, 0.08);
    this.subGain.gain.setTargetAtTime(racing ? 0.05 : 0.01, t, 0.2);
    this.windGain.gain.setTargetAtTime(racing ? speedNorm * speedNorm * 0.11 : 0, t, 0.15);
  }

  startMusic() {
    if (!this.ctx || this._musicTimer) return;
    const BPM = 126,
      stepDur = 60 / BPM / 4; // 16ths
    // F minor-ish pentatonic ladder, driving industrial bass
    const notes = [46.25, 46.25, 55.0, 61.74, 69.3];
    const seq = [
      0, -1, 0, 4, 0, -1, 3, 2, 0, -1, 0, 4, 3, -1, 2, 1, 0, 0, 4, -1, 0, 3, 2, -1, 0, -1, 4, 3, 2,
      -1, 1, -1,
    ];
    let nextT = this.ctx.currentTime + 0.1;
    const tick = () => {
      while (nextT < this.ctx.currentTime + 0.25) {
        const n = seq[this._step % seq.length];
        if (n >= 0) {
          const f = notes[n];
          this._blip(f, nextT, stepDur * 1.9, 'sawtooth', 0.3);
          if (this._step % 8 === 0) this._blip(f / 2, nextT, stepDur * 6, 'triangle', 0.22);
        }
        if (this._step % 4 === 2) this._hat(nextT, 0.05);
        if (this._step % 8 === 4) this._hat(nextT, 0.09);
        this._step++;
        nextT += stepDur;
      }
    };
    this._musicTimer = setInterval(tick, 90);
    tick();
  }

  _blip(freq, when, dur, type, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    o.connect(g);
    g.connect(this.musGain);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  _hat(when, gain) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    src.connect(f);
    f.connect(g);
    g.connect(this.musGain);
    src.start(when);
    src.stop(when + 0.08);
  }

  beep(freq = 440, dur = 0.14, gain = 0.35) {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setValueAtTime(gain, t + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  padBlip() {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(1200, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(600, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.2);
    o.connect(f);
    f.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.28);
  }

  wallScrape() {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 300;
    f.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + 0.2);
  }

  // heavy clunk when clipping a hazard pylon
  obstacleHit() {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.3);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 1.2;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.3, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    src.connect(f);
    f.connect(g2);
    g2.connect(this.master);
    src.start(t);
    src.stop(t + 0.22);
  }

  weaponPickup() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [660, 990].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      const w = t + i * 0.07;
      g.gain.setValueAtTime(0.001, w);
      g.gain.exponentialRampToValueAtTime(0.22, w + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, w + 0.14);
      o.connect(g);
      g.connect(this.master);
      o.start(w);
      o.stop(w + 0.16);
    });
  }

  rocketFire() {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(720, t + 0.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 300;
    o.connect(f);
    f.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.38);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1800;
    nf.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.12, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(nf);
    nf.connect(ng);
    ng.connect(this.master);
    src.start(t);
    src.stop(t + 0.32);
  }

  explosion() {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.52);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.4, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    src.connect(f);
    f.connect(ng);
    ng.connect(this.master);
    src.start(t);
    src.stop(t + 0.42);
  }

  shieldPing() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [880, 1318].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      const w = t + i * 0.09;
      g.gain.setValueAtTime(0.001, w);
      g.gain.exponentialRampToValueAtTime(0.25, w + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, w + 0.2);
      o.connect(g);
      g.connect(this.master);
      o.start(w);
      o.stop(w + 0.22);
    });
  }

  // metallic clank when ships collide; strength 0..1
  shipBump(strength = 0.5) {
    if (!this.ctx) return;
    const ctx = this.ctx,
      t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(340, t);
    o.frequency.exponentialRampToValueAtTime(130, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15 + strength * 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.17);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.08 + strength * 0.15, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    src.connect(f);
    f.connect(ng);
    ng.connect(this.master);
    src.start(t);
    src.stop(t + 0.12);
  }

  airbrakeHiss(strength = 0.5) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, t);
    filter.Q.value = 2.2;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.06 + strength * 0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t);
    src.stop(t + 0.18);
  }

  finishJingle() {
    if (!this.ctx) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      setTimeout(() => this.beep(f, 0.22, 0.3), i * 160);
    });
  }
}
