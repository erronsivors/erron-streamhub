import { BrowserWindow, session } from 'electron'
import type { Hub } from '../hub'
import type { Settings } from '../settings'
import type { Secrets } from '../secrets'
import type { Store } from '../db'
import { Backoff, UA, http, json, type DonationConnector, type DonationServiceState } from './common'

const API = 'https://api.boosty.to'
const SECRET_KEY = 'boosty.auth'
const POLL_MS = 60_000

interface Auth {
  accessToken: string
  refreshToken: string
  /** мс */
  expiresAt: number
  deviceId: string
}

interface Subscriber {
  id: number
  name?: string
  onTime?: number
  price?: number
  subscribed?: boolean
  level?: { name?: string; price?: number }
}

interface DonationSale {
  id: string | number
  amount?: number
  createdAt?: number
  type?: string
  user?: { name?: string }
}

/**
 * Boosty: официального API нет. Вход — окно Boosty внутри Crossember: пользователь входит в свой аккаунт,
 * Crossember берёт токен из cookie «auth» (как делают сторонние инструменты) и забывает сессию окна.
 * Новые подписки и донаты — опросом внутреннего API раз в минуту, только чтение. Может сломаться при изменениях Boosty.
 */
export class BoostyConnector implements DonationConnector {
  readonly id = 'boosty' as const
  onChange: () => void = () => undefined
  private win: BrowserWindow | null = null
  private timer: NodeJS.Timeout | null = null
  private backoff = new Backoff()
  private account: string | null
  private blog: string | null
  private stopped = true

  constructor(private hub: Hub, private settings: Settings, private secrets: Secrets, private store: Store) {
    hub.register(this.id, 'Boosty')
    this.account = store.get<string | null>('boosty.account', null)
    this.blog = store.get<string | null>('boosty.blog', null)
  }

  private auth(): Auth | null {
    const raw = this.secrets.get(SECRET_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as Auth
    } catch {
      return null
    }
  }

  state(): DonationServiceState {
    const a = this.auth()
    return { id: this.id, account: a ? (this.blog ? `${this.account ?? ''} · boosty.to/${this.blog}` : this.account) : null, pending: !!this.win, canLogin: true, method: a ? 'oauth' : null }
  }

  /** Открыть окно входа Boosty. Сессия окна — временная (в памяти), после входа стирается. */
  async login(): Promise<void> {
    if (this.win) {
      this.win.focus()
      return
    }
    const part = `boosty-login-${Date.now()}`
    const ses = session.fromPartition(part)
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    ses.setUserAgent(UA)
    const win = new BrowserWindow({
      width: 520, height: 760, title: 'Вход в Boosty — Crossember', autoHideMenuBar: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.win = win
    this.onChange()
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Только boosty.to и вход через VK/Яндекс/Google/Mail, которые предлагает сам Boosty.
    win.webContents.on('will-navigate', (e, url) => {
      if (!/^https:\/\/([\w-]+\.)*(boosty\.to|vk\.com|vk\.ru|vkontakte\.ru|id\.vk\.com|id\.vk\.ru|yandex\.ru|ya\.ru|google\.com|mail\.ru)(\/|$)/.test(url)) e.preventDefault()
    })
    const check = async (): Promise<void> => {
      const got = await this.readAuth(ses).catch(() => null)
      if (!got || !this.win) return
      this.secrets.set(SECRET_KEY, JSON.stringify(got))
      this.hub.log(this.id, 'info', 'Вход в Boosty выполнен')
      this.closeWin()
      void this.restart()
    }
    const iv = setInterval(() => void check(), 1500)
    win.on('closed', () => {
      clearInterval(iv)
      this.win = null
      void ses.clearStorageData().catch(() => undefined)
      this.onChange()
    })
    await win.loadURL('https://boosty.to/app/auth')
  }

  private closeWin(): void {
    const w = this.win
    this.win = null
    w?.close()
    this.onChange()
  }

  cancelLogin(): void {
    this.closeWin()
  }

  /** Достать токен: cookie «auth» (JSON, иногда URL-кодированный) и «_clientId» (device_id). */
  private async readAuth(ses: Electron.Session): Promise<Auth | null> {
    const cookies = await ses.cookies.get({ domain: 'boosty.to' })
    const auth = cookies.find((c) => c.name === 'auth')?.value
    const device = cookies.find((c) => c.name === '_clientId')?.value
    if (!auth) return null
    let a: Partial<Auth>
    try {
      a = JSON.parse(decodeURIComponent(auth))
    } catch {
      return null
    }
    if (!a.accessToken || !a.refreshToken) return null
    return { accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: Number(a.expiresAt) || Date.now() + 3600_000, deviceId: device ?? a.deviceId ?? '' }
  }

  async logout(): Promise<void> {
    this.stop()
    this.secrets.set(SECRET_KEY, null)
    this.store.set('boosty.account', null)
    this.store.set('boosty.blog', null)
    this.store.set('boosty.last', null)
    this.account = null
    this.blog = null
    this.hub.setStatus(this.id, 'off', 'Не подключено')
    this.onChange()
  }

  /** Обновить токен (form, обязательно device_id). Новая пара сохраняется — старый refresh больше не работает. */
  private async refresh(a: Auth): Promise<Auth> {
    if (!a.deviceId) throw new Error('нет device_id — войдите заново')
    const r = await http(`${API}/oauth/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Authorization: `Bearer ${a.accessToken}` },
      body: new URLSearchParams({ device_id: a.deviceId, device_os: 'web', grant_type: 'refresh_token', refresh_token: a.refreshToken })
    })
    const t = await json<{ access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }>(r)
    if (!t.access_token) throw new Error(t.error_description || `HTTP ${r.status}`)
    const next: Auth = { ...a, accessToken: t.access_token, refreshToken: t.refresh_token ?? a.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 }
    this.secrets.set(SECRET_KEY, JSON.stringify(next))
    return next
  }

  private async get<T>(path: string, retried = false): Promise<T> {
    let a = this.auth()
    if (!a) throw new Error('нет входа')
    if (a.expiresAt - Date.now() < 10 * 60_000) a = await this.refresh(a)
    const r = await http(`${API}${path}`, { headers: { Authorization: `Bearer ${a.accessToken}`, Accept: 'application/json', 'User-Agent': UA } })
    if (r.status === 401 && !retried) {
      await this.refresh(a)
      return this.get<T>(path, true)
    }
    if (r.status === 401) throw new Error('AUTH')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return json<T>(r)
  }

  async start(): Promise<void> {
    this.stopped = false
    if (!this.auth()) {
      this.hub.setStatus(this.id, 'off', 'Не подключено')
      return
    }
    this.hub.setStatus(this.id, 'connecting', 'Подключение…')
    try {
      const u = await this.get<{ name?: string; blogUrl?: string; blog?: { url?: string } }>('/v1/user/current')
      this.account = u.name ?? 'аккаунт Boosty'
      this.blog = u.blogUrl ?? u.blog?.url ?? null
      this.store.set('boosty.account', this.account)
      this.store.set('boosty.blog', this.blog)
      this.onChange()
      if (!this.blog) {
        this.hub.setStatus(this.id, 'error', 'У этого аккаунта нет страницы автора на Boosty')
        return
      }
      if (!this.settings.get().boosty.poll) {
        this.hub.setStatus(this.id, 'ok', `Аккаунт подключён: ${this.account}. Опрос выключен — включите «Получать события напрямую»`)
        return
      }
      this.backoff.reset()
      await this.poll()
    } catch (e) {
      this.fail(e as Error)
    }
  }

  private fail(e: Error): void {
    if (e.message === 'AUTH' || /device_id|invalid|expired/i.test(e.message)) {
      this.hub.setStatus(this.id, 'error', 'Boosty не принял вход — нажмите «Войти» ещё раз')
      return
    }
    if (this.stopped) return
    const sec = this.backoff.schedule(() => void this.start())
    this.hub.setStatus(this.id, 'error', `Ошибка: ${e.message}. Повтор через ${sec} с`)
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.blog) return
    const blog = encodeURIComponent(this.blog)
    const last = this.store.get<{ subTime: number; donTime: number } | null>('boosty.last', null)
    const first = !last
    const mark = last ?? { subTime: 0, donTime: 0 }
    try {
      const subs = await this.get<{ data?: Subscriber[] }>(`/v1/blog/${blog}/subscribers?sort_by=on_time&limit=20&order=gt`)
      const dons = await this.get<{ data?: { donationsSales?: DonationSale[] } }>(`/v1/blog/${blog}/sales/donation/?limit=20&sort_by=time&order=lt`)
        .catch((e) => {
          this.hub.log(this.id, 'warn', `Донаты Boosty недоступны: ${(e as Error).message}`)
          return { data: { donationsSales: [] } }
        })
      const subList = (subs.data ?? []).filter((s) => s.subscribed !== false && s.onTime)
      const donList = dons.data?.donationsSales ?? []
      const maxSub = Math.max(mark.subTime, ...subList.map((s) => s.onTime ?? 0))
      const maxDon = Math.max(mark.donTime, ...donList.map((d) => d.createdAt ?? 0))
      // Первый опрос только запоминает, что уже было: старые подписки и донаты алертами не показываем.
      if (!first) {
        for (const s of subList.filter((x) => (x.onTime ?? 0) > mark.subTime).sort((a, b) => (a.onTime ?? 0) - (b.onTime ?? 0))) {
          this.hub.push({
            id: `boosty:sub:${s.id}:${s.onTime}`, platform: this.id, type: 'sub', user: s.name || 'Подписчик',
            text: s.level?.name ? `Уровень «${s.level.name}»` : undefined, amount: s.price ?? s.level?.price, currency: 'RUB'
          })
        }
        for (const d of donList.filter((x) => (x.createdAt ?? 0) > mark.donTime).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
          this.hub.push({
            id: `boosty:don:${d.id}`, platform: this.id, type: 'donation', user: d.user?.name || 'Аноним',
            amount: d.amount, currency: 'RUB', amountRub: d.amount
          })
        }
      }
      this.store.set('boosty.last', { subTime: maxSub, donTime: maxDon })
      this.hub.setStatus(this.id, 'ok', `Подключено: ${this.account} · проверка раз в минуту`)
      this.timer = setTimeout(() => void this.poll(), POLL_MS)
    } catch (e) {
      this.fail(e as Error)
    }
  }

  stop(): void {
    this.stopped = true
    this.backoff.cancel()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }
}
