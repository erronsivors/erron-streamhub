import { OBSWebSocket } from 'obs-websocket-js'
import type { Hub } from './hub'
import type { Secrets } from './secrets'
import type { Store } from './db'
import type { ObsState } from './types'
import type { ObsAction } from './templates'

/** Сцены, источники и фильтры OBS — для выпадающих списков в правилах и конструкторе. */
export interface ObsCatalog {
  scenes: { name: string; items: string[] }[]
  inputs: { name: string; kind: string }[]
  filters: Record<string, string[]>
}

const MEDIA_ACTIONS = {
  restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
  play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
  stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP'
} as const

const PASSWORD_KEY = 'obs.password'

/** Подключение к OBS через obs-websocket v5 с авто-переподключением. */
export class ObsConnector {
  private obs = new OBSWebSocket()
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelay = 2000
  private stopped = false
  /** Отложенные возвраты «как было»: ключ — что меняли (сцена, источник, фильтр, текст). */
  private reverts = new Map<string, { timer: NodeJS.Timeout; restore: () => Promise<unknown> }>()
  state: ObsState = { connected: false, scene: null, streaming: false, streamStartedAt: null, recording: false, resolution: null, fps: null }
  onChange: () => void = () => undefined
  /** Эфир начался (true) или закончился (false) — по событию OBS, не при подключении к уже идущему эфиру. */
  onStream: (live: boolean) => void = () => undefined

  constructor(private hub: Hub, private store: Store, private secrets: Secrets) {
    hub.register('obs', 'OBS Studio')
    this.obs.on('ConnectionClosed', (err) => {
      if (this.state.connected) this.hub.log('obs', 'warn', `Соединение закрыто: ${err.message || err.code}`)
      this.patch({ connected: false })
      this.scheduleRetry(err.code === 4009 ? 'Неверный пароль OBS WebSocket' : 'OBS недоступен — переподключение…')
    })
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => this.patch({ scene: sceneName }))
    // Только окончательные состояния: «запускается» и «останавливается» пропускаем, чтобы не сбить время начала эфира.
    this.obs.on('StreamStateChanged', ({ outputState }) => {
      if (outputState !== 'OBS_WEBSOCKET_OUTPUT_STARTED' && outputState !== 'OBS_WEBSOCKET_OUTPUT_STOPPED') return
      const live = outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED'
      if (live === this.state.streaming) return
      this.patch({ streaming: live, streamStartedAt: live ? Date.now() : null })
      this.onStream(live)
    })
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
    for (const r of this.reverts.values()) clearTimeout(r.timer)
    this.reverts.clear()
    await this.obs.disconnect().catch(() => undefined)
  }

  private need(): void {
    if (!this.state.connected) throw new Error('OBS не подключён')
  }

  /** Список сцен, источников и фильтров (для настройки действий). */
  async catalog(): Promise<ObsCatalog> {
    this.need()
    const { scenes } = await this.obs.call('GetSceneList')
    const { inputs } = await this.obs.call('GetInputList')
    const sceneNames = (scenes as { sceneName: string }[]).map((s) => s.sceneName).reverse()
    const out: ObsCatalog = { scenes: [], inputs: (inputs as { inputName: string; inputKind: string }[]).map((i) => ({ name: i.inputName, kind: i.inputKind })), filters: {} }
    for (const name of sceneNames) {
      const { sceneItems } = await this.obs.call('GetSceneItemList', { sceneName: name })
      out.scenes.push({ name, items: (sceneItems as { sourceName: string }[]).map((i) => i.sourceName) })
    }
    for (const src of [...sceneNames, ...out.inputs.map((i) => i.name)]) {
      try {
        const { filters } = await this.obs.call('GetSourceFilterList', { sourceName: src })
        const names = (filters as { filterName: string }[]).map((f) => f.filterName)
        if (names.length) out.filters[src] = names
      } catch {
        /* у источника нет фильтров */
      }
    }
    return out
  }

  /**
   * Через revertSec вернуть как было. Если это же уже меняли и возврат ещё не случился —
   * исходное состояние берём старое (а не промежуточное), а таймер продлеваем.
   */
  private scheduleRevert(key: string, sec: number, restore: () => Promise<unknown>): void {
    const old = this.reverts.get(key)
    if (old) clearTimeout(old.timer)
    if (sec <= 0) {
      this.reverts.delete(key)
      return
    }
    const r = old?.restore ?? restore
    const timer = setTimeout(() => {
      this.reverts.delete(key)
      if (this.state.connected) r().catch((e) => this.hub.log('obs', 'warn', `Не удалось вернуть как было: ${(e as Error).message}`))
    }, sec * 1000)
    this.reverts.set(key, { timer, restore: r })
  }

  /** Выполнить действие правила или слоя конструктора. vars — подстановка {user} и т.п. в текст. */
  async run(a: ObsAction, vars: (s: string) => string = (s) => s): Promise<void> {
    this.need()
    switch (a.op) {
      case 'scene': {
        if (!a.scene) throw new Error('Не выбрана сцена')
        const { currentProgramSceneName: prev } = await this.obs.call('GetCurrentProgramScene')
        if (prev === a.scene && !this.reverts.has('scene')) return
        await this.obs.call('SetCurrentProgramScene', { sceneName: a.scene })
        this.scheduleRevert('scene', a.revertSec, async () => {
          const { currentProgramSceneName: now } = await this.obs.call('GetCurrentProgramScene')
          if (now === a.scene) await this.obs.call('SetCurrentProgramScene', { sceneName: prev })
        })
        return
      }
      case 'source': {
        if (!a.source) throw new Error('Не выбран источник')
        const sceneName = a.scene || (await this.obs.call('GetCurrentProgramScene')).currentProgramSceneName
        const { sceneItemId } = await this.obs.call('GetSceneItemId', { sceneName, sourceName: a.source })
        const { sceneItemEnabled: was } = await this.obs.call('GetSceneItemEnabled', { sceneName, sceneItemId })
        const want = a.mode === 'toggle' ? !was : a.mode === 'show'
        await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: want })
        this.scheduleRevert(`src:${sceneName}:${a.source}`, a.revertSec, () =>
          this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: was }))
        return
      }
      case 'filter': {
        if (!a.source || !a.filter) throw new Error('Не выбран источник или фильтр')
        const { filterEnabled: was } = await this.obs.call('GetSourceFilter', { sourceName: a.source, filterName: a.filter })
        const want = a.mode === 'toggle' ? !was : a.mode === 'show'
        await this.obs.call('SetSourceFilterEnabled', { sourceName: a.source, filterName: a.filter, filterEnabled: want })
        this.scheduleRevert(`flt:${a.source}:${a.filter}`, a.revertSec, () =>
          this.obs.call('SetSourceFilterEnabled', { sourceName: a.source, filterName: a.filter, filterEnabled: was }))
        return
      }
      case 'media': {
        if (!a.source) throw new Error('Не выбран медиа-источник')
        await this.obs.call('TriggerMediaInputAction', { inputName: a.source, mediaAction: MEDIA_ACTIONS[a.media] })
        return
      }
      case 'text': {
        if (!a.source) throw new Error('Не выбран текстовый источник')
        const { inputSettings } = await this.obs.call('GetInputSettings', { inputName: a.source })
        const was = typeof inputSettings.text === 'string' ? inputSettings.text : ''
        await this.obs.call('SetInputSettings', { inputName: a.source, inputSettings: { text: vars(a.text).slice(0, 500) } })
        this.scheduleRevert(`txt:${a.source}`, a.revertSec, () =>
          this.obs.call('SetInputSettings', { inputName: a.source, inputSettings: { text: was } }))
        return
      }
    }
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
