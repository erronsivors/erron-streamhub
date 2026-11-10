import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Store } from './db'

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.webm': 'video/webm', '.mp4': 'video/mp4'
}
const MAX_SIZE = 60 * 1024 * 1024
const FILE_RE = /^[0-9a-f]{32}\.(png|jpg|gif|webp|webm|mp4)$/

export interface MediaInfo {
  /** Значение для слоя шаблона: m:<файл>. */
  id: string
  name: string
  kind: 'image' | 'video'
}

/**
 * Картинки, GIF и видео для конструктора алертов. Как и звуки: файл копируется в папку данных под именем
 * <md5>.<ext>, в шаблонах и ссылках нет путей пользователя, сервер отдаёт только файлы по строгому шаблону.
 */
export class MediaLibrary {
  private dir: string

  constructor(root: string, private store: Store) {
    this.dir = join(root, 'media')
    mkdirSync(this.dir, { recursive: true })
  }

  private names(): Record<string, string> {
    return this.store.get<Record<string, string>>('media.names', {})
  }

  list(): MediaInfo[] {
    const n = this.names()
    return Object.keys(n)
      .filter((f) => FILE_RE.test(f) && existsSync(join(this.dir, f)))
      .map((f) => ({ id: `m:${f}`, name: n[f], kind: /\.(webm|mp4)$/.test(f) ? 'video' : 'image' }))
  }

  add(path: string): MediaInfo {
    let ext = extname(path).toLowerCase()
    if (ext === '.jpeg') ext = '.jpg'
    if (!TYPES[ext]) throw new Error('Подходят картинки png, jpg, gif, webp и видео webm, mp4')
    if (statSync(path).size > MAX_SIZE) throw new Error('Файл больше 60 МБ — сожмите или обрежьте его')
    const body = readFileSync(path)
    const file = `${createHash('md5').update(body).digest('hex')}${ext}`
    writeFileSync(join(this.dir, file), body)
    const n = this.names()
    n[file] = basename(path, extname(path)).slice(0, 60)
    this.store.set('media.names', n)
    return { id: `m:${file}`, name: n[file], kind: ext === '.webm' || ext === '.mp4' ? 'video' : 'image' }
  }

  remove(id: string): void {
    const file = id.replace(/^m:/, '')
    if (!FILE_RE.test(file)) return
    const n = this.names()
    delete n[file]
    this.store.set('media.names', n)
    try {
      unlinkSync(join(this.dir, file))
    } catch {
      /* уже удалён */
    }
  }

  /** Файл целиком или кусок (видео в браузере просит диапазоны). */
  async get(file: string, range?: string): Promise<{ body: Buffer; type: string; size: number; start: number; end: number } | null> {
    if (!FILE_RE.test(file)) return null
    const p = join(this.dir, file)
    try {
      const size = (await stat(p)).size
      const type = TYPES[extname(file)]
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range)
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
        const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1
        if (start > end || start >= size) return null
        const fh = await open(p, 'r')
        try {
          const body = Buffer.alloc(end - start + 1)
          await fh.read(body, 0, body.length, start)
          return { body, type, size, start, end }
        } finally {
          await fh.close()
        }
      }
      return { body: await readFile(p), type, size, start: 0, end: size - 1 }
    } catch {
      return null
    }
  }
}
