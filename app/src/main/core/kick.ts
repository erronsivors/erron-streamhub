import { BrowserWindow } from 'electron'
import type { Hub } from './hub'
import type { Settings } from './settings'
import type { ImageCache } from './imgcache'
import type { ChatConnector, ChatPlatformState } from './connector'
import type { MsgPart } from './types'

/**
 * Kick: чтение чата без входа, по нику канала.
 * - Номер чата и онлайн берутся из публичной страницы канала kick.com/api/v2/channels/<ник>. Она закрыта Cloudflare
 *   для программ, поэтому открывается в скрытом окне-браузере (отдельный профиль, только kick.com, без доступа к системе).
 * - Сообщения и события — через публичный WebSocket (Pusher), которым пользуется сам сайт Kick. Это неофициальный путь:
 *   Kick может его поменять — тогда статус площадки покажет ошибку.
 * Отправка в чат требует собственного приложения Kick с секретом — позже, в режиме «Для опытных».
 */

const NICK = /^[A-Za-z0-9_.-]{1,40}$/
const FALLBACK = { key: '34bf7a0ff419a2a775b9', cluster: 'us2' }

type Json = Record<string, unknown>
const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

export class KickConnector implements ChatConnector {
  readonly id = 'kick' as const
  private ws: WebSocket | null = null
  private page: BrowserWindow | null = null
  private chatroomId: string | null = null
  private channelId: string | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private viewersTimer: NodeJS.Timeout | null = null
  private retryDelay = 3000
  private generation = 0
  private unknown = new Set<string>()
  live = false
  viewers: number | null = null
  onChange: () => void = () => undefined

  constructor(private hub: Hub, private settings: Settings, private img: ImageCache) {
    hub.register('kick', 'Kick')
  }

  private nick(): string {
    return this.settings.get().kick.channel
  }

  chatState(): ChatPlatformState {
    const nick = this.nick()
    return { id: 'kick', name: 'Kick', configured: !!nick, live: this.live, viewers: this.viewers, canSend: false, canModerate: false, account: nick || null }
  }

  async start(): Promise<void> {
    const nick = this.nick()
    if (!nick) return this.hub.setStatus('kick', 'off', 'Укажите ник канала Kick')
    if (!NICK.test(nick)) return this.hub.setStatus('kick', 'error', 'Ник канала содержит недопустимые символы')
    this.stop('connecting', 'Подключение…', false)
    const gen = ++this.generation
    try {
      await this.loadChannel(nick)
      if (!this.chatroomId) throw new Error('Канал не найден — проверьте ник')
      if (gen !== this.generation) return
      const pusher = await this.pusherConfig()
      if (gen !== this.generation) return
      this.connect(pusher, gen)
      this.viewersTimer = setInterval(() => void this.loadChannel(nick).catch(() => undefined), 60_000)
    } catch (e) {
      this.hub.setStatus('kick', 'error', (e as Error).message)
      this.scheduleRetry(gen)
    }
  }

  stop(state: 'off' | 'connecting' = 'off', detail = 'Отключено', bump = true): void {
    if (bump) this.generation++
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.viewersTimer) clearInterval(this.viewersTimer)
    this.retryTimer = this.viewersTimer = null
    const ws = this.ws
    this.ws = null
    ws?.close()
    if (state === 'off') {
      this.page?.destroy()
      this.page = null
    }
    this.live = false
    this.viewers = null
    this.hub.setStatus('kick', state, detail)
    this.onChange()
  }

  async restart(): Promise<void> {
    this.retryDelay = 3000
    this.stop('connecting', 'Перезапуск…')
    await this.start()
  }

  private scheduleRetry(gen: number): void {
    if (gen !== this.generation || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (gen === this.generation) void this.start()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 120_000)
  }

  /** Скрытое окно-браузер только для kick.com. */
  private browser(): BrowserWindow {
    if (this.page && !this.page.isDestroyed()) return this.page
    const w = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { partition: 'persist:kick', contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: true }
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const allowed = (u: string): boolean => {
      try {
        const h = new URL(u).host
        return h === 'kick.com' || h.endsWith('.kick.com') || h === 'challenges.cloudflare.com'
      } catch {
        return false
      }
    }
    w.webContents.on('will-navigate', (e, u) => { if (!allowed(u)) e.preventDefault() })
    w.webContents.on('will-redirect', (e, u) => { if (!allowed(u)) e.preventDefault() })
    w.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    this.page = w
    return w
  }

  /** Загрузить JSON канала через скрытое окно (Cloudflare пропускает настоящий браузер). */
  private async loadChannel(nick: string): Promise<void> {
    const w = this.browser()
    await w.loadURL(`https://kick.com/api/v2/channels/${encodeURIComponent(nick)}`).catch(() => undefined)
    let j: Json | null = null
    for (let i = 0; i < 20 && !j; i++) {
      const text = String(await w.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => ''))
      if (text.trim().startsWith('{')) {
        try {
          j = JSON.parse(text) as Json
        } catch {
          /* ещё грузится */
        }
      }
      if (!j) await new Promise((r) => setTimeout(r, 1000))
    }
    if (!j) throw new Error('Kick не отдал данные канала (защита Cloudflare?) — повторю позже')
    if (j.message && !j.id) throw new Error('Канал не найден — проверьте ник')
    const room = s(obj(j.chatroom).id)
    if (/^\d{1,15}$/.test(room)) this.chatroomId = room
    if (/^\d{1,15}$/.test(s(j.id))) this.channelId = s(j.id)
    const ls = obj(j.livestream)
    this.live = !!j.livestream && ls.is_live !== false
    this.viewers = this.live ? Number(ls.viewer_count) || 0 : null
    this.onChange()
  }

  /** Ключ Pusher: спрашиваем у Kick, при ошибке — известный запасной. */
  private async pusherConfig(): Promise<{ key: string; cluster: string }> {
    try {
      const res = await fetch('https://web.kick.com/api/v1/realtime/connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'pusher' }),
        signal: AbortSignal.timeout(10_000)
      })
      if (res.ok) {
        const j = (await res.json()) as Json
        const d = obj(j.data ?? j)
        const key = s(d.app_key ?? d.key)
        const cluster = s(d.cluster)
        if (/^[a-z0-9]{10,40}$/.test(key) && /^[a-z0-9-]{2,10}$/.test(cluster)) return { key, cluster }
      }
    } catch {
      /* запасной ключ */
    }
    return FALLBACK
  }

  private parts(content: string): MsgPart[] {
    const out: MsgPart[] = []
    for (const tok of content.split(/(\[emote:\d{1,15}:[^\]]{1,64}\])/)) {
      if (!tok) continue
      const m = /^\[emote:(\d{1,15}):([^\]]{1,64})\]$/.exec(tok)
      const url = m ? this.img.local(`https://files.kick.com/emotes/${m[1]}/fullsize`) : null
      if (m && url) out.push({ t: 'emote', v: m[2], url })
      else {
        const last = out[out.length - 1]
        if (last?.t === 'text') last.v += tok
        else out.push({ t: 'text', v: tok })
      }
    }
    this.img.warm(out.filter((p) => p.t === 'emote').map((p) => (p as { url: string }).url))
    return out
  }

  private connect(p: { key: string; cluster: string }, gen: number): void {
    const ws = new WebSocket(`wss://ws-${p.cluster}.pusher.com/app/${p.key}?protocol=7&client=js&version=8.4.0-rc2&flash=false`)
    this.ws = ws
    ws.onmessage = (m) => {
      if (gen !== this.generation) return
      let msg: { event?: string; channel?: string; data?: unknown }
      try {
        msg = JSON.parse(String(m.data))
      } catch {
        return
      }
      let data: Json = {}
      try {
        data = typeof msg.data === 'string' ? (JSON.parse(msg.data) as Json) : obj(msg.data)
      } catch {
        /* пусто */
      }
      this.onEvent(ws, s(msg.event), data)
    }
    ws.onclose = () => {
      if (gen !== this.generation || this.ws !== ws) return
      this.ws = null
      this.hub.setStatus('kick', 'connecting', 'Соединение с Kick потеряно — переподключение…')
      this.scheduleRetry(gen)
    }
    ws.onerror = () => undefined
  }

  private onEvent(ws: WebSocket, event: string, d: Json): void {
    const base = { platform: 'kick' as const }
    switch (event) {
      case 'pusher:connection_established':
        for (const ch of [`chatrooms.${this.chatroomId}.v2`, this.channelId ? `channel.${this.channelId}` : null]) {
          if (ch) ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }))
        }
        return
      case 'pusher_internal:subscription_succeeded':
        this.retryDelay = 3000
        this.hub.setStatus('kick', 'ok', `Подключено · ${this.nick()} · только чтение`)
        return
      case 'pusher:ping':
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }))
        return
      case 'pusher:error': {
        const code = Number(d.code)
        this.hub.log('kick', 'error', `Kick (Pusher): ${s(d.message) || 'ошибка'} ${code || ''}`)
        if (code === 4001) ws.close()
        return
      }
      case 'App\\Events\\ChatMessageEvent': {
        const sender = obj(d.sender)
        const identity = obj(sender.identity)
        const content = s(d.content)
        this.hub.push({
          ...base, type: 'message', id: `kick-${s(d.id)}`, user: s(sender.username), userId: s(sender.id),
          text: content.replace(/\[emote:\d+:([^\]]+)\]/g, '$1'), parts: this.parts(content), color: s(identity.color)
        })
        return
      }
      case 'App\\Events\\MessageDeletedEvent':
        this.hub.deleteMessage(`kick-${s(obj(d.message).id)}`)
        return
      case 'App\\Events\\UserBannedEvent':
        this.hub.deleteUserMessages('kick', s(obj(d.user).id))
        return
      case 'App\\Events\\ChatroomClearEvent':
        this.hub.clearChat('kick')
        return
      case 'App\\Events\\SubscriptionEvent':
        this.hub.push({ ...base, type: 'sub', user: s(d.username), text: d.months ? `${s(d.months)} мес.` : 'Подписка' })
        return
      case 'App\\Events\\GiftedSubscriptionsEvent': {
        const list = Array.isArray(d.gifted_usernames) ? d.gifted_usernames.length : 1
        this.hub.push({ ...base, type: 'gift', user: s(d.gifter_username) || 'Аноним', amount: list, text: `Подарил подписок: ${list}` })
        return
      }
      case 'App\\Events\\StreamHostEvent':
        this.hub.push({ ...base, type: 'raid', user: s(d.host_username), amount: Number(d.number_viewers) || 0, text: `${s(d.number_viewers)} зрителей` })
        return
      case 'App\\Events\\FollowersUpdated':
        if (d.followed === true && d.username) this.hub.push({ ...base, type: 'follow', user: s(d.username) })
        return
      case 'App\\Events\\StreamerIsLive':
        this.live = true
        this.onChange()
        return
      case 'App\\Events\\StopStreamBroadcast':
        this.live = false
        this.viewers = null
        this.onChange()
        return
      default:
        // Неизвестные события пишем в журнал один раз — пригодится, когда Kick что-то поменяет.
        if (event && !event.startsWith('pusher') && !this.unknown.has(event) && this.unknown.size < 30) {
          this.unknown.add(event)
          this.hub.log('kick', 'info', `Новый тип события Kick: ${event}`)
        }
    }
  }
}
