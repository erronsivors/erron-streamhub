import { useEffect, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { GiveawayState, GiveawayWinner } from '../../../main/core/giveaway'
import type { GiveawaySettings } from '../../../main/core/settings'
import { Hint, NumberField, Toggle, errText } from '../components'
import { fmtTime, useNow } from '../ui'

const mmss = (ms: number): string => {
  const t = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(t / 60)
  const s = t % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
const PLAT: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', vk: 'VK', kick: 'Kick', goodgame: 'GoodGame', donationalerts: 'DonationAlerts', donatepay: 'DonatePay', donatex: 'DonateX', boosty: 'Boosty', hub: 'Crossember', obs: 'OBS' }

type Wrap = (p: Promise<unknown>, after?: () => void) => void

export function Giveaway({ snap }: { snap: HubSnapshot }) {
  const g = snap.giveaway
  const cfg = snap.settings.giveaway
  const [err, setErr] = useState<string | null>(null)
  const wrap: Wrap = (p, after) => { setErr(null); p.then(() => after?.()).catch((e) => setErr(errText(e))) }
  const status = g.reveal ? 'Выбираем победителя…' : g.open ? '● Приём участников' : g.timeUp ? 'Время вышло' : g.winners.length ? 'Итог объявлен' : 'Приём закрыт'

  return (
    <>
      <div className="head">
        <div>
          <h1>Розыгрыш <Hint id="giveaway" /></h1>
          <p>Участие — «{cfg.keyword}» в чате на любой площадке{cfg.rubPerTicket > 0 ? `, за каждые ${cfg.rubPerTicket} ₽ доната — ещё билет` : ''}.</p>
        </div>
        <div className="actions"><span className={`chip auc-state ${g.open ? 'on' : ''}`}>{status}</span></div>
      </div>
      {err && <div className="note err" style={{ marginBottom: 14 }}>{err}</div>}
      <ControlCard g={g} cfg={cfg} wrap={wrap} />
      {(g.reveal || g.winners.length > 0) && <WinnersCard g={g} cfg={cfg} wrap={wrap} />}
      <div className="grid gw-grid">
        <EntriesCard g={g} wrap={wrap} />
        <div className="auc-side">
          <SettingsCard cfg={cfg} />
          <ArchiveCard g={g} wrap={wrap} />
        </div>
      </div>
    </>
  )
}

function ControlCard({ g, cfg, wrap }: { g: GiveawayState; cfg: GiveawaySettings; wrap: Wrap }) {
  const now = useNow(250)
  const [prize, setPrize] = useState(g.prize)
  const [min, setMin] = useState(cfg.defaultMin)
  const [count, setCount] = useState(cfg.winners)
  const [confirmNew, setConfirmNew] = useState(false)
  useEffect(() => setPrize(g.prize), [g.prize])
  const left = g.endsAt ? g.endsAt - now : 0
  const people = g.entries.length

  return (
    <div className="card gw-control">
      <div className="gw-clock-box">
        <div className={`auc-clock ${g.endsAt && left < 30_000 ? 'low' : ''} ${!g.endsAt ? 'idle' : ''}`}>{g.endsAt ? mmss(left) : g.timeUp ? '00:00' : '—:—'}</div>
        <div className="small muted">{g.open ? (g.endsAt ? 'приём закроется сам' : 'приём без таймера') : g.timeUp ? 'время вышло' : 'приём закрыт'}</div>
      </div>
      <div className="auc-ctl">
        <div className="gw-prize">
          <input className="input" value={prize} maxLength={80} placeholder="Что разыгрываем: ключ от игры, подписка, мерч…" onChange={(e) => setPrize(e.target.value)}
            onBlur={() => { if (prize.trim() !== g.prize) wrap(window.hub.gwPrize(prize.trim())) }} />
        </div>
        <div className="btnrow">
          {g.open ? (
            <>
              <button className="btn" onClick={() => wrap(window.hub.gwExtend(1))}>+1 мин</button>
              <button className="btn" disabled={!g.endsAt} onClick={() => wrap(window.hub.gwExtend(-1))}>−1 мин</button>
              <button className="btn" onClick={() => wrap(window.hub.gwClose())}>Закрыть приём</button>
            </>
          ) : (
            <>
              <button className="btn primary" disabled={!!g.reveal} onClick={() => wrap(window.hub.gwStart(prize.trim(), min))}>▶ {min > 0 ? `Открыть приём · ${min} мин` : 'Открыть приём без таймера'}</button>
              <span className="gw-num"><input className="input" value={min} inputMode="numeric" onChange={(e) => setMin(Math.min(600, Number(e.target.value.replace(/\D/g, '')) || 0))} /><span className="small muted">мин (0 — без таймера)</span></span>
            </>
          )}
        </div>
        <div className="btnrow">
          <button className="btn primary" disabled={!!g.reveal || people === 0} onClick={() => wrap(window.hub.gwDraw(count))}>🎁 Выбрать {count > 1 ? `${count} победителей` : 'победителя'}</button>
          <span className="gw-num"><input className="input" value={count} inputMode="numeric" onChange={(e) => setCount(Math.max(1, Math.min(10, Number(e.target.value.replace(/\D/g, '')) || 1)))} /><span className="small muted">сколько</span></span>
          {confirmNew ? (
            <>
              <button className="btn" style={{ borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.gwReset(), () => setConfirmNew(false))}>Да, начать новый</button>
              <button className="btn" onClick={() => setConfirmNew(false)}>Отмена</button>
            </>
          ) : <button className="btn" disabled={!!g.reveal} onClick={() => setConfirmNew(true)} title="Итог уйдёт в архив, участники обнулятся">Новый розыгрыш</button>}
        </div>
      </div>
      <div className="auc-stats">
        <div><b>{people}</b><span>участников</span></div>
        <div><b>{g.tickets}</b><span>билетов</span></div>
      </div>
    </div>
  )
}

function WinnersCard({ g, cfg, wrap }: { g: GiveawayState; cfg: GiveawaySettings; wrap: Wrap }) {
  const now = useNow(500)
  const [roll, setRoll] = useState('')
  useEffect(() => {
    const r = g.reveal
    if (!r || !r.names.length) return
    const t = setInterval(() => setRoll(r.names[Math.floor(Date.now() / 90) % r.names.length]), 60)
    return () => clearInterval(t)
  }, [g.reveal])

  return (
    <div className="card gw-winners">
      <h3>Победители</h3>
      {g.reveal && <div className="gw-rolling"><span className="small muted">Выбираем…</span><b>{roll}</b></div>}
      {g.winners.map((w) => <WinnerRow key={w.key + w.ts} w={w} now={now} busy={!!g.reveal} wrap={wrap} />)}
      {!g.reveal && <p className="small muted" style={{ margin: '10px 0 0' }}>Ответ в чате ждём {cfg.answerSec} с. Сообщения победителя появятся здесь сами.</p>}
    </div>
  )
}

function WinnerRow({ w, now, busy, wrap }: { w: GiveawayWinner; now: number; busy: boolean; wrap: Wrap }) {
  const left = w.deadline - now
  return (
    <div className={`gw-win ${w.skipped ? 'skipped' : ''}`}>
      <div className="gw-win-head">
        <b className="gw-wname">{w.user}</b>
        <span className="small muted">{PLAT[w.platform] ?? w.platform} · {w.tickets} {w.tickets === 1 ? 'билет' : w.tickets < 5 ? 'билета' : 'билетов'}</span>
        {w.skipped ? <span className="wh-tag">перевыбран</span>
          : w.answered ? <span className="wh-tag win">✓ ответил</span>
            : left > 0 ? <span className="gw-wait">ждём ответа · {mmss(left)}</span>
              : <span className="gw-wait late">не ответил</span>}
        {!w.skipped && <button className="btn sm" disabled={busy} onClick={() => wrap(window.hub.gwReroll(w.key))} title="Отметить как не ответившего и выбрать другого">Перевыбрать</button>}
      </div>
      {w.messages.length > 0 && (
        <div className="gw-msgs">
          {w.messages.map((m, i) => <div key={i}><span className="small muted">{fmtTime(m.ts)}</span> {m.text}</div>)}
        </div>
      )}
    </div>
  )
}

function EntriesCard({ g, wrap }: { g: GiveawayState; wrap: Wrap }) {
  const [q, setQ] = useState('')
  const list = q.trim() ? g.entries.filter((e) => e.user.toLowerCase().includes(q.trim().toLowerCase())) : g.entries
  return (
    <div className="card">
      <h3>Участники <span className="r chip">{g.entries.length}</span></h3>
      <div className="auc-add" style={{ marginBottom: 10 }}>
        <input className="input" value={q} placeholder="Найти по нику…" onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => wrap(window.hub.gwFakes(10))} title="Добавить 10 тестовых участников — проверить выбор и оверлей без зрителей">+10 тестовых</button>
      </div>
      {g.entries.length === 0 && <p className="small muted" style={{ margin: 0 }}>Пока никого. Откройте приём — зрители появятся здесь, как только напишут слово в чат.</p>}
      <div className="gw-entries">
        {list.slice(0, 300).map((e) => (
          <div key={e.key} className="gw-entry">
            <span className="grow">{e.user}{e.fake && <span className="auc-auto" style={{ marginLeft: 8 }}>тест</span>}</span>
            <span className="small muted">{PLAT[e.platform] ?? e.platform}{e.rub > 0 ? ` · донат ${Math.round(e.rub).toLocaleString('ru-RU')} ₽` : ''}</span>
            <b className="gw-tk">{e.tickets}</b>
            <button className="btn sm" title="Убрать из розыгрыша" onClick={() => wrap(window.hub.gwRemove(e.key))}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SettingsCard({ cfg }: { cfg: GiveawaySettings }) {
  const set = (p: Partial<GiveawaySettings>): void => void window.hub.setSettings({ giveaway: p })
  const [kw, setKw] = useState(cfg.keyword)
  const [start, setStart] = useState(cfg.startText)
  const [win, setWin] = useState(cfg.winText)
  return (
    <div className="card">
      <h3>Правила розыгрыша</h3>
      <div className="field">
        <label>Слово для участия</label>
        <input className="input" value={kw} maxLength={30} onChange={(e) => setKw(e.target.value)} onBlur={() => { if (kw.trim()) set({ keyword: kw.trim() }); else setKw(cfg.keyword) }} />
      </div>
      <div className="grid g2" style={{ gap: 10 }}>
        <NumberField label="Билет за каждые, ₽ (0 — нет)" value={cfg.rubPerTicket} min={0} max={1_000_000} suffix="₽" onChange={(v) => set({ rubPerTicket: v })} />
        <NumberField label="Не больше билетов" value={cfg.maxTickets} min={1} max={1000} onChange={(v) => set({ maxTickets: v })} />
        <NumberField label="Таймер приёма" value={cfg.defaultMin} min={0} max={600} suffix="мин" onChange={(v) => set({ defaultMin: v })} />
        <NumberField label="Ждать ответа" value={cfg.answerSec} min={10} max={600} suffix="сек" onChange={(v) => set({ answerSec: v })} />
      </div>
      <Toggle on={cfg.announce} onChange={(v) => set({ announce: v })} label="Писать в чат о старте и победителях" />
      {cfg.announce && (
        <>
          <div className="field" style={{ marginTop: 10 }}>
            <label>При старте</label>
            <input className="input" value={start} maxLength={300} onChange={(e) => setStart(e.target.value)} onBlur={() => set({ startText: start })} />
          </div>
          <div className="field">
            <label>Победители</label>
            <input className="input" value={win} maxLength={300} onChange={(e) => setWin(e.target.value)} onBlur={() => set({ winText: win })} />
          </div>
          <p className="small muted" style={{ margin: 0 }}>Подстановки: {'{приз}'}, {'{слово}'}, {'{победители}'}. Пишет аккаунт стримера на площадках, где Crossember может писать.</p>
        </>
      )}
    </div>
  )
}

function ArchiveCard({ g, wrap }: { g: GiveawayState; wrap: Wrap }) {
  if (!g.archive.length) return null
  return (
    <div className="card">
      <h3>Прошлые розыгрыши <button className="r btn sm" onClick={() => wrap(window.hub.gwClearArchive())}>Очистить</button></h3>
      {g.archive.map((x, i) => (
        <div key={i} className="goal-top-row">
          <span className="grow">{x.prize || 'Розыгрыш'}<span className="small muted"> · {new Date(x.ts).toLocaleDateString('ru-RU')} · {x.entries} уч.</span></span>
          <b style={{ fontFamily: 'var(--f-text)' }}>{x.winners.join(', ') || '—'}</b>
        </div>
      ))}
    </div>
  )
}
