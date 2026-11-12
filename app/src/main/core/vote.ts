import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Store } from './db'
import type { Hub } from './hub'
import type { Settings } from './settings'
import type { HubEvent, Platform } from './types'
import { norm } from './auction'

/**
 * Голосование. Два места сразу: быстрое (на эфир, с таймером, висит на экране до конца)
 * и долгое (живёт между эфирами, на экране появляется иногда: само раз в N минут, по кнопке, клавише или команде).
 * Источник: «своё» — чат всех площадок (1 голос на зрителя, первый окончательный), донаты и баллы с весом;
 * «Twitch» — родное голосование Twitch: создаётся отсюда или на Twitch, голоса и таймер приходят оттуда.
 * Варианты от зрителей (команда, баллы, донат) ждут одобрения стримера.
 */

export type VoteKind = 'quick' | 'long'
export type VoteSource = 'own' | 'twitch'
export type VoteVia = 'chat' | 'donation' | 'points' | 'manual'

export interface VoteOption {
  id: string
  /** Номер для голоса «2», «второй», «#2». Не меняется. */
  num: number
  name: string
  /** Голоса из чата (по одному на зрителя). */
  chat: number
  /** Голоса за донаты, баллы и вручную. */
  paid: number
  /** Голоса Twitch (родное голосование). */
  tw: number
  /** id варианта на Twitch. */
  twId?: string
}

export interface VoteSuggestion {
  id: string
  ts: number
  user: string
  platform: Platform
  via: 'chat' | 'points' | 'donation'
  text: string
  /** Голоса, которые получит вариант при одобрении (донат или баллы). */
  weight: number
  /** Как пришло: «500 ₽», «1 000 баллов». */
  raw: string
}

export interface VoteRecent {
  ts: number
  user: string
  platform: Platform
  num: number
  weight: number
  via: VoteVia
}

export interface VoteResult {
  name: string
  votes: number
  tie: boolean
  ts: number
}

export interface Poll {
  id: string
  kind: VoteKind
  source: VoteSource
  title: string
  createdAt: number
  options: VoteOption[]
  /** Приём голосов идёт. */
  open: boolean
  /** Время вышло (приём остановлен таймером). */
  timeUp: boolean
  timer: { endsAt: number | null; pausedLeft: number | null }
  /** Принимать варианты от зрителей. */
  suggest: boolean
  /** Кто уже голосовал в чате: «площадка:ник». */
  voters: string[]
  /** id событий хаба, уже засчитанных (донаты и баллы не считаются дважды). */
  seen: string[]
  recent: VoteRecent[]
  pending: VoteSuggestion[]
  result: VoteResult | null
  /** Twitch: id голосования. */
  twitchId?: string
  /** Twitch: баллов за дополнительный голос (0 — выкл.). */
  twitchPoints?: number
}

export interface PollView extends Poll {
  total: number
  /** Сколько зрителей проголосовало в чате. */
  chatVoters: number
  /** Варианты по убыванию голосов (с суммой votes). */
  ranked: (VoteOption & { votes: number })[]
}

export interface VoteArchiveItem {
  ts: number
  kind: VoteKind
  source: VoteSource
  title: string
  winner: string | null
  votes: number
  total: number
  options: { name: string; votes: number }[]
}

export interface VoteState {
  quick: PollView | null
  long: PollView | null
  /** Долгое сейчас на экране до этого времени. */
  showUntil: number | null
  /** Когда долгое покажется само (если включено и идёт эфир). */
  nextAutoShow: number | null
  /** Когда снова сработает команда показа. */
  cmdReadyAt: number
  archive: VoteArchiveItem[]
  hotkeyError: string
}

export interface VoteOverlayView {
  now: number
  visible: boolean
  showFrom: number | null
  showUntil: number | null
  poll: {
    kind: VoteKind
    source: VoteSource
    title: string
    open: boolean
    timeUp: boolean
    timer: Poll['timer']
    total: number
    options: { id: string; num: number; name: string; votes: number }[]
    hint: string[]
    result: VoteResult | null
  } | null
}

/** Что нужно от Twitch (подключается в index.ts). */
export interface TwitchPolls {
  available(): 'ok' | 'login' | 'relogin'
  create(title: string, choices: string[], sec: number, pointsPerVote: number): Promise<{ id: string; endsAt: number | null; choices: { id: string; title: string }[] }>
  end(id: string): Promise<void>
}

/** Событие голосования Twitch (begin / progress / end). */
export interface TwitchPollEvent {
  phase: 'begin' | 'progress' | 'end'
  id: string
  title: string
  choices: { id: string; title: string; votes: number }[]
  endsAt: number | null
  /** Для end: completed, terminated, archived. */
  status: string
}

const OPT_LIMIT = 20
const TWITCH_OPT_LIMIT = 5
const VOTER_LIMIT = 50_000
const SEEN_LIMIT = 2000
const RECENT_LIMIT = 40
const PENDING_LIMIT = 100
const ARCHIVE_LIMIT = 10
const MAX_TIMER = 24 * 3600_000
const MAX_VOTES = 1_000_000

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '')
const cnt = (v: unknown): number => Math.max(0, Math.min(MAX_VOTES, Math.round(Number(v) || 0)))
const fmt = (n: number): string => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const PLATFORMS = new Set(['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'donationalerts', 'donatepay', 'donatex', 'boosty', 'obs', 'hub'])
const plat = (v: unknown): Platform => (PLATFORMS.has(v as string) ? v : 'hub') as Platform
const votesOf = (o: VoteOption): number => o.chat + o.paid + o.tw

/** Ник для «один голос на зрителя»: регистр и «@» не важны. */
export const voterKey = (platform: Platform, user: string): string => `${platform}:${user.toLowerCase().replace(/^@/, '').trim()}`

const ORDINALS: [RegExp, number][] = [
  [/^перв/, 1], [/^втор/, 2], [/^трет/, 3], [/^четв[её]рт/, 4], [/^пят/, 5],
  [/^шест/, 6], [/^седьм/, 7], [/^восьм/, 8], [/^девят/, 9], [/^десят/, 10]
]
const ORD_END = /^(?:ый|ий|ой|ая|ья|ое|ье|ые|ьи|ого|его|ую|ью|ым)?$/

/**
 * Номер варианта из короткого сообщения: «2», «#2», «№2», «2!», «2й», «второй», «Первый!».
 * Сообщение должно состоять только из этого (плюс знаки), иначе это обычный разговор в чате.
 */
export function choiceNumber(text: string): number | null {
  const n = norm(text).replace(/[#№]/g, '').trim()
  if (!n || n.includes(' ')) return null
  const d = n.match(/^(\d{1,2})(?:й|ый|ой|я|е|ое)?$/)
  if (d) return Number(d[1]) || null
  for (const [re, num] of ORDINALS) {
    const m = n.match(re)
    if (m && ORD_END.test(n.slice(m[0].length))) return num
  }
  return null
}

function loadPoll(v: unknown): Poll | null {
  const o = obj(v)
  const id = s(o.id, 40)
  if (!id) return null
  const options = (Array.isArray(o.options) ? o.options : []).slice(0, OPT_LIMIT).map((x): VoteOption | null => {
    const p = obj(x)
    const name = s(p.name, 60)
    const oid = s(p.id, 40)
    if (!name || !oid) return null
    return { id: oid, num: Math.max(1, Math.round(Number(p.num) || 1)), name, chat: cnt(p.chat), paid: cnt(p.paid), tw: cnt(p.tw), ...(s(p.twId, 80) ? { twId: s(p.twId, 80) } : {}) }
  }).filter((x): x is VoteOption => !!x)
  const t = obj(o.timer)
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null)
  const r = obj(o.result)
  const strs = (x: unknown, lim: number, max: number): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string').slice(-lim).map((y) => y.slice(0, max)) : [])
  return {
    id, kind: o.kind === 'long' ? 'long' : 'quick', source: o.source === 'twitch' ? 'twitch' : 'own',
    title: s(o.title, 120), createdAt: Number(o.createdAt) || Date.now(), options,
    open: o.open === true, timeUp: o.timeUp === true,
    timer: { endsAt: num(t.endsAt), pausedLeft: num(t.pausedLeft) },
    suggest: o.suggest === true,
    voters: strs(o.voters, VOTER_LIMIT, 100), seen: strs(o.seen, SEEN_LIMIT, 100),
    recent: (Array.isArray(o.recent) ? o.recent : []).slice(0, RECENT_LIMIT).map((x) => {
      const y = obj(x)
      const via = y.via === 'donation' || y.via === 'points' || y.via === 'manual' ? y.via : 'chat'
      return { ts: Number(y.ts) || 0, user: s(y.user, 64), platform: plat(y.platform), num: Math.max(0, Math.round(Number(y.num) || 0)), weight: cnt(y.weight), via }
    }),
    pending: (Array.isArray(o.pending) ? o.pending : []).slice(0, PENDING_LIMIT).map((x) => {
      const y = obj(x)
      const via: VoteSuggestion['via'] = y.via === 'points' || y.via === 'donation' ? y.via : 'chat'
      return { id: s(y.id, 40) || randomUUID(), ts: Number(y.ts) || 0, user: s(y.user, 64), platform: plat(y.platform), via, text: s(y.text, 60), weight: cnt(y.weight), raw: s(y.raw, 40) }
    }).filter((x) => x.text),
    result: s(r.name, 200) ? { name: s(r.name, 200), votes: cnt(r.votes), tie: r.tie === true, ts: Number(r.ts) || Date.now() } : null,
    ...(s(o.twitchId, 80) ? { twitchId: s(o.twitchId, 80) } : {}),
    ...(Number(o.twitchPoints) > 0 ? { twitchPoints: cnt(o.twitchPoints) } : {})
  }
}

interface Saved {
  quick: Poll | null
  long: Poll | null
  archive: VoteArchiveItem[]
}

function load(v: unknown): Saved {
  const o = obj(v)
  const quick = loadPoll(o.quick)
  const long = loadPoll(o.long)
  return {
    quick: quick ? { ...quick, kind: 'quick' } : null,
    long: long ? { ...long, kind: 'long', source: 'own', timer: { endsAt: null, pausedLeft: null } } : null,
    archive: (Array.isArray(o.archive) ? o.archive : []).slice(0, ARCHIVE_LIMIT).map((x) => {
      const a = obj(x)
      return {
        ts: Number(a.ts) || 0, kind: a.kind === 'long' ? 'long' : 'quick', source: a.source === 'twitch' ? 'twitch' : 'own',
        title: s(a.title, 120), winner: s(a.winner, 200) || null, votes: cnt(a.votes), total: cnt(a.total),
        options: (Array.isArray(a.options) ? a.options : []).slice(0, 10).map((y) => ({ name: s(obj(y).name, 60), votes: cnt(obj(y).votes) }))
      }
    })
  }
}

export interface PollDraft {
  kind: VoteKind
  source: VoteSource
  title: string
  options: string[]
  /** Таймер быстрого, секунд (0 — без таймера; Twitch: 15–1800). */
  sec: number
  suggest: boolean
  /** Twitch: баллов за дополнительный голос (0 — выкл.). */
  twitchPoints: number
}

/** События: 'change' (VoteState), 'started' (PollView), 'finished' (PollView). */
export class Vote extends EventEmitter {
  private d: Saved
  private tick: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private showFrom: number | null = null
  private showUntil: number | null = null
  /** Конец прошлого показа долгого (отсчёт «раз в N минут»). */
  private lastShown = Date.now()
  private cmdReadyAt = 0
  private hotkeyError = ''
  private twitch: TwitchPolls | null = null

  constructor(private store: Store, private settings: Settings, hub: Hub, private isLive: () => boolean = () => false) {
    super()
    this.d = load(store.get<unknown>('vote.v1', null))
    hub.on('event', (e: HubEvent) => this.onEvent(e))
    this.syncTick()
  }

  setTwitch(t: TwitchPolls): void {
    this.twitch = t
  }

  setHotkeyError(text: string): void {
    if (text === this.hotkeyError) return
    this.hotkeyError = text
    this.emit('change', this.state())
  }

  // ---------- Состояние ----------

  private view(p: Poll | null): PollView | null {
    if (!p) return null
    const ranked = p.options.map((o) => ({ ...o, votes: votesOf(o) })).sort((a, b) => b.votes - a.votes || a.num - b.num)
    return { ...p, voters: [], seen: [], chatVoters: p.voters.length, total: ranked.reduce((a, o) => a + o.votes, 0), ranked }
  }

  private nextAuto(): number | null {
    const cfg = this.settings.get().vote
    const l = this.d.long
    if (!l || !l.open || cfg.autoShowMin <= 0 || !this.isLive()) return null
    if (this.showUntil) return null
    return this.lastShown + cfg.autoShowMin * 60_000
  }

  state(): VoteState {
    return {
      quick: this.view(this.d.quick),
      long: this.view(this.d.long),
      showUntil: this.showUntil,
      nextAutoShow: this.nextAuto(),
      cmdReadyAt: this.cmdReadyAt,
      archive: this.d.archive,
      hotkeyError: this.hotkeyError
    }
  }

  /** Подсказки для оверлея: как голосовать. */
  private hint(p: Poll, other: Poll | null): string[] {
    const cfg = this.settings.get().vote
    if (p.source === 'twitch') return ['Голосуй в чате Twitch']
    const out: string[] = []
    const nums = p.options.slice(0, 3).map((o) => o.num).join(', ')
    // Если идут оба голосования, долгое — только командой (обычные номера уходят в быстрое).
    const plain = p.kind === 'quick' || !(other && other.open)
    if (cfg.chat && p.options.length) out.push(plain ? `Пиши в чат номер: ${nums}${p.options.length > 3 ? '…' : ''}` : `${cfg.voteCmd} ${p.options[0].num} — проголосовать`)
    if (cfg.chat && p.kind === 'long' && plain && p.options.length) out.push(`или ${cfg.voteCmd} ${p.options[0].num}`)
    if (p.suggest && cfg.suggestCmd) out.push(`${cfg.suggestCmd} название — предложить`)
    if (cfg.rubPerVote > 0) out.push('Донат с #номером — ещё голоса')
    return out
  }

  overlay(): VoteOverlayView {
    const now = Date.now()
    const q = this.d.quick
    const l = this.d.long
    let p: Poll | null = null
    let timed = false
    if (q && (q.open || q.result || q.timeUp || q.timer.pausedLeft)) p = q
    else if (l && this.showUntil && this.showUntil > now) { p = l; timed = true }
    const v = this.view(p)
    return {
      now, visible: !!v,
      showFrom: timed ? this.showFrom : null,
      showUntil: timed ? this.showUntil : null,
      poll: v && {
        kind: v.kind, source: v.source, title: v.title, open: v.open, timeUp: v.timeUp, timer: { ...v.timer }, total: v.total,
        options: v.options.map((o) => ({ id: o.id, num: o.num, name: o.name, votes: votesOf(o) })),
        hint: this.hint(v, v.kind === 'quick' ? l : q),
        result: v.result
      }
    }
  }

  private changed(): void {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.store.set('vote.v1', this.d) }, 500)
    this.syncTick()
    this.emit('change', this.state())
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    this.store.set('vote.v1', this.d)
  }

  // ---------- Голоса ----------

  /** Вариант по тексту: номер/порядковое слово, точное название, название внутри текста. */
  findOption(p: Poll, text: string, loose: boolean): VoteOption | null {
    const num = choiceNumber(text)
    if (num !== null) return p.options.find((o) => o.num === num) ?? null
    const n = norm(text)
    if (!n) return null
    const exact = p.options.find((o) => norm(o.name) === n)
    if (exact || !loose) return exact ?? null
    const m = n.match(/[#№]\s*(\d{1,2})\b/)
    if (m) return p.options.find((o) => o.num === Number(m[1])) ?? null
    const first = n.split(' ')[0]
    const byWord = choiceNumber(first)
    if (byWord !== null && n.split(' ').length <= 3) return p.options.find((o) => o.num === byWord) ?? null
    let best: VoteOption | null = null
    let bestLen = 0
    let tie = false
    for (const o of p.options) {
      const on = norm(o.name)
      if (on.length < 3) continue
      if ((' ' + n + ' ').includes(' ' + on + ' ')) {
        if (on.length > bestLen) { best = o; bestLen = on.length; tie = false } else if (on.length === bestLen) tie = true
      }
    }
    return tie ? null : best
  }

  private remember(p: Poll, id: string): boolean {
    if (!id) return true
    if (p.seen.includes(id)) return false
    p.seen.push(id)
    if (p.seen.length > SEEN_LIMIT) p.seen.splice(0, p.seen.length - SEEN_LIMIT)
    return true
  }

  private log(p: Poll, r: Omit<VoteRecent, 'ts'>): void {
    p.recent.unshift({ ts: Date.now(), ...r })
    if (p.recent.length > RECENT_LIMIT) p.recent.length = RECENT_LIMIT
  }

  private own(p: Poll | null): p is Poll {
    return !!p && p.open && p.source === 'own'
  }

  private longShown(): boolean {
    return !!this.showUntil && this.showUntil > Date.now()
  }

  private onEvent(e: HubEvent): void {
    if (e.test) return
    const cfg = this.settings.get().vote
    const q = this.d.quick
    const l = this.d.long
    if (e.type === 'message') {
      const text = (e.text ?? '').trim()
      if (!text) return
      const low = text.toLowerCase()
      const cmd = (c: string): string | null => {
        const k = c.trim().toLowerCase()
        if (!k) return null
        if (low === k) return ''
        return low.startsWith(k + ' ') ? text.slice(k.length).trim() : null
      }
      // Показать долгое командой — общий кулдаун на всех зрителей.
      if (cmd(cfg.showCmd) !== null) {
        if (l && (l.open || l.result) && Date.now() >= this.cmdReadyAt) {
          this.cmdReadyAt = Date.now() + cfg.showCooldownSec * 1000
          this.show()
        }
        return
      }
      const sug = cmd(cfg.suggestCmd)
      if (sug !== null) {
        const target = q && q.open && q.suggest ? q : l && l.open && l.suggest ? l : null
        if (target && sug) this.suggestion(target, { user: e.user, platform: e.platform, via: 'chat', text: sug, weight: 0, raw: '' })
        return
      }
      if (!cfg.chat) return
      const vc = cmd(cfg.voteCmd)
      let target: Poll | null = null
      let opt: VoteOption | null = null
      if (vc !== null) {
        target = this.own(l) ? l : this.own(q) ? q : null
        opt = target && vc ? this.findOption(target, vc, true) : null
      } else if (this.own(q)) {
        target = q
        opt = this.findOption(q, text, false)
      } else if (this.own(l) && this.longShown()) {
        target = l
        opt = this.findOption(l, text, false)
      }
      if (!target || !opt) return
      const key = voterKey(e.platform, e.user || e.userId || '')
      // Один голос из чата на зрителя за голосование; первый окончательный.
      if (target.voters.includes(key)) return
      target.voters.push(key)
      if (target.voters.length > VOTER_LIMIT) target.voters.splice(0, target.voters.length - VOTER_LIMIT)
      opt.chat++
      this.log(target, { user: e.user, platform: e.platform, num: opt.num, weight: 1, via: 'chat' })
      this.changed()
      return
    }

    if (e.type === 'donation' && (e.amountRub ?? 0) > 0) {
      const amount = e.amountRub ?? 0
      const raw = e.currency && e.currency !== 'RUB' && e.amount ? `${fmt(e.amount)} ${e.currency}` : `${fmt(amount)} ₽`
      const weight = cfg.rubPerVote > 0 ? Math.floor(amount / cfg.rubPerVote + 1e-9) : 0
      const text = e.text ?? ''
      for (const p of [q, l]) {
        if (!this.own(p) || weight <= 0) continue
        const opt = this.findOption(p, text, true)
        if (!opt) continue
        if (!this.remember(p, e.id)) return
        opt.paid += weight
        this.log(p, { user: e.user, platform: e.platform, num: opt.num, weight, via: e.manual ? 'manual' : 'donation' })
        this.changed()
        return
      }
      // Вариант не нашёлся: крупный донат с текстом — предложение (ждёт одобрения, голоса придут с ним).
      if (cfg.suggestDonMin > 0 && amount >= cfg.suggestDonMin && text.trim()) {
        const target = this.own(q) && q.suggest ? q : this.own(l) && l.suggest ? l : null
        if (target && this.remember(target, e.id)) this.suggestion(target, { user: e.user, platform: e.platform, via: 'donation', text, weight, raw })
      }
      return
    }

    if (e.type === 'reward' && e.platform === 'twitch') {
      const title = e.reward ?? ''
      const input = e.text && title && e.text.startsWith(title) ? e.text.slice(title.length).replace(/^\s*—\s*/, '') : (e.text ?? '')
      const raw = `${fmt(e.amount ?? 0)} баллов`
      if (cfg.pointsReward.trim() && norm(title) === norm(cfg.pointsReward)) {
        const weight = Math.max(1, Math.floor((e.amount ?? 0) / Math.max(1, cfg.pointsPerVote)))
        for (const p of [q, l]) {
          if (!this.own(p)) continue
          const opt = this.findOption(p, input, true)
          if (!opt) continue
          if (!this.remember(p, e.id)) return
          opt.paid += weight
          this.log(p, { user: e.user, platform: e.platform, num: opt.num, weight, via: 'points' })
          this.changed()
          return
        }
        // Баллы потрачены, но вариант не узнан — стримеру в очередь, решит сам.
        const target = this.own(q) ? q : this.own(l) ? l : null
        if (target && input.trim() && this.remember(target, e.id)) this.suggestion(target, { user: e.user, platform: e.platform, via: 'points', text: input, weight, raw })
        return
      }
      if (cfg.suggestReward.trim() && norm(title) === norm(cfg.suggestReward)) {
        const target = q && q.open && q.suggest ? q : l && l.open && l.suggest ? l : null
        if (target && input.trim() && this.remember(target, e.id)) this.suggestion(target, { user: e.user, platform: e.platform, via: 'points', text: input, weight: 0, raw })
      }
    }
  }

  private suggestion(p: Poll, x: Omit<VoteSuggestion, 'id' | 'ts'>): void {
    const text = s(x.text.replace(/https?:\/\/\S+/gi, ''), 60)
    if (!text) return
    const n = norm(text)
    // Такой вариант уже есть — платный голос засчитываем ему, бесплатное предложение просто пропускаем.
    const exists = p.options.find((o) => norm(o.name) === n)
    if (exists) {
      if (x.weight > 0) {
        exists.paid += x.weight
        this.log(p, { user: x.user, platform: x.platform, num: exists.num, weight: x.weight, via: x.via === 'donation' ? 'donation' : 'points' })
        this.changed()
      }
      return
    }
    if (x.weight === 0) {
      if (p.pending.some((y) => norm(y.text) === n)) return
      // Не больше трёх бесплатных предложений от одного зрителя в очереди.
      const key = voterKey(x.platform, x.user)
      if (p.pending.filter((y) => y.weight === 0 && voterKey(y.platform, y.user) === key).length >= 3) return
    }
    if (p.pending.length >= PENDING_LIMIT) return
    p.pending.push({ id: randomUUID(), ts: Date.now(), ...x, user: s(x.user, 64) || 'Зритель', text })
    this.changed()
  }

  // ---------- Голосование: запуск и ход ----------

  private poll(kind: unknown): Poll {
    const p = kind === 'long' ? this.d.long : kind === 'quick' ? this.d.quick : null
    if (!p) throw new Error('Голосование не найдено — возможно, его уже закрыли')
    return p
  }

  private cleanOptions(list: unknown, max: number, maxLen: number): string[] {
    const out: string[] = []
    for (const x of Array.isArray(list) ? list : []) {
      const n = s(x, maxLen)
      if (n && !out.some((y) => norm(y) === norm(n))) out.push(n)
    }
    return out.slice(0, max)
  }

  async start(raw: unknown): Promise<void> {
    const o = obj(raw)
    const kind: VoteKind = o.kind === 'long' ? 'long' : 'quick'
    const source: VoteSource = kind === 'quick' && o.source === 'twitch' ? 'twitch' : 'own'
    const cur = kind === 'long' ? this.d.long : this.d.quick
    if (cur && cur.open) throw new Error(kind === 'long' ? 'Долгое голосование уже идёт — сначала завершите его' : 'Быстрое голосование уже идёт — сначала завершите его')
    const title = s(o.title, source === 'twitch' ? 60 : 120)
    const options = this.cleanOptions(o.options, source === 'twitch' ? TWITCH_OPT_LIMIT : OPT_LIMIT, source === 'twitch' ? 25 : 60)
    const suggest = source === 'own' && o.suggest === true
    if (!options.length && !suggest) throw new Error('Добавьте хотя бы один вариант')
    const secRaw = Math.round(Number(o.sec) || 0)
    let poll: Poll = {
      id: randomUUID(), kind, source, title, createdAt: Date.now(),
      options: options.map((name, i) => ({ id: randomUUID(), num: i + 1, name, chat: 0, paid: 0, tw: 0 })),
      open: true, timeUp: false, timer: { endsAt: null, pausedLeft: null }, suggest,
      voters: [], seen: [], recent: [], pending: [], result: null
    }
    if (source === 'twitch') {
      if (!this.twitch) throw new Error('Twitch не подключён')
      const acc = this.twitch.available()
      if (acc === 'login') throw new Error('Войдите в Twitch (Подключения → Twitch)')
      if (acc === 'relogin') throw new Error('Нужно новое разрешение на голосования — войдите в Twitch заново (Подключения → Twitch)')
      if (!title) throw new Error('Для Twitch нужен вопрос (до 60 символов)')
      if (options.length < 2) throw new Error('Для Twitch нужно от 2 до 5 вариантов')
      const sec = Math.min(1800, Math.max(15, secRaw || 60))
      const points = Math.max(0, Math.min(1_000_000, Math.round(Number(o.twitchPoints) || 0)))
      const r = await this.twitch.create(title, options, sec, points)
      // Пока ждали Twitch, могло начаться другое быстрое (например, на самом Twitch) — его не затираем.
      if (this.d.quick?.open && this.d.quick.twitchId === r.id) return
      poll = {
        ...poll, twitchId: r.id, twitchPoints: points,
        options: poll.options.map((x, i) => ({ ...x, twId: r.choices[i]?.id })),
        timer: { endsAt: r.endsAt ?? Date.now() + sec * 1000, pausedLeft: null }
      }
    } else if (kind === 'quick' && secRaw > 0) {
      poll.timer = { endsAt: Date.now() + Math.min(MAX_TIMER, secRaw * 1000), pausedLeft: null }
    }
    this.retire(kind)
    if (kind === 'long') this.d.long = poll
    else this.d.quick = poll
    if (kind === 'long') this.lastShown = Date.now()
    this.changed()
    this.emit('started', this.view(poll))
  }

  /** Убрать прошлое голосование этого места: итог — в архив (если были голоса). */
  private retire(kind: VoteKind): void {
    const p = kind === 'long' ? this.d.long : this.d.quick
    if (!p) return
    const v = this.view(p)
    if (v && v.total > 0) {
      this.d.archive.unshift({
        ts: Date.now(), kind: v.kind, source: v.source, title: v.title,
        winner: v.result?.name ?? null, votes: v.result?.votes ?? 0, total: v.total,
        options: v.ranked.slice(0, 10).map((x) => ({ name: x.name, votes: x.votes }))
      })
      if (this.d.archive.length > ARCHIVE_LIMIT) this.d.archive.length = ARCHIVE_LIMIT
    }
    if (kind === 'long') { this.d.long = null; this.showUntil = null; this.showFrom = null } else this.d.quick = null
  }

  /** Закрыть голосование (убрать с экрана): итог — в архив. Идущее на Twitch — завершается там. */
  close(kind: unknown): void {
    const p = this.poll(kind)
    if (p.source === 'twitch' && p.open && p.twitchId && this.twitch) void this.twitch.end(p.twitchId).catch(() => {})
    this.retire(p.kind)
    this.changed()
  }

  private computeResult(p: Poll): VoteResult | null {
    const v = this.view(p)
    if (!v || !v.ranked.length || v.total <= 0) return null
    const top = v.ranked[0].votes
    const leaders = v.ranked.filter((x) => x.votes === top)
    return { name: leaders.map((x) => x.name).join(' / ').slice(0, 200), votes: top, tie: leaders.length > 1, ts: Date.now() }
  }

  /** Завершить: приём закрыт, итог на экране. */
  finish(kind: unknown): VoteResult | null {
    const p = this.poll(kind)
    if (!p.open && p.result) return p.result
    if (p.source === 'twitch' && p.open && p.twitchId && this.twitch) void this.twitch.end(p.twitchId).catch(() => {})
    p.open = false
    p.timer = { endsAt: null, pausedLeft: null }
    p.result = this.computeResult(p)
    if (p.kind === 'long' && p.result) this.show()
    this.changed()
    const v = this.view(p)
    if (v && p.result) this.emit('finished', v)
    return p.result
  }

  /** Открыть/закрыть приём голосов (своё). Таймер быстрого при закрытии встаёт на паузу. */
  setOpen(kind: unknown, v: boolean): void {
    const p = this.poll(kind)
    if (p.source === 'twitch') throw new Error('Приёмом голосов Twitch управляет Twitch — можно только завершить')
    if (v) {
      p.open = true
      p.timeUp = false
      p.result = null
      if (p.timer.pausedLeft) { p.timer.endsAt = Date.now() + p.timer.pausedLeft; p.timer.pausedLeft = null }
    } else {
      p.open = false
      if (p.timer.endsAt) { p.timer.pausedLeft = Math.max(1000, p.timer.endsAt - Date.now()); p.timer.endsAt = null }
    }
    this.changed()
  }

  /** Таймер быстрого: add/sub — ±sec секунд. */
  timer(op: unknown, sec: unknown): void {
    const p = this.poll('quick')
    if (p.source === 'twitch') throw new Error('Таймер голосования Twitch изменить нельзя')
    const n = (typeof sec === 'number' && Number.isFinite(sec) ? Math.round(Math.abs(sec)) : 30) * 1000
    const t = p.timer
    const now = Date.now()
    if (op === 'add') {
      if (t.endsAt) t.endsAt = Math.min(now + MAX_TIMER, t.endsAt + n)
      else if (t.pausedLeft) t.pausedLeft = Math.min(MAX_TIMER, t.pausedLeft + n)
      else if (p.open) t.endsAt = now + n
      else { t.pausedLeft = n; p.timeUp = false }
    } else if (op === 'sub') {
      if (t.endsAt) t.endsAt = Math.max(now + 1000, t.endsAt - n)
      else if (t.pausedLeft) t.pausedLeft = Math.max(1000, t.pausedLeft - n)
    } else if (op === 'clear') {
      t.endsAt = null
      t.pausedLeft = null
    } else return
    this.changed()
  }

  // ---------- Варианты ----------

  addOption(kind: unknown, name: unknown): VoteOption {
    const p = this.poll(kind)
    if (p.source === 'twitch') throw new Error('Варианты голосования Twitch менять нельзя')
    if (p.options.length >= OPT_LIMIT) throw new Error(`Слишком много вариантов (максимум ${OPT_LIMIT})`)
    const n = s(name, 60)
    if (!n) throw new Error('Название варианта пустое')
    if (p.options.some((o) => norm(o.name) === norm(n))) throw new Error(`Вариант «${n}» уже есть`)
    const o: VoteOption = { id: randomUUID(), num: Math.max(0, ...p.options.map((x) => x.num)) + 1, name: n, chat: 0, paid: 0, tw: 0 }
    p.options.push(o)
    this.changed()
    return o
  }

  renameOption(kind: unknown, id: unknown, name: unknown): void {
    const p = this.poll(kind)
    if (p.source === 'twitch') throw new Error('Варианты голосования Twitch менять нельзя')
    const o = p.options.find((x) => x.id === id)
    if (!o) throw new Error('Вариант не найден')
    const n = s(name, 60)
    if (!n) throw new Error('Название варианта пустое')
    if (p.options.some((x) => x.id !== o.id && norm(x.name) === norm(n))) throw new Error(`Вариант «${n}» уже есть`)
    o.name = n
    this.changed()
  }

  /** Удалить вариант вместе с его голосами (голос из чата у зрителя остаётся потраченным). */
  removeOption(kind: unknown, id: unknown): void {
    const p = this.poll(kind)
    if (p.source === 'twitch') throw new Error('Варианты голосования Twitch менять нельзя')
    p.options = p.options.filter((x) => x.id !== id)
    this.changed()
  }

  /** Голоса вручную (наличные, перевод мимо сервисов; минус — поправить ошибку). */
  addVotes(kind: unknown, id: unknown, n: unknown): void {
    const p = this.poll(kind)
    if (p.source === 'twitch') throw new Error('Голоса Twitch менять нельзя')
    const o = p.options.find((x) => x.id === id)
    if (!o) throw new Error('Вариант не найден')
    const k = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0
    if (!k || Math.abs(k) > MAX_VOTES) throw new Error('Укажите число голосов')
    o.paid = Math.max(0, Math.min(MAX_VOTES, o.paid + k))
    this.log(p, { user: 'Стример', platform: 'hub', num: o.num, weight: k, via: 'manual' })
    this.changed()
  }

  /** Одобрить предложение: новый вариант (можно со своим названием) или голоса в существующий. */
  approve(kind: unknown, sugId: unknown, name?: unknown, intoId?: unknown): void {
    const p = this.poll(kind)
    const x = p.pending.find((y) => y.id === sugId)
    if (!x) throw new Error('Предложение не найдено')
    let opt = typeof intoId === 'string' && intoId ? p.options.find((o) => o.id === intoId) ?? null : null
    if (!opt) {
      const n = s(typeof name === 'string' && name.trim() ? name : x.text, 60)
      opt = p.options.find((o) => norm(o.name) === norm(n)) ?? null
      if (!opt) {
        if (p.options.length >= OPT_LIMIT) throw new Error(`Слишком много вариантов (максимум ${OPT_LIMIT})`)
        opt = { id: randomUUID(), num: Math.max(0, ...p.options.map((o) => o.num)) + 1, name: n, chat: 0, paid: 0, tw: 0 }
        p.options.push(opt)
      }
    }
    if (x.weight > 0) {
      opt.paid += x.weight
      this.log(p, { user: x.user, platform: x.platform, num: opt.num, weight: x.weight, via: x.via === 'donation' ? 'donation' : 'points' })
    }
    p.pending = p.pending.filter((y) => y.id !== x.id)
    this.changed()
  }

  reject(kind: unknown, sugId: unknown): void {
    const p = this.poll(kind)
    p.pending = p.pending.filter((y) => y.id !== sugId)
    this.changed()
  }

  setSuggest(kind: unknown, v: boolean): void {
    const p = this.poll(kind)
    if (p.source === 'twitch') return
    p.suggest = v
    this.changed()
  }

  setTitle(kind: unknown, title: unknown): void {
    const p = this.poll(kind)
    if (p.source === 'twitch') throw new Error('Вопрос голосования Twitch менять нельзя')
    p.title = s(title, 120)
    this.changed()
  }

  // ---------- Показ долгого ----------

  /** Показать долгое на showSec секунд (или на sec). */
  show(sec?: number): void {
    const l = this.d.long
    if (!l) return
    const cfg = this.settings.get().vote
    const n = Math.max(5, Math.min(600, Math.round(sec ?? cfg.showSec)))
    this.showFrom = Date.now()
    this.showUntil = this.showFrom + n * 1000
    this.changed()
  }

  hide(): void {
    if (!this.showUntil) return
    this.showUntil = null
    this.showFrom = null
    this.lastShown = Date.now()
    this.changed()
  }

  /** Горячая клавиша и кнопка дока: показать, а если уже на экране — спрятать. */
  toggleShow(): void {
    if (this.longShown()) this.hide()
    else this.show()
  }

  // ---------- Twitch ----------

  /** Событие родного голосования Twitch: начато здесь или на самом Twitch — показываем и считаем. */
  twitchEvent(ev: TwitchPollEvent): void {
    let p = this.d.quick
    if (!p || p.twitchId !== ev.id) {
      if (ev.phase === 'end' && ev.status === 'archived') return
      // Голосование начали на Twitch (не отсюда): занимаем быстрое место, если оно свободно.
      if (p && p.open) return
      this.retire('quick')
      p = {
        id: randomUUID(), kind: 'quick', source: 'twitch', title: s(ev.title, 60), createdAt: Date.now(),
        options: ev.choices.slice(0, TWITCH_OPT_LIMIT).map((c, i) => ({ id: randomUUID(), num: i + 1, name: s(c.title, 60) || `Вариант ${i + 1}`, chat: 0, paid: 0, tw: 0, twId: c.id })),
        open: true, timeUp: false, timer: { endsAt: ev.endsAt, pausedLeft: null }, suggest: false,
        voters: [], seen: [], recent: [], pending: [], result: null, twitchId: ev.id
      }
      this.d.quick = p
      if (ev.phase === 'begin') this.emit('started', this.view(p))
    }
    for (const c of ev.choices) {
      const o = p.options.find((x) => x.twId === c.id) ?? p.options.find((x) => norm(x.name) === norm(c.title))
      if (o) o.tw = cnt(c.votes)
    }
    if (ev.endsAt && p.open) p.timer.endsAt = ev.endsAt
    if (ev.phase === 'end') {
      if (ev.status === 'archived') { this.changed(); return }
      const wasOpen = p.open
      p.open = false
      p.timer = { endsAt: null, pausedLeft: null }
      p.timeUp = ev.status === 'completed'
      p.result = this.computeResult(p)
      this.changed()
      const v = this.view(p)
      if (wasOpen && v && p.result) this.emit('finished', v)
      return
    }
    this.changed()
  }

  // ---------- Таймер ----------

  private syncTick(): void {
    const need = !!(this.d.quick?.timer.endsAt || this.d.long)
    if (need && !this.tick) this.tick = setInterval(() => this.onTick(), 500)
    if (!need && this.tick) { clearInterval(this.tick); this.tick = null }
  }

  private onTick(): void {
    const now = Date.now()
    const q = this.d.quick
    if (q && q.open && q.timer.endsAt && q.timer.endsAt <= now) {
      if (q.source === 'twitch') {
        // Итог пришлёт Twitch (channel.poll.end); если не пришлёт за 15 с — считаем сами.
        if (now - q.timer.endsAt > 15_000) { q.timeUp = true; this.finish('quick') }
      } else {
        q.timeUp = true
        this.finish('quick')
      }
      return
    }
    if (this.showUntil && this.showUntil <= now) { this.hide(); return }
    const next = this.nextAuto()
    if (next !== null && next <= now) this.show()
    // Эфира нет — «раз в N минут» не копится: отсчёт начнётся с начала эфира.
    else if (next === null && !this.showUntil && !this.isLive()) this.lastShown = now
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
