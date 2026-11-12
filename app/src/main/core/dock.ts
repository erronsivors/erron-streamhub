import type { Platform } from './types'
import type { AlertQueueState } from './alerts'
import type { AuctionState } from './auction'
import type { GoalOverlayView } from './goal'
import type { GiveawayState, GiveawayOverlayView } from './giveaway'
import type { WheelState, WheelOverlayView } from './wheel'
import type { Counter } from './counters'
import type { VoteState, PollView } from './vote'

/**
 * Док для OBS (Docks → Custom Browser Docks) и пульт второго ПК — одна страница из блоков.
 * Какие блоки показывать, выбирает сам стример (готовые наборы или галочки).
 */

export const DOCK_BLOCKS = ['chat', 'events', 'alerts', 'auction', 'vote', 'goal', 'giveaway', 'wheel', 'counters'] as const
export type DockBlock = (typeof DOCK_BLOCKS)[number]

export const DOCK_PRESETS: Record<'operator' | 'buttons' | 'chat', DockBlock[]> = {
  operator: [...DOCK_BLOCKS],
  buttons: ['alerts', 'auction', 'vote', 'goal', 'giveaway', 'wheel', 'counters'],
  chat: ['chat', 'events', 'alerts']
}

/** Блоки без управления — их видно на втором ПК, даже если кнопки там выключены. */
export const READONLY_BLOCKS: DockBlock[] = ['chat', 'events']

/** Список блоков из настроек или ссылки: только известные, без повторов, в постоянном порядке. */
export function sanitizeBlocks(v: unknown, fallback: DockBlock[]): DockBlock[] {
  const raw = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null
  if (!raw) return fallback.slice()
  const set = new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()))
  return DOCK_BLOCKS.filter((b) => set.has(b))
}

export interface DockSources {
  alerts: { state(): AlertQueueState }
  auction: { state(): AuctionState }
  goal: { overlay(): GoalOverlayView | null }
  giveaway: { state(): GiveawayState; overlay(): GiveawayOverlayView }
  wheel: { state(): WheelState; overlay(): WheelOverlayView }
  counters: { list(): Counter[] }
  vote: { state(): VoteState }
}

interface AlertRow { id: string; summary: string; platform: Platform; test: boolean }

/** Что видит док: только то, что нужно для кнопок, без истории и архивов. */
export interface DockView {
  now: number
  alerts: { enabled: boolean; paused: boolean; current: AlertRow | null; queue: AlertRow[]; queued: number }
  auction: {
    accepting: boolean
    timeUp: boolean
    timer: AuctionState['timer']
    total: number
    lots: { num: number; name: string; rub: number }[]
    lotCount: number
    pending: number
    winner: { name: string; rub: number } | null
  }
  goal: { title: string; target: number; collected: number; accepting: boolean; timeUp: boolean; endsAt: number | null; last: { user: string; rub: number } | null } | null
  giveaway: {
    prize: string
    keyword: string
    open: boolean
    endsAt: number | null
    timeUp: boolean
    count: number
    tickets: number
    revealing: boolean
    winners: { key: string; user: string; answered: boolean; deadline: number }[]
  }
  wheel: { items: number; left: number; spinning: boolean; result: { kind: 'win' | 'out'; name: string } | null; winner: string | null; fromAuction: boolean }
  counters: { id: string; name: string; value: number }[]
  vote: { quick: DockPoll | null; long: DockPoll | null; showUntil: number | null }
}

interface DockPoll {
  source: 'own' | 'twitch'
  title: string
  open: boolean
  timeUp: boolean
  endsAt: number | null
  total: number
  pending: number
  top: { num: number; name: string; votes: number }[]
  result: string | null
}

const dockPoll = (p: PollView | null): DockPoll | null => p && {
  source: p.source, title: p.title, open: p.open, timeUp: p.timeUp, endsAt: p.timer.endsAt, total: p.total, pending: p.pending.length,
  top: p.ranked.slice(0, 3).map((o) => ({ num: o.num, name: o.name, votes: o.votes })), result: p.result?.name ?? null
}

const row = (a: AlertQueueState['queue'][number]): AlertRow => ({ id: a.id, summary: a.summary, platform: a.platform, test: a.test })

export function dockView(src: DockSources): DockView {
  const now = Date.now()
  const al = src.alerts.state()
  const auc = src.auction.state()
  const goal = src.goal.overlay()
  const gw = src.giveaway.state()
  const gwo = src.giveaway.overlay()
  const wh = src.wheel.state()
  const who = src.wheel.overlay()
  return {
    now,
    alerts: { enabled: al.enabled, paused: al.paused, current: al.current ? row(al.current) : null, queue: al.queue.slice(0, 8).map(row), queued: al.queue.length },
    auction: {
      accepting: auc.accepting, timeUp: auc.timeUp, timer: auc.timer, total: auc.total,
      lots: auc.lots.slice(0, 5).map((l) => ({ num: l.num, name: l.name, rub: l.rub })),
      lotCount: auc.lots.length,
      pending: auc.bets.filter((b) => b.status === 'pending').length,
      winner: auc.winner ? { name: auc.winner.name, rub: auc.winner.rub } : null
    },
    goal: goal && {
      title: goal.title, target: goal.target, collected: goal.collected, accepting: goal.accepting,
      timeUp: goal.timeUp, endsAt: goal.endsAt, last: goal.last
    },
    giveaway: {
      prize: gw.prize, keyword: gwo.keyword, open: gw.open, endsAt: gw.endsAt, timeUp: gw.timeUp,
      count: gwo.count, tickets: gw.tickets, revealing: !!gw.reveal,
      winners: gw.reveal ? [] : gw.winners.filter((w) => !w.skipped).map((w) => ({ key: w.key, user: w.user, answered: w.answered, deadline: w.deadline }))
    },
    wheel: {
      items: wh.items.length, left: who.left, spinning: !!wh.spin && now < wh.spin.startedAt + wh.spin.durationMs,
      result: wh.result ? { kind: wh.result.kind, name: wh.result.name } : null,
      winner: wh.winner?.name ?? null, fromAuction: wh.fromAuction
    },
    counters: src.counters.list().map((c) => ({ id: c.id, name: c.name, value: c.value })),
    vote: (() => { const v = src.vote.state(); return { quick: dockPoll(v.quick), long: dockPoll(v.long), showUntil: v.showUntil } })()
  }
}

/** Команда дока: имя действия и до трёх простых аргументов. Остальное отбрасывается. */
export type DockActionTable = Record<string, (...args: (string | number | boolean | null)[]) => unknown>

export function parseAction(raw: unknown, table: DockActionTable): { name: string; args: (string | number | boolean | null)[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as { kind?: unknown; a?: unknown; args?: unknown }
  if (m.kind !== 'act' || typeof m.a !== 'string' || !Object.prototype.hasOwnProperty.call(table, m.a)) return null
  const list = m.args === undefined ? [] : m.args
  if (!Array.isArray(list) || list.length > 3) return null
  const args: (string | number | boolean | null)[] = []
  for (const x of list) {
    if (x === null || typeof x === 'boolean') args.push(x)
    else if (typeof x === 'number' && Number.isFinite(x)) args.push(x)
    else if (typeof x === 'string' && x.length <= 200) args.push(x)
    else return null
  }
  return { name: m.a, args }
}

/** Выполнить команду; ошибку модуля вернуть текстом (покажется в доке). */
export async function runAction(table: DockActionTable, name: string, args: (string | number | boolean | null)[]): Promise<string | null> {
  try {
    await table[name](...args)
    return null
  } catch (e) {
    return (e as Error).message || 'Не получилось'
  }
}
