import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Store } from './db'
import type { Hub } from './hub'
import type { Settings } from './settings'
import type { HubEvent, Platform } from './types'

/**
 * Аукцион: зрители донатят (или тратят баллы Twitch на выбранную награду) с названием лота в сообщении.
 * Лот ищется по номеру (#3) или по названию. Не нашёлся — ставка ждёт решения стримера в очереди;
 * от заданной суммы лот создаётся сам (с пометкой «создан сам», его можно отклонить — ставки вернутся в очередь).
 * Сумма лота всегда считается из его ставок, поэтому отмена, перенос и объединение не теряют деньги.
 * Таймер: старт, пауза, ±время, продление при ставке под конец. Время вышло — приём ставок останавливается,
 * победителя объявляет стример (лидер по сумме; колесо — следующим этапом).
 */

export type BetSource = 'donation' | 'points' | 'manual'
export type BetStatus = 'lot' | 'pending' | 'rejected'

export interface AuctionLot {
  id: string
  /** Номер для ставок «#3». Не меняется, новые получают следующий. */
  num: number
  name: string
  /** Создан сам из сообщения зрителя — можно отклонить. */
  auto: boolean
  createdAt: number
  /** Итог ставок этого лота, вытесненных из списка (он хранит последние BET_LIMIT): сумма лота не уменьшается. */
  carry?: { rub: number; bets: number }
}

export interface AuctionBet {
  id: string
  ts: number
  user: string
  platform: Platform
  source: BetSource
  /** Сколько засчитано в рублях. */
  rub: number
  /** Как пришло: «500 ₽», «2 000 баллов». */
  raw: string
  text: string
  lotId: string | null
  status: BetStatus
  /** id события хаба: тот же донат, пришедший повторно (переподключение сервиса), второй раз не засчитывается. */
  eventId?: string
}

export interface AuctionTimer {
  /** Идёт: когда закончится (мс). */
  endsAt: number | null
  /** На паузе: сколько осталось (мс). Оба null — таймер не задан. */
  pausedLeft: number | null
}

export interface AuctionResult {
  ts: number
  winner: { name: string; rub: number } | null
  total: number
  bets: number
  lots: { name: string; rub: number }[]
}

export interface LotView extends AuctionLot {
  rub: number
  bets: number
}

export interface AuctionState {
  /** Приём ставок идёт. */
  accepting: boolean
  /** Время вышло (приём остановлен таймером). */
  timeUp: boolean
  timer: AuctionTimer
  /** Лоты с суммами, по убыванию суммы. */
  lots: LotView[]
  /** Ставки, новые сверху (не больше BET_LIMIT). */
  bets: AuctionBet[]
  total: number
  winner: { lotId: string; name: string; rub: number; ts: number } | null
  archive: AuctionResult[]
}

/** Что видит оверлей: без истории ставок и ников. */
export interface AuctionOverlayView {
  accepting: boolean
  timeUp: boolean
  timer: AuctionTimer
  now: number
  total: number
  lots: { id: string; num: number; name: string; rub: number }[]
  winner: { name: string; rub: number } | null
}

const LOT_LIMIT = 200
const BET_LIMIT = 3000
const ARCHIVE_LIMIT = 10
const MAX_RUB = 100_000_000
const MAX_TIMER = 24 * 3600_000

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const rub = (n: number): number => Math.round(Math.min(MAX_RUB, Math.max(0, n)) * 100) / 100
const fmt = (n: number): string => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })

/** Для сравнения названий: регистр, «ё», знаки препинания и лишние пробелы не важны. */
export function norm(t: string): string {
  return t.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}#№ ]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

/** Слова, по которым лот не угадываем: они есть почти в любом сообщении. */
const STOP_WORDS = new Set(['хочу', 'давай', 'давайте', 'пожалуйста', 'плиз', 'please', 'игра', 'игру', 'игры', 'фильм', 'смотрим', 'смотреть', 'играть', 'играем', 'ставлю', 'ставка', 'всех', 'чтобы', 'этот', 'этого', 'тебе', 'тоже', 'game', 'play', 'with', 'this', 'that'])

/** Название лота из сообщения: без «#», ссылок и лишнего, до 60 символов. */
function lotNameFrom(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '').replace(/[#№]\s*\d+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

interface Saved {
  lots: AuctionLot[]
  bets: AuctionBet[]
  accepting: boolean
  timeUp: boolean
  timer: AuctionTimer
  winner: AuctionState['winner']
  archive: AuctionResult[]
  nextNum: number
}

const PLATFORMS = new Set(['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'donationalerts', 'donatepay', 'donatex', 'boosty', 'obs', 'hub'])

function load(v: unknown): Saved {
  const o = obj(v)
  const lots = (Array.isArray(o.lots) ? o.lots : []).slice(0, LOT_LIMIT).map((x): AuctionLot | null => {
    const l = obj(x)
    const name = s(l.name, 60)
    const id = s(l.id, 40)
    if (!name || !id) return null
    const c = obj(l.carry)
    const carry = { rub: rub(Math.max(0, Number(c.rub) || 0)), bets: Math.max(0, Math.round(Number(c.bets) || 0)) }
    return { id, num: Math.max(1, Math.round(Number(l.num) || 1)), name, auto: l.auto === true, createdAt: Number(l.createdAt) || Date.now(), ...(carry.rub > 0 || carry.bets > 0 ? { carry } : {}) }
  }).filter((l): l is AuctionLot => !!l)
  const ids = new Set(lots.map((l) => l.id))
  const bets = (Array.isArray(o.bets) ? o.bets : []).slice(0, BET_LIMIT).map((x): AuctionBet | null => {
    const b = obj(x)
    const id = s(b.id, 40)
    if (!id) return null
    const lotId = typeof b.lotId === 'string' && ids.has(b.lotId) ? b.lotId : null
    let status: BetStatus = b.status === 'rejected' ? 'rejected' : b.status === 'lot' && lotId ? 'lot' : 'pending'
    if (status === 'lot' && !lotId) status = 'pending'
    return {
      id, ts: Number(b.ts) || Date.now(), user: s(b.user, 64), platform: (PLATFORMS.has(b.platform as string) ? b.platform : 'hub') as Platform,
      source: b.source === 'points' ? 'points' : b.source === 'manual' ? 'manual' : 'donation',
      rub: rub(Number(b.rub) || 0), raw: s(b.raw, 40), text: s(b.text, 300), lotId: status === 'lot' ? lotId : null, status,
      ...(s(b.eventId, 100) ? { eventId: s(b.eventId, 100) } : {})
    }
  }).filter((b): b is AuctionBet => !!b)
  const t = obj(o.timer)
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  const w = obj(o.winner)
  return {
    lots, bets,
    accepting: o.accepting === true,
    timeUp: o.timeUp === true,
    timer: { endsAt: num(t.endsAt), pausedLeft: num(t.pausedLeft) },
    winner: s(w.name, 60) ? { lotId: s(w.lotId, 40), name: s(w.name, 60), rub: rub(Number(w.rub) || 0), ts: Number(w.ts) || Date.now() } : null,
    archive: (Array.isArray(o.archive) ? o.archive : []).slice(0, ARCHIVE_LIMIT).map((x) => {
      const r = obj(x)
      const win = obj(r.winner)
      return {
        ts: Number(r.ts) || 0,
        winner: s(win.name, 60) ? { name: s(win.name, 60), rub: rub(Number(win.rub) || 0) } : null,
        total: rub(Number(r.total) || 0),
        bets: Math.max(0, Math.round(Number(r.bets) || 0)),
        lots: (Array.isArray(r.lots) ? r.lots : []).slice(0, 10).map((y) => ({ name: s(obj(y).name, 60), rub: rub(Number(obj(y).rub) || 0) }))
      }
    }),
    nextNum: Math.max(Number(o.nextNum) || 1, ...lots.map((l) => l.num + 1), 1)
  }
}

/** События: 'change' (AuctionState). */
export class Auction extends EventEmitter {
  private d: Saved
  private tick: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private store: Store, private settings: Settings, hub: Hub) {
    super()
    this.d = load(store.get<unknown>('auction.v1', null))
    hub.on('event', (e: HubEvent) => this.onEvent(e))
    this.syncTick()
  }

  // ---------- Состояние ----------

  private sums(): Map<string, { rub: number; bets: number }> {
    const m = new Map<string, { rub: number; bets: number }>()
    for (const l of this.d.lots) if (l.carry) m.set(l.id, { ...l.carry })
    for (const b of this.d.bets) {
      if (b.status !== 'lot' || !b.lotId) continue
      const x = m.get(b.lotId) ?? { rub: 0, bets: 0 }
      x.rub += b.rub
      x.bets++
      m.set(b.lotId, x)
    }
    return m
  }

  private lotViews(): LotView[] {
    const m = this.sums()
    return this.d.lots
      .map((l) => ({ ...l, rub: rub(m.get(l.id)?.rub ?? 0), bets: m.get(l.id)?.bets ?? 0 }))
      .sort((a, b) => b.rub - a.rub || a.num - b.num)
  }

  state(): AuctionState {
    const lots = this.lotViews()
    return {
      accepting: this.d.accepting,
      timeUp: this.d.timeUp,
      timer: { ...this.d.timer },
      lots,
      bets: this.d.bets.slice(0, 300),
      total: rub(lots.reduce((a, l) => a + l.rub, 0)),
      winner: this.d.winner,
      archive: this.d.archive
    }
  }

  overlay(): AuctionOverlayView {
    const st = this.state()
    return {
      accepting: st.accepting, timeUp: st.timeUp, timer: st.timer, now: Date.now(), total: st.total,
      lots: st.lots.filter((l) => l.rub > 0 || st.lots.length <= 20).slice(0, 20).map((l) => ({ id: l.id, num: l.num, name: l.name, rub: l.rub })),
      winner: st.winner ? { name: st.winner.name, rub: st.winner.rub } : null
    }
  }

  private changed(): void {
    // Пишем на диск не чаще раза в полсекунды: ставки могут сыпаться пачкой.
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.store.set('auction.v1', this.d) }, 500)
    this.emit('change', this.state())
  }

  /** Сохранить сразу (при выходе из приложения). */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.store.set('auction.v1', this.d)
  }

  // ---------- Ставки зрителей ----------

  private onEvent(e: HubEvent): void {
    if (e.test || !this.d.accepting) return
    if (this.d.bets.some((b) => b.eventId === e.id)) return
    const cfg = this.settings.get().auction
    if (e.type === 'donation' && (e.amountRub ?? 0) > 0) {
      const amount = e.amountRub ?? 0
      const raw = e.currency && e.currency !== 'RUB' && e.amount ? `${fmt(e.amount)} ${e.currency}` : `${fmt(amount)} ₽`
      this.addBet({ user: e.user, platform: e.platform, source: e.manual ? 'manual' : 'donation', rub: amount, raw, text: e.text ?? '', eventId: e.id })
    } else if (e.type === 'reward' && e.platform === 'twitch' && cfg.pointsReward.trim() && cfg.pointsPerRub > 0) {
      const title = e.reward ?? ''
      if (norm(title) !== norm(cfg.pointsReward)) return
      const points = e.amount ?? 0
      if (points <= 0) return
      // Текст награды приходит как «Название — ввод зрителя»: лот берём из ввода.
      const text = e.text && title && e.text.startsWith(title) ? e.text.slice(title.length).replace(/^\s*—\s*/, '') : (e.text ?? '')
      this.addBet({ user: e.user, platform: e.platform, source: 'points', rub: points / cfg.pointsPerRub, raw: `${fmt(points)} баллов`, text, eventId: e.id })
    }
  }

  /** Найти лот по тексту: «#3»/«№3», точное название или название внутри сообщения (самое длинное). */
  findLot(text: string): AuctionLot | null {
    const n = norm(text)
    if (!n) return null
    const m = n.match(/[#№]\s*(\d{1,4})\b/)
    if (m) return this.d.lots.find((l) => l.num === Number(m[1])) ?? null
    const exact = this.d.lots.find((l) => norm(l.name) === n)
    if (exact) return exact
    let best: AuctionLot | null = null
    let bestLen = 0
    let tie = false
    for (const l of this.d.lots) {
      const ln = norm(l.name)
      if (ln.length < 3) continue
      if ((' ' + n + ' ').includes(' ' + ln + ' ')) {
        if (ln.length > bestLen) { best = l; bestLen = ln.length; tie = false } else if (ln.length === bestLen) tie = true
      }
    }
    if (best || tie) return tie ? null : best
    // По отдельному слову: «silksong» → «Hollow Knight: Silksong», «интерстеллара» → «Смотрим «Интерстеллар»».
    // Засчитываем, только если слово указывает ровно на один лот.
    const words = n.split(' ').filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
    if (!words.length) return null
    const close = (a: string, b: string): boolean => {
      if (a === b) return true
      let p = 0
      while (p < a.length && p < b.length && a[p] === b[p]) p++
      return p >= 5 && p >= Math.min(a.length, b.length) - 2
    }
    const hits = this.d.lots.filter((l) => norm(l.name).split(' ').some((lw) => lw.length >= 4 && !STOP_WORDS.has(lw) && words.some((w) => close(w, lw))))
    return hits.length === 1 ? hits[0] : null
  }

  private addBet(b: { user: string; platform: Platform; source: BetSource; rub: number; raw: string; text: string; eventId?: string }): AuctionBet {
    const cfg = this.settings.get().auction
    const amount = rub(b.rub)
    const text = s(b.text, 300)
    const bet: AuctionBet = { id: randomUUID(), ts: Date.now(), user: s(b.user, 64) || 'Зритель', platform: b.platform, source: b.source, rub: amount, raw: s(b.raw, 40), text, lotId: null, status: 'pending', ...(b.eventId ? { eventId: b.eventId } : {}) }
    const lot = this.findLot(text)
    if (lot) {
      bet.lotId = lot.id
      bet.status = 'lot'
    } else if (cfg.autoLotMin > 0 && amount >= cfg.autoLotMin && lotNameFrom(text) && this.d.lots.length < LOT_LIMIT) {
      const nl = this.makeLot(lotNameFrom(text), true)
      bet.lotId = nl.id
      bet.status = 'lot'
    }
    this.d.bets.unshift(bet)
    this.trimBets()
    this.extend()
    this.changed()
    return bet
  }

  /** Ручная ставка из интерфейса (для проверки или если зритель перевёл мимо сервисов). В статистику не идёт. */
  manualBet(v: unknown): AuctionBet {
    const o = obj(v)
    const amount = typeof o.rub === 'number' && Number.isFinite(o.rub) ? o.rub : 0
    if (!(amount > 0) || amount > MAX_RUB) throw new Error('Сумма должна быть больше нуля')
    const user = s(o.user, 64) || 'Вручную'
    return this.addBet({ user, platform: 'hub', source: 'manual', rub: amount, raw: `${fmt(rub(amount))} ₽`, text: s(o.text, 300) })
  }

  /** Продление: ставка пришла, когда осталось меньше порога, — добавить время. */
  private extend(): void {
    const cfg = this.settings.get().auction
    const t = this.d.timer
    if (!cfg.extend || !t.endsAt) return
    const left = t.endsAt - Date.now()
    if (left > 0 && left < cfg.extendBelowSec * 1000) t.endsAt += cfg.extendAddSec * 1000
  }

  // ---------- Лоты ----------

  private makeLot(name: string, auto: boolean): AuctionLot {
    const l: AuctionLot = { id: randomUUID(), num: this.d.nextNum++, name, auto, createdAt: Date.now() }
    this.d.lots.push(l)
    return l
  }

  private lot(id: unknown): AuctionLot {
    const l = this.d.lots.find((x) => x.id === id)
    if (!l) throw new Error('Лот не найден — возможно, его уже удалили')
    return l
  }

  private checkName(name: string, exceptId?: string): string {
    const n = s(name, 60)
    if (!n) throw new Error('Название лота пустое')
    if (this.d.lots.some((l) => l.id !== exceptId && norm(l.name) === norm(n))) throw new Error(`Лот «${n}» уже есть`)
    return n
  }

  addLot(name: unknown): AuctionLot {
    if (this.d.lots.length >= LOT_LIMIT) throw new Error(`Слишком много лотов (максимум ${LOT_LIMIT})`)
    const l = this.makeLot(this.checkName(String(name ?? '')), false)
    this.changed()
    return l
  }

  renameLot(id: unknown, name: unknown): void {
    const l = this.lot(id)
    l.name = this.checkName(String(name ?? ''), l.id)
    // Переименовал стример — значит, лот принят.
    l.auto = false
    this.changed()
  }

  /** Принять лот, созданный сам: снять пометку. */
  approveLot(id: unknown): void {
    this.lot(id).auto = false
    this.changed()
  }

  /** Список ставок хранит последние BET_LIMIT; вытесненные засчитанные сворачиваются в итог своего лота. */
  private trimBets(): void {
    for (const old of this.d.bets.splice(BET_LIMIT)) {
      if (old.status !== 'lot' || !old.lotId) continue
      const l = this.d.lots.find((x) => x.id === old.lotId)
      if (!l) continue
      const c = l.carry ?? { rub: 0, bets: 0 }
      l.carry = { rub: rub(c.rub + old.rub), bets: c.bets + 1 }
    }
  }

  /** Удалить или отклонить лот: его ставки возвращаются в очередь «Требует решения». */
  removeLot(id: unknown): void {
    const l = this.lot(id)
    for (const b of this.d.bets) if (b.lotId === l.id) { b.lotId = null; b.status = 'pending' }
    this.d.lots = this.d.lots.filter((x) => x.id !== l.id)
    if (this.d.winner?.lotId === l.id) this.d.winner = null
    this.changed()
  }

  /** Объединить: все ставки лота from переходят в into, from удаляется. */
  mergeLots(from: unknown, into: unknown): void {
    const a = this.lot(from)
    const b = this.lot(into)
    if (a.id === b.id) return
    for (const x of this.d.bets) if (x.lotId === a.id) x.lotId = b.id
    if (a.carry) b.carry = { rub: rub((b.carry?.rub ?? 0) + a.carry.rub), bets: (b.carry?.bets ?? 0) + a.carry.bets }
    this.d.lots = this.d.lots.filter((x) => x.id !== a.id)
    this.changed()
  }

  /** Прибавить сумму лоту вручную (отдельной ставкой «Стример» — её можно отменить). */
  addToLot(id: unknown, amount: unknown): void {
    const l = this.lot(id)
    const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
    if (!(n > 0) || n > MAX_RUB) throw new Error('Сумма должна быть больше нуля')
    this.d.bets.unshift({ id: randomUUID(), ts: Date.now(), user: 'Стример', platform: 'hub', source: 'manual', rub: rub(n), raw: `${fmt(rub(n))} ₽`, text: l.name, lotId: l.id, status: 'lot' })
    this.trimBets()
    this.changed()
  }

  // ---------- Ставки: решения стримера ----------

  private bet(id: unknown): AuctionBet {
    const b = this.d.bets.find((x) => x.id === id)
    if (!b) throw new Error('Ставка не найдена')
    return b
  }

  assignBet(betId: unknown, lotId: unknown): void {
    const b = this.bet(betId)
    const l = this.lot(lotId)
    b.lotId = l.id
    b.status = 'lot'
    this.changed()
  }

  /** Новый лот из текста ставки (или из своего названия) и сразу ставка в него. */
  betToNewLot(betId: unknown, name?: unknown): AuctionLot {
    const b = this.bet(betId)
    const raw = typeof name === 'string' && name.trim() ? name : lotNameFrom(b.text)
    const l = this.addLot(raw)
    b.lotId = l.id
    b.status = 'lot'
    this.changed()
    return l
  }

  rejectBet(betId: unknown): void {
    const b = this.bet(betId)
    b.lotId = null
    b.status = 'rejected'
    this.changed()
  }

  /** Вернуть отклонённую или засчитанную ставку в очередь. */
  reopenBet(betId: unknown): void {
    const b = this.bet(betId)
    b.lotId = null
    b.status = 'pending'
    this.changed()
  }

  // ---------- Таймер и ход аукциона ----------

  private left(): number {
    const t = this.d.timer
    return t.endsAt ? Math.max(0, t.endsAt - Date.now()) : t.pausedLeft ?? 0
  }

  private syncTick(): void {
    const need = !!this.d.timer.endsAt
    if (need && !this.tick) this.tick = setInterval(() => this.onTick(), 500)
    if (!need && this.tick) { clearInterval(this.tick); this.tick = null }
  }

  private onTick(): void {
    const t = this.d.timer
    if (!t.endsAt || t.endsAt > Date.now()) return
    // Время вышло: таймер на нуле, приём ставок остановлен. Победителя объявляет стример.
    t.endsAt = null
    t.pausedLeft = null
    this.d.accepting = false
    this.d.timeUp = true
    this.syncTick()
    this.changed()
  }

  /**
   * start — запустить (с паузы или заново на defaultMin минут), также открывает приём ставок;
   * pause — пауза; add/sub — ±sec секунд; set — поставить sec секунд (на паузе); clear — убрать таймер.
   */
  timer(op: unknown, sec?: unknown): void {
    const t = this.d.timer
    const now = Date.now()
    const n = typeof sec === 'number' && Number.isFinite(sec) ? Math.round(Math.abs(sec)) * 1000 : 60_000
    const cap = (ms: number): number => Math.min(MAX_TIMER, Math.max(0, ms))
    switch (op) {
      case 'start': {
        if (t.endsAt) return
        const left = t.pausedLeft ?? this.settings.get().auction.defaultMin * 60_000
        t.endsAt = now + cap(left)
        t.pausedLeft = null
        this.d.accepting = true
        this.d.timeUp = false
        this.d.winner = null
        break
      }
      case 'pause':
        if (!t.endsAt) return
        t.pausedLeft = Math.max(1000, t.endsAt - now)
        t.endsAt = null
        break
      case 'add':
        if (t.endsAt) t.endsAt = now + cap(t.endsAt - now + n)
        else t.pausedLeft = cap((t.pausedLeft ?? 0) + n)
        if (this.d.timeUp) this.d.timeUp = false
        break
      case 'sub':
        if (t.endsAt) t.endsAt = now + Math.max(1000, t.endsAt - now - n)
        else if (t.pausedLeft) t.pausedLeft = Math.max(1000, t.pausedLeft - n)
        break
      case 'set':
        t.endsAt = null
        t.pausedLeft = cap(n) || null
        this.d.timeUp = false
        break
      case 'clear':
        t.endsAt = null
        t.pausedLeft = null
        this.d.timeUp = false
        break
      default:
        return
    }
    this.syncTick()
    this.changed()
  }

  /** Открыть/закрыть приём ставок вручную (таймер не трогаем, кроме паузы при закрытии). */
  setAccepting(v: boolean): void {
    this.d.accepting = v
    if (v) { this.d.timeUp = false; this.d.winner = null }
    else if (this.d.timer.endsAt) this.timer('pause')
    this.changed()
  }

  /** Объявить победителя: лот с наибольшей суммой. Приём ставок и таймер останавливаются. */
  finish(): AuctionState['winner'] {
    const top = this.lotViews()[0]
    if (!top || top.rub <= 0) throw new Error('Нет лотов со ставками — побеждать некому')
    if (this.d.timer.endsAt) { this.d.timer.pausedLeft = null; this.d.timer.endsAt = null }
    this.d.accepting = false
    this.d.winner = { lotId: top.id, name: top.name, rub: top.rub, ts: Date.now() }
    this.syncTick()
    this.changed()
    return this.d.winner
  }

  /** Победитель выбран колесом: этот лот. Приём ставок и таймер останавливаются. */
  setWinner(lotId: string): void {
    const l = this.lotViews().find((x) => x.id === lotId)
    if (!l) return
    this.d.timer.endsAt = null
    this.d.timer.pausedLeft = null
    this.d.accepting = false
    this.d.winner = { lotId: l.id, name: l.name, rub: l.rub, ts: Date.now() }
    this.syncTick()
    this.changed()
  }

  /** Новый аукцион: итог текущего — в архив (если были ставки), всё остальное очищается. */
  reset(keepLots: boolean): void {
    const lots = this.lotViews()
    const total = rub(lots.reduce((a, l) => a + l.rub, 0))
    const counted = this.d.bets.filter((b) => b.status === 'lot').length + this.d.lots.reduce((a, l) => a + (l.carry?.bets ?? 0), 0)
    if (counted > 0) {
      this.d.archive.unshift({
        ts: Date.now(),
        winner: this.d.winner ? { name: this.d.winner.name, rub: this.d.winner.rub } : null,
        total, bets: counted,
        lots: lots.filter((l) => l.rub > 0).slice(0, 10).map((l) => ({ name: l.name, rub: l.rub }))
      })
      if (this.d.archive.length > ARCHIVE_LIMIT) this.d.archive.length = ARCHIVE_LIMIT
    }
    this.d.bets = []
    if (keepLots) {
      this.d.lots = this.d.lots.filter((l) => !l.auto).map(({ carry: _carry, ...l }) => l)
    } else {
      this.d.lots = []
      this.d.nextNum = 1
    }
    this.d.accepting = false
    this.d.timeUp = false
    this.d.winner = null
    this.d.timer = { endsAt: null, pausedLeft: null }
    this.syncTick()
    this.changed()
  }

  clearArchive(): void {
    this.d.archive = []
    this.changed()
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    this.flush()
  }
}
