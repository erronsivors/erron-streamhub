import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ConnLogEntry, ConnState, ConnStatus, HubEvent, MsgPart, Platform } from './types'

const LOG_LIMIT = 50
const EVENTS_LIMIT = 200
const CHAT_LIMIT = 300

/** Текст из внешних источников: обрезаем длину и убираем управляющие символы. */
export function clean(s: unknown, max = 500): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
}

/** Цвет ника: только #RRGGBB, иначе ничего. */
export function cleanColor(c: unknown): string | undefined {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : undefined
}

/**
 * Центральная шина Crossember.
 * 'event'  — новое событие/сообщение (HubEvent)
 * 'delete' — удалено сообщение чата (id) или все сообщения пользователя ({ userId })
 * 'pinned' — изменилось закреплённое сообщение
 * 'status' — изменился статус подключения
 */
export class Hub extends EventEmitter {
  private conns = new Map<Platform, ConnStatus>()
  private events: HubEvent[] = []
  private chat: HubEvent[] = []
  pinned: HubEvent | null = null

  register(id: Platform, name: string): void {
    if (!this.conns.has(id)) this.conns.set(id, { id, name, state: 'off', detail: 'Не настроено', since: Date.now(), log: [] })
  }

  setStatus(id: Platform, state: ConnState, detail: string): void {
    const c = this.conns.get(id)
    if (!c) return
    if (c.state !== state || c.detail !== detail) {
      const level: ConnLogEntry['level'] = state === 'error' ? 'error' : state === 'connecting' ? 'warn' : 'info'
      if (c.state !== state) c.since = Date.now()
      c.state = state
      c.detail = detail
      this.log(id, level, detail)
      this.emit('status', c)
    }
  }

  log(id: Platform, level: ConnLogEntry['level'], text: string): void {
    const c = this.conns.get(id)
    if (!c) return
    c.log.unshift({ ts: Date.now(), level, text: clean(text, 300) })
    if (c.log.length > LOG_LIMIT) c.log.length = LOG_LIMIT
    this.emit('log')
  }

  connections(): ConnStatus[] {
    return [...this.conns.values()].map((c) => ({ ...c, log: [...c.log] }))
  }

  /** Принять событие от коннектора. Поля чистятся здесь — один раз для всех площадок. */
  push(e: Omit<HubEvent, 'id' | 'ts'> & { id?: string; ts?: number }): HubEvent {
    const parts: MsgPart[] | undefined = e.parts
      ?.slice(0, 200)
      .map((p) => (p.t === 'text' ? { t: 'text' as const, v: clean(p.v) } : { t: 'emote' as const, v: clean(p.v, 64), url: p.url }))
    const ev: HubEvent = {
      ...e,
      id: clean(e.id ?? randomUUID(), 100),
      ts: e.ts ?? Date.now(),
      user: clean(e.user, 64),
      userId: e.userId === undefined ? undefined : clean(e.userId, 64),
      text: e.text === undefined ? undefined : clean(e.text),
      parts,
      color: cleanColor(e.color),
      badges: e.badges?.slice(0, 8).map((b) => ({ title: clean(b.title, 64), url: b.url })),
      currency: e.currency === undefined ? undefined : clean(e.currency, 8)
    }
    const list = ev.type === 'message' ? this.chat : this.events
    list.unshift(ev)
    const limit = ev.type === 'message' ? CHAT_LIMIT : EVENTS_LIMIT
    if (list.length > limit) list.length = limit
    this.emit('event', ev)
    return ev
  }

  deleteMessage(id: string): void {
    this.chat = this.chat.filter((m) => m.id !== id)
    if (this.pinned?.id === id) this.setPinned(null)
    this.emit('delete', { id })
  }

  deleteUserMessages(platform: Platform, userId: string): void {
    this.chat = this.chat.filter((m) => !(m.platform === platform && m.userId === userId))
    if (this.pinned && this.pinned.platform === platform && this.pinned.userId === userId) this.setPinned(null)
    this.emit('delete', { platform, userId })
  }

  clearChat(platform: Platform): void {
    this.chat = this.chat.filter((m) => m.platform !== platform)
    if (this.pinned?.platform === platform) this.setPinned(null)
    this.emit('delete', { platform })
  }

  /** Закрепить сообщение (вывести в оверлей «Закреп»). Повторный вызов с тем же id — снять. */
  togglePin(id: string | null): void {
    if (id === null || this.pinned?.id === id) return this.setPinned(null)
    const m = this.chat.find((x) => x.id === id) ?? this.events.find((x) => x.id === id)
    if (m) this.setPinned(m)
  }

  private setPinned(m: HubEvent | null): void {
    this.pinned = m
    this.emit('pinned', m)
  }

  findMessage(id: string): HubEvent | undefined {
    return this.chat.find((x) => x.id === id)
  }

  recent(): HubEvent[] {
    return [...this.events]
  }

  recentChat(): HubEvent[] {
    return [...this.chat]
  }

  seed(list: HubEvent[]): void {
    this.events = list.slice(0, EVENTS_LIMIT)
  }
}
