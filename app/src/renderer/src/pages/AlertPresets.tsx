import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { AlertTemplate } from '../../../main/core/templates'
import { kit, serverUrl, type KitHandle } from '../editors'
import { PRESETS } from '../presets'
import { blankTemplate, previewItem } from './AlertEditor'

/** Живая миниатюра шаблона: стоп-кадр, при наведении — проигрывается (без звука). */
function Thumb({ t, snap, live }: { t: AlertTemplate; snap: HubSnapshot; live: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(0.15)
  const item = useMemo(() => ({ ...(previewItem(t, 'donation', 0) as object), test: false }), [t])
  const theme = snap.settings.overlays.alert.theme
  // Адрес сервера — строкой: снимок состояния обновляется часто, миниатюра не должна из-за этого перезапускаться.
  const base = snap.server ? `${snap.server.baseUrl}|${snap.server.overlayKey}` : ''
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setK(el.clientWidth / 1920))
    ro.observe(el)
    setK(el.clientWidth / 1920)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!stage.current) return
    const url = (s: string): string => serverUrl(snap, s)
    const el = stage.current
    let h: KitHandle | null = null
    let loop: number | undefined
    if (live) {
      const run = (): void => { h?.stop(); h = kit().mount(el, item, { url, theme }) }
      run()
      loop = window.setInterval(run, ((h as KitHandle | null)?.duration ?? 6000) + 900)
    } else h = kit().mount(el, item, { url, theme, paused: true, startAt: 1800 })
    return () => { if (loop) clearInterval(loop); h?.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, live, theme, base])
  return (
    <div ref={box} className="preset-thumb">
      <div ref={stage} style={{ transform: `scale(${k})`, transformOrigin: '0 0' }} />
    </div>
  )
}

/** Выбор готового стиля при создании шаблона. */
export function PresetPicker({ snap, onPick, onClose }: { snap: HubSnapshot; onPick: (t: AlertTemplate) => void; onClose: () => void }) {
  const [hover, setHover] = useState<string | null>(null)
  const samples = useMemo(() => PRESETS.map((p) => ({ p, t: p.make() })), [])
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal wide">
        <h2>Новый шаблон</h2>
        <p className="muted">Выберите готовый стиль — дальше его можно поменять в конструкторе: текст, цвета, анимации, звук, картинки.</p>
        <div className="preset-grid">
          {samples.map(({ p, t }) => (
            <button key={p.id} className="preset" onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onClick={() => onPick(p.make())}>
              <Thumb t={t} snap={snap} live={hover === p.id} />
              <b>{p.name}</b>
              <span>{p.desc}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => onPick(blankTemplate())}>Начать с нуля</button>
          <button className="btn" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  )
}
