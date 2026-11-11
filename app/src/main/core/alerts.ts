import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Hub } from './hub'
import type { Settings, Theme } from './settings'
import type { HubEvent, Platform } from './types'
import type { AlertTemplate, Layer, ObsAction } from './templates'
import type { RulePlan } from './rules'
import { cleanForSpeech, type WindowsTts } from './tts'
import { moneyWords, numberWords, numbersToWords, plural } from './ruwords'

/** Кусок текста: обычный текст или сумма (выделяется цветом). */
export type AlertTitlePart = { t: 'text' | 'amount'; v: string }

/** Слой, готовый к показу: подстановки сделаны, файлы превращены в ссылки нашего сервера. Весь текст — простой текст. */
export interface AlertLayerOut extends Layer {
  /** text / card: главная строка по кусочкам. */
  parts?: AlertTitlePart[]
  /** card: верхняя строка. */
  kickerText?: string
  /** card: сообщение зрителя. */
  message?: string | null
  /** image / video: /m/<файл>; tts: /t/<файл>; sound (свой файл): /s/<файл>. */
  src?: string
  /** sound: встроенный звук оверлея. */
  builtin?: string
  /** Итоговая громкость 0…1. */
  vol?: number
}

/** Готовый к показу алерт. */
export interface AlertItem {
  id: string
  eventId: string
  kind: string
  platform: Platform
  user: string
  /** Краткое описание для очереди в интерфейсе. */
  summary: string
  theme: 'auto' | Theme
  durationMs: number
  layers: AlertLayerOut[]
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
export { plural }

export function money(amount: number, currency?: string): string {
  const sym = CURRENCY[currency ?? 'RUB'] ?? currency ?? ''
  return `${amount.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${sym}`.trim()
}

/** Сумма события словами для экрана ({amount}). */
function amountText(e: HubEvent): string {
  const n = e.amount ?? 0
  switch (e.type) {
    case 'donation': return n ? money(n, e.currency) : ''
    case 'bits': return `${n} ${plural(n, 'бит', 'бита', 'бит')}`
    case 'gift': return `${n} ${plural(n, 'подписку', 'подписки', 'подписок')}`
    default: return n ? String(n) : ''
  }
}

/** Сумма для озвучки — словами: «пятьсот рублей», «одну подписку». */
function amountSpoken(e: HubEvent): string {
  const n = e.amount ?? 0
  if (!n) return amountText(e)
  switch (e.type) {
    case 'donation': return moneyWords(n, e.currency ?? 'RUB')
    case 'bits': return `${numberWords(n)} ${plural(n, 'бит', 'бита', 'бит')}`
    case 'gift': return `${n % 10 === 1 && n % 100 !== 11 ? numberWords(n, 'f').replace(/одна$/, 'одну') : numberWords(n, 'f')} ${plural(n, 'подписку', 'подписки', 'подписок')}`
    default: return numberWords(n)
  }
}

const PLACEHOLDER = /(\{user\}|\{amount\}|\{message\}|\{platform\})/

/** Подставить {user} {amount} {message} {platform} в простой текст. */
export function fill(tpl: string, e: HubEvent, message = e.text ?? '', amount = amountText(e)): string {
  return tpl.split(PLACEHOLDER).map((p) =>
    p === '{user}' ? e.user : p === '{amount}' ? amount : p === '{message}' ? message : p === '{platform}' ? PLATFORM_NAMES[e.platform] : p
  ).join('').trim()
}

/** То же, но по кусочкам — сумма отдельным куском (выделяется в оверлее). */
function parts(tpl: string, e: HubEvent): AlertTitlePart[] {
  const out: AlertTitlePart[] = []
  const amount = amountText(e)
  for (const p of tpl.split(PLACEHOLDER)) {
    if (!p) continue
    if (p === '{user}') out.push({ t: 'text', v: e.user })
    else if (p === '{amount}') { if (amount) out.push({ t: 'amount', v: amount }) }
    else if (p === '{message}') { if (e.text) out.push({ t: 'text', v: e.text }) }
    else if (p === '{platform}') out.push({ t: 'text', v: PLATFORM_NAMES[e.platform] })
    else out.push({ t: 'text', v: p })
  }
  return out
}

interface Entry {
  item: AlertItem
  /** Ждёт озвучку: показывать, только когда готово. */
  ready: boolean
  event: HubEvent
}

/**
 * Движок алертов: одна очередь на всё приложение. Что показывать, решают правила (rules.ts),
 * оверлеи только показывают то, что пришло (все открытые копии синхронны, пауза/пропуск — из интерфейса).
 * Действия OBS из слоёв шаблона выполняет ядро в нужный момент таймлайна.
 * События: 'play' (AlertItem), 'end' (id), 'change'.
 */
export class AlertEngine extends EventEmitter {
  private queue: Entry[] = []
  private current: Entry | null = null
  /** Когда начался текущий алерт (для оверлея, подключившегося посреди показа). */
  private startedAt = 0
  private paused = false
  private playTimer: NodeJS.Timeout | null = null
  private gapTimer: NodeJS.Timeout | null = null
  private obsTimers: NodeJS.Timeout[] = []

  constructor(
    private hub: Hub,
    private settings: Settings,
    private tts: WindowsTts,
    private runObs: (a: ObsAction, e: HubEvent) => Promise<void>
  ) {
    super()
  }

  state(): AlertQueueState {
    return {
      enabled: this.settings.get().alerts.enabled,
      paused: this.paused,
      current: this.current?.item ?? null,
      queue: this.queue.slice(0, 30).map((q) => q.item)
    }
  }

  /** Что показывается сейчас и с какого момента. */
  nowPlaying(): { item: AlertItem; at: number } | null {
    return this.current ? { item: this.current.item, at: this.startedAt } : null
  }

  /** Исполнитель правил: первый шаблон получает озвучку и звуки правил, без шаблона они играют отдельно. */
  play(plan: RulePlan, e: HubEvent, force: boolean): void {
    if (!force && !this.settings.get().alerts.enabled) return
    if (!plan.templates.length) {
      this.enqueue({ id: 'extras', name: 'Озвучка', theme: 'auto', durationMs: 1500, extendByMessage: false, layers: [] }, e, force, plan.extras)
      return
    }
    plan.templates.forEach((t, i) => this.enqueue(t, e, force, i === 0 ? plan.extras : []))
  }

  /** Собрать алерт из шаблона и поставить в очередь. */
  enqueue(t: AlertTemplate, e: HubEvent, force: boolean, extras: Layer[] = []): void {
    const s = this.settings.get()
    const master = s.alerts.volume / 100
    const layers: AlertLayerOut[] = []
    for (const l of [...t.layers, ...extras]) {
      if (l.hidden) continue
      const out: AlertLayerOut = { ...l, keyframes: l.keyframes.map((k) => ({ ...k })) }
      if (l.type === 'card') {
        out.parts = parts(l.text, e)
        out.kickerText = fill(l.kicker, e)
        out.message = l.showMessage && e.text ? e.text : null
      } else if (l.type === 'text') {
        out.parts = parts(l.text, e)
      } else if (l.type === 'image' || l.type === 'video') {
        if (!l.media) continue
        out.src = `/m/${l.media.slice(2)}`
        out.vol = (l.volume / 100) * master
      } else if (l.type === 'sound') {
        if (l.sound === 'none') continue
        if (l.sound.startsWith('custom:')) out.src = `/s/${l.sound.slice(7)}`
        else out.builtin = l.sound
        out.vol = (l.volume / 100) * master
      } else if (l.type === 'tts') {
        out.vol = (l.volume / 100) * (s.tts.volume / 100) * master
      }
      layers.push(out)
    }
    const extra = t.extendByMessage && e.text ? Math.min(e.text.length * 40, 5000) : 0
    const item: AlertItem = {
      id: randomUUID(),
      eventId: e.id,
      kind: e.type,
      platform: e.platform,
      user: e.user,
      summary: `${t.name}: ${e.user}${amountText(e) ? ` — ${amountText(e)}` : ''}`,
      theme: t.theme,
      durationMs: t.durationMs + extra,
      layers,
      test: !!e.test,
      replay: force
    }
    const entry: Entry = { item, ready: true, event: e }
    const tts = layers.filter((l) => l.type === 'tts')
    if (tts.length) {
      entry.ready = false
      void this.prepareTts(entry, tts).finally(() => {
        entry.ready = true
        this.next()
      })
    }
    this.queue.push(entry)
    if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT)
    this.emit('change')
    this.next()
  }

  /** Озвучить tts-слои; алерт удлиняется, если голос не успевает договорить. */
  private async prepareTts(entry: Entry, layers: AlertLayerOut[]): Promise<void> {
    const s = this.settings.get().tts
    const e = entry.event
    for (const l of layers) {
      try {
        const msg = cleanForSpeech(e.text ?? '', { stripLinks: s.stripLinks, badWords: s.badWords, maxChars: s.maxChars })
        // Все числа — словами (сумма уже словами в нужном роде): «лови 300» → «лови триста».
        const text = cleanForSpeech(numbersToWords(fill(l.text, { ...e, user: cleanForSpeech(e.user, { stripLinks: false, badWords: s.badWords, maxChars: 40 }) }, msg, amountSpoken(e))),
          { stripLinks: false, badWords: '', maxChars: 800 })
        if (!text) throw new Error('нечего читать')
        const r = await this.tts.synth(text, l.voice || s.voice, l.rate || s.rate)
        l.src = `/t/${r.file}`
        entry.item.durationMs = Math.max(entry.item.durationMs, l.start + r.durationMs + 500)
      } catch (err) {
        entry.item.layers = entry.item.layers.filter((x) => x !== l)
        if ((err as Error).message !== 'нечего читать') this.hub.log('hub', 'warn', `Озвучка не получилась: ${(err as Error).message}`)
      }
    }
  }

  private next(): void {
    if (this.current || this.paused || this.gapTimer || !this.queue.length) return
    if (!this.queue[0].ready) return
    const entry = this.queue.shift()!
    this.current = entry
    this.startedAt = Date.now()
    this.emit('play', entry.item)
    this.emit('change')
    for (const l of entry.item.layers) {
      if (l.type !== 'obs') continue
      this.obsTimers.push(setTimeout(() => {
        this.runObs(l.obs, entry.event).catch((err) => this.hub.log('obs', 'warn', `Алерт не выполнил действие OBS: ${(err as Error).message}`))
      }, l.start))
    }
    // +700 мс — запас на анимацию исчезновения.
    this.playTimer = setTimeout(() => this.finish(), entry.item.durationMs + 700)
  }

  private finish(): void {
    if (this.playTimer) clearTimeout(this.playTimer)
    this.playTimer = null
    for (const t of this.obsTimers) clearTimeout(t)
    this.obsTimers = []
    if (!this.current) return
    this.emit('end', this.current.item.id)
    this.current = null
    this.emit('change')
    const gap = this.settings.get().alerts.gapSec * 1000 + 400
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null
      this.next()
    }, gap)
  }

  skip(): void {
    this.finish()
  }

  /** Убрать один алерт из очереди. */
  remove(id: string): void {
    this.queue = this.queue.filter((a) => a.item.id !== id)
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
    for (const t of this.obsTimers) clearTimeout(t)
  }
}
