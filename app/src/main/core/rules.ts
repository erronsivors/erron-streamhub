import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Hub } from './hub'
import type { Store } from './db'
import type { HubEvent, HubEventType, Platform } from './types'
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

export const TRIGGER_TYPES = ['donation', 'sub', 'gift', 'follow', 'raid', 'bits', 'reward', 'message'] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]
const PLATFORMS: Platform[] = ['twitch', 'youtube', 'vk', 'kick', 'goodgame', 'donationalerts', 'donatepay', 'donatex', 'boosty']

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
  | { type: 'tts'; text: string; voice: string; rate: number; volume: number }
  | { type: 'sound'; sound: string; volume: number }
  | { type: 'obs'; obs: ObsAction }

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
}

export interface RuleLogEntry {
  ts: number
  ruleId: string
  ruleName: string
  user: string
  platform: Platform
  type: HubEventType
  result: 'done' | 'dry' | 'cooldown' | 'error' | 'test'
  detail: string
}

export interface RulesState {
  enabled: boolean
  dryRun: boolean
  rules: Rule[]
  log: RuleLogEntry[]
}

/** Что делать с событием: собрано по всем подошедшим правилам. */
export interface RulePlan {
  templates: AlertTemplate[]
  /** Озвучка и звуки: прикрепляются к первому алерту события или играют отдельно. */
  extras: Layer[]
  obs: ObsAction[]
}

/** Исполнители действий (алерты, OBS) — подключаются в index.ts. */
export interface RuleRunner {
  play(plan: RulePlan, e: HubEvent, force: boolean): void
  obs(a: ObsAction, e: HubEvent): Promise<void>
}

const LOG_LIMIT = 200

function sanitizeAction(v: unknown): RuleAction | null {
  const o = obj(v)
  switch (o.type) {
    case 'alert': return typeof o.templateId === 'string' && /^[\w-]{1,40}$/.test(o.templateId) ? { type: 'alert', templateId: o.templateId } : null
    case 'tts': return { type: 'tts', text: str(o.text, '{user} — {amount}. {message}', 300), voice: str(o.voice, '', 100), rate: num(o.rate, 0, -10, 10), volume: num(o.volume, 100, 0, 100) }
    case 'sound': return { type: 'sound', sound: soundId(o.sound, 'coin'), volume: num(o.volume, 80, 0, 100) }
    case 'obs': return { type: 'obs', obs: sanitizeObs(o.obs) }
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
    actions: (Array.isArray(o.actions) ? o.actions : []).slice(0, 20).map(sanitizeAction).filter((a): a is RuleAction => !!a)
  }
}

/** Сумма события для условий: донаты — в рублях, остальное — как есть. */
export function eventValue(e: HubEvent): number {
  if (e.type === 'donation') return e.amountRub ?? (e.currency === 'RUB' || !e.currency ? e.amount : undefined) ?? e.amount ?? 0
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

  constructor(private hub: Hub, private store: Store, private settings: Settings, private templates: TemplateStore, private runner: RuleRunner) {
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
  }

  state(): RulesState {
    return { enabled: this.enabled, dryRun: this.dryRun, rules: this.rules, log: this.log.slice(0, 60) }
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
    if (i >= 0) this.rules[i] = r
    else {
      if (this.rules.length >= 200) throw new Error('Слишком много правил (максимум 200)')
      this.rules.push(r)
    }
    this.save()
    return r
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

  private addLog(r: Rule, e: HubEvent, result: RuleLogEntry['result'], detail: string): void {
    this.log.unshift({ ts: Date.now(), ruleId: r.id, ruleName: r.name, user: e.user, platform: e.platform, type: e.type, result, detail })
    if (this.log.length > LOG_LIMIT) this.log.length = LOG_LIMIT
  }

  private describe(r: Rule): string {
    return r.actions.map((a) => {
      if (a.type === 'alert') return `алерт «${this.templates.get(a.templateId)?.name ?? 'шаблон удалён'}»`
      if (a.type === 'tts') return 'озвучка'
      if (a.type === 'sound') return 'звук'
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
        plan.extras.push(newLayer('tts', { text: a.text, voice: a.voice, rate: a.rate, volume: a.volume, start: 600 }))
      } else if (a.type === 'sound') {
        plan.extras.push(newLayer('sound', { sound: a.sound, volume: a.volume }))
      } else plan.obs.push(a.obs)
    }
  }

  private execute(plan: RulePlan, e: HubEvent, force: boolean): void {
    if (plan.templates.length || plan.extras.length) this.runner.play(plan, e, force)
    for (const o of plan.obs) {
      this.runner.obs(o, e).catch((err) => this.hub.log('obs', 'warn', `Правило не выполнило действие OBS: ${(err as Error).message}`))
    }
  }

  private handle(e: HubEvent): void {
    if (e.type === 'system' || !this.enabled) return
    const plan: RulePlan = { templates: [], extras: [], obs: [] }
    const now = Date.now()
    let any = false
    for (const r of this.rules) {
      if (!r.enabled || !matches(r, e)) continue
      const key = r.cooldownPerUser ? `${r.id}:${e.platform}:${e.user.toLowerCase()}` : r.id
      const last = this.lastFire.get(key) ?? 0
      if (r.cooldownSec > 0 && now - last < r.cooldownSec * 1000) {
        this.addLog(r, e, 'cooldown', `кулдаун: ещё ${Math.ceil((r.cooldownSec * 1000 - (now - last)) / 1000)} с`)
        any = true
        if (r.stop) break
        continue
      }
      any = true
      if (this.dryRun) this.addLog(r, e, 'dry', `сработало бы: ${this.describe(r)}`)
      else {
        this.lastFire.set(key, now)
        this.collect(r, plan)
        this.addLog(r, e, 'done', this.describe(r))
      }
      if (r.stop) break
    }
    if (this.lastFire.size > 5000) this.lastFire.clear()
    if (!this.dryRun) this.execute(plan, e, false)
    if (any) this.emit('change')
  }

  /** Проверить правило вручную: тестовое событие, без условий и кулдауна. */
  test(ruleId: string, sample: HubEvent): boolean {
    const r = this.rules.find((x) => x.id === ruleId)
    if (!r) return false
    const plan: RulePlan = { templates: [], extras: [], obs: [] }
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
    const plan: RulePlan = { templates: [], extras: [], obs: [] }
    for (const a of r.actions) if (a.type === 'alert') { const t = this.templates.get(a.templateId); if (t) plan.templates.push(t) }
    if (!plan.templates.length) return false
    this.runner.play(plan, e, true)
    return true
  }
}

export const newRuleId = (): string => randomUUID()
