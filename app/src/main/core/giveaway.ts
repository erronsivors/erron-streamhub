import { EventEmitter } from 'node:events'
import { randomInt, randomUUID } from 'node:crypto'
import type { Hub } from './hub'
import type { Store } from './db'
import type { HubEvent, Platform } from './types'
import type { Settings } from './settings'
import { norm } from './auction'

/**
 * Розыгрыш: зрители пишут слово в чат (один билет), донат даёт дополнительные билеты (каждые N ₽ = +1).
 * Приём — по таймеру или до кнопки. Победители выбираются в ядре заранее (crypto, вес = билеты, без повторов),
 * оверлей и интерфейс лишь проигрывают прокрутку ников до них. После выбора — проверка «на месте»:
 * сообщения победителя и таймер ответа; не ответил — «Перевыбрать».
 */

export interface GiveawayEntry {
  /** Ник в нижнем регистре (ё → е): один зритель — одна запись, даже с разных площадок. */
  key: string
  user: string
  platform: Platform
  /** Написал слово в чат. */
  chat: boolean
  /** Сумма донатов за время приёма. */
  rub: number
  ts: number
  /** Тестовый участник (кнопка «Добавить тестовых»). */
  fake?: boolean
}

export interface GiveawayWinner {
  key: string
  user: string
  platform: Platform
  tickets: number
  ts: number
  /** До какого момента ждать ответа в чате. */
  deadline: number
  answered: boolean
  /** Перевыбран (не ответил) — остаётся в списке зачёркнутым. */
  skipped: boolean
  messages: { ts: number; text: string; platform: Platform }[]
}

export interface GiveawayReveal {
  id: string
  /** Ники для прокрутки (перемешаны), в конце — победители. */
  names: string[]
  winners: string[]
  startedAt: number
  durationMs: number
}

export interface GiveawayArchiveItem {
  ts: number
  prize: string
  winners: string[]
  entries: number
  tickets: number
}

export interface GiveawayState {
  prize: string
  open: boolean
  endsAt: number | null
  timeUp: boolean
  entries: (GiveawayEntry & { tickets: number })[]
  tickets: number
  reveal: GiveawayReveal | null
  winners: GiveawayWinner[]
  archive: GiveawayArchiveItem[]
}

export interface GiveawayOverlayView {
  prize: string
  keyword: string
  open: boolean
  endsAt: number | null
  timeUp: boolean
  count: number
  tickets: number
  rubPerTicket: number
  reveal: GiveawayReveal | null
  winners: { user: string; answered: boolean }[]
  /** Когда выбраны (для «скрыть через N секунд»). */
  drawnAt: number | null
  now: number
}

const ENTRY_LIMIT = 20000
const ARCHIVE_LIMIT = 10
const MSG_LIMIT = 8

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const nickOf = (user: string): string => user.toLowerCase().replace(/ё/g, 'е').trim()
/** Участник = площадка + ник: одинаковые ники на разных площадках — разные люди. */
const keyOf = (platform: Platform, user: string): string => `${platform}:${nickOf(user)}`
/** Площадки с чатом: донат с сервиса донатов (без своей площадки) прибавляется участнику из чата с тем же ником. */
const CHAT_PLATFORMS = new Set<Platform>(['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'hub'])
const PLATFORMS: Platform[] = ['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'donationalerts', 'donatepay', 'donatex', 'boosty', 'obs', 'hub']
const plat = (v: unknown): Platform => ((PLATFORMS as unknown[]).includes(v) ? (v as Platform) : 'hub')

function sanitizeEntry(v: unknown): GiveawayEntry | null {
  const o = obj(v)
  const user = s(o.user, 60)
  if (!user) return null
  return {
    key: keyOf(plat(o.platform), user), user, platform: plat(o.platform), chat: o.chat === true, rub: Math.max(0, Math.min(1e9, num(o.rub))), ts: num(o.ts),
    ...(o.fake === true ? { fake: true } : {})
  }
}

function sanitizeWinner(v: unknown): GiveawayWinner | null {
  const o = obj(v)
  const user = s(o.user, 60)
  if (!user) return null
  return {
    key: keyOf(plat(o.platform), user), user, platform: plat(o.platform), tickets: Math.max(1, Math.round(num(o.tickets))), ts: num(o.ts), deadline: num(o.deadline),
    answered: o.answered === true, skipped: o.skipped === true,
    messages: (Array.isArray(o.messages) ? o.messages : []).slice(0, MSG_LIMIT).map((m) => ({ ts: num(obj(m).ts), text: s(obj(m).text, 300), platform: plat(obj(m).platform) })).filter((m) => m.text)
  }
}

/** Взвешенный выбор без повторов (криптографический). */
export function pickWeighted<T>(list: T[], weight: (x: T) => number, count: number): T[] {
  const pool = list.filter((x) => weight(x) > 0)
  const out: T[] = []
  while (out.length < count && pool.length) {
    const total = pool.reduce((a, x) => a + weight(x), 0)
    let r = randomInt(0, Math.max(1, Math.round(total * 1000))) / 1000
    let i = 0
    for (; i < pool.length - 1; i++) {
      r -= weight(pool[i])
      if (r < 0) break
    }
    out.push(pool.splice(i, 1)[0])
  }
  return out
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** События: 'change' (GiveawayState), 'opened' (prize), 'drawn' (GiveawayWinner[] — новые победители, после прокрутки). */
export class Giveaway extends EventEmitter {
  private prize = ''
  private open = false
  private endsAt: number | null = null
  private timeUp = false
  private entries = new Map<string, GiveawayEntry>()
  private seen = new Set<string>()
  private winners: GiveawayWinner[] = []
  private reveal: GiveawayReveal | null = null
  private archive: GiveawayArchiveItem[] = []
  private timer: NodeJS.Timeout | null = null
  private revealTimer: NodeJS.Timeout | null = null
  /** Уже выбранные победители, пока идёт показ прокрутки: итог фиксируется даже при закрытии посреди показа. */
  private pendingChosen: (GiveawayEntry & { tickets: number })[] | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private drawnAt: number | null = null
  /** Когда открыт приём: донаты раньше этого момента (повтор при переподключении сервиса) не засчитываются. */
  private openedAt = 0

  constructor(private store: Store, private settings: Settings, hub: Hub) {
    super()
    const raw = obj(store.get<unknown>('giveaway.v1', null))
    this.prize = s(raw.prize, 80)
    this.open = raw.open === true
    this.endsAt = num(raw.endsAt) > 0 ? num(raw.endsAt) : null
    this.timeUp = raw.timeUp === true
    this.openedAt = num(raw.openedAt)
    for (const e of (Array.isArray(raw.entries) ? raw.entries : []).slice(0, ENTRY_LIMIT).map(sanitizeEntry)) if (e) this.entries.set(e.key, e)
    for (const id of (Array.isArray(raw.seen) ? raw.seen : []).slice(-5000)) if (typeof id === 'string') this.seen.add(id)
    this.winners = (Array.isArray(raw.winners) ? raw.winners : []).slice(0, 20).map(sanitizeWinner).filter((x): x is GiveawayWinner => !!x)
    this.drawnAt = this.winners.length ? Math.max(...this.winners.map((w) => w.ts)) : null
    this.archive = (Array.isArray(raw.archive) ? raw.archive : []).slice(0, ARCHIVE_LIMIT).map((x) => {
      const o = obj(x)
      return { ts: num(o.ts), prize: s(o.prize, 80), winners: (Array.isArray(o.winners) ? o.winners : []).map((w) => s(w, 60)).filter(Boolean).slice(0, 20), entries: Math.round(num(o.entries)), tickets: Math.round(num(o.tickets)) }
    })
    hub.on('event', (e: HubEvent) => this.onEvent(e))
    this.syncTimer()
  }

  // ---------- Состояние ----------

  ticketsOf(e: GiveawayEntry): number {
    const cfg = this.settings.get().giveaway
    const extra = cfg.rubPerTicket > 0 ? Math.floor(e.rub / cfg.rubPerTicket) : 0
    return Math.min(cfg.maxTickets, (e.chat ? 1 : 0) + extra)
  }

  private list(): (GiveawayEntry & { tickets: number })[] {
    return [...this.entries.values()].map((e) => ({ ...e, tickets: this.ticketsOf(e) })).filter((e) => e.tickets > 0)
  }

  state(): GiveawayState {
    const list = this.list().sort((a, b) => b.ts - a.ts)
    return {
      prize: this.prize, open: this.open, endsAt: this.endsAt, timeUp: this.timeUp,
      entries: list.slice(0, 500), tickets: list.reduce((a, e) => a + e.tickets, 0),
      reveal: this.reveal, winners: this.winners, archive: this.archive
    }
  }

  overlay(): GiveawayOverlayView {
    const list = this.list()
    const cfg = this.settings.get().giveaway
    return {
      prize: this.prize, keyword: cfg.keyword, open: this.open, endsAt: this.endsAt, timeUp: this.timeUp,
      count: list.length, tickets: list.reduce((a, e) => a + e.tickets, 0), rubPerTicket: cfg.rubPerTicket,
      reveal: this.reveal, winners: this.reveal ? [] : this.winners.filter((w) => !w.skipped).map((w) => ({ user: w.user, answered: w.answered })),
      drawnAt: this.drawnAt, now: Date.now()
    }
  }

  private changed(): void {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save() }, 500)
    this.emit('change', this.state())
  }

  private save(): void {
    this.store.set('giveaway.v1', {
      prize: this.prize, open: this.open, endsAt: this.endsAt, timeUp: this.timeUp, openedAt: this.openedAt,
      entries: [...this.entries.values()], seen: [...this.seen].slice(-5000), winners: this.winners, archive: this.archive
    })
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.save()
  }

  // ---------- Приём ----------

  private syncTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.open || !this.endsAt) return
    const ms = this.endsAt - Date.now()
    if (ms <= 0) { this.close(true); return }
    this.timer = setTimeout(() => this.syncTimer(), Math.min(ms, 86_400_000))
  }

  /** Открыть приём: на N минут (0 — без таймера). Приз — что разыгрываем. */
  start(prize: unknown, min: unknown): void {
    if (this.reveal) throw new Error('Идёт выбор победителя — дождитесь итога')
    const p = s(prize, 80)
    if (p) this.prize = p
    const m = Math.max(0, Math.min(24 * 60, Math.round(num(min))))
    const wasOpen = this.open
    if (!wasOpen) this.openedAt = Date.now()
    this.open = true
    this.timeUp = false
    this.endsAt = m > 0 ? Date.now() + m * 60_000 : null
    this.syncTimer()
    this.changed()
    if (!wasOpen) this.emit('opened', this.prize)
  }

  /** ±N минут к таймеру. */
  extend(min: unknown): void {
    if (!this.open) throw new Error('Приём участников закрыт')
    const m = Math.round(num(min))
    if (!m) return
    const base = this.endsAt ?? Date.now()
    this.endsAt = Math.max(Date.now() + 5000, base + m * 60_000)
    this.syncTimer()
    this.changed()
  }

  close(byTimer = false): void {
    this.open = false
    this.timeUp = byTimer
    this.endsAt = null
    this.syncTimer()
    this.changed()
  }

  setPrize(prize: unknown): void {
    this.prize = s(prize, 80)
    this.changed()
  }

  private onEvent(e: HubEvent): void {
    if (e.test) return
    const user = s(e.user, 60)
    if (!user) return
    const key = keyOf(e.platform, user)
    // Проверка «на месте»: любые сообщения победителя после выбора.
    if (e.type === 'message') {
      // Победитель-донатер (участвовал только донатом с сервиса) может ответить в чате любой площадки — сверяем по нику.
      const w = this.winners.find((x) => !x.skipped && (x.key === key || (!CHAT_PLATFORMS.has(x.platform) && nickOf(x.user) === nickOf(user))))
      if (w && e.ts >= w.ts && !this.reveal) {
        w.messages.unshift({ ts: e.ts || Date.now(), text: s(e.text, 300), platform: e.platform })
        if (w.messages.length > MSG_LIMIT) w.messages.length = MSG_LIMIT
        w.answered = true
        this.changed()
      }
    }
    if (!this.open) return
    const cfg = this.settings.get().giveaway
    if (e.type === 'message') {
      const kw = norm(cfg.keyword)
      const t = norm(e.text ?? '')
      if (!kw || !(t === kw || t.startsWith(kw + ' '))) return
      const cur = this.entries.get(key)
      if (cur?.chat) return
      if (!cur && this.entries.size >= ENTRY_LIMIT) return
      this.entries.set(key, { ...(cur ?? { key, user, platform: e.platform, rub: 0, ts: e.ts || Date.now() }), chat: true })
      this.changed()
    } else if (e.type === 'donation' && cfg.rubPerTicket > 0 && (e.amountRub ?? 0) > 0) {
      if (this.seen.has(e.id) || (e.ts && e.ts < this.openedAt - 5000)) return
      this.seen.add(e.id)
      // Донат с сервиса донатов: если в чате ровно один участник с таким ником — билеты ему; иначе отдельный участник.
      let target = key
      if (!CHAT_PLATFORMS.has(e.platform) && !this.entries.has(key)) {
        const same = [...this.entries.values()].filter((x) => nickOf(x.user) === nickOf(user))
        if (same.length === 1) target = same[0].key
      }
      const cur = this.entries.get(target)
      if (!cur && this.entries.size >= ENTRY_LIMIT) return
      const next = cur ? { ...cur, rub: cur.rub + (e.amountRub ?? 0) } : { key, user, platform: e.platform, chat: false, rub: e.amountRub ?? 0, ts: e.ts || Date.now() }
      this.entries.set(target, next)
      this.changed()
    }
  }

  removeEntry(key: string): void {
    this.entries.delete(String(key).slice(0, 120))
    this.changed()
  }

  /** Тестовые участники — проверить оверлей и выбор без зрителей. */
  addFakes(n: unknown): number {
    const count = Math.max(1, Math.min(50, Math.round(num(n)) || 10))
    const names = ['night_raven', 'pixel_fox', 'kot_v_sapogah', 'Ёжик', 'moroz', 'lisa', 'santa_claws', 'bit_master', 'lucky_cat', 'kostya_play', 'ann', 'vasya', 'dark_knight', 'zefirka', 'gromozeka']
    let added = 0
    for (let i = 0; i < 200 && added < count; i++) {
      const user = `Тест ${names[i % names.length]}${i >= names.length ? ' ' + Math.floor(i / names.length) : ''}`
      const key = keyOf('hub', user)
      if (this.entries.has(key)) continue
      this.entries.set(key, { key, user, platform: 'hub', chat: true, rub: randomInt(0, 4) * 150, ts: Date.now() + added, fake: true })
      added++
    }
    this.changed()
    return added
  }

  // ---------- Выбор ----------

  /** Выбрать N победителей (из тех, кто ещё не выигрывал в этом розыгрыше). */
  draw(count: unknown): void {
    if (this.reveal) throw new Error('Уже выбираем — дождитесь итога')
    const n = Math.max(1, Math.min(10, Math.round(num(count)) || 1))
    const taken = new Set(this.winners.map((w) => w.key))
    const pool = this.list().filter((e) => !taken.has(e.key))
    if (!pool.length) throw new Error(this.entries.size ? 'Все участники уже выиграли или перевыбраны' : 'Участников пока нет')
    if (this.open) this.close(false)
    const chosen = pickWeighted(pool, (e) => e.tickets, n)
    this.startReveal(chosen, pool)
  }

  /** Победитель не ответил — отметить и выбрать другого. */
  reroll(key: string): void {
    if (this.reveal) throw new Error('Уже выбираем — дождитесь итога')
    const w = this.winners.find((x) => x.key === String(key).slice(0, 120) && !x.skipped)
    if (!w) throw new Error('Победитель не найден')
    const taken = new Set(this.winners.map((x) => x.key))
    const pool = this.list().filter((e) => !taken.has(e.key))
    if (!pool.length) throw new Error('Больше некого выбрать — все участники уже были')
    w.skipped = true
    this.startReveal(pickWeighted(pool, (e) => e.tickets, 1), pool)
  }

  private startReveal(chosen: (GiveawayEntry & { tickets: number })[], pool: GiveawayEntry[]): void {
    const ovCfg = this.settings.get().overlays.giveaway
    const winners = chosen.map((e) => e.user)
    const others = shuffle(pool.filter((e) => !chosen.includes(e as never)).map((e) => e.user)).slice(0, 40)
    // Если участников мало — повторяем ники, чтобы прокрутке было что показывать.
    const names: string[] = []
    while (names.length < 24 && (others.length || winners.length)) names.push(...(others.length ? others : winners))
    const durationMs = Math.max(1, ovCfg.revealSec) * 1000
    this.reveal = { id: randomUUID(), names: names.slice(0, 40), winners, startedAt: Date.now() + 150, durationMs }
    this.changed()
    this.pendingChosen = chosen
    this.revealTimer = setTimeout(() => this.finishReveal(false), durationMs + 150)
  }

  /** Итог выбора: победители записываются. quiet — без события 'drawn' (приложение закрывается посреди показа). */
  private finishReveal(quiet: boolean): void {
    if (this.revealTimer) clearTimeout(this.revealTimer)
    this.revealTimer = null
    const chosen = this.pendingChosen
    this.pendingChosen = null
    if (!chosen) return
    const cfg = this.settings.get().giveaway
    const now = Date.now()
    const fresh: GiveawayWinner[] = chosen.map((e) => ({
      key: e.key, user: e.user, platform: e.platform, tickets: e.tickets, ts: now, deadline: now + cfg.answerSec * 1000,
      answered: false, skipped: false, messages: []
    }))
    this.winners.push(...fresh)
    this.reveal = null
    this.drawnAt = now
    this.changed()
    if (!quiet) this.emit('drawn', fresh)
  }

  /** Новый розыгрыш: итог в архив, участники и победители — с нуля. */
  reset(): void {
    if (this.reveal) throw new Error('Идёт выбор победителя — дождитесь итога')
    const list = this.list()
    const won = this.winners.filter((w) => !w.skipped).map((w) => w.user)
    if (won.length || list.length) {
      this.archive.unshift({ ts: Date.now(), prize: this.prize, winners: won, entries: list.length, tickets: list.reduce((a, e) => a + e.tickets, 0) })
      if (this.archive.length > ARCHIVE_LIMIT) this.archive.length = ARCHIVE_LIMIT
    }
    this.entries.clear()
    this.winners = []
    this.drawnAt = null
    this.open = false
    this.timeUp = false
    this.endsAt = null
    this.syncTimer()
    this.changed()
  }

  clearArchive(): void {
    this.archive = []
    this.changed()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    // Закрытие посреди показа: победители уже выбраны — записываем их, а не теряем.
    if (this.pendingChosen) this.finishReveal(true)
    if (this.revealTimer) clearTimeout(this.revealTimer)
    this.timer = null
    this.revealTimer = null
    this.flush()
  }
}
