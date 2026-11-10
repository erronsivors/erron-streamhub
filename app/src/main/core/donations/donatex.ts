import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { Hub } from '../hub'
import type { Settings } from '../settings'
import type { Secrets } from '../secrets'
import type { Store } from '../db'
import { Backoff, DONE_PAGE, FAIL_PAGE, http, json, loopback, type DonationConnector, type DonationServiceState } from './common'

/** Общее приложение Crossember на DonateX (публичный клиент, PKCE, без секрета). Пока не зарегистрировано. */
const SHARED_CLIENT_ID = ''
const PORT = 47835
export const DX_REDIRECT = `http://127.0.0.1:${PORT}/dx/callback`
const BASE = 'https://donatex.gg/api'
const HUB = `${BASE}/public-donations-hub`
const SCOPES = 'openid offline_access donations.read donations.subscribe'
const SECRET_KEY = 'donatex.auth'
const RS = '\u001e'

interface Saved {
  kind: 'oauth' | 'token'
  access: string
  refresh?: string
  expiresAt?: number
  clientId?: string
}

interface Donation {
  id: string
  username?: string | null
  message?: string | null
  currency?: string | null
  amount?: number | null
  amountInRub?: number | null
  isTest?: boolean | null
}

/**
 * DonateX: официальное API. Вход — OAuth 2.0 + PKCE (общее приложение Crossember) или личный токен
 * из кабинета («Настройки → API и доступ»). Донаты в реальном времени — SignalR (JSON-протокол поверх WebSocket).
 */
export class DonateXConnector implements DonationConnector {
  readonly id = 'donatex' as const
  onChange: () => void = () => undefined
  private ws: WebSocket | null = null
  private pending: { close: () => void } | null = null
  private backoff = new Backoff()
  private pingTimer: NodeJS.Timeout | null = null
  private account: string | null
  private stopped = true

  constructor(private hub: Hub, private settings: Settings, private secrets: Secrets, private store: Store) {
    hub.register(this.id, 'DonateX')
    this.account = store.get<string | null>('donatex.account', null)
  }

  private clientId(): string {
    return this.settings.get().donatex.customClientId || SHARED_CLIENT_ID
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

  private save(s: Saved | null): void {
    this.secrets.set(SECRET_KEY, s ? JSON.stringify(s) : null)
  }

  state(): DonationServiceState {
    const s = this.saved()
    return { id: this.id, account: s ? this.account : null, pending: !!this.pending, canLogin: !!this.clientId(), method: s?.kind ?? null }
  }

  /** Личный токен из кабинета DonateX. */
  async setToken(token: string): Promise<void> {
    const t = token.trim()
    if (t.length < 10 || t.length > 4000 || /\s/.test(t)) throw new Error('Токен выглядит неправильно — скопируйте его целиком')
    await this.me(t)
    this.save({ kind: 'token', access: t })
    await this.restart()
  }

  async login(): Promise<void> {
    const clientId = this.clientId()
    if (!clientId) throw new Error('У Crossember пока нет приложения DonateX — подключитесь по личному токену')
    this.cancelLogin()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('hex')
    this.pending = await loopback(PORT, async (req) => {
      if (req.path !== '/dx/callback') return { text: '' }
      const finish = (): void => {
        const p = this.pending
        this.pending = null
        setTimeout(() => p?.close(), 1000)
        this.onChange()
      }
      if (req.query.get('error')) {
        finish()
        return { html: FAIL_PAGE('DonateX отказал во входе: ' + req.query.get('error')), done: true }
      }
      if (req.query.get('state') !== state || !req.query.get('code')) return { html: FAIL_PAGE('Неверный запрос входа — начните вход заново.') }
      try {
        const body = new URLSearchParams({ grant_type: 'authorization_code', code: req.query.get('code')!, redirect_uri: DX_REDIRECT, client_id: clientId, code_verifier: verifier })
        const r = await http(`${BASE}/connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
        const t = await json<{ access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string }>(r)
        if (!t.access_token) throw new Error(t.error_description || t.error || `HTTP ${r.status}`)
        this.save({ kind: 'oauth', access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, clientId })
        finish()
        void this.restart()
        return { html: DONE_PAGE, done: true }
      } catch (e) {
        finish()
        return { html: FAIL_PAGE('Не удалось завершить вход: ' + (e as Error).message), done: true }
      }
    })
    this.onChange()
    const url = new URL(`${BASE}/connect/authorize`)
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: DX_REDIRECT, response_type: 'code', scope: SCOPES, code_challenge: challenge, code_challenge_method: 'S256', state }).toString()
    void shell.openExternal(url.toString())
    this.hub.log(this.id, 'info', 'Открыт вход DonateX в браузере')
  }

  cancelLogin(): void {
    this.pending?.close()
    this.pending = null
    this.onChange()
  }

  async logout(): Promise<void> {
    const s = this.saved()
    this.stop()
    if (s?.kind === 'oauth' && s.refresh && s.clientId) {
      // Отозвать токен на стороне DonateX (ошибки не важны).
      void http(`${BASE}/connect/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: s.refresh, token_type_hint: 'refresh_token', client_id: s.clientId })
      }).catch(() => undefined)
    }
    this.save(null)
    this.store.set('donatex.account', null)
    this.account = null
    this.hub.setStatus(this.id, 'off', 'Не подключено')
    this.onChange()
  }

  /** Действующий токен: OAuth обновляется заранее (за 5 минут до истечения). */
  private async token(): Promise<string | null> {
    const s = this.saved()
    if (!s) return null
    if (s.kind === 'token' || !s.expiresAt || s.expiresAt - Date.now() > 5 * 60_000) return s.access
    if (!s.refresh || !s.clientId) return null
    const r = await http(`${BASE}/connect/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh, client_id: s.clientId })
    })
    const t = await json<{ access_token?: string; refresh_token?: string; expires_in?: number }>(r)
    if (!t.access_token) return null
    this.save({ ...s, access: t.access_token, refresh: t.refresh_token ?? s.refresh, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 })
    return t.access_token
  }

  private async me(token: string): Promise<string> {
    const r = await http(`${BASE}/v1/user/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    if (r.status === 401 || r.status === 403) throw new Error('DonateX не принял токен')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const u = await json<Record<string, unknown>>(r)
    const name = String(u.username ?? u.userName ?? u.displayName ?? u.name ?? u.login ?? 'аккаунт DonateX')
    this.account = name
    this.store.set('donatex.account', name)
    this.onChange()
    return name
  }

  async start(): Promise<void> {
    this.stopped = false
    if (!this.saved()) {
      this.hub.setStatus(this.id, 'off', 'Не подключено')
      return
    }
    this.hub.setStatus(this.id, 'connecting', 'Подключение…')
    try {
      const token = await this.token()
      if (!token) {
        this.hub.setStatus(this.id, 'error', 'Вход устарел — нажмите «Войти» ещё раз')
        return
      }
      await this.me(token)
      if (this.stopped) return
      await this.connect(token)
    } catch (e) {
      const msg = (e as Error).message
      if (/не принял/.test(msg)) this.hub.setStatus(this.id, 'error', `${msg} — подключитесь заново`)
      else this.retry(`Не удалось подключиться: ${msg}`)
    }
  }

  /** SignalR: negotiate → WebSocket → рукопожатие {"protocol":"json","version":1}. */
  private async connect(token: string): Promise<void> {
    const n = await http(`${HUB}/negotiate?negotiateVersion=1`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    if (!n.ok) throw new Error(`negotiate: HTTP ${n.status}`)
    const neg = await json<{ connectionToken?: string; connectionId?: string }>(n)
    const id = neg.connectionToken ?? neg.connectionId
    if (!id) throw new Error('negotiate: нет id соединения')
    const url = `${HUB.replace(/^https/, 'wss')}?id=${encodeURIComponent(id)}&access_token=${encodeURIComponent(token)}`
    this.ws?.close()
    const ws = new WebSocket(url)
    this.ws = ws
    let handshake = false
    ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS)
    ws.onmessage = (m) => {
      const raw = typeof m.data === 'string' ? m.data : ''
      for (const part of raw.split(RS)) {
        if (!part) continue
        let f: { type?: number; target?: string; arguments?: unknown[]; error?: string }
        try {
          f = JSON.parse(part)
        } catch {
          continue
        }
        if (!handshake) {
          handshake = true
          if (f.error) {
            this.hub.setStatus(this.id, 'error', `DonateX: ${f.error}`)
            ws.close()
            return
          }
          this.backoff.reset()
          this.hub.setStatus(this.id, 'ok', `Подключено: ${this.account ?? 'DonateX'}`)
          this.startPing()
          continue
        }
        if (f.type === 1 && (f.target === 'DonationCreated' || f.target === 'DonationRerun')) this.donation(f.arguments?.[0] as Donation)
        else if (f.type === 7) this.hub.log(this.id, 'warn', `Сервер закрыл соединение${f.error ? ': ' + f.error : ''}`)
      }
    }
    ws.onclose = (c) => {
      this.stopPing()
      if (this.ws === ws) this.retry(`Связь потеряна (код ${c.code})`)
    }
    ws.onerror = () => undefined
  }

  private donation(d: Donation | undefined): void {
    if (!d || typeof d !== 'object' || !d.id) return
    const id = `dx:${d.id}`
    if (this.hub.recent().some((e) => e.id === id) || this.store.hasEvent(id)) return
    // Повтор из панели DonateX для уже показанного доната пропускаем; новый (после модерации) — показываем.
    const currency = (d.currency ?? 'RUB').toUpperCase()
    this.hub.push({
      id,
      platform: this.id,
      type: 'donation',
      user: d.username || 'Аноним',
      text: d.message ?? undefined,
      amount: d.amount ?? undefined,
      currency,
      amountRub: d.amountInRub ?? (currency === 'RUB' ? d.amount ?? undefined : undefined),
      test: !!d.isTest
    })
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 6 }) + RS)
    }, 15_000)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private retry(why: string): void {
    if (this.stopped) return
    const sec = this.backoff.schedule(() => void this.start())
    this.hub.setStatus(this.id, 'error', `${why}. Повтор через ${sec} с`)
  }

  stop(): void {
    this.stopped = true
    this.backoff.cancel()
    this.stopPing()
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }
}
