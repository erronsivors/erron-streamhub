import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { shell } from 'electron'
import type { Hub } from './hub'
import type { Secrets } from './secrets'

/**
 * Вход в Kick (официальный API) — только чтобы менять название и категорию эфира. Чат Kick по-прежнему читается без входа.
 * - OAuth 2.1 + PKCE через id.kick.com. Kick требует секрет приложения при обмене кода, поэтому нужен общий клиент
 *   Crossember: файл resources/kick/oauth-client.json ({ "clientId": "…", "clientSecret": "…" }). В Git он не хранится
 *   (публичный репозиторий). Нет файла — вход в Kick недоступен в этой сборке.
 * - Адрес возврата фиксированный: http://localhost:47835/callback — он же указан в приложении на kick.com.
 * - Токены — только в зашифрованном хранилище (DPAPI).
 */

const SHARED_FILE = ['kick', 'oauth-client.json']
const AUTH_URL = 'https://id.kick.com/oauth/authorize'
const TOKEN_URL = 'https://id.kick.com/oauth/token'
const REVOKE_URL = 'https://id.kick.com/oauth/revoke'
const API = 'https://api.kick.com/public'
const SCOPES = 'user:read channel:read channel:write'
export const KICK_REDIRECT_PORT = 47835
const REDIRECT = `http://localhost:${KICK_REDIRECT_PORT}/callback`
const TOKENS_KEY = 'kick.tokens'
const LOGIN_TIMEOUT = 5 * 60_000

type Json = Record<string, unknown>
const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const b64url = (b: Buffer): string => b.toString('base64url')

interface Tokens { access: string; refresh: string; expiresAt: number; name: string }

export interface KickAuthState {
  /** Есть ли в сборке общий клиент Crossember для входа. */
  available: boolean
  account: string | null
  pending: boolean
}

const DONE_PAGE = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><title>Crossember</title><body style="font:16px system-ui;background:#16110d;color:#f3e7d8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${ok ? 'Вход в Kick выполнен' : 'Вход не удался'}</h2><p>${ok ? 'Эту вкладку можно закрыть и вернуться в Crossember.' : 'Вернитесь в Crossember и попробуйте ещё раз.'}</p></div>`

export class KickAuth {
  private client: { id: string; secret: string } | null = null
  private tokens: Tokens | null = null
  private servers: Server[] = []
  private loginTimer: NodeJS.Timeout | null = null
  private pending = false
  onChange: () => void = () => undefined

  constructor(private hub: Hub, private secrets: Secrets, resourcesDir: string) {
    try {
      const c = obj(JSON.parse(readFileSync(join(resourcesDir, ...SHARED_FILE), 'utf8')))
      if (/^[\w-]{8,}$/.test(s(c.clientId)) && s(c.clientSecret)) this.client = { id: s(c.clientId), secret: s(c.clientSecret) }
    } catch {
      /* файла нет — входа нет */
    }
    try {
      const t = JSON.parse(secrets.get(TOKENS_KEY) ?? 'null') as Tokens | null
      if (t?.refresh) this.tokens = t
    } catch {
      /* повреждённые токены — войти заново */
    }
  }

  state(): KickAuthState {
    return { available: !!this.client, account: this.tokens?.name || (this.tokens ? 'Kick' : null), pending: this.pending }
  }

  loggedIn(): boolean {
    return !!this.tokens
  }

  private save(): void {
    this.secrets.set(TOKENS_KEY, this.tokens ? JSON.stringify(this.tokens) : null)
  }

  async login(): Promise<void> {
    if (!this.client) throw new Error('Вход в Kick ещё не настроен в этой сборке Crossember')
    this.cancelLogin()
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(24))
    const c = this.client

    const onRequest = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      const url = new URL(req.url ?? '/', REDIRECT)
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
      const code = url.searchParams.get('code')
      const okState = url.searchParams.get('state') === state
      if (!okState || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(false))
        if (okState) { this.hub.log('kick', 'warn', 'Вход в Kick отменён'); this.cancelLogin() }
        return
      }
      this.exchange(code, verifier, c)
        .then(() => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(true)))
        .catch((e: Error) => {
          this.hub.log('kick', 'error', `Вход в Kick не удался: ${e.message}`)
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(false))
        })
        .finally(() => this.cancelLogin())
    }
    // localhost может означать и 127.0.0.1, и ::1 — слушаем оба, только на этом компьютере.
    for (const host of ['127.0.0.1', '::1']) {
      const srv = createServer(onRequest)
      const ok = await new Promise<boolean>((resolve) => {
        srv.once('error', () => resolve(false))
        srv.listen(KICK_REDIRECT_PORT, host, () => resolve(true))
      })
      if (ok) this.servers.push(srv)
    }
    if (!this.servers.length) throw new Error(`Порт ${KICK_REDIRECT_PORT} занят другой программой — закройте её и попробуйте снова`)

    const q = new URLSearchParams({
      client_id: c.id, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
      code_challenge: challenge, code_challenge_method: 'S256', state
    })
    this.pending = true
    this.loginTimer = setTimeout(() => this.cancelLogin(), LOGIN_TIMEOUT)
    this.onChange()
    await shell.openExternal(`${AUTH_URL}?${q}`)
  }

  cancelLogin(): void {
    if (this.loginTimer) clearTimeout(this.loginTimer)
    this.loginTimer = null
    for (const srv of this.servers) srv.close()
    this.servers = []
    if (this.pending) { this.pending = false; this.onChange() }
  }

  private async tokenRequest(params: Record<string, string>): Promise<Json> {
    const res = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) })
    const j = (await res.json().catch(() => ({}))) as Json
    if (!res.ok || !j.access_token) throw Object.assign(new Error(s(j.error_description) || s(j.error) || s(j.message) || `Kick: ${res.status}`), { status: res.status })
    return j
  }

  private async exchange(code: string, verifier: string, c: { id: string; secret: string }): Promise<void> {
    const j = await this.tokenRequest({ grant_type: 'authorization_code', code, client_id: c.id, client_secret: c.secret, redirect_uri: REDIRECT, code_verifier: verifier })
    this.tokens = { access: s(j.access_token), refresh: s(j.refresh_token), expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, name: '' }
    try {
      const u = obj(arr((await this.api('GET', '/v1/users')).data)[0])
      this.tokens.name = s(u.name).slice(0, 60)
    } catch { /* имя не обязательно */ }
    this.save()
    this.hub.log('kick', 'info', `Вход в Kick выполнен${this.tokens.name ? `: ${this.tokens.name}` : ''}`)
    this.onChange()
  }

  private async accessToken(force = false): Promise<string> {
    const t = this.tokens
    if (!t) throw new Error('Не выполнен вход в Kick')
    if (!force && Date.now() < t.expiresAt - 60_000) return t.access
    if (!this.client) throw new Error('Вход в Kick не настроен в этой сборке')
    try {
      const j = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: this.client.id, client_secret: this.client.secret })
      t.access = s(j.access_token)
      if (j.refresh_token) t.refresh = s(j.refresh_token)
      t.expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000
      this.save()
      return t.access
    } catch (e) {
      const st = (e as { status?: number }).status
      if (st === 400 || st === 401) {
        this.tokens = null
        this.save()
        this.onChange()
        throw new Error('Вход в Kick истёк или отозван — войдите снова')
      }
      throw e
    }
  }

  private async api(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<Json> {
    const call = async (token: string): Promise<Response> => fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000)
    })
    let res = await call(await this.accessToken())
    if (res.status === 401) res = await call(await this.accessToken(true))
    if (res.status === 204) return {}
    const j = (await res.json().catch(() => ({}))) as Json
    if (res.status === 403) throw new Error('Kick не дал прав — войдите в Kick заново')
    if (!res.ok) throw new Error(s(j.message) || `Kick API: ${res.status}`)
    return j
  }

  async logout(): Promise<void> {
    const t = this.tokens
    this.tokens = null
    this.save()
    this.onChange()
    if (t) await fetch(`${REVOKE_URL}?${new URLSearchParams({ token: t.refresh, token_hint_type: 'refresh_token' })}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  }

  /** Поиск категорий по названию (устаревший, но задокументированный v1: q=…). */
  async searchCategories(q: string): Promise<{ id: number; name: string }[]> {
    if (!this.tokens || !q.trim()) return []
    const j = await this.api('GET', `/v1/categories?${new URLSearchParams({ q: q.trim().slice(0, 100) })}`)
    return arr(j.data).map(obj).map((c) => ({ id: Number(c.id), name: s(c.name) })).filter((c) => Number.isInteger(c.id) && c.id > 0).slice(0, 8)
  }

  /** Сменить название и (если найдена) категорию. Возвращает поставленную категорию. */
  async setChannelInfo(title: string, game: string): Promise<string> {
    const body: Json = { stream_title: title.slice(0, 140) }
    let name = ''
    if (game.trim()) {
      const found = await this.searchCategories(game)
      const pick = found.find((c) => c.name.toLowerCase() === game.trim().toLowerCase()) ?? found[0]
      if (!pick) throw new Error(`Категория «${game}» на Kick не найдена`)
      body.category_id = pick.id
      name = pick.name
    }
    await this.api('PATCH', '/v1/channels', body)
    return name
  }
}
