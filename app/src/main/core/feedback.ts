import { writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mask, type Logger } from './logger'
import type { ConnStatus } from './types'

/**
 * Обратная связь без своего сервера: Crossember собирает файл логов и открывает готовое письмо
 * (Gmail в браузере или почтовая программа). Файл пользователь прикладывает сам — видно, что уходит.
 */

/** Куда приходят письма. Поменять адрес — только здесь. */
export const FEEDBACK_EMAIL = 'crossemberwork@gmail.com'

export const FEEDBACK_KINDS = { bug: 'Ошибка', idea: 'Предложение', other: 'Другое' } as const
export type FeedbackKind = keyof typeof FEEDBACK_KINDS

export interface FeedbackForm {
  kind: FeedbackKind
  text: string
  contact: string
}

export interface SystemInfo {
  version: string
  electron: string
  os: string
  arch: string
  setupMode: string
  uptimeMin: number
}

export interface LogBundle {
  path: string
  name: string
  size: number
  createdAt: number
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '')

export function sanitizeForm(v: unknown): FeedbackForm {
  const o = obj(v)
  const kind = typeof o.kind === 'string' && o.kind in FEEDBACK_KINDS ? (o.kind as FeedbackKind) : 'bug'
  return { kind, text: clean(o.text, 4000), contact: clean(o.contact, 200) }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const fileStamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`

/** Текст файла логов: сведения о системе, состояние подключений, журнал за 3 дня. Всё замаскировано. */
export function bundleText(info: SystemInfo, conns: ConnStatus[], logger: Logger, now = new Date()): string {
  const lines: string[] = []
  lines.push('Crossember — логи для разбора ошибки')
  lines.push(`Собрано: ${now.toLocaleString('ru-RU')}`)
  lines.push(`Версия: ${info.version} · Electron ${info.electron} · ${info.os} ${info.arch} · режим: ${info.setupMode} · работает ${info.uptimeMin} мин`)
  lines.push('Токены, пароли, ключи ссылок, IP-адреса, почта и сообщения чата сюда не попадают.')
  lines.push('')
  lines.push('===== Подключения сейчас =====')
  for (const c of conns) {
    lines.push(`${c.name} (${c.id}): ${c.state} — ${mask(c.detail)}`)
    for (const l of c.log.slice(0, 15)) lines.push(`    ${new Date(l.ts).toLocaleTimeString('ru-RU')} [${l.level}] ${mask(l.text)}`)
  }
  lines.push('')
  lines.push('===== Журнал (последние 3 дня) =====')
  lines.push(logger.tail(3, 1_500_000) || '(журнал пуст)')
  return lines.join('\n')
}

/** Записать файл логов в папку (обычно «Загрузки»). */
export function writeBundle(dir: string, text: string, now = new Date()): LogBundle {
  const name = `Crossember-логи-${fileStamp(now)}.txt`
  const path = join(dir, name)
  writeFileSync(path, '﻿' + text, 'utf8')
  return { path, name, size: statSync(path).size, createdAt: now.getTime() }
}

function subject(f: FeedbackForm, info: SystemInfo): string {
  const first = f.text.split('\n')[0].slice(0, 60)
  return `Crossember ${info.version} · ${FEEDBACK_KINDS[f.kind]}${first ? ': ' + first : ''}`
}

function body(f: FeedbackForm, info: SystemInfo, bundle: LogBundle | null): string {
  const out = [f.text || '(без текста)', '', '—']
  if (f.contact) out.push(`Связаться: ${f.contact}`)
  out.push(`Crossember ${info.version} · ${info.os} ${info.arch} · режим: ${info.setupMode}`)
  if (bundle) out.push('', `Файл логов: ${bundle.name} — не забудьте прикрепить его к письму (лежит в «Загрузках»).`)
  return out.join('\n')
}

/** Ссылки на готовое письмо: Gmail в браузере и почтовая программа (mailto). */
export function composeUrls(f: FeedbackForm, info: SystemInfo, bundle: LogBundle | null): { gmail: string; mailto: string } {
  const su = subject(f, info)
  const b = body(f, info, bundle)
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(FEEDBACK_EMAIL)}&su=${encodeURIComponent(su)}&body=${encodeURIComponent(b)}`
  const mailto = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(su)}&body=${encodeURIComponent(b)}`
  return { gmail, mailto }
}
