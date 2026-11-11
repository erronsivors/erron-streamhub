import { useState, type ReactNode } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { AuctionBet, AuctionState, LotView } from '../../../main/core/auction'
import type { AuctionSettings } from '../../../main/core/settings'
import { Hint, NumberField, Toggle, errText } from '../components'
import { fmtTime, useNow } from '../ui'

const money = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`
const mmss = (ms: number): string => {
  const t = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const p = (x: number): string => String(x).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
const SRC: Record<AuctionBet['source'], string> = { donation: 'донат', points: 'баллы', manual: 'вручную' }

type Wrap = (p: Promise<unknown>, after?: () => void) => void

export function Auction({ snap }: { snap: HubSnapshot }) {
  const a = snap.auction
  const [err, setErr] = useState<string | null>(null)
  const wrap: Wrap = (p, after) => { setErr(null); p.then(() => after?.()).catch((e) => setErr(errText(e))) }
  const pending = a.bets.filter((b) => b.status === 'pending')

  return (
    <>
      <div className="head">
        <div>
          <h1>Аукцион <Hint id="auction" /></h1>
          <p>Ставка — донат{snap.settings.auction.pointsReward ? ' или награда за баллы' : ''} с названием лота или его номером (#3) в сообщении.</p>
        </div>
        <div className="actions">
          <span className={`chip auc-state ${a.accepting ? 'on' : ''}`}>{a.accepting ? '● Приём ставок идёт' : a.timeUp ? 'Время вышло' : a.winner ? 'Итог объявлен' : 'Приём ставок закрыт'}</span>
        </div>
      </div>
      {err && <div className="note err" style={{ marginBottom: 14 }}>{err}</div>}
      {a.winner && <WinnerCard a={a} />}
      <ControlCard a={a} cfg={snap.settings.auction} pending={pending.length} wrap={wrap} />
      <div className="grid auc-grid">
        <LotsCard a={a} wrap={wrap} />
        <div className="auc-side">
          <PendingCard a={a} pending={pending} wrap={wrap} />
          <HistoryCard a={a} wrap={wrap} />
        </div>
      </div>
      <div className="grid g2" style={{ marginTop: 18 }}>
        <SettingsCard cfg={snap.settings.auction} />
        <div className="auc-side">
          <ManualBetCard wrap={wrap} />
          <ArchiveCard a={a} wrap={wrap} />
        </div>
      </div>
    </>
  )
}

function WinnerCard({ a }: { a: AuctionState }) {
  const w = a.winner!
  return (
    <div className="card auc-winner">
      <div className="grow">
        <div className="auc-kicker">Победитель аукциона</div>
        <div className="auc-wname">{w.name}</div>
        <div className="muted">{money(w.rub)} из {money(a.total)} · {fmtTime(w.ts)}</div>
      </div>
      <p className="small muted" style={{ margin: 0, maxWidth: 260 }}>Итог уже на оверлее «Аукцион». Начать заново — кнопка «Новый аукцион» ниже.</p>
    </div>
  )
}

function ControlCard({ a, cfg, pending, wrap }: { a: AuctionState; cfg: AuctionSettings; pending: number; wrap: Wrap }) {
  const now = useNow(250)
  const [confirmNew, setConfirmNew] = useState(false)
  const t = a.timer
  const running = !!t.endsAt
  const hasTimer = running || !!t.pausedLeft
  const left = running ? (t.endsAt ?? 0) - now : t.pausedLeft ?? cfg.defaultMin * 60_000
  const low = running && left < 60_000
  const status = running ? 'Идёт' : t.pausedLeft ? 'Пауза' : a.timeUp ? 'Время вышло' : 'Таймер не запущен'
  const top = a.lots[0]
  const counted = a.bets.filter((b) => b.status === 'lot').length

  return (
    <div className="card auc-control">
      <div className="auc-clock-box">
        <div className={`auc-clock ${low ? 'low' : ''} ${!running ? 'idle' : ''}`}>{a.timeUp ? '00:00' : mmss(left)}</div>
        <div className="small muted">{status}{cfg.extend && running ? ` · продление +${cfg.extendAddSec} с, если осталось < ${cfg.extendBelowSec} с` : ''}</div>
      </div>
      <div className="auc-ctl">
        <div className="btnrow">
          {running
            ? <button className="btn" onClick={() => wrap(window.hub.aucTimer('pause'))}>❚❚ Пауза</button>
            : <button className="btn primary" onClick={() => wrap(window.hub.aucTimer('start'))}>▶ {t.pausedLeft ? 'Продолжить' : `Старт · ${cfg.defaultMin} мин`}</button>}
          <button className="btn" onClick={() => wrap(window.hub.aucTimer('sub', 60))} disabled={!hasTimer}>−1 мин</button>
          <button className="btn" onClick={() => wrap(window.hub.aucTimer('add', 60))}>+1 мин</button>
          <button className="btn" onClick={() => wrap(window.hub.aucTimer('clear'))} disabled={!hasTimer && !a.timeUp}>Сбросить таймер</button>
        </div>
        <div className="btnrow">
          {a.accepting
            ? <button className="btn" onClick={() => wrap(window.hub.aucAccepting(false))}>Закрыть приём ставок</button>
            : <button className="btn" onClick={() => wrap(window.hub.aucAccepting(true))} title="Принимать ставки без таймера">Открыть приём без таймера</button>}
          <button className="btn" disabled={!top || top.rub <= 0} onClick={() => wrap(window.hub.aucFinish())}
            title={pending ? 'Сначала разберите очередь «Требует решения»' : 'Победит лот с наибольшей суммой'}>
            🏆 Объявить победителя
          </button>
          {confirmNew ? (
            <>
              <button className="btn" onClick={() => wrap(window.hub.aucReset(true), () => setConfirmNew(false))} title="Ставки обнулятся, лоты останутся (кроме созданных сами)">Новый: лоты оставить</button>
              <button className="btn" style={{ borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.aucReset(false), () => setConfirmNew(false))}>Новый: всё с нуля</button>
              <button className="btn" onClick={() => setConfirmNew(false)}>Отмена</button>
            </>
          ) : <button className="btn" onClick={() => setConfirmNew(true)}>Новый аукцион</button>}
        </div>
        {pending > 0 && (a.timeUp || !a.accepting) && <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>В очереди «Требует решения» — {pending}. Разберите её до объявления победителя.</p>}
      </div>
      <div className="auc-stats">
        <div><b>{money(a.total)}</b><span>всего</span></div>
        <div><b>{a.lots.length}</b><span>лотов</span></div>
        <div><b>{counted}</b><span>ставок</span></div>
      </div>
    </div>
  )
}

function LotsCard({ a, wrap }: { a: AuctionState; wrap: Wrap }) {
  const [name, setName] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const add = (): void => { if (name.trim()) wrap(window.hub.aucLotAdd(name.trim()), () => setName('')) }
  const max = Math.max(1, ...a.lots.map((l) => l.rub))
  return (
    <div className="card">
      <h3>Лоты <span className="r chip">{a.lots.length}</span></h3>
      <div className="auc-add">
        <input className="input" value={name} maxLength={60} placeholder="Название лота: игра, фильм, челлендж…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <button className="btn" disabled={!name.trim()} onClick={add}>Добавить</button>
      </div>
      <div className="list">
        {a.lots.map((l, i) => (
          <LotRow key={l.id} l={l} lead={i === 0 && l.rub > 0} max={max} total={a.total} lots={a.lots} open={open === l.id}
            toggle={() => setOpen(open === l.id ? null : l.id)} wrap={wrap} />
        ))}
      </div>
      {!a.lots.length && <p className="small muted" style={{ margin: '12px 0 0' }}>Лотов пока нет. Добавьте их заранее — или они появятся из ставок зрителей.</p>}
    </div>
  )
}

function LotRow({ l, lead, max, total, lots, open, toggle, wrap }: {
  l: LotView; lead: boolean; max: number; total: number; lots: LotView[]; open: boolean; toggle: () => void; wrap: Wrap
}) {
  const [name, setName] = useState(l.name)
  const [sum, setSum] = useState('')
  const [into, setInto] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const pct = total > 0 ? Math.round((l.rub / total) * 1000) / 10 : 0
  return (
    <div className={`auc-lot ${open ? 'open' : ''}`}>
      <div className="auc-lot-line" onClick={toggle} title="Изменить, прибавить, объединить">
        <span className="auc-num">#{l.num}</span>
        <div className="grow">
          <div className="auc-lot-name">
            <b className="ellipsis">{l.name}</b>
            {l.auto && <span className="auc-auto">создан сам</span>}
          </div>
          <div className="auc-bar"><div className={lead ? 'lead' : ''} style={{ width: `${(l.rub / max) * 100}%` }} /></div>
        </div>
        <div className="auc-sum">
          <b>{money(l.rub)}</b>
          <span>{pct.toLocaleString('ru-RU')}% · {l.bets} ст.</span>
        </div>
      </div>
      {l.auto && !open && (
        <div className="auc-auto-row">
          <span className="small muted">Лот создан из сообщения зрителя. Нарушает правила — отклоните: ставки вернутся в очередь.</span>
          <button className="btn sm" onClick={() => wrap(window.hub.aucLotApprove(l.id))}>Принять</button>
          <button className="btn sm" style={{ borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.aucLotRemove(l.id))}>Отклонить</button>
        </div>
      )}
      {open && (
        <div className="auc-lot-edit">
          <div className="auc-edit-grid">
            <div className="field"><label>Название</label>
              <div className="auc-add">
                <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <button className="btn sm" disabled={!name.trim() || name.trim() === l.name} onClick={() => wrap(window.hub.aucLotRename(l.id, name.trim()))}>Сохранить</button>
              </div>
            </div>
            <div className="field"><label>Прибавить вручную, ₽</label>
              <div className="auc-add">
                <input className="input mono" type="number" min={1} value={sum} placeholder="100" onChange={(e) => setSum(e.target.value)} />
                <button className="btn sm" disabled={!(Number(sum) > 0)} onClick={() => wrap(window.hub.aucLotAddSum(l.id, Number(sum)), () => setSum(''))}>Прибавить</button>
              </div>
            </div>
            <div className="field"><label>Объединить: перенести ставки в лот</label>
              <div className="auc-add">
                <select className="input" value={into} onChange={(e) => setInto(e.target.value)}>
                  <option value="">— выберите лот —</option>
                  {lots.filter((x) => x.id !== l.id).map((x) => <option key={x.id} value={x.id}>#{x.num} {x.name}</option>)}
                </select>
                <button className="btn sm" disabled={!into} onClick={() => wrap(window.hub.aucLotMerge(l.id, into), toggle)}>Объединить</button>
              </div>
            </div>
          </div>
          <div className="btnrow">
            {l.auto && <button className="btn sm" onClick={() => wrap(window.hub.aucLotApprove(l.id))}>Принять лот</button>}
            <button className="btn sm" onClick={toggle}>Закрыть</button>
            {confirmDel
              ? <button className="btn sm" style={{ marginLeft: 'auto', borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.aucLotRemove(l.id))}>{l.bets ? `Удалить? ${l.bets} ст. уйдут в очередь` : 'Точно удалить?'}</button>
              : <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setConfirmDel(true)}>{l.auto ? 'Отклонить' : 'Удалить'}</button>}
          </div>
        </div>
      )}
    </div>
  )
}

function PendingCard({ a, pending, wrap }: { a: AuctionState; pending: AuctionBet[]; wrap: Wrap }) {
  return (
    <div className="card">
      <h3>Требует решения <Hint id="auctionQueue" /> {pending.length > 0 && <span className="r chip auc-warn">{pending.length}</span>}</h3>
      {pending.length ? (
        <div className="list">
          {pending.map((b) => <PendingRow key={b.id} b={b} lots={a.lots} wrap={wrap} />)}
        </div>
      ) : <p className="small muted" style={{ margin: 0 }}>Пусто — все ставки разобраны.</p>}
    </div>
  )
}

function PendingRow({ b, lots, wrap }: { b: AuctionBet; lots: LotView[]; wrap: Wrap }) {
  const [lot, setLot] = useState('')
  return (
    <div className="auc-bet">
      <div className="auc-bet-head">
        <b className="ellipsis">{b.user}</b>
        <span className="auc-raw">{b.raw}</span>
        <span className="small muted" style={{ marginLeft: 'auto' }}>{SRC[b.source]} · {fmtTime(b.ts)}</span>
      </div>
      <div className="auc-bet-text">{b.text ? `«${b.text}»` : <span className="muted">без сообщения</span>}</div>
      <div className="auc-add">
        <select className="input" value={lot} onChange={(e) => setLot(e.target.value)}>
          <option value="">— в какой лот —</option>
          {lots.map((x) => <option key={x.id} value={x.id}>#{x.num} {x.name}</option>)}
        </select>
        <button className="btn sm" disabled={!lot} onClick={() => wrap(window.hub.aucBetAssign(b.id, lot))}>В лот</button>
        <button className="btn sm" disabled={!b.text.trim()} title="Создать лот с названием из сообщения" onClick={() => wrap(window.hub.aucBetNewLot(b.id))}>Новый лот</button>
        <button className="btn sm" onClick={() => wrap(window.hub.aucBetReject(b.id))}>Отклонить</button>
      </div>
    </div>
  )
}

function HistoryCard({ a, wrap }: { a: AuctionState; wrap: Wrap }) {
  const done = a.bets.filter((b) => b.status !== 'pending').slice(0, 40)
  const names = new Map(a.lots.map((l) => [l.id, `#${l.num} ${l.name}`]))
  return (
    <div className="card">
      <h3>История ставок</h3>
      {done.length ? (
        <div className="list auc-history">
          {done.map((b) => (
            <div key={b.id} className={`row ${b.status === 'rejected' ? 'auc-rejected' : ''}`}>
              <div className="grow">
                <div className="auc-bet-head">
                  <b className="ellipsis">{b.user}</b>
                  <span className="auc-raw">{b.raw}</span>
                </div>
                <div className="small muted ellipsis">{b.status === 'rejected' ? 'отклонена' : `→ ${names.get(b.lotId ?? '') ?? 'лот удалён'}`} · {fmtTime(b.ts)}</div>
              </div>
              <button className="btn sm" title="Вернуть в очередь «Требует решения»" onClick={() => wrap(window.hub.aucBetReopen(b.id))}>↩</button>
            </div>
          ))}
        </div>
      ) : <p className="small muted" style={{ margin: 0 }}>Ставок пока не было.</p>}
    </div>
  )
}

function TextField({ label, value, placeholder, onSave }: { label: ReactNode; value: string; placeholder?: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input" value={v} maxLength={45} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== value) onSave(v.trim()) }} />
    </div>
  )
}

function SettingsCard({ cfg }: { cfg: AuctionSettings }) {
  const set = (p: Partial<AuctionSettings>): void => void window.hub.setSettings({ auction: p })
  return (
    <div className="card">
      <h3>Правила аукциона</h3>
      <div className="grid g2" style={{ gap: 10 }}>
        <NumberField label="Таймер по умолчанию" value={cfg.defaultMin} min={1} max={600} suffix="мин" onChange={(v) => set({ defaultMin: v })} />
        <NumberField label="Лот создаётся сам — от суммы" value={cfg.autoLotMin} min={0} max={10_000_000} suffix="₽ · 0 — выкл." onChange={(v) => set({ autoLotMin: v })} />
      </div>
      <Toggle on={cfg.extend} onChange={(v) => set({ extend: v })} label="Продлевать таймер, если ставка пришла под конец" />
      {cfg.extend && (
        <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
          <NumberField label="Если осталось меньше" value={cfg.extendBelowSec} min={5} max={600} suffix="сек" onChange={(v) => set({ extendBelowSec: v })} />
          <NumberField label="Добавить" value={cfg.extendAddSec} min={5} max={600} suffix="сек" onChange={(v) => set({ extendAddSec: v })} />
        </div>
      )}
      <div className="auc-sep">Баллы канала Twitch</div>
      <div className="grid g2" style={{ gap: 10 }}>
        <TextField label="Награда-ставка (название как на Twitch)" value={cfg.pointsReward} placeholder="Пусто — баллы не принимаются" onSave={(v) => set({ pointsReward: v })} />
        <NumberField label="Баллов за 1 ₽" value={cfg.pointsPerRub} min={1} max={1_000_000} onChange={(v) => set({ pointsPerRub: v })} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>Создайте на Twitch награду с полем для ввода текста — зритель пишет туда название лота. Сумма ставки = цена награды ÷ курс.</p>
    </div>
  )
}

function ManualBetCard({ wrap }: { wrap: Wrap }) {
  const [user, setUser] = useState('')
  const [rub, setRub] = useState('')
  const [text, setText] = useState('')
  return (
    <div className="card">
      <h3>Ставка вручную</h3>
      <div className="auc-manual">
        <input className="input" value={user} maxLength={64} placeholder="Ник" onChange={(e) => setUser(e.target.value)} />
        <input className="input mono" type="number" min={1} value={rub} placeholder="₽" onChange={(e) => setRub(e.target.value)} />
        <input className="input" value={text} maxLength={300} placeholder="Лот: название или #номер" onChange={(e) => setText(e.target.value)} />
        <button className="btn" disabled={!(Number(rub) > 0)} onClick={() => wrap(window.hub.aucManualBet({ user, rub: Number(rub), text }), () => { setRub(''); setText('') })}>Добавить</button>
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>Перевод мимо сервисов или проверка перед эфиром. Работает и при закрытом приёме; в статистику донатов не попадает.</p>
    </div>
  )
}

function ArchiveCard({ a, wrap }: { a: AuctionState; wrap: Wrap }) {
  if (!a.archive.length) return null
  return (
    <div className="card">
      <h3>Прошлые аукционы <button className="btn sm r" onClick={() => wrap(window.hub.aucClearArchive())}>Очистить</button></h3>
      <div className="list">
        {a.archive.map((r) => (
          <div key={r.ts} className="row">
            <div className="grow">
              <b className="ellipsis">{r.winner ? `🏆 ${r.winner.name}` : 'Без объявленного победителя'}</b>
              <div className="small muted ellipsis">{new Date(r.ts).toLocaleDateString('ru-RU')} · {money(r.total)} · {r.bets} ст. · {r.lots.slice(0, 3).map((l) => l.name).join(', ')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
