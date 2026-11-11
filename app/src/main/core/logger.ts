import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Журнал Crossember на диске — чтобы разбирать ошибки у друзей.
 * Пишется только техническое: подключения, ошибки, падения. Сообщения чата и донатов сюда не попадают.
 * Всё, что похоже на секрет (ключи ссылок, токены, адреса, почта, имя пользователя Windows), маскируется ДО записи.
 * Файл в день: crossember-ГГГГ-ММ-ДД.log, хранятся 7 последних, один файл — не больше 2 МБ.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'fatal'

const KEEP_DAYS = 7
const MAX_FILE = 2 * 1024 * 1024
const MAX_LINE = 2000

/** Убрать из строки всё, что может быть секретом или личными данными. */
export function mask(text: string): string {
  return text
    .replace(/((?:[?&]|\b)(?:k|key|token|access_token|refresh_token|code|client_secret|state|password|pass)=)[^&\s"'#]+/gi, '$1***')
    .replace(/\b(Bearer|OAuth|Basic)\s+[\w.~+/=-]+/gi, '$1 ***')
    .replace(/\boauth:[\w-]+/gi, 'oauth:***')
    .replace(/("?(?:access_token|refresh_token|token|password|secret|apiKey|api_key|client_secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"***"')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '***@***')
    .replace(/\b(?!127\.0\.0\.1\b)(\d{1,3}\.){3}\d{1,3}\b/g, 'x.x.x.x')
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***')
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
const day = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const stamp = (d: Date): string => `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

export interface CrashInfo {
  /** Когда случилось. */
  at: number
  /** Коротко, что произошло (уже замаскировано). */
  text: string
  /** true — прошлый запуск закрылся неожиданно (замечено при этом старте). */
  previous: boolean
}

export class Logger {
  private crashInfo: CrashInfo | null = null
  private full = new Set<string>()
  /** Сообщить интерфейсу, что появилась серьёзная ошибка. */
  onCrash: () => void = () => undefined

  constructor(readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* без журнала приложение всё равно работает */
    }
    this.cleanup()
    // Метка «приложение запущено»: осталась от прошлого раза — значит, закрылось оно не само.
    const lock = join(dir, 'running.lock')
    if (existsSync(lock)) {
      let at = Date.now()
      try { at = statSync(lock).mtimeMs } catch { /* ок */ }
      this.crashInfo = { at, text: 'Прошлый запуск Crossember закрылся неожиданно', previous: true }
    }
    try { writeFileSync(lock, String(Date.now())) } catch { /* ок */ }
  }

  file(d = new Date()): string {
    return join(this.dir, `crossember-${day(d)}.log`)
  }

  write(level: LogLevel, source: string, text: string): void {
    const d = new Date()
    const f = this.file(d)
    if (this.full.has(f)) return
    const line = `${stamp(d)} [${level}] [${source.slice(0, 24)}] ${mask(String(text)).replace(/\r?\n/g, ' ⏎ ').slice(0, MAX_LINE)}\n`
    try {
      if (existsSync(f) && statSync(f).size > MAX_FILE) {
        this.full.add(f)
        appendFileSync(f, `${stamp(d)} [warn] [log] Журнал за день больше 2 МБ — дальше не пишется до завтра\n`)
        return
      }
      appendFileSync(f, line)
    } catch {
      /* диск недоступен — молча пропускаем */
    }
  }

  info(source: string, text: string): void { this.write('info', source, text) }
  warn(source: string, text: string): void { this.write('warn', source, text) }
  error(source: string, text: string): void { this.write('error', source, text) }

  /** Серьёзная ошибка: в журнал и плашка «Сообщить об ошибке» в интерфейсе. */
  fatal(source: string, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err))
    this.write('fatal', source, `${e.message}${e.stack ? ' | ' + e.stack.split('\n').slice(1, 8).map((s) => s.trim()).join(' | ') : ''}`)
    this.crashInfo = { at: Date.now(), text: mask(e.message).slice(0, 200) || 'Неизвестная ошибка', previous: false }
    this.onCrash()
  }

  crash(): CrashInfo | null {
    return this.crashInfo
  }

  dismissCrash(): void {
    this.crashInfo = null
  }

  /** Нормальный выход: снять метку запуска. */
  close(): void {
    try { unlinkSync(join(this.dir, 'running.lock')) } catch { /* ок */ }
  }

  /** Файлы журнала, новые первыми. */
  files(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => /^crossember-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse()
    } catch {
      return []
    }
  }

  /** Последние дни журнала одним текстом (не больше maxBytes, обрезается старое). */
  tail(days: number, maxBytes: number): string {
    const parts: string[] = []
    let size = 0
    for (const f of this.files().slice(0, days)) {
      let t = ''
      try { t = readFileSync(join(this.dir, f), 'utf8') } catch { continue }
      if (size + t.length > maxBytes) {
        const left = maxBytes - size
        if (left > 1000) parts.push(`===== ${f} (только конец) =====\n…${t.slice(-left)}`)
        break
      }
      parts.push(`===== ${f} =====\n${t}`)
      size += t.length
    }
    return parts.reverse().join('\n')
  }

  private cleanup(): void {
    for (const f of this.files().slice(KEEP_DAYS)) {
      try { unlinkSync(join(this.dir, f)) } catch { /* ок */ }
    }
  }
}
