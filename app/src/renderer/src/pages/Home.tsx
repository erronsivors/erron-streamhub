import type { HubSnapshot } from '../../../main/core/types'
import type { Page } from '../App'
import { EventRow, PlatIcon, useNow } from '../ui'

export function Home({ snap, go }: { snap: HubSnapshot; go: (p: Page) => void }) {
  const now = useNow(15000)
  const { obs } = snap
  const problems = snap.connections.filter((c) => c.state === 'error')
  const events = snap.events.filter((e) => e.type !== 'message').slice(0, 5)

  return (
    <>
      <div className="head">
        <div>
          <h1>
            Всё для эфира — <span className="grad-text" style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', color: 'transparent' }}>у костра</span>
          </h1>
          <p>Чат, события и оверлеи в одном месте. На стрим-ПК — только OBS и StreamHub.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => void window.hub.testEvent('donation')}>⚡ Тестовый донат</button>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="note warnbox" style={{ marginBottom: 18 }}>
          <b>Есть проблемы с подключениями:</b> {problems.map((p) => `${p.name} — ${p.detail}`).join('; ')}{' '}
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => go('connections')}>Открыть диагностику</button>
        </div>
      )}

      <div className="grid g3">
        <div className="card">
          <h3>Зрители в эфире {snap.twitch.live && <span className="r tag">Twitch в эфире</span>}</h3>
          <div className={`big ${snap.twitch.viewers === null ? 'muted' : ''}`}>{snap.twitch.viewers ?? '—'}</div>
          <p className="small muted">
            {snap.twitch.broadcaster ? `Twitch: ${snap.twitch.broadcaster.name}${snap.twitch.live ? '' : ' · не в эфире'}` : 'Подключите Twitch в «Подключениях»'}. YouTube, VK и Kick — на следующем этапе.
          </p>
        </div>

        <div className="card">
          <h3>OBS Studio <span className={`r dot ${obs.connected ? 'ok' : 'connecting'}`} /></h3>
          {obs.connected ? (
            <>
              <div className="kv">
                <div><span>Разрешение</span><b>{obs.resolution}</b></div>
                <div><span>Частота</span><b>{obs.fps} FPS</b></div>
              </div>
              <div className="row"><span className="grow muted">Текущая сцена</span><b>{obs.scene}</b></div>
              <div className="row"><span className="grow muted">Эфир</span><b style={{ color: obs.streaming ? 'var(--ok)' : undefined }}>{obs.streaming ? 'В сети' : 'Не в эфире'}</b></div>
            </>
          ) : (
            <>
              <p className="muted">{snap.connections.find((c) => c.id === 'obs')?.detail}</p>
              <button className="btn sm" onClick={() => go('connections')}>Настроить подключение</button>
            </>
          )}
        </div>

        <div className="card">
          <h3>Подключения <button className="r btn sm" onClick={() => go('connections')}>Все →</button></h3>
          <div className="list">
            {snap.connections.filter((c) => c.id !== 'hub').slice(0, 5).map((c) => (
              <div className="row" key={c.id}>
                <PlatIcon p={c.id} />
                <span className="grow ellipsis">{c.name}</span>
                <span className={`dot ${c.state}`} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 18 }}>
        <div className="card">
          <h3>Последние события <button className="r btn sm" onClick={() => go('events')}>Все →</button></h3>
          {events.length ? <div className="list">{events.map((e) => <EventRow key={e.id} e={e} now={now} />)}</div>
            : <div className="empty">Событий пока нет — нажмите «Тестовый донат»</div>}
        </div>
        <div className="card">
          <h3>Под рукой</h3>
          <div className="grid g2" style={{ gap: 12 }}>
            {[
              ['Оверлеи для OBS', 'Ссылки и ключи', 'overlays'],
              ['Подключения', 'Диагностика площадок', 'connections'],
              ['События', 'Лента и тесты', 'events'],
              ['Настройки', 'Сервер, ключи, OBS', 'settings']
            ].map(([t, d, p]) => (
              <button key={t} className="btn" style={{ flexDirection: 'column', alignItems: 'flex-start', padding: 16 }} onClick={() => go(p as Page)}>
                {t}
                <span className="small muted" style={{ fontWeight: 500 }}>{d}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
