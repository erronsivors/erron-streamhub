import { useEffect, useState } from 'react'
import type { HubSnapshot } from '../../main/core/types'
import mark from './assets/mark.svg'
import { Home } from './pages/Home'
import { Connections } from './pages/Connections'
import { Events } from './pages/Events'
import { Overlays } from './pages/Overlays'
import { Settings } from './pages/Settings'
import { Soon } from './pages/Soon'
import { useNow, fmtDuration } from './ui'

export type Page = 'home' | 'chat' | 'events' | 'alerts' | 'overlays' | 'connections' | 'settings'

const NAV: { id: Page; label: string; ico: string; soon?: boolean }[] = [
  { id: 'home', label: 'Главная', ico: '⌂' },
  { id: 'chat', label: 'Мультичат', ico: '💬', soon: true },
  { id: 'events', label: 'События', ico: '⚡' },
  { id: 'alerts', label: 'Алерты', ico: '✦', soon: true },
  { id: 'overlays', label: 'Оверлеи', ico: '▣' },
  { id: 'connections', label: 'Подключения', ico: '⏚' },
  { id: 'settings', label: 'Настройки', ico: '⚙' }
]

const LATER = ['Конструктор алертов', 'Пульт для 2-го ПК', 'Колесо и аукцион', 'Автоматизации', 'AI Studio']

export function App() {
  const [snap, setSnap] = useState<HubSnapshot | null>(null)
  const [page, setPage] = useState<Page>('home')
  const now = useNow()

  useEffect(() => {
    void window.hub.snapshot().then(setSnap)
    return window.hub.onUpdate(setSnap)
  }, [])

  if (!snap) return <div className="empty">Запуск…</div>
  const { obs } = snap
  const okCount = snap.connections.filter((c) => c.state === 'ok').length

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <img src={mark} alt="" />
          <div>
            <b>StreamHub</b>
            <small>ERRON · v0.1</small>
          </div>
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav ${page === n.id ? 'on' : ''}`} onClick={() => setPage(n.id)}>
            <span className="ico">{n.ico}</span>
            {n.label}
            {n.soon && <span className="soon">скоро</span>}
          </button>
        ))}
        <div className="side-sep">Дальше по плану</div>
        {LATER.map((l) => (
          <div key={l} className="nav" style={{ cursor: 'default', opacity: 0.45 }}>
            <span className="ico">·</span>
            {l}
          </div>
        ))}
        <div className="side-foot">
          <span className={`dot ${snap.server ? 'ok' : 'error'}`} /> Всё локально · без чужих серверов
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <span className="live">
            <span className={`dot ${obs.streaming ? 'live' : ''}`} />
            {obs.streaming ? 'В эфире' : obs.connected ? 'Не в эфире' : 'OBS не подключён'}
          </span>
          {obs.streaming && obs.streamStartedAt && <span className="mono">{fmtDuration(now - obs.streamStartedAt)}</span>}
          {obs.recording && <span>● Запись</span>}
          {obs.scene && <span>Сцена: <b style={{ color: 'var(--ink)' }}>{obs.scene}</b></span>}
          <div className="right">
            <span>Подключений: {okCount}/{snap.connections.length}</span>
            {obs.resolution && <span className="chip">{obs.resolution} · {obs.fps} FPS</span>}
          </div>
        </div>

        {page === 'home' && <Home snap={snap} go={setPage} />}
        {page === 'connections' && <Connections snap={snap} />}
        {page === 'events' && <Events snap={snap} />}
        {page === 'overlays' && <Overlays snap={snap} />}
        {page === 'settings' && <Settings snap={snap} />}
        {page === 'chat' && <Soon title="Мультичат" text="Единая лента Twitch, YouTube, VK Видео Live и Kick — этапы 1–2." />}
        {page === 'alerts' && <Soon title="Алерты" text="Очередь, шаблоны в стиле ERRON, звуки, условия по сумме — этап 3. Тестовый оверлей уже есть в «Оверлеях»." />}
      </main>
    </div>
  )
}
