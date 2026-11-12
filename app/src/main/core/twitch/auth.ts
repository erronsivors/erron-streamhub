import type { Secrets } from '../secrets'
import type { TwitchAccount } from '../types'

/**
 * Публичный Client ID общего приложения Crossember на dev.twitch.tv (тип «Public», без секрета).
 * Это не секрет: он виден любому, кто входит через приложение. Пользователь может указать свой в настройках.
 */
export const SHARED_CLIENT_ID = 'nskl20g1j7bekvneokc4sadh70tmlf'

export type Role = 'broadcaster' | 'bot'

/** Права: только то, что нужно функциям. Для бота — только отправка сообщений. */
export const SCOPES: Record<Role, string[]> = {
  broadcaster: [
    'user:read:chat',
    'user:write:chat',
    'moderator:read:followers',
    'channel:read:subscriptions',
    'bits:read',
    'channel:read:redemptions',
    'moderator:manage:chat_messages',
    'moderator:manage:banned_users',
    'channel:manage:broadcast',
    'channel:manage:polls'
  ],
  bot: ['user:write:chat']
}

interface TokenSet {
  access: string
  refresh: string
  expiresAt: number
  scopes: string[]
  account: TwitchAccount
}

export interface DeviceStart {
  userCode: string
  uri: string
  expiresAt: number
  wait: () => Promise<TwitchAccount>
  cancel: () => void
}

const ID = 'https://id.twitch.tv/oauth2'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function form(url: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

/** Вход и хранение токенов Twitch. Токены — только в зашифрованном хранилище (DPAPI). */
export class TwitchAuth {
  private cache: Partial<Record<Role, TokenSet>> = {}
  private refreshing: Partial<Record<Role, Promise<string>>> = {}
  /** Номер входа по роли: выход увеличивает его, и запоздавшее обновление токена не воскрешает сессию. */
  private epoch: Record<Role, number> = { broadcaster: 0, bot: 0 }

  constructor(private secrets: Secrets, private clientId: () => string) {}

  private key(role: Role): string {
    return `twitch.${role}.tokens`
  }

  private load(role: Role): TokenSet | null {
    if (this.cache[role]) return this.cache[role]!
    const raw = this.secrets.get(this.key(role))
    if (!raw) return null
    try {
      const t = JSON.parse(raw) as TokenSet
      this.cache[role] = t
      return t
    } catch {
      return null
    }
  }

  private save(role: Role, t: TokenSet | null): void {
    if (t) this.cache[role] = t
    else delete this.cache[role]
    this.secrets.set(this.key(role), t ? JSON.stringify(t) : null)
  }

  account(role: Role): TwitchAccount | null {
    return this.load(role)?.account ?? null
  }

  hasScope(role: Role, scope: string): boolean {
    return this.load(role)?.scopes.includes(scope) ?? false
  }

  /** Начать вход по коду устройства: пользователь открывает ссылку и подтверждает код. */
  async startDevice(role: Role): Promise<DeviceStart> {
    const clientId = this.clientId()
    if (!clientId) throw new Error('Не задан Client ID приложения Twitch')
    const scopes = SCOPES[role].join(' ')
    const { status, json } = await form(`${ID}/device`, { client_id: clientId, scopes })
    if (status !== 200) throw new Error(`Twitch отказал в начале входа: ${String(json.message ?? status)}`)
    const deviceCode = String(json.device_code)
    const interval = Math.max(1, Number(json.interval) || 5) * 1000
    const expiresAt = Date.now() + (Number(json.expires_in) || 1800) * 1000
    let cancelled = false

    const wait = async (): Promise<TwitchAccount> => {
      while (!cancelled && Date.now() < expiresAt) {
        await sleep(interval)
        if (cancelled) break
        const r = await form(`${ID}/token`, {
          client_id: clientId,
          scopes,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
        if (r.status === 200) {
          const access = String(r.json.access_token)
          const account = await this.validate(access)
          if (!account) throw new Error('Twitch выдал токен, но проверка не прошла')
          this.save(role, {
            access,
            refresh: String(r.json.refresh_token),
            expiresAt: Date.now() + (Number(r.json.expires_in) || 3600) * 1000,
            scopes: Array.isArray(r.json.scope) ? (r.json.scope as string[]) : SCOPES[role],
            account
          })
          return account
        }
        const msg = String(r.json.message ?? '')
        if (msg === 'authorization_pending' || msg === 'slow_down') continue
        throw new Error(msg === 'access_denied' ? 'Вход отменён в Twitch' : `Ошибка входа: ${msg || r.status}`)
      }
      throw new Error(cancelled ? 'Вход отменён' : 'Время на подтверждение кода истекло')
    }

    return {
      userCode: String(json.user_code),
      uri: String(json.verification_uri),
      expiresAt,
      wait,
      cancel: () => {
        cancelled = true
      }
    }
  }

  /** Проверка токена (Twitch требует проверять раз в час). null — токен недействителен. */
  async validate(access: string): Promise<TwitchAccount | null> {
    const res = await fetch(`${ID}/validate`, { headers: { Authorization: `OAuth ${access}` } })
    if (res.status !== 200) return null
    const j = (await res.json()) as { login: string; user_id: string }
    return { login: j.login, name: j.login, id: j.user_id }
  }

  /** Действующий access-токен (с авто-обновлением). */
  async token(role: Role, force = false): Promise<string> {
    const t = this.load(role)
    if (!t) throw new Error(role === 'bot' ? 'Бот не подключён' : 'Twitch не подключён')
    if (!force && t.expiresAt - Date.now() > 60_000) return t.access
    if (!this.refreshing[role]) {
      this.refreshing[role] = this.refresh(role, t).finally(() => delete this.refreshing[role])
    }
    return this.refreshing[role]!
  }

  private async refresh(role: Role, t: TokenSet): Promise<string> {
    const epoch = this.epoch[role]
    const { status, json } = await form(`${ID}/token`, {
      client_id: this.clientId(),
      grant_type: 'refresh_token',
      refresh_token: t.refresh
    })
    // Пока ждали ответ, пользователь вышел или вошёл заново — этот ответ уже не наш, ничего не сохраняем.
    if (epoch !== this.epoch[role] || this.load(role)?.refresh !== t.refresh) throw new Error('Вход Twitch изменился — повторите действие')
    // Стираем вход, только если Twitch именно отказал (400/401: токен отозван или недействителен).
    // Временные сбои (429, 5xx) вход не трогают — попробуем позже.
    if (status === 400 || status === 401) {
      this.save(role, null)
      throw new Error('Сессия Twitch истекла — войдите заново')
    }
    if (status !== 200) throw new Error(`Twitch временно не отвечает (код ${status}) — попробуем ещё раз позже`)
    const next: TokenSet = {
      ...t,
      access: String(json.access_token),
      refresh: String(json.refresh_token ?? t.refresh),
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      scopes: Array.isArray(json.scope) ? (json.scope as string[]) : t.scopes
    }
    this.save(role, next)
    return next.access
  }

  /** Выход: отзываем токен у Twitch и стираем локально. */
  async logout(role: Role): Promise<void> {
    this.epoch[role]++
    delete this.refreshing[role]
    const t = this.load(role)
    this.save(role, null)
    if (t) await form(`${ID}/revoke`, { client_id: this.clientId(), token: t.access }).catch(() => undefined)
  }

  setName(role: Role, name: string): void {
    const t = this.load(role)
    if (t && t.account.name !== name) this.save(role, { ...t, account: { ...t.account, name } })
  }
}
