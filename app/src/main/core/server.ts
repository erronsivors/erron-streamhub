import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import websocket, { type WebSocket } from '@fastify/websocket'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Hub } from './hub'
import type { Store } from './db'
import type { Settings } from './settings'
import type { ImageCache } from './imgcache'
import type { HubEvent, ServerInfo } from './types'

/** Оверлеи для OBS. id = имя файла в resources/overlays, key = ключ настроек. */
const OVERLAYS = [
  { id: 'alert', key: 'alert', name: 'Алерты', size: '1920 × 1080' },
  { id: 'chat', key: 'chat', name: 'Чат вертикальный', size: '500 × 900' },
  { id: 'chat-h', key: 'chatH', name: 'Чат горизонтальный', size: '1920 × 80' },
  { id: 'pinned', key: 'pinned', name: 'Закреплённое сообщение', size: '1200 × 300' }
] as const

/** Общие файлы оверлеев и пульта — только этот список. */
const ASSETS: Record<string, string> = {
  'overlay.css': 'text/css; charset=utf-8',
  'overlay.js': 'text/javascript; charset=utf-8',
  'alert.js': 'text/javascript; charset=utf-8',
  'chat.js': 'text/javascript; charset=utf-8',
  'pinned.js': 'text/javascript; charset=utf-8',
  'remote.js': 'text/javascript; charset=utf-8'
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
  private overlayKey: string
  private remoteKey: string
  private lanError: string | null = null
  private lanUrl: string | null = null
  port: number

  constructor(
    private hub: Hub,
    private store: Store,
    private settings: Settings,
    private images: ImageCache,
    private resourcesDir: string,
    private appDir: string,
    private actions: RemoteActions
  ) {
    this.port = store.get('server.port', 47832)
    this.overlayKey = store.get('server.overlayKey', '') || this.rotate('overlay')
    this.remoteKey = store.get('server.remoteKey', '') || this.rotate('remote')
    hub.on('event', (e: HubEvent) => this.broadcast({ kind: 'event', event: e }))
    hub.on('delete', (d: unknown) => this.broadcast({ kind: 'delete', ...(d as object) }))
    hub.on('pinned', (m: HubEvent | null) => this.broadcast({ kind: 'pinned', event: m }))
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
    this.broadcast({ kind: 'config', overlays: this.settings.get().overlays })
  }

  info(): ServerInfo {
    const baseUrl = `http://127.0.0.1:${this.port}`
    return {
      port: this.port,
      baseUrl,
      overlays: OVERLAYS.map((o) => ({ id: o.id, name: o.name, size: o.size, url: `${baseUrl}/o/${o.id}?k=${this.overlayKey}` })),
      lan: { running: !!this.lan, url: this.lanUrl, error: this.lanError, addresses: lanAddresses() }
    }
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg)
    for (const s of this.sockets.keys()) if (s.readyState === s.OPEN) s.send(data)
  }

  private hello(kind: Kind): string {
    const s = this.settings.get()
    return JSON.stringify({
      kind: 'hello',
      role: kind === 'lan' ? 'remote' : 'overlay',
      overlays: s.overlays,
      chat: this.hub.recentChat().slice(0, 50),
      events: kind === 'lan' ? this.hub.recent().slice(0, 30) : [],
      pinned: this.hub.pinned
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
      socket.on('close', () => this.sockets.delete(socket))
      socket.send(this.hello(kind))
      if (kind === 'local') {
        socket.on('message', () => undefined) // оверлеи только слушают
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
    this.local = await this.build('local', '127.0.0.1', this.port)
    this.hub.setStatus('hub', 'ok', `Сервер оверлеев: 127.0.0.1:${this.port}`)
    await this.applyLan()
  }

  /** Включить/выключить/перезапустить LAN-сервер по текущим настройкам (только в режиме «2 ПК»). */
  async applyLan(): Promise<void> {
    const s = this.settings.get()
    const want = s.setupMode === 'two' && s.lan.enabled && !!s.lan.host
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
