import { randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { Hub } from '../hub'
import type { Settings } from '../settings'
import type { Secrets } from '../secrets'
import type { Store } from '../db'
import { Backoff, CentrifugeClient, FAIL_PAGE, FRAGMENT_PAGE, http, json, loopback, type DonationConnector, type DonationServiceState } from './common'

/**
 * Общее приложение Crossember на DonationAlerts. ID приложения — публичный (не секрет).
 * Вход — OAuth implicit grant: секрет приложения не нужен и в программе не хранится.
 */
const SHARED_CLIENT_ID = '22938'
const PORT = 47834
export const DA_REDIRECT = `http://127.0.0.1:${PORT}/da/callback`
const API = 'https://www.donationalerts.com/api/v1'
const WS = 'wss://centrifugo.donationalerts.com/connection/websocket'
const SCOPES = 'oauth-user-show oauth-donation-subscribe'
const SECRET_KEY = 'donationalerts.token'

interface Saved {
  token: string
  expiresAt: number
}

/**
 * DonationAlerts: вход через сайт (implicit OAuth + приёмник на 127.0.0.1), донаты в реальном времени
 * через Centrifugo: канал $alerts:donation_<id пользователя>.
 */
export class DonationAlertsConnector implements DonationConnector {
  readonly id = 'donationalerts' as const
  onChange: () => void = () => undefined
  private client: CentrifugeClient | null = null
  private pending: { close: () => void } | null = null
  private backoff = new Backoff()
  private account: string | null
  private stopped = true
  /** Номер сеанса: stop() увеличивает его, запоздавшие ответы старого сеанса ничего не делают. */
  private gen = 0

  constructor(private hub: Hub, private settings: Settings, private secrets: Secrets, private store: Store) {
    hub.register(this.id, 'DonationAlerts')
    this.account = store.get<string | null>('donationalerts.account', null)
  }

  private clientId(): string {
    return this.settings.get().donationalerts.customClientId || SHARED_CLIENT_ID
  }

  private saved(): Saved | null {
    const raw = this.secrets.get(SECRET_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as Saved
    } catch {
      return null
    }
  }

  state(): DonationServiceState {
    return { id: this.id, account: this.saved() ? this.account : null, pending: !!this.pending, canLogin: !!this.clientId(), method: this.saved() ? 'oauth' : null }
  }

  async login(): Promise<void> {
    const clientId = this.clientId()
    if (!clientId) throw new Error('Нет ID приложения DonationAlerts — укажите его в «Для опытных»')
    this.cancelLogin()
    const state = randomBytes(16).toString('hex')
    this.pending = await loopback(PORT, async (req) => {
      if (req.path !== '/da/callback') return { text: '' }
      if (req.method === 'GET') {
        if (req.query.get('error')) {
          this.finishLogin()
          return { html: FAIL_PAGE('DonationAlerts отказал во входе: ' + req.query.get('error')), done: true }
        }
        return { html: FRAGMENT_PAGE }
      }
      const p = new URLSearchParams(req.body)
      if (p.get('state') !== state) return { text: 'Неверный запрос входа — начните вход в Crossember заново.' }
      const token = p.get('access_token')
      if (!token) return { text: 'DonationAlerts не прислал токен: ' + (p.get('error') ?? 'неизвестная ошибка') }
      const expiresIn = Number(p.get('expires_in')) || 365 * 86400
      this.secrets.set(SECRET_KEY, JSON.stringify({ token, expiresAt: Date.now() + expiresIn * 1000 } satisfies Saved))
      this.finishLogin()
      void this.restart()
      return { text: 'Готово! Вход выполнен — вкладку можно закрыть и вернуться в Crossember.', done: true }
    })
    this.onChange()
    const url = new URL('https://www.donationalerts.com/oauth/authorize')
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: DA_REDIRECT, response_type: 'token', scope: SCOPES, state }).toString()
    void shell.openExternal(url.toString())
    this.hub.log(this.id, 'info', 'Открыт вход DonationAlerts в браузере')
  }

  private finishLogin(): void {
    const p = this.pending
    this.pending = null
    setTimeout(() => p?.close(), 1000)
    this.onChange()
  }

  cancelLogin(): void {
    this.pending?.close()
    this.pending = null
    this.onChange()
  }

  async logout(): Promise<void> {
    this.stop()
    this.secrets.set(SECRET_KEY, null)
    this.store.set('donationalerts.account', null)
    this.account = null
    this.hub.setStatus(this.id, 'off', 'Не подключено')
    this.onChange()
  }

  async start(): Promise<void> {
    this.stopped = false
    const gen = ++this.gen
    const s = this.saved()
    if (!s) {
      this.hub.setStatus(this.id, 'off', 'Не подключено')
      return
    }
    if (s.expiresAt < Date.now()) {
      this.hub.setStatus(this.id, 'error', 'Вход устарел (токен действует год) — нажмите «Войти» ещё раз')
      return
    }
    this.hub.setStatus(this.id, 'connecting', 'Подключение…')
    try {
      const r = await http(`${API}/user/oauth`, { headers: { Authorization: `Bearer ${s.token}` } })
      if (gen !== this.gen) return
      if (r.status === 401) {
        this.hub.setStatus(this.id, 'error', 'DonationAlerts не принял вход — нажмите «Войти» ещё раз')
        return
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const u = (await json<{ data: { id: number; name: string; code?: string; socket_connection_token: string } }>(r)).data
      if (gen !== this.gen) return
      this.account = u.name || u.code || String(u.id)
      this.store.set('donationalerts.account', this.account)
      this.onChange()
      if (this.stopped) return
      this.hub.log(this.id, 'info', `Профиль получен: ${this.account}. Подключаемся к каналу донатов`)
      this.connect(s.token, u.id, u.socket_connection_token)
    } catch (e) {
      if (gen !== this.gen) return
      this.retry(`Не удалось получить профиль: ${(e as Error).message}`)
    }
  }

  private connect(token: string, userId: number, socketToken: string): void {
    const channel = `$alerts:donation_${userId}`
    this.client?.close()
    this.client = new CentrifugeClient(WS, {
      token: socketToken,
      subscribe: async (client) => {
        const r = await http(`${API}/centrifuge/subscribe`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channels: [channel], client })
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await json<{ channels: { channel: string; token: string }[] }>(r)
        return d.channels
      },
      onReady: () => {
        this.backoff.reset()
        this.hub.setStatus(this.id, 'ok', `Подключено: ${this.account ?? 'аккаунт DonationAlerts'} · подписка на донаты подтверждена`)
      },
      onPublish: (ch, data) => {
        this.hub.log(this.id, 'info', `Получено событие из канала ${ch}`)
        this.donation(data)
      },
      onClose: (why) => this.retry(`Связь потеряна: ${why}`),
      onError: (text) => this.hub.log(this.id, 'error', text)
    })
    this.client.connect()
  }

  private donation(raw: unknown): void {
    const d = raw as Record<string, unknown>
    if (!d || typeof d !== 'object' || d.id === undefined) {
      this.hub.log(this.id, 'warn', `Неизвестное сообщение: поля ${Object.keys(d ?? {}).slice(0, 12).join(', ')}`)
      return
    }
    const id = `da:${String(d.id)}`
    // Повторный показ из панели DA приходит с тем же id — в ленту второй раз не добавляем.
    if (this.hub.recent().some((e) => e.id === id) || this.store.hasEvent(id)) return
    const amount = Number(d.amount)
    const currency = typeof d.currency === 'string' ? d.currency : 'RUB'
    // Сумма в основной валюте стримера (недокументированное поле). Считаем её рублями, если валюта доната не RUB.
    const inUser = Number(d.amount_in_user_currency)
    this.hub.push({
      id,
      platform: this.id,
      type: 'donation',
      user: typeof d.username === 'string' && d.username ? d.username : 'Аноним',
      text: typeof d.message === 'string' && d.message_type !== 'audio' ? d.message : undefined,
      amount: Number.isFinite(amount) ? amount : undefined,
      currency,
      amountRub: currency.toUpperCase() === 'RUB' ? amount : Number.isFinite(inUser) ? inUser : undefined
    })
  }

  private retry(why: string): void {
    if (this.stopped) return
    const sec = this.backoff.schedule(() => void this.start())
    this.hub.setStatus(this.id, 'error', `${why}. Повтор через ${sec} с`)
  }

  stop(): void {
    this.stopped = true
    this.gen++
    this.backoff.cancel()
    this.client?.close()
    this.client = null
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }
}
