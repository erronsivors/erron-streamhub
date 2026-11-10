import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, basename, join } from 'node:path'
import type { Store } from './db'

const TYPES: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }
const MAX_SIZE = 5 * 1024 * 1024

export interface SoundInfo {
  /** Значение для настроек алерта: custom:<файл>. */
  id: string
  name: string
}

/**
 * Свои звуки алертов. Файл копируется в папку данных под именем <md5>.<ext> — так в настройках
 * и ссылках нет путей пользователя, а сервер отдаёт только файлы из этой папки по строгому шаблону.
 */
export class SoundLibrary {
  private dir: string

  constructor(root: string, private store: Store) {
    this.dir = join(root, 'sounds')
    mkdirSync(this.dir, { recursive: true })
  }

  private names(): Record<string, string> {
    return this.store.get<Record<string, string>>('sounds.names', {})
  }

  list(): SoundInfo[] {
    const n = this.names()
    return Object.keys(n).filter((f) => existsSync(join(this.dir, f))).map((f) => ({ id: `custom:${f}`, name: n[f] }))
  }

  add(path: string): SoundInfo {
    const ext = extname(path).toLowerCase()
    if (!TYPES[ext]) throw new Error('Подходят только файлы mp3, wav или ogg')
    if (statSync(path).size > MAX_SIZE) throw new Error('Файл больше 5 МБ — выберите покороче')
    const body = readFileSync(path)
    const file = `${createHash('md5').update(body).digest('hex')}${ext}`
    writeFileSync(join(this.dir, file), body)
    const n = this.names()
    n[file] = basename(path, extname(path)).slice(0, 60)
    this.store.set('sounds.names', n)
    return { id: `custom:${file}`, name: n[file] }
  }

  remove(id: string): void {
    const file = id.replace(/^custom:/, '')
    if (!/^[0-9a-f]{32}\.(mp3|wav|ogg)$/.test(file)) return
    const n = this.names()
    delete n[file]
    this.store.set('sounds.names', n)
    try {
      unlinkSync(join(this.dir, file))
    } catch {
      /* уже удалён */
    }
  }

  async get(file: string): Promise<{ body: Buffer; type: string } | null> {
    if (!/^[0-9a-f]{32}\.(mp3|wav|ogg)$/.test(file)) return null
    try {
      return { body: await readFile(join(this.dir, file)), type: TYPES[extname(file)] }
    } catch {
      return null
    }
  }
}
