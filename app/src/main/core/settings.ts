import type { Store } from './db'

/**
 * Все пользовательские настройки Crossember. Ничего не зашито под конкретного стримера:
 * каждый пользователь настраивает своё. Любое входящее значение проходит через sanitize().
 */

export type SetupMode = 'one' | 'two'
export type Theme = 'general' | 'campfire'

export interface ChatOverlaySettings {
  theme: Theme
  fontSize: number
  maxMessages: number
  /** Через сколько секунд сообщение исчезает (0 — не исчезает). */
  hideAfterSec: number
  showBadges: boolean
  showPlatform: boolean
  /** Показывать служебные строки «площадка отключилась / подключилась». */
  showStatus: boolean
}

/** Чат поверх игры: прозрачное окно поверх всех окон, клики проходят насквозь. */
export interface FloatChatSettings extends ChatOverlaySettings {
  enabled: boolean
  /** Непрозрачность подложки сообщений, % (0 — только текст). */
  bgOpacity: number
  bounds: { x: number; y: number; width: number; height: number } | null
}

/** Типы событий, у которых бывают алерты. */
export const ALERT_KINDS = ['donation', 'sub', 'gift', 'follow', 'raid', 'bits', 'reward'] as const
export type AlertKind = (typeof ALERT_KINDS)[number]
/** Встроенные звуки (синтезируются в оверлее, файлов нет) или свой файл custom:<id>. */
export const BUILTIN_SOUNDS = ['none', 'chime', 'coin', 'fire', 'pop', 'fanfare'] as const

/** Вариант алерта по сумме: от суммы «from» — свой заголовок, звук, длительность. */
export interface AlertTier {
  from: number
  kicker: string
  sound: string
  durationSec: number
}

/** Правило алерта для одного типа события (этап 3; с этапа 4 — только для переноса в правила и шаблоны). */
export interface AlertRule {
  enabled: boolean
  /** Минимальная сумма (₽ / биты / зрители рейда); меньше — без алерта, только в ленте. */
  minAmount: number
  /** Верхняя строка («Новый донат»). */
  kicker: string
  /** Главная строка: {user}, {amount}, {platform}. */
  title: string
  showMessage: boolean
  sound: string
  /** Громкость звука, %. */
  volume: number
  durationSec: number
  tiers: AlertTier[]
}

export interface AlertSettings {
  enabled: boolean
  /** Пауза между алертами, сек. */
  gapSec: number
  /** Общая громкость, %. */
  volume: number
  rules: Record<AlertKind, AlertRule>
}

/** Озвучка. engine — задел под Silero / свой голос (Chatterbox). */
export interface TtsSettings {
  engine: 'windows'
  /** Голос Windows; пусто — первый русский. */
  voice: string
  /** Скорость −10…10. */
  rate: number
  /** Громкость, %. */
  volume: number
  /** Сколько символов сообщения читать. */
  maxChars: number
  /** Не читать ссылки. */
  stripLinks: boolean
  /** Слова через запятую, которые не читать (вырезаются вместе со словом). */
  badWords: string
}

export type StatsPeriod = 'stream' | 'today' | 'week' | 'month' | 'all'

export interface AppSettings {
  setupMode: SetupMode | null
  defaultTheme: Theme
  twitch: {
    /** Свой Client ID (необязательно). Пусто — используется общее приложение Crossember. */
    customClientId: string
    thirdPartyEmotes: boolean
    /** От чьего имени пишут автоматические сообщения. */
    autoSendAs: 'broadcaster' | 'bot'
  }
  /** Свой OAuth-клиент Google (режим «Для опытных»); secret хранится зашифрованным отдельно. */
  youtube: { customClientId: string }
  /** Ник канала для площадок, которые читаются без входа. */
  goodgame: { channel: string }
  kick: { channel: string }
  vk: { channel: string }
  /** DonationAlerts: свой ID приложения (необязательно). Пусто — общее приложение Crossember. */
  donationalerts: { customClientId: string }
  /** DonateX: свой client_id OAuth (необязательно). Пусто — общее приложение Crossember. */
  donatex: { customClientId: string }
  /** Boosty: опрос внутреннего API (неофициально, только чтение). */
  boosty: { poll: boolean }
  alerts: AlertSettings
  tts: TtsSettings
  lan: {
    enabled: boolean
    host: string
    port: number
  }
  overlays: {
    alert: { theme: Theme }
    chat: ChatOverlaySettings
    chatH: ChatOverlaySettings
    pinned: { theme: Theme; fontSize: number }
    top: { theme: Theme; period: StatsPeriod; count: number; fontSize: number }
    last: { theme: Theme; fontSize: number; showSub: boolean }
    /** Счётчики: какие показывать (пусто — все), в столбик или в строку. */
    counter: { theme: Theme; fontSize: number; ids: string[]; layout: 'column' | 'row' }
  }
  float: FloatChatSettings
}

const chatDefaults = (horizontal: boolean): ChatOverlaySettings => ({
  theme: 'general',
  fontSize: horizontal ? 22 : 20,
  maxMessages: horizontal ? 12 : 30,
  hideAfterSec: horizontal ? 30 : 0,
  showBadges: true,
  showPlatform: true,
  showStatus: false
})

const rule = (kicker: string, title: string, sound: string, extra: Partial<AlertRule> = {}): AlertRule => ({
  enabled: true, minAmount: 0, kicker, title, showMessage: true, sound, volume: 80, durationSec: 6, tiers: [], ...extra
})

export const ALERT_DEFAULTS: AlertSettings = {
  enabled: true,
  gapSec: 1,
  volume: 80,
  rules: {
    donation: rule('Новый донат', '{user} — {amount}', 'coin', {
      durationSec: 7,
      tiers: [{ from: 1000, kicker: 'Крупный донат!', sound: 'fanfare', durationSec: 10 }]
    }),
    sub: rule('Подписка', '{user}', 'chime'),
    gift: rule('Подарочные подписки', '{user} дарит {amount}', 'fanfare'),
    follow: rule('Новый фолловер', '{user}', 'pop', { durationSec: 4, showMessage: false }),
    raid: rule('Рейд', '{user} — {amount} зрителей', 'fire', { durationSec: 8 }),
    bits: rule('Биты', '{user} — {amount}', 'coin'),
    reward: rule('Награда за баллы', '{user}', 'pop', { enabled: false })
  }
}

export const DEFAULTS: AppSettings = {
  setupMode: null,
  defaultTheme: 'general',
  twitch: { customClientId: '', thirdPartyEmotes: true, autoSendAs: 'broadcaster' },
  youtube: { customClientId: '' },
  goodgame: { channel: '' },
  kick: { channel: '' },
  vk: { channel: '' },
  donationalerts: { customClientId: '' },
  donatex: { customClientId: '' },
  boosty: { poll: false },
  alerts: ALERT_DEFAULTS,
  tts: { engine: 'windows', voice: '', rate: 0, volume: 100, maxChars: 200, stripLinks: true, badWords: '' },
  lan: { enabled: false, host: '', port: 47833 },
  overlays: {
    alert: { theme: 'general' },
    chat: chatDefaults(false),
    chatH: chatDefaults(true),
    pinned: { theme: 'general', fontSize: 34 },
    top: { theme: 'general', period: 'stream', count: 5, fontSize: 24 },
    last: { theme: 'general', fontSize: 26, showSub: true },
    counter: { theme: 'general', fontSize: 30, ids: [], layout: 'column' }
  },
  float: { ...chatDefaults(false), fontSize: 18, maxMessages: 12, hideAfterSec: 45, showStatus: true, enabled: false, bgOpacity: 55, bounds: null }
}

const theme = (v: unknown, d: Theme): Theme => (v === 'general' || v === 'campfire' ? v : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const int = (v: unknown, d: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d
/** Ник канала: обрезаем пробелы, ссылку превращаем в ник, только безопасные символы. */
const nick = (v: unknown, d: string): string => {
  if (typeof v !== 'string') return d
  const t = v.trim().replace(/^https?:\/\/[^/]+\//, '').replace(/[/?#].*$/, '').replace(/^@/, '')
  return /^[A-Za-z0-9_.-]{0,40}$/.test(t) ? t : d
}
/** Client ID Google: вида 123-abc.apps.googleusercontent.com или пусто. */
const ytId = (v: unknown, d: string): string => {
  if (typeof v !== 'string') return d
  const t = v.trim()
  return t === '' || /^[\w-]{1,100}\.apps\.googleusercontent\.com$/.test(t) ? t : d
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

function chat(v: unknown, d: ChatOverlaySettings): ChatOverlaySettings {
  const o = obj(v)
  return {
    theme: theme(o.theme, d.theme),
    fontSize: int(o.fontSize, d.fontSize, 10, 72),
    maxMessages: int(o.maxMessages, d.maxMessages, 1, 100),
    hideAfterSec: int(o.hideAfterSec, d.hideAfterSec, 0, 3600),
    showBadges: bool(o.showBadges, d.showBadges),
    showPlatform: bool(o.showPlatform, d.showPlatform),
    showStatus: bool(o.showStatus, d.showStatus ?? false)
  }
}

const text = (v: unknown, d: string, max = 80): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : d)
const sound = (v: unknown, d: string): string =>
  typeof v === 'string' && ((BUILTIN_SOUNDS as readonly string[]).includes(v) || /^custom:[0-9a-f]{32}\.(mp3|wav|ogg)$/.test(v)) ? v : d
const period = (v: unknown, d: StatsPeriod): StatsPeriod =>
  v === 'stream' || v === 'today' || v === 'week' || v === 'month' || v === 'all' ? v : d
/** Публичный ID приложения: только буквы, цифры, дефис, подчёркивание. */
const appId = (v: unknown, d: string): string => {
  if (typeof v !== 'string') return d
  const t = v.trim()
  return /^[\w-]{0,100}$/.test(t) ? t : d
}

function alertRule(v: unknown, d: AlertRule): AlertRule {
  const o = obj(v)
  const tiers = Array.isArray(o.tiers) ? o.tiers : d.tiers
  return {
    enabled: bool(o.enabled, d.enabled),
    minAmount: int(o.minAmount, d.minAmount, 0, 10_000_000),
    kicker: text(o.kicker, d.kicker, 60),
    title: text(o.title, d.title, 80),
    showMessage: bool(o.showMessage, d.showMessage),
    sound: sound(o.sound, d.sound),
    volume: int(o.volume, d.volume, 0, 100),
    durationSec: int(o.durationSec, d.durationSec, 2, 60),
    tiers: tiers
      .slice(0, 5)
      .map((t) => {
        const x = obj(t)
        return {
          from: int(x.from, 1000, 1, 10_000_000),
          kicker: text(x.kicker, d.kicker, 60),
          sound: sound(x.sound, d.sound),
          durationSec: int(x.durationSec, d.durationSec, 2, 60)
        }
      })
      .sort((a, b) => a.from - b.from)
  }
}

function alerts(v: unknown, d: AlertSettings): AlertSettings {
  const o = obj(v)
  const r = obj(o.rules)
  const rules = {} as Record<AlertKind, AlertRule>
  for (const k of ALERT_KINDS) rules[k] = alertRule(r[k], d.rules?.[k] ?? ALERT_DEFAULTS.rules[k])
  return { enabled: bool(o.enabled, d.enabled), gapSec: int(o.gapSec, d.gapSec, 0, 30), volume: int(o.volume, d.volume, 0, 100), rules }
}

function float(v: unknown, d: FloatChatSettings): FloatChatSettings {
  const o = obj(v)
  const b = o.bounds === null ? null : obj(o.bounds)
  const bounds =
    b && Object.keys(b).length
      ? { x: int(b.x, 100, -10000, 10000), y: int(b.y, 100, -10000, 10000), width: int(b.width, 380, 200, 4000), height: int(b.height, 520, 120, 4000) }
      : o.bounds === null ? null : d.bounds
  return { ...chat(o, d), enabled: bool(o.enabled, d.enabled), bgOpacity: int(o.bgOpacity, d.bgOpacity, 0, 100), bounds }
}

/** Привести произвольный объект к корректным настройкам (неизвестные поля отбрасываются). */
export function sanitize(input: unknown, base: AppSettings = DEFAULTS): AppSettings {
  const i = obj(input)
  const tw = obj(i.twitch)
  const lan = obj(i.lan)
  const ov = obj(i.overlays)
  const clientId = typeof tw.customClientId === 'string' ? tw.customClientId.trim() : base.twitch.customClientId
  const host = typeof lan.host === 'string' ? lan.host.trim() : base.lan.host
  return {
    setupMode: i.setupMode === 'one' || i.setupMode === 'two' ? i.setupMode : i.setupMode === null ? null : base.setupMode,
    defaultTheme: theme(i.defaultTheme, base.defaultTheme),
    twitch: {
      customClientId: /^[a-z0-9]{0,64}$/.test(clientId) ? clientId : base.twitch.customClientId,
      thirdPartyEmotes: bool(tw.thirdPartyEmotes, base.twitch.thirdPartyEmotes),
      autoSendAs: tw.autoSendAs === 'bot' || tw.autoSendAs === 'broadcaster' ? tw.autoSendAs : base.twitch.autoSendAs
    },
    youtube: { customClientId: ytId(obj(i.youtube).customClientId, base.youtube?.customClientId ?? '') },
    goodgame: { channel: nick(obj(i.goodgame).channel, base.goodgame?.channel ?? '') },
    kick: { channel: nick(obj(i.kick).channel, base.kick?.channel ?? '') },
    vk: { channel: nick(obj(i.vk).channel, base.vk?.channel ?? '') },
    donationalerts: { customClientId: appId(obj(i.donationalerts).customClientId, base.donationalerts?.customClientId ?? '') },
    donatex: { customClientId: appId(obj(i.donatex).customClientId, base.donatex?.customClientId ?? '') },
    boosty: { poll: bool(obj(i.boosty).poll, base.boosty?.poll ?? false) },
    alerts: alerts(i.alerts, base.alerts ?? ALERT_DEFAULTS),
    tts: (() => {
      const o = obj(i.tts)
      const b = base.tts ?? DEFAULTS.tts
      return {
        engine: 'windows' as const,
        voice: text(o.voice, b.voice, 100),
        rate: int(o.rate, b.rate, -10, 10),
        volume: int(o.volume, b.volume, 0, 100),
        maxChars: int(o.maxChars, b.maxChars, 20, 500),
        stripLinks: bool(o.stripLinks, b.stripLinks),
        badWords: text(o.badWords, b.badWords, 2000)
      }
    })(),
    lan: {
      enabled: bool(lan.enabled, base.lan.enabled),
      host: host === '' || /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? host : base.lan.host,
      port: int(lan.port, base.lan.port, 1024, 65535)
    },
    overlays: {
      alert: { theme: theme(obj(ov.alert).theme, base.overlays.alert.theme) },
      chat: chat(ov.chat, base.overlays.chat),
      chatH: chat(ov.chatH, base.overlays.chatH),
      pinned: {
        theme: theme(obj(ov.pinned).theme, base.overlays.pinned.theme),
        fontSize: int(obj(ov.pinned).fontSize, base.overlays.pinned.fontSize, 12, 96)
      },
      top: (() => {
        const o = obj(ov.top)
        const b = base.overlays.top ?? DEFAULTS.overlays.top
        return { theme: theme(o.theme, b.theme), period: period(o.period, b.period), count: int(o.count, b.count, 1, 20), fontSize: int(o.fontSize, b.fontSize, 12, 72) }
      })(),
      last: (() => {
        const o = obj(ov.last)
        const b = base.overlays.last ?? DEFAULTS.overlays.last
        return { theme: theme(o.theme, b.theme), fontSize: int(o.fontSize, b.fontSize, 12, 72), showSub: bool(o.showSub, b.showSub) }
      })(),
      counter: (() => {
        const o = obj(ov.counter)
        const b = base.overlays.counter ?? DEFAULTS.overlays.counter
        const ids = Array.isArray(o.ids) ? o.ids.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,40}$/.test(x)).slice(0, 50) : b.ids
        return { theme: theme(o.theme, b.theme), fontSize: int(o.fontSize, b.fontSize, 12, 96), ids, layout: o.layout === 'row' || o.layout === 'column' ? o.layout : b.layout }
      })()
    },
    float: float(i.float, base.float ?? DEFAULTS.float)
  }
}

/** Глубокое слияние частичного патча с текущими настройками. */
function merge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a
  const ao = obj(a)
  const bo = obj(b)
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return b
  const out: Record<string, unknown> = { ...ao }
  for (const k of Object.keys(bo)) out[k] = merge(ao[k], bo[k])
  return out
}

export class Settings {
  private value: AppSettings
  onChange: (s: AppSettings) => void = () => undefined

  constructor(private store: Store) {
    this.value = sanitize(store.get('settings', {}), DEFAULTS)
  }

  get(): AppSettings {
    return this.value
  }

  /** Заменить настройки целиком (загрузка профиля); недостающее берётся из текущих. */
  replaceAll(v: unknown): AppSettings {
    this.value = sanitize(v, this.value)
    this.store.set('settings', this.value)
    this.onChange(this.value)
    return this.value
  }

  patch(p: unknown): AppSettings {
    this.value = sanitize(merge(this.value, p), this.value)
    this.store.set('settings', this.value)
    this.onChange(this.value)
    return this.value
  }
}
