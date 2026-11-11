import { shell } from 'electron'
import type { Hub } from '../hub'
import type { Settings } from '../settings'
import type { Secrets } from '../secrets'
import type { Badge, HubEvent, TwitchState } from '../types'
import { SHARED_CLIENT_ID, TwitchAuth, type DeviceStart, type Role } from './auth'
import { EmoteCache } from './emotes'
import type { ImageCache } from '../imgcache'
import type { ChatConnector, ChatPlatformState } from '../connector'

const HELIX = 'https://api.twitch.tv/helix'
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30'

type Json = Record<string, unknown>
const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

/** Подписки EventSub: тип, версия, условие (b — id канала). Нужные права указаны в SCOPES. */
const SUBS: { type: string; version: string; cond: (b: string) => Json }[] = [
  { type: 'channel.chat.message', version: '1', cond: (b) => ({ broadcaster_user_id: b, user_id: b }) },
  { type: 'channel.chat.message_delete', version: '1', cond: (b) => ({ broadcaster_user_id: b, user_id: b }) },
  { type: 'channel.chat.clear_user_messages', version: '1', cond: (b) => ({ broadcaster_user_id: b, user_id: b }) },
  { type: 'channel.chat.clear', version: '1', cond: (b) => ({ broadcaster_user_id: b, user_id: b }) },
  { type: 'channel.follow', version: '2', cond: (b) => ({ broadcaster_user_id: b, moderator_user_id: b }) },
  { type: 'channel.subscribe', version: '1', cond: (b) => ({ broadcaster_user_id: b }) },
  { type: 'channel.subscription.gift', version: '1', cond: (b) => ({ broadcaster_user_id: b }) },
  { type: 'channel.subscription.message', version: '1', cond: (b) => ({ broadcaster_user_id: b }) },
  { type: 'channel.cheer', version: '1', cond: (b) => ({ broadcaster_user_id: b }) },
  { type: 'channel.raid', version: '1', cond: (b) => ({ to_broadcaster_user_id: b }) },
  { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', cond: (b) => ({ broadcaster_user_id: b }) },
  { type: 'stream.online', version: '1', cond: (b) => ({ broadcaster_user_id: b }) },
  { type: 'stream.offline', version: '1', cond: (b) => ({ broadcaster_user_id: b }) }
]

/** Twitch: вход, чат и события через EventSub WebSocket, онлайн, отправка и модерация. */
export class TwitchConnector implements ChatConnector {
  readonly id = 'twitch' as const
  readonly auth: TwitchAuth
  private emotes: EmoteCache
  private ws: WebSocket | null = null
  private keepaliveTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private viewersTimer: NodeJS.Timeout | null = null
  private validateTimer: NodeJS.Timeout | null = null
  private retryDelay = 2000
  private device: (DeviceStart & { role: Role }) | null = null
  private generation = 0
  live = false
  viewers: number | null = null
  onChange: () => void = () => undefined

  constructor(private hub: Hub, private settings: Settings, secrets: Secrets, img: ImageCache) {
    this.emotes = new EmoteCache(img)
    hub.register('twitch', 'Twitch')
    this.auth = new TwitchAuth(secrets, () => this.clientId())
  }

  clientId(): string {
    return this.settings.get().twitch.customClientId || SHARED_CLIENT_ID
  }

  state(): TwitchState {
    return {
      clientIdSource: this.settings.get().twitch.customClientId ? 'custom' : SHARED_CLIENT_ID ? 'shared' : 'none',
      broadcaster: this.auth.account('broadcaster'),
      bot: this.auth.account('bot'),
      pending: this.device ? { role: this.device.role, userCode: this.device.userCode, uri: this.device.uri, expiresAt: this.device.expiresAt } : null,
      live: this.live,
      viewers: this.viewers,
      emotes: { twitch: true, thirdParty: this.emotes.thirdPartyCount() }
    }
  }

  chatState(): ChatPlatformState {
    const me = this.auth.account('broadcaster')
    return {
      id: 'twitch', name: 'Twitch', configured: !!me, live: this.live, viewers: this.viewers,
      canSend: !!me, canModerate: !!me, account: me?.name ?? null
    }
  }

  // ---------- вход / выход ----------

  async login(role: Role): Promise<void> {
    this.device?.cancel()
    const d = await this.auth.startDevice(role)
    this.device = { ...d, role }
    this.onChange()
    if (/^https:\/\/(www\.)?twitch\.tv\//.test(d.uri)) void shell.openExternal(d.uri)
    try {
      const acc = await d.wait()
      this.hub.log('twitch', 'info', `${role === 'bot' ? 'Бот' : 'Стример'} вошёл: ${acc.login}`)
      if (role === 'broadcaster') await this.start()
    } catch (e) {
      this.hub.log('twitch', 'warn', (e as Error).message)
      throw e
    } finally {
      if (this.device?.userCode === d.userCode) this.device = null
      this.onChange()
    }
  }

  cancelLogin(): void {
    this.device?.cancel()
    this.device = null
    this.onChange()
  }

  async logout(role: Role): Promise<void> {
    await this.auth.logout(role)
    if (role === 'broadcaster') this.stop('off', 'Не подключено')
    this.onChange()
  }

  // ---------- жизненный цикл ----------

  async start(): Promise<void> {
    const me = this.auth.account('broadcaster')
    if (!me) return this.hub.setStatus('twitch', 'off', this.clientId() ? 'Не подключено — нажмите «Войти»' : 'Нужен Client ID приложения Twitch')
    this.stop('connecting', 'Подключение…', false)
    const gen = ++this.generation
    try {
      const token = await this.auth.token('broadcaster')
      const acc = await this.auth.validate(token)
      if (!acc) await this.auth.token('broadcaster', true)
      await this.loadUser(me.id)
      await this.loadBadges(me.id)
      void this.warmTwitchEmotes(me.id)
      if (this.settings.get().twitch.thirdPartyEmotes && /^\d+$/.test(me.id)) {
        void this.emotes.loadThirdParty(me.id, (m) => this.hub.log('twitch', 'warn', m)).then(() => this.onChange())
      } else this.emotes.clearThirdParty()
      if (gen !== this.generation) return
      this.connect(EVENTSUB_URL, gen)
      this.pollViewers()
      this.viewersTimer = setInterval(() => this.pollViewers(), 60_000)
      this.validateTimer = setInterval(() => void this.validateHourly(), 60 * 60_000)
    } catch (e) {
      this.hub.setStatus('twitch', 'error', (e as Error).message)
      this.scheduleRetry(gen)
    }
  }

  stop(state: 'off' | 'connecting' = 'off', detail = 'Отключено', bump = true): void {
    if (bump) this.generation++
    for (const t of [this.keepaliveTimer, this.retryTimer]) if (t) clearTimeout(t)
    for (const t of [this.viewersTimer, this.validateTimer]) if (t) clearInterval(t)
    this.keepaliveTimer = this.retryTimer = this.viewersTimer = this.validateTimer = null
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.hub.setStatus('twitch', state, detail)
  }

  /** Перезапуск, например после смены Client ID или настроек смайлов. */
  async restart(): Promise<void> {
    this.stop('connecting', 'Перезапуск…')
    await this.start()
  }

  private scheduleRetry(gen: number): void {
    if (gen !== this.generation || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (gen === this.generation) void this.start()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
  }

  private async validateHourly(): Promise<void> {
    for (const role of ['broadcaster', 'bot'] as Role[]) {
      if (!this.auth.account(role)) continue
      try {
        const t = await this.auth.token(role)
        if (!(await this.auth.validate(t))) await this.auth.token(role, true)
      } catch (e) {
        this.hub.log('twitch', 'error', `${role === 'bot' ? 'Бот' : 'Стример'}: ${(e as Error).message}`)
        this.onChange()
      }
    }
  }

  // ---------- Helix ----------

  private async helix(path: string, init: RequestInit = {}, role: Role = 'broadcaster'): Promise<Response> {
    const call = async (token: string): Promise<Response> =>
      fetch(`${HELIX}${path}`, {
        ...init,
        signal: AbortSignal.timeout(15_000),
        headers: { 'Client-Id': this.clientId(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
      })
    let res = await call(await this.auth.token(role))
    if (res.status === 401) res = await call(await this.auth.token(role, true))
    return res
  }

  private async loadUser(id: string): Promise<void> {
    const res = await this.helix(`/users?id=${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(`Twitch API: ${res.status}`)
    const u = ((await res.json()) as { data: Json[] }).data[0]
    if (u) this.auth.setName('broadcaster', s(u.display_name) || s(u.login))
  }

  private async loadBadges(id: string): Promise<void> {
    for (const path of ['/chat/badges/global', `/chat/badges?broadcaster_id=${encodeURIComponent(id)}`]) {
      const res = await this.helix(path).catch(() => null)
      if (res?.ok) this.emotes.addBadges(await res.json())
    }
  }

  /** Смайлы Twitch канала и глобальные — скачать в кэш заранее. */
  private async warmTwitchEmotes(id: string): Promise<void> {
    for (const path of [`/chat/emotes?broadcaster_id=${encodeURIComponent(id)}`, '/chat/emotes/global']) {
      const res = await this.helix(path).catch(() => null)
      if (res?.ok) this.emotes.warmTwitchEmotes(await res.json())
    }
  }

  private async pollViewers(): Promise<void> {
    const me = this.auth.account('broadcaster')
    if (!me) return
    try {
      const res = await this.helix(`/streams?user_id=${encodeURIComponent(me.id)}`)
      if (!res.ok) return
      const st = ((await res.json()) as { data: Json[] }).data[0]
      this.live = !!st
      this.viewers = st ? Number(st.viewer_count) || 0 : null
      this.onChange()
    } catch {
      /* сеть — попробуем в следующий раз */
    }
  }

  // ---------- EventSub WebSocket ----------

  private connect(url: string, gen: number, old?: WebSocket): void {
    const ws = new WebSocket(url)
    ws.onmessage = (m) => {
      if (gen !== this.generation) return
      let msg: Json
      try {
        msg = JSON.parse(String(m.data)) as Json
      } catch {
        return
      }
      void this.onSocketMessage(ws, msg, gen, old).catch((e) => this.hub.log('twitch', 'error', (e as Error).message))
    }
    ws.onclose = () => {
      if (gen !== this.generation || this.ws !== ws) return
      this.ws = null
      this.hub.setStatus('twitch', 'connecting', 'Соединение с Twitch потеряно — переподключение…')
      this.scheduleRetry(gen)
    }
    ws.onerror = () => undefined
  }

  private armKeepalive(seconds: number, gen: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer)
    this.keepaliveTimer = setTimeout(() => {
      if (gen !== this.generation) return
      this.hub.log('twitch', 'warn', 'Twitch молчит дольше положенного — переподключаюсь')
      this.ws?.close()
    }, (seconds + 10) * 1000)
  }

  private async onSocketMessage(ws: WebSocket, msg: Json, gen: number, old?: WebSocket): Promise<void> {
    const meta = (msg.metadata ?? {}) as Json
    const payload = (msg.payload ?? {}) as Json
    const type = s(meta.message_type)
    if (type !== 'session_reconnect') this.armKeepalive(30, gen)

    if (type === 'session_welcome') {
      const session = payload.session as Json
      this.ws = ws
      old?.close()
      if (old) return // после reconnect подписки переносятся автоматически
      await this.subscribeAll(s(session.id), gen)
      return
    }
    if (type === 'session_reconnect') {
      const url = s((payload.session as Json)?.reconnect_url)
      if (url.startsWith('wss://eventsub.wss.twitch.tv/')) this.connect(url, gen, ws)
      return
    }
    if (type === 'revocation') {
      this.hub.log('twitch', 'warn', `Twitch отозвал подписку: ${s((payload.subscription as Json)?.type)}`)
      return
    }
    if (type === 'notification') this.onNotification(s((payload.subscription as Json)?.type), (payload.event ?? {}) as Json)
  }

  private async subscribeAll(sessionId: string, gen: number): Promise<void> {
    const me = this.auth.account('broadcaster')
    if (!me) return
    let ok = 0
    const failed: string[] = []
    await Promise.all(
      SUBS.map(async (sub) => {
        const res = await this.helix('/eventsub/subscriptions', {
          method: 'POST',
          body: JSON.stringify({ type: sub.type, version: sub.version, condition: sub.cond(me.id), transport: { method: 'websocket', session_id: sessionId } })
        }).catch(() => null)
        if (res && (res.ok || res.status === 409)) ok++
        else failed.push(`${sub.type}${res ? ` (${res.status})` : ''}`)
      })
    )
    if (gen !== this.generation) return
    this.retryDelay = 2000
    if (failed.length) this.hub.log('twitch', 'warn', `Не удалось подписаться: ${failed.join(', ')}. Часть событий (сабы, биты) доступна только компаньонам/партнёрам.`)
    const chatOk = !failed.some((f) => f.startsWith('channel.chat.message '))
    this.hub.setStatus('twitch', chatOk ? 'ok' : 'error', chatOk ? `Подключено · ${me.name} · подписок: ${ok}/${SUBS.length}` : 'Чат не подключился — смотрите журнал')
  }

  private badgesOf(list: unknown): Badge[] {
    const out: Badge[] = []
    for (const b of Array.isArray(list) ? (list as Json[]) : []) {
      const badge = this.emotes.badge(s(b.set_id), s(b.id))
      if (badge) out.push(badge)
    }
    return out
  }

  private onNotification(type: string, e: Json): void {
    const base = { platform: 'twitch' as const }
    switch (type) {
      case 'channel.chat.message': {
        const message = (e.message ?? {}) as Json
        this.hub.push({
          ...base,
          type: 'message',
          id: s(e.message_id) || undefined,
          user: s(e.chatter_user_name) || s(e.chatter_user_login),
          userId: s(e.chatter_user_id),
          text: s(message.text),
          parts: this.emotes.parts(message.fragments),
          badges: this.badgesOf(e.badges),
          color: s(e.color)
        })
        break
      }
      case 'channel.chat.message_delete':
        this.hub.deleteMessage(s(e.message_id))
        break
      case 'channel.chat.clear_user_messages':
        this.hub.deleteUserMessages('twitch', s(e.target_user_id))
        break
      case 'channel.chat.clear':
        this.hub.clearChat('twitch')
        break
      case 'channel.follow':
        this.hub.push({ ...base, type: 'follow', user: s(e.user_name), userId: s(e.user_id) })
        break
      case 'channel.subscribe':
        if (!e.is_gift) this.hub.push({ ...base, type: 'sub', user: s(e.user_name), userId: s(e.user_id), text: `Уровень ${tier(e.tier)}` })
        break
      case 'channel.subscription.message':
        this.hub.push({
          ...base, type: 'sub', user: s(e.user_name), userId: s(e.user_id),
          text: s((e.message as Json)?.text) || `${s(e.cumulative_months)} мес. вместе`
        })
        break
      case 'channel.subscription.gift':
        this.hub.push({
          ...base, type: 'gift', user: e.is_anonymous ? 'Аноним' : s(e.user_name), userId: s(e.user_id),
          amount: Number(e.total) || 1, text: `Подарил подписок: ${s(e.total)}`
        })
        break
      case 'channel.cheer':
        this.hub.push({
          ...base, type: 'bits', user: e.is_anonymous ? 'Аноним' : s(e.user_name), userId: s(e.user_id),
          amount: Number(e.bits) || 0, currency: 'bits', text: s(e.message)
        })
        break
      case 'channel.raid':
        this.hub.push({
          ...base, type: 'raid', user: s(e.from_broadcaster_user_name), userId: s(e.from_broadcaster_user_id),
          amount: Number(e.viewers) || 0, text: `${s(e.viewers)} зрителей`
        })
        break
      case 'channel.channel_points_custom_reward_redemption.add':
        this.hub.push({
          ...base, type: 'reward', user: s(e.user_name), userId: s(e.user_id),
          amount: Number((e.reward as Json)?.cost) || 0, currency: 'points', reward: s((e.reward as Json)?.title),
          text: [s((e.reward as Json)?.title), s(e.user_input)].filter(Boolean).join(' — ')
        })
        break
      case 'stream.online':
        this.live = true
        void this.pollViewers()
        this.onChange()
        break
      case 'stream.offline':
        this.live = false
        this.viewers = null
        this.onChange()
        break
    }
  }

  // ---------- действия ----------

  async send(text: string, opts: { as?: Role; replyTo?: string } = {}): Promise<void> {
    const as: Role = opts.as === 'bot' && this.auth.account('bot') ? 'bot' : 'broadcaster'
    const replyTo = opts.replyTo
    const me = this.auth.account('broadcaster')
    const sender = this.auth.account(as)
    if (!me || !sender) throw new Error(as === 'bot' ? 'Бот не подключён' : 'Twitch не подключён')
    const message = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500)
    if (!message) return
    const body: Json = { broadcaster_id: me.id, sender_id: sender.id, message }
    if (replyTo && /^[\w-]{1,100}$/.test(replyTo)) body.reply_parent_message_id = replyTo
    const res = await this.helix('/chat/messages', { method: 'POST', body: JSON.stringify(body) }, as)
    const j = (await res.json().catch(() => ({}))) as { data?: { is_sent?: boolean; drop_reason?: { message?: string } }[] }
    if (!res.ok) throw new Error(`Twitch не принял сообщение (${res.status})`)
    const r = j.data?.[0]
    if (r && !r.is_sent) throw new Error(`Сообщение отклонено: ${r.drop_reason?.message ?? 'без причины'}`)
  }

  async deleteMessage(m: HubEvent): Promise<void> {
    if (m.platform === 'twitch') await this.deleteById(m.id)
  }

  async ban(m: HubEvent, seconds: number): Promise<void> {
    if (m.platform === 'twitch' && m.userId) await this.banUser(m.userId, seconds, 'Crossember')
  }

  // ---------- название и категория эфира ----------

  /** Можно ли менять название: вошёл стример и у входа есть право channel:manage:broadcast (появилось в этапе 5). */
  infoAccess(): 'ok' | 'login' | 'relogin' {
    if (!this.auth.account('broadcaster')) return 'login'
    return this.auth.hasScope('broadcaster', 'channel:manage:broadcast') ? 'ok' : 'relogin'
  }

  /** Поиск категорий (игр) по названию. */
  async searchCategories(q: string): Promise<{ id: string; name: string }[]> {
    if (!this.auth.account('broadcaster') || !q.trim()) return []
    const res = await this.helix(`/search/categories?first=8&query=${encodeURIComponent(q.trim().slice(0, 100))}`)
    if (!res.ok) throw new Error(`Twitch API: ${res.status}`)
    return ((await res.json()) as { data?: Json[] }).data?.map((c) => ({ id: s(c.id), name: s(c.name) })).filter((c) => /^\d{1,20}$/.test(c.id)) ?? []
  }

  /** Текущие название и категория канала. */
  async channelInfo(): Promise<{ title: string; game: string }> {
    const me = this.auth.account('broadcaster')
    if (!me) throw new Error('Не выполнен вход в Twitch')
    const res = await this.helix(`/channels?broadcaster_id=${encodeURIComponent(me.id)}`)
    if (!res.ok) throw new Error(`Twitch API: ${res.status}`)
    const c = ((await res.json()) as { data?: Json[] }).data?.[0] ?? {}
    return { title: s(c.title), game: s(c.game_name) }
  }

  /** Сменить название и (если найдена) категорию. Возвращает, какая категория поставлена. */
  async setChannelInfo(title: string, game: string): Promise<string> {
    const me = this.auth.account('broadcaster')
    if (!me) throw new Error('Не выполнен вход в Twitch')
    if (this.infoAccess() === 'relogin') throw new Error('Нужно новое разрешение — войдите в Twitch заново (Подключения → Twitch)')
    const body: Json = { title: title.slice(0, 140) }
    let gameName = ''
    if (game.trim()) {
      const found = await this.searchCategories(game)
      const pick = found.find((c) => c.name.toLowerCase() === game.trim().toLowerCase()) ?? found[0]
      if (!pick) throw new Error(`Категория «${game}» на Twitch не найдена`)
      body.game_id = pick.id
      gameName = pick.name
    }
    const res = await this.helix(`/channels?broadcaster_id=${encodeURIComponent(me.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
    if (res.status === 401 || res.status === 403) throw new Error('Twitch не дал прав — войдите заново (Подключения → Twitch)')
    if (!res.ok) throw new Error(`Twitch API: ${res.status}`)
    return gameName
  }

  async deleteById(messageId: string): Promise<void> {
    const me = this.auth.account('broadcaster')
    if (!me || !/^[\w-]{1,100}$/.test(messageId)) return
    const res = await this.helix(`/moderation/chat?broadcaster_id=${me.id}&moderator_id=${me.id}&message_id=${encodeURIComponent(messageId)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`Не удалось удалить сообщение (${res.status})`)
  }

  /** Таймаут (seconds > 0) или бан (seconds = 0). */
  async banUser(userId: string, seconds: number, reason = ''): Promise<void> {
    const me = this.auth.account('broadcaster')
    if (!me || !/^\d{1,20}$/.test(userId)) return
    const data: Json = { user_id: userId, reason: reason.slice(0, 500) }
    if (seconds > 0) data.duration = Math.min(1_209_600, Math.max(1, Math.round(seconds)))
    const res = await this.helix(`/moderation/bans?broadcaster_id=${me.id}&moderator_id=${me.id}`, { method: 'POST', body: JSON.stringify({ data }) })
    if (!res.ok) throw new Error(`Не удалось ${seconds > 0 ? 'выдать таймаут' : 'забанить'} (${res.status})`)
  }
}

function tier(t: unknown): string {
  return t === '2000' ? '2' : t === '3000' ? '3' : '1'
}

export type { HubEvent }
