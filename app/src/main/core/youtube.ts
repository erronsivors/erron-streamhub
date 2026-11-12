import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { shell } from 'electron'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import type { Hub } from './hub'
import type { Settings } from './settings'
import type { Secrets } from './secrets'
import type { ChatConnector, ChatPlatformState } from './connector'
import type { HubEvent, YoutubeState } from './types'

/**
 * YouTube: вход через Google (OAuth для приложений на ПК: loopback 127.0.0.1 + PKCE), чтение чата через
 * liveChatMessages.streamList (gRPC — одно соединение вместо частых опросов, бережёт общую квоту),
 * запасной путь — liveChatMessages.list. Отправка, удаление и бан — через YouTube Data API v3.
 *
 * Квота проекта Google — 10 000 единиц в сутки на всех пользователей общего Client ID:
 * поиск эфира 1 ед. (раз в 2 мин, пока эфира нет), зрители 1 ед. (раз в 90 с в эфире),
 * подключение к чату 5 ед., отправка ~20 ед., удаление ~50, бан ~200 — бан только по явному действию.
 *
 * Client secret у «Desktop app»-клиента Google по документации Google НЕ считается секретом
 * (его нельзя спрятать в программе на ПК), но в публичный репозиторий его не кладём (иначе его отзовут); защита входа — PKCE + state.
 */

/**
 * Общий OAuth-клиент Crossember (Desktop app) — в файле resources/youtube/oauth-client.json
 * ({ "clientId": "…", "clientSecret": "…" }). Файл не хранится в Git: GitHub и Google автоматически
 * отзывают ключи, найденные в публичных репозиториях. Нет файла — нужен свой клиент («Для опытных»).
 */
const SHARED_FILE = ['youtube', 'oauth-client.json']

const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const API = 'https://www.googleapis.com/youtube/v3'
const GRPC_HOST = 'youtube.googleapis.com:443'
const TOKENS_KEY = 'youtube.tokens'
const CUSTOM_SECRET_KEY = 'youtube.customSecret'
const LOGIN_TIMEOUT = 5 * 60_000

type Json = Record<string, unknown>
const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const b64url = (b: Buffer): string => b.toString('base64url')

interface Tokens {
  access: string
  refresh: string
  expiresAt: number
  channelId: string
  channelName: string
}

/** Ответ страницы после входа: только статичный текст, ничего из адреса не выводится. */
const DONE_PAGE = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><title>Crossember</title><body style="font:16px system-ui;background:#16110d;color:#f3e7d8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${ok ? 'Вход в YouTube выполнен' : 'Вход не удался'}</h2><p>${ok ? 'Эту вкладку можно закрыть и вернуться в Crossember.' : 'Вернитесь в Crossember и попробуйте ещё раз.'}</p></div>`

export class YoutubeConnector implements ChatConnector {
  readonly id = 'youtube' as const
  private tokens: Tokens | null = null
  private loginServer: Server | null = null
  private loginTimer: NodeJS.Timeout | null = null
  private pendingSince: number | null = null
  private broadcastTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private call: grpc.ClientReadableStream<Json> | null = null
  private client: grpc.Client | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private ServiceCtor: grpc.ServiceClientConstructor | null = null
  private liveChatId: string | null = null
  private videoId: string | null = null
  private pageToken: string | null = null
  private retryDelay = 5000
  private generation = 0
  private unknown = new Set<string>()
  private shared: { id: string; secret: string } | null = null
  live = false
  viewers: number | null = null
  onChange: () => void = () => undefined

  constructor(private hub: Hub, private settings: Settings, private secrets: Secrets, private resourcesDir: string) {
    hub.register('youtube', 'YouTube')
    try {
      const c = obj(JSON.parse(readFileSync(join(resourcesDir, ...SHARED_FILE), 'utf8')))
      if (s(c.clientId).endsWith('.apps.googleusercontent.com')) this.shared = { id: s(c.clientId), secret: s(c.clientSecret) }
    } catch {
      /* файла нет — общего входа нет */
    }
    try {
      const t = JSON.parse(secrets.get(TOKENS_KEY) ?? 'null') as Tokens | null
      if (t?.refresh) this.tokens = t
    } catch {
      /* повреждённые токены — просто войти заново */
    }
  }

  // ---------- состояние ----------

  private client_(): { id: string; secret: string; source: 'shared' | 'custom' | 'none' } {
    const customId = this.settings.get().youtube.customClientId
    if (customId) return { id: customId, secret: this.secrets.get(CUSTOM_SECRET_KEY) ?? '', source: 'custom' }
    if (this.shared) return { ...this.shared, source: 'shared' }
    return { id: '', secret: '', source: 'none' }
  }

  state(): YoutubeState {
    return {
      clientIdSource: this.client_().source,
      hasCustomSecret: this.secrets.has(CUSTOM_SECRET_KEY),
      account: this.tokens ? { id: this.tokens.channelId, name: this.tokens.channelName } : null,
      pending: this.pendingSince !== null,
      live: this.live,
      viewers: this.viewers
    }
  }

  chatState(): ChatPlatformState {
    const ok = !!this.tokens && !!this.liveChatId
    return { id: 'youtube', name: 'YouTube', configured: !!this.tokens, live: this.live, viewers: this.viewers, canSend: ok, canModerate: ok, account: this.tokens?.channelName ?? null }
  }

  /** Свой OAuth-клиент (режим «Для опытных»). Secret хранится зашифрованным, в настройки не попадает. */
  setCustomSecret(secret: string | null): void {
    this.secrets.set(CUSTOM_SECRET_KEY, secret && secret.trim() ? secret.trim() : null)
    this.onChange()
  }

  // ---------- вход ----------

  async login(): Promise<void> {
    const c = this.client_()
    if (!c.id) throw new Error('Вход в YouTube ещё не настроен в этой сборке — укажите свой Client ID («Для опытных»)')
    this.cancelLogin()
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(24))

    const srv = createServer()
    this.loginServer = srv
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (srv.address() as { port: number }).port
    const redirect = `http://127.0.0.1:${port}`

    srv.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirect)
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const okState = url.searchParams.get('state') === state
      if (!okState || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(false))
        if (okState) {
          this.hub.log('youtube', 'warn', `Вход отменён: ${url.searchParams.get('error') === 'access_denied' ? 'доступ не разрешён' : 'нет кода'}`)
          this.cancelLogin()
        }
        return
      }
      this.exchange(code, verifier, redirect, c)
        .then(() => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(true)))
        .catch((e: Error) => {
          this.hub.log('youtube', 'error', `Вход не удался: ${e.message}`)
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(false))
        })
        .finally(() => this.cancelLogin())
    })

    const q = new URLSearchParams({
      client_id: c.id,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent select_account'
    })
    this.pendingSince = Date.now()
    this.loginTimer = setTimeout(() => this.cancelLogin(), LOGIN_TIMEOUT)
    this.hub.setStatus('youtube', 'connecting', 'Подтвердите вход в браузере…')
    this.onChange()
    await shell.openExternal(`${AUTH_URL}?${q}`)
  }

  cancelLogin(): void {
    if (this.loginTimer) clearTimeout(this.loginTimer)
    this.loginTimer = null
    this.loginServer?.close()
    this.loginServer = null
    if (this.pendingSince !== null) {
      this.pendingSince = null
      if (!this.tokens) this.hub.setStatus('youtube', 'off', 'Не подключён — нажмите «Войти»')
      this.onChange()
    }
  }

  private async exchange(code: string, verifier: string, redirect: string, c: { id: string; secret: string }): Promise<void> {
    const body = new URLSearchParams({ code, client_id: c.id, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect })
    if (c.secret) body.set('client_secret', c.secret)
    const res = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(20_000) })
    const j = (await res.json().catch(() => ({}))) as Json
    if (!res.ok || !j.access_token) throw new Error(s(j.error_description) || s(j.error) || `Google: ${res.status}`)
    if (!j.refresh_token) throw new Error('Google не выдал refresh-токен — попробуйте войти ещё раз')
    const t: Tokens = { access: s(j.access_token), refresh: s(j.refresh_token), expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, channelId: '', channelName: '' }
    this.tokens = t
    const ch = await this.api('GET', 'channels', { part: 'snippet', mine: 'true' })
    const item = obj(arr(ch.items)[0])
    if (!item.id) {
      this.tokens = null
      throw new Error('У этого аккаунта Google нет YouTube-канала')
    }
    t.channelId = s(item.id)
    t.channelName = s(obj(item.snippet).title).slice(0, 100)
    this.save()
    this.hub.log('youtube', 'info', `Вход выполнен: ${t.channelName}`)
    void this.restart()
  }

  async logout(): Promise<void> {
    const t = this.tokens
    this.tokens = null
    this.secrets.set(TOKENS_KEY, null)
    this.stop()
    this.hub.setStatus('youtube', 'off', 'Не подключён — нажмите «Войти»')
    if (t) await fetch(`${REVOKE_URL}?token=${encodeURIComponent(t.refresh)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  }

  private save(): void {
    this.secrets.set(TOKENS_KEY, this.tokens ? JSON.stringify(this.tokens) : null)
  }

  private async accessToken(): Promise<string> {
    const t = this.tokens
    if (!t) throw new Error('Не выполнен вход в YouTube')
    if (Date.now() < t.expiresAt - 60_000) return t.access
    const c = this.client_()
    const body = new URLSearchParams({ client_id: c.id, refresh_token: t.refresh, grant_type: 'refresh_token' })
    if (c.secret) body.set('client_secret', c.secret)
    const res = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(20_000) })
    const j = (await res.json().catch(() => ({}))) as Json
    if (!res.ok || !j.access_token) {
      if (j.error === 'invalid_grant') {
        this.tokens = null
        this.save()
        throw new Error('Вход в YouTube истёк или отозван — войдите снова')
      }
      throw new Error(s(j.error_description) || `Google: ${res.status}`)
    }
    t.access = s(j.access_token)
    t.expiresAt = Date.now() + (Number(j.expires_in) || 3600) * 1000
    this.save()
    return t.access
  }

  /** Запрос к YouTube Data API v3. */
  private async api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, query: Record<string, string>, body?: unknown): Promise<Json> {
    const token = await this.accessToken()
    const res = await fetch(`${API}/${path}?${new URLSearchParams(query)}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000)
    })
    if (res.status === 204) return {}
    const j = (await res.json().catch(() => ({}))) as Json
    if (!res.ok) {
      const err = obj(j.error)
      const reason = s(obj(arr(err.errors)[0]).reason)
      if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') throw new Error('Закончилась суточная квота YouTube API — попробуйте завтра или укажите свой Client ID')
      throw new Error(s(err.message) || `YouTube API: ${res.status}`)
    }
    return j
  }

  // ---------- жизненный цикл ----------

  async start(): Promise<void> {
    if (!this.tokens) return this.hub.setStatus('youtube', 'off', this.client_().id ? 'Не подключён — нажмите «Войти»' : 'Вход YouTube ещё не настроен')
    this.stop('connecting', 'Поиск эфира…', false)
    const gen = ++this.generation
    await this.findBroadcast(gen)
  }

  stop(state: 'off' | 'connecting' = 'off', detail = 'Отключено', bump = true): void {
    if (bump) this.generation++
    for (const t of [this.broadcastTimer, this.retryTimer, this.pollTimer]) if (t) clearTimeout(t)
    this.broadcastTimer = this.retryTimer = this.pollTimer = null
    this.closeStream()
    this.liveChatId = this.videoId = this.pageToken = null
    this.live = false
    this.viewers = null
    this.hub.setStatus('youtube', state, detail)
    this.onChange()
  }

  async restart(): Promise<void> {
    this.retryDelay = 5000
    this.stop('connecting', 'Перезапуск…')
    await this.start()
  }

  private closeStream(): void {
    const c = this.call
    this.call = null
    c?.cancel()
    this.client?.close()
    this.client = null
  }

  private later(gen: number, ms: number, fn: () => void): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer)
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      if (gen === this.generation) fn()
    }, ms)
  }

  /** Ищем активный эфир канала (1 ед. квоты). Без эфира — повтор раз в 2 минуты. */
  private async findBroadcast(gen: number): Promise<void> {
    try {
      const j = await this.api('GET', 'liveBroadcasts', { part: 'snippet,status', broadcastStatus: 'active', broadcastType: 'all', maxResults: '5' })
      if (gen !== this.generation) return
      const b = arr(j.items).map(obj).find((x) => s(obj(x.snippet).liveChatId))
      if (!b) {
        this.live = false
        this.viewers = null
        this.hub.setStatus('youtube', 'ok', `Подключено · ${this.tokens?.channelName} · ждём эфир`)
        this.onChange()
        this.later(gen, 120_000, () => void this.findBroadcast(gen))
        return
      }
      const chatId = s(obj(b.snippet).liveChatId)
      const fresh = chatId !== this.liveChatId
      this.liveChatId = chatId
      this.videoId = s(b.id)
      this.live = true
      if (fresh) {
        this.pageToken = null
        this.openChat(gen)
      }
      await this.updateViewers()
      this.later(gen, 90_000, () => void this.watchLive(gen))
    } catch (e) {
      if (gen !== this.generation) return
      this.hub.setStatus('youtube', 'error', (e as Error).message)
      if (this.tokens) this.later(gen, Math.min((this.retryDelay *= 2), 300_000), () => void this.findBroadcast(gen))
    }
  }

  /** В эфире: зрители раз в 90 с (1 ед.). Когда эфир закончился — снова ищем. */
  private async watchLive(gen: number): Promise<void> {
    try {
      const ended = await this.updateViewers()
      if (gen !== this.generation) return
      if (ended) {
        this.closeStream()
        this.liveChatId = null
        this.live = false
        this.viewers = null
        this.onChange()
        return void this.findBroadcast(gen)
      }
    } catch (e) {
      this.hub.log('youtube', 'warn', `Не удалось обновить онлайн: ${(e as Error).message}`)
    }
    this.later(gen, 90_000, () => void this.watchLive(gen))
  }

  /** Обновить онлайн; true — эфир закончился. */
  private async updateViewers(): Promise<boolean> {
    if (!this.videoId) return true
    const j = await this.api('GET', 'videos', { part: 'liveStreamingDetails', id: this.videoId })
    const d = obj(obj(arr(j.items)[0]).liveStreamingDetails)
    if (!d.activeLiveChatId || d.actualEndTime) return true
    this.viewers = Number(d.concurrentViewers) || 0
    this.onChange()
    return false
  }

  // ---------- чат ----------

  private service(): grpc.ServiceClientConstructor {
    if (this.ServiceCtor) return this.ServiceCtor
    const def = protoLoader.loadSync(join(this.resourcesDir, 'youtube', 'stream_list.proto'), { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true })
    const pkg = grpc.loadPackageDefinition(def) as unknown as { youtube: { api: { v3: { V3DataLiveChatMessageService: grpc.ServiceClientConstructor } } } }
    this.ServiceCtor = pkg.youtube.api.v3.V3DataLiveChatMessageService
    return this.ServiceCtor
  }

  private openChat(gen: number): void {
    this.closeStream()
    let Ctor: grpc.ServiceClientConstructor
    try {
      Ctor = this.service()
    } catch (e) {
      this.hub.log('youtube', 'warn', `gRPC недоступен (${(e as Error).message}) — читаю чат опросом`)
      return this.poll(gen, true)
    }
    const creds = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(),
      grpc.credentials.createFromMetadataGenerator((_p, cb) => {
        this.accessToken().then(
          (t) => {
            const md = new grpc.Metadata()
            md.add('authorization', `Bearer ${t}`)
            cb(null, md)
          },
          (e: Error) => cb(e)
        )
      })
    )
    const client = new Ctor(GRPC_HOST, creds)
    this.client = client
    const first = this.pageToken === null
    let skipBacklog = first
    const req: Json = { live_chat_id: this.liveChatId, part: ['snippet', 'authorDetails'], max_results: 200 }
    if (this.pageToken) req.page_token = this.pageToken
    const call = (client as unknown as { StreamList: (r: Json) => grpc.ClientReadableStream<Json> }).StreamList(req)
    this.call = call
    this.hub.setStatus('youtube', 'ok', `Подключено · ${this.tokens?.channelName} · в эфире`)

    call.on('data', (r: Json) => {
      if (gen !== this.generation || this.call !== call) return
      this.retryDelay = 5000
      if (r.next_page_token) this.pageToken = s(r.next_page_token)
      // Первая порция — недавняя история чата: её не показываем, как и на других площадках.
      if (!skipBacklog) for (const it of arr(r.items)) this.onItem(obj(it))
      skipBacklog = false
      if (r.offline_at) {
        this.hub.log('youtube', 'info', 'Чат эфира закрыт')
        this.closeStream()
        this.liveChatId = null
        this.later(gen, 5000, () => void this.findBroadcast(gen))
      }
    })
    call.on('error', (e: grpc.ServiceError) => {
      if (gen !== this.generation || this.call !== call) return
      this.call = null
      if (e.code === grpc.status.CANCELLED) return
      if (e.code === grpc.status.RESOURCE_EXHAUSTED) {
        this.hub.setStatus('youtube', 'error', 'Закончилась суточная квота YouTube API — чат вернётся завтра')
        return this.retryChat(gen, 30 * 60_000)
      }
      if (e.code === grpc.status.NOT_FOUND || e.code === grpc.status.FAILED_PRECONDITION) {
        this.liveChatId = null
        return this.later(gen, 10_000, () => void this.findBroadcast(gen))
      }
      if (e.code === grpc.status.UNIMPLEMENTED) {
        this.hub.log('youtube', 'warn', 'streamList недоступен — читаю чат опросом')
        // Если поток не успел выдать ни одной порции — первая порция опроса тоже история, её не показываем.
        return this.poll(gen, this.pageToken === null)
      }
      this.hub.setStatus('youtube', 'connecting', `Соединение с чатом YouTube потеряно — переподключение… (${e.details || e.code})`)
      this.retryChat(gen, this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, 120_000)
    })
    call.on('end', () => {
      if (gen !== this.generation || this.call !== call) return
      this.call = null
      if (this.liveChatId) this.retryChat(gen, 1000) // сервер закрыл поток — продолжаем с page_token
    })
  }

  private retryChat(gen: number, ms: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (gen === this.generation && this.liveChatId) this.openChat(gen)
    }, ms)
  }

  /** Запасной путь: liveChatMessages.list (5 ед. за запрос) — не чаще раза в 15 с. */
  private poll(gen: number, first: boolean): void {
    if (gen !== this.generation || !this.liveChatId) return
    const q: Record<string, string> = { liveChatId: this.liveChatId, part: 'snippet,authorDetails', maxResults: '200' }
    if (this.pageToken) q.pageToken = this.pageToken
    this.api('GET', 'liveChat/messages', q)
      .then((j) => {
        if (gen !== this.generation) return
        this.pageToken = s(j.nextPageToken) || this.pageToken
        if (!first) for (const it of arr(j.items)) this.onItem(this.restToGrpc(obj(it)))
        if (j.offlineAt) {
          this.liveChatId = null
          return this.later(gen, 5000, () => void this.findBroadcast(gen))
        }
        this.pollTimer = setTimeout(() => this.poll(gen, false), Math.max(15_000, Number(j.pollingIntervalMillis) || 0))
      })
      .catch((e: Error) => {
        this.hub.log('youtube', 'warn', `Чат YouTube: ${e.message}`)
        this.pollTimer = setTimeout(() => this.poll(gen, false), 60_000)
      })
  }

  /** REST-ответ (camelCase) → тот же вид, что у gRPC (snake_case), чтобы разбирать одним кодом. */
  private restToGrpc(it: Json): Json {
    const sn = obj(it.snippet)
    const a = obj(it.authorDetails)
    const map: Record<string, string> = {
      textMessageEvent: 'TEXT_MESSAGE_EVENT', superChatEvent: 'SUPER_CHAT_EVENT', superStickerEvent: 'SUPER_STICKER_EVENT',
      newSponsorEvent: 'NEW_SPONSOR_EVENT', memberMilestoneChatEvent: 'MEMBER_MILESTONE_CHAT_EVENT', membershipGiftingEvent: 'MEMBERSHIP_GIFTING_EVENT',
      messageDeletedEvent: 'TOMBSTONE', userBannedEvent: 'USER_BANNED_EVENT', chatEndedEvent: 'CHAT_ENDED_EVENT'
    }
    const sc = obj(sn.superChatDetails)
    const st = obj(sn.superStickerDetails)
    const ms = obj(sn.memberMilestoneChatDetails)
    const gift = obj(sn.membershipGiftingDetails)
    const ban = obj(sn.userBannedDetails)
    return {
      id: s(sn.type) === 'messageDeletedEvent' ? s(obj(sn.messageDeletedDetails).deletedMessageId) : it.id,
      snippet: {
        type: map[s(sn.type)] ?? s(sn.type),
        display_message: sn.displayMessage,
        text_message_details: { message_text: obj(sn.textMessageDetails).messageText },
        super_chat_details: { amount_micros: sc.amountMicros, currency: sc.currency, user_comment: sc.userComment },
        super_sticker_details: { amount_micros: st.amountMicros, currency: st.currency, super_sticker_metadata: { alt_text: obj(st.superStickerMetadata).altText } },
        new_sponsor_details: { member_level_name: obj(sn.newSponsorDetails).memberLevelName },
        member_milestone_chat_details: { member_month: ms.memberMonth, user_comment: ms.userComment },
        membership_gifting_details: { gift_memberships_count: gift.giftMembershipsCount },
        user_banned_details: { banned_user_details: { channel_id: obj(ban.bannedUserDetails).channelId } }
      },
      author_details: { channel_id: a.channelId, display_name: a.displayName, is_chat_owner: a.isChatOwner, is_chat_moderator: a.isChatModerator }
    }
  }

  private onItem(it: Json): void {
    const sn = obj(it.snippet)
    const a = obj(it.author_details)
    const type = s(sn.type)
    // id события YouTube постоянный: повтор той же записи (переподключение, переход на опрос) хаб отсекает.
    const base = { platform: 'youtube' as const, id: it.id ? `yt-${s(it.id)}` : undefined, user: s(a.display_name).slice(0, 100), userId: s(a.channel_id) }
    const micros = (v: unknown): number => Math.round(Number(v) / 10_000) / 100 || 0
    switch (type) {
      case 'TEXT_MESSAGE_EVENT': {
        const text = s(obj(sn.text_message_details).message_text) || s(sn.display_message)
        if (!text) return
        this.hub.push({ ...base, type: 'message', id: `yt-${s(it.id)}`, text, parts: [{ t: 'text', v: text }], color: a.is_chat_owner ? '#ffd600' : a.is_chat_moderator ? '#5e84f1' : undefined })
        return
      }
      case 'SUPER_CHAT_EVENT': {
        const d = obj(sn.super_chat_details)
        this.hub.push({ ...base, type: 'donation', amount: micros(d.amount_micros), currency: s(d.currency), text: s(d.user_comment) })
        return
      }
      case 'SUPER_STICKER_EVENT': {
        const d = obj(sn.super_sticker_details)
        this.hub.push({ ...base, type: 'donation', amount: micros(d.amount_micros), currency: s(d.currency), text: `Суперстикер: ${s(obj(d.super_sticker_metadata).alt_text)}` })
        return
      }
      case 'NEW_SPONSOR_EVENT':
        this.hub.push({ ...base, type: 'sub', text: `Новый спонсор${obj(sn.new_sponsor_details).member_level_name ? ` (${s(obj(sn.new_sponsor_details).member_level_name)})` : ''}` })
        return
      case 'MEMBER_MILESTONE_CHAT_EVENT': {
        const d = obj(sn.member_milestone_chat_details)
        this.hub.push({ ...base, type: 'sub', text: `Спонсор ${s(d.member_month)} мес.${d.user_comment ? ` — ${s(d.user_comment)}` : ''}` })
        return
      }
      case 'MEMBERSHIP_GIFTING_EVENT': {
        const n = Number(obj(sn.membership_gifting_details).gift_memberships_count) || 1
        this.hub.push({ ...base, type: 'gift', amount: n, text: `Подарил спонсорств: ${n}` })
        return
      }
      case 'GIFT_EVENT': {
        const d = obj(sn.gift_details)
        this.hub.push({ ...base, type: 'gift', amount: Number(d.combo_count) || 1, text: `Подарок: ${s(d.alt_text || d.gift_name)}` })
        return
      }
      case 'TOMBSTONE':
        this.hub.deleteMessage(`yt-${s(it.id)}`)
        return
      case 'USER_BANNED_EVENT': {
        const uid = s(obj(obj(sn.user_banned_details).banned_user_details).channel_id)
        if (uid) this.hub.deleteUserMessages('youtube', uid)
        return
      }
      case 'CHAT_ENDED_EVENT':
        this.live = false
        this.onChange()
        return
      case 'GIFT_MEMBERSHIP_RECEIVED_EVENT':
      case 'SPONSOR_ONLY_MODE_STARTED_EVENT':
      case 'SPONSOR_ONLY_MODE_ENDED_EVENT':
      case 'POLL_EVENT':
        return
      default:
        if (type && !this.unknown.has(type) && this.unknown.size < 30) {
          this.unknown.add(type)
          this.hub.log('youtube', 'info', `Новый тип события YouTube: ${type}`)
        }
    }
  }

  // ---------- название эфира ----------

  /**
   * Сменить название (и категорию YouTube) идущей или ближайшей запланированной трансляции.
   * videos.update заменяет snippet целиком, поэтому сначала читаем его и меняем только название и категорию.
   * Квота: ~52 ед. (из 10 000 в сутки).
   */
  async setTitle(title: string, categoryId: string): Promise<void> {
    if (!this.tokens) throw new Error('Не выполнен вход в YouTube')
    const clean = title.replace(/[<>]/g, '').trim().slice(0, 100)
    if (!clean) throw new Error('Пустое название')
    let id = this.live ? this.videoId : null
    if (!id) {
      for (const status of ['active', 'upcoming']) {
        const j = await this.api('GET', 'liveBroadcasts', { part: 'id', broadcastStatus: status, broadcastType: 'all', maxResults: '1' })
        id = s(obj(arr(j.items)[0]).id) || null
        if (id) break
      }
    }
    if (!id) throw new Error('Нет идущей или запланированной трансляции — начните или запланируйте эфир на YouTube')
    const v = obj(arr((await this.api('GET', 'videos', { part: 'snippet', id })).items)[0])
    const sn = obj(v.snippet)
    if (!v.id) throw new Error('YouTube не нашёл видео трансляции')
    const snippet: Json = { title: clean, categoryId: /^\d{1,3}$/.test(categoryId) ? categoryId : s(sn.categoryId) || '20', description: s(sn.description) }
    if (Array.isArray(sn.tags)) snippet.tags = sn.tags
    if (sn.defaultLanguage) snippet.defaultLanguage = sn.defaultLanguage
    await this.api('PUT', 'videos', { part: 'snippet' }, { id: s(v.id), snippet })
  }

  // ---------- действия ----------

  async send(text: string): Promise<void> {
    if (!this.liveChatId) throw new Error('Нет активного эфира')
    const messageText = [...text.trim()].slice(0, 200).join('')
    if (!messageText) return
    await this.api('POST', 'liveChat/messages', { part: 'snippet' }, { snippet: { liveChatId: this.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText } } })
  }

  async deleteMessage(m: HubEvent): Promise<void> {
    const id = m.id.replace(/^yt-/, '')
    if (!id || id === m.id) return
    await this.api('DELETE', 'liveChat/messages', { id })
    this.hub.deleteMessage(m.id)
  }

  async ban(m: HubEvent, seconds: number): Promise<void> {
    if (!this.liveChatId || !m.userId) return
    const snippet: Json = { liveChatId: this.liveChatId, type: seconds > 0 ? 'temporary' : 'permanent', bannedUserDetails: { channelId: m.userId } }
    if (seconds > 0) snippet.banDurationSeconds = Math.min(Math.max(Math.round(seconds), 10), 86_400)
    await this.api('POST', 'liveChat/bans', { part: 'snippet' }, { snippet })
    this.hub.deleteUserMessages('youtube', m.userId)
  }
}
