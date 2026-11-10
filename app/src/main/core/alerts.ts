import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Hub } from './hub'
import type { Settings, AlertKind } from './settings'
import { ALERT_KINDS } from './settings'
import type { HubEvent, Platform } from './types'

/** Кусок заголовка алерта: обычный текст или сумма (выделяется цветом). */
export type AlertTitlePart = { t: 'text' | 'amount'; v: string }

/** Готовый к показу алерт. Весь текст — простой текст, оверлей выводит его через textContent. */
export interface AlertItem {
  id: string
  eventId: string
  kind: AlertKind
  platform: Platform
  user: string
  kicker: string
  title: AlertTitlePart[]
  text: string | null
  /** builtin — встроенный звук оверлея; url — свой файл с сервера Crossember. */
  sound: { builtin: string } | { url: string } | null
  /** 0…1 с учётом общей громкости. */
  volume: number
  durationMs: number
  test: boolean
  replay: boolean
}

export interface AlertQueueState {
  enabled: boolean
  paused: boolean
  current: AlertItem | null
  queue: AlertItem[]
}

export const PLATFORM_NAMES: Record<Platform, string> = {
  twitch: 'Twitch', youtube: 'YouTube', vk: 'VK Видео Live', kick: 'Kick', goodgame: 'GoodGame',
  donationalerts: 'DonationAlerts', donatepay: 'DonatePay', donatex: 'DonateX', boosty: 'Boosty', obs: 'OBS', hub: 'Crossember'
}

const QUEUE_LIMIT = 100
const CURRENCY: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€', UAH: '₴', KZT: '₸', BYN: 'Br' }

function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}

export function money(amount: number, currency?: string): string {
  const sym = CURRENCY[currency ?? 'RUB'] ?? currency ?? ''
  return `${amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${sym}`.trim()
}

function amountText(e: HubEvent, kind: AlertKind): string {
  const n = e.amount ?? 0
  switch (kind) {
    case 'donation': return money(n, e.currency)
    case 'bits': return `${n} ${plural(n, 'бит', 'бита', 'бит')}`
    case 'gift': return `${n} ${plural(n, 'подписку', 'подписки', 'подписок')}`
    default: return n ? String(n) : ''
  }
}

/**
 * Движок алертов: одна очередь на всё приложение. Оверлеи только показывают то, что пришло
 * (поэтому все открытые копии оверлея синхронны, а пауза/пропуск работают из интерфейса).
 * События: 'play' (AlertItem), 'end' (id), 'change'.
 */
export class AlertEngine extends EventEmitter {
  private queue: AlertItem[] = []
  private current: AlertItem | null = null
  private paused = false
  private playTimer: NodeJS.Timeout | null = null
  private gapTimer: NodeJS.Timeout | null = null

  constructor(private hub: Hub, private settings: Settings) {
    super()
    hub.on('event', (e: HubEvent) => {
      const a = this.build(e, false)
      if (a) this.enqueue(a)
    })
  }

  state(): AlertQueueState {
    return { enabled: this.settings.get().alerts.enabled, paused: this.paused, current: this.current, queue: this.queue.slice(0, 30) }
  }

  /** Собрать алерт по событию. force — повтор вручную: игнорирует выключатели и минимальную сумму. */
  build(e: HubEvent, force: boolean): AlertItem | null {
    if (!(ALERT_KINDS as readonly string[]).includes(e.type)) return null
    const kind = e.type as AlertKind
    const s = this.settings.get().alerts
    const rule = s.rules[kind]
    if (!force && (!s.enabled || !rule.enabled)) return null
    const value = kind === 'donation' ? (e.amountRub ?? (e.currency === 'RUB' ? e.amount : undefined) ?? e.amount ?? 0) : (e.amount ?? 0)
    if (!force && rule.minAmount > 0 && value < rule.minAmount) return null
    const tier = kind === 'donation' || kind === 'bits' || kind === 'raid' || kind === 'gift'
      ? [...rule.tiers].reverse().find((t) => value >= t.from)
      : undefined

    const amount = amountText(e, kind)
    const title: AlertTitlePart[] = []
    for (const piece of rule.title.split(/(\{user\}|\{amount\}|\{platform\})/)) {
      if (!piece) continue
      if (piece === '{user}') title.push({ t: 'text', v: e.user })
      else if (piece === '{amount}') { if (amount) title.push({ t: 'amount', v: amount }) }
      else if (piece === '{platform}') title.push({ t: 'text', v: PLATFORM_NAMES[e.platform] })
      else title.push({ t: 'text', v: piece })
    }
    const text = rule.showMessage && e.text ? e.text : null
    const soundId = tier?.sound ?? rule.sound
    const sound = soundId === 'none' ? null : soundId.startsWith('custom:') ? { url: `/s/${soundId.slice(7)}` } : { builtin: soundId }
    const base = (tier?.durationSec ?? rule.durationSec) * 1000
    return {
      id: randomUUID(),
      eventId: e.id,
      kind,
      platform: e.platform,
      user: e.user,
      kicker: tier?.kicker ?? rule.kicker,
      title,
      text,
      sound,
      volume: Math.round(rule.volume * s.volume) / 10000,
      durationMs: base + (text ? Math.min(text.length * 40, 5000) : 0),
      test: !!e.test,
      replay: force
    }
  }

  private enqueue(a: AlertItem): void {
    this.queue.push(a)
    if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT)
    this.emit('change')
    this.next()
  }

  private next(): void {
    if (this.current || this.paused || this.gapTimer || !this.queue.length) return
    const a = this.queue.shift()!
    this.current = a
    this.emit('play', a)
    this.emit('change')
    // +700 мс — анимация появления/исчезновения.
    this.playTimer = setTimeout(() => this.finish(), a.durationMs + 700)
  }

  private finish(): void {
    if (this.playTimer) clearTimeout(this.playTimer)
    this.playTimer = null
    if (!this.current) return
    this.emit('end', this.current.id)
    this.current = null
    this.emit('change')
    const gap = this.settings.get().alerts.gapSec * 1000 + 400
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null
      this.next()
    }, gap)
  }

  /** Повторить алерт события из ленты. */
  replay(eventId: string): boolean {
    const e = this.hub.recent().find((x) => x.id === eventId)
    const a = e ? this.build(e, true) : null
    if (a) this.enqueue(a)
    return !!a
  }

  skip(): void {
    this.finish()
  }

  /** Убрать один алерт из очереди. */
  remove(id: string): void {
    this.queue = this.queue.filter((a) => a.id !== id)
    this.emit('change')
  }

  /** «Стоп всё»: очистить очередь и убрать текущий. */
  stopAll(): void {
    this.queue = []
    this.finish()
  }

  setPaused(v: boolean): void {
    this.paused = v
    this.emit('change')
    if (!v) this.next()
  }

  dispose(): void {
    if (this.playTimer) clearTimeout(this.playTimer)
    if (this.gapTimer) clearTimeout(this.gapTimer)
  }
}
