import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import websocket, { type WebSocket } from '@fastify/websocket'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Hub } from './hub'
import type { Store } from './db'
import type { HubEvent, ServerInfo } from './types'

/** Оверлеи, которые отдаёт сервер. Имя файла = id, лежат в resources/overlays. */
const OVERLAYS = [
  { id: 'alert', name: 'Алерты (тест)', size: '1920 × 1080' }
] as const

/** Шрифты для оверлеев — только этот список файлов, никаких произвольных путей. */
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

const OVERLAY_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'"

function newKey(): string {
  return randomBytes(24).toString('base64url')
}

function sameKey(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Локальный сервер оверлеев. Слушает ТОЛЬКО 127.0.0.1.
 * Каждый запрос к оверлею и WebSocket требует ключ (?k=...), проверяется Host (защита от DNS-rebinding)
 * и Origin у WebSocket.
 */
export class OverlayServer {
  private app: FastifyInstance | null = null
  private sockets = new Set<WebSocket>()
  private key: string
  port: number

  constructor(private hub: Hub, private store: Store, private resourcesDir: string, private appDir: string) {
    this.port = store.get('server.port', 47832)
    this.key = store.get('server.overlayKey', '')
    if (!this.key) this.rotateKey()
    hub.on('event', (e: HubEvent) => this.broadcast({ kind: 'event', event: e }))
  }

  rotateKey(): void {
    this.key = newKey()
    this.store.set('server.overlayKey', this.key)
    for (const s of this.sockets) s.close(4001, 'key rotated')
  }

  info(): ServerInfo {
    const baseUrl = `http://127.0.0.1:${this.port}`
    return {
      port: this.port,
      baseUrl,
      overlays: OVERLAYS.map((o) => ({ ...o, url: `${baseUrl}/o/${o.id}?k=${this.key}` }))
    }
  }

  private hostOk(req: FastifyRequest): boolean {
    const host = req.headers.host
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg)
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.send(data)
  }

  async start(): Promise<void> {
    const app = Fastify({ logger: false, bodyLimit: 16 * 1024 })
    await app.register(websocket, { options: { maxPayload: 4 * 1024 } })

    app.addHook('onRequest', async (req, reply) => {
      reply.headers(SECURITY_HEADERS)
      if (!this.hostOk(req)) return reply.code(421).send({ error: 'bad host' })
    })

    app.get('/health', async () => ({ ok: true }))

    app.get<{ Params: { id: string }; Querystring: { k?: string } }>('/o/:id', async (req, reply) => {
      if (!sameKey(req.query.k, this.key)) return reply.code(403).type('text/plain').send('Нет доступа: неверный ключ оверлея')
      const o = OVERLAYS.find((x) => x.id === req.params.id)
      if (!o) return reply.code(404).send({ error: 'not found' })
      const html = await readFile(join(this.resourcesDir, 'overlays', `${o.id}.html`), 'utf8')
      return reply.header('Content-Security-Policy', OVERLAY_CSP).type('text/html; charset=utf-8').send(html)
    })

    app.get<{ Params: { file: string } }>('/f/:file', async (req, reply) => {
      const rel = FONTS[req.params.file]
      if (!rel) return reply.code(404).send({ error: 'not found' })
      const buf = await readFile(join(this.appDir, 'node_modules', rel))
      return reply.header('Cache-Control', 'max-age=86400').type('font/woff2').send(buf)
    })

    app.get<{ Querystring: { k?: string } }>('/ws', { websocket: true }, (socket, req) => {
      const origin = req.headers.origin
      const originOk = !origin || origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`
      if (!originOk || !sameKey(req.query.k, this.key)) {
        socket.close(4003, 'forbidden')
        return
      }
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      // Оверлеи только слушают; входящие сообщения игнорируем.
      socket.on('message', () => undefined)
    })

    await app.listen({ host: '127.0.0.1', port: this.port })
    this.app = app
    this.hub.setStatus('hub', 'ok', `Сервер оверлеев: 127.0.0.1:${this.port}`)
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.close()
    await this.app?.close()
  }
}
