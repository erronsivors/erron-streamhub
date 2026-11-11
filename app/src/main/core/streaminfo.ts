import { EventEmitter } from 'node:events'
import { clipboard, shell } from 'electron'
import type { Store } from './db'
import type { Settings } from './settings'
import type { TwitchConnector } from './twitch'
import type { YoutubeConnector } from './youtube'
import type { KickAuth } from './kickauth'

/**
 * Название и категория эфира — сразу на всех площадках.
 * Twitch, YouTube, Kick — через официальные API. VK Видео Live и GoodGame — вручную: Crossember копирует название
 * и открывает страницу настроек эфира в браузере (публичного способа менять их программой пока нет).
 */

export const INFO_PLATFORMS = ['twitch', 'youtube', 'kick', 'vk', 'goodgame'] as const
export type InfoPlatform = (typeof INFO_PLATFORMS)[number]

/** Категории YouTube (у YouTube нельзя указать конкретную игру через API — только общий раздел). */
export const YT_CATEGORIES: { id: string; name: string }[] = [
  { id: '20', name: 'Видеоигры' }, { id: '24', name: 'Развлечения' }, { id: '22', name: 'Люди и блоги' }, { id: '10', name: 'Музыка' },
  { id: '27', name: 'Образование' }, { id: '28', name: 'Наука и техника' }, { id: '17', name: 'Спорт' }, { id: '26', name: 'Хобби и стиль' }, { id: '23', name: 'Юмор' }
]

export type InfoAccess = 'ok' | 'login' | 'relogin' | 'unavailable' | 'manual' | 'nochannel'

export interface InfoResult {
  state: 'ok' | 'error' | 'manual' | 'working'
  text: string
  ts: number
}

export interface StreamInfoState {
  title: string
  game: string
  ytCategory: string
  targets: InfoPlatform[]
  /** Последние названия — чтобы быстро вернуть прежнее. */
  recent: { title: string; game: string }[]
  access: Record<InfoPlatform, InfoAccess>
  results: Partial<Record<InfoPlatform, InfoResult>>
  busy: boolean
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '')

export class StreamInfo extends EventEmitter {
  private title: string
  private game: string
  private ytCategory: string
  private targets: InfoPlatform[]
  private recent: { title: string; game: string }[]
  private results: Partial<Record<InfoPlatform, InfoResult>> = {}
  private busy = false

  constructor(
    private store: Store,
    private settings: Settings,
    private twitch: TwitchConnector,
    private youtube: YoutubeConnector,
    private kick: KickAuth
  ) {
    super()
    const o = obj(store.get('streaminfo.v1', {}))
    this.title = str(o.title, 140)
    this.game = str(o.game, 100)
    this.ytCategory = YT_CATEGORIES.some((c) => c.id === o.ytCategory) ? String(o.ytCategory) : '20'
    this.targets = Array.isArray(o.targets) ? o.targets.filter((p): p is InfoPlatform => (INFO_PLATFORMS as readonly string[]).includes(p as string)) : [...INFO_PLATFORMS]
    this.recent = (Array.isArray(o.recent) ? o.recent : []).slice(0, 8).map((r) => ({ title: str(obj(r).title, 140), game: str(obj(r).game, 100) })).filter((r) => r.title)
  }

  private access(): Record<InfoPlatform, InfoAccess> {
    const s = this.settings.get()
    return {
      twitch: this.twitch.infoAccess(),
      youtube: this.youtube.state().account ? 'ok' : 'login',
      kick: !this.kick.state().available ? 'unavailable' : this.kick.loggedIn() ? 'ok' : 'login',
      vk: s.vk.channel ? 'manual' : 'nochannel',
      goodgame: s.goodgame.channel ? 'manual' : 'nochannel'
    }
  }

  state(): StreamInfoState {
    return { title: this.title, game: this.game, ytCategory: this.ytCategory, targets: this.targets, recent: this.recent, access: this.access(), results: this.results, busy: this.busy }
  }

  private save(): void {
    this.store.set('streaminfo.v1', { title: this.title, game: this.game, ytCategory: this.ytCategory, targets: this.targets, recent: this.recent })
    this.emit('change')
  }

  /** Запомнить черновик (поля формы), ничего не отправляя. */
  setDraft(v: unknown): void {
    const o = obj(v)
    if ('title' in o) this.title = str(o.title, 140)
    if ('game' in o) this.game = str(o.game, 100)
    if (typeof o.ytCategory === 'string' && YT_CATEGORIES.some((c) => c.id === o.ytCategory)) this.ytCategory = o.ytCategory
    if (Array.isArray(o.targets)) this.targets = o.targets.filter((p): p is InfoPlatform => (INFO_PLATFORMS as readonly string[]).includes(p as string))
    this.save()
  }

  /** Подсказки категорий: с Twitch (если вошли), иначе с Kick. */
  async suggest(q: string): Promise<string[]> {
    const query = str(q, 100)
    if (query.length < 2) return []
    try {
      if (this.twitch.infoAccess() !== 'login') return (await this.twitch.searchCategories(query)).map((c) => c.name)
      if (this.kick.loggedIn()) return (await this.kick.searchCategories(query)).map((c) => c.name)
    } catch { /* подсказки не обязательны */ }
    return []
  }

  /** Подставить текущие название и категорию с Twitch. */
  async loadFromTwitch(): Promise<void> {
    const c = await this.twitch.channelInfo()
    this.title = c.title.slice(0, 140)
    this.game = c.game.slice(0, 100)
    this.save()
  }

  private set(p: InfoPlatform, state: InfoResult['state'], text: string): void {
    this.results[p] = { state, text, ts: Date.now() }
    this.emit('change')
  }

  private async one(p: InfoPlatform): Promise<void> {
    const access = this.access()[p]
    const title = this.title
    const game = this.game
    try {
      if (p === 'twitch') {
        if (access === 'login') throw new Error('Не выполнен вход в Twitch')
        const g = await this.twitch.setChannelInfo(title, game)
        this.set(p, 'ok', g ? `Применено · ${g}` : 'Применено')
      } else if (p === 'youtube') {
        if (access === 'login') throw new Error('Не выполнен вход в YouTube')
        await this.youtube.setTitle(title, this.ytCategory)
        this.set(p, 'ok', `Применено · ${YT_CATEGORIES.find((c) => c.id === this.ytCategory)?.name ?? ''}`)
      } else if (p === 'kick') {
        if (access === 'unavailable') throw new Error('Вход в Kick не настроен в этой сборке')
        if (access === 'login') throw new Error('Не выполнен вход в Kick')
        const g = await this.kick.setChannelInfo(title, game)
        this.set(p, 'ok', g ? `Применено · ${g}` : 'Применено')
      } else {
        if (access === 'nochannel') throw new Error('Не указан ник канала (Подключения)')
        this.set(p, 'manual', 'Название скопировано — вставьте его в настройках эфира на открывшейся странице (Ctrl+V)')
      }
    } catch (e) {
      this.set(p, 'error', (e as Error).message)
    }
  }

  /** Применить на выбранных площадках. */
  async apply(): Promise<void> {
    if (this.busy) return
    if (!this.title) throw new Error('Введите название эфира')
    const list = this.targets
    if (!list.length) throw new Error('Не выбрано ни одной площадки')
    this.busy = true
    for (const p of list) this.results[p] = { state: 'working', text: 'Отправляю…', ts: Date.now() }
    this.emit('change')
    try {
      await Promise.all(list.filter((p) => p !== 'vk' && p !== 'goodgame').map((p) => this.one(p)))
      // VK и GoodGame — название в буфер обмена и страница настроек эфира в браузере.
      const manual = list.filter((p) => p === 'vk' || p === 'goodgame')
      if (manual.length) {
        clipboard.writeText(this.title)
        for (const p of manual) await this.one(p)
        for (const p of manual) if (this.results[p]?.state === 'manual') await this.openManual(p)
      }
      this.recent = [{ title: this.title, game: this.game }, ...this.recent.filter((r) => r.title !== this.title || r.game !== this.game)].slice(0, 8)
      this.save()
    } finally {
      this.busy = false
      this.emit('change')
    }
  }

  /** Страница канала на площадке (в браузере пользователя, где он уже вошёл) — оттуда владелец открывает настройки эфира. */
  async openManual(p: InfoPlatform): Promise<void> {
    const s = this.settings.get()
    const nick = /^[A-Za-z0-9_.-]{1,40}$/
    if (p === 'vk' && nick.test(s.vk.channel)) await shell.openExternal(`https://live.vkvideo.ru/${s.vk.channel}`)
    if (p === 'goodgame' && nick.test(s.goodgame.channel)) await shell.openExternal(`https://goodgame.ru/${s.goodgame.channel}`)
  }
}
