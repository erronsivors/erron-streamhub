// Встроенные звуки алертов для предпрослушки в приложении. Тот же синтез, что в resources/overlays/sounds.js
// (оверлей — обычный JS без сборки, поэтому код продублирован; меняете звук — меняйте в обоих местах).

export const SOUND_LABEL: Record<string, string> = {
  none: 'Без звука', chime: 'Колокольчик', coin: 'Монетка', fire: 'Костёр', pop: 'Щелчок', fanfare: 'Фанфары'
}

let ctx: AudioContext | null = null

function tone(c: AudioContext, out: AudioNode, f: number, t0: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(f, t0)
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g).connect(out)
  o.start(t0)
  o.stop(t0 + dur + 0.05)
}

function noise(c: AudioContext, out: AudioNode, t0: number, dur: number, gain: number, freq: number): void {
  const len = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.02 ? 1 : 0.35)
  const src = c.createBufferSource()
  src.buffer = buf
  const flt = c.createBiquadFilter()
  flt.type = 'bandpass'
  flt.frequency.setValueAtTime(freq, t0)
  flt.frequency.exponentialRampToValueAtTime(freq * 3, t0 + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.3)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  src.connect(flt).connect(g).connect(out)
  src.start(t0)
}

const SOUNDS: Record<string, (c: AudioContext, o: AudioNode, t: number) => void> = {
  chime: (c, o, t) => [784, 988, 1319].forEach((f, i) => tone(c, o, f, t + i * 0.11, 0.9, 'sine', 0.35)),
  coin: (c, o, t) => { tone(c, o, 988, t, 0.08, 'square', 0.18); tone(c, o, 1319, t + 0.08, 0.5, 'square', 0.18) },
  pop: (c, o, t) => tone(c, o, 420, t, 0.16, 'sine', 0.5, 900),
  fire: (c, o, t) => { noise(c, o, t, 1.2, 0.6, 500); tone(c, o, 196, t + 0.1, 1.1, 'triangle', 0.25, 392) },
  fanfare: (c, o, t) => {
    for (const [f, d] of [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.4]]) {
      tone(c, o, f, t + d, d === 0.4 ? 1.1 : 0.2, 'sawtooth', 0.12)
      tone(c, o, f / 2, t + d, d === 0.4 ? 1.1 : 0.2, 'triangle', 0.2)
    }
  }
}

/** Сыграть встроенный звук (volume 0…1). Свои файлы проверяются тестовым алертом в OBS. */
export function playBuiltin(name: string, volume: number): void {
  const fn = SOUNDS[name]
  if (!fn || volume <= 0) return
  ctx = ctx ?? new AudioContext()
  void ctx.resume()
  const out = ctx.createGain()
  out.gain.value = Math.min(1, volume)
  out.connect(ctx.destination)
  fn(ctx, out, ctx.currentTime + 0.02)
}
