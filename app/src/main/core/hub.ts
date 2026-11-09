import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ConnLogEntry, ConnState, ConnStatus, HubEvent, Platform } from './types'

const LOG_LIMIT = 50
const EVENTS_LIMIT = 200

/** Ник/текст из внешних источников: обрезаем длину и убираем управляющие символы. */
export function clean(s: unknown, max = 500): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
}

/**
 * Центральная шина: события со всех площадок и статусы подключений.
 * 'event'  — новое событие (HubEvent)
 * 'status' — изменился статус подключения
 */
export class Hub extends EventEmitter {
  private conns = new Map<Platform, ConnStatus>()
  private events: HubEvent[] = []

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
  }

  connections(): ConnStatus[] {
    return [...this.conns.values()].map((c) => ({ ...c, log: [...c.log] }))
  }

  /** Принять событие от коннектора. Поля чистятся здесь — один раз для всех площадок. */
  push(e: Omit<HubEvent, 'id' | 'ts'> & { id?: string; ts?: number }): HubEvent {
    const ev: HubEvent = {
      ...e,
      id: e.id ?? randomUUID(),
      ts: e.ts ?? Date.now(),
      user: clean(e.user, 64),
      text: e.text === undefined ? undefined : clean(e.text),
      currency: e.currency === undefined ? undefined : clean(e.currency, 8)
    }
    this.events.unshift(ev)
    if (this.events.length > EVENTS_LIMIT) this.events.length = EVENTS_LIMIT
    this.emit('event', ev)
    return ev
  }

  recent(): HubEvent[] {
    return [...this.events]
  }

  seed(list: HubEvent[]): void {
    this.events = list.slice(0, EVENTS_LIMIT)
  }
}
