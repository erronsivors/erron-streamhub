import { createServer, type Server } from 'node:http'
import type { Platform } from '../types'

/** Состояние сервиса донатов для интерфейса (без токенов). */
export interface DonationServiceState {
  id: Platform
  /** Имя подключённого аккаунта. */
  account: string | null
  /** Идёт вход (открыт браузер / окно входа). */
  pending: boolean
  /** Есть ли общий/свой ID приложения для входа через сайт. */
  canLogin: boolean
  /** Как подключено: вход через сайт, личный токен, API-ключ. */
  method: 'oauth' | 'token' | 'key' | null
}

/** Сервис донатов: тот же жизненный цикл, что у площадок с чатом. */
export interface DonationConnector {
  readonly id: Platform
  start(): Promise<void>
  stop(): void
  restart(): Promise<void>
  state(): DonationServiceState
  logout(): Promise<void>
  onChange: () => void
}

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

/** fetch с таймаутом и понятной ошибкой. */
export async function http(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    throw new Error(ctrl.signal.aborted ? 'сервер не ответил вовремя' : `нет связи (${(e as Error).message})`)
  } finally {
    clearTimeout(t)
  }
}

export async function json<T = unknown>(r: Response): Promise<T> {
  const text = await r.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`неожиданный ответ сервера (HTTP ${r.status})`)
  }
}

const PAGE = (title: string, body: string, script = ''): string =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Crossember</title>
<style>body{font:16px system-ui,sans-serif;background:#0f0b0a;color:#f3e9e2;display:grid;place-items:center;height:100vh;margin:0}
div{max-width:460px;text-align:center}h1{font-size:22px}</style></head><body><div><h1>${title}</h1><p id="m">${body}</p></div>${script}</body></html>`

export const DONE_PAGE = PAGE('Готово', 'Вход выполнен. Вкладку можно закрыть и вернуться в Crossember.')
export const FAIL_PAGE = (why: string): string => PAGE('Не получилось', why.replace(/[<>&"]/g, ''))

/**
 * Страница-приёмник для OAuth implicit: токен приходит во фрагменте (#access_token=…), который браузер
 * не отправляет на сервер. Скрипт страницы пересылает фрагмент POST-запросом на тот же адрес 127.0.0.1.
 */
export const FRAGMENT_PAGE = PAGE('Секунду…', 'Передаём вход в Crossember…', `<script>
fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: location.hash.slice(1) })
  .then(r => r.text()).then(t => { document.getElementById('m').textContent = t; history.replaceState(null, '', location.pathname); })
  .catch(() => { document.getElementById('m').textContent = 'Не удалось связаться с Crossember. Он запущен?'; });
</script>`)

/**
 * Временный приёмник входа на 127.0.0.1:<port>. Слушает только этот ПК и закрывается сразу после входа
 * или через 10 минут. handler получает путь, метод, query и тело; возвращает HTML или текст.
 */
export function loopback(
  port: number,
  handler: (req: { path: string; method: string; query: URLSearchParams; body: string }) => Promise<{ html?: string; text?: string; done?: boolean }>
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    let srv: Server | null = createServer((req, res) => {
      const host = req.headers.host ?? ''
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(421).end()
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      let body = ''
      req.on('data', (c: Buffer) => {
        if (body.length < 8192) body += c.toString('utf8')
      })
      req.on('end', () => {
        handler({ path: url.pathname, method: req.method ?? 'GET', query: url.searchParams, body })
          .then((r) => {
            res.writeHead(200, {
              'Content-Type': r.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer'
            })
            res.end(r.html ?? r.text ?? '')
            if (r.done) setTimeout(close, 500)
          })
          .catch((e) => {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end((e as Error).message)
          })
      })
    })
    const timer = setTimeout(() => close(), 10 * 60_000)
    const close = (): void => {
      clearTimeout(timer)
      srv?.close()
      srv = null
    }
    srv.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new Error(e.code === 'EADDRINUSE' ? `порт ${port} занят другой программой — закройте её и попробуйте снова` : e.message))
    })
    srv.listen(port, '127.0.0.1', () => resolve({ close }))
  })
}

/** Публикация в канале Centrifugo. */
export type CentrifugePublish = (channel: string, data: unknown) => void

/**
 * Минимальный клиент Centrifugo (JSON). Понимает протокол v2 («id/method/params», публикации в result.data.data)
 * и новый формат (push.pub.data) — DonationAlerts и DonatePay используют разные версии.
 */
export class CentrifugeClient {
  private ws: WebSocket | null = null
  private seq = 1
  private pingTimer: NodeJS.Timeout | null = null
  private serverPings = false
  private closedByUs = false
  /** id команд subscribe, ждущих ответа → имя канала. */
  private subs = new Map<number, string>()

  constructor(
    private url: string,
    private opts: {
      token: string
      /** После подключения: вернуть каналы с токенами подписки. */
      subscribe: (client: string) => Promise<{ channel: string; token?: string }[]>
      onPublish: CentrifugePublish
      onReady: () => void
      onClose: (reason: string) => void
      onError: (text: string) => void
    }
  ) {}

  connect(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: this.seq++, params: { token: this.opts.token } }))
    }
    ws.onmessage = (m) => {
      const raw = typeof m.data === 'string' ? m.data : ''
      for (const line of raw.split('\n')) if (line.trim()) this.frame(line)
    }
    ws.onclose = (c) => {
      this.stopPing()
      if (!this.closedByUs) this.opts.onClose(c.reason || `соединение закрыто (код ${c.code})`)
    }
    ws.onerror = () => undefined
  }

  private frame(line: string): void {
    let f: Record<string, any>
    try {
      f = JSON.parse(line)
    } catch {
      return
    }
    // Пинг сервера (новые версии): пустой объект → ответить пустым объектом.
    if (Object.keys(f).length === 0) {
      this.serverPings = true
      this.ws?.send('{}')
      return
    }
    if (f.error) {
      const ch = typeof f.id === 'number' ? this.subs.get(f.id) : undefined
      this.opts.onError(`Centrifugo${ch ? ` (подписка ${ch})` : ''}: ${f.error.message ?? JSON.stringify(f.error)}`)
      return
    }
    // Ответ на subscribe: сервер подтвердил подписку на канал.
    if (typeof f.id === 'number' && this.subs.has(f.id)) {
      this.subs.delete(f.id)
      if (this.subs.size === 0) this.opts.onReady()
      return
    }
    // Ответ на connect (id 1): result.client (v2) или connect.client (новый формат).
    const client = f.id === 1 ? (f.result?.client ?? f.connect?.client) : undefined
    if (client) {
      this.startPing()
      this.opts
        .subscribe(String(client))
        .then((subs) => {
          if (!subs.length) throw new Error('сервер не выдал ни одного канала')
          for (const s of subs) {
            const id = this.seq++
            this.subs.set(id, s.channel)
            this.ws?.send(JSON.stringify({ id, method: 1, params: { channel: s.channel, token: s.token } }))
          }
        })
        .catch((e) => {
          this.opts.onError(`подписка не удалась: ${(e as Error).message}`)
          this.ws?.close()
        })
      return
    }
    // Публикация: v2 — result без id {channel, data:{data}}; новый формат — push {channel, pub:{data}}.
    // v2: служебные события канала (вход/выход клиента и т.п.) имеют type ≠ 0 — это не публикации.
    if (f.id === undefined && f.result?.type !== undefined && f.result.type !== 0) return
    if (f.id === undefined && f.result?.channel && f.result?.data) {
      this.opts.onPublish(f.result.channel, f.result.data.data ?? f.result.data)
    } else if (f.push?.channel && f.push.pub) {
      this.opts.onPublish(f.push.channel, f.push.pub.data)
    } else if (f.id === undefined) {
      // Для диагностики: только имена полей, без содержимого.
      this.opts.onError(`неизвестное сообщение сервера: ${Object.keys(f.result ?? f.push ?? f).join(', ')}`)
    }
  }

  private startPing(): void {
    this.stopPing()
    // v2: клиент сам шлёт ping (method 7). Если сервер пингует сам — молчим.
    this.pingTimer = setInterval(() => {
      if (!this.serverPings && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ id: this.seq++, method: 7 }))
    }, 25_000)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  close(): void {
    this.closedByUs = true
    this.stopPing()
    this.ws?.close()
    this.ws = null
  }
}

/** Повторное подключение с нарастающей паузой: 3 с, 6 с, 12 с … до 2 минут. */
export class Backoff {
  private n = 0
  private timer: NodeJS.Timeout | null = null
  schedule(fn: () => void): number {
    const delay = Math.min(120_000, 3000 * 2 ** this.n++)
    this.cancel()
    this.timer = setTimeout(fn, delay)
    return Math.round(delay / 1000)
  }
  reset(): void {
    this.n = 0
  }
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
