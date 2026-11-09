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
    this.db.prepare('INSERT OR IGNORE INTO events(id, ts, platform, type, user, text, amount, currency, test) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(e.id, e.ts, e.platform, e.type, e.user, e.text ?? null, e.amount ?? null, e.currency ?? null, e.test ? 1 : 0)
  }

  recentEvents(limit = 100): HubEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE type != ? ORDER BY ts DESC LIMIT ?').all('message', limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id), ts: Number(r.ts), platform: r.platform as HubEvent['platform'], type: r.type as HubEvent['type'],
      user: String(r.user), text: (r.text as string) ?? undefined, amount: (r.amount as number) ?? undefined,
      currency: (r.currency as string) ?? undefined, test: r.test === 1
    }))
  }

  close(): void {
    this.db.close()
  }
}
