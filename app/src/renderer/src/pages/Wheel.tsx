import { useEffect, useRef, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { WheelItem, WheelSector, WheelSpin, WheelState } from '../../../main/core/wheel'
import type { AppSettings } from '../../../main/core/settings'
import { Hint, NumberField, errText } from '../components'
import { fmtTime } from '../ui'

const PAL = ['#e0303e', '#8a3bc4', '#2f62e0', '#b8344f', '#6236a8', '#2a4fb8']


/** Те же сектора, что посчитает ядро: обычный — по весу, на выбывание — обратно весу, «поровну» — одинаковые. */
function sectorsOf(w: WheelState, cfg: AppSettings['wheel']): WheelSector[] {
  const alive = cfg.mode === 'elim' ? w.items.filter((i) => !w.out.includes(i.id)) : w.items
  const raw = alive.map((i) => (cfg.weighting === 'equal' ? 1 : cfg.mode === 'elim' ? 1 / i.weight : i.weight))
  const total = raw.reduce((a, x) => a + x, 0) || 1
  return alive.map((i, k) => ({ id: i.id, name: i.name, frac: raw[k] / total }))
}

function targetAngle(sp: WheelSpin): number {
  let a0 = 0
  for (const s of sp.sectors) {
    if (s.id === sp.targetId) return sp.turns * 360 - (a0 + s.frac * 360 * sp.offset)
    a0 += s.frac * 360
  }
  return sp.turns * 360
}

const pt = (deg: number, r: number): [number, number] => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)]

export function Wheel({ snap }: { snap: HubSnapshot }) {
  const w = snap.wheel
  const cfg = snap.settings.wheel
  const [err, setErr] = useState<string | null>(null)
  const wrap = (p: Promise<unknown>, after?: () => void): void => { setErr(null); p.then(() => after?.()).catch((e) => setErr(errText(e))) }
  const set = (p: Partial<AppSettings['wheel']>): void => void window.hub.setSettings({ wheel: p })
  const alive = cfg.mode === 'elim' ? w.items.length - w.out.length : w.items.length
  const spinning = !!w.spin

  return (
    <>
      <div className="head">
        <div>
          <h1>Колесо <Hint id="wheel" /></h1>
          <p>Свой список или лоты аукциона. Кто выпадет, решается заранее и честно — колесо только докручивается до итога.</p>
        </div>
      </div>
      {err && <div className="note err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="grid wh-grid">
        <div className="card wh-main">
          <WheelView w={w} cfg={cfg} />
          <ResultLine w={w} />
          <div className="wh-ctl">
            <button className="btn primary wh-spin" disabled={spinning || alive < 2} onClick={() => wrap(window.hub.wheelSpin())}>
              {spinning ? 'Крутится…' : cfg.mode === 'elim' && w.out.length ? 'Крутить дальше' : 'Крутить'}
            </button>
            {cfg.mode === 'elim' && (w.out.length > 0 || w.winner) && <button className="btn" disabled={spinning} onClick={() => wrap(window.hub.wheelRestart())}>Начать заново</button>}
          </div>
          <div className="wh-opts">
            <div className="field">
              <label>Режим</label>
              <div className="seg">
                <button className={cfg.mode === 'normal' ? 'on' : ''} disabled={spinning} onClick={() => set({ mode: 'normal' })}>Обычное</button>
                <button className={cfg.mode === 'elim' ? 'on' : ''} disabled={spinning} onClick={() => set({ mode: 'elim' })}>На выбывание</button>
              </div>
            </div>
            <div className="field">
              <label>Размер секторов</label>
              <div className="seg">
                <button className={cfg.weighting === 'weight' ? 'on' : ''} disabled={spinning} onClick={() => set({ weighting: 'weight' })}>{w.fromAuction ? 'По сумме' : 'По весу'}</button>
                <button className={cfg.weighting === 'equal' ? 'on' : ''} disabled={spinning} onClick={() => set({ weighting: 'equal' })}>Поровну</button>
              </div>
            </div>
            <NumberField label="Крутится" value={cfg.durationSec} min={3} max={60} suffix="сек" onChange={(v) => set({ durationSec: v })} />
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {cfg.mode === 'elim'
              ? (cfg.weighting === 'equal' ? 'Каждый раз вылетает выпавший вариант, шансы равные. Последний оставшийся — победитель.' : 'Каждый раз вылетает выпавший вариант. Чем больше вес (сумма), тем меньше сектор — крупные держатся дольше. Последний оставшийся — победитель.')
              : (cfg.weighting === 'equal' ? 'Выпавший вариант побеждает. Шансы у всех равные.' : 'Выпавший вариант побеждает. Шанс = доля веса (суммы).')}
            {w.fromAuction && ' Победитель колеса сразу станет победителем аукциона.'}
          </p>
        </div>
        <div className="wh-side">
          <ItemsCard w={w} cfg={cfg} wrap={wrap} />
          <HistoryCard w={w} wrap={wrap} />
        </div>
      </div>
    </>
  )
}

function ResultLine({ w }: { w: WheelState }) {
  if (w.spin) return <div className="wh-result muted">Крутится…</div>
  const r = w.result
  if (w.winner && (!r || w.winner.ts >= r.ts)) return <div className="wh-result"><span className="wh-kick">Победитель</span><b>{w.winner.name}</b></div>
  if (r?.kind === 'out') return <div className="wh-result"><span className="wh-kick out">Выбывает</span><b>{r.name}</b><span className="muted small">осталось {w.items.length - w.out.length}</span></div>
  return <div className="wh-result muted">{w.items.length - w.out.length >= 2 ? 'Готово к прокрутке' : 'Добавьте хотя бы два варианта'}</div>
}

/** Колесо в интерфейсе: та же геометрия и та же кривая, что в оверлее. */
function WheelView({ w, cfg }: { w: WheelState; cfg: AppSettings['wheel'] }) {
  const gRef = useRef<SVGGElement>(null)
  const last = useRef<{ spin: WheelSpin; angle: number } | null>(null)
  const sp = w.spin
  if (sp && last.current?.spin.id !== sp.id) last.current = { spin: sp, angle: targetAngle(sp) }
  // После прокрутки колесо стоит на итоге, пока набор вариантов не изменился.
  const shown = sp ?? (last.current && sameSet(last.current.spin.sectors, sectorsOf(w, cfg)) && !w.out.includes(last.current.spin.targetId) ? last.current.spin : null) ??
    (last.current && w.result && w.result.id === last.current.spin.targetId ? last.current.spin : null)
  const sectors = shown ? shown.sectors : sectorsOf(w, cfg)

  useEffect(() => {
    const g = gRef.current
    if (!g) return
    if (!sp) {
      g.setAttribute('transform', `rotate(${shown && last.current ? last.current.angle : 0})`)
      return
    }
    const end = last.current!.angle
    let raf = 0
    const tick = (): void => {
      const p = Math.min(1, Math.max(0, (Date.now() - sp.startedAt) / sp.durationMs))
      g.setAttribute('transform', `rotate(${(end * (1 - Math.pow(1 - p, 4))).toFixed(3)})`)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [sp?.id, shown?.id])

  const cols = sectors.map((_, i) => PAL[i % PAL.length])
  if (cols.length > 3 && cols[cols.length - 1] === cols[0]) cols[cols.length - 1] = PAL[2]
  let a0 = 0
  const winId = !sp && w.result ? w.result.id : null
  return (
    <div className="wh-view">
      <svg viewBox="-112 -116 224 228">
        <g ref={gRef}>
          {sectors.length === 0 && <circle r={100} fill="var(--coal-2)" />}
          {sectors.map((s, i) => {
            const span = s.frac * 360
            const start = a0
            a0 += span
            const [x0, y0] = pt(start, 100)
            const [x1, y1] = pt(start + span, 100)
            const mid = start + span / 2
            const size = Math.max(3.2, Math.min(7.5, span * 0.33))
            const max = Math.max(6, Math.floor(76 / (size * 0.58)))
            const name = s.name.length > max ? s.name.slice(0, max - 1) + '…' : s.name
            return (
              <g key={s.id} className={winId === s.id ? 'wh-win' : ''}>
                {span >= 359.99
                  ? <circle r={100} fill={cols[i]} />
                  : <path d={`M0 0 L${x0.toFixed(2)} ${y0.toFixed(2)} A100 100 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`} fill={cols[i]} stroke="rgba(0,0,0,.25)" strokeWidth={0.6} />}
                {span >= 6 && <text className="wh-lbl" transform={`rotate(${(mid - 90).toFixed(2)}) translate(92 0)`} textAnchor="end" dominantBaseline="middle" fontSize={size.toFixed(2)}>{name}</text>}
              </g>
            )
          })}
        </g>
        <circle r={100.5} fill="none" stroke="var(--line-2)" strokeWidth={2.2} />
        <circle r={9} fill="var(--coal)" stroke="var(--line-2)" strokeWidth={1.5} />
        <path d="M0 -96 L-7 -114 L7 -114 Z" fill="var(--ink)" stroke="rgba(0,0,0,.4)" strokeWidth={0.8} />
      </svg>
    </div>
  )
}

function sameSet(a: WheelSector[], b: WheelSector[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && Math.abs(x.frac - b[i].frac) < 1e-9)
}

function ItemsCard({ w, cfg, wrap }: { w: WheelState; cfg: AppSettings['wheel']; wrap: (p: Promise<unknown>, after?: () => void) => void }) {
  const [name, setName] = useState('')
  const [bulk, setBulk] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const busy = !!w.spin
  const save = (items: WheelItem[]): void => wrap(window.hub.wheelSetItems(items))
  const add = (): void => {
    const n = name.trim()
    if (!n) return
    wrap(window.hub.wheelSetItems([...w.items, { id: crypto.randomUUID(), name: n, weight: 1 }]), () => setName(''))
  }
  const addBulk = (): void => {
    const lines = (bulk ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return
    wrap(window.hub.wheelSetItems([...w.items, ...lines.map((n) => ({ id: crypto.randomUUID(), name: n.slice(0, 60), weight: 1 }))]), () => setBulk(null))
  }
  const elim = cfg.mode === 'elim'
  const alive = elim ? w.items.filter((i) => !w.out.includes(i.id)) : w.items
  const total = alive.reduce((a, i) => a + i.weight, 0) || 1

  return (
    <div className="card">
      <h3>
        Варианты <span className="chip">{elim && w.out.length ? `${alive.length} из ${w.items.length}` : w.items.length}</span>
        <button className="btn sm r" disabled={busy} onClick={() => wrap(window.hub.wheelLoadLots())} title="Лоты со ставками; вес = сумма">Взять лоты аукциона</button>
      </h3>
      {w.fromAuction && <p className="small muted" style={{ margin: '-6px 0 10px' }}>Взято из аукциона. Победитель колеса станет победителем аукциона.</p>}
      <div className="auc-add">
        <input className="input" value={name} maxLength={60} placeholder="Вариант: игра, челлендж, ник…" disabled={busy} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <button className="btn" disabled={busy || !name.trim()} onClick={add}>Добавить</button>
        <button className="btn" disabled={busy} onClick={() => setBulk(bulk === null ? '' : null)} title="Вставить много вариантов, по одному на строку">Списком</button>
      </div>
      {bulk !== null && (
        <div className="wh-bulk">
          <textarea className="input" rows={5} value={bulk} placeholder={'По одному варианту на строку'} onChange={(e) => setBulk(e.target.value)} />
          <div className="btnrow"><button className="btn sm primary" disabled={!bulk.trim()} onClick={addBulk}>Добавить все</button><button className="btn sm" onClick={() => setBulk(null)}>Отмена</button></div>
        </div>
      )}
      <div className="list">
        {w.items.map((it) => {
          const isOut = elim && w.out.includes(it.id)
          return <ItemRow key={it.id} it={it} out={isOut} pct={isOut ? 0 : Math.round((it.weight / total) * 1000) / 10} showPct={cfg.weighting === 'weight'} busy={busy} fromAuction={!!it.lotId}
            onSave={(x) => save(w.items.map((y) => (y.id === x.id ? x : y)))} onRemove={() => save(w.items.filter((y) => y.id !== it.id))} />
        })}
      </div>
      {!w.items.length && <p className="small muted" style={{ margin: '12px 0 0' }}>Пусто. Добавьте варианты или возьмите лоты аукциона.</p>}
      {w.items.length > 0 && (
        <div className="btnrow" style={{ marginTop: 12 }}>
          {confirmClear
            ? <><button className="btn sm" style={{ borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.wheelSetItems([]), () => setConfirmClear(false))}>Точно очистить?</button><button className="btn sm" onClick={() => setConfirmClear(false)}>Отмена</button></>
            : <button className="btn sm" disabled={busy} onClick={() => setConfirmClear(true)}>Очистить список</button>}
        </div>
      )}
    </div>
  )
}

function ItemRow({ it, out, pct, showPct, busy, fromAuction, onSave, onRemove }: {
  it: WheelItem; out: boolean; pct: number; showPct: boolean; busy: boolean; fromAuction: boolean; onSave: (x: WheelItem) => void; onRemove: () => void
}) {
  const [name, setName] = useState(it.name)
  const [weight, setWeight] = useState(String(it.weight))
  useEffect(() => { setName(it.name); setWeight(String(it.weight)) }, [it.name, it.weight])
  const commit = (): void => {
    const n = name.trim()
    const wv = Number(weight)
    if (!n) { setName(it.name); return }
    if (n !== it.name || (wv > 0 && wv !== it.weight)) onSave({ ...it, name: n, weight: wv > 0 ? wv : it.weight })
    else setWeight(String(it.weight))
  }
  return (
    <div className={`wh-item ${out ? 'out' : ''}`}>
      <input className="input wh-name" value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      <input className="input mono wh-weight" type="number" min={0.01} step="any" value={weight} disabled={busy} title={fromAuction ? 'Сумма лота, ₽' : 'Вес: чем больше, тем больше шанс'}
        onChange={(e) => setWeight(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      <span className="wh-pct">{out ? 'выбыл' : showPct ? `${pct.toLocaleString('ru-RU')}%` : ''}</span>
      <button className="btn sm" disabled={busy} title="Убрать" onClick={onRemove}>×</button>
    </div>
  )
}

function HistoryCard({ w, wrap }: { w: WheelState; wrap: (p: Promise<unknown>) => void }) {
  if (!w.history.length) return null
  return (
    <div className="card">
      <h3>История <button className="btn sm r" onClick={() => wrap(window.hub.wheelClearHistory())}>Очистить</button></h3>
      <div className="list wh-history">
        {w.history.map((h, i) => (
          <div key={i} className="row">
            <span className={`wh-tag ${h.kind}`}>{h.kind === 'win' ? 'победил' : 'выбыл'}</span>
            <b className="grow ellipsis">{h.name}</b>
            <span className="small muted">{fmtTime(h.ts)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
