import type { ConnStatus, HubSnapshot, Platform } from '../../../main/core/types'
import type { Page } from '../App'
import { EventRow, PlatIcon, useNow } from '../ui'
import { StreamInfoCard } from './StreamInfoCard'

/** Группы подключений на главной: сразу видно, что работает, а что отвалилось. */
const GROUPS: { title: string; ids: Platform[] }[] = [
  { title: 'Программы', ids: ['obs', 'hub'] },
  { title: 'Донаты', ids: ['donationalerts', 'donatepay', 'donatex', 'boosty'] },
  { title: 'Стрим-площадки', ids: ['twitch', 'youtube', 'vk', 'kick', 'goodgame'] }
]
const SHORT: Record<ConnStatus['state'], string> = { ok: 'работает', connecting: 'подключение…', error: 'ошибка', off: 'не подключено' }

export function Home({ snap, go }: { snap: HubSnapshot; go: (p: Page, sel?: Platform) => void }) {
  const now = useNow(15000)
  const { obs } = snap
  const problems = snap.connections.filter((c) => c.state === 'error')
  const events = snap.events.filter((e) => e.type !== 'message').slice(0, 5)
  const configured = snap.platforms.filter((p) => p.configured)
  const live = configured.filter((p) => p.live)
  const counted = live.filter((p) => p.viewers !== null)
  const viewers = counted.length ? counted.reduce((a, p) => a + (p.viewers ?? 0), 0) : null
  const total = GROUPS.reduce((a, g) => a + g.ids.length, 0)
  const okCount = snap.connections.filter((c) => c.state === 'ok' && GROUPS.some((g) => g.ids.includes(c.id))).length

  return (
    <>
      <div className="head">
        <div>
          <h1>
            Всё для эфира — <span className="grad-text" style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', color: 'transparent' }}>у костра</span>
          </h1>
          <p>Чат, события, донаты и оверлеи в одном месте. На стрим-ПК — только OBS и Crossember.</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => void window.hub.testEvent('donation')}>⚡ Тестовый донат</button>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="note warnbox" style={{ marginBottom: 18 }}>
          <b>Есть проблемы с подключениями:</b> {problems.map((p) => `${p.name} — ${p.detail}`).join('; ')}{' '}
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => go('connections', problems[0].id)}>Открыть диагностику</button>
        </div>
      )}

      <div className="grid g3">
        <div className="card">
          <h3>Зрители в эфире {live.length > 0 && <span className="r tag">в эфире: {live.length}</span>}</h3>
          <div className={`big ${viewers === null ? 'muted' : ''}`}>{viewers ?? '—'}</div>
          {configured.length ? (
            <div className="list">
              {configured.map((p) => (
                <div key={p.id} className="row"><PlatIcon p={p.id} /><span className="grow ellipsis">{p.name}</span><b className={p.live ? '' : 'muted small'}>{p.live ? (p.viewers ?? 0) : 'не в эфире'}</b></div>
              ))}
            </div>
          ) : <p className="small muted">Подключите площадки в «Подключениях» — здесь появятся зрители каждой.</p>}
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
          <h3>Алерты <button className="r btn sm" onClick={() => go('alerts')}>Открыть →</button></h3>
          <div className="kv">
            <div><span>Сейчас</span><b className="ellipsis" style={{ display: 'block' }}>{snap.alerts.current ? snap.alerts.current.user : '—'}</b></div>
            <div><span>В очереди</span><b>{snap.alerts.queue.length}</b></div>
          </div>
          <div className="row">
            <span className="grow muted">{!snap.settings.alerts.enabled ? 'Алерты выключены' : snap.alerts.paused ? 'На паузе' : 'Показываются'}</span>
            <button className="btn sm" onClick={() => void window.hub.alertPause(!snap.alerts.paused)}>{snap.alerts.paused ? '▶ Продолжить' : '❚❚ Пауза'}</button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 18 }}><StreamInfoCard snap={snap} go={go} /></div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>Подключения <span className="small muted" style={{ fontWeight: 500, marginLeft: 8 }}>активно {okCount} из {total}</span> <button className="r btn sm" onClick={() => go('connections')}>Все →</button></h3>
        <div className="grid g3">
          {GROUPS.map((g) => {
            const list = g.ids.map((id) => snap.connections.find((c) => c.id === id)).filter((c): c is ConnStatus => !!c)
            const ok = list.filter((c) => c.state === 'ok').length
            return (
              <div key={g.title}>
                <div className="small muted" style={{ letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 6 }}>{g.title} · {ok}/{list.length}</div>
                <div className="list">
                  {list.map((c) => (
                    <div key={c.id} className="row" style={{ cursor: 'pointer', opacity: c.state === 'off' ? 0.55 : 1 }} title={c.detail} onClick={() => go('connections', c.id)}>
                      <PlatIcon p={c.id} />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <span className="ellipsis" style={{ display: 'block' }}>{c.name}</span>
                        <span className="small ellipsis" style={{ display: 'block', color: c.state === 'error' ? '#ff7a84' : 'var(--muted)' }}>{c.state === 'error' ? c.detail : SHORT[c.state]}</span>
                      </div>
                      <span className={`dot ${c.state}`} />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
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
