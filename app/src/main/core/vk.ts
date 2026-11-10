import type { Hub } from './hub'
import type { Settings } from './settings'
import type { ImageCache } from './imgcache'
import type { ChatConnector, ChatPlatformState } from './connector'
import type { Badge, MsgPart } from './types'

/**
 * VK Видео Live: чтение чата без входа, по нику канала (как в ссылке live.vkvideo.ru/ник).
 * - Гостевой токен для сокета сайт кладёт в HTML страницы канала (поле websocket.token).
 * - Каналы сокета (чат и инфо: онлайн, зрители) — из публичного API api.live.vkvideo.ru/v1/blog/<ник>/public_video_stream.
 * - Сообщения — через Centrifugo (wss://pubsub.live.vkvideo.ru), которым пользуется сам сайт. Это неофициальный путь:
 *   VK может его поменять — тогда статус площадки покажет ошибку, а новые типы событий попадут в журнал.
 * Отправка и модерация в официальном API VK не описаны — пока только чтение.
 */

const SITE = 'https://live.vkvideo.ru'
const API = 'https://api.live.vkvideo.ru/v1'
const WS_URL = 'wss://pubsub.live.vkvideo.ru/connection/websocket?cf_protocol_version=v2'
const NICK = /^[A-Za-z0-9_.-]{1,40}$/
const CHANNEL = /^channel-(chat|info):\d{1,15}$/
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

type Json = Record<string, unknown>
const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** 16 цветов ника VK (nickColor 0..15) — примерно как на сайте. */
const NICK_COLORS = ['#d66e34', '#b8aaff', '#1d90ff', '#9961f9', '#59a840', '#e73629', '#de6489', '#20bba1', '#f8b301', '#0099bb', '#7bbeff', '#e542ff', '#a36c59', '#8ba259', '#00a9ff', '#a20bff']

/** Текстовый блок VK хранит текст как JSON-строку вида ["текст","unstyled",[]]. */
function blockText(content: unknown): string {
  const c = s(content)
  if (!c.startsWith('[')) return c
  try {
    const j = JSON.parse(c) as unknown
    return Array.isArray(j) ? s(j[0]) : c
  } catch {
    return c
  }
}

export class VkConnector implements ChatConnector {
  readonly id = 'vk' as const
  private ws: WebSocket | null = null
  private chatChannel: string | null = null
  private infoChannel: string | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private viewersTimer: NodeJS.Timeout | null = null
  private retryDelay = 3000
  private generation = 0
  private unknown = new Set<string>()
  live = false
  viewers: number | null = null
  onChange: () => void = () => undefined

  constructor(private hub: Hub, private settings: Settings, private img: ImageCache) {
    hub.register('vk', 'VK Видео Live')
  }

  private nick(): string {
    return this.settings.get().vk.channel
  }

  chatState(): ChatPlatformState {
    const nick = this.nick()
    return { id: 'vk', name: 'VK Видео Live', configured: !!nick, live: this.live, viewers: this.viewers, canSend: false, canModerate: false, account: nick || null }
  }

  async start(): Promise<void> {
    const nick = this.nick()
    if (!nick) return this.hub.setStatus('vk', 'off', 'Укажите ник канала VK Видео Live')
    if (!NICK.test(nick)) return this.hub.setStatus('vk', 'error', 'Ник канала содержит недопустимые символы')
    this.stop('connecting', 'Подключение…', false)
    const gen = ++this.generation
    try {
      await this.loadStream(nick)
      const token = await this.guestToken(nick)
      if (gen !== this.generation) return
      this.connect(token, gen)
      this.viewersTimer = setInterval(() => void this.loadStream(nick).catch(() => undefined), 120_000)
    } catch (e) {
      this.hub.setStatus('vk', 'error', (e as Error).message)
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
    this.live = false
    this.viewers = null
    this.hub.setStatus('vk', state, detail)
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

  /** Каналы сокета, в эфире ли, зрители. */
  private async loadStream(nick: string): Promise<void> {
    const res = await fetch(`${API}/blog/${encodeURIComponent(nick)}/public_video_stream`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
    if (res.status === 404) throw new Error('Канал не найден — проверьте ник')
    if (!res.ok) throw new Error(`VK Видео Live API: ${res.status}`)
    const j = (await res.json()) as Json
    const chat = s(j.wsChatChannel)
    const info = s(j.wsStreamChannel)
    if (CHANNEL.test(chat)) this.chatChannel = chat
    if (CHANNEL.test(info)) this.infoChannel = info
    if (!this.chatChannel) throw new Error('У канала нет чата или VK поменял формат ответа')
    this.live = j.isOnline === true
    this.viewers = this.live ? Number(obj(j.count).viewers) || 0 : null
    this.onChange()
  }

  /** Гостевой токен сокета из HTML страницы канала. */
  private async guestToken(nick: string): Promise<string> {
    const res = await fetch(`${SITE}/${encodeURIComponent(nick)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru' }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`Страница канала VK: ${res.status}`)
    const html = await res.text()
    const m = /"websocket":\{[^{}]*?"token":"([A-Za-z0-9_\-.]{20,2000})"/.exec(html)
    if (!m) throw new Error('Не нашёл гостевой токен чата на странице VK — возможно, сайт изменился')
    return m[1]
  }

  private connect(token: string, gen: number): void {
    const ws = new WebSocket(WS_URL, { headers: { Origin: SITE, 'User-Agent': UA } } as unknown as string[])
    this.ws = ws
    let nextId = 1
    ws.onopen = () => ws.send(JSON.stringify({ connect: { token, name: 'js' }, id: nextId++ }))
    ws.onmessage = (m) => {
      if (gen !== this.generation) return
      // Centrifugo может прислать несколько JSON подряд через перевод строки.
      for (const line of String(m.data).split('\n')) {
        if (!line.trim()) continue
        let o: Json
        try {
          o = JSON.parse(line) as Json
        } catch {
          continue
        }
        if (Object.keys(o).length === 0) {
          ws.send('{}') // пинг сервера — отвечаем понгом
          continue
        }
        if (o.error) {
          const e = obj(o.error)
          this.hub.log('vk', 'error', `VK (сокет): ${s(e.message) || 'ошибка'} ${s(e.code)}`)
          if (o.connect === undefined && o.id === 1) ws.close()
          continue
        }
        if (o.connect) {
          for (const ch of [this.chatChannel, this.infoChannel]) if (ch) ws.send(JSON.stringify({ subscribe: { channel: ch }, id: nextId++ }))
          this.retryDelay = 3000
          this.hub.setStatus('vk', 'ok', `Подключено · ${this.nick()} · только чтение`)
          continue
        }
        const push = obj(o.push)
        const data = obj(obj(push.pub).data)
        if (push.channel && Object.keys(data).length) this.onEvent(s(push.channel), data)
      }
    }
    ws.onclose = () => {
      if (gen !== this.generation || this.ws !== ws) return
      this.ws = null
      this.hub.setStatus('vk', 'connecting', 'Соединение с VK потеряно — переподключение…')
      this.scheduleRetry(gen)
    }
    ws.onerror = () => undefined
  }

  /** Блоки сообщения → куски текста и смайлов. */
  private parts(blocks: unknown[]): { text: string; parts: MsgPart[] } {
    const out: MsgPart[] = []
    const add = (v: string): void => {
      if (!v) return
      const last = out[out.length - 1]
      if (last?.t === 'text') last.v += v
      else out.push({ t: 'text', v })
    }
    for (const raw of blocks) {
      const b = obj(raw)
      switch (s(b.type)) {
        case 'text':
          if (b.modificator === 'BLOCK_END') add(' ')
          else add(blockText(b.content).replace(/\u200b/g, ''))
          break
        case 'smile': {
          const name = s(b.name).slice(0, 64) || 'smile'
          const url = this.img.local(s(b.mediumUrl || b.largeUrl || b.smallUrl))
          if (url) out.push({ t: 'emote', v: `:${name}:`, url })
          else add(`:${name}:`)
          break
        }
        case 'mention':
          add(`@${s(b.displayName || b.nick || b.name)} `)
          break
        case 'link':
          add(blockText(b.content) || s(b.url))
          break
        default:
          if (b.content) add(blockText(b.content))
      }
    }
    for (const p of out) if (p.t === 'text') p.v = p.v.replace(/ {2,}/g, ' ')
    // Сайт иногда ставит перевод блока в конце — убираем хвостовые пробелы.
    const last = out[out.length - 1]
    if (last?.t === 'text') last.v = last.v.replace(/\s+$/, '')
    if (last?.t === 'text' && !last.v) out.pop()
    this.img.warm(out.filter((p) => p.t === 'emote').map((p) => (p as { url: string }).url))
    const text = out.map((p) => p.v).join('').trim()
    return { text, parts: out }
  }

  private badges(author: Json): Badge[] {
    const out: Badge[] = []
    for (const raw of arr(author.badges).slice(0, 6)) {
      const b = obj(raw)
      const url = this.img.local(s(b.smallUrl || b.mediumUrl))
      if (url) out.push({ title: s(b.name).slice(0, 60), url })
    }
    if (out.length) this.img.warm(out.map((b) => b.url))
    return out
  }

  private onEvent(channel: string, d: Json): void {
    const type = s(d.type)
    const base = { platform: 'vk' as const }
    switch (type) {
      case 'message': {
        const m = obj(d.data)
        const author = obj(m.author ?? m.user)
        const { text, parts } = this.parts(arr(m.data))
        if (!text && !parts.length) return
        const color = NICK_COLORS[Number(author.nickColor)]
        this.hub.push({
          ...base, type: 'message', id: `vk-${s(m.id) || Date.now()}`,
          user: s(author.displayName || author.nick || author.name), userId: s(author.id),
          text, parts, badges: this.badges(author), color
        })
        return
      }
      // Дубль того же сообщения в новом формате — уже обработан как 'message'.
      case 'message_v8':
        return
      // Модератор удалил сообщение / все сообщения пользователя (так обрабатывает их сам сайт).
      case 'delete_message': {
        const id = s(obj(d.data).id)
        if (/^\d{1,20}$/.test(id)) this.hub.deleteMessage(`vk-${id}`)
        return
      }
      case 'clean_chat_messages': {
        const uid = s(obj(d.data).userId)
        if (uid) this.hub.deleteUserMessages('vk', uid)
        return
      }
      case 'stream_online_status': {
        this.live = d.isOnline === true
        this.viewers = this.live ? Number(d.viewers) || 0 : null
        this.onChange()
        return
      }
      case 'stream_start':
        this.live = true
        this.onChange()
        return
      case 'stream_end':
        this.live = false
        this.viewers = null
        this.onChange()
        return
      case 'stream_slot_online_status':
      case 'stream_like_counter':
      case 'stream_slot_like_counter':
      case 'chat_ban': // бан приходит вместе с clean_chat_messages
      case 'prediction':
      case 'poll':
      case 'chat_pinned_message_pin':
      case 'chat_pinned_message_pin_v8':
      case 'chat_pinned_message_edit':
      case 'chat_pinned_message_edit_v8':
      case 'chat_pinned_message_unpin':
      case 'chat_pinned_message_reaction':
      case 'chat_pinned_message_reaction_v8':
        return
      default:
        // Неизвестные события — один раз в журнал: пригодится, когда VK что-то поменяет.
        if (type && !this.unknown.has(type) && this.unknown.size < 30) {
          this.unknown.add(type)
          this.hub.log('vk', 'info', `Новый тип события VK (${channel.split(':')[0]}): ${type}`)
        }
    }
  }
}
