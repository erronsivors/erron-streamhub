import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { HubEvent } from './types'

/** Локальное хранилище: один файл SQLite в папке данных пользователя. */
export class Store {
  private db: DatabaseSync

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'hub.sqlite3'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets  (key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, platform TEXT NOT NULL, type TEXT NOT NULL,
        user TEXT NOT NULL, text TEXT, amount REAL, currency TEXT, test INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    `)
    // Миграция: сумма в рублях для статистики (этап 3).
    const cols = this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'amount_rub')) this.db.exec('ALTER TABLE events ADD COLUMN amount_rub REAL')
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  getSecretBlob(key: string): Buffer | null {
    const row = this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: Uint8Array } | undefined
    return row ? Buffer.from(row.value) : null
  }

  setSecretBlob(key: string, value: Buffer | null): void {
    if (value === null) this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO secrets(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  addEvent(e: HubEvent): void {
    this.db.prepare('INSERT OR IGNORE INTO events(id, ts, platform, type, user, text, amount, currency, test, amount_rub) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(e.id, e.ts, e.platform, e.type, e.user, e.text ?? null, e.amount ?? null, e.currency ?? null, e.test ? 1 : 0, e.amountRub ?? null)
  }

  recentEvents(limit = 100): HubEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE type != ? ORDER BY ts DESC LIMIT ?').all('message', limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id), ts: Number(r.ts), platform: r.platform as HubEvent['platform'], type: r.type as HubEvent['type'],
      user: String(r.user), text: (r.text as string) ?? undefined, amount: (r.amount as number) ?? undefined,
      currency: (r.currency as string) ?? undefined, test: r.test === 1, amountRub: (r.amount_rub as number) ?? undefined
    }))
  }

  /** Есть ли уже событие с таким id (защита от повторов при переподключении). */
  hasEvent(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM events WHERE id = ?').get(id)
  }

  /** Итоги с момента since (тестовые не считаются). */
  totals(since: number): { type: string; platform: string; count: number; rub: number }[] {
    return this.db.prepare(
      'SELECT type, platform, COUNT(*) AS count, COALESCE(SUM(amount_rub), 0) AS rub FROM events WHERE test = 0 AND ts >= ? AND type != ? GROUP BY type, platform'
    ).all(since, 'message') as { type: string; platform: string; count: number; rub: number }[]
  }

  /** Топ донатеров по сумме в рублях с момента since. Один ник с разных сервисов складывается. */
  topDonors(since: number, limit: number): { user: string; rub: number; count: number }[] {
    return this.db.prepare(
      `SELECT MAX(user) AS user, SUM(amount_rub) AS rub, COUNT(*) AS count FROM events
       WHERE test = 0 AND type = 'donation' AND amount_rub IS NOT NULL AND ts >= ?
       GROUP BY LOWER(user) ORDER BY rub DESC LIMIT ?`
    ).all(since, limit) as { user: string; rub: number; count: number }[]
  }

  /** Последнее настоящее событие указанного типа. */
  lastEvent(type: string): HubEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE test = 0 AND type = ? ORDER BY ts DESC LIMIT 1').get(type) as Record<string, unknown> | undefined
    if (!r) return null
    return {
      id: String(r.id), ts: Number(r.ts), platform: r.platform as HubEvent['platform'], type: r.type as HubEvent['type'],
      user: String(r.user), text: (r.text as string) ?? undefined, amount: (r.amount as number) ?? undefined,
      currency: (r.currency as string) ?? undefined, amountRub: (r.amount_rub as number) ?? undefined
    }
  }

  close(): void {
    this.db.close()
  }
}
