import type { Badge, MsgPart } from '../types'
import type { ImageCache } from '../imgcache'

/**
 * Смайлы и бейджи. Внешние URL картинок собираются ТОЛЬКО из проверенных ID по фиксированным шаблонам
 * (или берутся с CDN Twitch для бейджей), затем заменяются на локальные пути кэша /e/<hash>.
 * В интерфейс и оверлеи уходят только локальные пути.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/
const SAFE_NAME = /^\S{1,64}$/

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

type Arr = Record<string, unknown>[]
const arr = (v: unknown): Arr => (Array.isArray(v) ? (v as Arr) : [])

const twitchUrl = (id: string): string => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`

export class EmoteCache {
  private third = new Map<string, string>() // имя -> локальный путь
  private badges = new Map<string, Badge>()
  /** Смайлы канала — их стоит скачать заранее. */
  private channelPaths: string[] = []

  constructor(private img: ImageCache) {}

  thirdPartyCount(): number {
    return this.third.size
  }

  twitchEmote(id: string): string | null {
    return SAFE_ID.test(id) ? this.img.local(twitchUrl(id)) : null
  }

  /** Загрузить смайлы 7TV / BTTV / FFZ (глобальные и канала). Ошибка одного сервиса не мешает остальным. */
  async loadThirdParty(channelId: string, log: (msg: string) => void): Promise<void> {
    const map = new Map<string, string>()
    const warm: string[] = []
    const add = (name: unknown, id: unknown, tpl: (id: string) => string): void => {
      const n = String(name ?? '')
      const i = String(id ?? '')
      if (!SAFE_NAME.test(n) || !SAFE_ID.test(i)) return
      const path = this.img.local(tpl(i))
      if (path) {
        map.set(n, path)
        warm.push(path)
      }
    }
    const tv = (id: string): string => `https://cdn.7tv.app/emote/${id}/1x.webp`
    const bttv = (id: string): string => `https://cdn.betterttv.net/emote/${id}/1x`
    const ffz = (id: string): string => `https://cdn.frankerfacez.com/emote/${id}/1`

    const jobs: [string, () => Promise<void>][] = [
      ['7TV', async () => {
        const g = (await getJson('https://7tv.io/v3/emote-sets/global')) as { emotes?: Arr }
        for (const e of arr(g.emotes)) add(e.name, e.id, tv)
        const u = (await getJson(`https://7tv.io/v3/users/twitch/${channelId}`).catch(() => ({}))) as { emote_set?: { emotes?: Arr } }
        for (const e of arr(u.emote_set?.emotes)) add(e.name, e.id, tv)
      }],
      ['BTTV', async () => {
        for (const e of arr(await getJson('https://api.betterttv.net/3/cached/emotes/global'))) add(e.code, e.id, bttv)
        const u = (await getJson(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`).catch(() => ({}))) as { channelEmotes?: Arr; sharedEmotes?: Arr }
        for (const e of [...arr(u.channelEmotes), ...arr(u.sharedEmotes)]) add(e.code, e.id, bttv)
      }],
      ['FFZ', async () => {
        const sets = async (url: string): Promise<void> => {
          const j = (await getJson(url).catch(() => ({}))) as { sets?: Record<string, { emoticons?: Arr }> }
          for (const s of Object.values(j.sets ?? {})) for (const e of arr(s.emoticons)) add(e.name, e.id, ffz)
        }
        await sets('https://api.frankerfacez.com/v1/set/global')
        await sets(`https://api.frankerfacez.com/v1/room/id/${channelId}`)
      }]
    ]
    await Promise.all(jobs.map(([name, fn]) => fn().catch((e) => log(`Смайлы ${name} не загрузились: ${(e as Error).message}`))))
    this.third = map
    this.img.warm(warm)
  }

  clearThirdParty(): void {
    this.third.clear()
  }

  /** Смайлы Twitch канала и глобальные (ответ Helix /chat/emotes): скачать заранее. */
  warmTwitchEmotes(data: unknown): void {
    const paths: string[] = []
    for (const e of arr((data as { data?: unknown })?.data)) {
      const p = this.twitchEmote(String(e.id ?? ''))
      if (p) paths.push(p)
    }
    this.channelPaths.push(...paths)
    this.img.warm(paths)
  }

  /** Бейджи из ответа Helix /chat/badges: только картинки с CDN Twitch, сразу в кэш. */
  addBadges(data: unknown): void {
    const warm: string[] = []
    for (const set of arr((data as { data?: unknown })?.data)) {
      for (const v of arr(set.versions)) {
        const path = this.img.local(String(v.image_url_2x ?? ''))
        if (!path) continue
        this.badges.set(`${String(set.set_id)}/${String(v.id)}`, { title: String(v.title ?? set.set_id), url: path })
        warm.push(path)
      }
    }
    this.img.warm(warm)
  }

  badge(setId: string, id: string): Badge | undefined {
    return this.badges.get(`${setId}/${id}`)
  }

  /** Разобрать фрагменты сообщения Twitch EventSub в части: текст / смайл. */
  parts(fragments: unknown): MsgPart[] {
    const out: MsgPart[] = []
    const pushText = (s: string): void => {
      if (!s) return
      for (const tok of this.third.size ? s.split(/(\s+)/) : [s]) {
        const url = this.third.get(tok)
        if (url) out.push({ t: 'emote', v: tok, url })
        else if (tok) {
          const last = out[out.length - 1]
          if (last?.t === 'text') last.v += tok
          else out.push({ t: 'text', v: tok })
        }
      }
    }
    for (const f of arr(fragments)) {
      const text = String(f.text ?? '')
      if (f.type === 'emote') {
        const url = this.twitchEmote(String((f.emote as { id?: string })?.id ?? ''))
        if (url) out.push({ t: 'emote', v: text, url })
        else pushText(text)
      } else pushText(text)
    }
    // Картинки этого сообщения — сразу в загрузку, не дожидаясь запроса от чата.
    this.img.warm(out.filter((p) => p.t === 'emote').map((p) => (p as { url: string }).url))
    return out
  }
}
