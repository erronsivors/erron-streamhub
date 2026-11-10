import { randomUUID } from 'node:crypto'
import type { Store } from './db'
import { BUILTIN_SOUNDS, type Theme } from './settings'

/**
 * Шаблоны алертов для конструктора: холст 1920×1080 + слои на таймлайне.
 * Один и тот же формат читают ядро (сборка алерта), оверлей и редактор (движок alertkit.js).
 * Всё, что приходит из интерфейса или с диска, проходит через sanitizeTemplate().
 */

export const CANVAS = { w: 1920, h: 1080 } as const

export const LAYER_TYPES = ['card', 'text', 'image', 'video', 'sound', 'tts', 'obs'] as const
export type LayerType = (typeof LAYER_TYPES)[number]
export const ANIM_PRESETS = ['none', 'fade', 'up', 'down', 'left', 'right', 'zoom', 'pop', 'spin'] as const
export type AnimPreset = (typeof ANIM_PRESETS)[number]
export const EASES = ['linear', 'ease', 'in', 'out', 'inout', 'back'] as const
export type Ease = (typeof EASES)[number]
export const FONTS = ['manrope', 'unbounded', 'mono'] as const
export type FontId = (typeof FONTS)[number]

/** Ключевой кадр: время от начала слоя (мс) и состояние слоя в этот момент. */
export interface Keyframe {
  t: number
  x: number
  y: number
  scale: number
  rotate: number
  opacity: number
  /** Сглаживание движения ОТ этого кадра к следующему. */
  ease: Ease
}

export const OBS_OPS = ['scene', 'source', 'filter', 'media', 'text'] as const
export type ObsOp = (typeof OBS_OPS)[number]

/** Действие в OBS. Поля, ненужные выбранной операции, просто не используются. */
export interface ObsAction {
  op: ObsOp
  scene: string
  source: string
  filter: string
  /** Источник/фильтр: показать, скрыть или переключить. */
  mode: 'show' | 'hide' | 'toggle'
  media: 'restart' | 'play' | 'pause' | 'stop'
  /** Новый текст для текстового источника; подстановки {user} {amount} {message} {platform}. */
  text: string
  /** Через сколько секунд вернуть как было (0 — не возвращать). */
  revertSec: number
}

export interface Layer {
  id: string
  type: LayerType
  name: string
  hidden: boolean
  /** Начало и длительность на таймлайне, мс. duration 0 — до конца алерта. */
  start: number
  duration: number
  x: number
  y: number
  w: number
  h: number
  rotate: number
  /** 0…1 */
  opacity: number
  animIn: AnimPreset
  animInMs: number
  animOut: AnimPreset
  animOutMs: number
  keyframes: Keyframe[]
  /** text: текст слоя; card: главная строка. Подстановки {user} {amount} {message} {platform}. */
  text: string
  /** card: верхняя строка. */
  kicker: string
  /** card: показывать сообщение зрителя. */
  showMessage: boolean
  font: FontId
  size: number
  color: string
  /** Цвет суммы ({amount}); пусто — фирменный градиент темы. */
  accent: string
  align: 'left' | 'center' | 'right'
  bold: boolean
  shadow: boolean
  /** Обводка текста, px. */
  stroke: number
  /** image/video: m:<md5>.<ext> из библиотеки Crossember. */
  media: string
  fit: 'contain' | 'cover' | 'fill'
  loop: boolean
  /** sound: встроенный звук или custom:<файл>. */
  sound: string
  /** sound / video / tts, %. */
  volume: number
  /** tts: голос (пусто — из настроек озвучки), скорость −10…10, текст — в поле text. */
  voice: string
  rate: number
  obs: ObsAction
}

export interface AlertTemplate {
  id: string
  name: string
  /** Тема оформления карточки: как у оверлея или своя. */
  theme: 'auto' | Theme
  /** Длина алерта, мс. */
  durationMs: number
  /** Удлинять на время чтения сообщения зрителя (до +5 с). */
  extendByMessage: boolean
  layers: Layer[]
}

// ---------- проверка входящих данных ----------

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
export const num = (v: unknown, d: number, min: number, max: number, round = true): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, round ? Math.round(v) : Math.round(v * 1000) / 1000)) : d
export const str = (v: unknown, d: string, max = 200): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, max) : d)
export const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)
export const id = (v: unknown): string => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : randomUUID())
/** Имя сцены/источника/фильтра OBS: любые печатные символы. */
const obsName = (v: unknown): string => str(v, '', 120).trim()
const color = (v: unknown, d: string): string => (typeof v === 'string' && /^(#[0-9a-fA-F]{6})?$/.test(v) ? v : d)
export const soundId = (v: unknown, d: string): string =>
  typeof v === 'string' && ((BUILTIN_SOUNDS as readonly string[]).includes(v) || /^custom:[0-9a-f]{32}\.(mp3|wav|ogg)$/.test(v)) ? v : d
const mediaId = (v: unknown): string => (typeof v === 'string' && /^m:[0-9a-f]{32}\.(png|jpg|gif|webp|webm|mp4)$/.test(v) ? v : '')

export function sanitizeObs(v: unknown): ObsAction {
  const o = obj(v)
  return {
    op: oneOf(o.op, OBS_OPS, 'source'),
    scene: obsName(o.scene),
    source: obsName(o.source),
    filter: obsName(o.filter),
    mode: oneOf(o.mode, ['show', 'hide', 'toggle'] as const, 'show'),
    media: oneOf(o.media, ['restart', 'play', 'pause', 'stop'] as const, 'restart'),
    text: str(o.text, '', 300),
    revertSec: num(o.revertSec, 0, 0, 3600)
  }
}

function keyframe(v: unknown): Keyframe {
  const o = obj(v)
  return {
    t: num(o.t, 0, 0, 120_000),
    x: num(o.x, 0, -4000, 6000),
    y: num(o.y, 0, -4000, 6000),
    scale: num(o.scale, 1, 0, 20, false),
    rotate: num(o.rotate, 0, -3600, 3600),
    opacity: num(o.opacity, 1, 0, 1, false),
    ease: oneOf(o.ease, EASES, 'ease')
  }
}

export const LAYER_NAMES: Record<LayerType, string> = {
  card: 'Карточка', text: 'Текст', image: 'Картинка', video: 'Видео', sound: 'Звук', tts: 'Озвучка', obs: 'Действие OBS'
}

/** Слой с настройками по умолчанию для своего типа. */
export function newLayer(type: LayerType, patch: Partial<Layer> = {}): Layer {
  const visual = type === 'card' || type === 'text' || type === 'image' || type === 'video'
  const base: Layer = {
    id: randomUUID(),
    type,
    name: LAYER_NAMES[type],
    hidden: false,
    start: 0,
    duration: 0,
    x: type === 'card' ? 260 : 660,
    y: type === 'card' ? 200 : 340,
    w: type === 'card' ? 1400 : 600,
    h: type === 'card' ? 260 : type === 'text' ? 120 : 400,
    rotate: 0,
    opacity: 1,
    animIn: visual ? (type === 'card' ? 'pop' : 'fade') : 'none',
    animInMs: 450,
    animOut: visual ? 'fade' : 'none',
    animOutMs: 450,
    keyframes: [],
    text: type === 'card' ? '{user} — {amount}' : type === 'tts' ? '{user} — {amount}. {message}' : type === 'text' ? '{user}' : '',
    kicker: type === 'card' ? 'Новый донат' : '',
    showMessage: true,
    font: type === 'text' ? 'unbounded' : 'manrope',
    size: 56,
    color: '#ffffff',
    accent: '',
    align: 'center',
    bold: true,
    shadow: true,
    stroke: 0,
    media: '',
    fit: 'contain',
    loop: false,
    sound: type === 'sound' ? 'coin' : 'none',
    volume: 80,
    voice: '',
    rate: 0,
    obs: sanitizeObs({})
  }
  return { ...base, ...patch }
}

export function sanitizeLayer(v: unknown): Layer {
  const o = obj(v)
  const type = oneOf(o.type, LAYER_TYPES, 'text')
  const d = newLayer(type)
  return {
    id: id(o.id),
    type,
    name: str(o.name, d.name, 40),
    hidden: bool(o.hidden, false),
    start: num(o.start, 0, 0, 120_000),
    duration: num(o.duration, 0, 0, 120_000),
    x: num(o.x, d.x, -4000, 6000),
    y: num(o.y, d.y, -4000, 6000),
    w: num(o.w, d.w, 10, 4000),
    h: num(o.h, d.h, 10, 4000),
    rotate: num(o.rotate, 0, -3600, 3600),
    opacity: num(o.opacity, 1, 0, 1, false),
    animIn: oneOf(o.animIn, ANIM_PRESETS, d.animIn),
    animInMs: num(o.animInMs, d.animInMs, 0, 5000),
    animOut: oneOf(o.animOut, ANIM_PRESETS, d.animOut),
    animOutMs: num(o.animOutMs, d.animOutMs, 0, 5000),
    keyframes: (Array.isArray(o.keyframes) ? o.keyframes : []).slice(0, 50).map(keyframe).sort((a, b) => a.t - b.t),
    text: str(o.text, d.text, 300),
    kicker: str(o.kicker, d.kicker, 60),
    showMessage: bool(o.showMessage, d.showMessage),
    font: oneOf(o.font, FONTS, d.font),
    size: num(o.size, d.size, 8, 400),
    color: color(o.color, d.color) || '#ffffff',
    accent: color(o.accent, ''),
    align: oneOf(o.align, ['left', 'center', 'right'] as const, d.align),
    bold: bool(o.bold, d.bold),
    shadow: bool(o.shadow, d.shadow),
    stroke: num(o.stroke, 0, 0, 20),
    media: mediaId(o.media),
    fit: oneOf(o.fit, ['contain', 'cover', 'fill'] as const, 'contain'),
    loop: bool(o.loop, false),
    sound: soundId(o.sound, d.sound),
    volume: num(o.volume, d.volume, 0, 100),
    voice: str(o.voice, '', 100),
    rate: num(o.rate, 0, -10, 10),
    obs: sanitizeObs(o.obs)
  }
}

export function sanitizeTemplate(v: unknown): AlertTemplate {
  const o = obj(v)
  return {
    id: id(o.id),
    name: str(o.name, 'Новый алерт', 60).trim() || 'Новый алерт',
    theme: oneOf(o.theme, ['auto', 'general', 'campfire'] as const, 'auto'),
    durationMs: num(o.durationMs, 6000, 1000, 120_000),
    extendByMessage: bool(o.extendByMessage, true),
    layers: (Array.isArray(o.layers) ? o.layers : []).slice(0, 40).map(sanitizeLayer)
  }
}

/** Простой шаблон «карточка + звук» — им становятся старые настройки алертов этапа 3. */
export function simpleTemplate(name: string, kicker: string, title: string, sound: string, volume: number, durationSec: number, showMessage: boolean): AlertTemplate {
  const layers = [newLayer('card', { kicker, text: title, showMessage })]
  if (sound !== 'none') layers.push(newLayer('sound', { sound, volume }))
  return { id: randomUUID(), name, theme: 'auto', durationMs: durationSec * 1000, extendByMessage: true, layers }
}

/** Хранилище шаблонов алертов. */
export class TemplateStore {
  private list: AlertTemplate[]
  onChange: () => void = () => undefined

  constructor(private store: Store) {
    const raw = store.get<unknown[] | null>('templates.v1', null)
    this.list = Array.isArray(raw) ? raw.slice(0, 200).map(sanitizeTemplate) : []
  }

  /** Есть ли сохранённые шаблоны (нет — значит, первый запуск этапа 4 и нужна миграция). */
  initialized(): boolean {
    return this.store.get<unknown>('templates.v1', null) !== null
  }

  all(): AlertTemplate[] {
    return this.list
  }

  get(id: string): AlertTemplate | undefined {
    return this.list.find((t) => t.id === id)
  }

  private save(): void {
    this.store.set('templates.v1', this.list)
    this.onChange()
  }

  /** Добавить или заменить шаблон. */
  put(v: unknown): AlertTemplate {
    const t = sanitizeTemplate(v)
    const i = this.list.findIndex((x) => x.id === t.id)
    if (i >= 0) this.list[i] = t
    else {
      if (this.list.length >= 200) throw new Error('Слишком много шаблонов (максимум 200)')
      this.list.push(t)
    }
    this.save()
    return t
  }

  setAll(list: AlertTemplate[]): void {
    this.list = list.map(sanitizeTemplate)
    this.save()
  }

  remove(id: string): void {
    this.list = this.list.filter((t) => t.id !== id)
    this.save()
  }

  duplicate(id: string): AlertTemplate | null {
    const t = this.get(id)
    if (!t) return null
    const copy = sanitizeTemplate({ ...structuredClone(t), id: randomUUID(), name: `${t.name} (копия)`.slice(0, 60) })
    copy.layers = copy.layers.map((l) => ({ ...l, id: randomUUID() }))
    this.list.push(copy)
    this.save()
    return copy
  }

  /** Какие файлы медиа и звуков используются (чтобы не удалить нужное). */
  usedMedia(): Set<string> {
    const s = new Set<string>()
    for (const t of this.list) for (const l of t.layers) { if (l.media) s.add(l.media); if (l.sound.startsWith('custom:')) s.add(l.sound) }
    return s
  }
}
