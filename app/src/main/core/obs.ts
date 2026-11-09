import { OBSWebSocket } from 'obs-websocket-js'
import type { Hub } from './hub'
import type { Secrets } from './secrets'
import type { Store } from './db'
import type { ObsState } from './types'

const PASSWORD_KEY = 'obs.password'

/** Подключение к OBS через obs-websocket v5 с авто-переподключением. */
export class ObsConnector {
  private obs = new OBSWebSocket()
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelay = 2000
  private stopped = false
  state: ObsState = { connected: false, scene: null, streaming: false, streamStartedAt: null, recording: false, resolution: null, fps: null }
  onChange: () => void = () => undefined

  constructor(private hub: Hub, private store: Store, private secrets: Secrets) {
    hub.register('obs', 'OBS Studio')
    this.obs.on('ConnectionClosed', (err) => {
      if (this.state.connected) this.hub.log('obs', 'warn', `Соединение закрыто: ${err.message || err.code}`)
      this.patch({ connected: false })
      this.scheduleRetry(err.code === 4009 ? 'Неверный пароль OBS WebSocket' : 'OBS недоступен — переподключение…')
    })
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => this.patch({ scene: sceneName }))
    this.obs.on('StreamStateChanged', ({ outputActive }) =>
      this.patch({ streaming: outputActive, streamStartedAt: outputActive ? Date.now() : null }))
    this.obs.on('RecordStateChanged', ({ outputActive }) => this.patch({ recording: outputActive }))
  }

  config(): { url: string; hasPassword: boolean } {
    return { url: this.store.get('obs.url', 'ws://127.0.0.1:4455'), hasPassword: this.secrets.has(PASSWORD_KEY) }
  }

  /** Сохранить настройки. password: undefined — не менять, '' — удалить. */
  async configure(url: string, password?: string): Promise<void> {
    if (!/^wss?:\/\/[\w.-]+(:\d{1,5})?\/?$/.test(url)) throw new Error('Адрес должен быть вида ws://127.0.0.1:4455')
    this.store.set('obs.url', url)
    if (password !== undefined) this.secrets.set(PASSWORD_KEY, password || null)
    await this.reconnect()
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async reconnect(): Promise<void> {
    this.retryDelay = 2000
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    try {
      await this.obs.disconnect()
    } catch {
      /* уже отключено */
    }
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    await this.obs.disconnect().catch(() => undefined)
  }

  private patch(p: Partial<ObsState>): void {
    this.state = { ...this.state, ...p }
    this.onChange()
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped || this.retryTimer) return
    this.hub.setStatus('obs', reason.startsWith('Неверный') ? 'error' : 'connecting', reason)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 30000)
  }

  private async connect(): Promise<void> {
    const { url } = this.config()
    this.hub.setStatus('obs', 'connecting', `Подключение к ${url}…`)
    try {
      const pass = this.secrets.get(PASSWORD_KEY) ?? undefined
      const { obsWebSocketVersion } = await this.obs.connect(url, pass)
      this.retryDelay = 2000
      const [scene, stream, record, video] = await Promise.all([
        this.obs.call('GetCurrentProgramScene'),
        this.obs.call('GetStreamStatus'),
        this.obs.call('GetRecordStatus'),
        this.obs.call('GetVideoSettings')
      ])
      this.patch({
        connected: true,
        scene: scene.currentProgramSceneName,
        streaming: stream.outputActive,
        streamStartedAt: stream.outputActive ? Date.now() - stream.outputDuration : null,
        recording: record.outputActive,
        resolution: `${video.outputWidth}×${video.outputHeight}`,
        fps: Math.round((video.fpsNumerator / video.fpsDenominator) * 100) / 100
      })
      this.hub.setStatus('obs', 'ok', `Подключено · obs-websocket ${obsWebSocketVersion}`)
    } catch (e) {
      // ConnectionClosed сам запланирует повтор; здесь — на случай ошибки до открытия сокета.
      this.scheduleRetry(`Не удалось подключиться: ${(e as Error).message}`)
    }
  }
}
