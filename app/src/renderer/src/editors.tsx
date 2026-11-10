// Общие редакторы для правил и конструктора: звук, голос, действие OBS, движок алертов.
import { useEffect, useId, useState } from 'react'
import '../../../resources/overlays/alertkit.js'
import '../../../resources/overlays/alertkit.css'
import type { HubSnapshot } from '../../main/core/types'
import type { ObsAction } from '../../main/core/templates'
import type { ObsCatalog } from '../../main/core/obs'
import type { TtsVoice } from '../../main/core/tts'
import { SOUND_LABEL, playBuiltin } from './sounds'
import { errText } from './components'

// ---------- движок показа алертов (resources/overlays/alertkit.js) ----------
export interface KitState { x: number; y: number; scale: number; rotate: number; opacity: number }
export interface KitHandle { duration: number; seek(t: number): void; stop(): void }
interface Kit {
  W: number
  H: number
  mount(stage: HTMLElement, item: unknown, opts: { url: (s: string) => string; theme?: string; paused?: boolean; startAt?: number; editor?: boolean; playBuiltin?: (id: string, v: number) => void }): KitHandle
  sample(l: unknown, t: number): KitState
  layerDur(l: { start: number; duration: number }, total: number): number
}
export const kit = (): Kit => (window as unknown as { AlertKit: Kit }).AlertKit

/** Полный адрес файла на сервере Crossember (/m/…, /s/…, /t/…) с ключом оверлеев. */
export function serverUrl(snap: HubSnapshot, src: string): string {
  return snap.server ? `${snap.server.baseUrl}${src}?k=${encodeURIComponent(snap.server.overlayKey)}` : src
}

// ---------- звук ----------
export function SoundSelect({ value, onChange, snap }: { value: string; onChange: (v: string) => void; snap: HubSnapshot }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {Object.entries(SOUND_LABEL).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
      {snap.sounds.map((x) => <option key={x.id} value={x.id}>Свой: {x.name}</option>)}
    </select>
  )
}

let previewAudio: HTMLAudioElement | null = null
/** Послушать звук в приложении. */
export function previewSound(snap: HubSnapshot, sound: string, volume: number): void {
  previewAudio?.pause()
  if (sound === 'none') return
  if (sound.startsWith('custom:')) {
    previewAudio = new Audio(serverUrl(snap, `/s/${sound.slice(7)}`))
    previewAudio.volume = Math.min(1, Math.max(0, volume))
    void previewAudio.play().catch(() => undefined)
  } else playBuiltin(sound, volume)
}

/** Послушать озвучку текста текущим голосом из настроек. */
export async function previewTts(snap: HubSnapshot, text: string): Promise<void> {
  const src = await window.hub.ttsTest(text)
  previewAudio?.pause()
  previewAudio = new Audio(serverUrl(snap, src))
  previewAudio.volume = snap.settings.tts.volume / 100
  await previewAudio.play().catch(() => undefined)
}

// ---------- голоса ----------
let voicesCache: TtsVoice[] | null = null
export function useVoices(): { voices: TtsVoice[]; error: string | null } {
  const [voices, setVoices] = useState<TtsVoice[]>(voicesCache ?? [])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (voicesCache) return
    window.hub.ttsVoices().then((v) => { voicesCache = v; setVoices(v) }).catch((e) => setError(errText(e)))
  }, [])
  return { voices, error }
}

export function VoiceSelect({ value, onChange, allowDefault }: { value: string; onChange: (v: string) => void; allowDefault?: boolean }) {
  const { voices, error } = useVoices()
  return (
    <>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allowDefault ? 'Как в настройках озвучки' : 'Первый русский голос'}</option>
        {voices.map((v) => <option key={v.name} value={v.name}>{v.name.replace(/^Microsoft /, '')} · {v.culture}</option>)}
        {value && !voices.some((v) => v.name === value) && <option value={value}>{value}</option>}
      </select>
      {error && <span className="small" style={{ color: '#ff7a84' }}>{error}</span>}
    </>
  )
}

// ---------- OBS ----------
let catalogCache: ObsCatalog | null = null
export function useObsCatalog(): { catalog: ObsCatalog | null; error: string | null; reload: () => void; loading: boolean } {
  const [catalog, setCatalog] = useState<ObsCatalog | null>(catalogCache)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const reload = (): void => {
    setLoading(true)
    setError(null)
    window.hub.obsCatalog()
      .then((c) => { catalogCache = c; setCatalog(c) })
      .catch((e) => setError(errText(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { if (!catalogCache) reload() }, [])
  return { catalog, error, reload, loading }
}

const OP_LABEL: Record<ObsAction['op'], string> = {
  source: 'Показать / скрыть источник', scene: 'Переключить сцену', filter: 'Включить / выключить фильтр',
  media: 'Медиа-источник: запуск / стоп', text: 'Поменять текст в источнике'
}

/** Список с подсказками из OBS; если OBS не подключён — можно вписать вручную. */
function NamePick({ value, options, onChange, placeholder }: { value: string; options: string[]; onChange: (v: string) => void; placeholder: string }) {
  const listId = useId()
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <>
      <input className="input" list={listId} value={v} placeholder={placeholder} maxLength={120}
        onChange={(e) => { setV(e.target.value); if (options.includes(e.target.value)) onChange(e.target.value) }}
        onBlur={() => v !== value && onChange(v)} />
      <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  )
}

export function ObsActionEditor({ value, onChange, withTest = true }: { value: ObsAction; onChange: (a: ObsAction) => void; withTest?: boolean }) {
  const { catalog, error, reload, loading } = useObsCatalog()
  const [msg, setMsg] = useState<string | null>(null)
  const set = (p: Partial<ObsAction>): void => onChange({ ...value, ...p })
  const scenes = catalog?.scenes.map((s) => s.name) ?? []
  const items = catalog?.scenes.find((s) => s.name === value.scene)?.items ?? [...new Set(catalog?.scenes.flatMap((s) => s.items) ?? [])]
  const inputs = catalog?.inputs ?? []
  const filterSources = Object.keys(catalog?.filters ?? {})
  const textInputs = inputs.filter((i) => /text/.test(i.kind)).map((i) => i.name)
  const mediaInputs = inputs.filter((i) => /ffmpeg|vlc|media/.test(i.kind)).map((i) => i.name)

  return (
    <div className="obsact">
      <div className="obs-grid">
        <div className="field" style={{ margin: 0 }}>
          <label>Что сделать</label>
          <select className="input" value={value.op} onChange={(e) => set({ op: e.target.value as ObsAction['op'] })}>
            {Object.entries(OP_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {value.op === 'scene' && <div className="field" style={{ margin: 0 }}><label>Сцена</label><NamePick value={value.scene} options={scenes} placeholder="Сцена" onChange={(v) => set({ scene: v })} /></div>}
        {value.op === 'source' && <div className="field" style={{ margin: 0 }}><label>Сцена (пусто — текущая)</label><NamePick value={value.scene} options={scenes} placeholder="Текущая сцена" onChange={(v) => set({ scene: v })} /></div>}
        {(value.op === 'filter') && <div className="field" style={{ margin: 0 }}><label>Источник с фильтром</label><NamePick value={value.source} options={filterSources} placeholder="Источник" onChange={(v) => set({ source: v })} /></div>}
        {value.op === 'media' && <div className="field" style={{ margin: 0 }}><label>Медиа-источник</label><NamePick value={value.source} options={mediaInputs.length ? mediaInputs : inputs.map((i) => i.name)} placeholder="Источник" onChange={(v) => set({ source: v })} /></div>}
        {value.op === 'text' && <div className="field" style={{ margin: 0 }}><label>Текстовый источник</label><NamePick value={value.source} options={textInputs.length ? textInputs : inputs.map((i) => i.name)} placeholder="Источник" onChange={(v) => set({ source: v })} /></div>}
        {value.op === 'source' && <div className="field" style={{ margin: 0 }}><label>Источник</label><NamePick value={value.source} options={items} placeholder="Источник" onChange={(v) => set({ source: v })} /></div>}
        {value.op === 'filter' && <div className="field" style={{ margin: 0 }}><label>Фильтр</label><NamePick value={value.filter} options={catalog?.filters[value.source] ?? []} placeholder="Фильтр" onChange={(v) => set({ filter: v })} /></div>}
        {(value.op === 'source' || value.op === 'filter') && (
          <div className="field" style={{ margin: 0 }}>
            <label>Как</label>
            <select className="input" value={value.mode} onChange={(e) => set({ mode: e.target.value as ObsAction['mode'] })}>
              <option value="show">{value.op === 'filter' ? 'Включить' : 'Показать'}</option>
              <option value="hide">{value.op === 'filter' ? 'Выключить' : 'Скрыть'}</option>
              <option value="toggle">Переключить</option>
            </select>
          </div>
        )}
        {value.op === 'media' && (
          <div className="field" style={{ margin: 0 }}>
            <label>Команда</label>
            <select className="input" value={value.media} onChange={(e) => set({ media: e.target.value as ObsAction['media'] })}>
              <option value="restart">Запустить сначала</option><option value="play">Играть</option><option value="pause">Пауза</option><option value="stop">Стоп</option>
            </select>
          </div>
        )}
        {value.op === 'text' && (
          <div className="field" style={{ margin: 0, gridColumn: '1 / -1' }}>
            <label>Новый текст ({'{user}'}, {'{amount}'}, {'{message}'})</label>
            <input className="input" defaultValue={value.text} maxLength={300} onBlur={(e) => e.target.value !== value.text && set({ text: e.target.value })} />
          </div>
        )}
        {value.op !== 'media' && (
          <div className="field" style={{ margin: 0 }}>
            <label>Вернуть как было, сек</label>
            <input className="input mono" type="number" min={0} max={3600} defaultValue={value.revertSec} key={value.revertSec}
              onBlur={(e) => { const n = Math.max(0, Math.min(3600, Math.round(Number(e.target.value) || 0))); if (n !== value.revertSec) set({ revertSec: n }) }} />
          </div>
        )}
      </div>
      <div className="btnrow" style={{ marginTop: 8 }}>
        {withTest && <button className="btn sm" onClick={() => { setMsg(null); window.hub.obsTest(value).then(() => setMsg('Выполнено')).catch((e) => setMsg(errText(e))) }}>Проверить в OBS</button>}
        <button className="btn sm" disabled={loading} onClick={reload}>{loading ? 'Загрузка…' : '↻ Списки из OBS'}</button>
        {(msg || error) && <span className="small muted">{msg ?? (error === 'OBS не подключён' ? 'OBS не подключён — названия можно вписать вручную' : `OBS: ${error}`)}</span>}
      </div>
    </div>
  )
}
