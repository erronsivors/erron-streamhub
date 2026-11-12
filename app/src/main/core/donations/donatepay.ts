import type { Hub } from '../hub'
import type { Secrets } from '../secrets'
import type { Store } from '../db'
import { Backoff, CentrifugeClient, http, json, type DonationConnector, type DonationServiceState } from './common'

const API = 'https://donatepay.ru/api'
const WS = 'wss://centrifugo.donatepay.ru/connection/websocket'
const SECRET_KEY = 'donatepay.key'
/** DonatePay разрешает один запрос к API раз в 20 секунд. */
const MIN_GAP = 21_000
/** Размер страницы при дочитывании и сколько страниц максимум за одну проверку. */
const PAGE = 25
const MAX_PAGES = 8

interface Tx {
  id: number
  what?: string
  sum?: string | number
  comment?: string
  status?: string
  type?: string
  vars?: { name?: string; comment?: string; currency?: string }
}

/**
 * DonatePay: личный API-ключ стримера (OAuth у сервиса нет).
 * Новые донаты — опросом /v1/transactions (не чаще раза в 20 с); сокет Centrifugo служит только «звонком»,
 * чтобы проверить сразу, а не ждать следующего опроса. Повторы отсекаются по id транзакции.
 */
export class DonatePayConnector implements DonationConnector {
  readonly id = 'donatepay' as const
  onChange: () => void = () => undefined
  private account: string | null
  private lastId = 0
  private lastCall = 0
  private pollTimer: NodeJS.Timeout | null = null
  private client: CentrifugeClient | null = null
  private backoff = new Backoff()
  private stopped = true
  private busy = false
  /** Номер сеанса: stop()/выход увеличивают его, и запоздавший ответ старого сеанса ничего не публикует. */
  private gen = 0

  constructor(private hub: Hub, private secrets: Secrets, private store: Store) {
    hub.register(this.id, 'DonatePay')
    this.account = store.get<string | null>('donatepay.account', null)
  }

  state(): DonationServiceState {
    const has = this.secrets.has(SECRET_KEY)
    return { id: this.id, account: has ? this.account : null, pending: false, canLogin: false, method: has ? 'key' : null }
  }

  /** Сохранить ключ и проверить его. */
  async setKey(key: string): Promise<void> {
    const k = key.trim()
    if (!/^[\w-]{10,200}$/.test(k)) throw new Error('Ключ выглядит неправильно — скопируйте его целиком со страницы API DonatePay')
    const u = await this.user(k)
    this.secrets.set(SECRET_KEY, k)
    this.account = u.name
    this.store.set('donatepay.account', u.name)
    this.onChange()
    await this.restart()
  }

  async logout(): Promise<void> {
    this.stop()
    this.secrets.set(SECRET_KEY, null)
    this.store.set('donatepay.account', null)
    this.account = null
    this.hub.setStatus(this.id, 'off', 'Не подключено')
    this.onChange()
  }

  /** Запрос к API с соблюдением лимита частоты. */
  private async call<T>(path: string, key: string, init: RequestInit = {}): Promise<T> {
    const wait = this.lastCall + MIN_GAP - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastCall = Date.now()
    const sep = path.includes('?') ? '&' : '?'
    const r = await http(`${API}${path}${sep}access_token=${encodeURIComponent(key)}`, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } })
    const d = await json<{ status?: string; message?: string; error?: string } & T>(r)
    if (d.status === 'error' || !r.ok) throw new Error(d.message || d.error || `HTTP ${r.status}`)
    return d
  }

  private async user(key: string): Promise<{ id: number; name: string }> {
    const d = await this.call<{ data: { id: number; name: string } }>('/v1/user', key)
    return d.data
  }

  async start(): Promise<void> {
    this.stopped = false
    const gen = ++this.gen
    const key = this.secrets.get(SECRET_KEY)
    if (!key) {
      this.hub.setStatus(this.id, 'off', 'Не подключено')
      return
    }
    this.hub.setStatus(this.id, 'connecting', 'Подключение…')
    try {
      const saved = this.store.get('donatepay.lastId', 0)
      if (saved > 0) {
        // Восстановление: продолжаем с сохранённого места — донаты, пришедшие, пока Crossember был закрыт или без связи, дочитаем.
        this.lastId = saved
      } else {
        // Первое подключение: отметка «с какого доната начинать», старые донаты не показываем.
        const d = await this.call<{ data: Tx[] }>('/v1/transactions?type=donation&limit=1&order=DESC', key)
        if (gen !== this.gen) return
        this.lastId = d.data[0]?.id ?? 0
        this.store.set('donatepay.lastId', this.lastId)
      }
      this.backoff.reset()
      this.hub.setStatus(this.id, 'ok', `Подключено: ${this.account ?? 'DonatePay'} · проверка каждые 20 с`)
      this.schedule(key, saved > 0 ? 0 : MIN_GAP)
      this.socket(key)
    } catch (e) {
      if (gen !== this.gen) return
      this.retry(`Не удалось подключиться: ${(e as Error).message}`)
    }
  }

  private schedule(key: string, delay = MIN_GAP): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.stopped) return
    const gen = this.gen
    this.pollTimer = setTimeout(() => void this.poll(key, gen), delay)
  }

  /**
   * Новые донаты после lastId. API отдаёт страницами (новые сверху), поэтому листаем, пока не дойдём
   * до уже показанного id: если между проверками пришло больше одной страницы, ни один не теряется.
   */
  private async fetchNew(key: string, gen: number): Promise<Tx[] | null> {
    const found = new Map<number, Tx>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await this.call<{ data: Tx[] }>(`/v1/transactions?type=donation&status=success&limit=${PAGE}&skip=${page * PAGE}&order=DESC`, key)
      if (gen !== this.gen) return null
      const list = Array.isArray(d.data) ? d.data : []
      for (const t of list) if (t.id > this.lastId) found.set(t.id, t)
      // Дошли до уже показанного или страница неполная — дальше новых нет.
      if (list.length < PAGE || list.some((t) => t.id <= this.lastId)) return [...found.values()].sort((a, b) => a.id - b.id)
    }
    this.hub.log(this.id, 'warn', `Новых донатов больше ${MAX_PAGES * PAGE} — показаны последние ${MAX_PAGES * PAGE}`)
    return [...found.values()].sort((a, b) => a.id - b.id)
  }

  private async poll(key: string, gen: number): Promise<void> {
    if (this.busy || this.stopped || gen !== this.gen) return
    this.busy = true
    try {
      const fresh = await this.fetchNew(key, gen)
      if (!fresh || gen !== this.gen) return
      for (const t of fresh) this.push(t)
      if (fresh.length) {
        this.lastId = fresh[fresh.length - 1].id
        this.store.set('donatepay.lastId', this.lastId)
      }
      if (this.hub.connections().find((c) => c.id === this.id)?.state !== 'ok') {
        this.hub.setStatus(this.id, 'ok', `Подключено: ${this.account ?? 'DonatePay'} · проверка каждые 20 с`)
      }
    } catch (e) {
      if (gen !== this.gen) return
      this.hub.setStatus(this.id, 'error', `Проверка не удалась: ${(e as Error).message}. Повторим`)
    } finally {
      this.busy = false
      if (gen === this.gen) this.schedule(key)
    }
  }

  private push(t: Tx): void {
    const amount = Number(String(t.sum ?? '').replace(',', '.'))
    const currency = (t.vars?.currency ?? 'RUB').toUpperCase()
    this.hub.push({
      id: `dp:${t.id}`,
      platform: this.id,
      type: 'donation',
      user: t.vars?.name || t.what || 'Аноним',
      text: t.vars?.comment ?? t.comment ?? undefined,
      amount: Number.isFinite(amount) ? amount : undefined,
      currency,
      amountRub: currency === 'RUB' && Number.isFinite(amount) ? amount : undefined
    })
  }

  /** Сокет — необязательный «звонок». Если не заработал, остаётся опрос. */
  private socket(key: string): void {
    this.client?.close()
    const gen = this.gen
    void (async () => {
      try {
        const r = await http(`${API}/v2/socket/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: key }) })
        const { token } = await json<{ token?: string }>(r)
        if (!token || this.stopped || gen !== this.gen) return
        // id пользователя — в поле sub токена (JWT).
        const sub = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}').sub
        if (!sub) return
        this.client = new CentrifugeClient(WS, {
          token,
          subscribe: async (client) => {
            const rr = await http(`${API}/v2/socket/token?access_token=${encodeURIComponent(key)}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, channels: [`$public:${sub}`] })
            })
            const d = await json<{ channels?: { channel: string; token: string }[]; token?: string }>(rr)
            return d.channels ?? [{ channel: `$public:${sub}`, token: d.token }]
          },
          onReady: () => this.hub.log(this.id, 'info', 'Мгновенные уведомления включены'),
          onPublish: () => { if (gen === this.gen && !this.busy) this.schedule(key, Math.max(0, this.lastCall + MIN_GAP - Date.now())) },
          onClose: () => this.hub.log(this.id, 'warn', 'Мгновенные уведомления недоступны — работает проверка раз в 20 с'),
          onError: (text) => this.hub.log(this.id, 'warn', text)
        })
        this.client.connect()
      } catch (e) {
        this.hub.log(this.id, 'warn', `Сокет недоступен (${(e as Error).message}) — работает проверка раз в 20 с`)
      }
    })()
  }

  private retry(why: string): void {
    if (this.stopped) return
    const sec = this.backoff.schedule(() => void this.start())
    this.hub.setStatus(this.id, 'error', `${why}. Повтор через ${sec} с`)
  }

  stop(): void {
    this.stopped = true
    this.gen++
    this.backoff.cancel()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.client?.close()
    this.client = null
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }
}
