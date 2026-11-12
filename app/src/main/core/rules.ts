import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Hub } from './hub'
import type { Store } from './db'
import type { HubEvent, HubEventType, Platform } from './types'
import { COUNTER_OPS, type CounterOp, type Counters } from './counters'
import { ALERT_KINDS, type AlertKind, type AlertRule, type Settings } from './settings'
import {
  bool, id, num, obj, oneOf, str, soundId, sanitizeObs, newLayer, simpleTemplate,
  type AlertTemplate, type Layer, type ObsAction, type TemplateStore
} from './templates'

/**
 * Единая модель правил Crossember: «событие + площадка + условие → действия».
 * Одна для алертов, озвучки, OBS (позже — аукцион, интерактив). У каждого правила включатель, кулдаун и журнал.
 * Правила проверяются сверху вниз; «стоп» — следующие правила для этого события не проверяются.
 */

export const TRIGGER_TYPES = ['donation', 'sub', 'gift', 'follow', 'raid', 'bits', 'reward', 'message', 'stream_start', 'stream_end', 'timer', 'hotkey', 'goal_stage', 'goal_done'] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]
/** Служебные поводы: не события зрителей, а эфир, таймер, горячая клавиша и сбор средств. Условия и площадки к ним не применяются. */
export const SERVICE_TRIGGERS = ['stream_start', 'stream_end', 'timer', 'hotkey', 'goal_stage', 'goal_done'] as const
export type ServiceTrigger = (typeof SERVICE_TRIGGERS)[number]
const SERVICE_USER: Record<ServiceTrigger, string> = { stream_start: 'Эфир начался', stream_end: 'Эфир закончился', timer: 'Таймер', hotkey: 'Горячая клавиша', goal_stage: 'Сбор: этап', goal_done: 'Сбор: цель' }
/** Горячая клавиша: Ctrl/Alt/Shift + буква, цифра, F1–F24 или цифра доп. клавиатуры; без модификатора — только F-клавиши. */
export const HOTKEY_RE = /^(?:(?:Ctrl|Alt|Shift)\+){1,3}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|num[0-9])$|^F(?:[1-9]|1\d|2[0-4])$/
const PLATFORMS: Platform[] = ['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'donationalerts', 'donatepay', 'donatex', 'boosty', 'hub']

/**
 * Когда читать озвучку из правила: with — вместе с алертом (через 0,6 с); afterIn — когда закончится анимация появления;
 * delay — через delaySec секунд от начала алерта; after — после алерта, отдельно, следом в той же очереди.
 */
export const TTS_WHEN = ['with', 'afterIn', 'delay', 'after'] as const
export type TtsWhen = (typeof TTS_WHEN)[number]

export interface RuleFilter {
  /** Сумма от (₽ для донатов, биты, зрители рейда…); 0 — не важно. */
  minAmount: number
  /** Сумма до (не включая); 0 — не важно. */
  maxAmount: number
  /** Слова через запятую: сработает, если в тексте есть любое. Пусто — не важно. */
  textContains: string
  /** Ники через запятую. Пусто — все. */
  users: string
  /** any — все события, real — только настоящие, test — только тестовые. */
  tests: 'any' | 'real' | 'test'
}

export type RuleAction =
  | { type: 'alert'; templateId: string }
  | { type: 'tts'; text: string; voice: string; rate: number; volume: number; when: TtsWhen; delaySec: number }
  | { type: 'sound'; sound: string; volume: number }
  | { type: 'obs'; obs: ObsAction }
  | { type: 'counter'; counterId: string; op: CounterOp; value: number }

export interface Rule {
  id: string
  name: string
  enabled: boolean
  /** Пусто — правило ни на что не срабатывает. */
  types: TriggerType[]
  /** Пусто — все площадки. */
  platforms: Platform[]
  filter: RuleFilter
  cooldownSec: number
  /** Кулдаун отдельно для каждого зрителя. */
  cooldownPerUser: boolean
  stop: boolean
  actions: RuleAction[]
  /** Повод «каждые N минут»: интервал. */
  intervalMin: number
  /** Повод «каждые N минут»: только пока идёт эфир. */
  onlyLive: boolean
  /** Повод «горячая клавиша»: сочетание в формате Electron (Ctrl+Shift+1). */
  hotkey: string
}

export interface RuleLogEntry {
  ts: number
  ruleId: string
  ruleName: string
  user: string
  platform: Platform
  type: HubEventType | TriggerType
  result: 'done' | 'dry' | 'cooldown' | 'error' | 'test'
  detail: string
}

export interface RulesState {
  enabled: boolean
  dryRun: boolean
  rules: Rule[]
  log: RuleLogEntry[]
  /** Горячие клавиши, которые не удалось занять: id правила → причина. */
  hotkeyErrors: Record<string, string>
}

/** Что делать с событием: собрано по всем подошедшим правилам. */
export interface RulePlan {
  templates: AlertTemplate[]
  /** Озвучка и звуки: прикрепляются к первому алерту события или играют отдельно. */
  extras: Layer[]
  /** Озвучка «после появления»: время начала считается по анимациям первого алерта. */
  afterIn: Layer[]
  /** Озвучка «после алерта»: отдельным элементом очереди следом за алертами события. */
  after: Layer[]
  obs: ObsAction[]
  /** Изменения счётчиков: применяются до алертов, чтобы в тексте было уже новое значение. */
  counters: { counterId: string; op: CounterOp; value: number }[]
}

/** Исполнители действий (алерты, OBS) — подключаются в index.ts. */
export interface RuleRunner {
  play(plan: RulePlan, e: HubEvent, force: boolean): void
  obs(a: ObsAction, e: HubEvent): Promise<void>
  /** Идёт ли эфир (для таймеров «только во время эфира»). */
  isLive(): boolean
}

const LOG_LIMIT = 200

function sanitizeAction(v: unknown): RuleAction | null {
  const o = obj(v)
  switch (o.type) {
    case 'alert': return typeof o.templateId === 'string' && /^[\w-]{1,40}$/.test(o.templateId) ? { type: 'alert', templateId: o.templateId } : null
    case 'tts': return {
      type: 'tts', text: str(o.text, '{user} — {amount}. {message}', 300), voice: str(o.voice, '', 100), rate: num(o.rate, 0, -10, 10), volume: num(o.volume, 100, 0, 100),
      when: oneOf(o.when, TTS_WHEN, 'with'), delaySec: num(o.delaySec, 2, 0, 60, false)
    }
    case 'sound': return { type: 'sound', sound: soundId(o.sound, 'coin'), volume: num(o.volume, 80, 0, 100) }
    case 'obs': return { type: 'obs', obs: sanitizeObs(o.obs) }
    case 'counter': return { type: 'counter', counterId: id(o.counterId), op: oneOf(o.op, COUNTER_OPS, 'add'), value: num(o.value, 1, 0, 1_000_000_000) }
    default: return null
  }
}

export function sanitizeRule(v: unknown): Rule {
  const o = obj(v)
  const f = obj(o.filter)
  const types = Array.isArray(o.types) ? o.types.filter((t): t is TriggerType => (TRIGGER_TYPES as readonly string[]).includes(t as string)) : []
  const platforms = Array.isArray(o.platforms) ? o.platforms.filter((p): p is Platform => PLATFORMS.includes(p as Platform)) : []
  return {
    id: id(o.id),
    name: str(o.name, 'Новое правило', 60).trim() || 'Новое правило',
    enabled: bool(o.enabled, true),
    types: [...new Set(types)],
    platforms: [...new Set(platforms)],
    filter: {
      minAmount: num(f.minAmount, 0, 0, 10_000_000),
      maxAmount: num(f.maxAmount, 0, 0, 10_000_000),
      textContains: str(f.textContains, '', 200),
      users: str(f.users, '', 300),
      tests: oneOf(f.tests, ['any', 'real', 'test'] as const, 'any')
    },
    cooldownSec: num(o.cooldownSec, 0, 0, 86_400),
    cooldownPerUser: bool(o.cooldownPerUser, false),
    stop: bool(o.stop, false),
    actions: (Array.isArray(o.actions) ? o.actions : []).slice(0, 20).map(sanitizeAction).filter((a): a is RuleAction => !!a),
    intervalMin: num(o.intervalMin, 15, 1, 720),
    onlyLive: bool(o.onlyLive, true),
    hotkey: typeof o.hotkey === 'string' && HOTKEY_RE.test(o.hotkey) ? o.hotkey : ''
  }
}

/** Сумма события для условий: донаты — в рублях, остальное — как есть. */
export function eventValue(e: HubEvent): number {
  // Донат в другой валюте без пересчёта в рубли сервисом не считаем рублями (иначе $10 прошли бы как 10 ₽).
  if (e.type === 'donation') return e.amountRub ?? (e.currency === 'RUB' || !e.currency ? e.amount ?? 0 : 0)
  return e.amount ?? 0
}

const list = (s: string): string[] => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

/** Подходит ли событие под правило (без учёта включателя и кулдауна). */
export function matches(r: Rule, e: HubEvent): boolean {
  if (!(r.types as string[]).includes(e.type)) return false
  if (r.platforms.length && !r.platforms.includes(e.platform)) return false
  const f = r.filter
  if (f.tests === 'real' && e.test) return false
  if (f.tests === 'test' && !e.test) return false
  const v = eventValue(e)
  if (f.minAmount > 0 && v < f.minAmount) return false
  if (f.maxAmount > 0 && v >= f.maxAmount) return false
  const words = list(f.textContains)
  if (words.length) {
    const t = (e.text ?? '').toLowerCase()
    if (!words.some((w) => t.includes(w))) return false
  }
  const users = list(f.users)
  if (users.length && !users.includes(e.user.toLowerCase())) return false
  return true
}

const KIND_LABEL: Record<AlertKind, string> = {
  donation: 'Донат', sub: 'Подписка', gift: 'Подарочные подписки', follow: 'Фоллоу', raid: 'Рейд', bits: 'Биты', reward: 'Баллы'
}

/** Первый запуск этапа 4: старые настройки алертов (тип → шаблон + варианты по сумме) → шаблоны и правила. */
export function migrateLegacy(legacy: Record<AlertKind, AlertRule>): { templates: AlertTemplate[]; rules: Rule[] } {
  const templates: AlertTemplate[] = []
  const rules: Rule[] = []
  // Озвучка донатов — пример, выключена: включается одной галочкой.
  rules.push(sanitizeRule({
    name: 'Озвучка донатов', enabled: false, types: ['donation'], filter: { minAmount: 100 },
    actions: [{ type: 'tts', text: '{user} — {amount}. {message}', voice: '', rate: 0, volume: 100 }]
  }))
  for (const kind of ALERT_KINDS) {
    const r = legacy[kind]
    const label = KIND_LABEL[kind]
    const msg = r.showMessage && kind !== 'follow' && kind !== 'reward'
    for (const t of [...r.tiers].sort((a, b) => b.from - a.from)) {
      const tpl = simpleTemplate(`${label} от ${t.from}`, t.kicker, r.title, t.sound, r.volume, t.durationSec, msg)
      templates.push(tpl)
      rules.push(sanitizeRule({
        name: `${label} от ${t.from}`, enabled: r.enabled, types: [kind], filter: { minAmount: Math.max(t.from, r.minAmount) },
        stop: true, actions: [{ type: 'alert', templateId: tpl.id }]
      }))
    }
    const tpl = simpleTemplate(label, r.kicker, r.title, r.sound, r.volume, r.durationSec, msg)
    templates.push(tpl)
    rules.push(sanitizeRule({
      name: label, enabled: r.enabled, types: [kind], filter: { minAmount: r.minAmount }, stop: true, actions: [{ type: 'alert', templateId: tpl.id }]
    }))
  }
  return { templates, rules }
}

/**
 * Движок правил. Слушает все события хаба и решает, что делать.
 * События: 'change'.
 */
export class RuleEngine extends EventEmitter {
  private rules: Rule[]
  private enabled: boolean
  private dryRun: boolean
  private log: RuleLogEntry[] = []
  private lastFire = new Map<string, number>()
  /** Таймеры «каждые N минут»: id правила → когда сработать. */
  private nextAt = new Map<string, number>()
  private tick: NodeJS.Timeout
  private wasLive = false
  private hotkeyErrors: Record<string, string> = {}

  constructor(private hub: Hub, private store: Store, private settings: Settings, private templates: TemplateStore, private runner: RuleRunner, private counters: Counters) {
    super()
    if (!templates.initialized()) {
      const m = migrateLegacy(settings.get().alerts.rules)
      templates.setAll(m.templates)
      store.set('rules.v1', m.rules)
    }
    const raw = store.get<unknown[]>('rules.v1', [])
    this.rules = (Array.isArray(raw) ? raw : []).slice(0, 200).map(sanitizeRule)
    const flags = obj(store.get('rules.flags', {}))
    this.enabled = bool(flags.enabled, true)
    this.dryRun = bool(flags.dryRun, false)
    hub.on('event', (e: HubEvent) => this.handle(e))
    this.tick = setInterval(() => this.timers(), 5000)
  }

  state(): RulesState {
    return { enabled: this.enabled, dryRun: this.dryRun, rules: this.rules, log: this.log.slice(0, 60), hotkeyErrors: this.hotkeyErrors }
  }

  dispose(): void {
    clearInterval(this.tick)
  }

  /** Горячие клавиши включённых правил — их занимает index.ts. */
  hotkeys(): { id: string; accel: string }[] {
    return this.rules.filter((r) => r.enabled && r.types.includes('hotkey') && r.hotkey).map((r) => ({ id: r.id, accel: r.hotkey }))
  }

  setHotkeyErrors(errors: Record<string, string>): void {
    if (JSON.stringify(errors) === JSON.stringify(this.hotkeyErrors)) return
    this.hotkeyErrors = errors
    this.emit('change')
  }

  /** «Каждые N минут»: первый раз — через N минут после включения правила (или начала эфира). */
  private timers(): void {
    const now = Date.now()
    const live = this.runner.isLive()
    if (live && !this.wasLive) this.nextAt.clear()
    this.wasLive = live
    for (const r of this.rules) {
      if (!r.enabled || !r.types.includes('timer') || (r.onlyLive && !live)) { this.nextAt.delete(r.id); continue }
      const at = this.nextAt.get(r.id)
      if (at === undefined) this.nextAt.set(r.id, now + r.intervalMin * 60_000)
      else if (now >= at) {
        this.nextAt.set(r.id, now + r.intervalMin * 60_000)
        this.fireRule(r.id, 'timer')
      }
    }
  }

  /** Событие-заглушка для служебного повода: в ленту не попадает, нужно только для действий и журнала. */
  private serviceEvent(kind: ServiceTrigger): HubEvent {
    return { id: randomUUID(), ts: Date.now(), platform: kind === 'stream_start' || kind === 'stream_end' ? 'obs' : 'hub', type: 'system', user: SERVICE_USER[kind] }
  }

  /** Эфир начался / закончился: все подходящие правила сверху вниз (со «стоп» и кулдауном). */
  fireService(kind: 'stream_start' | 'stream_end'): void {
    this.process(this.serviceEvent(kind), (r) => r.types.includes(kind), kind)
  }

  /**
   * Сбор средств: этап или цель достигнуты. В тексте алерта/озвучки: {user} — название этапа или цели,
   * {amount} — сколько собрано всего, {message} — «Собрано X из Y».
   */
  fireGoal(kind: 'goal_stage' | 'goal_done', name: string, collected: number, message: string): void {
    const e: HubEvent = { ...this.serviceEvent(kind), user: name || SERVICE_USER[kind], amount: collected, currency: 'RUB', amountRub: collected, text: message }
    this.process(e, (r) => r.types.includes(kind), kind)
  }

  /** Таймер или горячая клавиша конкретного правила. */
  fireRule(ruleId: string, kind: 'timer' | 'hotkey'): void {
    this.process(this.serviceEvent(kind), (r) => r.id === ruleId && r.types.includes(kind), kind)
  }

  private save(): void {
    this.store.set('rules.v1', this.rules)
    this.emit('change')
  }

  setFlags(p: { enabled?: unknown; dryRun?: unknown }): void {
    this.enabled = bool(p.enabled, this.enabled)
    this.dryRun = bool(p.dryRun, this.dryRun)
    this.store.set('rules.flags', { enabled: this.enabled, dryRun: this.dryRun })
    this.emit('change')
  }

  /** Добавить или заменить правило. */
  put(v: unknown): Rule {
    const r = sanitizeRule(v)
    const i = this.rules.findIndex((x) => x.id === r.id)
    this.nextAt.delete(r.id) // таймер правила считается заново
    if (i >= 0) this.rules[i] = r
    else {
      if (this.rules.length >= 200) throw new Error('Слишком много правил (максимум 200)')
      this.rules.push(r)
    }
    this.save()
    return r
  }

  /** Заменить все правила (загрузка профиля). */
  replaceAll(list: Rule[], flags?: unknown): void {
    this.rules = list.slice(0, 200)
    this.nextAt.clear()
    this.lastFire.clear()
    const f = obj(flags)
    this.enabled = bool(f.enabled, this.enabled)
    this.dryRun = bool(f.dryRun, this.dryRun)
    this.store.set('rules.flags', { enabled: this.enabled, dryRun: this.dryRun })
    this.save()
  }

  remove(ruleId: string): void {
    this.rules = this.rules.filter((r) => r.id !== ruleId)
    this.save()
  }

  /** Сдвинуть правило выше (−1) или ниже (+1). */
  move(ruleId: string, dir: number): void {
    const i = this.rules.findIndex((r) => r.id === ruleId)
    const j = i + (dir < 0 ? -1 : 1)
    if (i < 0 || j < 0 || j >= this.rules.length) return
    ;[this.rules[i], this.rules[j]] = [this.rules[j], this.rules[i]]
    this.save()
  }

  clearLog(): void {
    this.log = []
    this.emit('change')
  }

  /** Шаблон удалён — убрать ссылки на него из правил. */
  forgetTemplate(templateId: string): void {
    let changed = false
    for (const r of this.rules) {
      const n = r.actions.filter((a) => !(a.type === 'alert' && a.templateId === templateId))
      if (n.length !== r.actions.length) { r.actions = n; changed = true }
    }
    if (changed) this.save()
  }

  /** Счётчик удалён — убрать действия с ним. */
  forgetCounter(counterId: string): void {
    let changed = false
    for (const r of this.rules) {
      const n = r.actions.filter((a) => !(a.type === 'counter' && a.counterId === counterId))
      if (n.length !== r.actions.length) { r.actions = n; changed = true }
    }
    if (changed) this.save()
  }

  private addLog(r: Rule, e: HubEvent, result: RuleLogEntry['result'], detail: string, type: RuleLogEntry['type'] = e.type): void {
    this.log.unshift({ ts: Date.now(), ruleId: r.id, ruleName: r.name, user: e.user, platform: e.platform, type, result, detail })
    if (this.log.length > LOG_LIMIT) this.log.length = LOG_LIMIT
  }

  private describe(r: Rule): string {
    return r.actions.map((a) => {
      if (a.type === 'alert') return `алерт «${this.templates.get(a.templateId)?.name ?? 'шаблон удалён'}»`
      if (a.type === 'tts') return 'озвучка'
      if (a.type === 'sound') return 'звук'
      if (a.type === 'counter') {
        const c = this.counters.get(a.counterId)
        const how = a.op === 'add' ? `+${a.value}` : a.op === 'sub' ? `−${a.value}` : a.op === 'set' ? `= ${a.value}` : '+ сумма'
        return `счётчик «${c?.name ?? 'удалён'}» ${how}`
      }
      return `OBS: ${a.obs.op}`
    }).join(', ') || 'нет действий'
  }

  /** Добавить действия правила в общий план события. */
  private collect(r: Rule, plan: RulePlan): void {
    for (const a of r.actions) {
      if (a.type === 'alert') {
        const t = this.templates.get(a.templateId)
        if (t) plan.templates.push(t)
      } else if (a.type === 'tts') {
        const l = newLayer('tts', { text: a.text, voice: a.voice, rate: a.rate, volume: a.volume, start: a.when === 'delay' ? Math.round(a.delaySec * 1000) : a.when === 'with' ? 600 : 0 })
        if (a.when === 'afterIn') plan.afterIn.push(l)
        else if (a.when === 'after') plan.after.push(l)
        else plan.extras.push(l)
      } else if (a.type === 'sound') {
        plan.extras.push(newLayer('sound', { sound: a.sound, volume: a.volume }))
      } else if (a.type === 'counter') {
        plan.counters.push({ counterId: a.counterId, op: a.op, value: a.value })
      } else plan.obs.push(a.obs)
    }
  }

  /**
   * Счётчики → снимок значений для подстановки. Настоящее событие меняет счётчики;
   * проверка правила (кнопка «Тест») только показывает, что было бы, и ничего не меняет.
   */
  private applyCounters(plan: RulePlan, e: HubEvent, commit: boolean): Record<string, string> {
    const amount = eventValue(e)
    if (commit) {
      for (const c of plan.counters) this.counters.apply(c.counterId, c.op, c.value, amount)
      return this.counters.vars()
    }
    const copy = new Map(this.counters.list().map((c) => [c.id, { ...c }]))
    for (const c of plan.counters) {
      const x = copy.get(c.counterId)
      if (x) x.value = Math.round(c.op === 'add' ? x.value + c.value : c.op === 'sub' ? x.value - c.value : c.op === 'set' ? c.value : x.value + amount)
    }
    const out: Record<string, string> = {}
    for (const x of copy.values()) out[x.key] = String(x.value)
    return out
  }

  private execute(plan: RulePlan, ev: HubEvent, force: boolean): void {
    const e: HubEvent = { ...ev, vars: this.applyCounters(plan, ev, !force) }
    if (plan.templates.length || plan.extras.length || plan.afterIn.length || plan.after.length) this.runner.play(plan, e, force)
    for (const o of plan.obs) {
      this.runner.obs(o, e).catch((err) => this.hub.log('obs', 'warn', `Правило не выполнило действие OBS: ${(err as Error).message}`))
    }
  }

  private handle(e: HubEvent): void {
    if (e.type === 'system') return
    this.process(e, (r) => matches(r, e), e.type)
  }

  /** Пройти правила сверху вниз: pick — подходит ли правило к этому поводу. */
  private process(e: HubEvent, pick: (r: Rule) => boolean, type: RuleLogEntry['type']): void {
    if (!this.enabled) return
    const plan = emptyPlan()
    const now = Date.now()
    let any = false
    for (const r of this.rules) {
      if (!r.enabled || !pick(r)) continue
      const key = r.cooldownPerUser ? `${r.id}:${e.platform}:${e.user.toLowerCase()}` : r.id
      const last = this.lastFire.get(key) ?? 0
      if (r.cooldownSec > 0 && now - last < r.cooldownSec * 1000) {
        this.addLog(r, e, 'cooldown', `кулдаун: ещё ${Math.ceil((r.cooldownSec * 1000 - (now - last)) / 1000)} с`, type)
        any = true
        if (r.stop) break
        continue
      }
      any = true
      if (this.dryRun) this.addLog(r, e, 'dry', `сработало бы: ${this.describe(r)}`, type)
      else {
        // Удалить и вставить заново: порядок в Map — от давно сработавших к недавним.
        this.lastFire.delete(key)
        this.lastFire.set(key, now)
        this.collect(r, plan)
        this.addLog(r, e, 'done', this.describe(r), type)
      }
      if (r.stop) break
    }
    // Защита памяти: забываем только самые давние срабатывания, а не все кулдауны разом.
    if (this.lastFire.size > 5000) for (const k of [...this.lastFire.keys()].slice(0, this.lastFire.size - 4000)) this.lastFire.delete(k)
    if (!this.dryRun) this.execute(plan, e, false)
    if (any) this.emit('change')
  }

  /** Проверить правило вручную: тестовое событие, без условий и кулдауна. */
  test(ruleId: string, sample: HubEvent): boolean {
    const r = this.rules.find((x) => x.id === ruleId)
    if (!r) return false
    const plan = emptyPlan()
    this.collect(r, plan)
    this.execute(plan, sample, true)
    this.addLog(r, sample, 'test', this.describe(r))
    this.emit('change')
    return true
  }

  /** Повтор алерта из ленты: первое подходящее правило с алертом, без кулдауна; если нет — любое правило этого типа. */
  replay(e: HubEvent): boolean {
    const withAlert = this.rules.filter((r) => r.actions.some((a) => a.type === 'alert'))
    const r = withAlert.find((x) => x.enabled && matches(x, { ...e, test: e.test })) ??
      withAlert.find((x) => (x.types as string[]).includes(e.type))
    if (!r) return false
    const plan = emptyPlan()
    for (const a of r.actions) if (a.type === 'alert') { const t = this.templates.get(a.templateId); if (t) plan.templates.push(t) }
    if (!plan.templates.length) return false
    this.runner.play(plan, e, true)
    return true
  }
}

export const newRuleId = (): string => randomUUID()

const emptyPlan = (): RulePlan => ({ templates: [], extras: [], afterIn: [], after: [], obs: [], counters: [] })
