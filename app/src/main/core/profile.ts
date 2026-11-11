import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Store } from './db'
import type { Settings, AppSettings } from './settings'
import type { RuleEngine } from './rules'
import { sanitizeRule } from './rules'
import type { TemplateStore } from './templates'
import { sanitizeTemplate } from './templates'
import type { Counters } from './counters'

/**
 * Профиль Crossember — один файл .crossember (JSON, сжатый gzip): настройки, правила, счётчики, шаблоны алертов,
 * свои картинки, видео и звуки. Секретов в нём нет: токены и ключи лежат в зашифрованной таблице secrets
 * и сюда не попадают; не попадают и ключи оверлеев, адрес OBS, адрес домашней сети, аккаунты донат-сервисов.
 * Перед загрузкой профиля текущее состояние сохраняется в папку backups; если загрузка сорвалась — всё возвращается.
 */

const FORMAT = 'crossember-profile'
const VERSION = 1
const MAX_FILE = 400 * 1024 * 1024
const MAX_JSON = 1024 * 1024 * 1024
const BACKUPS_KEEP = 10
const MEDIA_RE = /^([0-9a-f]{32})\.(png|jpg|gif|webp|webm|mp4)$/
const SOUND_RE = /^([0-9a-f]{32})\.(mp3|wav|ogg)$/
const MEDIA_MAX = 60 * 1024 * 1024
const SOUND_MAX = 5 * 1024 * 1024

export const PROFILE_PARTS = ['settings', 'rules', 'templates', 'media'] as const
export type ProfilePart = (typeof PROFILE_PARTS)[number]

interface FileEntry { file: string; name: string; data: string }

interface ProfileFile {
  format: typeof FORMAT
  version: number
  createdAt: number
  settings?: unknown
  rules?: unknown[]
  rulesFlags?: unknown
  counters?: unknown[]
  templates?: unknown[]
  media?: FileEntry[]
  sounds?: FileEntry[]
}

/** Что в файле — показываем перед загрузкой. */
export interface ProfileSummary {
  createdAt: number
  settings: boolean
  rules: number
  counters: number
  templates: number
  media: number
  sounds: number
  /** Размер файла, байт. */
  size: number
}

export interface ProfileState {
  /** Последняя резервная копия (до загрузки профиля): когда сделана. */
  lastBackup: number | null
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex')

export class Profiles {
  private mediaDir: string
  private soundDir: string
  private backupDir: string
  private pending: { data: ProfileFile; summary: ProfileSummary } | null = null

  constructor(
    root: string,
    private store: Store,
    private settings: Settings,
    private rules: RuleEngine,
    private templates: TemplateStore,
    private counters: Counters
  ) {
    this.mediaDir = join(root, 'media')
    this.soundDir = join(root, 'sounds')
    this.backupDir = join(root, 'backups')
  }

  state(): ProfileState {
    const last = this.backups()[0]
    return { lastBackup: last ? last.ts : null }
  }

  /** Резервные копии — новые первыми. */
  private backups(): { file: string; ts: number }[] {
    if (!existsSync(this.backupDir)) return []
    return readdirSync(this.backupDir)
      .map((f) => ({ f, m: /^before-import-(\d{13})\.crossember$/.exec(f) }))
      .filter((x) => x.m)
      .map((x) => ({ file: join(this.backupDir, x.f), ts: Number(x.m![1]) }))
      .sort((a, b) => b.ts - a.ts)
  }

  /** Настройки для файла: без того, что относится только к этому ПК (адрес домашней сети, место окна чата). */
  private portableSettings(): Json {
    const s = structuredClone(this.settings.get()) as unknown as Json
    delete s.lan
    const f = obj(s.float)
    delete f.bounds
    return s
  }

  private build(includeMedia: boolean): ProfileFile {
    const p: ProfileFile = {
      format: FORMAT,
      version: VERSION,
      createdAt: Date.now(),
      settings: this.portableSettings(),
      rules: this.rules.state().rules,
      rulesFlags: { enabled: this.rules.state().enabled, dryRun: this.rules.state().dryRun },
      counters: this.counters.list(),
      templates: this.templates.all()
    }
    if (includeMedia) {
      p.media = this.collect(this.mediaDir, 'media.names', MEDIA_RE)
      p.sounds = this.collect(this.soundDir, 'sounds.names', SOUND_RE)
    }
    return p
  }

  private collect(dir: string, key: string, re: RegExp): FileEntry[] {
    const names = this.store.get<Record<string, string>>(key, {})
    const out: FileEntry[] = []
    for (const [file, name] of Object.entries(names)) {
      const path = join(dir, file)
      if (!re.test(file) || !existsSync(path)) continue
      out.push({ file, name: String(name).slice(0, 60), data: '' })
    }
    return out
  }

  private async encode(p: ProfileFile): Promise<Buffer> {
    // Файлы читаем здесь, асинхронно (могут быть большими).
    for (const [list, dir] of [[p.media, this.mediaDir], [p.sounds, this.soundDir]] as const) {
      for (const e of list ?? []) e.data = (await readFile(join(dir, e.file))).toString('base64')
    }
    return gzipSync(Buffer.from(JSON.stringify(p), 'utf8'))
  }

  /** Сохранить профиль в файл. */
  async exportTo(path: string, includeMedia: boolean): Promise<{ size: number }> {
    const buf = await this.encode(this.build(includeMedia))
    await writeFile(path, buf)
    return { size: buf.length }
  }

  /** Прочитать и проверить файл профиля; запомнить до подтверждения. */
  async inspect(path: string): Promise<ProfileSummary> {
    this.pending = null
    const size = (await stat(path)).size
    if (size > MAX_FILE) throw new Error('Файл слишком большой для профиля Crossember')
    const data = this.decode(await readFile(path))
    const summary: ProfileSummary = {
      createdAt: data.createdAt,
      settings: !!data.settings,
      rules: data.rules?.length ?? 0,
      counters: data.counters?.length ?? 0,
      templates: data.templates?.length ?? 0,
      media: data.media?.length ?? 0,
      sounds: data.sounds?.length ?? 0,
      size
    }
    this.pending = { data, summary }
    return summary
  }

  cancel(): void {
    this.pending = null
  }

  private decode(buf: Buffer): ProfileFile {
    let raw: unknown
    try {
      raw = JSON.parse(gunzipSync(buf, { maxOutputLength: MAX_JSON }).toString('utf8'))
    } catch {
      throw new Error('Это не файл профиля Crossember (или он повреждён)')
    }
    const o = obj(raw)
    if (o.format !== FORMAT) throw new Error('Это не файл профиля Crossember')
    if (typeof o.version !== 'number' || o.version > VERSION) throw new Error('Профиль сделан более новой версией Crossember — обновите программу')
    const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined)
    const files = (v: unknown, re: RegExp, max: number): FileEntry[] =>
      (arr(v) ?? []).slice(0, 500).map((x) => {
        const e = obj(x)
        const file = typeof e.file === 'string' ? e.file : ''
        const m = re.exec(file)
        if (!m || typeof e.data !== 'string') throw new Error('В профиле повреждён файл медиа')
        if (e.data.length > Math.ceil(max / 3) * 4 + 4) throw new Error(`Файл «${String(e.name ?? file)}» в профиле слишком большой`)
        return { file, name: typeof e.name === 'string' ? e.name.slice(0, 60) : file, data: e.data }
      })
    return {
      format: FORMAT,
      version: o.version,
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
      settings: o.settings && typeof o.settings === 'object' ? o.settings : undefined,
      rules: arr(o.rules),
      rulesFlags: o.rulesFlags,
      counters: arr(o.counters),
      templates: arr(o.templates),
      media: files(o.media, MEDIA_RE, MEDIA_MAX),
      sounds: files(o.sounds, SOUND_RE, SOUND_MAX)
    }
  }

  /** Резервная копия перед загрузкой: всё, кроме самих медиафайлов (их загрузка не удаляет и не перезаписывает). */
  private async backup(): Promise<string> {
    mkdirSync(this.backupDir, { recursive: true })
    const path = join(this.backupDir, `before-import-${Date.now()}.crossember`)
    await writeFile(path, await this.encode(this.build(false)))
    for (const old of this.backups().slice(BACKUPS_KEEP)) {
      try { unlinkSync(old.file) } catch { /* не страшно */ }
    }
    return path
  }

  /** Загрузить проверенный профиль (выбранные части). Перед этим — резервная копия; при ошибке — откат. */
  async apply(parts: ProfilePart[]): Promise<void> {
    if (!this.pending) throw new Error('Сначала выберите файл профиля')
    const { data } = this.pending
    const want = new Set(parts.filter((p) => (PROFILE_PARTS as readonly string[]).includes(p)))
    if (!want.size) throw new Error('Не выбрано, что загружать')

    // 1. Всё проверяем и готовим заранее — до любых изменений.
    const mediaFiles: { dir: string; key: string; file: string; name: string; body: Buffer }[] = []
    if (want.has('media')) {
      for (const [list, dir, key, re] of [[data.media, this.mediaDir, 'media.names', MEDIA_RE], [data.sounds, this.soundDir, 'sounds.names', SOUND_RE]] as const) {
        for (const e of list ?? []) {
          const body = Buffer.from(e.data, 'base64')
          if (md5(body) !== re.exec(e.file)![1]) throw new Error(`Файл «${e.name}» в профиле повреждён`)
          mediaFiles.push({ dir, key, file: e.file, name: e.name, body })
        }
      }
    }
    const rules = want.has('rules') && data.rules ? data.rules.slice(0, 200).map(sanitizeRule) : null
    const templates = want.has('templates') && data.templates ? data.templates.slice(0, 200).map(sanitizeTemplate) : null
    let settings: AppSettings | null = null
    if (want.has('settings') && data.settings) {
      const cur = this.settings.get()
      const s = obj(structuredClone(data.settings))
      // Только для этого ПК — оставляем свои.
      s.lan = cur.lan
      s.float = { ...obj(s.float), bounds: cur.float.bounds }
      settings = s as unknown as AppSettings
    }

    // 2. Резервная копия текущего состояния.
    const backupPath = await this.backup()
    const written: string[] = []
    const namesBefore = { media: this.store.get<Record<string, string>>('media.names', {}), sounds: this.store.get<Record<string, string>>('sounds.names', {}) }

    // 3. Применяем; любая ошибка — откат из резервной копии.
    try {
      for (const f of mediaFiles) {
        mkdirSync(f.dir, { recursive: true })
        const path = join(f.dir, f.file)
        if (!existsSync(path)) { await writeFile(path, f.body); written.push(path) }
        const names = this.store.get<Record<string, string>>(f.key, {})
        if (!names[f.file]) { names[f.file] = f.name; this.store.set(f.key, names) }
      }
      if (templates) this.templates.setAll(templates)
      if (rules) {
        this.counters.replaceAll(data.counters ?? [])
        this.rules.replaceAll(rules, data.rulesFlags)
      }
      if (settings) this.settings.replaceAll(settings)
      this.pending = null
    } catch (err) {
      try {
        const prev = this.decode(await readFile(backupPath))
        this.restoreFrom(prev)
        this.store.set('media.names', namesBefore.media)
        this.store.set('sounds.names', namesBefore.sounds)
        for (const p of written) { try { unlinkSync(p) } catch { /* ок */ } }
      } catch { /* откат не удался — резервная копия осталась в папке backups */ }
      throw new Error(`Профиль не загружен, всё возвращено как было: ${(err as Error).message}`)
    }
  }

  private restoreFrom(p: ProfileFile): void {
    if (p.templates) this.templates.setAll(p.templates.map(sanitizeTemplate))
    if (p.rules) {
      this.counters.replaceAll(p.counters ?? [])
      this.rules.replaceAll(p.rules.map(sanitizeRule), p.rulesFlags)
    }
    if (p.settings) {
      const cur = this.settings.get()
      this.settings.replaceAll({ ...(obj(p.settings) as unknown as AppSettings), lan: cur.lan, float: { ...obj(obj(p.settings).float), bounds: cur.float.bounds } as AppSettings['float'] })
    }
  }

  /** «Вернуть как было»: последняя резервная копия (до последней загрузки профиля). */
  async undo(): Promise<void> {
    const last = this.backups()[0]
    if (!last) throw new Error('Резервных копий нет')
    const p = this.decode(await readFile(last.file))
    this.restoreFrom(p)
    // Копию, из которой вернулись, убираем — следующая «отмена» вернёт ещё более раннее состояние.
    try { unlinkSync(last.file) } catch { /* ок */ }
  }
}
