/*
 * audio.js — tiny procedural sound engine built on the Web Audio API.
 * No asset files required; all effects are synthesised. Respects a master
 * volume and a mute toggle (presentation/accessibility requirement).
 */
(function (G) {
  'use strict';

  const Audio = {
    ctx: null,
    master: null,
    muted: false,
    volume: 0.6,
    ready: false,

    init() {
      if (this.ready) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(this.ctx.destination);
        this.ready = true;
      } catch (e) {
        this.ready = false;
      }
    },

    // Browsers block audio until a user gesture; call this from input.
    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    setVolume(v) {
      this.volume = v;
      if (this.master) this.master.gain.value = this.muted ? 0 : v;
    },
    setMuted(m) {
      this.muted = m;
      if (this.master) this.master.gain.value = m ? 0 : this.volume;
    },

    _tone(freq, dur, type, gain, slideTo) {
      if (!this.ready || this.muted) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain || 0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },

    jump() { this._tone(320, 0.12, 'square', 0.12, 520); },
    land() { this._tone(160, 0.08, 'sine', 0.1, 90); },
    tetherFire() { this._tone(680, 0.1, 'sawtooth', 0.08, 900); },
    tetherHit() { this._tone(520, 0.12, 'triangle', 0.12, 740); },
    tetherMiss() { this._tone(200, 0.12, 'sawtooth', 0.1, 120); },
    collect() { this._tone(880, 0.1, 'triangle', 0.16, 1320); setTimeout(() => this._tone(1320, 0.12, 'triangle', 0.14, 1760), 90); },
    quest() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this._tone(f, 0.18, 'triangle', 0.14), i * 110)); },
    error() { this._tone(180, 0.18, 'square', 0.12, 120); },
    win() { [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => this._tone(f, 0.3, 'triangle', 0.16), i * 160)); },
    thud() { this._tone(110, 0.12, 'sine', 0.14, 60); },
  };

  G.Audio = Audio;
})(window.EOTW);
