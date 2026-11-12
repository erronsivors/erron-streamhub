import type { HubSnapshot } from '../../../main/core/types'
import type { Page } from '../App'

/** Инструменты раздела «Интерактив»: игры со зрителями. Новые добавляются сюда — плиткой и вкладкой. */
export const INTERACTIVE: { id: Page; label: string; ico: string; desc: string }[] = [
  { id: 'auction', label: 'Аукцион', ico: '◈', desc: 'Зрители донатят за лоты, побеждает лидер или колесо.' },
  { id: 'vote', label: 'Голосование', ico: '☰', desc: 'Быстрое на эфир и долгое между эфирами: чат, донаты, баллы или Twitch.' },
  { id: 'wheel', label: 'Колесо', ico: '◎', desc: 'Случайный выбор из своего списка или лотов аукциона.' },
  { id: 'goal', label: 'Сбор средств', ico: '◔', desc: 'Цель с этапами, донаты засчитываются сами.' },
  { id: 'giveaway', label: 'Розыгрыш', ico: '❖', desc: 'Участие словом в чате, билеты за донат, честный выбор.' }
]

/** Вкладки внутри «Алертов и правил». */
export const ALERT_TABS: { id: Page; label: string }[] = [
  { id: 'alerts', label: 'Алерты' },
  { id: 'rules', label: 'Правила и счётчики' }
]

const money = (n: number): string => `${Math.round(n).toLocaleString('ru-RU')} ₽`
const clock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const plural = (n: number, one: string, few: string, many: string): string => {
  const a = n % 10
  const b = n % 100
  return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`
}

interface ToolStatus {
  text: string
  live: boolean
  extra?: string
  bar?: number
  badge?: number
}

/** Короткое состояние инструмента для плитки и точки на вкладке. */
export function toolStatus(id: Page, snap: HubSnapshot, now: number): ToolStatus {
  switch (id) {
    case 'auction': {
      const a = snap.auction
      const pending = a.bets.filter((b) => b.status === 'pending').length
      const extra = a.lots.length ? `${plural(a.lots.length, 'лот', 'лота', 'лотов')} · ${money(a.total)}` : undefined
      if (a.accepting) return { text: a.timer.endsAt ? `● Идёт · ${clock(a.timer.endsAt - now)}` : '● Приём ставок', live: true, extra, badge: pending }
      if (a.winner) return { text: `Победил: ${a.winner.name}`, live: false, extra, badge: pending }
      if (a.timeUp) return { text: 'Время вышло', live: false, extra, badge: pending }
      return { text: a.lots.length ? 'Пауза' : 'Не запущен', live: false, extra, badge: pending }
    }
    case 'vote': {
      const v = snap.vote
      const pending = (v.quick?.pending.length ?? 0) + (v.long?.pending.length ?? 0)
      const q = v.quick
      const l = v.long
      const extra = l ? `Долгое: ${l.open ? (l.ranked[0]?.votes ? l.ranked[0].name : 'идёт') : 'итог'}` : undefined
      if (q && q.open) return { text: q.timer.endsAt ? `● Быстрое · ${clock(q.timer.endsAt - now)}` : '● Быстрое идёт', live: true, extra, badge: pending }
      if (q && q.result) return { text: `Итог: ${q.result.name}`, live: false, extra, badge: pending }
      if (l && l.open) return { text: '● Долгое идёт', live: true, extra: plural(l.total, 'голос', 'голоса', 'голосов'), badge: pending }
      if (l && l.result) return { text: `Итог: ${l.result.name}`, live: false, badge: pending }
      return { text: 'Не запущено', live: false, badge: pending }
    }
    case 'wheel': {
      const w = snap.wheel
      if (w.spin) return { text: '● Крутится', live: true }
      const n = w.items.length - w.out.length
      const extra = w.items.length ? plural(n, 'вариант', 'варианта', 'вариантов') : undefined
      if (w.winner) return { text: `Выпало: ${w.winner.name}`, live: false, extra }
      return { text: w.items.length ? 'Готово' : 'Список пуст', live: false, extra }
    }
    case 'goal': {
      const st = snap.goal
      const g = st.goal
      if (!g) return { text: 'Нет цели', live: false }
      const extra = `${money(st.collected)} из ${money(g.target)}`
      const bar = Math.min(100, st.pct)
      if (g.accepting) return { text: g.endsAt ? `● Сбор идёт · ${clock(g.endsAt - now)}` : `● Сбор идёт · ${Math.floor(st.pct)}%`, live: true, extra, bar }
      return { text: g.timeUp ? 'Срок вышел' : 'Пауза', live: false, extra, bar }
    }
    case 'giveaway': {
      const gw = snap.giveaway
      const n = gw.entries.length
      if (gw.open) return { text: gw.endsAt ? `● Приём · ${clock(gw.endsAt - now)}` : '● Приём участников', live: true, extra: plural(n, 'участник', 'участника', 'участников') }
      const win = gw.winners.filter((w) => !w.skipped)
      if (gw.reveal) return { text: '● Выбираем победителя', live: true }
      if (win.length) return { text: `Победитель: ${win.map((w) => w.user).join(', ')}`, live: false, extra: gw.prize || undefined }
      return { text: 'Не запущен', live: false }
    }
    default:
      return { text: '', live: false }
  }
}

/** Экран «Интерактив»: плитки инструментов с их состоянием. */
export function InteractiveHub({ snap, go, now }: { snap: HubSnapshot; go: (p: Page) => void; now: number }) {
  return (
    <>
      <div className="head">
        <div>
          <h1>Интерактив</h1>
          <p>Игры со зрителями: всё, что зрители делают донатами, баллами и чатом.</p>
        </div>
      </div>
      <div className="ix-tiles">
        {INTERACTIVE.map((t) => {
          const s = toolStatus(t.id, snap, now)
          return (
            <button key={t.id} className="ix-tile" onClick={() => go(t.id)}>
              <h3><span className="ix-ico">{t.ico}</span>{t.label}{!!s.badge && <span className="nav-cnt" title="Ставки ждут решения">{s.badge}</span>}</h3>
              <p>{t.desc}</p>
              <div className="ix-status">
                <span className={`ix-st ${s.live ? 'live' : ''}`}>{s.text}</span>
                {s.extra && <span className="small muted ellipsis">{s.extra}</span>}
              </div>
              {s.bar !== undefined && <div className="ix-bar"><i style={{ width: `${s.bar}%` }} /></div>}
            </button>
          )
        })}
      </div>
    </>
  )
}

/** Вкладки над страницей раздела; back — ссылка на экран раздела (для «Интерактива»). */
export function SubTabs({ tabs, page, go, back, snap, now }: {
  tabs: { id: Page; label: string }[]
  page: Page
  go: (p: Page) => void
  back?: { label: string; page: Page }
  snap: HubSnapshot
  now: number
}) {
  return (
    <div className="subnav">
      {back && <button className="subnav-back" onClick={() => go(back.page)}>← {back.label}</button>}
      <div className="subtabs">
        {tabs.map((t) => {
          const s = back ? toolStatus(t.id, snap, now) : null
          return (
            <button key={t.id} className={page === t.id ? 'on' : ''} onClick={() => go(t.id)}>
              {t.label}
              {s?.live && <span className="dot live" title={s.text} />}
              {!!s?.badge && <span className="nav-cnt">{s.badge}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
