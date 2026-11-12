import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Store } from './db'
import type { Settings } from './settings'
import type { HubEvent } from './types'

/**
 * Локальная аналитика: зрители чата по площадкам, ядро аудитории, онлайн эфиров, склейка аккаунтов.
 * Всё хранится только в базе на этом ПК. Тексты сообщений НЕ сохраняются — у зрителя есть лишь
 * ник, площадка и счётчики (сколько сообщений, на скольких эфирах был, когда впервые и последний раз).
 * Онлайн площадок записывается раз в минуту, пока идёт эфир.
 */

export const CHAT_PLATFORMS = ['twitch', 'youtube', 'vk', 'kick', 'goodgame'] as const
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number]
export type AnalyticsPeriod = 'week' | 'month' | 'quarter' | 'all'

/** Что сейчас в эфире: даёт ядро (OBS + площадки). */
export interface LiveInfo {
  live: boolean
  /** Начало трансляции по OBS, если известно. */
  startedAt: number | null
  viewers: Partial<Record<ChatPlatform, number>>
  /** Свои аккаунты (канал, бот) — их сообщения не считаются. */
  own: string[]
}

export interface StreamPlatformStat {
  platform: ChatPlatform
  avg: number
  peak: number
  chatters: number
  messages: number
}

export interface StreamSummary {
  id: string
  started: number
  ended: number
  live: boolean
  avg: number
  peak: number
  chatters: number
  newChatters: number
  messages: number
  platforms: StreamPlatformStat[]
}

export interface StreamSamples {
  id: string
  started: number
  ended: number
  points: { t: number; v: Partial<Record<ChatPlatform, number>> }[]
}

export interface ViewerAccount {
  platform: ChatPlatform
  key: string
  user: string
  messages: number
  streams: number
  firstTs: number
  lastTs: number
}

export interface AudiencePerson {
  /** id склейки или «a:площадка:ник» для одиночного аккаунта. */
  id: string
  name: string
  accounts: ViewerAccount[]
  merged: boolean
  messages: number
  streams: number
  firstTs: number
  lastTs: number
  donations: { rub: number; count: number }
  core: boolean
}

export interface MergeSuggestion {
  key: string
  name: string
  accounts: ViewerAccount[]
}

export interface AnalyticsReport {
  period: AnalyticsPeriod
  since: number
  overview: {
    streams: number
    /** Суммарная длительность эфиров, мс. */
    airMs: number
    avg: number
    peak: number
    chatters: number
    newChatters: number
    core: number
    /** Зрителей в базе за всё время (после склейки). */
    total: number
  }
  platforms: { platform: ChatPlatform; avg: number; peak: number; chatters: number; share: number }[]
  streams: StreamSummary[]
  people: AudiencePerson[]
  peopleTotal: number
  suggestions: MergeSuggestion[]
}

export interface ViewerRef {
  platform: ChatPlatform
  key: string
}

/** Эфир закончился, если его нет дольше этого (переподключение OBS, сбой площадки). */
const END_GAP = 5 * 60_000
const TICK_MS = 60_000
const MAX_POINTS = 3000
/** Ядро — кто был на N+ эфирах и заходил за последние 30 дней. */
const CORE_RECENT = 30 * 86400_000
const PERIOD_DAYS: Record<AnalyticsPeriod, number> = { week: 7, month: 30, quarter: 90, all: 0 }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const clean = (v: string, max: number): string => v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
const isChat = (p: unknown): p is ChatPlatform => typeof p === 'string' && (CHAT_PLATFORMS as readonly string[]).includes(p)

/** Ключ зрителя: без «@», регистра и разницы «ё/е». Один ключ на разных площадках — кандидат на склейку. */
export function viewerKey(user: string): string {
  return clean(user, 80).replace(/^@+/, '').toLowerCase().replace(/ё/g, 'е')
}

const dayKey = (ts: number): string => {
  const d = new Date(ts)
  return `d:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

interface CurrentStream {
  id: string
  started: number
  lastLive: number
  points: [number, Partial<Record<ChatPlatform, number>>][]
  chatters: Partial<Record<ChatPlatform, number>>
  messages: Partial<Record<ChatPlatform, number>>
  newChatters: number
}

interface Pending {
  platform: ChatPlatform
  key: string
  user: string
  n: number
  first: number
  last: number
}

interface ViewerRow {
  platform: string
  key: string
  user: string
  messages: number
  streams: number
  first_ts: number
  last_ts: number
  last_session: string
  person: string | null
}

export class Analytics extends EventEmitter {
  private cur: CurrentStream | null = null
  private pending = new Map<string, Pending>()
  private flushTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null

  constructor(private store: Store, private settings: Settings, private live: () => LiveInfo, opts: { timers?: boolean; now?: number } = {}) {
    super()
    store.sql.exec(`
      CREATE TABLE IF NOT EXISTS viewers (
        platform TEXT NOT NULL, key TEXT NOT NULL, user TEXT NOT NULL,
        messages INTEGER NOT NULL DEFAULT 0, streams INTEGER NOT NULL DEFAULT 0,
        first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, last_session TEXT NOT NULL DEFAULT '',
        person TEXT, PRIMARY KEY (platform, key)
      );
      CREATE INDEX IF NOT EXISTS viewers_person ON viewers(person);
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY, started INTEGER NOT NULL, ended INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS streams_ended ON streams(ended);
    `)
    this.resume(opts.now ?? Date.now())
    if (opts.timers !== false) this.tickTimer = setInterval(() => this.tick(), TICK_MS)
  }

  private cfg(): { chat: boolean; online: boolean; coreMin: number; ignore: Set<string> } {
    const a = this.settings.get().analytics
    return { chat: a.chat, online: a.online, coreMin: a.coreMin, ignore: new Set(a.ignore.split(/[\s,;]+/).map(viewerKey).filter(Boolean)) }
  }

  // ---------- Эфиры и онлайн ----------

  /** После перезапуска приложения посреди эфира продолжаем тот же эфир. */
  private resume(now: number): void {
    const r = this.store.sql.prepare('SELECT * FROM streams ORDER BY ended DESC LIMIT 1').get() as { id: string; started: number; ended: number; data: string } | undefined
    if (!r || now - r.ended > END_GAP) return
    const d = this.parse(r.data)
    this.cur = { id: r.id, started: r.started, lastLive: r.ended, points: d.points, chatters: d.chatters, messages: d.messages, newChatters: d.newChatters }
  }

  private parse(raw: string): { points: CurrentStream['points']; chatters: CurrentStream['chatters']; messages: CurrentStream['messages']; newChatters: number } {
    let o: Record<string, unknown> = {}
    try { o = obj(JSON.parse(raw)) } catch { /* битая запись — пустой эфир */ }
    const counts = (v: unknown): Partial<Record<ChatPlatform, number>> => {
      const out: Partial<Record<ChatPlatform, number>> = {}
      for (const [k, x] of Object.entries(obj(v))) if (isChat(k) && num(x) > 0) out[k] = Math.round(num(x))
      return out
    }
    const points = (Array.isArray(o.points) ? o.points : []).slice(-MAX_POINTS).flatMap((p) => {
      if (!Array.isArray(p) || typeof p[0] !== 'number') return []
      return [[p[0], counts(p[1])] as [number, Partial<Record<ChatPlatform, number>>]]
    })
    return { points, chatters: counts(o.chatters), messages: counts(o.messages), newChatters: Math.round(num(o.newChatters)) }
  }

  /** Раз в минуту: эфир начался/идёт/закончился, точка онлайна. */
  tick(now = Date.now()): void {
    const info = this.live()
    const cfg = this.cfg()
    if (info.live && (cfg.chat || cfg.online)) {
      if (!this.cur) {
        const started = info.startedAt && info.startedAt <= now && now - info.startedAt < 86400_000 ? info.startedAt : now
        this.cur = { id: randomUUID(), started, lastLive: now, points: [], chatters: {}, messages: {}, newChatters: 0 }
      }
      this.cur.lastLive = now
      if (cfg.online) {
        const v: Partial<Record<ChatPlatform, number>> = {}
        for (const p of CHAT_PLATFORMS) {
          const n = info.viewers[p]
          if (typeof n === 'number' && Number.isFinite(n) && n >= 0) v[p] = Math.round(n)
        }
        if (Object.keys(v).length) {
          this.cur.points.push([now, v])
          if (this.cur.points.length > MAX_POINTS) this.cur.points.splice(0, this.cur.points.length - MAX_POINTS)
        }
      }
      this.saveStream()
    } else if (this.cur && (now - this.cur.lastLive > END_GAP || !(cfg.chat || cfg.online))) {
      this.endStream()
    }
  }

  private saveStream(): void {
    const c = this.cur
    if (!c) return
    const data = JSON.stringify({ points: c.points, chatters: c.chatters, messages: c.messages, newChatters: c.newChatters })
    this.store.sql.prepare('INSERT INTO streams(id, started, ended, data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET ended = excluded.ended, data = excluded.data')
      .run(c.id, c.started, c.lastLive, data)
    this.emit('change')
  }

  private endStream(): void {
    const c = this.cur
    if (!c) return
    this.flush()
    this.saveStream()
    this.cur = null
    // Проверка OBS на пару минут без зрителей и чата — не эфир.
    const empty = !c.points.length && !Object.keys(c.messages).length
    if (empty && c.lastLive - c.started < 3 * 60_000) this.store.sql.prepare('DELETE FROM streams WHERE id = ?').run(c.id)
    this.emit('change')
  }

  // ---------- Зрители чата ----------

  /** Сообщение чата: запомнить ник и +1 к счётчику. Текст не сохраняется. */
  onEvent(e: HubEvent): void {
    if (e.type !== 'message' || e.test || !isChat(e.platform)) return
    const cfg = this.cfg()
    if (!cfg.chat) return
    const key = viewerKey(e.user)
    if (!key || cfg.ignore.has(key)) return
    if (this.live().own.some((o) => viewerKey(o) === key)) return
    const id = `${e.platform}\n${key}`
    const ts = e.ts || Date.now()
    const p = this.pending.get(id)
    if (p) {
      p.n++
      p.last = Math.max(p.last, ts)
      p.user = clean(e.user, 60).replace(/^@+/, '') || p.user
    } else {
      this.pending.set(id, { platform: e.platform, key, user: clean(e.user, 60).replace(/^@+/, ''), n: 1, first: ts, last: ts })
    }
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush() }, 3000)
  }

  /** Записать накопленные сообщения одной транзакцией. */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (!this.pending.size) return
    const list = [...this.pending.values()]
    const db = this.store.sql
    const sel = db.prepare('SELECT last_session FROM viewers WHERE platform = ? AND key = ?')
    const ins = db.prepare('INSERT INTO viewers(platform, key, user, messages, streams, first_ts, last_ts, last_session) VALUES(?,?,?,?,1,?,?,?)')
    const upd = db.prepare('UPDATE viewers SET user = ?, messages = messages + ?, last_ts = MAX(last_ts, ?), streams = streams + ?, last_session = ? WHERE platform = ? AND key = ?')
    const c = this.cur
    // Счётчики эфира меняются в цикле — при сбое транзакции вернём их, чтобы повтор не посчитал дважды.
    const before = c ? { chatters: { ...c.chatters }, messages: { ...c.messages }, newChatters: c.newChatters } : null
    db.exec('BEGIN')
    try {
      for (const p of list) {
        const sk = c ? c.id : dayKey(p.last)
        const row = sel.get(p.platform, p.key) as { last_session: string } | undefined
        if (!row) {
          ins.run(p.platform, p.key, p.user, p.n, p.first, p.last, sk)
          if (c) { c.chatters[p.platform] = (c.chatters[p.platform] ?? 0) + 1; c.newChatters++ }
        } else {
          const visit = row.last_session !== sk
          upd.run(p.user, p.n, p.last, visit ? 1 : 0, sk, p.platform, p.key)
          if (c && visit) c.chatters[p.platform] = (c.chatters[p.platform] ?? 0) + 1
        }
        if (c) c.messages[p.platform] = (c.messages[p.platform] ?? 0) + p.n
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      if (c && before) Object.assign(c, before)
      // Очередь не очищена — данные запишутся при следующей попытке.
      throw err
    }
    // Очищаем только после успешной записи: при сбое накопленное не теряется.
    this.pending.clear()
    if (c) this.saveStream()
    else this.emit('change')
  }

  // ---------- Отчёт ----------

  private summary(r: { id: string; started: number; ended: number; data: string }): StreamSummary {
    const d = this.parse(r.data)
    const n = d.points.length
    const totals = d.points.map(([, v]) => Object.values(v).reduce((a, x) => a + (x ?? 0), 0))
    const platforms: StreamPlatformStat[] = []
    for (const p of CHAT_PLATFORMS) {
      const vals = d.points.map(([, v]) => v[p] ?? 0)
      const seen = d.points.some(([, v]) => v[p] !== undefined)
      if (!seen && !d.chatters[p] && !d.messages[p]) continue
      platforms.push({
        platform: p,
        avg: n ? Math.round(vals.reduce((a, x) => a + x, 0) / n) : 0,
        peak: vals.length ? Math.max(...vals) : 0,
        chatters: d.chatters[p] ?? 0,
        messages: d.messages[p] ?? 0
      })
    }
    platforms.sort((a, b) => b.avg - a.avg || b.chatters - a.chatters)
    return {
      id: r.id, started: r.started, ended: r.ended, live: this.cur?.id === r.id,
      avg: n ? Math.round(totals.reduce((a, x) => a + x, 0) / n) : 0,
      peak: n ? Math.max(...totals) : 0,
      chatters: Object.values(d.chatters).reduce((a, x) => a + (x ?? 0), 0),
      newChatters: d.newChatters,
      messages: Object.values(d.messages).reduce((a, x) => a + (x ?? 0), 0),
      platforms
    }
  }

  private accounts(): (ViewerAccount & { person: string | null })[] {
    const rows = this.store.sql.prepare('SELECT * FROM viewers').all() as unknown as ViewerRow[]
    return rows.filter((r) => isChat(r.platform)).map((r) => ({
      platform: r.platform as ChatPlatform, key: r.key, user: r.user, messages: Number(r.messages), streams: Number(r.streams),
      firstTs: Number(r.first_ts), lastTs: Number(r.last_ts), person: r.person
    }))
  }

  /** Склеенные зрители: аккаунты с одним person — один человек. */
  private persons(now: number, coreMin: number): AudiencePerson[] {
    // Донаты — по нику (сервисы донатов не привязаны к площадкам чата).
    const don = new Map<string, { rub: number; count: number }>()
    const rows = this.store.sql.prepare(
      `SELECT user, SUM(amount_rub) AS rub, COUNT(*) AS count FROM events WHERE test = 0 AND type = 'donation' AND amount_rub IS NOT NULL GROUP BY user`
    ).all() as { user: string; rub: number; count: number }[]
    for (const r of rows) {
      const k = viewerKey(String(r.user))
      const d = don.get(k) ?? { rub: 0, count: 0 }
      d.rub += Number(r.rub) || 0
      d.count += Number(r.count) || 0
      don.set(k, d)
    }
    const groups = new Map<string, (ViewerAccount & { person: string | null })[]>()
    for (const a of this.accounts()) {
      const id = a.person ?? `a:${a.platform}:${a.key}`
      const g = groups.get(id)
      if (g) g.push(a)
      else groups.set(id, [a])
    }
    const out: AudiencePerson[] = []
    for (const [id, list] of groups) {
      list.sort((a, b) => b.messages - a.messages)
      const keys = new Set(list.map((a) => a.key))
      const donations = { rub: 0, count: 0 }
      for (const k of keys) {
        const d = don.get(k)
        if (d) { donations.rub += d.rub; donations.count += d.count }
      }
      const streams = Math.max(...list.map((a) => a.streams))
      const lastTs = Math.max(...list.map((a) => a.lastTs))
      out.push({
        id, name: list[0].user, merged: !id.startsWith('a:'),
        accounts: list.map(({ person: _p, ...a }) => a),
        messages: list.reduce((s, a) => s + a.messages, 0),
        streams, firstTs: Math.min(...list.map((a) => a.firstTs)), lastTs,
        donations: { rub: Math.round(donations.rub * 100) / 100, count: donations.count },
        core: streams >= coreMin && now - lastTs <= CORE_RECENT
      })
    }
    return out
  }

  private suggestions(): MergeSuggestion[] {
    const dismissed = new Set(this.store.get<string[]>('analytics.dismissed.v1', []))
    const byKey = new Map<string, (ViewerAccount & { person: string | null })[]>()
    for (const a of this.accounts()) {
      const g = byKey.get(a.key)
      if (g) g.push(a)
      else byKey.set(a.key, [a])
    }
    const out: (MergeSuggestion & { weight: number })[] = []
    for (const [key, list] of byKey) {
      if (list.length < 2 || dismissed.has(key)) continue
      const people = new Set(list.map((a) => a.person ?? `a:${a.platform}`))
      if (people.size < 2) continue
      list.sort((a, b) => b.messages - a.messages)
      out.push({ key, name: list[0].user, accounts: list.map(({ person: _p, ...a }) => a), weight: list.reduce((s, a) => s + a.messages, 0) })
    }
    return out.sort((a, b) => b.weight - a.weight).slice(0, 30).map(({ weight: _w, ...s }) => s)
  }

  report(period: AnalyticsPeriod, now = Date.now()): AnalyticsReport {
    this.flush()
    const cfg = this.cfg()
    const since = PERIOD_DAYS[period] ? now - PERIOD_DAYS[period] * 86400_000 : 0
    const rows = this.store.sql.prepare('SELECT * FROM streams WHERE ended >= ? ORDER BY started DESC LIMIT 500').all(since) as { id: string; started: number; ended: number; data: string }[]
    const streams = rows.map((r) => this.summary(r))
    const withOnline = streams.filter((s) => s.peak > 0)

    const all = this.persons(now, cfg.coreMin)
    const active = all.filter((p) => p.lastTs >= since).sort((a, b) => b.messages - a.messages)

    const accounts = this.accounts().filter((a) => a.lastTs >= since)
    const platforms: AnalyticsReport['platforms'] = []
    const chattersTotal = accounts.length
    for (const p of CHAT_PLATFORMS) {
      const st = withOnline.map((s) => s.platforms.find((x) => x.platform === p)).filter((x): x is StreamPlatformStat => !!x)
      const chatters = accounts.filter((a) => a.platform === p).length
      if (!st.length && !chatters) continue
      platforms.push({
        platform: p,
        avg: st.length ? Math.round(st.reduce((a, x) => a + x.avg, 0) / withOnline.length) : 0,
        peak: st.length ? Math.max(...st.map((x) => x.peak)) : 0,
        chatters,
        share: chattersTotal ? Math.round((chatters / chattersTotal) * 100) : 0
      })
    }
    platforms.sort((a, b) => b.avg - a.avg || b.chatters - a.chatters)

    return {
      period, since,
      overview: {
        streams: streams.length,
        airMs: streams.reduce((a, s) => a + Math.max(0, s.ended - s.started), 0),
        avg: withOnline.length ? Math.round(withOnline.reduce((a, s) => a + s.avg, 0) / withOnline.length) : 0,
        peak: withOnline.length ? Math.max(...withOnline.map((s) => s.peak)) : 0,
        chatters: active.length,
        newChatters: active.filter((p) => p.firstTs >= since).length,
        core: all.filter((p) => p.core).length,
        total: all.length
      },
      platforms,
      streams: streams.slice(0, 200),
      people: active.slice(0, 1000),
      peopleTotal: active.length,
      suggestions: this.suggestions()
    }
  }

  stream(id: string): StreamSamples | null {
    if (this.cur?.id === id) this.saveStream()
    const r = this.store.sql.prepare('SELECT * FROM streams WHERE id = ?').get(id) as { id: string; started: number; ended: number; data: string } | undefined
    if (!r) return null
    return { id: r.id, started: r.started, ended: r.ended, points: this.parse(r.data).points.map(([t, v]) => ({ t, v })) }
  }

  // ---------- Склейка и удаление ----------

  private refs(v: unknown): ViewerRef[] {
    if (!Array.isArray(v)) return []
    const seen = new Set<string>()
    const out: ViewerRef[] = []
    for (const x of v.slice(0, 20)) {
      const o = obj(x)
      if (!isChat(o.platform) || typeof o.key !== 'string' || !o.key || o.key.length > 100) continue
      const id = `${o.platform}\n${o.key}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ platform: o.platform, key: o.key })
    }
    return out
  }

  /** Склеить аккаунты (и уже склеенные с ними) в одного зрителя. */
  merge(input: unknown): void {
    this.flush()
    const refs = this.refs(input)
    const db = this.store.sql
    const get = db.prepare('SELECT person FROM viewers WHERE platform = ? AND key = ?')
    const found = refs.map((r) => ({ r, row: get.get(r.platform, r.key) as { person: string | null } | undefined })).filter((x) => x.row)
    if (found.length < 2) throw new Error('Выберите хотя бы двух зрителей')
    const persons = [...new Set(found.map((x) => x.row?.person).filter((p): p is string => !!p))]
    const target = persons[0] ?? `p:${randomUUID()}`
    db.exec('BEGIN')
    try {
      for (const p of persons.slice(1)) db.prepare('UPDATE viewers SET person = ? WHERE person = ?').run(target, p)
      for (const { r } of found) db.prepare('UPDATE viewers SET person = ? WHERE platform = ? AND key = ?').run(target, r.platform, r.key)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    this.emit('change')
  }

  /** Отделить аккаунт от склейки. */
  unmerge(input: unknown): void {
    const [r] = this.refs([input])
    if (!r) return
    const db = this.store.sql
    const row = db.prepare('SELECT person FROM viewers WHERE platform = ? AND key = ?').get(r.platform, r.key) as { person: string | null } | undefined
    if (!row?.person) return
    db.prepare('UPDATE viewers SET person = NULL WHERE platform = ? AND key = ?').run(r.platform, r.key)
    const left = db.prepare('SELECT COUNT(*) AS n FROM viewers WHERE person = ?').get(row.person) as { n: number }
    if (Number(left.n) < 2) db.prepare('UPDATE viewers SET person = NULL WHERE person = ?').run(row.person)
    // Чтобы подсказка «это один человек» не вернулась сразу после ручного разделения.
    this.dismiss(r.key)
    this.emit('change')
  }

  /** «Не он»: больше не предлагать склеить этот ник. */
  dismiss(key: unknown): void {
    if (typeof key !== 'string' || !key || key.length > 100) return
    const list = this.store.get<string[]>('analytics.dismissed.v1', []).filter((k) => typeof k === 'string' && k !== key)
    list.push(key)
    this.store.set('analytics.dismissed.v1', list.slice(-2000))
    this.emit('change')
  }

  /** Забыть зрителя (все его аккаунты). */
  forget(id: unknown): void {
    if (typeof id !== 'string' || id.length > 200) return
    this.flush()
    const db = this.store.sql
    const m = /^a:([a-z]+):(.+)$/s.exec(id)
    if (m) db.prepare('DELETE FROM viewers WHERE platform = ? AND key = ?').run(m[1], m[2])
    else if (id.startsWith('p:')) db.prepare('DELETE FROM viewers WHERE person = ?').run(id)
    this.emit('change')
  }

  /** Очистить всю аналитику: зрителей и историю эфиров. */
  clear(): void {
    this.pending.clear()
    const db = this.store.sql
    db.exec('DELETE FROM viewers; DELETE FROM streams;')
    this.store.set('analytics.dismissed.v1', [])
    if (this.cur) {
      this.cur = { ...this.cur, started: Date.now(), points: [], chatters: {}, messages: {}, newChatters: 0 }
      this.saveStream()
    }
    this.emit('change')
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    this.flush()
    if (this.cur) this.saveStream()
  }
}

export const isAnalyticsPeriod = (v: unknown): v is AnalyticsPeriod => v === 'week' || v === 'month' || v === 'quarter' || v === 'all'
