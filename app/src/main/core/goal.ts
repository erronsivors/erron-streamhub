import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Hub } from './hub'
import type { Store } from './db'
import type { HubEvent, Platform } from './types'

/**
 * Сбор средств: одна цель (название, сумма) с промежуточными этапами.
 * Засчитываются донаты в рублях со всех сервисов и ручные донаты (из ленты), с момента запуска цели.
 * Тестовые события не идут, повтор того же доната (переподключение сервиса) — тоже.
 * Этап или цель достигнуты — событие 'reached' (праздник в оверлее и повод для правил); сбор продолжается сверх 100%.
 */

export interface GoalStage {
  id: string
  /** Сколько нужно собрать (всего, вместе с «уже было»). */
  rub: number
  name: string
}

export interface GoalGift {
  id: string
  ts: number
  user: string
  platform: Platform
  rub: number
  text: string
  /** donation — донат с сервиса, manual — ручной донат из ленты, hand — «Добавить сумму» в разделе «Сбор». */
  source: 'donation' | 'manual' | 'hand'
  eventId?: string
  /** Отменён вручную — не считается. */
  undone?: boolean
}

export interface Goal {
  id: string
  title: string
  target: number
  /** Собрано до старта (в другом месте, прошлые эфиры). */
  startRub: number
  stages: GoalStage[]
  startedAt: number
  /** Срок: когда сбор закроется сам. null — без срока. */
  endsAt: number | null
  /** Принимаются ли донаты (пауза / срок вышел). */
  accepting: boolean
  timeUp: boolean
  gifts: GoalGift[]
  /** Что уже отпраздновали (id этапов и 'goal') — второй раз не празднуем. */
  fired: string[]
}

export interface GoalArchiveItem {
  title: string
  target: number
  collected: number
  gifts: number
  startedAt: number
  endedAt: number
}

export interface GoalCelebrate {
  kind: 'stage' | 'goal'
  name: string
  rub: number
  ts: number
}

export interface GoalState {
  goal: Goal | null
  collected: number
  /** Процент от цели (может быть больше 100). */
  pct: number
  top: { user: string; rub: number }[]
  last: { user: string; rub: number; ts: number } | null
  /** Ближайший недостигнутый этап. */
  next: GoalStage | null
  celebrate: GoalCelebrate | null
  archive: GoalArchiveItem[]
}

export interface GoalOverlayView {
  title: string
  target: number
  collected: number
  stages: { name: string; rub: number; reached: boolean }[]
  last: { user: string; rub: number } | null
  top: { user: string; rub: number }[]
  endsAt: number | null
  accepting: boolean
  timeUp: boolean
  celebrate: GoalCelebrate | null
  now: number
}

export interface GoalReached {
  kind: 'stage' | 'goal'
  /** Название этапа или цели. */
  name: string
  /** Сумма этапа или цели. */
  rub: number
  title: string
  collected: number
  target: number
}

const GIFT_LIMIT = 2000
const STAGE_LIMIT = 20
const ARCHIVE_LIMIT = 10
const MAX = 1_000_000_000
/** Сколько секунд показывать праздник в оверлее. */
const CELEBRATE_MS = 9000
/** Донат с меткой времени чуть раньше запуска цели (разница часов сервиса) всё равно засчитываем. */
const GRACE_MS = 5000

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const r2 = (n: number): number => Math.round(n * 100) / 100
const money = (v: unknown, min = 0): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.min(MAX, Math.max(min, r2(n))) : min
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const okId = (v: unknown, re = /^[\w:-]{1,80}$/): string | undefined => (typeof v === 'string' && re.test(v) ? v : undefined)
const PLATFORMS: Platform[] = ['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'donationalerts', 'donatepay', 'donatex', 'boosty', 'obs', 'hub']

function sanitizeStages(v: unknown): GoalStage[] {
  const list = (Array.isArray(v) ? v : []).map((x) => {
    const o = obj(x)
    const rub = money(o.rub)
    const name = s(o.name, 80)
    if (rub <= 0 || !name) return null
    return { id: okId(o.id, /^[\w-]{1,40}$/) ?? randomUUID(), rub, name }
  }).filter((x): x is GoalStage => !!x)
  return list.sort((a, b) => a.rub - b.rub).slice(0, STAGE_LIMIT)
}

function sanitizeGift(v: unknown): GoalGift | null {
  const o = obj(v)
  const rub = money(o.rub)
  if (rub <= 0) return null
  const src = o.source === 'manual' || o.source === 'hand' ? o.source : 'donation'
  const platform = (PLATFORMS as unknown[]).includes(o.platform) ? (o.platform as Platform) : 'hub'
  const eventId = okId(o.eventId, /^[\w:.\-]{1,120}$/)
  return {
    id: okId(o.id, /^[\w-]{1,40}$/) ?? randomUUID(), ts: num(o.ts), user: s(o.user, 60) || 'Аноним', platform, rub, text: s(o.text, 300), source: src,
    ...(eventId ? { eventId } : {}), ...(o.undone === true ? { undone: true } : {})
  }
}

function sanitizeGoal(v: unknown): Goal | null {
  const o = obj(v)
  const title = s(o.title, 80)
  const target = money(o.target)
  if (!title || target <= 0) return null
  const endsAt = num(o.endsAt) > 0 ? num(o.endsAt) : null
  return {
    id: okId(o.id, /^[\w-]{1,40}$/) ?? randomUUID(), title, target, startRub: money(o.startRub), stages: sanitizeStages(o.stages),
    startedAt: num(o.startedAt) || Date.now(), endsAt, accepting: o.accepting !== false, timeUp: o.timeUp === true,
    gifts: (Array.isArray(o.gifts) ? o.gifts : []).slice(0, GIFT_LIMIT).map(sanitizeGift).filter((x): x is GoalGift => !!x),
    fired: (Array.isArray(o.fired) ? o.fired : []).filter((x): x is string => typeof x === 'string' && x.length <= 40).slice(0, STAGE_LIMIT + 1)
  }
}

function sanitizeArchive(v: unknown): GoalArchiveItem[] {
  return (Array.isArray(v) ? v : []).slice(0, ARCHIVE_LIMIT).map((x) => {
    const o = obj(x)
    return { title: s(o.title, 80), target: money(o.target), collected: money(o.collected), gifts: Math.max(0, Math.round(num(o.gifts))), startedAt: num(o.startedAt), endedAt: num(o.endedAt) }
  }).filter((x) => x.title)
}

/** Данные цели из формы: название, сумма, «уже собрано», этапы, срок в минутах (0 — без срока). */
export interface GoalInput {
  title: string
  target: number
  startRub?: number
  stages?: { id?: string; rub: number; name: string }[]
  durationMin?: number
}

/** События: 'change' (GoalState), 'reached' (GoalReached). */
export class Fundraiser extends EventEmitter {
  private goal: Goal | null
  private archive: GoalArchiveItem[]
  private celebrate: GoalCelebrate | null = null
  private timer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private store: Store, hub: Hub) {
    super()
    const raw = obj(store.get<unknown>('goal.v1', null))
    this.goal = sanitizeGoal(raw.goal)
    this.archive = sanitizeArchive(raw.archive)
    hub.on('event', (e: HubEvent) => this.onEvent(e))
    this.syncTimer()
  }

  // ---------- Состояние ----------

  private counted(): GoalGift[] {
    return this.goal ? this.goal.gifts.filter((g) => !g.undone) : []
  }

  collected(): number {
    if (!this.goal) return 0
    return r2(this.goal.startRub + this.counted().reduce((a, g) => a + g.rub, 0))
  }

  private top(n: number): { user: string; rub: number }[] {
    const m = new Map<string, { user: string; rub: number }>()
    for (const g of this.counted()) {
      if (g.source === 'hand') continue
      const k = g.user.toLowerCase()
      const x = m.get(k) ?? { user: g.user, rub: 0 }
      x.rub = r2(x.rub + g.rub)
      m.set(k, x)
    }
    return [...m.values()].sort((a, b) => b.rub - a.rub).slice(0, n)
  }

  private lastGift(): GoalGift | null {
    return this.counted().find((g) => g.source !== 'hand') ?? null
  }

  private liveCelebrate(): GoalCelebrate | null {
    return this.celebrate && Date.now() - this.celebrate.ts < CELEBRATE_MS ? this.celebrate : null
  }

  state(): GoalState {
    const collected = this.collected()
    const g = this.goal
    const last = this.lastGift()
    return {
      goal: g ? { ...g, gifts: g.gifts.slice(0, 300) } : null,
      collected,
      pct: g ? Math.round((collected / g.target) * 1000) / 10 : 0,
      top: this.top(10),
      last: last ? { user: last.user, rub: last.rub, ts: last.ts } : null,
      next: g ? g.stages.find((x) => x.rub > collected) ?? null : null,
      celebrate: this.liveCelebrate(),
      archive: this.archive
    }
  }

  overlay(): GoalOverlayView | null {
    const g = this.goal
    if (!g) return null
    const collected = this.collected()
    const last = this.lastGift()
    return {
      title: g.title, target: g.target, collected,
      stages: g.stages.map((x) => ({ name: x.name, rub: x.rub, reached: collected >= x.rub })),
      last: last ? { user: last.user, rub: last.rub } : null,
      top: this.top(5), endsAt: g.endsAt, accepting: g.accepting, timeUp: g.timeUp,
      celebrate: this.liveCelebrate(), now: Date.now()
    }
  }

  private changed(): void {
    // На диск — не чаще раза в полсекунды: донаты могут идти пачкой.
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save() }, 500)
    this.emit('change', this.state())
  }

  private save(): void {
    this.store.set('goal.v1', { goal: this.goal, archive: this.archive })
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.save()
  }

  private need(): Goal {
    if (!this.goal) throw new Error('Цель ещё не создана')
    return this.goal
  }

  // ---------- Срок ----------

  private syncTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const g = this.goal
    if (!g || !g.endsAt || g.timeUp) return
    const ms = g.endsAt - Date.now()
    if (ms <= 0) { this.expire(); return }
    // setTimeout не любит больше ~24 дней — проверяем не реже раза в сутки.
    this.timer = setTimeout(() => this.syncTimer(), Math.min(ms, 86_400_000))
  }

  private expire(): void {
    const g = this.goal
    if (!g) return
    g.timeUp = true
    g.accepting = false
    this.changed()
  }

  /** Срок: через сколько минут закрыть сбор (0 — убрать срок). */
  setDuration(min: unknown): void {
    const g = this.need()
    const m = Math.max(0, Math.min(60 * 24 * 60, Math.round(num(typeof min === 'string' ? Number(min) : min))))
    g.endsAt = m > 0 ? Date.now() + m * 60_000 : null
    if (g.timeUp) { g.timeUp = false; g.accepting = true }
    this.syncTimer()
    this.changed()
  }

  /** Продлить срок на N минут (отрицательное — сократить). Без срока — ставит срок от текущего момента. */
  extend(min: unknown): void {
    const g = this.need()
    const m = Math.round(num(min))
    if (!m) return
    const base = g.endsAt && !g.timeUp ? g.endsAt : Date.now()
    g.endsAt = Math.max(Date.now() + 1000, base + m * 60_000)
    if (g.timeUp) { g.timeUp = false; g.accepting = true }
    this.syncTimer()
    this.changed()
  }

  setAccepting(on: boolean): void {
    const g = this.need()
    if (on && g.timeUp) { g.timeUp = false; g.endsAt = null; this.syncTimer() }
    g.accepting = on
    this.changed()
  }

  // ---------- Цель ----------

  private parse(v: unknown): { title: string; target: number; startRub: number; stages: GoalStage[]; durationMin: number } {
    const o = obj(v)
    const title = s(o.title, 80)
    const target = money(o.target)
    if (!title) throw new Error('Напишите, на что собираем')
    if (target <= 0) throw new Error('Укажите сумму цели больше нуля')
    const stages = sanitizeStages(o.stages).filter((x) => x.rub < target)
    return { title, target, startRub: money(o.startRub), stages, durationMin: Math.max(0, Math.min(60 * 24 * 60, Math.round(num(o.durationMin)))) }
  }

  /** Новая цель. Текущая (если была) уходит в архив. */
  start(v: unknown): Goal {
    const p = this.parse(v)
    this.toArchive()
    const now = Date.now()
    this.goal = {
      id: randomUUID(), title: p.title, target: p.target, startRub: p.startRub, stages: p.stages,
      startedAt: now, endsAt: p.durationMin > 0 ? now + p.durationMin * 60_000 : null,
      accepting: true, timeUp: false, gifts: [], fired: []
    }
    this.celebrate = null
    // Уже собранное до старта могло перекрыть этапы — их не празднуем.
    this.markReached(false)
    this.syncTimer()
    this.changed()
    return this.goal
  }

  /** Поправить цель на ходу: название, сумму, «уже собрано», этапы. Донаты сохраняются. */
  edit(v: unknown): void {
    const g = this.need()
    const p = this.parse(v)
    g.title = p.title
    g.target = p.target
    g.startRub = p.startRub
    g.stages = p.stages
    // Отпразднованное, которого больше нет, забываем; уже достигнутое после правки — не празднуем задним числом.
    g.fired = g.fired.filter((id) => id === 'goal' || g.stages.some((x) => x.id === id))
    this.markReached(false)
    this.changed()
  }

  private toArchive(): void {
    const g = this.goal
    if (!g) return
    if (g.gifts.length || g.startRub > 0) {
      this.archive.unshift({ title: g.title, target: g.target, collected: this.collected(), gifts: this.counted().length, startedAt: g.startedAt, endedAt: Date.now() })
      if (this.archive.length > ARCHIVE_LIMIT) this.archive.length = ARCHIVE_LIMIT
    }
  }

  /** Завершить сбор: в архив, цели больше нет. */
  finish(): void {
    this.need()
    this.toArchive()
    this.goal = null
    this.celebrate = null
    this.syncTimer()
    this.changed()
  }

  clearArchive(): void {
    this.archive = []
    this.changed()
  }

  // ---------- Донаты ----------

  private onEvent(e: HubEvent): void {
    const g = this.goal
    if (!g || e.test || !g.accepting || e.type !== 'donation') return
    const rub = money(e.amountRub)
    if (rub <= 0) return
    if (e.ts && e.ts < g.startedAt - GRACE_MS) return
    if (g.gifts.some((x) => x.eventId === e.id)) return
    this.add({ id: randomUUID(), ts: e.ts || Date.now(), user: s(e.user, 60) || 'Аноним', platform: e.platform, rub, text: s(e.text, 300), source: e.manual ? 'manual' : 'donation', eventId: e.id })
  }

  /** «Добавить сумму» из раздела: деньги, собранные мимо Crossember. В ленту и статистику не идёт. */
  addHand(rubV: unknown, note?: unknown): GoalGift {
    this.need()
    const rub = money(rubV)
    if (rub <= 0) throw new Error('Сумма должна быть больше нуля')
    const gift: GoalGift = { id: randomUUID(), ts: Date.now(), user: 'Вручную', platform: 'hub', rub, text: s(note, 300), source: 'hand' }
    this.add(gift)
    return gift
  }

  private add(gift: GoalGift): void {
    const g = this.need()
    g.gifts.unshift(gift)
    if (g.gifts.length > GIFT_LIMIT) g.gifts.length = GIFT_LIMIT
    this.markReached(true)
    this.changed()
  }

  /** Отменить (или вернуть) поступление. */
  toggleGift(id: string): void {
    const g = this.need()
    const gift = g.gifts.find((x) => x.id === id)
    if (!gift) throw new Error('Поступление не найдено')
    if (gift.undone) delete gift.undone
    else gift.undone = true
    // После отмены этап может снова стать «не достигнут» — отпразднуем, когда дойдём снова.
    const c = this.collected()
    g.fired = g.fired.filter((fid) => (fid === 'goal' ? c >= g.target : (g.stages.find((x) => x.id === fid)?.rub ?? Infinity) <= c))
    this.markReached(true)
    this.changed()
  }

  /** Отметить достигнутое; celebrate — праздновать (донат) или молча (старт, правка). */
  private markReached(celebrate: boolean): void {
    const g = this.goal
    if (!g) return
    const c = this.collected()
    const hits: GoalReached[] = []
    for (const st of g.stages) {
      if (c >= st.rub && !g.fired.includes(st.id)) {
        g.fired.push(st.id)
        hits.push({ kind: 'stage', name: st.name, rub: st.rub, title: g.title, collected: c, target: g.target })
      }
    }
    if (c >= g.target && !g.fired.includes('goal')) {
      g.fired.push('goal')
      hits.push({ kind: 'goal', name: g.title, rub: g.target, title: g.title, collected: c, target: g.target })
    }
    if (!celebrate || !hits.length) return
    // В оверлее — самое важное (цель важнее этапа, старший этап важнее младшего).
    const top = hits[hits.length - 1]
    this.celebrate = { kind: top.kind, name: top.name, rub: top.rub, ts: Date.now() }
    for (const h of hits) this.emit('reached', h)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.flush()
  }
}
