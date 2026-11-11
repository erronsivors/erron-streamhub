import { useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { GoalGift, GoalInput, GoalState } from '../../../main/core/goal'
import { Hint, errText } from '../components'
import { fmtTime, useNow } from '../ui'

const money = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`
const left = (ms: number): string => {
  const t = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(t / 86400)
  const h = Math.floor((t % 86400) / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const p = (x: number): string => String(x).padStart(2, '0')
  return d ? `${d} д ${h} ч` : h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`
}
const SRC: Record<GoalGift['source'], string> = { donation: 'донат', manual: 'вручную', hand: 'добавлено' }

type Wrap = (p: Promise<unknown>, after?: () => void) => void

export function Goal({ snap }: { snap: HubSnapshot }) {
  const st = snap.goal
  const g = st.goal
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const wrap: Wrap = (p, after) => { setErr(null); p.then(() => after?.()).catch((e) => setErr(errText(e))) }

  return (
    <>
      <div className="head">
        <div>
          <h1>Сбор средств <Hint id="goal" /></h1>
          <p>Цель с этапами: донаты в рублях и ручные донаты засчитываются сами, с момента запуска цели.</p>
        </div>
        {g && (
          <div className="actions">
            <span className={`chip auc-state ${g.accepting ? 'on' : ''}`}>{g.accepting ? '● Сбор идёт' : g.timeUp ? 'Срок вышел' : 'Пауза'}</span>
          </div>
        )}
      </div>
      {err && <div className="note err" style={{ marginBottom: 14 }}>{err}</div>}
      {!g && (
        <div className="grid g2">
          <GoalForm title="Новая цель" submit="Запустить сбор" withDuration onSubmit={(v, done) => wrap(window.hub.goalStart(v), done)} />
          <ArchiveCard st={st} wrap={wrap} />
        </div>
      )}
      {g && editing && (
        <div style={{ marginBottom: 18 }}>
          <GoalForm title="Изменить цель" submit="Сохранить" initial={{ title: g.title, target: g.target, startRub: g.startRub, stages: g.stages }}
            onCancel={() => setEditing(false)} onSubmit={(v, done) => wrap(window.hub.goalEdit(v), () => { done(); setEditing(false) })} />
        </div>
      )}
      {g && !editing && <ProgressCard st={st} wrap={wrap} onEdit={() => setEditing(true)} />}
      {g && (
        <div className="grid goal-grid">
          <GiftsCard st={st} wrap={wrap} />
          <div className="auc-side">
            <AddCard wrap={wrap} />
            <TopCard st={st} />
            <ArchiveCard st={st} wrap={wrap} />
          </div>
        </div>
      )}
    </>
  )
}

function ProgressCard({ st, wrap, onEdit }: { st: GoalState; wrap: Wrap; onEdit: () => void }) {
  const g = st.goal!
  const now = useNow(1000)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [dur, setDur] = useState('60')
  const fill = Math.min(100, (st.collected / g.target) * 100)
  const done = st.collected >= g.target
  const celebrate = st.celebrate && now - st.celebrate.ts < 9000 ? st.celebrate : null

  return (
    <div className={`card goal-hero ${celebrate ? 'party' : ''}`}>
      {celebrate && (
        <div className="goal-party">
          <span className="goal-kicker">{celebrate.kind === 'goal' ? 'Цель достигнута' : 'Этап достигнут'}</span>
          <b>{celebrate.name}</b>
          <span className="muted">{money(celebrate.rub)}</span>
        </div>
      )}
      <div className="goal-top">
        <div className="grow">
          <div className="goal-kicker">Собираем на</div>
          <div className="goal-title">{g.title}</div>
        </div>
        <div className="goal-sum">
          <b>{money(st.collected)}</b>
          <span>из {money(g.target)} · {st.pct.toLocaleString('ru-RU')}%</span>
        </div>
      </div>
      <div className="goal-bar">
        <div className={`goal-fill ${done ? 'done' : ''}`} style={{ width: fill + '%' }} />
        {g.stages.map((x) => (
          <i key={x.id} className={`goal-tick ${st.collected >= x.rub ? 'on' : ''}`} style={{ left: (x.rub / g.target) * 100 + '%' }} title={`${money(x.rub)} — ${x.name}`} />
        ))}
      </div>
      <div className="goal-under">
        <span className="small muted">
          {done ? `Цель достигнута${st.collected > g.target ? `, сверху ещё ${money(st.collected - g.target)}` : ''}`
            : st.next ? <>Следующий этап — <b className="goal-next">{st.next.name}</b> на {money(st.next.rub)}, осталось {money(st.next.rub - st.collected)}</>
              : `До цели осталось ${money(g.target - st.collected)}`}
        </span>
        {g.startRub > 0 && <span className="small muted">в том числе собрано до старта: {money(g.startRub)}</span>}
      </div>
      {g.stages.length > 0 && (
        <div className="goal-stages">
          {g.stages.map((x) => (
            <div key={x.id} className={`goal-stage ${st.collected >= x.rub ? 'on' : ''}`}>
              <span className="goal-dot" /><span className="goal-srub">{money(x.rub)}</span><span className="goal-sname">{x.name}</span>
            </div>
          ))}
        </div>
      )}
      <div className="goal-ctl">
        <div className="goal-clock">
          <span className="small muted">Срок</span>
          <b className={g.endsAt && !g.timeUp && g.endsAt - now < 5 * 60_000 ? 'low' : ''}>{g.timeUp ? 'вышел' : g.endsAt ? left(g.endsAt - now) : 'без срока'}</b>
        </div>
        <div className="btnrow">
          <button className="btn" onClick={() => wrap(window.hub.goalExtend(15))}>+15 мин</button>
          <button className="btn" onClick={() => wrap(window.hub.goalExtend(60))}>+1 час</button>
          <span className="goal-dur">
            <input className="input" value={dur} inputMode="numeric" onChange={(e) => setDur(e.target.value.replace(/\D/g, '').slice(0, 5))} />
            <span className="small muted">мин</span>
            <button className="btn" disabled={!Number(dur)} onClick={() => wrap(window.hub.goalDuration(Number(dur)))}>Задать срок</button>
          </span>
          {g.endsAt && <button className="btn" onClick={() => wrap(window.hub.goalDuration(0))}>Без срока</button>}
        </div>
        <div className="btnrow">
          {g.accepting
            ? <button className="btn" onClick={() => wrap(window.hub.goalAccepting(false))}>❚❚ Пауза</button>
            : <button className="btn primary" onClick={() => wrap(window.hub.goalAccepting(true))}>▶ {g.timeUp ? 'Продолжить без срока' : 'Продолжить сбор'}</button>}
          <button className="btn" onClick={onEdit}>Изменить цель</button>
          {confirmEnd ? (
            <>
              <button className="btn" style={{ borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.goalFinish(), () => setConfirmEnd(false))}>Да, завершить</button>
              <button className="btn" onClick={() => setConfirmEnd(false)}>Отмена</button>
            </>
          ) : <button className="btn" onClick={() => setConfirmEnd(true)} title="Сбор уйдёт в архив, оверлей опустеет">Завершить сбор</button>}
        </div>
      </div>
    </div>
  )
}

type Draft = { title: string; target: string; startRub: string; stages: { id?: string; rub: string; name: string }[]; duration: string }

function GoalForm({ title, submit, initial, withDuration, onSubmit, onCancel }: {
  title: string; submit: string; withDuration?: boolean
  initial?: { title: string; target: number; startRub: number; stages: { id: string; rub: number; name: string }[] }
  onSubmit: (v: GoalInput, done: () => void) => void; onCancel?: () => void
}) {
  const [d, setD] = useState<Draft>(() => ({
    title: initial?.title ?? '', target: initial ? String(initial.target) : '', startRub: initial?.startRub ? String(initial.startRub) : '',
    stages: initial?.stages.map((x) => ({ id: x.id, rub: String(x.rub), name: x.name })) ?? [], duration: ''
  }))
  const numOnly = (v: string): string => v.replace(/[^\d]/g, '').slice(0, 9)
  const setStage = (i: number, p: Partial<Draft['stages'][number]>): void => setD({ ...d, stages: d.stages.map((x, k) => (k === i ? { ...x, ...p } : x)) })
  const target = Number(d.target) || 0
  const bad = d.stages.filter((x) => x.rub && x.name.trim() && Number(x.rub) >= target && target > 0)
  const send = (): void => onSubmit({
    title: d.title.trim(), target, startRub: Number(d.startRub) || 0,
    stages: d.stages.filter((x) => Number(x.rub) > 0 && x.name.trim()).map((x) => ({ ...(x.id ? { id: x.id } : {}), rub: Number(x.rub), name: x.name.trim() })),
    ...(withDuration ? { durationMin: Number(d.duration) || 0 } : {})
  }, () => {})

  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="field">
        <label>На что собираем</label>
        <input className="input" value={d.title} maxLength={80} placeholder="Новая камера, поездка на турнир, ремонт сетапа…" onChange={(e) => setD({ ...d, title: e.target.value })} />
      </div>
      <div className={`grid ${withDuration ? 'g3' : 'g2'}`} style={{ gap: 10 }}>
        <div className="field">
          <label>Цель, ₽</label>
          <input className="input" value={d.target} inputMode="numeric" placeholder="30000" onChange={(e) => setD({ ...d, target: numOnly(e.target.value) })} />
        </div>
        <div className="field">
          <label>Уже собрано, ₽</label>
          <input className="input" value={d.startRub} inputMode="numeric" placeholder="0" onChange={(e) => setD({ ...d, startRub: numOnly(e.target.value) })} />
        </div>
        {withDuration && (
          <div className="field">
            <label>Срок, мин</label>
            <input className="input" value={d.duration} inputMode="numeric" placeholder="без срока" onChange={(e) => setD({ ...d, duration: numOnly(e.target.value).slice(0, 5) })} />
          </div>
        )}
      </div>
      <div className="field">
        <label>Этапы — промежуточные суммы со своим обещанием</label>
        {d.stages.map((x, i) => (
          <div key={i} className="goal-srow">
            <input className="input" value={x.rub} inputMode="numeric" placeholder="10000" onChange={(e) => setStage(i, { rub: numOnly(e.target.value) })} />
            <input className="input" value={x.name} maxLength={80} placeholder="Играю в хоррор до утра" onChange={(e) => setStage(i, { name: e.target.value })} />
            <button className="btn sm" title="Убрать этап" onClick={() => setD({ ...d, stages: d.stages.filter((_, k) => k !== i) })}>✕</button>
          </div>
        ))}
        {d.stages.length < 20 && <button className="linkbtn" style={{ alignSelf: 'flex-start' }} onClick={() => setD({ ...d, stages: [...d.stages, { rub: '', name: '' }] })}>+ Добавить этап</button>}
        {bad.length > 0 && <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>Этап на сумму не меньше цели не сохранится — его заменит сама цель.</p>}
      </div>
      <div className="btnrow">
        <button className="btn primary" disabled={!d.title.trim() || target <= 0} onClick={send}>{submit}</button>
        {onCancel && <button className="btn" onClick={onCancel}>Отмена</button>}
      </div>
    </div>
  )
}

function GiftsCard({ st, wrap }: { st: GoalState; wrap: Wrap }) {
  const gifts = st.goal?.gifts ?? []
  const counted = gifts.filter((x) => !x.undone).length
  return (
    <div className="card">
      <h3>Поступления <span className="r chip">{counted}</span></h3>
      {gifts.length === 0 && <p className="small muted" style={{ margin: 0 }}>Пока пусто. Донаты появятся здесь сами; для проверки — «Добавить сумму» или ручной донат в «Событиях».</p>}
      <div className="goal-gifts">
        {gifts.map((x) => (
          <div key={x.id} className={`auc-bet ${x.undone ? 'auc-rejected' : ''}`}>
            <div className="auc-bet-head">
              <b className="goal-guser">{x.user}</b>
              <span className="auc-raw">{money(x.rub)}</span>
              <span className="small muted">{SRC[x.source]} · {fmtTime(x.ts)}</span>
              <button className="btn sm" title={x.undone ? 'Вернуть в сбор' : 'Отменить — не засчитывать'} onClick={() => wrap(window.hub.goalToggleGift(x.id))}>{x.undone ? 'Вернуть' : '↩'}</button>
            </div>
            {x.text && <div className="auc-bet-text">{x.text}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function AddCard({ wrap }: { wrap: Wrap }) {
  const [rub, setRub] = useState('')
  const [note, setNote] = useState('')
  const add = (): void => { if (Number(rub) > 0) wrap(window.hub.goalAdd(Number(rub), note.trim()), () => { setRub(''); setNote('') }) }
  return (
    <div className="card">
      <h3>Добавить сумму</h3>
      <p className="small muted" style={{ marginTop: -6 }}>Деньги, собранные мимо Crossember. Идут только в сбор — не в ленту, не в статистику и не в правила.</p>
      <div className="goal-add">
        <input className="input" value={rub} inputMode="numeric" placeholder="₽" onChange={(e) => setRub(e.target.value.replace(/[^\d]/g, '').slice(0, 9))} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <input className="input" value={note} maxLength={300} placeholder="Заметка: перевод от друга…" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <button className="btn" disabled={!(Number(rub) > 0)} onClick={add}>Добавить</button>
      </div>
    </div>
  )
}

function TopCard({ st }: { st: GoalState }) {
  return (
    <div className="card">
      <h3>Топ сбора</h3>
      {st.top.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Здесь появятся зрители, которые поддержали сбор больше всех.</p> : (
        <div className="goal-top-list">
          {st.top.map((x, i) => (
            <div key={x.user} className="goal-top-row">
              <span className="auc-num">{i + 1}</span><span className="grow">{x.user}</span><b>{money(x.rub)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ArchiveCard({ st, wrap }: { st: GoalState; wrap: Wrap }) {
  if (!st.archive.length) return null
  return (
    <div className="card">
      <h3>Прошлые сборы <button className="r btn sm" onClick={() => wrap(window.hub.goalClearArchive())}>Очистить</button></h3>
      {st.archive.map((x, i) => (
        <div key={i} className="goal-top-row">
          <span className="grow">{x.title}<span className="small muted"> · {new Date(x.endedAt).toLocaleDateString('ru-RU')}</span></span>
          <b>{money(x.collected)}</b><span className="small muted">из {money(x.target)}</span>
        </div>
      ))}
    </div>
  )
}
