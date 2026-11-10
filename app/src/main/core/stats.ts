import type { Store } from './db'
import type { StatsPeriod } from './settings'
import type { HubEvent, Platform } from './types'

export interface StatsSnapshot {
  period: StatsPeriod
  since: number
  /** Для периода «эфир»: эфир не идёт — показываем «сегодня». */
  streamFallback: boolean
  donations: { count: number; rub: number }
  byPlatform: { platform: Platform; count: number; rub: number }[]
  counts: Partial<Record<HubEvent['type'], number>>
  top: { user: string; rub: number; count: number }[]
}

/** Данные для оверлеев «Топ донатеров» и «Последний донат». */
export interface OverlayStats {
  top: { user: string; rub: number }[]
  lastDonation: HubEvent | null
  lastSub: HubEvent | null
}

/** Статистика и топы по событиям из локальной базы. Тестовые события не считаются. */
export class Stats {
  constructor(private store: Store, private streamStartedAt: () => number | null) {}

  since(period: StatsPeriod): { since: number; fallback: boolean } {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    switch (period) {
      case 'stream': {
        const s = this.streamStartedAt()
        return s ? { since: s, fallback: false } : { since: today, fallback: true }
      }
      case 'today': return { since: today, fallback: false }
      case 'week': return { since: Date.now() - 7 * 86400_000, fallback: false }
      case 'month': return { since: Date.now() - 30 * 86400_000, fallback: false }
      default: return { since: 0, fallback: false }
    }
  }

  snapshot(period: StatsPeriod, topCount = 10): StatsSnapshot {
    const { since, fallback } = this.since(period)
    const rows = this.store.totals(since)
    const counts: StatsSnapshot['counts'] = {}
    const byPlatform: StatsSnapshot['byPlatform'] = []
    let count = 0
    let rub = 0
    for (const r of rows) {
      const t = r.type as HubEvent['type']
      counts[t] = (counts[t] ?? 0) + r.count
      if (t === 'donation') {
        count += r.count
        rub += r.rub
        byPlatform.push({ platform: r.platform as Platform, count: r.count, rub: r.rub })
      }
    }
    byPlatform.sort((a, b) => b.rub - a.rub)
    return { period, since, streamFallback: fallback, donations: { count, rub }, byPlatform, counts, top: this.store.topDonors(since, topCount) }
  }

  overlay(period: StatsPeriod, count: number): OverlayStats {
    return {
      top: this.store.topDonors(this.since(period).since, count).map((t) => ({ user: t.user, rub: t.rub })),
      lastDonation: this.store.lastEvent('donation'),
      lastSub: this.store.lastEvent('sub')
    }
  }
}
