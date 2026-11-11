import { useEffect, useMemo, useRef, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { AnalyticsPeriod, AnalyticsReport, AudiencePerson, ChatPlatform, StreamSamples, StreamSummary, ViewerRef } from '../../../main/core/analytics'
import { Hint, NumberField, Toggle, errText } from '../components'
import { PLATFORM, PlatIcon, fmtAgo, useNow } from '../ui'

const PERIODS: { id: AnalyticsPeriod; label: string }[] = [
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'quarter', label: '3 месяца' },
  { id: 'all', label: 'Всё время' }
]
const NAME: Record<ChatPlatform, string> = { twitch: 'Twitch', youtube: 'YouTube', vk: 'VK Видео', kick: 'Kick', goodgame: 'GoodGame' }
/** Цвет линии площадки: GoodGame в фирменном цвете почти не виден на тёмном фоне. */
const LINE: Record<ChatPlatform, string> = { twitch: '#a970ff', youtube: '#ff4d6a', vk: '#4d9bff', kick: '#53fc18', goodgame: '#8fa3d9' }

const n0 = (n: number): string => Math.round(n).toLocaleString('ru-RU')
const rub = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`
const hours = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`
}
const day = (ts: number): string => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
const hm = (ts: number): string => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
const refOf = (a: { platform: ChatPlatform; key: string }): ViewerRef => ({ platform: a.platform, key: a.key })

type Wrap = (p: Promise<unknown>, after?: () => void) => void

export function Analytics({ snap }: { snap: HubSnapshot }) {
  const cfg = snap.settings.analytics
  const [period, setPeriod] = useState<AnalyticsPeriod>('month')
  const [rep, setRep] = useState<AnalyticsReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [bump, setBump] = useState(0)
  const now = useNow(15_000)

  useEffect(() => {
    let alive = true
    void window.hub.analytics(period).then((r) => alive && setRep(r)).catch((e) => alive && setErr(errText(e)))
    return () => { alive = false }
  }, [period, bump, now])

  const wrap: Wrap = (p, after) => { setErr(null); p.then(() => { after?.(); setBump((b) => b + 1) }).catch((e) => setErr(errText(e))) }

  return (
    <>
      <div className="head">
        <div>
          <h1>Аналитика <Hint id="analytics" /></h1>
          <p>Кто смотрит и пишет в чат, на каких площадках, кто приходит снова. Только на этом ПК — тексты сообщений не сохраняются.</p>
        </div>
        <div className="actions">
          <div className="seg">
            {PERIODS.map((p) => <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>)}
          </div>
        </div>
      </div>
      {err && <div className="note err" style={{ marginBottom: 14 }}>{err}</div>}
      {!cfg.chat && !cfg.online && <div className="note" style={{ marginBottom: 14 }}>Аналитика выключена: новые эфиры и зрители не записываются. Включить — в карточке «Что записывать» внизу.</div>}
      {rep && <>
        <Overview rep={rep} />
        <div className="grid an-grid">
          <OnlineCard rep={rep} now={now} />
          <PlatformsCard rep={rep} />
        </div>
        <PeopleCard rep={rep} wrap={wrap} now={now} />
        <div className="grid an-grid">
          <StreamsCard rep={rep} />
          <div className="an-side">
            {rep.suggestions.length > 0 && <SuggestCard rep={rep} wrap={wrap} />}
            <SettingsCard snap={snap} wrap={wrap} />
          </div>
        </div>
      </>}
    </>
  )
}

function Overview({ rep }: { rep: AnalyticsReport }) {
  const o = rep.overview
  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: 'Эфиров', value: n0(o.streams), sub: o.airMs ? hours(o.airMs) : undefined },
    { label: 'Средний онлайн', value: o.avg ? n0(o.avg) : '—', sub: 'все площадки вместе' },
    { label: 'Пик онлайна', value: o.peak ? n0(o.peak) : '—' },
    { label: 'Писали в чат', value: n0(o.chatters), sub: o.newChatters ? `новых: ${n0(o.newChatters)}` : undefined },
    { label: 'Ядро аудитории', value: n0(o.core), sub: o.total ? `из ${n0(o.total)} в базе` : undefined }
  ]
  return (
    <div className="an-kpi">
      {tiles.map((t) => (
        <div key={t.label} className="an-tile">
          <span>{t.label}</span>
          <b>{t.value}</b>
          {t.sub && <small>{t.sub}</small>}
        </div>
      ))}
    </div>
  )
}

// ---------- Онлайн эфира: график ----------

function OnlineCard({ rep, now }: { rep: AnalyticsReport; now: number }) {
  const withOnline = rep.streams.filter((s) => s.peak > 0)
  const [sel, setSel] = useState<string | null>(null)
  const id = sel && rep.streams.some((s) => s.id === sel) ? sel : withOnline[0]?.id ?? null
  const summary = rep.streams.find((s) => s.id === id) ?? null
  const [data, setData] = useState<StreamSamples | null>(null)
  useEffect(() => {
    if (!id) { setData(null); return }
    let alive = true
    void window.hub.analyticsStream(id).then((d) => alive && setData(d))
    return () => { alive = false }
  }, [id, summary?.live ? now : 0])

  return (
    <div className="card">
      <h3>
        Онлайн эфира
        {rep.streams.length > 0 && (
          <select className="input an-select r" value={id ?? ''} onChange={(e) => setSel(e.target.value)}>
            {rep.streams.map((s) => <option key={s.id} value={s.id}>{day(s.started)}, {hm(s.started)}{s.live ? ' — идёт' : ''}{s.peak ? '' : ' (без онлайна)'}</option>)}
          </select>
        )}
      </h3>
      {!summary ? (
        <p className="small muted">Эфиров за этот период нет. Онлайн записывается раз в минуту, пока идёт трансляция (OBS или площадка «в эфире»).</p>
      ) : (
        <>
          <div className="an-stream-meta">
            {summary.live && <span className="chip auc-state on">● Идёт</span>}
            <span>{hours(summary.ended - summary.started)}</span>
            <span>среднее <b>{n0(summary.avg)}</b></span>
            <span>пик <b>{n0(summary.peak)}</b></span>
            <span>в чате <b>{n0(summary.chatters)}</b>{summary.newChatters ? ` · новых ${n0(summary.newChatters)}` : ''}</span>
          </div>
          {data && data.points.length > 1 ? <Chart data={data} /> : <p className="small muted">Точек онлайна пока нет{summary.live ? ' — первая появится через минуту' : ': площадки не сообщали число зрителей'}.</p>}
        </>
      )}
    </div>
  )
}

function Chart({ data }: { data: StreamSamples }) {
  const W = 600
  const H = 190
  const pts = data.points
  const plats = useMemo(() => {
    const s = new Set<ChatPlatform>()
    for (const p of pts) for (const k of Object.keys(p.v) as ChatPlatform[]) s.add(k)
    return [...s]
  }, [pts])
  const total = pts.map((p) => Object.values(p.v).reduce((a, x) => a + (x ?? 0), 0))
  const max = Math.max(1, ...total)
  const t0 = pts[0].t
  const span = Math.max(1, pts[pts.length - 1].t - t0)
  const x = (t: number): number => ((t - t0) / span) * W
  const y = (v: number): number => H - (v / max) * (H - 8)
  const line = (vals: number[]): string => vals.map((v, i) => `${i ? 'L' : 'M'}${x(pts[i].t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const [hover, setHover] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const move = (e: React.MouseEvent): void => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const t = t0 + ((e.clientX - r.left) / r.width) * span
    let best = 0
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i
    setHover(best)
  }
  const hp = hover !== null ? pts[hover] : null
  const left = hp ? (x(hp.t) / W) * 100 : 0

  return (
    <div className="an-chart">
      <div className="an-legend">
        <span><i style={{ background: 'var(--ink)' }} />Всего</span>
        {plats.length > 1 && plats.map((p) => <span key={p}><i style={{ background: LINE[p] }} />{NAME[p]}</span>)}
      </div>
      <div className="an-plot" ref={box} onMouseMove={move} onMouseLeave={() => setHover(null)}>
        <span className="an-ymax">{n0(max)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} className="an-grid-line" vectorEffect="non-scaling-stroke" />)}
          {plats.length > 1 && plats.map((p) => <path key={p} d={line(pts.map((q) => q.v[p] ?? 0))} stroke={LINE[p]} strokeWidth={1.5} fill="none" opacity={0.85} vectorEffect="non-scaling-stroke" />)}
          <path d={line(total)} stroke="var(--ink)" strokeWidth={2.2} fill="none" vectorEffect="non-scaling-stroke" />
          {hp && <line x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={H} className="an-cursor" vectorEffect="non-scaling-stroke" />}
        </svg>
        {hp && hover !== null && (
          <div className={`an-tip ${left > 70 ? 'flip' : ''}`} style={{ left: `${left}%` }}>
            <div className="muted">{hm(hp.t)}</div>
            <div><b>{n0(total[hover])}</b> всего</div>
            {plats.length > 1 && plats.map((p) => <div key={p}><i style={{ background: LINE[p] }} />{NAME[p]}: {n0(hp.v[p] ?? 0)}</div>)}
          </div>
        )}
      </div>
      <div className="an-xaxis"><span>{hm(t0)}</span><span>{hm(pts[pts.length - 1].t)}</span></div>
    </div>
  )
}

// ---------- Площадки ----------

function PlatformsCard({ rep }: { rep: AnalyticsReport }) {
  const maxAvg = Math.max(1, ...rep.platforms.map((p) => p.avg))
  return (
    <div className="card">
      <h3>По площадкам</h3>
      {rep.platforms.length === 0 ? <p className="small muted">Данных пока нет — появятся после первого эфира с чатом.</p> : (
        <div className="an-plats">
          <div className="an-plat an-plat-head small muted"><span /><span>Средний онлайн</span><span>Пик</span><span>Писали в чат</span></div>
          {rep.platforms.map((p) => (
            <div key={p.platform} className="an-plat">
              <span className="an-plat-name"><PlatIcon p={p.platform} />{NAME[p.platform]}</span>
              <span className="an-bar-cell">
                <b>{p.avg ? n0(p.avg) : '—'}</b>
                <span className="an-bar"><i style={{ width: `${(p.avg / maxAvg) * 100}%`, background: LINE[p.platform] }} /></span>
              </span>
              <span className="mono">{p.peak ? n0(p.peak) : '—'}</span>
              <span className="mono">{n0(p.chatters)} <span className="muted">· {p.share}%</span></span>
            </div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12 }}>Онлайн — со страниц площадок раз в минуту. «Писали в чат» — разные ники за период; доля — от всех площадок.</p>
    </div>
  )
}

// ---------- Зрители ----------

type Filter = 'all' | 'core' | 'new'
type Sort = 'messages' | 'streams' | 'donations' | 'recent'

function PeopleCard({ rep, wrap, now }: { rep: AnalyticsReport; wrap: Wrap; now: number }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('messages')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [limit, setLimit] = useState(50)

  const list = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/ё/g, 'е')
    const out = rep.people.filter((p) =>
      (filter === 'all' || (filter === 'core' && p.core) || (filter === 'new' && p.firstTs >= rep.since)) &&
      (!s || p.accounts.some((a) => a.key.includes(s))))
    const by: Record<Sort, (a: AudiencePerson, b: AudiencePerson) => number> = {
      messages: (a, b) => b.messages - a.messages,
      streams: (a, b) => b.streams - a.streams || b.messages - a.messages,
      donations: (a, b) => b.donations.rub - a.donations.rub || b.messages - a.messages,
      recent: (a, b) => b.lastTs - a.lastTs
    }
    return out.sort(by[sort])
  }, [rep, filter, sort, q])

  const sel = rep.people.filter((p) => picked.includes(p.id))
  const toggle = (id: string): void => setPicked((x) => (x.includes(id) ? x.filter((i) => i !== id) : [...x, id]))

  return (
    <div className="card an-people">
      <h3>
        Зрители <span className="muted small">{n0(rep.peopleTotal)} за период</span>
        <input className="input an-search r" placeholder="Найти ник" value={q} onChange={(e) => setQ(e.target.value)} />
      </h3>
      <div className="an-tools">
        <div className="seg">
          {([['all', 'Все'], ['core', 'Ядро'], ['new', 'Новые']] as [Filter, string][]).map(([id, l]) => <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{l}</button>)}
        </div>
        <div className="seg">
          {([['messages', 'Сообщения'], ['streams', 'Эфиры'], ['donations', 'Донаты'], ['recent', 'Недавно']] as [Sort, string][]).map(([id, l]) => <button key={id} className={sort === id ? 'on' : ''} onClick={() => setSort(id)}>{l}</button>)}
        </div>
      </div>
      {sel.length > 0 && (
        <div className="an-merge-bar">
          <span className="grow">Выбрано: <b>{sel.map((p) => p.name).join(', ')}</b></span>
          <button className="btn sm primary" disabled={sel.length < 2}
            onClick={() => wrap(window.hub.analyticsMerge(sel.flatMap((p) => p.accounts.map(refOf))), () => setPicked([]))}>
            Склеить в одного зрителя
          </button>
          <button className="btn sm" onClick={() => setPicked([])}>Снять выбор</button>
        </div>
      )}
      {list.length === 0 ? (
        <p className="small muted">{rep.peopleTotal ? 'Никого не нашлось.' : 'Пока никого: зрители появятся, когда кто-нибудь напишет в чат.'}</p>
      ) : (
        <div className="an-table">
          <div className="an-row an-row-head small muted">
            <span /><span>Зритель</span><span>Сообщений</span><span>Эфиров</span><span>Донаты</span><span>Был</span>
          </div>
          {list.slice(0, limit).map((p) => (
            <div key={p.id} className={`an-item ${open === p.id ? 'open' : ''}`}>
              <div className="an-row" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <input type="checkbox" checked={picked.includes(p.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(p.id)} title="Выбрать для склейки" />
                <span className="an-who">
                  <span className="an-icons">{[...new Set(p.accounts.map((a) => a.platform))].map((pl) => <PlatIcon key={pl} p={pl} />)}</span>
                  <b className="ellipsis">{p.name}</b>
                  {p.core && <span className="an-badge core">ядро</span>}
                  {p.firstTs >= rep.since && rep.since > 0 && <span className="an-badge">новый</span>}
                  {p.merged && <span className="an-badge" title="Склеенные аккаунты">{p.accounts.length} акк.</span>}
                </span>
                <span className="mono">{n0(p.messages)}</span>
                <span className="mono">{n0(p.streams)}</span>
                <span className="mono">{p.donations.rub ? rub(p.donations.rub) : '—'}</span>
                <span className="small muted">{fmtAgo(p.lastTs, now)}</span>
              </div>
              {open === p.id && <PersonDetail p={p} wrap={wrap} />}
            </div>
          ))}
        </div>
      )}
      {list.length > limit && <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setLimit(limit + 100)}>Показать ещё ({n0(list.length - limit)})</button>}
    </div>
  )
}

function PersonDetail({ p, wrap }: { p: AudiencePerson; wrap: Wrap }) {
  const [sure, setSure] = useState(false)
  return (
    <div className="an-detail">
      <div className="small muted">Впервые: {new Date(p.firstTs).toLocaleDateString('ru-RU')} · последний раз: {new Date(p.lastTs).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}{p.donations.count ? ` · донатов: ${p.donations.count}` : ''}</div>
      {p.accounts.map((a) => (
        <div key={a.platform + a.key} className="an-acc">
          <PlatIcon p={a.platform} />
          <span className="grow ellipsis">{a.user} <span className="muted small">· {NAME[a.platform]}</span></span>
          <span className="small muted">{n0(a.messages)} сообщ. · {n0(a.streams)} эфир.</span>
          {p.merged && <button className="btn sm" onClick={() => wrap(window.hub.analyticsUnmerge(refOf(a)))}>Отделить</button>}
        </div>
      ))}
      <div className="an-detail-foot">
        {!sure
          ? <button className="btn sm" onClick={() => setSure(true)}>Забыть зрителя</button>
          : <>
            <span className="small">Удалить «{p.name}» из аналитики? Если он снова напишет в чат — появится как новый.</span>
            <button className="btn sm an-danger" onClick={() => wrap(window.hub.analyticsForget(p.id))}>Удалить</button>
            <button className="btn sm" onClick={() => setSure(false)}>Отмена</button>
          </>}
      </div>
    </div>
  )
}

function SuggestCard({ rep, wrap }: { rep: AnalyticsReport; wrap: Wrap }) {
  return (
    <div className="card">
      <h3>Похоже, это один человек <Hint id="analyticsMerge" /></h3>
      <div className="an-sugg">
        {rep.suggestions.slice(0, 8).map((s) => (
          <div key={s.key} className="an-sugg-row">
            <span className="an-icons">{s.accounts.map((a) => <PlatIcon key={a.platform} p={a.platform} />)}</span>
            <span className="grow ellipsis"><b>{s.name}</b> <span className="small muted">· {s.accounts.map((a) => NAME[a.platform]).join(', ')}</span></span>
            <button className="btn sm primary" onClick={() => wrap(window.hub.analyticsMerge(s.accounts.map(refOf)))}>Склеить</button>
            <button className="btn sm" onClick={() => wrap(window.hub.analyticsDismiss(s.key))}>Не он</button>
          </div>
        ))}
      </div>
      {rep.suggestions.length > 8 && <p className="small muted" style={{ marginTop: 8 }}>И ещё {rep.suggestions.length - 8} — появятся по мере разбора.</p>}
    </div>
  )
}

// ---------- История эфиров ----------

function StreamsCard({ rep }: { rep: AnalyticsReport }) {
  const [limit, setLimit] = useState(15)
  const list: StreamSummary[] = rep.streams
  return (
    <div className="card">
      <h3>История эфиров</h3>
      {list.length === 0 ? <p className="small muted">Эфиров за период нет.</p> : (
        <div className="an-table">
          <div className="an-srow an-row-head small muted"><span>Когда</span><span>Длилось</span><span>Среднее</span><span>Пик</span><span>В чате</span><span>Новых</span></div>
          {list.slice(0, limit).map((s) => (
            <div key={s.id} className="an-srow">
              <span>{day(s.started)}, {hm(s.started)} {s.live && <span className="an-badge core">идёт</span>}</span>
              <span className="mono">{hours(s.ended - s.started)}</span>
              <span className="mono">{s.avg ? n0(s.avg) : '—'}</span>
              <span className="mono">{s.peak ? n0(s.peak) : '—'}</span>
              <span className="mono">{n0(s.chatters)}</span>
              <span className="mono">{n0(s.newChatters)}</span>
            </div>
          ))}
        </div>
      )}
      {list.length > limit && <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setLimit(limit + 30)}>Показать ещё</button>}
    </div>
  )
}

// ---------- Что записывать ----------

function SettingsCard({ snap, wrap }: { snap: HubSnapshot; wrap: Wrap }) {
  const a = snap.settings.analytics
  const [ignore, setIgnore] = useState(a.ignore)
  const [sure, setSure] = useState(false)
  useEffect(() => setIgnore(a.ignore), [a.ignore])
  const set = (patch: Partial<typeof a>): void => wrap(window.hub.setSettings({ analytics: patch }))
  return (
    <div className="card">
      <h3>Что записывать</h3>
      <div className="an-set">
        <Toggle on={a.chat} onChange={(v) => set({ chat: v })} label={<>Зрителей чата <span className="small muted">— ник, площадка и счётчики, без текста</span></>} />
        <Toggle on={a.online} onChange={(v) => set({ online: v })} label={<>Онлайн площадок <span className="small muted">— раз в минуту во время эфира</span></>} />
        <NumberField label="Ядро аудитории — был на эфирах, от" value={a.coreMin} min={2} max={100} onChange={(v) => set({ coreMin: v })} />
        <div className="field">
          <label>Не считать эти ники (боты), через запятую</label>
          <textarea className="input" rows={2} value={ignore} onChange={(e) => setIgnore(e.target.value)} onBlur={() => ignore !== a.ignore && set({ ignore })} />
        </div>
      </div>
      <div className="an-detail-foot" style={{ marginTop: 14 }}>
        {!sure
          ? <button className="btn sm" onClick={() => setSure(true)}>Очистить всю аналитику…</button>
          : <>
            <span className="small">Удалить всех зрителей и историю эфиров? Это не отменить. Донаты и события останутся.</span>
            <button className="btn sm an-danger" onClick={() => wrap(window.hub.analyticsClear(), () => setSure(false))}>Очистить</button>
            <button className="btn sm" onClick={() => setSure(false)}>Отмена</button>
          </>}
      </div>
    </div>
  )
}
