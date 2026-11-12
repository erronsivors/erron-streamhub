import { EventEmitter } from 'node:events'
import { randomInt, randomUUID } from 'node:crypto'
import type { Store } from './db'
import type { Settings } from './settings'

/**
 * Колесо: свой список вариантов (с весом) или лоты аукциона (вес = сумма).
 * Режимы: обычный — выпавший побеждает; на выбывание — выпавший вылетает, крутим, пока не останется один.
 * На выбывании сектор обратно пропорционален весу: крупные лоты держатся дольше.
 * Результат выбирается в ядре ДО анимации (crypto), колесо в интерфейсе и в OBS просто докручивается до него.
 */

export interface WheelItem {
  id: string
  name: string
  /** Вес (сумма лота или свой). Больше 0. */
  weight: number
  /** Лот аукциона, из которого взят вариант. */
  lotId?: string
}

export interface WheelSector {
  id: string
  name: string
  /** Доля круга, сумма всех = 1. */
  frac: number
}

export interface WheelSpin {
  id: string
  mode: 'normal' | 'elim'
  sectors: WheelSector[]
  targetId: string
  /** Где внутри сектора остановится стрелка (0..1). */
  offset: number
  /** Полных оборотов до остановки. */
  turns: number
  startedAt: number
  durationMs: number
}

export interface WheelResult {
  kind: 'win' | 'out'
  id: string
  name: string
  ts: number
}

export interface WheelState {
  items: WheelItem[]
  /** Выбывшие в текущем круге «на выбывание». */
  out: string[]
  /** Варианты взяты из аукциона. */
  fromAuction: boolean
  spin: WheelSpin | null
  /** Чем закончилась последняя прокрутка. */
  result: WheelResult | null
  /** Победитель (обычный режим — сразу, на выбывание — последний оставшийся). */
  winner: { name: string; ts: number } | null
  history: { ts: number; name: string; kind: 'win' | 'out' }[]
}

export interface WheelOverlayView {
  spin: WheelSpin | null
  result: WheelResult | null
  winner: { name: string; ts: number } | null
  /** Осталось вариантов (на выбывание). */
  left: number
  now: number
}

const ITEM_LIMIT = 100
const HISTORY_LIMIT = 30

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const w = (v: unknown, d = 1): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(100_000_000, Math.round(n * 100) / 100) : d
}

function sanitizeItem(v: unknown): WheelItem | null {
  const o = obj(v)
  const name = s(o.name, 60)
  if (!name) return null
  const id = typeof o.id === 'string' && /^[\w:-]{1,60}$/.test(o.id) ? o.id : randomUUID()
  const lotId = typeof o.lotId === 'string' && /^[\w-]{1,40}$/.test(o.lotId) ? o.lotId : undefined
  return { id, name, weight: w(o.weight), ...(lotId ? { lotId } : {}) }
}

/** Взвешенный случайный выбор (криптографический). */
function pick<T>(list: T[], weight: (x: T) => number): T {
  const total = list.reduce((a, x) => a + weight(x), 0)
  let r = (randomInt(0, 1_000_000_000) / 1_000_000_000) * total
  for (const x of list) {
    r -= weight(x)
    if (r < 0) return x
  }
  return list[list.length - 1]
}

/** События: 'change' (WheelState), 'winner' (WheelItem) — победитель определён (после анимации). */
export class Wheel extends EventEmitter {
  private items: WheelItem[]
  private out: string[] = []
  private fromAuction = false
  private spinNow: WheelSpin | null = null
  private result: WheelResult | null = null
  private winner: WheelState['winner'] = null
  private history: WheelState['history'] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private store: Store, private settings: Settings) {
    super()
    const raw = obj(store.get<unknown>('wheel.v1', null))
    this.items = (Array.isArray(raw.items) ? raw.items : []).slice(0, ITEM_LIMIT).map(sanitizeItem).filter((x): x is WheelItem => !!x)
    this.fromAuction = raw.fromAuction === true && this.items.some((x) => x.lotId)
    this.out = (Array.isArray(raw.out) ? raw.out : []).filter((x): x is string => typeof x === 'string' && this.items.some((i) => i.id === x))
    this.history = (Array.isArray(raw.history) ? raw.history : []).slice(0, HISTORY_LIMIT).map((x) => {
      const h = obj(x)
      return { ts: Number(h.ts) || 0, name: s(h.name, 60), kind: h.kind === 'out' ? ('out' as const) : ('win' as const) }
    }).filter((h) => h.name)
  }

  state(): WheelState {
    return {
      items: this.items, out: this.out, fromAuction: this.fromAuction, spin: this.spinNow,
      result: this.result, winner: this.winner, history: this.history
    }
  }

  overlay(): WheelOverlayView {
    return { spin: this.spinNow, result: this.result, winner: this.winner, left: this.items.length - this.out.length, now: Date.now() }
  }

  private changed(): void {
    this.store.set('wheel.v1', { items: this.items, out: this.out, fromAuction: this.fromAuction, history: this.history })
    this.emit('change', this.state())
  }

  private busy(): void {
    if (this.spinNow) throw new Error('Колесо ещё крутится — дождитесь итога')
  }

  /** Заменить список вариантов (свой список из интерфейса). */
  setItems(list: unknown): void {
    this.busy()
    const items = (Array.isArray(list) ? list : []).slice(0, ITEM_LIMIT).map(sanitizeItem).filter((x): x is WheelItem => !!x)
    // Те же id — те же варианты; если пропали лоты — список больше не «из аукциона».
    this.items = items
    this.fromAuction = this.fromAuction && items.some((x) => x.lotId)
    this.out = this.out.filter((id) => items.some((i) => i.id === id))
    this.winner = null
    this.result = null
    this.changed()
  }

  /** Взять лоты аукциона (только со ставками): вес = сумма. */
  loadLots(lots: { id: string; num: number; name: string; rub: number }[]): number {
    this.busy()
    const items = lots.filter((l) => l.rub > 0).slice(0, ITEM_LIMIT).map((l) => ({ id: 'lot:' + l.id, name: `#${l.num} ${l.name}`.slice(0, 60), weight: w(l.rub), lotId: l.id }))
    if (!items.length) throw new Error('В аукционе нет лотов со ставками')
    this.items = items
    this.fromAuction = true
    this.out = []
    this.winner = null
    this.result = null
    this.changed()
    return items.length
  }

  /** Начать круг «на выбывание» заново (вернуть всех выбывших). */
  restart(): void {
    this.busy()
    this.out = []
    this.winner = null
    this.result = null
    this.changed()
  }

  clearHistory(): void {
    this.history = []
    this.changed()
  }

  /** Сектора для текущего режима: обычный — по весу, на выбывание — обратно весу; «поровну» — одинаковые. */
  sectors(mode: 'normal' | 'elim', equal: boolean): WheelSector[] {
    const alive = mode === 'elim' ? this.items.filter((i) => !this.out.includes(i.id)) : this.items
    const raw = alive.map((i) => (equal ? 1 : mode === 'elim' ? 1 / i.weight : i.weight))
    const total = raw.reduce((a, x) => a + x, 0) || 1
    return alive.map((i, k) => ({ id: i.id, name: i.name, frac: raw[k] / total }))
  }

  spin(): WheelSpin {
    this.busy()
    const cfg = this.settings.get().wheel
    const mode = cfg.mode
    const alive = mode === 'elim' ? this.items.filter((i) => !this.out.includes(i.id)) : this.items
    if (alive.length < 2) throw new Error(alive.length ? 'Остался один вариант — он и победил. «Начать заново», чтобы вернуть всех.' : 'Добавьте хотя бы два варианта')
    const sectors = this.sectors(mode, cfg.weighting === 'equal')
    const target = pick(sectors, (x) => x.frac)
    const durationMs = cfg.durationSec * 1000
    this.spinNow = {
      id: randomUUID(), mode, sectors, targetId: target.id,
      offset: 0.15 + randomInt(0, 700) / 1000,
      turns: 4 + Math.round(cfg.durationSec / 2),
      startedAt: Date.now() + 150, durationMs
    }
    if (mode === 'normal' || this.out.length === 0) this.winner = null
    this.result = null
    this.timer = setTimeout(() => this.finish(), durationMs + 150)
    this.emit('change', this.state())
    return this.spinNow
  }

  /** Итог вращения. quiet — без событий 'winner' (приложение закрывается: итог сохраняем, действия не запускаем). */
  private finish(quiet = false): void {
    const sp = this.spinNow
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!sp) return
    this.spinNow = null
    const item = this.items.find((i) => i.id === sp.targetId)
    const name = item?.name ?? sp.sectors.find((x) => x.id === sp.targetId)?.name ?? '—'
    const ts = Date.now()
    if (sp.mode === 'normal') {
      this.result = { kind: 'win', id: sp.targetId, name, ts }
      this.winner = { name, ts }
      this.history.unshift({ ts, name, kind: 'win' })
      if (item && !quiet) this.emit('winner', item)
    } else {
      this.out.push(sp.targetId)
      this.result = { kind: 'out', id: sp.targetId, name, ts }
      this.history.unshift({ ts, name, kind: 'out' })
      const alive = this.items.filter((i) => !this.out.includes(i.id))
      if (alive.length === 1) {
        this.winner = { name: alive[0].name, ts }
        this.history.unshift({ ts, name: alive[0].name, kind: 'win' })
        if (!quiet) this.emit('winner', alive[0])
      }
    }
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT
    this.changed()
  }

  stop(): void {
    // Закрытие посреди вращения: исход уже выбран — записываем его в историю, а не теряем.
    if (this.spinNow) this.finish(true)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
