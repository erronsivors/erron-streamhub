// Оформление чата для OBS: настройки, проверка, CSS и вид событий в ленте.
// Без node-импортов: этот модуль использует и ядро (оверлей в OBS), и интерфейс (живой предпросмотр) —
// так OBS и предпросмотр всегда выглядят одинаково.
import type { HubEvent, Platform } from './types'

export const CHAT_FONTS = ['manrope', 'unbounded', 'arial', 'segoe', 'verdana', 'tahoma', 'georgia', 'impact', 'consolas', 'comic'] as const
export type ChatFont = (typeof CHAT_FONTS)[number]
export const FONT_LABEL: Record<ChatFont, string> = {
  manrope: 'Manrope', unbounded: 'Unbounded', arial: 'Arial', segoe: 'Segoe UI', verdana: 'Verdana', tahoma: 'Tahoma',
  georgia: 'Georgia', impact: 'Impact', consolas: 'Consolas', comic: 'Comic Sans MS'
}
const FONT_CSS: Record<ChatFont, string> = {
  manrope: "'Manrope', sans-serif", unbounded: "'Unbounded', sans-serif", arial: 'Arial, sans-serif', segoe: "'Segoe UI', sans-serif",
  verdana: 'Verdana, sans-serif', tahoma: 'Tahoma, sans-serif', georgia: 'Georgia, serif', impact: 'Impact, sans-serif',
  consolas: 'Consolas, monospace', comic: "'Comic Sans MS', cursive"
}

export const ANIM_IN = ['none', 'fade', 'slide', 'pop', 'blur', 'bounce'] as const
export const ANIM_OUT = ['none', 'fade', 'slide', 'shrink'] as const
export const ANIM_IN_LABEL: Record<(typeof ANIM_IN)[number], string> = { none: 'Без анимации', fade: 'Проявление', slide: 'Выезд', pop: 'Пружина', blur: 'Из размытия', bounce: 'Подскок' }
export const ANIM_OUT_LABEL: Record<(typeof ANIM_OUT)[number], string> = { none: 'Сразу', fade: 'Растворение', slide: 'Уезжает', shrink: 'Сжатие' }

export const BG_STYLES = ['card', 'plain', 'strip'] as const
export const BG_LABEL: Record<(typeof BG_STYLES)[number], string> = { card: 'Карточки', plain: 'Без подложки', strip: 'Полоса' }
export const HIGHLIGHTS = ['none', 'frame', 'fill', 'both', 'bar'] as const
export const HIGHLIGHT_LABEL: Record<(typeof HIGHLIGHTS)[number], string> = { none: 'Нет', frame: 'Рамка', fill: 'Заливка', both: 'Рамка и заливка', bar: 'Полоса слева' }

/** События, которые можно показывать в ленте чата (каждое — своей галочкой). */
export const CHAT_EVENTS = ['donation', 'follow', 'sub', 'gift', 'raid', 'bits', 'reward', 'mention'] as const
export type ChatEventKind = (typeof CHAT_EVENTS)[number]
export const CHAT_EVENT_LABEL: Record<ChatEventKind, string> = {
  donation: 'Донаты', follow: 'Фолловы', sub: 'Подписки', gift: 'Подарочные подписки', raid: 'Рейды', bits: 'Биты', reward: 'Награды за баллы', mention: 'Обращения к стримеру'
}

export const CHAT_SOURCES = ['twitch', 'youtube', 'vk', 'kick', 'goodgame'] as const
/** Чьим цветом красится событие: площадка или сервис доната. */
export const COLOR_KEYS = ['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'donationalerts', 'donatepay', 'donatex', 'boosty', 'hub'] as const
export type ColorKey = (typeof COLOR_KEYS)[number]
export const COLOR_LABEL: Record<ColorKey, string> = {
  twitch: 'Twitch', youtube: 'YouTube', vk: 'VK Видео', kick: 'Kick', goodgame: 'GoodGame', donationalerts: 'DonationAlerts',
  donatepay: 'DonatePay', donatex: 'DonateX', boosty: 'Boosty', hub: 'Ручные донаты'
}
export const DEFAULT_COLORS: Record<ColorKey, string> = {
  twitch: '#9146ff', youtube: '#ff3355', vk: '#2f7dff', kick: '#53fc18', goodgame: '#7d9cff', donationalerts: '#f57d07',
  donatepay: '#2fbf71', donatex: '#ff4f8b', boosty: '#f15f2c', hub: '#ffb27a'
}

export interface TextStyle {
  font: ChatFont
  /** px; 0 — как основной размер шрифта. */
  size: number
  weight: 400 | 600 | 800
  italic: boolean
  upper: boolean
  /** '' — цвет по умолчанию (у ника — цвет из чата площадки). */
  color: string
  /** Межбуквенный интервал, px. */
  letter: number
  /** Высота строки, % от размера. */
  line: number
  /** Обводка, px (0 — нет). */
  stroke: number
  strokeColor: string
  /** Размытие тени, px (0 — нет). */
  shadow: number
  shadowColor: string
}

export interface ChatLook {
  animIn: (typeof ANIM_IN)[number]
  animOut: (typeof ANIM_OUT)[number]
  animMs: number
  /** Вертикальный чат: новые сообщения сверху (по умолчанию — снизу). */
  newestTop: boolean
  gap: number
  radius: number
  bg: (typeof BG_STYLES)[number]
  /** Непрозрачность подложки, %. */
  opacity: number
  /** Значок площадки: цветная точка или короткая подпись (Tw, YT). */
  plat: 'dot' | 'tag'
  showName: boolean
  /** Знак после ника. */
  sep: string
  showEmotes: boolean
  /** Размер смайлов, % от строки. */
  emoteScale: number
  /** Чьи чаты показывать; пусто — все подключённые. */
  platforms: string[]
  events: Record<ChatEventKind, boolean>
  highlight: (typeof HIGHLIGHTS)[number]
  colors: Record<ColorKey, string>
  textMode: 'all' | 'split'
  text: TextStyle
  name: TextStyle
  msg: TextStyle
  event: TextStyle
}

export const textDefaults = (over: Partial<TextStyle> = {}): TextStyle => ({
  font: 'manrope', size: 0, weight: 600, italic: false, upper: false, color: '', letter: 0, line: 135,
  stroke: 0, strokeColor: '#000000', shadow: 0, shadowColor: '#000000', ...over
})

export const lookDefaults = (over: Partial<ChatLook> = {}): ChatLook => ({
  animIn: 'slide', animOut: 'fade', animMs: 300, newestTop: false, gap: 8, radius: 14, bg: 'card', opacity: 72,
  plat: 'dot', showName: true, sep: ':', showEmotes: true, emoteScale: 160, platforms: [],
  events: { donation: true, follow: true, sub: true, gift: true, raid: true, bits: true, reward: true, mention: true },
  highlight: 'fill', colors: { ...DEFAULT_COLORS }, textMode: 'all',
  text: textDefaults(), name: textDefaults({ weight: 800 }), msg: textDefaults(), event: textDefaults({ weight: 800, size: 0 }),
  ...over
})

// ---------- Проверка ----------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const int = (v: unknown, d: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d)
const hex = (v: unknown, d: string, allowEmpty = false): string =>
  typeof v === 'string' && (/^#[0-9a-fA-F]{6}$/.test(v) || (allowEmpty && v === '')) ? v.toLowerCase() : d

export function sanitizeText(v: unknown, d: TextStyle): TextStyle {
  const o = obj(v)
  const w = o.weight === 400 || o.weight === 600 || o.weight === 800 ? o.weight : d.weight
  return {
    font: oneOf(o.font, CHAT_FONTS, d.font), size: int(o.size, d.size, 0, 96), weight: w, italic: bool(o.italic, d.italic), upper: bool(o.upper, d.upper),
    color: hex(o.color, d.color, true), letter: int(o.letter, d.letter, -2, 20), line: int(o.line, d.line, 90, 220),
    stroke: int(o.stroke, d.stroke, 0, 8), strokeColor: hex(o.strokeColor, d.strokeColor), shadow: int(o.shadow, d.shadow, 0, 30), shadowColor: hex(o.shadowColor, d.shadowColor)
  }
}

export function sanitizeLook(v: unknown, d: ChatLook): ChatLook {
  const o = obj(v)
  const ev = obj(o.events)
  const events = {} as Record<ChatEventKind, boolean>
  for (const k of CHAT_EVENTS) events[k] = bool(ev[k], d.events[k])
  const co = obj(o.colors)
  const colors = {} as Record<ColorKey, string>
  for (const k of COLOR_KEYS) colors[k] = hex(co[k], d.colors[k] ?? DEFAULT_COLORS[k])
  const platforms = Array.isArray(o.platforms)
    ? [...new Set(o.platforms.filter((p): p is string => typeof p === 'string' && (CHAT_SOURCES as readonly string[]).includes(p)))]
    : d.platforms
  return {
    animIn: oneOf(o.animIn, ANIM_IN, d.animIn), animOut: oneOf(o.animOut, ANIM_OUT, d.animOut), animMs: int(o.animMs, d.animMs, 100, 2000),
    newestTop: bool(o.newestTop, d.newestTop), gap: int(o.gap, d.gap, 0, 40), radius: int(o.radius, d.radius, 0, 30),
    bg: oneOf(o.bg, BG_STYLES, d.bg), opacity: int(o.opacity, d.opacity, 0, 100),
    plat: o.plat === 'dot' || o.plat === 'tag' ? o.plat : d.plat, showName: bool(o.showName, d.showName),
    sep: typeof o.sep === 'string' ? o.sep.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 4) : d.sep,
    showEmotes: bool(o.showEmotes, d.showEmotes), emoteScale: int(o.emoteScale, d.emoteScale, 50, 300), platforms, events,
    highlight: oneOf(o.highlight, HIGHLIGHTS, d.highlight), colors, textMode: o.textMode === 'split' || o.textMode === 'all' ? o.textMode : d.textMode,
    text: sanitizeText(o.text, d.text), name: sanitizeText(o.name, d.name), msg: sanitizeText(o.msg, d.msg), event: sanitizeText(o.event, d.event)
  }
}

// ---------- Вид события в ленте ----------

export interface ChatEventView {
  kind: ChatEventKind
  icon: string
  label: string
  detail: string
  /** Текст под плашкой (сообщение зрителя). */
  body: string
  /** Ключ цвета: площадка или сервис доната. */
  color: ColorKey
}

const CUR: Record<string, string> = { RUB: '₽', USD: '$', EUR: '€', UAH: '₴', KZT: '₸', BYN: 'Br' }
const money = (n: number | undefined, cur: string | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  const v = n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  const c = (cur || 'RUB').toUpperCase()
  return `${v} ${CUR[c] ?? c}`
}
const isColorKey = (p: string): p is ColorKey => (COLOR_KEYS as readonly string[]).includes(p)

/** Как событие выглядит в ленте чата; null — это не событие для чата. */
export function eventView(e: HubEvent): ChatEventView | null {
  const color: ColorKey = isColorKey(e.platform) ? e.platform : 'hub'
  const n = typeof e.amount === 'number' && Number.isFinite(e.amount) ? Math.round(e.amount) : 0
  const text = e.text ?? ''
  switch (e.type) {
    case 'donation': return { kind: 'donation', icon: '◆', label: e.manual ? 'Донат вручную' : 'Донат', detail: money(e.amount, e.currency), body: text, color }
    case 'follow': return { kind: 'follow', icon: '♥', label: 'Новый фолловер', detail: '', body: '', color }
    case 'sub': return { kind: 'sub', icon: '★', label: 'Подписка', detail: '', body: text, color }
    case 'gift': return { kind: 'gift', icon: '✚', label: 'Дарит подписки', detail: n ? `× ${n}` : '', body: '', color }
    case 'raid': return { kind: 'raid', icon: '➜', label: 'Рейд', detail: n ? `${n} зрителей` : '', body: '', color }
    case 'bits': return { kind: 'bits', icon: '◇', label: 'Биты', detail: n ? String(n) : '', body: text.replace(/^cheer\d+\s*/i, ''), color }
    case 'reward': {
      const name = e.reward ?? ''
      const body = name && text.startsWith(name) ? text.slice(name.length).replace(/^\s*—\s*/, '') : text
      return { kind: 'reward', icon: '✦', label: 'Награда', detail: name, body, color }
    }
    default: return null
  }
}

/** Обращение к стримеру: «@ник» или ник отдельным словом. */
export function isMention(text: string, own: string[]): boolean {
  const t = text.toLowerCase().replace(/ё/g, 'е')
  return own.some((o) => {
    const n = o.toLowerCase().replace(/ё/g, 'е').replace(/^@/, '')
    if (n.length < 2) return false
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${esc}($|[^\\p{L}\\p{N}_])`, 'u').test(t)
  })
}

// ---------- CSS ----------

const THEMES = `
{R}.t-general { --fg:#ffffff; --muted:#c8c8d0; --cardrgb:16,16,20; --edge:rgba(255,255,255,.10); --accent:#8e7dff; --accentf:#8e7dff4d; }
{R}.t-campfire { --fg:#f3e9e2; --muted:#b9a69b; --cardrgb:26,19,17; --edge:#9a3fd6; --accent:#ffb27a; --accentf:#ffb27a4d; }`

function textCss(t: TextStyle, base: number, nameColor = false): string {
  const out: string[] = [`font-family:${FONT_CSS[t.font]}`, `font-weight:${t.weight}`, `font-style:${t.italic ? 'italic' : 'normal'}`,
    `text-transform:${t.upper ? 'uppercase' : 'none'}`, `letter-spacing:${t.letter}px`, `line-height:${t.line / 100}`]
  if (t.size > 0) out.push(`font-size:${t.size}px`)
  else out.push(`font-size:${base}px`)
  if (t.color && !nameColor) out.push(`color:${t.color}`)
  if (t.stroke > 0) out.push(`-webkit-text-stroke:${t.stroke}px ${t.strokeColor}`, 'paint-order:stroke fill')
  else out.push('-webkit-text-stroke:0')
  out.push(t.shadow > 0 ? `text-shadow:0 1px ${t.shadow}px ${t.shadowColor}, 0 0 ${Math.round(t.shadow / 2)}px ${t.shadowColor}` : 'text-shadow:none')
  return out.join(';')
}

/**
 * CSS ленты чата. root — корень (в OBS — body, в предпросмотре — контейнер), mode: v — колонка, h — строка, f — поверх игры.
 * Все значения уже проверены sanitizeLook, поэтому в CSS попадают только числа, цвета #rrggbb и шрифты из списка.
 */
export function chatCss(look: ChatLook, fontSize: number, root: string, mode: 'v' | 'h' | 'f'): string {
  const R = root
  const ms = look.animMs
  const op = look.opacity / 100
  const bg = look.bg === 'plain' ? 'transparent' : `rgba(var(--cardrgb),${op})`
  const edge = look.bg === 'card' && look.opacity > 0 ? 'box-shadow:0 0 0 1.5px var(--edge)' : 'box-shadow:none'
  const radius = look.bg === 'strip' ? Math.min(look.radius, 4) : look.radius
  const pad = look.bg === 'plain' ? '.15em .2em' : '.45em .75em'
  const slideFrom = mode === 'h' ? 'translateX(-24px)' : look.newestTop ? 'translateY(-14px)' : 'translateY(14px)'
  const css: string[] = [THEMES.replace(/\{R\}/g, R)]
  css.push(`${R} { --fs:${fontSize}px; color:var(--fg); }`)
  css.push(`${R} .msg { position:relative; padding:${pad}; border-radius:${radius}px; background:${bg}; ${edge}; overflow-wrap:anywhere; animation:cx-in ${ms}ms ease both; }`)
  if (look.bg === 'strip') css.push(`${R} .msg { border-radius:${radius}px; }`)
  css.push(`${R} .msg.gone { animation:cx-out ${ms}ms ease forwards; }`)
  css.push(`${R} .msg.still { animation:none; }`)
  css.push(`${R} #list, ${R} .cx-list { gap:${look.gap}px; }`)
  // Текст
  if (look.textMode === 'all') {
    css.push(`${R} .msg { ${textCss(look.text, fontSize)} }`)
    css.push(`${R} .msg .name { font-weight:${Math.max(look.text.weight, 800)}; }`)
  } else {
    css.push(`${R} .msg { ${textCss(look.msg, fontSize)} }`)
    css.push(`${R} .msg .name { ${textCss(look.name, fontSize, true)} }`)
    if (look.name.color) css.push(`${R} .msg .name.fixed { color:${look.name.color} !important; }`)
    css.push(`${R} .msg .ev-head { ${textCss(look.event, fontSize)} }`)
  }
  css.push(`${R} .sep { color:var(--muted); margin-right:.3em; }`)
  css.push(`${R} .name { margin-right:0; }`)
  css.push(`${R} .name.nosep { margin-right:.35em; }`)
  css.push(`${R} .emote { height:${(look.emoteScale / 100).toFixed(2)}em; vertical-align:middle; margin:-.25em .05em; }`)
  css.push(`${R} .badge { height:1em; vertical-align:-.12em; margin-right:.25em; }`)
  // Значок площадки
  if (look.plat === 'dot') css.push(`${R} .plat { display:inline-block; width:.55em; height:.55em; border-radius:50%; margin-right:.4em; vertical-align:.12em; background:var(--pc); }`)
  else css.push(`${R} .plat { display:inline-block; padding:.05em .4em; border-radius:.35em; margin-right:.4em; font:800 .62em/1.5 'Manrope',sans-serif; color:#fff; vertical-align:.18em; background:var(--pc); text-shadow:none; -webkit-text-stroke:0; letter-spacing:.02em; text-transform:none; font-style:normal; }`)
  // События
  css.push(`${R} .ev-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:.15em .45em; }`)
  css.push(`${R} .ev-label { color:var(--ec); }`)
  css.push(`${R} .ev-detail { opacity:.9; }`)
  css.push(`${R} .ev-body { margin-top:.2em; }`)
  const hl: Record<string, string> = {
    none: '',
    frame: `box-shadow:inset 0 0 0 2px var(--ec)`,
    fill: `background-color:rgba(var(--cardrgb),${Math.max(op, 0.55)}); background-image:linear-gradient(var(--ecf),var(--ecf))`,
    both: `box-shadow:inset 0 0 0 2px var(--ec); background-color:rgba(var(--cardrgb),${Math.max(op, 0.55)}); background-image:linear-gradient(var(--ecf),var(--ecf))`,
    bar: `box-shadow:inset 4px 0 0 var(--ec); padding-left:calc(.75em + 4px)`
  }
  if (look.highlight !== 'none') css.push(`${R} .msg.ev, ${R} .msg.mention { ${hl[look.highlight]}; }`)
  css.push(`${R} .msg.mention { --ec:var(--accent); --ecf:var(--accentf); }`)
  css.push(`${R} .msg.system { color:#ffb24a; font-size:.85em; }`)
  // Анимации
  const inKf: Record<string, string> = {
    none: 'from{} to{}',
    fade: 'from{opacity:0}',
    slide: `from{opacity:0;transform:${slideFrom}}`,
    pop: 'from{opacity:0;transform:scale(.7)} 70%{transform:scale(1.04)}',
    blur: 'from{opacity:0;filter:blur(8px)}',
    bounce: `from{opacity:0;transform:translateY(${mode === 'h' ? 0 : 20}px)} 60%{opacity:1;transform:translateY(-5px)} 80%{transform:translateY(2px)}`
  }
  const outKf: Record<string, string> = {
    none: 'to{opacity:0}',
    fade: 'to{opacity:0}',
    slide: `to{opacity:0;transform:${mode === 'h' ? 'translateX(24px)' : 'translateX(-30px)'}}`,
    shrink: 'to{opacity:0;transform:scale(.8)}'
  }
  css.push(`@keyframes cx-in { ${inKf[look.animIn]} }`)
  css.push(`@keyframes cx-out { ${outKf[look.animOut]} }`)
  if (look.animIn === 'none') css.push(`${R} .msg { animation:none; }`)
  if (look.animOut === 'none') css.push(`${R} .msg.gone { animation-duration:1ms; }`)
  return css.join('\n')
}

// ---------- Тестовые сообщения (предпросмотр и «Тест в OBS») ----------

const NAMES = ['pixel_fox', 'night_raven', 'Ёжик_в_тумане', 'kotleta228', 'SashaPlays', 'lumen', 'moroz_ivan', 'crow_ru', 'tihiy_omut', 'Bublik', 'Marisha', 'old_gamer']
const TEXTS = ['всем привет у костра!', 'го ещё катку', 'это было мощно', 'ахахах', 'а что за игра?', 'стример, ты лучший', 'звук отличный сегодня', 'лол', 'как прошёл день?', 'GG', 'давай босса', 'я с работы, всем привет']
const COLORS = ['#ff7a90', '#7ad3ff', '#ffd27a', '#a8ff7a', '#d17aff', '#ffb27a']

/** i-е тестовое событие ленты: в основном сообщения, иногда донат, подписка, рейд, упоминание. */
export function sampleChat(i: number, own: string): HubEvent {
  const plat = CHAT_SOURCES[i % CHAT_SOURCES.length] as Platform
  const user = NAMES[(i * 7) % NAMES.length]
  const base = { id: `cxtest-${Date.now()}-${i}`, ts: Date.now(), platform: plat, user, test: true }
  const k = i % 11
  if (k === 3) return { ...base, platform: 'donationalerts', type: 'donation', amount: [100, 300, 500, 1500][i % 4], currency: 'RUB', amountRub: 500, text: 'Спасибо за стрим!' }
  if (k === 6) return { ...base, platform: 'twitch', type: 'sub', text: `${(i % 12) + 1} мес. вместе` }
  if (k === 8) return { ...base, type: 'message', text: `@${own} ${TEXTS[i % TEXTS.length]}`, parts: [{ t: 'text', v: `@${own} ${TEXTS[i % TEXTS.length]}` }], color: COLORS[i % COLORS.length] }
  if (k === 9) return { ...base, platform: 'twitch', type: 'raid', amount: 40 + i, text: `${40 + i} зрителей` }
  if (k === 10) return { ...base, platform: 'twitch', type: 'reward', reward: 'Заказ трека', text: 'Заказ трека — Кино, Группа крови' }
  const t = TEXTS[(i * 5) % TEXTS.length]
  return { ...base, type: 'message', text: t, parts: [{ t: 'text', v: t }], color: COLORS[i % COLORS.length] }
}
