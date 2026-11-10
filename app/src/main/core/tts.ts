import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Hub } from './hub'

/**
 * Озвучка голосами Windows (System.Speech, SAPI). Один фоновый процесс PowerShell на всё время работы:
 * команды идут построчно в base64 (текст зрителя никогда не попадает в командную строку), ответ — JSON-строкой.
 * Готовый звук — wav-файл в папке данных, его играет оверлей (поэтому озвучка слышна в OBS).
 * Позже сюда добавятся другие движки (Silero, свой голос через Chatterbox) — поле engine в настройках.
 */

export interface TtsVoice {
  name: string
  culture: string
  gender: string
}

const WORKER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $out = $null
  try {
    $j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    if ($j.cmd -eq 'voices') {
      $v = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender } })
      $out = @{ ok = $true; voices = $v }
    } else {
      if ($j.voice) { $s.SelectVoice([string]$j.voice) }
      $s.Rate = [int]$j.rate
      $s.Volume = 100
      $s.SetOutputToWaveFile([string]$j.path)
      try { $s.Speak([string]$j.text) } finally { $s.SetOutputToNull() }
      $out = @{ ok = $true }
    }
  } catch {
    $out = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
}
`

/** Длительность wav-файла, мс (по заголовку). */
export function wavDurationMs(buf: Buffer): number {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0
  let byteRate = 0
  let pos = 12
  while (pos + 8 <= buf.length) {
    const tag = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (tag === 'fmt ') byteRate = buf.readUInt32LE(pos + 16)
    if (tag === 'data') return byteRate ? Math.round((Math.min(size, buf.length - pos - 8) / byteRate) * 1000) : 0
    pos += 8 + size + (size % 2)
  }
  return 0
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:ru|com|net|org|gg|tv|io|me|рф|su|xyz|info|link|ly)(?:\/\S*)?/gi

/** Подготовить текст к озвучке: без ссылок, мата из списка, повторов и мусора; не длиннее maxChars. */
export function cleanForSpeech(text: string, opts: { stripLinks: boolean; badWords: string; maxChars: number }): string {
  let t = text
  if (opts.stripLinks) t = t.replace(URL_RE, ' ')
  for (const w of opts.badWords.split(',').map((x) => x.trim()).filter(Boolean)) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(`[\\p{L}\\d]*${esc}[\\p{L}\\d]*`, 'giu'), ' ')
  }
  t = t
    .replace(/[^\p{L}\p{N}\s.,!?:;()'"«»—–-]/gu, ' ') // смайлы и символы
    .replace(/(\p{L})\1{3,}/gu, '$1$1$1') // «ааааааа» → «ааа»
    .replace(/([!?.,])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > opts.maxChars) t = `${t.slice(0, opts.maxChars).replace(/\s+\S*$/, '')}…`
  return t
}

export class WindowsTts {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private waiting: ((r: Record<string, unknown>) => void)[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private voicesCache: TtsVoice[] | null = null
  private dir: string
  private cleanTimer: NodeJS.Timeout

  constructor(root: string, private hub: Hub) {
    this.dir = join(root, 'tts')
    mkdirSync(this.dir, { recursive: true })
    this.cleanup()
    this.cleanTimer = setInterval(() => this.cleanup(), 30 * 60 * 1000)
  }

  /** Удалить озвучки старше 2 часов. */
  private cleanup(): void {
    const old = Date.now() - 2 * 3600 * 1000
    try {
      for (const f of readdirSync(this.dir)) {
        const p = join(this.dir, f)
        if (statSync(p).mtimeMs < old) unlinkSync(p)
      }
    } catch {
      /* не страшно */
    }
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc
    const encoded = Buffer.from(WORKER, 'utf16le').toString('base64')
    const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        let r: Record<string, unknown>
        try { r = JSON.parse(line) } catch { r = { ok: false, error: 'bad reply' } }
        this.waiting.shift()?.(r)
      }
    })
    p.stderr.on('data', () => undefined)
    p.on('exit', () => {
      this.proc = null
      this.buf = ''
      for (const w of this.waiting.splice(0)) w({ ok: false, error: 'Процесс озвучки завершился' })
    })
    p.on('error', (e) => this.hub.log('hub', 'error', `Озвучка Windows не запустилась: ${e.message}`))
    this.proc = p
    return p
  }

  /** Отправить команду фоновому процессу (по одной за раз), ждать ответ не дольше timeoutMs. */
  private request(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const run = (): Promise<Record<string, unknown>> => new Promise((resolve) => {
      const p = this.start()
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(done)
        if (i >= 0) this.waiting.splice(i, 1)
        p.kill()
        resolve({ ok: false, error: 'Озвучка не ответила вовремя' })
      }, timeoutMs)
      const done = (r: Record<string, unknown>): void => { clearTimeout(timer); resolve(r) }
      this.waiting.push(done)
      p.stdin.write(Buffer.from(JSON.stringify(cmd), 'utf8').toString('base64') + '\n')
    })
    const next = this.chain.then(run, run)
    this.chain = next
    return next
  }

  async voices(): Promise<TtsVoice[]> {
    if (this.voicesCache) return this.voicesCache
    const r = await this.request({ cmd: 'voices' }, 20_000)
    if (!r.ok) throw new Error(String(r.error ?? 'Не удалось получить список голосов'))
    const list = (Array.isArray(r.voices) ? r.voices : [r.voices]).filter(Boolean) as TtsVoice[]
    this.voicesCache = list.map((v) => ({ name: String(v.name), culture: String(v.culture), gender: String(v.gender) }))
    return this.voicesCache
  }

  /** Голос по умолчанию: заданный, иначе первый русский, иначе любой. */
  private async pickVoice(want: string): Promise<string> {
    const list = await this.voices().catch(() => [] as TtsVoice[])
    if (want && list.some((v) => v.name === want)) return want
    return (list.find((v) => v.culture.toLowerCase().startsWith('ru')) ?? list[0])?.name ?? ''
  }

  /** Озвучить текст в wav. Возвращает имя файла (для /t/<файл>) и длительность. */
  async synth(text: string, voice: string, rate: number): Promise<{ file: string; durationMs: number }> {
    if (!text.trim()) throw new Error('Пустой текст')
    const v = await this.pickVoice(voice)
    const r10 = Math.max(-10, Math.min(10, Math.round(rate)))
    const file = `${createHash('sha1').update(`${v}|${r10}|${text}`).digest('hex')}.wav`
    const path = join(this.dir, file)
    if (!existsSync(path)) {
      const r = await this.request({ cmd: 'speak', text, voice: v, rate: r10, path })
      if (!r.ok) throw new Error(String(r.error ?? 'Ошибка озвучки'))
    }
    const body = await readFile(path)
    return { file, durationMs: wavDurationMs(body) }
  }

  async get(file: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{40}\.wav$/.test(file)) return null
    try {
      return await readFile(join(this.dir, file))
    } catch {
      return null
    }
  }

  dispose(): void {
    clearInterval(this.cleanTimer)
    this.proc?.kill()
  }
}
