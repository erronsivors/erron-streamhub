// Общие типы ядра. Те же типы использует интерфейс (через preload).

export type Platform = 'twitch' | 'youtube' | 'vk' | 'kick' | 'donationalerts' | 'donatepay' | 'donatex' | 'boosty' | 'obs' | 'hub'

export type HubEventType = 'message' | 'donation' | 'follow' | 'sub' | 'gift' | 'raid' | 'bits' | 'reward' | 'system'

/** Единое событие хаба: чат, донат, подписка и т.д. со всех площадок. */
export interface HubEvent {
  id: string
  ts: number
  platform: Platform
  type: HubEventType
  user: string
  text?: string
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

export interface ServerInfo {
  port: number
  baseUrl: string
  overlays: { id: string; name: string; url: string; size: string }[]
}

export interface HubSnapshot {
  connections: ConnStatus[]
  obs: ObsState
  events: HubEvent[]
  server: ServerInfo | null
  obsConfig: { url: string; hasPassword: boolean }
}
