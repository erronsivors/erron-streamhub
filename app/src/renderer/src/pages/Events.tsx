import type { HubSnapshot } from '../../../main/core/types'
import { EventRow, useNow } from '../ui'
import { Hint } from '../components'

export function Events({ snap }: { snap: HubSnapshot }) {
  const now = useNow(15000)
  const events = snap.events.filter((e) => e.type !== 'message')
  return (
    <>
      <div className="head">
        <div>
          <h1>События <Hint id="testEvents" /></h1>
          <p>Донаты, подписки, рейды и фолловы со всех площадок в одной ленте. Тестовые не идут в статистику.</p>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={() => void window.hub.testEvent('follow')}>♥ Фоллоу</button>
          <button className="btn sm" onClick={() => void window.hub.testEvent('sub')}>★ Подписка</button>
          <button className="btn sm" onClick={() => void window.hub.testEvent('raid')}>↗ Рейд</button>
          <button className="btn primary sm" onClick={() => void window.hub.testEvent('donation')}>₽ Донат</button>
          <span className="small muted">Все виды тестов и очередь — в «Алертах»</span>
        </div>
      </div>
      <div className="card">
        {events.length ? <div className="list">{events.map((e) => <EventRow key={e.id} e={e} now={now} onReplay={e.type === 'system' ? undefined : () => void window.hub.alertReplay(e.id)} />)}</div>
          : <div className="empty">Пока пусто. Нажмите кнопку теста — событие появится здесь и в оверлее алертов.</div>}
      </div>
    </>
  )
}
