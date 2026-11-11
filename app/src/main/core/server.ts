import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import websocket, { type WebSocket } from '@fastify/websocket'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Hub } from './hub'
import type { Store } from './db'
import type { Settings } from './settings'
import type { ImageCache } from './imgcache'
import type { HubEvent, ServerInfo } from './types'
import type { AlertEngine, AlertItem } from './alerts'
import type { Stats } from './stats'
import type { SoundLibrary } from './sounds'
import type { MediaLibrary } from './media'
import type { WindowsTts } from './tts'
import type { Counter, Counters } from './counters'

/** Оверлеи для OBS. id = имя файла в resources/overlays, key = ключ настроек. */
const OVERLAYS = [
  { id: 'alert', key: 'alert', name: 'Алерты', size: '1920 × 1080' },
  { id: 'chat', key: 'chat', name: 'Чат вертикальный', size: '500 × 900' },
  { id: 'chat-h', key: 'chatH', name: 'Чат горизонтальный', size: '1920 × 80' },
  { id: 'pinned', key: 'pinned', name: 'Закреплённое сообщение', size: '1200 × 300' },
  { id: 'top', key: 'top', name: 'Топ донатеров', size: '500 × 400' },
  { id: 'last', key: 'last', name: 'Последний донат', size: '800 × 140' },
  { id: 'counter', key: 'counter', name: 'Счётчики', size: '600 × 300' },
  // Окно «чат поверх игры» — открывается самим Crossember, в списке для OBS не показывается.
  { id: 'float', key: 'float', name: 'Чат поверх игры', size: '', hidden: true }
] as { id: string; key: string; name: string; size: string; hidden?: boolean }[]

/** Общие файлы оверлеев и пульта — только этот список. */
const ASSETS: Record<string, string> = {
  'overlay.css': 'text/css; charset=utf-8',
  'overlay.js': 'text/javascript; charset=utf-8',
  'alert.js': 'text/javascript; charset=utf-8',
  'alertkit.js': 'text/javascript; charset=utf-8',
  'alertkit.css': 'text/css; charset=utf-8',
  'chat.js': 'text/javascript; charset=utf-8',
  'pinned.js': 'text/javascript; charset=utf-8',
  'remote.js': 'text/javascript; charset=utf-8',
  'top.js': 'text/javascript; charset=utf-8',
  'last.js': 'text/javascript; charset=utf-8',
  'counter.js': 'text/javascript; charset=utf-8',
  'sounds.js': 'text/javascript; charset=utf-8'
}

/** Шрифты — только этот список файлов, никаких произвольных путей. */
const FONTS: Record<string, string> = {
  'unbounded-800-cyr.woff2': '@fontsource/unbounded/files/unbounded-cyrillic-800-normal.woff2',
  'unbounded-800-lat.woff2': '@fontsource/unbounded/files/unbounded-latin-800-normal.woff2',
  'manrope-600-cyr.woff2': '@fontsource/manrope/files/manrope-cyrillic-600-normal.woff2',
  'manrope-600-lat.woff2': '@fontsource/manrope/files/manrope-latin-600-normal.woff2',
  'manrope-800-cyr.woff2': '@fontsource/manrope/files/manrope-cyrillic-800-normal.woff2',
  'manrope-800-lat.woff2': '@fontsource/manrope/files/manrope-latin-800-normal.woff2'
}


const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
}

const PAGE_CSP = `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'`

const newKey = (): string => randomBytes(24).toString('base64url')

function sameKey(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !b) return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Адреса этого ПК в домашней сети (только частные диапазоны). */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address)
    }
  }
  return out
}

/** Движок алертов, статистика и звуки (этап 3). */
export interface OverlayExtras {
  alerts: AlertEngine
  stats: Stats
  sounds: SoundLibrary
  media: MediaLibrary
  tts: WindowsTts
  counters: Counters
}

export interface RemoteActions {
  send: (text: string) => Promise<void>
  pin: (id: string | null) => void
}

type Kind = 'local' | 'lan'

/**
 * Сервер Crossember.
 * - local: оверлеи для OBS, слушает ТОЛЬКО 127.0.0.1, ключ оверлеев, только чтение.
 * - lan: страница чата для второго ПК, слушает выбранный адрес домашней сети, отдельный ключ пульта.
 * Везде: ключ в каждом запросе (сравнение за постоянное время), проверка Host (DNS-rebinding) и Origin у WebSocket.
 */
export class OverlayServer {
  private local: FastifyInstance | null = null
  private lan: FastifyInstance | null = null
  private sockets = new Map<WebSocket, Kind>()
  /** Какой оверлей открыт в каком сокете (чтобы знать, есть ли кому показать алерт). */
  private socketOverlay = new Map<WebSocket, string>()
  /** Где открыта копия оверлея и видна ли она — для выбора «главной» копии алертов (она одна играет звук). */
  private socketMeta = new Map<WebSocket, { obs: boolean; visible: boolean; since: number; main: boolean | null }>()
  /** Изменилось число открытых оверлеев. */
  onClients: () => void = () => undefined
  private overlayKey: string
  private remoteKey: string
  private lanError: string | null = null
  private lanUrl: string | null = null
  /** Отпечаток файлов оверлеев: изменился (новая версия Crossember) — открытые оверлеи перезагрузятся сами. */
  private overlayBuild = ''
  port: number

  constructor(
    private hub: Hub,
    private store: Store,
    private settings: Settings,
    private images: ImageCache,
    private resourcesDir: string,
    private appDir: string,
    private actions: RemoteActions,
    private extras: OverlayExtras
  ) {
    this.port = store.get('server.port', 47832)
    this.overlayKey = store.get('server.overlayKey', '') || this.rotate('overlay')
    this.remoteKey = store.get('server.remoteKey', '') || this.rotate('remote')
    hub.on('event', (e: HubEvent) => this.broadcast({ kind: 'event', event: e }))
    hub.on('delete', (d: unknown) => this.broadcast({ kind: 'delete', ...(d as object) }))
    hub.on('pinned', (m: HubEvent | null) => this.broadcast({ kind: 'pinned', event: m }))
    // Алерты идут только в оверлеи (local), пульту второго ПК они не нужны.
    extras.alerts.on('play', (a: AlertItem) => this.broadcast({ kind: 'alert', alert: a, at: Date.now() }, 'local'))
    extras.alerts.on('end', (id: string) => this.broadcast({ kind: 'alert-end', id }, 'local'))
    extras.counters.on('change', (list: Counter[]) => this.broadcast({ kind: 'counters', counters: list }, 'local'))
    hub.on('event', (e: HubEvent) => {
      if (e.type !== 'message' && e.type !== 'system' && !e.test) this.pushStats()
    })
  }

  private statsData(): unknown {
    const t = this.settings.get().overlays.top
    return this.extras.stats.overlay(t.period, t.count)
  }

  /** Обновить оверлеи «Топ донатеров» и «Последний донат». */
  pushStats(): void {
    this.broadcast({ kind: 'stats', stats: this.statsData() }, 'local')
  }

  rotate(which: 'overlay' | 'remote'): string {
    const k = newKey()
    if (which === 'overlay') this.overlayKey = k
    else this.remoteKey = k
    this.store.set(which === 'overlay' ? 'server.overlayKey' : 'server.remoteKey', k)
    for (const [s, kind] of this.sockets) if ((kind === 'local') === (which === 'overlay')) s.close(4001, 'key rotated')
    if (which === 'remote' && this.lanUrl) this.lanUrl = this.lanUrl.replace(/k=.*$/, `k=${k}`)
    return k
  }

  /** Сообщить оверлеям о новых настройках (тема, размер шрифта…). */
  pushConfig(): void {
    const s = this.settings.get()
    this.broadcast({ kind: 'config', overlays: { ...s.overlays, float: s.float } })
    this.pushStats()
  }

  info(): ServerInfo {
    const baseUrl = `http://127.0.0.1:${this.port}`
    return {
      port: this.port,
      baseUrl,
      overlayKey: this.overlayKey,
      overlays: OVERLAYS.filter((o) => !o.hidden).map((o) => ({ id: o.id, name: o.name, size: o.size, url: `${baseUrl}/o/${o.id}?k=${this.overlayKey}` })),
      lan: { running: !!this.lan, url: this.lanUrl, error: this.lanError, addresses: lanAddresses() }
    }
  }

  private broadcast(msg: unknown, only?: Kind): void {
    const data = JSON.stringify(msg)
    for (const [s, kind] of this.sockets) if ((!only || kind === only) && s.readyState === s.OPEN) s.send(data)
  }

  /**
   * Выбрать «главную» копию оверлея «Алерты»: видимая важнее скрытой, OBS важнее браузера, при равенстве — открытая раньше.
   * Только она играет звук и озвучку, остальные показывают молча.
   */
  private electMain(): void {
    let best: WebSocket | null = null
    for (const [sock, ov] of this.socketOverlay) {
      if (ov !== 'alert') continue
      const m = this.socketMeta.get(sock)
      if (!m) continue
      const b = best ? this.socketMeta.get(best)! : null
      if (!b || (m.visible !== b.visible ? m.visible : m.obs !== b.obs ? m.obs : m.since < b.since)) best = sock
    }
    for (const [sock, m] of this.socketMeta) {
      const main = sock === best
      if (main === m.main) continue
      m.main = main
      if (sock.readyState === sock.OPEN) sock.send(JSON.stringify({ kind: 'role', main }))
    }
  }

  private hello(kind: Kind, ov = ''): string {
    const s = this.settings.get()
    return JSON.stringify({
      kind: 'hello',
      build: this.overlayBuild,
      role: kind === 'lan' ? 'remote' : 'overlay',
      overlays: { ...s.overlays, float: s.float },
      chat: this.hub.recentChat().slice(0, 50),
      events: kind === 'lan' ? this.hub.recent().slice(0, 30) : [],
      pinned: this.hub.pinned,
      ...(kind === 'local' ? { stats: this.statsData(), counters: this.extras.counters.list() } : {}),
      // Снимок для оверлея алертов после (пере)подключения: что идёт сейчас и с какого момента.
      ...(ov === 'alert' ? { alert: this.extras.alerts.nowPlaying() } : {})
    })
  }

  private async build(kind: Kind, host: string, port: number): Promise<FastifyInstance> {
    const app = Fastify({ logger: false, bodyLimit: 16 * 1024 })
    await app.register(websocket, { options: { maxPayload: 4 * 1024 } })
    const allowedHosts = kind === 'local' ? [`127.0.0.1:${port}`, `localhost:${port}`] : [`${host}:${port}`]
    const origins = allowedHosts.map((h) => `http://${h}`)
    const key = (): string => (kind === 'local' ? this.overlayKey : this.remoteKey)
    const asset = async (rel: string): Promise<string> => readFile(join(this.resourcesDir, 'overlays', rel), 'utf8')

    app.addHook('onRequest', async (req: FastifyRequest, reply) => {
      reply.headers(SECURITY_HEADERS)
      if (!allowedHosts.includes(req.headers.host ?? '')) return reply.code(421).send({ error: 'bad host' })
    })

    app.get('/health', async () => ({ ok: true }))

    if (kind === 'local') {
      app.get<{ Params: { id: string }; Querystring: { k?: string } }>('/o/:id', async (req, reply) => {
        if (!sameKey(req.query.k, key())) return reply.code(403).type('text/plain; charset=utf-8').send('Нет доступа: неверный ключ оверлея')
        const o = OVERLAYS.find((x) => x.id === req.params.id)
        if (!o) return reply.code(404).send({ error: 'not found' })
        return reply.header('Content-Security-Policy', PAGE_CSP).type('text/html; charset=utf-8').send(await asset(`${o.id}.html`))
      })
    } else {
      app.get<{ Querystring: { k?: string } }>('/remote', async (req, reply) => {
        if (!sameKey(req.query.k, key())) return reply.code(403).type('text/plain; charset=utf-8').send('Нет доступа: неверный ключ. Скопируйте ссылку заново в Crossember → Настройки → Второй ПК.')
        return reply.header('Content-Security-Policy', PAGE_CSP).type('text/html; charset=utf-8').send(await asset('remote.html'))
      })
    }

    app.get<{ Params: { file: string } }>('/a/:file', async (req, reply) => {
      const type = ASSETS[req.params.file]
      if (!type) return reply.code(404).send({ error: 'not found' })
      return reply.type(type).send(await asset(req.params.file))
    })

    // Смайлы и бейджи из локального кэша (без ключа: это публичные картинки; Host всё равно проверяется).
    app.get<{ Params: { hash: string } }>('/e/:hash', async (req, reply) => {
      const img = await this.images.get(req.params.hash)
      if (!img) return reply.code(404).send({ error: 'not found' })
      return reply.header('Cache-Control', 'public, max-age=604800, immutable').header('Cross-Origin-Resource-Policy', 'cross-origin').type(img.type).send(img.body)
    })

    // Свои звуки алертов — только для оверлеев, с ключом.
    if (kind === 'local') {
      app.get<{ Params: { file: string }; Querystring: { k?: string } }>('/s/:file', async (req, reply) => {
        if (!sameKey(req.query.k, key())) return reply.code(403).send({ error: 'forbidden' })
        const snd = await this.extras.sounds.get(req.params.file)
        if (!snd) return reply.code(404).send({ error: 'not found' })
        return reply.header('Cross-Origin-Resource-Policy', 'cross-origin').type(snd.type).send(snd.body)
      })
      // Картинки и видео конструктора (с ключом; видео браузер просит кусками — Range).
      app.get<{ Params: { file: string }; Querystring: { k?: string } }>('/m/:file', async (req, reply) => {
        if (!sameKey(req.query.k, key())) return reply.code(403).send({ error: 'forbidden' })
        const range = typeof req.headers.range === 'string' ? req.headers.range : undefined
        const m = await this.extras.media.get(req.params.file, range)
        if (!m) return reply.code(range ? 416 : 404).send({ error: 'not found' })
        reply.header('Cross-Origin-Resource-Policy', 'cross-origin').header('Accept-Ranges', 'bytes').type(m.type)
        if (range) reply.code(206).header('Content-Range', `bytes ${m.start}-${m.end}/${m.size}`)
        return reply.send(m.body)
      })
      // Готовая озвучка.
      app.get<{ Params: { file: string }; Querystring: { k?: string } }>('/t/:file', async (req, reply) => {
        if (!sameKey(req.query.k, key())) return reply.code(403).send({ error: 'forbidden' })
        const body = await this.extras.tts.get(req.params.file)
        if (!body) return reply.code(404).send({ error: 'not found' })
        return reply.header('Cross-Origin-Resource-Policy', 'cross-origin').type('audio/wav').send(body)
      })
    }

    app.get<{ Params: { file: string } }>('/f/:file', async (req, reply) => {
      const rel = FONTS[req.params.file]
      if (!rel) return reply.code(404).send({ error: 'not found' })
      return reply.header('Cache-Control', 'max-age=86400').type('font/woff2').send(await readFile(join(this.appDir, 'node_modules', rel)))
    })

    app.get<{ Querystring: { k?: string } }>('/ws', { websocket: true }, (socket, req) => {
      const origin = req.headers.origin
      if ((origin && !origins.includes(origin)) || !sameKey(req.query.k, key())) {
        socket.close(4003, 'forbidden')
        return
      }
      this.sockets.set(socket, kind)
      const ov = typeof (req.query as { o?: unknown }).o === 'string' ? String((req.query as { o?: unknown }).o).slice(0, 20) : ''
      if (kind === 'local' && ov) this.socketOverlay.set(socket, ov)
      this.onClients()
      socket.on('close', () => {
        this.sockets.delete(socket)
        this.socketOverlay.delete(socket)
        if (this.socketMeta.delete(socket)) this.electMain()
        this.onClients()
      })
      socket.send(this.hello(kind, ov))
      if (kind === 'local') {
        // Оверлеи только слушают; единственное, что они сообщают, — где открыты и видны ли (для оверлея «Алерты»).
        if (ov !== 'alert') {
          socket.on('message', () => undefined)
          return
        }
        let count = 0
        const since = Date.now()
        const reset = setInterval(() => { count = 0 }, 10_000)
        socket.on('close', () => clearInterval(reset))
        socket.on('message', (raw: Buffer) => {
          if (++count > 30 || raw.length > 200) return
          let m: { kind?: unknown; obs?: unknown; visible?: unknown }
          try {
            m = JSON.parse(raw.toString('utf8'))
          } catch {
            return
          }
          // main: null — роль этой копии ещё не сообщали.
          const meta = this.socketMeta.get(socket) ?? { obs: false, visible: true, since, main: null }
          if (m.kind === 'hi') meta.obs = m.obs === true
          else if (m.kind !== 'vis') return
          if (typeof m.visible === 'boolean') meta.visible = m.visible
          this.socketMeta.set(socket, meta)
          this.electMain()
        })
        return
      }
      // Пульт второго ПК: только два действия, с ограничением частоты.
      let last = 0
      socket.on('message', (raw: Buffer) => {
        const now = Date.now()
        if (now - last < 500) return
        last = now
        let m: { kind?: unknown; text?: unknown; id?: unknown }
        try {
          m = JSON.parse(raw.toString('utf8'))
        } catch {
          return
        }
        if (m.kind === 'send' && typeof m.text === 'string') {
          this.actions.send(m.text.slice(0, 500)).catch((e) => socket.send(JSON.stringify({ kind: 'error', text: (e as Error).message })))
        } else if (m.kind === 'pin' && (m.id === null || (typeof m.id === 'string' && m.id.length <= 100))) {
          this.actions.pin(m.id as string | null)
        }
      })
    })

    await app.listen({ host, port })
    return app
  }

  async start(): Promise<void> {
    try {
      const dir = join(this.resourcesDir, 'overlays')
      const h = createHash('md5')
      for (const f of (await readdir(dir)).sort()) h.update(f).update(await readFile(join(dir, f)))
      this.overlayBuild = h.digest('hex').slice(0, 12)
    } catch {
      this.overlayBuild = String(Date.now())
    }
    this.local = await this.build('local', '127.0.0.1', this.port)
    this.hub.setStatus('hub', 'ok', `Сервер оверлеев: 127.0.0.1:${this.port}`)
    await this.applyLan()
  }

  /** Сколько копий оверлея открыто (в OBS, браузере). */
  openCount(id: string): number {
    let n = 0
    for (const v of this.socketOverlay.values()) if (v === id) n++
    return n
  }

  /** Ссылка на оверлей по id (для окна «чат поверх игры»). */
  overlayUrl(id: string): string {
    return `http://127.0.0.1:${this.port}/o/${id}?k=${this.overlayKey}`
  }

  /** Включить/выключить/перезапустить сервер «Чат на другом устройстве» (любой режим). */
  async applyLan(): Promise<void> {
    const s = this.settings.get()
    const want = s.lan.enabled && !!s.lan.host
    if (this.lan) {
      for (const [sock, kind] of this.sockets) if (kind === 'lan') sock.close()
      await this.lan.close().catch(() => undefined)
      this.lan = null
      this.lanUrl = null
    }
    this.lanError = null
    if (!want) return
    if (!lanAddresses().includes(s.lan.host)) {
      this.lanError = `Адрес ${s.lan.host} не найден на этом ПК — выберите другой`
      this.hub.log('hub', 'error', this.lanError)
      return
    }
    try {
      this.lan = await this.build('lan', s.lan.host, s.lan.port)
      this.lanUrl = `http://${s.lan.host}:${s.lan.port}/remote?k=${this.remoteKey}`
      this.hub.log('hub', 'info', `Чат для второго ПК доступен: ${s.lan.host}:${s.lan.port}`)
    } catch (e) {
      this.lanError = `Не удалось открыть порт ${s.lan.port}: ${(e as Error).message}`
      this.hub.log('hub', 'error', this.lanError)
    }
  }

  async stop(): Promise<void> {
    for (const s of this.sockets.keys()) s.close()
    await this.lan?.close()
    await this.local?.close()
  }
}
