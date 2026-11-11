import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { AlertTemplate, AnimPreset, Ease, Keyframe, Layer, LayerType, ObsAction } from '../../../main/core/templates'
import { Hint, Toggle, errText } from '../components'
import { ObsActionEditor, SoundSelect, VoiceSelect, kit, previewSound, previewTts, serverUrl, type KitHandle } from '../editors'
import { playBuiltin } from '../sounds'

// ---------- значения по умолчанию (как в core/templates.ts newLayer) ----------
const LAYER_LABEL: Record<LayerType, string> = { card: 'Карточка', text: 'Текст', image: 'Картинка', video: 'Видео', sound: 'Звук', tts: 'Озвучка', obs: 'Действие OBS' }
const LAYER_ICO: Record<LayerType, string> = { card: '▭', text: 'T', image: '▧', video: '▶', sound: '♪', tts: '🗣', obs: '⚙' }
const VISUAL: LayerType[] = ['card', 'text', 'image', 'video']
const ANIMS: { id: AnimPreset; label: string }[] = [
  { id: 'none', label: 'Нет' }, { id: 'fade', label: 'Проявление' }, { id: 'up', label: 'Снизу' }, { id: 'down', label: 'Сверху' },
  { id: 'left', label: 'Справа' }, { id: 'right', label: 'Слева' }, { id: 'zoom', label: 'Увеличение' }, { id: 'pop', label: 'Выпрыгивание' }, { id: 'spin', label: 'Вращение' }
]
const EASES: { id: Ease; label: string }[] = [
  { id: 'ease', label: 'Плавно' }, { id: 'linear', label: 'Равномерно' }, { id: 'in', label: 'Разгон' }, { id: 'out', label: 'Торможение' },
  { id: 'inout', label: 'Разгон и торможение' }, { id: 'back', label: 'С отскоком' }
]
const KINDS = [
  { id: 'donation', label: 'Донат' }, { id: 'sub', label: 'Подписка' }, { id: 'follow', label: 'Фоллоу' }, { id: 'raid', label: 'Рейд' },
  { id: 'gift', label: 'Подарки' }, { id: 'bits', label: 'Биты' }, { id: 'reward', label: 'Баллы' }
]
const SAMPLE: Record<string, { user: string; amount: string; message: string; platform: string }> = {
  donation: { user: 'Тестовый зритель', amount: '500 ₽', message: 'Привет со стрима! 🔥', platform: 'DonationAlerts' },
  sub: { user: 'night_raven', amount: '', message: '3 мес. вместе', platform: 'Twitch' },
  follow: { user: 'pixel_fox', amount: '', message: '', platform: 'Twitch' },
  raid: { user: 'kostya_play', amount: '42', message: '', platform: 'Twitch' },
  gift: { user: 'santa_claws', amount: '5 подписок', message: '', platform: 'Twitch' },
  bits: { user: 'bit_master', amount: '300 бит', message: 'Держи биты!', platform: 'Twitch' },
  reward: { user: 'lucky_cat', amount: '', message: 'Спой песню', platform: 'Twitch' }
}

const uid = (): string => crypto.randomUUID()

export function makeLayer(type: LayerType, patch: Partial<Layer> = {}): Layer {
  const card = type === 'card'
  const visual = VISUAL.includes(type)
  return {
    id: uid(), type, name: LAYER_LABEL[type], hidden: false, start: 0, duration: 0,
    x: card ? 260 : 660, y: card ? 200 : 340, w: card ? 1400 : 600, h: card ? 260 : type === 'text' ? 120 : 400, rotate: 0, opacity: 1,
    animIn: visual ? (card ? 'pop' : 'fade') : 'none', animInMs: 450, animOut: visual ? 'fade' : 'none', animOutMs: 450, keyframes: [],
    text: card ? '{user} — {amount}' : type === 'tts' ? '{user} — {amount}. {message}' : type === 'text' ? '{user}' : '',
    kicker: card ? 'Новый донат' : '', showMessage: true, font: type === 'text' ? 'unbounded' : 'manrope', size: 56, color: '#ffffff', accent: '',
    align: 'center', bold: true, shadow: true, stroke: 0, media: '', fit: 'contain', loop: false, sound: type === 'sound' ? 'coin' : 'none', volume: 80,
    voice: '', rate: 0, obs: { op: 'source', scene: '', source: '', filter: '', mode: 'show', media: 'restart', text: '', revertSec: 0 },
    ...patch
  }
}

export function blankTemplate(): AlertTemplate {
  return { id: uid(), name: 'Новый алерт', theme: 'auto', durationMs: 6000, extendByMessage: true, layers: [makeLayer('card'), makeLayer('sound')] }
}

// ---------- сборка предпросмотра (как AlertEngine.enqueue, но на тестовых данных) ----------
type Part = { t: 'text' | 'amount'; v: string }
function parts(tpl: string, s: (typeof SAMPLE)[string]): Part[] {
  const out: Part[] = []
  for (const p of tpl.split(/(\{user\}|\{amount\}|\{message\}|\{platform\})/)) {
    if (!p) continue
    if (p === '{user}') out.push({ t: 'text', v: s.user })
    else if (p === '{amount}') { if (s.amount) out.push({ t: 'amount', v: s.amount }) }
    else if (p === '{message}') { if (s.message) out.push({ t: 'text', v: s.message }) }
    else if (p === '{platform}') out.push({ t: 'text', v: s.platform })
    else out.push({ t: 'text', v: p })
  }
  return out
}
const fillText = (tpl: string, s: (typeof SAMPLE)[string]): string => parts(tpl, s).map((p) => p.v).join('')

export function previewItem(t: AlertTemplate, kind: string, volume: number): unknown {
  const s = SAMPLE[kind] ?? SAMPLE.donation
  const extra = t.extendByMessage && s.message ? Math.min(s.message.length * 40, 5000) : 0
  return {
    id: 'preview', kind, theme: t.theme, durationMs: t.durationMs + extra, test: true,
    layers: t.layers.filter((l) => !l.hidden).map((l) => ({
      ...l,
      parts: l.type === 'card' || l.type === 'text' ? parts(l.text, s) : undefined,
      kickerText: l.type === 'card' ? fillText(l.kicker, s) : undefined,
      message: l.type === 'card' && l.showMessage && s.message ? s.message : null,
      src: (l.type === 'image' || l.type === 'video') && l.media ? `/m/${l.media.slice(2)}` : l.type === 'sound' && l.sound.startsWith('custom:') ? `/s/${l.sound.slice(7)}` : undefined,
      builtin: l.type === 'sound' && l.sound !== 'none' && !l.sound.startsWith('custom:') ? l.sound : undefined,
      vol: (l.volume / 100) * volume
    }))
  }
}

const totalMs = (t: AlertTemplate, kind: string): number => {
  const s = SAMPLE[kind] ?? SAMPLE.donation
  return t.durationMs + (t.extendByMessage && s.message ? Math.min(s.message.length * 40, 5000) : 0)
}
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const sec = (ms: number): string => `${(ms / 1000).toFixed(ms % 1000 ? 2 : 0)} с`

// ---------- редактор ----------
export function AlertEditor({ initial, snap, onClose }: { initial: AlertTemplate; snap: HubSnapshot; onClose: () => void }) {
  const [t, setT] = useState<AlertTemplate>(initial)
  const [saved, setSaved] = useState(JSON.stringify(initial))
  const [history, setHistory] = useState<AlertTemplate[]>([])
  const [sel, setSel] = useState<string | null>(initial.layers[0]?.id ?? null)
  const [selKf, setSelKf] = useState<number | null>(null)
  const [time, setTime] = useState(800)
  const [kind, setKind] = useState('donation')
  const [playing, setPlaying] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const exists = snap.templates.some((x) => x.id === t.id)
  const dirty = JSON.stringify(t) !== saved || !exists
  const total = totalMs(t, kind)
  const layer = t.layers.find((l) => l.id === sel) ?? null
  const volume = snap.settings.alerts.volume / 100
  const theme = snap.settings.overlays.alert.theme

  /** Изменить шаблон; snapshot=true — запомнить для «Отменить». */
  const change = (next: AlertTemplate, snapshot = true): void => {
    if (snapshot) setHistory((h) => [...h.slice(-49), t])
    setT(next)
  }
  const undo = (): void => {
    const prev = history.at(-1)
    if (!prev) return
    setHistory((h) => h.slice(0, -1))
    setT(prev)
  }
  const setLayer = (id: string, p: Partial<Layer>, snapshot = true): void =>
    change({ ...t, layers: t.layers.map((l) => (l.id === id ? { ...l, ...p } : l)) }, snapshot)

  const save = (): void => {
    setMsg(null)
    window.hub.templatePut(t).then((r) => { setT(r); setSaved(JSON.stringify(r)); setMsg('Сохранено') }).catch((e) => setMsg(errText(e)))
  }

  // Ctrl+Z / Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const inField = (e.target as HTMLElement)?.closest('input, textarea, select')
      if (e.code === 'KeyZ' && !inField) { e.preventDefault(); undo() }
      if (e.code === 'KeyS') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const addLayer = (type: LayerType): void => {
    const l = makeLayer(type)
    if (type === 'tts') l.start = 600
    change({ ...t, layers: [...t.layers, l] })
    setSel(l.id)
    setSelKf(null)
  }
  const removeLayer = (id: string): void => {
    change({ ...t, layers: t.layers.filter((l) => l.id !== id) })
    if (sel === id) setSel(null)
  }
  /** Сдвинуть слой вперёд (+1, ближе к зрителю) или назад (−1). */
  const zMove = (id: string, dir: number): void => {
    const i = t.layers.findIndex((l) => l.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= t.layers.length) return
    const layers = [...t.layers]
    ;[layers[i], layers[j]] = [layers[j], layers[i]]
    change({ ...t, layers })
  }

  return (
    <div className="ed">
      <div className="ed-top">
        <button className="btn sm" onClick={() => (dirty && exists ? setLeaving(true) : dirty ? setLeaving(true) : onClose())}>← К алертам</button>
        <input className="input ed-name" value={t.name} maxLength={60} onChange={(e) => change({ ...t, name: e.target.value }, false)} />
        {dirty ? <span className="tag warn">Есть изменения</span> : <span className="tag">Сохранено</span>}
        <div className="btnrow" style={{ marginLeft: 'auto' }}>
          <button className="btn sm" disabled={!history.length} title="Отменить (Ctrl+Z)" onClick={undo}>↶ Отменить</button>
          <select className="input sm" value={kind} title="На каком событии показывать предпросмотр" onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>Пример: {k.label}</option>)}
          </select>
          <button className="btn sm" title="Показать в оверлее OBS (с озвучкой и действиями OBS)" onClick={() => { setMsg(null); window.hub.templateTest(t, kind).then(() => setMsg('Отправлено в оверлей')).catch((e) => setMsg(errText(e))) }}>Тест в OBS</button>
          <button className="btn sm primary" onClick={save} title="Ctrl+S">Сохранить</button>
        </div>
      </div>
      {leaving && (
        <div className="note warnbox btnrow" style={{ marginBottom: 10 }}>
          Есть несохранённые изменения.
          <button className="btn sm primary" onClick={() => { window.hub.templatePut(t).then(onClose).catch((e) => setMsg(errText(e))) }}>Сохранить и выйти</button>
          <button className="btn sm" onClick={onClose}>Выйти без сохранения</button>
          <button className="btn sm" onClick={() => setLeaving(false)}>Остаться</button>
        </div>
      )}
      {msg && <p className="small muted" style={{ margin: '0 0 8px' }}>{msg}</p>}

      <div className="ed-main">
        <LayerList t={t} sel={sel} onSel={(id) => { setSel(id); setSelKf(null) }} onAdd={addLayer} onRemove={removeLayer} onZ={zMove}
          onToggle={(id, hidden) => setLayer(id, { hidden })} />
        <Canvas t={t} kind={kind} time={time} total={total} playing={playing} sel={sel} snap={snap} theme={theme} volume={volume}
          onSel={(id) => { setSel(id); setSelKf(null) }}
          onPlayEnd={() => setPlaying(false)} onTick={setTime}
          onBegin={() => setHistory((h) => [...h.slice(-49), t])}
          onLayer={(id, p) => setLayer(id, p, false)} />
        <div className="ed-props">
          {layer
            ? <LayerProps key={layer.id} l={layer} t={t} time={time} total={total} snap={snap} kind={kind} selKf={selKf} setSelKf={setSelKf}
                onChange={(p, s) => setLayer(layer.id, p, s)} />
            : <TemplateProps t={t} onChange={(p) => change({ ...t, ...p })} />}
        </div>
      </div>

      <Timeline t={t} total={total} time={time} sel={sel} selKf={selKf} playing={playing}
        onTime={(ms) => { setPlaying(false); setTime(ms) }}
        onPlay={() => { if (playing) setPlaying(false); else { setTime(0); setPlaying(true) } }}
        onSel={(id, kf) => { setSel(id); setSelKf(kf) }}
        onBegin={() => setHistory((h) => [...h.slice(-49), t])}
        onLayer={(id, p) => setLayer(id, p, false)}
        onDuration={(ms) => change({ ...t, durationMs: ms })} />
    </div>
  )
}

// ---------- список слоёв ----------
function LayerList({ t, sel, onSel, onAdd, onRemove, onZ, onToggle }: {
  t: AlertTemplate; sel: string | null; onSel: (id: string | null) => void; onAdd: (type: LayerType) => void
  onRemove: (id: string) => void; onZ: (id: string, dir: number) => void; onToggle: (id: string, hidden: boolean) => void
}) {
  const [confirm, setConfirm] = useState<string | null>(null)
  const list = [...t.layers].reverse()
  return (
    <div className="ed-layers">
      <div className="ed-sec">Слои <Hint id="edLayers" /></div>
      <div className="ed-add">
        {(Object.keys(LAYER_LABEL) as LayerType[]).map((k) => <button key={k} className="btn sm" title={`Добавить: ${LAYER_LABEL[k]}`} onClick={() => onAdd(k)}>{LAYER_ICO[k]} {LAYER_LABEL[k]}</button>)}
      </div>
      <div className="ed-llist">
        <button className={`ed-lrow ${sel === null ? 'on' : ''}`} onClick={() => onSel(null)}><span className="ico">◫</span><span className="grow">Весь алерт</span></button>
        {list.map((l) => (
          <div key={l.id} className={`ed-lrow ${sel === l.id ? 'on' : ''} ${l.hidden ? 'off' : ''}`} onClick={() => onSel(l.id)}>
            <button className="eye" title={l.hidden ? 'Включить слой' : 'Выключить слой'} onClick={(e) => { e.stopPropagation(); onToggle(l.id, !l.hidden) }}>{l.hidden ? '○' : '●'}</button>
            <span className="ico">{LAYER_ICO[l.type]}</span>
            <span className="grow ellipsis">{l.name}</span>
            {sel === l.id && <>
              <button title="Выше (поверх других)" onClick={(e) => { e.stopPropagation(); onZ(l.id, 1) }}>↑</button>
              <button title="Ниже" onClick={(e) => { e.stopPropagation(); onZ(l.id, -1) }}>↓</button>
              {confirm === l.id
                ? <button className="danger" onClick={(e) => { e.stopPropagation(); setConfirm(null); onRemove(l.id) }}>удалить?</button>
                : <button title="Удалить слой" onClick={(e) => { e.stopPropagation(); setConfirm(l.id) }}>✕</button>}
            </>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- холст ----------
function Canvas({ t, kind, time, total, playing, sel, snap, theme, volume, onSel, onPlayEnd, onTick, onBegin, onLayer }: {
  t: AlertTemplate; kind: string; time: number; total: number; playing: boolean; sel: string | null; snap: HubSnapshot; theme: string; volume: number
  onSel: (id: string | null) => void; onPlayEnd: () => void; onTick: (ms: number) => void; onBegin: () => void; onLayer: (id: string, p: Partial<Layer>) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const handle = useRef<KitHandle | null>(null)
  const [k, setK] = useState(0.4)
  const item = useMemo(() => previewItem(t, kind, volume), [t, kind, volume])
  const url = (src: string): string => serverUrl(snap, src)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setK(el.clientWidth / 1920))
    ro.observe(el)
    setK(el.clientWidth / 1920)
    return () => ro.disconnect()
  }, [])

  // Кадр в момент time (перемотка) или живое проигрывание.
  useEffect(() => {
    if (!stageRef.current) return
    handle.current?.stop()
    if (playing) {
      handle.current = kit().mount(stageRef.current, item, { url, theme, playBuiltin: (id, v) => playBuiltin(id, v) })
      const t0 = performance.now()
      let raf = 0
      const step = (): void => {
        const el = performance.now() - t0
        onTick(Math.min(el, total))
        if (el >= total + 200) { onPlayEnd(); return }
        raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
      return () => { cancelAnimationFrame(raf); handle.current?.stop(); handle.current = null }
    }
    handle.current = kit().mount(stageRef.current, item, { url, theme, paused: true, startAt: time, editor: true })
    return () => { handle.current?.stop(); handle.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, playing, theme])

  useEffect(() => { if (!playing) handle.current?.seek(time) }, [time, playing])

  // Перетаскивание: переместить или изменить размер.
  const drag = useRef<{ id: string; mode: 'move' | 'size'; x0: number; y0: number; l: Layer } | null>(null)
  const down = (e: RPointerEvent, l: Layer, mode: 'move' | 'size'): void => {
    e.stopPropagation()
    onSel(l.id)
    if (playing) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    onBegin()
    drag.current = { id: l.id, mode, x0: e.clientX, y0: e.clientY, l }
  }
  const move = (e: RPointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x0) / k
    const dy = (e.clientY - d.y0) / k
    const l = d.l
    if (d.mode === 'size') {
      onLayer(l.id, { w: Math.round(clamp(l.w + dx, 10, 4000)), h: Math.round(clamp(l.h + dy, 10, 4000)) })
      return
    }
    if (!l.keyframes.length) {
      onLayer(l.id, { x: Math.round(l.x + dx), y: Math.round(l.y + dy) })
      return
    }
    // Есть анимация — двигаем ключевой кадр в текущем моменте (создаём, если его нет).
    onLayer(l.id, { keyframes: setKeyAt(l, time, total, (s) => ({ ...s, x: Math.round(s.x + dx), y: Math.round(s.y + dy) })) })
  }
  const up = (): void => { drag.current = null }

  const visual = t.layers.filter((l) => !l.hidden && VISUAL.includes(l.type))
  return (
    <div className="ed-canvas" onPointerDown={() => onSel(null)}>
      <div ref={wrapRef} className="ed-wrap" style={{ height: 1080 * k }}>
        <div className="ed-scale" style={{ transform: `scale(${k})` }}>
          <div ref={stageRef} className="ak-stage ed-stage" />
          {!playing && (
            <div className="ed-handles" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
              {visual.map((l) => {
                const local = time - l.start
                const dur = kit().layerDur(l, total)
                const active = local >= 0 && local <= dur
                const s = kit().sample(l, clamp(local, 0, dur))
                return (
                  <div key={l.id} className={`ed-box ${sel === l.id ? 'on' : ''} ${active ? '' : 'idle'}`}
                    style={{ width: l.w, height: l.h, transform: `translate(${s.x}px, ${s.y}px) rotate(${s.rotate}deg) scale(${s.scale})` }}
                    onPointerDown={(e) => down(e, l, 'move')}>
                    {sel === l.id && <>
                      <span className="ed-label" style={{ transform: `scale(${1 / k})` }}>{l.name}{l.keyframes.length ? ' · ◆ анимация' : ''}{active ? '' : ' · сейчас не виден'}</span>
                      <span className="ed-size" style={{ transform: `scale(${1 / k})` }} onPointerDown={(e) => down(e, l, 'size')} />
                    </>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Холст 1920×1080 — как источник «Браузер» в OBS. Тяните слой мышкой, уголок справа внизу — размер. Звук в предпросмотре — встроенный и свои файлы; озвучку слышно в «Тест в OBS».
      </p>
    </div>
  )
}

/** Изменить (или создать) ключевой кадр слоя в момент time. */
function setKeyAt(l: Layer, time: number, total: number, fn: (s: Keyframe) => Keyframe): Keyframe[] {
  const dur = kit().layerDur(l, total)
  const local = Math.round(clamp(time - l.start, 0, dur))
  const i = l.keyframes.findIndex((f) => Math.abs(f.t - local) < 15)
  if (i >= 0) return l.keyframes.map((f, j) => (j === i ? fn(f) : f))
  const s = kit().sample(l, local)
  const base: Keyframe = { t: local, x: Math.round(s.x), y: Math.round(s.y), scale: Math.round(s.scale * 1000) / 1000, rotate: Math.round(s.rotate), opacity: Math.round(s.opacity * 1000) / 1000, ease: 'ease' }
  return [...l.keyframes, fn(base)].sort((a, b) => a.t - b.t)
}

// ---------- таймлайн ----------
function Timeline({ t, total, time, sel, selKf, playing, onTime, onPlay, onSel, onBegin, onLayer, onDuration }: {
  t: AlertTemplate; total: number; time: number; sel: string | null; selKf: number | null; playing: boolean
  onTime: (ms: number) => void; onPlay: () => void; onSel: (id: string, kf: number | null) => void; onBegin: () => void
  onLayer: (id: string, p: Partial<Layer>) => void; onDuration: (ms: number) => void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(800)
  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const span = Math.max(total, ...t.layers.map((l) => l.start + (l.duration || 0))) + 500
  const px = w / span
  const snapMs = (ms: number): number => Math.round(ms / 50) * 50

  const drag = useRef<{ kind: 'head' | 'move' | 'l' | 'r' | 'kf'; id?: string; kf?: number; x0: number; l?: Layer } | null>(null)
  const start = (e: RPointerEvent, d: NonNullable<typeof drag.current>): void => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    if (d.kind !== 'head') onBegin()
    drag.current = d
  }
  const moveTo = (e: RPointerEvent): void => {
    const d = drag.current
    if (!d) return
    const rect = trackRef.current!.getBoundingClientRect()
    if (d.kind === 'head') { onTime(snapMs(clamp((e.clientX - rect.left) / px, 0, span))); return }
    const dms = snapMs((e.clientX - d.x0) / px)
    const l = d.l!
    if (d.kind === 'move') onLayer(l.id, { start: clamp(l.start + dms, 0, 120000) })
    else if (d.kind === 'r') {
      const cur = l.duration || Math.max(100, total - l.start)
      onLayer(l.id, { duration: clamp(cur + dms, 100, 120000) })
    } else if (d.kind === 'l') {
      const end = l.start + (l.duration || Math.max(100, total - l.start))
      const ns = clamp(l.start + dms, 0, end - 100)
      onLayer(l.id, { start: ns, duration: l.duration ? end - ns : 0 })
    } else if (d.kind === 'kf' && d.kf !== undefined) {
      const dur = kit().layerDur(l, total)
      const kfs = l.keyframes.map((f, i) => (i === d.kf ? { ...f, t: clamp(l.keyframes[d.kf!].t + dms, 0, dur) } : f))
      onLayer(l.id, { keyframes: kfs })
    }
  }
  const end = (): void => {
    const d = drag.current
    drag.current = null
    // После перетаскивания кадра — упорядочить кадры по времени.
    if (d?.kind === 'kf' && d.l) {
      const l = t.layers.find((x) => x.id === d.l!.id)
      if (l) {
        const moved = l.keyframes[d.kf!]
        const sorted = [...l.keyframes].sort((a, b) => a.t - b.t)
        onLayer(l.id, { keyframes: sorted })
        onSel(l.id, sorted.indexOf(moved))
      }
    }
  }

  const ticks: number[] = []
  for (let ms = 0; ms <= span; ms += 500) ticks.push(ms)
  const list = [...t.layers].reverse()

  return (
    <div className="ed-tl">
      <div className="ed-tl-bar">
        <button className="btn sm" onClick={onPlay}>{playing ? '■ Стоп' : '▶ Проиграть'}</button>
        <span className="mono">{sec(time)} / {sec(total)}</span>
        <label className="small muted">Длина алерта
          <input className="input mono sm" type="number" min={1} max={120} step={0.5} defaultValue={t.durationMs / 1000} key={t.durationMs}
            onBlur={(e) => { const v = Math.round(clamp(Number(e.target.value) || 6, 1, 120) * 1000); if (v !== t.durationMs) onDuration(v) }} /> с
        </label>
        <span className="small muted">Тяните полоску — сдвиг, края — начало и длина, ◆ — ключевые кадры. <Hint id="edTimeline" /></span>
      </div>
      <div className="ed-tl-grid" onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end}>
        <div className="ed-tl-names">
          <div className="ed-tl-ruler-name" />
          {list.map((l) => <div key={l.id} className={`ed-tl-name ${sel === l.id ? 'on' : ''} ${l.hidden ? 'off' : ''}`} onClick={() => onSel(l.id, null)}>{LAYER_ICO[l.type]} {l.name}</div>)}
        </div>
        <div className="ed-tl-tracks" ref={trackRef}>
          <div className="ed-tl-ruler" onPointerDown={(e) => { start(e, { kind: 'head', x0: e.clientX }); moveTo(e) }}>
            {ticks.map((ms) => <span key={ms} className={ms % 1000 ? 'half' : ''} style={{ left: ms * px }}>{ms % 1000 ? '' : `${ms / 1000}`}</span>)}
            <span className="end" style={{ left: total * px }} title="Конец алерта" />
          </div>
          {list.map((l) => {
            const dur = kit().layerDur(l, total)
            return (
              <div key={l.id} className="ed-tl-row">
                <div className={`ed-tl-clip t-${l.type} ${sel === l.id ? 'on' : ''} ${l.duration ? '' : 'auto'} ${l.hidden ? 'off' : ''}`}
                  style={{ left: l.start * px, width: Math.max(6, dur * px) }}
                  onPointerDown={(e) => { onSel(l.id, null); start(e, { kind: 'move', id: l.id, x0: e.clientX, l }) }}>
                  {VISUAL.includes(l.type) && l.animIn !== 'none' && <span className="anim in" style={{ width: Math.min(l.animInMs, dur) * px }} />}
                  {VISUAL.includes(l.type) && l.animOut !== 'none' && <span className="anim out" style={{ width: Math.min(l.animOutMs, dur) * px }} />}
                  <span className="ed-tl-h l" onPointerDown={(e) => { onSel(l.id, null); start(e, { kind: 'l', id: l.id, x0: e.clientX, l }) }} />
                  <span className="ed-tl-h r" title={l.duration ? '' : 'До конца алерта — потяните, чтобы задать длину'} onPointerDown={(e) => { onSel(l.id, null); start(e, { kind: 'r', id: l.id, x0: e.clientX, l }) }} />
                  {l.keyframes.map((f, i) => (
                    <span key={i} className={`kf ${sel === l.id && selKf === i ? 'on' : ''}`} style={{ left: f.t * px }} title={`Кадр ${sec(f.t)}`}
                      onPointerDown={(e) => { onSel(l.id, i); onTime(l.start + f.t); start(e, { kind: 'kf', id: l.id, kf: i, x0: e.clientX, l }) }} />
                  ))}
                </div>
              </div>
            )
          })}
          <div className="ed-tl-head" style={{ left: time * px }} />
        </div>
      </div>
    </div>
  )
}

// ---------- свойства ----------
function Field({ label, children, span }: { label: ReactNode; children: ReactNode; span?: boolean }) {
  return <div className="field" style={{ margin: 0, gridColumn: span ? '1 / -1' : undefined }}><label>{label}</label>{children}</div>
}

/** Числовое поле: применяется по Enter или при уходе с поля. */
function N({ value, onChange, min = -100000, max = 100000, step = 1 }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const apply = (): void => {
    const n = clamp(Number(v), min, max)
    if (!Number.isFinite(n)) return setV(String(value))
    if (n !== value) onChange(step < 1 ? Math.round(n * 1000) / 1000 : Math.round(n))
  }
  return <input className="input mono" type="number" value={v} min={min} max={max} step={step} onChange={(e) => setV(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
}

function T({ value, onChange, max = 300, area }: { value: string; onChange: (s: string) => void; max?: number; area?: boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return area
    ? <textarea className="input" rows={3} value={v} maxLength={max} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)} />
    : <input className="input" value={v} maxLength={max} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onChange(v)} />
}

function TemplateProps({ t, onChange }: { t: AlertTemplate; onChange: (p: Partial<AlertTemplate>) => void }) {
  return (
    <>
      <div className="ed-sec">Весь алерт</div>
      <div className="ed-fields">
        <Field label="Оформление карточки" span>
          <select className="input" value={t.theme} onChange={(e) => onChange({ theme: e.target.value as AlertTemplate['theme'] })}>
            <option value="auto">Как у оверлея «Алерты»</option><option value="general">Общий</option><option value="campfire">У костра</option>
          </select>
        </Field>
        <Field label="Длина, сек"><N value={t.durationMs / 1000} min={1} max={120} step={0.5} onChange={(n) => onChange({ durationMs: Math.round(n * 1000) })} /></Field>
      </div>
      <Toggle on={t.extendByMessage} onChange={(v) => onChange({ extendByMessage: v })} label="Удлинять на время чтения сообщения (до +5 с)" />
      <p className="small muted">Слои с длиной «до конца» растягиваются вместе с алертом. Если озвучка длиннее алерта, он сам продлится, пока голос не договорит.</p>
      <p className="small muted">Подстановки в текстах: <code>{'{user}'}</code> ник, <code>{'{amount}'}</code> сумма, <code>{'{message}'}</code> сообщение, <code>{'{platform}'}</code> площадка.</p>
    </>
  )
}

function LayerProps({ l, t, time, total, snap, kind, selKf, setSelKf, onChange }: {
  l: Layer; t: AlertTemplate; time: number; total: number; snap: HubSnapshot; kind: string; selKf: number | null
  setSelKf: (i: number | null) => void; onChange: (p: Partial<Layer>, snapshot?: boolean) => void
}) {
  const [err, setErr] = useState<string | null>(null)
  const visual = VISUAL.includes(l.type)
  const dur = kit().layerDur(l, total)
  const local = clamp(time - l.start, 0, dur)
  const s = kit().sample(l, local)
  const animated = l.keyframes.length > 0
  /** Поле положения/вида: без анимации меняет слой, с анимацией — кадр в текущем моменте. */
  const setPose = (p: Partial<Keyframe>): void => {
    if (!animated) {
      const q: Partial<Layer> = {}
      if (p.x !== undefined) q.x = p.x
      if (p.y !== undefined) q.y = p.y
      if (p.rotate !== undefined) q.rotate = p.rotate
      if (p.opacity !== undefined) q.opacity = p.opacity
      onChange(q)
    } else onChange({ keyframes: setKeyAt(l, time, total, (f) => ({ ...f, ...p })) })
  }
  const addKey = (): void => {
    const kfs = setKeyAt(l, time, total, (f) => f)
    // Первый кадр — добавить и стартовую точку, чтобы было откуда двигаться.
    onChange({ keyframes: kfs })
    setSelKf(kfs.findIndex((f) => Math.abs(f.t - Math.round(local)) < 15))
  }
  const media = snap.media.filter((m) => m.kind === (l.type === 'video' ? 'video' : 'image'))
  const addMedia = (): void => {
    setErr(null)
    window.hub.mediaAdd().then((m) => { if (m) onChange({ media: m.id }) }).catch((e) => setErr(errText(e)))
  }

  return (
    <>
      <div className="ed-sec">{LAYER_ICO[l.type]} {LAYER_LABEL[l.type]}</div>
      <div className="ed-fields">
        <Field label="Название" span><T value={l.name} max={40} onChange={(v) => onChange({ name: v })} /></Field>
        <Field label="Начало, сек"><N value={l.start / 1000} min={0} max={120} step={0.05} onChange={(n) => onChange({ start: Math.round(n * 1000) })} /></Field>
        <Field label="Длина, сек · 0 = до конца"><N value={l.duration / 1000} min={0} max={120} step={0.05} onChange={(n) => onChange({ duration: Math.round(n * 1000) })} /></Field>
      </div>

      {l.type === 'card' && <>
        <div className="ed-sub">Текст карточки</div>
        <div className="ed-fields">
          <Field label="Верхняя строка" span><T value={l.kicker} max={60} onChange={(v) => onChange({ kicker: v })} /></Field>
          <Field label="Главная строка" span><T value={l.text} max={120} onChange={(v) => onChange({ text: v })} /></Field>
          <Field label="Размер"><N value={l.size} min={8} max={400} onChange={(n) => onChange({ size: n })} /></Field>
          <Field label="Выравнивание"><Align value={l.align} onChange={(a) => onChange({ align: a })} /></Field>
          <Field label="Цвет суммы" span><ColorPick value={l.accent} allowEmpty onChange={(c) => onChange({ accent: c })} /></Field>
        </div>
        <Toggle on={l.showMessage} onChange={(v) => onChange({ showMessage: v })} label="Показывать сообщение зрителя" />
      </>}

      {l.type === 'text' && <>
        <div className="ed-sub">Текст</div>
        <div className="ed-fields">
          <Field label="Текст" span><T area value={l.text} onChange={(v) => onChange({ text: v })} /></Field>
          <Field label="Шрифт">
            <select className="input" value={l.font} onChange={(e) => onChange({ font: e.target.value as Layer['font'] })}>
              <option value="unbounded">Unbounded</option><option value="manrope">Manrope</option><option value="mono">JetBrains Mono</option>
            </select>
          </Field>
          <Field label="Размер, px"><N value={l.size} min={8} max={400} onChange={(n) => onChange({ size: n })} /></Field>
          <Field label="Цвет"><ColorPick value={l.color} onChange={(c) => onChange({ color: c || '#ffffff' })} /></Field>
          <Field label="Цвет суммы"><ColorPick value={l.accent} allowEmpty onChange={(c) => onChange({ accent: c })} /></Field>
          <Field label="Выравнивание"><Align value={l.align} onChange={(a) => onChange({ align: a })} /></Field>
          <Field label="Обводка, px"><N value={l.stroke} min={0} max={20} onChange={(n) => onChange({ stroke: n })} /></Field>
        </div>
        <Toggle on={l.bold} onChange={(v) => onChange({ bold: v })} label="Жирный" />
        <Toggle on={l.shadow} onChange={(v) => onChange({ shadow: v })} label="Тень" />
      </>}

      {(l.type === 'image' || l.type === 'video') && <>
        <div className="ed-sub">{l.type === 'image' ? 'Картинка или GIF' : 'Видео (webm с прозрачностью или mp4)'}</div>
        <div className="ed-fields">
          <Field label="Файл" span>
            <select className="input" value={l.media} onChange={(e) => onChange({ media: e.target.value })}>
              <option value="">— не выбран —</option>
              {media.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Вписать">
            <select className="input" value={l.fit} onChange={(e) => onChange({ fit: e.target.value as Layer['fit'] })}>
              <option value="contain">Целиком</option><option value="cover">Заполнить</option><option value="fill">Растянуть</option>
            </select>
          </Field>
          {l.type === 'video' && <Field label="Громкость, %"><N value={l.volume} min={0} max={100} onChange={(n) => onChange({ volume: n })} /></Field>}
        </div>
        <div className="btnrow"><button className="btn sm" onClick={addMedia}>+ Добавить файл</button>
          {l.type === 'video' && <Toggle on={l.loop} onChange={(v) => onChange({ loop: v })} label="По кругу" />}</div>
        {err && <p className="small" style={{ color: '#ff7a84' }}>{err}</p>}
      </>}

      {l.type === 'sound' && <>
        <div className="ed-sub">Звук</div>
        <div className="ed-fields">
          <Field label="Звук" span><SoundSelect snap={snap} value={l.sound} onChange={(v) => onChange({ sound: v })} /></Field>
          <Field label="Громкость, %"><N value={l.volume} min={0} max={100} onChange={(n) => onChange({ volume: n })} /></Field>
          <Field label=" "><button className="btn sm" onClick={() => previewSound(snap, l.sound, (l.volume / 100) * (snap.settings.alerts.volume / 100))}>▶ Послушать</button></Field>
        </div>
      </>}

      {l.type === 'tts' && <>
        <div className="ed-sub">Озвучка <Hint id="tts" /></div>
        <div className="ed-fields">
          <Field label="Что читать" span><T area value={l.text} onChange={(v) => onChange({ text: v })} /></Field>
          <Field label="Голос" span><VoiceSelect allowDefault value={l.voice} onChange={(v) => onChange({ voice: v })} /></Field>
          <Field label="Скорость (0 — из настроек)"><N value={l.rate} min={-10} max={10} onChange={(n) => onChange({ rate: n })} /></Field>
          <Field label="Громкость, %"><N value={l.volume} min={0} max={100} onChange={(n) => onChange({ volume: n })} /></Field>
        </div>
        <button className="btn sm" onClick={() => { setErr(null); previewTts(snap, fillText(l.text, SAMPLE[kind] ?? SAMPLE.donation)).catch((e) => setErr(errText(e))) }}>▶ Послушать на примере</button>
        {err && <p className="small" style={{ color: '#ff7a84' }}>{err}</p>}
      </>}

      {l.type === 'obs' && <>
        <div className="ed-sub">Действие в OBS в момент начала слоя</div>
        <ObsActionEditor value={l.obs} onChange={(o: ObsAction) => onChange({ obs: o })} />
      </>}

      {visual && <>
        <div className="ed-sub">Положение {animated && <span className="tag">◆ анимация</span>}</div>
        {animated && <p className="small muted" style={{ marginTop: 0 }}>Поля и перетаскивание меняют ключевой кадр в текущем моменте ({sec(Math.round(local))} от начала слоя).</p>}
        <div className="ed-fields">
          <Field label="X"><N value={Math.round(s.x)} onChange={(n) => setPose({ x: n })} /></Field>
          <Field label="Y"><N value={Math.round(s.y)} onChange={(n) => setPose({ y: n })} /></Field>
          <Field label="Ширина"><N value={l.w} min={10} max={4000} onChange={(n) => onChange({ w: n })} /></Field>
          <Field label="Высота"><N value={l.h} min={10} max={4000} onChange={(n) => onChange({ h: n })} /></Field>
          <Field label="Поворот, °"><N value={Math.round(s.rotate)} min={-3600} max={3600} onChange={(n) => setPose({ rotate: n })} /></Field>
          <Field label="Прозрачность, %"><N value={Math.round(s.opacity * 100)} min={0} max={100} onChange={(n) => setPose({ opacity: n / 100 })} /></Field>
          {animated && <Field label="Масштаб, %"><N value={Math.round(s.scale * 100)} min={0} max={2000} onChange={(n) => setPose({ scale: n / 100 })} /></Field>}
        </div>
        <div className="btnrow">
          <button className="btn sm" onClick={() => onChange({ x: Math.round((1920 - l.w) / 2) })} disabled={animated}>По центру ↔</button>
          <button className="btn sm" onClick={() => onChange({ y: Math.round((1080 - l.h) / 2) })} disabled={animated}>По центру ↕</button>
        </div>

        <div className="ed-sub">Появление и исчезновение</div>
        <div className="ed-fields">
          <Field label="Появление"><select className="input" value={l.animIn} onChange={(e) => onChange({ animIn: e.target.value as AnimPreset })}>{ANIMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
          <Field label="Длится, мс"><N value={l.animInMs} min={0} max={5000} onChange={(n) => onChange({ animInMs: n })} /></Field>
          <Field label="Исчезновение"><select className="input" value={l.animOut} onChange={(e) => onChange({ animOut: e.target.value as AnimPreset })}>{ANIMS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
          <Field label="Длится, мс"><N value={l.animOutMs} min={0} max={5000} onChange={(n) => onChange({ animOutMs: n })} /></Field>
        </div>

        <div className="ed-sub">Ключевые кадры <Hint id="edKeyframes" /></div>
        <div className="btnrow">
          <button className="btn sm" onClick={addKey}>◆ Кадр в {sec(Math.round(local))}</button>
          {animated && <button className="btn sm" onClick={() => { onChange({ keyframes: [], x: Math.round(s.x), y: Math.round(s.y), rotate: Math.round(s.rotate), opacity: s.opacity }); setSelKf(null) }}>Убрать анимацию</button>}
        </div>
        {l.keyframes.map((f, i) => (
          <div key={i} className={`ed-kf ${selKf === i ? 'on' : ''}`} onClick={() => setSelKf(i)}>
            <span className="mono">◆ {sec(f.t)}</span>
            <span className="small muted">{f.x}, {f.y} · {Math.round(f.scale * 100)}% · {f.rotate}° · {Math.round(f.opacity * 100)}%</span>
            {i < l.keyframes.length - 1 && (
              <select className="input sm" value={f.ease} title="Как двигаться к следующему кадру" onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChange({ keyframes: l.keyframes.map((x, j) => (j === i ? { ...x, ease: e.target.value as Ease } : x)) })}>
                {EASES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            )}
            <button className="btn sm" title="Удалить кадр" onClick={(e) => { e.stopPropagation(); onChange({ keyframes: l.keyframes.filter((_, j) => j !== i) }); setSelKf(null) }}>✕</button>
          </div>
        ))}
        {animated && l.keyframes.length === 1 && <p className="small muted">Один кадр — слой просто стоит в этом положении. Передвиньте указатель времени и поставьте второй кадр, чтобы появилось движение.</p>}
      </>}
      <p className="small muted" style={{ marginTop: 14 }}>Слоёв в шаблоне: {t.layers.length}</p>
    </>
  )
}

function Align({ value, onChange }: { value: Layer['align']; onChange: (a: Layer['align']) => void }) {
  return (
    <div className="seg">
      {(['left', 'center', 'right'] as const).map((a) => <button key={a} className={value === a ? 'on' : ''} onClick={() => onChange(a)}>{a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}</button>)}
    </div>
  )
}

function ColorPick({ value, onChange, allowEmpty }: { value: string; onChange: (c: string) => void; allowEmpty?: boolean }) {
  return (
    <div className="btnrow">
      <input type="color" className="ed-color" value={value || '#ffb27a'} onChange={(e) => onChange(e.target.value)} />
      {allowEmpty && <button className={`btn sm ${value ? '' : 'primary'}`} onClick={() => onChange('')}>Градиент темы</button>}
    </div>
  )
}
