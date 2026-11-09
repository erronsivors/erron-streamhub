// Общие типы ядра. Те же типы использует интерфейс (через preload).
import type { AppSettings } from './settings'

export type Platform = 'twitch' | 'youtube' | 'vk' | 'kick' | 'donationalerts' | 'donatepay' | 'donatex' | 'boosty' | 'obs' | 'hub'

export type HubEventType = 'message' | 'donation' | 'follow' | 'sub' | 'gift' | 'raid' | 'bits' | 'reward' | 'system'

/** Кусок сообщения: текст или смайл. URL смайлов собираются ядром только из проверенных ID. */
export type MsgPart = { t: 'text'; v: string } | { t: 'emote'; v: string; url: string }

export interface Badge {
  title: string
  url: string
}

/** Единое событие хаба: чат, донат, подписка и т.д. со всех площадок. */
export interface HubEvent {
  id: string
  ts: number
  platform: Platform
  type: HubEventType
  user: string
  userId?: string
  text?: string
  parts?: MsgPart[]
  badges?: Badge[]
  color?: string
  amount?: number
  currency?: string
  /** Тестовое событие: показывается в оверлеях, но не идёт в статистику. */
  test?: boolean
}

export type ConnState = 'off' | 'connecting' | 'ok' | 'error'

export interface ConnLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface ConnStatus {
  id: Platform
  name: string
  state: ConnState
  detail: string
  since: number
  log: ConnLogEntry[]
}

export interface ObsState {
  connected: boolean
  scene: string | null
  streaming: boolean
  streamStartedAt: number | null
  recording: boolean
  resolution: string | null
  fps: number | null
}

export interface OverlayInfo {
  id: string
  name: string
  url: string
  size: string
}

export interface ServerInfo {
  port: number
  baseUrl: string
  overlays: OverlayInfo[]
  lan: { running: boolean; url: string | null; error: string | null; addresses: string[] }
}

export interface TwitchAccount {
  login: string
  name: string
  id: string
}

export interface TwitchState {
  clientIdSource: 'shared' | 'custom' | 'none'
  broadcaster: TwitchAccount | null
  bot: TwitchAccount | null
  /** Идёт вход по коду: показать пользователю код и ссылку. */
  pending: { role: 'broadcaster' | 'bot'; userCode: string; uri: string; expiresAt: number } | null
  live: boolean
  viewers: number | null
  emotes: { twitch: boolean; thirdParty: number }
}

export interface HubSnapshot {
  connections: ConnStatus[]
  obs: ObsState
  events: HubEvent[]
  chat: HubEvent[]
  pinned: HubEvent | null
  server: ServerInfo | null
  obsConfig: { url: string; hasPassword: boolean }
  settings: AppSettings
  twitch: TwitchState
}
