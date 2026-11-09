import { createHash } from 'node:crypto'
import { Agent, request } from 'node:https'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Локальный кэш картинок смайлов и бейджей.
 * Зачем: у части пользователей (VPN, обход блокировок) каждое новое соединение с CDN занимает 1–3 секунды,
 * и смайлы появляются в чате с опозданием. Crossember скачивает картинки сам через постоянные соединения,
 * хранит на диске и отдаёт чату и оверлеям с локального сервера — мгновенно.
 *
 * Безопасность: скачиваются только URL, которые ядро само зарегистрировало, и только с разрешённых хостов;
 * ответ должен быть картинкой не больше 3 МБ; имена файлов — хэш, никаких путей из сети.
 */

const ALLOWED_HOSTS = new Set(['static-cdn.jtvnw.net', 'cdn.7tv.app', 'cdn.betterttv.net', 'cdn.frankerfacez.com', 'goodgame.ru', 'static.goodgame.ru', 'files.kick.com', 'images.live.vkvideo.ru'])
const MAX_BYTES = 3 * 1024 * 1024
// SVG не принимаем: в нём может быть скрипт.
const TYPES = ['image/png', 'image/gif', 'image/webp', 'image/avif', 'image/jpeg']

export class ImageCache {
  private agent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 })
  private urls = new Map<string, string>() // hash -> upstream url
  private inflight = new Map<string, Promise<{ type: string; body: Buffer } | null>>()
  private warmQueue: string[] = []
  private warming = 0

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  /** Зарегистрировать внешний URL и получить локальный путь /e/<hash>. null — хост не разрешён. */
  local(url: string): string | null {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return null
    }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.host)) return null
    const hash = createHash('sha256').update(u.href).digest('hex').slice(0, 32)
    this.urls.set(hash, u.href)
    return `/e/${hash}`
  }

  /** Открыть заранее соединения с CDN, чтобы первый смайл не ждал рукопожатия. */
  preconnect(): void {
    for (const host of ALLOWED_HOSTS) {
      const req = request({ host, path: '/', method: 'HEAD', agent: this.agent, timeout: 10_000 }, (res) => res.resume())
      req.on('error', () => undefined).on('timeout', () => req.destroy()).end()
    }
  }

  /** Поставить картинки в фоновую загрузку (уже скачанные пропускаются). */
  warm(paths: string[]): void {
    for (const p of paths) this.warmQueue.push(p.replace(/^\/e\//, ''))
    this.pump()
  }

  private pump(): void {
    while (this.warming < 6 && this.warmQueue.length) {
      const hash = this.warmQueue.shift()!
      this.warming++
      void this.get(hash).finally(() => {
        this.warming--
        this.pump()
      })
    }
  }

  /** Получить картинку: с диска или скачать. */
  async get(hash: string): Promise<{ type: string; body: Buffer } | null> {
    if (!/^[0-9a-f]{32}$/.test(hash)) return null
    const file = join(this.dir, hash)
    try {
      const [body, type] = await Promise.all([readFile(file), readFile(`${file}.type`, 'utf8')])
      if (TYPES.includes(type)) return { type, body }
    } catch {
      /* нет в кэше */
    }
    const url = this.urls.get(hash)
    if (!url) return null
    let p = this.inflight.get(hash)
    if (!p) {
      p = this.download(url)
        .then(async (r) => {
          if (r) {
            const tmp = `${file}.${process.pid}.tmp`
            await writeFile(tmp, r.body)
            await writeFile(`${file}.type`, r.type)
            await rename(tmp, file)
          }
          return r
        })
        .catch(() => null)
        .finally(() => this.inflight.delete(hash))
      this.inflight.set(hash, p)
    }
    return p
  }

  private download(url: string, redirects = 0): Promise<{ type: string; body: Buffer } | null> {
    return new Promise((resolve) => {
      const req = request(url, { agent: this.agent, timeout: 15_000, headers: { Accept: 'image/webp,image/avif,image/*' } }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
          res.resume()
          const next = new URL(res.headers.location, url)
          if (next.protocol === 'https:' && ALLOWED_HOSTS.has(next.host)) return resolve(this.download(next.href, redirects + 1))
          return resolve(null)
        }
        const type = String(res.headers['content-type'] ?? '').split(';')[0].trim()
        if (status !== 200 || !TYPES.includes(type)) {
          res.resume()
          return resolve(null)
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_BYTES) {
            req.destroy()
            resolve(null)
          } else chunks.push(c)
        })
        res.on('end', () => resolve(size <= MAX_BYTES ? { type, body: Buffer.concat(chunks) } : null))
        res.on('error', () => resolve(null))
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => {
        req.destroy()
        resolve(null)
      })
      req.end()
    })
  }
}
