import { useEffect, useState } from 'react'
import type { HubSnapshot, Platform } from '../../main/core/types'
import mark from './assets/mark.svg'
import { Home } from './pages/Home'
import { Chat } from './pages/Chat'
import { Connections } from './pages/Connections'
import { Events } from './pages/Events'
import { Overlays } from './pages/Overlays'
import { Settings } from './pages/Settings'
import { Alerts } from './pages/Alerts'
import { Wizard } from './pages/Wizard'
import { ModeContext } from './components'
import { useNow, fmtDuration } from './ui'

export type Page = 'home' | 'chat' | 'events' | 'alerts' | 'overlays' | 'connections' | 'settings'

const NAV: { id: Page; label: string; ico: string; soon?: boolean }[] = [
  { id: 'home', label: 'Главная', ico: '⌂' },
  { id: 'chat', label: 'Мультичат', ico: '💬' },
  { id: 'events', label: 'События', ico: '⚡' },
  { id: 'alerts', label: 'Алерты', ico: '✦' },
  { id: 'overlays', label: 'Оверлеи', ico: '▣' },
  { id: 'connections', label: 'Подключения', ico: '⏚' },
  { id: 'settings', label: 'Настройки', ico: '⚙' }
]

const LATER = ['Конструктор алертов', 'Озвучка донатов', 'Аукцион и колесо', 'Автоматизации']

export function App() {
  const [snap, setSnap] = useState<HubSnapshot | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [connSel, setConnSel] = useState<Platform | undefined>(undefined)
  const go = (p: Page, sel?: Platform): void => {
    setConnSel(sel)
    setPage(p)
  }
  const now = useNow()

  useEffect(() => {
    void window.hub.snapshot().then(setSnap)
    return window.hub.onUpdate(setSnap)
  }, [])

  if (!snap) return <div className="empty">Запуск…</div>
  const { obs, twitch } = snap
  const okCount = snap.connections.filter((c) => c.state === 'ok').length
  const live = obs.streaming || snap.platforms.some((p) => p.live)
  const counted = snap.platforms.filter((p) => p.viewers !== null)
  const totalViewers = counted.length ? counted.reduce((a, p) => a + (p.viewers ?? 0), 0) : null

  return (
    <ModeContext.Provider value={snap.settings.setupMode}>
      <div className="layout">
        <aside className="side">
          <div className="brand">
            <img src={mark} alt="" />
            <div>
              <b>Crossember</b>
              <small>made by erron for friends</small>
            </div>
          </div>
          {NAV.map((n) => (
            <button key={n.id} className={`nav ${page === n.id ? 'on' : ''}`} onClick={() => go(n.id)}>
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
            <span className={`dot ${snap.server ? 'ok' : 'error'}`} /> {snap.settings.setupMode === 'two' ? 'Режим: 2 ПК' : snap.settings.setupMode === 'one' ? 'Режим: 1 ПК' : 'Режим не выбран'} · всё локально
          </div>
        </aside>

        <main className="main">
          <div className="topbar">
            <span className="live">
              <span className={`dot ${live ? 'live' : ''}`} />
              {live ? 'В эфире' : obs.connected || twitch.broadcaster ? 'Не в эфире' : 'Ничего не подключено'}
            </span>
            {obs.streaming && obs.streamStartedAt && <span className="mono">{fmtDuration(now - obs.streamStartedAt)}</span>}
            {totalViewers !== null && <span title="Зрители на всех площадках">👁 {totalViewers}</span>}
            {obs.recording && <span>● Запись</span>}
            {obs.scene && <span>Сцена: <b style={{ color: 'var(--ink)' }}>{obs.scene}</b></span>}
            <div className="right">
              <span>Подключений: {okCount}/{snap.connections.length}</span>
              {obs.resolution && <span className="chip">{obs.resolution} · {obs.fps} FPS</span>}
            </div>
          </div>

          {page === 'home' && <Home snap={snap} go={go} />}
          {page === 'chat' && <Chat snap={snap} />}
          {page === 'connections' && <Connections key={connSel ?? ""} snap={snap} initial={connSel} />}
          {page === 'events' && <Events snap={snap} />}
          {page === 'overlays' && <Overlays snap={snap} />}
          {page === 'settings' && <Settings snap={snap} />}
          {page === 'alerts' && <Alerts snap={snap} />}
        </main>
      </div>
      {snap.settings.setupMode === null && <Wizard />}
    </ModeContext.Provider>
  )
}
