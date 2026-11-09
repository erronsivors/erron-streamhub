import type { HubEvent, Platform } from './types'

/** Краткое состояние площадки с чатом — для полоски площадок, онлайна и выбора «куда отправить». */
export interface ChatPlatformState {
  id: Platform
  name: string
  /** Подключён ли аккаунт/канал (иначе площадка не показывается в полоске). */
  configured: boolean
  live: boolean
  viewers: number | null
  /** Можно ли писать в чат из Crossember (нужен вход). */
  canSend: boolean
  /** Можно ли удалять сообщения и банить. */
  canModerate: boolean
  /** Имя канала/аккаунта для подписи. */
  account: string | null
}

/**
 * Единый интерфейс площадки с чатом. Каждая площадка (Twitch, YouTube, VK, Kick, GoodGame)
 * реализует его, а ядро работает со всеми одинаково.
 */
export interface ChatConnector {
  readonly id: Platform
  start(): Promise<void>
  stop(): void
  restart(): Promise<void>
  chatState(): ChatPlatformState
  send?(text: string, opts?: { as?: 'broadcaster' | 'bot' }): Promise<void>
  deleteMessage?(m: HubEvent): Promise<void>
  /** seconds > 0 — таймаут, 0 — бан. */
  ban?(m: HubEvent, seconds: number): Promise<void>
}

/** Реестр площадок с чатом. */
export class ChatRegistry {
  private map = new Map<Platform, ChatConnector>()

  add(c: ChatConnector): void {
    this.map.set(c.id, c)
  }

  get(id: Platform): ChatConnector | undefined {
    return this.map.get(id)
  }

  all(): ChatConnector[] {
    return [...this.map.values()]
  }

  states(): ChatPlatformState[] {
    return this.all().map((c) => c.chatState())
  }

  /** Отправить сообщение в выбранные площадки. Ошибки собираются, чтобы одна площадка не мешала другим. */
  async send(text: string, targets: Platform[], as: 'broadcaster' | 'bot'): Promise<void> {
    const errors: string[] = []
    await Promise.all(
      targets.map(async (id) => {
        const c = this.map.get(id)
        if (!c?.send || !c.chatState().canSend) return
        try {
          await c.send(text, { as })
        } catch (e) {
          errors.push(`${c.chatState().name}: ${(e as Error).message}`)
        }
      })
    )
    if (errors.length) throw new Error(errors.join('; '))
  }

  async startAll(): Promise<void> {
    await Promise.all(this.all().map((c) => c.start().catch(() => undefined)))
  }

  stopAll(): void {
    for (const c of this.all()) c.stop()
  }
}
