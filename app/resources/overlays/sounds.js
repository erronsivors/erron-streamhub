// Crossember — встроенные звуки алертов. Синтезируются Web Audio прямо в оверлее: никаких чужих файлов и лицензий.
'use strict';
const CBSound = (() => {
  let ctx = null;
  const ac = () => (ctx = ctx || new (window.AudioContext || window.webkitAudioContext)());

  // Одна нота: частота, начало, длительность, форма волны, громкость.
  function tone(c, out, f, t0, dur, type, gain, slideTo) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  // Шум (треск костра / «вжух»).
  function noise(c, out, t0, dur, gain, freq) {
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.02 ? 1 : 0.35);
    const src = c.createBufferSource();
    src.buffer = buf;
    const flt = c.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.setValueAtTime(freq, t0);
    flt.frequency.exponentialRampToValueAtTime(freq * 3, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt).connect(g).connect(out);
    src.start(t0);
  }

  const SOUNDS = {
    chime: (c, o, t) => { [784, 988, 1319].forEach((f, i) => tone(c, o, f, t + i * 0.11, 0.9, 'sine', 0.35)); },
    coin: (c, o, t) => { tone(c, o, 988, t, 0.08, 'square', 0.18); tone(c, o, 1319, t + 0.08, 0.5, 'square', 0.18); },
    pop: (c, o, t) => { tone(c, o, 420, t, 0.16, 'sine', 0.5, 900); },
    fire: (c, o, t) => { noise(c, o, t, 1.2, 0.6, 500); tone(c, o, 196, t + 0.1, 1.1, 'triangle', 0.25, 392); },
    fanfare: (c, o, t) => {
      [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.4]].forEach(([f, d]) => {
        tone(c, o, f, t + d, d === 0.4 ? 1.1 : 0.2, 'sawtooth', 0.12);
        tone(c, o, f / 2, t + d, d === 0.4 ? 1.1 : 0.2, 'triangle', 0.2);
      });
    }
  };

  /** Сыграть встроенный звук. volume 0…1. */
  function play(name, volume) {
    const fn = SOUNDS[name];
    if (!fn || !(volume > 0)) return;
    const c = ac();
    if (c.state === 'suspended') c.resume();
    const out = c.createGain();
    out.gain.value = Math.min(1, volume);
    out.connect(c.destination);
    fn(c, out, c.currentTime + 0.02);
  }

  return { play, names: Object.keys(SOUNDS) };
})();
