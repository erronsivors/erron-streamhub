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

export const DEFAULTS: AppSettings = {
  setupMode: null,
  defaultTheme: 'general',
  twitch: { customClientId: '', thirdPartyEmotes: true, autoSendAs: 'broadcaster' },
  lan: { enabled: false, host: '', port: 47833 },
  overlays: {
    alert: { theme: 'general' },
    chat: chatDefaults(false),
    chatH: chatDefaults(true),
    pinned: { theme: 'general', fontSize: 34 }
  },
  float: { ...chatDefaults(false), fontSize: 18, maxMessages: 12, hideAfterSec: 45, showStatus: true, enabled: false, bgOpacity: 55, bounds: null }
}

const theme = (v: unknown, d: Theme): Theme => (v === 'general' || v === 'campfire' ? v : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const int = (v: unknown, d: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d
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
      }
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

  patch(p: unknown): AppSettings {
    this.value = sanitize(merge(this.value, p), this.value)
    this.store.set('settings', this.value)
    this.onChange(this.value)
    return this.value
  }
}
