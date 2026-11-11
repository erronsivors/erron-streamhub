import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Store } from './db'

/**
 * Счётчики (смерти, победы, «собрано на цель»…): число с именем и коротким ключом.
 * Ключ подставляется в тексты алертов, озвучки и OBS как {ключ}: «Смерть №{смерти}».
 * Меняются действием правила (прибавить, отнять, установить, прибавить сумму события) и кнопками в интерфейсе.
 */

export interface Counter {
  id: string
  /** Как показывать: «Смерти». */
  name: string
  /** Для подстановки {ключ}: буквы, цифры, подчёркивание. */
  key: string
  value: number
}

export const COUNTER_OPS = ['add', 'sub', 'set', 'amount'] as const
export type CounterOp = (typeof COUNTER_OPS)[number]

/** Ключ: русские или латинские буквы, цифры, подчёркивание; до 24 символов. */
export const COUNTER_KEY = /^[A-Za-zА-Яа-яЁё0-9_]{1,24}$/
/** Встроенные подстановки — такие ключи занимать нельзя. */
export const RESERVED_KEYS = ['user', 'amount', 'message', 'platform']
const LIMIT = 50
const MAX = 1_000_000_000

const clamp = (n: number): number => Math.min(MAX, Math.max(-MAX, Math.round(n)))
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Ключ из названия: «Смерти за стрим» → «смерти_за_стрим». */
export function keyFrom(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-zа-яё0-9_]/g, '').slice(0, 24)
}

function sanitize(v: unknown): Counter | null {
  const o = obj(v)
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 40) : ''
  if (!name) return null
  const rawKey = typeof o.key === 'string' && o.key.trim() ? o.key.trim() : keyFrom(name)
  if (!COUNTER_KEY.test(rawKey) || RESERVED_KEYS.includes(rawKey.toLowerCase())) return null
  const id = typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) ? o.id : randomUUID()
  const value = typeof o.value === 'number' && Number.isFinite(o.value) ? clamp(o.value) : 0
  return { id, name, key: rawKey, value }
}

/** События: 'change' (Counter[]). */
export class Counters extends EventEmitter {
  private items: Counter[]

  constructor(private store: Store) {
    super()
    const raw = store.get<unknown>('counters.v1', null)
    if (raw === null) {
      // Первый запуск — два примера, чтобы было с чего начать.
      this.items = [
        { id: randomUUID(), name: 'Смерти', key: 'смерти', value: 0 },
        { id: randomUUID(), name: 'Победы', key: 'победы', value: 0 }
      ]
      store.set('counters.v1', this.items)
    } else {
      this.items = (Array.isArray(raw) ? raw : []).slice(0, LIMIT).map(sanitize).filter((c): c is Counter => !!c)
    }
  }

  list(): Counter[] {
    return this.items
  }

  get(id: string): Counter | undefined {
    return this.items.find((c) => c.id === id)
  }

  /** {ключ} → значение для подстановки в тексты. */
  vars(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const c of this.items) out[c.key] = String(c.value)
    return out
  }

  private save(): void {
    this.store.set('counters.v1', this.items)
    this.emit('change', this.items)
  }

  /** Заменить весь список (импорт профиля). */
  replaceAll(list: unknown): void {
    this.items = (Array.isArray(list) ? list : []).slice(0, LIMIT).map(sanitize).filter((c): c is Counter => !!c)
    this.save()
  }

  /** Добавить или переименовать (значение при переименовании не трогаем, если не передано). */
  put(v: unknown): Counter {
    const c = sanitize(v)
    if (!c) throw new Error('Название пустое, или ключ занят/содержит недопустимые символы (можно буквы, цифры и _)')
    const i = this.items.findIndex((x) => x.id === c.id)
    if (this.items.some((x) => x.id !== c.id && x.key.toLowerCase() === c.key.toLowerCase())) throw new Error(`Ключ {${c.key}} уже есть у другого счётчика`)
    if (i >= 0) {
      const hasValue = typeof obj(v).value === 'number'
      this.items[i] = { ...c, value: hasValue ? c.value : this.items[i].value }
    } else {
      if (this.items.length >= LIMIT) throw new Error(`Слишком много счётчиков (максимум ${LIMIT})`)
      this.items.push(c)
    }
    this.save()
    return c
  }

  remove(id: string): void {
    this.items = this.items.filter((c) => c.id !== id)
    this.save()
  }

  /** Изменить значение: add/sub — на n, set — сделать равным n, amount — прибавить сумму события. */
  apply(id: string, op: CounterOp, n: number, eventAmount = 0): Counter | null {
    const c = this.get(id)
    if (!c) return null
    const v = op === 'add' ? c.value + n : op === 'sub' ? c.value - n : op === 'set' ? n : c.value + eventAmount
    c.value = clamp(v)
    this.save()
    return c
  }
}
