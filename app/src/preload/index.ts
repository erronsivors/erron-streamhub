import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HubSnapshot } from '../main/core/types'
import type { StatsSnapshot } from '../main/core/stats'
import type { SoundInfo } from '../main/core/sounds'
import type { AppSettings } from '../main/core/settings'
import type { MediaInfo } from '../main/core/media'
import type { AlertTemplate, ObsAction } from '../main/core/templates'
import type { Rule } from '../main/core/rules'
import type { ObsCatalog } from '../main/core/obs'
import type { TtsVoice } from '../main/core/tts'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
type Role = 'broadcaster' | 'bot'
const call = <T = void>(ch: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(ch, ...args)

// Интерфейс видит только эти функции — никакого прямого доступа к Node/Electron.
const api = {
  snapshot: () => call<HubSnapshot>('hub:snapshot'),
  setSettings: (patch: DeepPartial<AppSettings>) => call<AppSettings>('hub:settings', patch),
  obsConfigure: (url: string, password?: string) => call('hub:obsConfigure', url, password),
  obsReconnect: () => call('hub:obsReconnect'),
  rotateKey: (which: 'overlay' | 'remote') => call('hub:rotateKey', which),
  copy: (text: string) => call('hub:copy', text),
  openExternal: (url: string) => call('hub:openExternal', url),
  testEvent: (kind: 'donation' | 'bigdonation' | 'sub' | 'follow' | 'raid' | 'gift' | 'bits' | 'reward' | 'boosty' | 'message') => call('hub:testEvent', kind),
  alertPause: (v: boolean) => call('hub:alertPause', v),
  alertSkip: () => call('hub:alertSkip'),
  alertStopAll: () => call('hub:alertStopAll'),
  alertRemove: (id: string) => call('hub:alertRemove', id),
  alertReplay: (eventId: string) => call<boolean>('hub:alertReplay', eventId),
  stats: (period: string) => call<StatsSnapshot>('hub:stats', period),
  soundAdd: () => call<SoundInfo | null>('hub:soundAdd'),
  soundRemove: (id: string) => call('hub:soundRemove', id),
  rulePut: (r: Rule) => call<Rule>('hub:rulePut', r),
  ruleRemove: (id: string) => call('hub:ruleRemove', id),
  ruleMove: (id: string, dir: -1 | 1) => call('hub:ruleMove', id, dir),
  ruleTest: (id: string, kind: string) => call<boolean>('hub:ruleTest', id, kind),
  rulesFlags: (p: { enabled?: boolean; dryRun?: boolean }) => call('hub:rulesFlags', p),
  rulesClearLog: () => call('hub:rulesClearLog'),
  templatePut: (t: AlertTemplate) => call<AlertTemplate>('hub:templatePut', t),
  templateRemove: (id: string) => call('hub:templateRemove', id),
  templateDuplicate: (id: string) => call<AlertTemplate | null>('hub:templateDuplicate', id),
  templateTest: (t: AlertTemplate, kind: string) => call('hub:templateTest', t, kind),
  mediaAdd: () => call<MediaInfo | null>('hub:mediaAdd'),
  mediaRemove: (id: string) => call('hub:mediaRemove', id),
  openOverlay: (id: string) => call('hub:openOverlay', id),
  obsCatalog: () => call<ObsCatalog>('hub:obsCatalog'),
  obsTest: (a: ObsAction) => call('hub:obsTest', a),
  ttsVoices: () => call<TtsVoice[]>('hub:ttsVoices'),
  ttsTest: (text: string) => call<string>('hub:ttsTest', text),
  daLogin: () => call('hub:daLogin'),
  daCancel: () => call('hub:daCancel'),
  dpKey: (key: string) => call('hub:dpKey', key),
  dxLogin: () => call('hub:dxLogin'),
  dxCancel: () => call('hub:dxCancel'),
  dxToken: (token: string) => call('hub:dxToken', token),
  boostyLogin: () => call('hub:boostyLogin'),
  boostyCancel: () => call('hub:boostyCancel'),
  openSite: (id: string) => call('hub:openSite', id),
  clearSite: (id: string) => call('hub:clearSite', id),
  donationLogout: (platform: string) => call('hub:donationLogout', platform),
  reconnect: (platform: string) => call('hub:reconnect', platform),
  floatEdit: () => call('hub:floatEdit'),
  floatReset: () => call('hub:floatReset'),
  twitchLogin: (role: Role) => call('hub:twitchLogin', role),
  twitchCancel: () => call('hub:twitchCancel'),
  twitchLogout: (role: Role) => call('hub:twitchLogout', role),
  twitchRestart: () => call('hub:twitchRestart'),
  youtubeLogin: () => call('hub:youtubeLogin'),
  youtubeCancel: () => call('hub:youtubeCancel'),
  youtubeLogout: () => call('hub:youtubeLogout'),
  youtubeSecret: (secret: string | null) => call('hub:youtubeSecret', secret),
  chatSend: (text: string, as: Role, targets: string[]) => call('hub:chatSend', text, as, targets),
  chatPin: (id: string | null) => call('hub:chatPin', id),
  chatDelete: (id: string) => call('hub:chatDelete', id),
  chatBan: (id: string, seconds: number) => call('hub:chatBan', id, seconds),
  onUpdate: (cb: (s: HubSnapshot) => void): (() => void) => {
    const fn = (_e: IpcRendererEvent, s: HubSnapshot): void => cb(s)
    ipcRenderer.on('hub:update', fn)
    return () => ipcRenderer.removeListener('hub:update', fn)
  }
}

contextBridge.exposeInMainWorld('hub', api)
export type HubApi = typeof api
