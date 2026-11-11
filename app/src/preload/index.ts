import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HubSnapshot } from '../main/core/types'
import type { StatsSnapshot } from '../main/core/stats'
import type { SoundInfo } from '../main/core/sounds'
import type { AppSettings } from '../main/core/settings'
import type { MediaInfo } from '../main/core/media'
import type { AlertTemplate, ObsAction } from '../main/core/templates'
import type { Rule } from '../main/core/rules'
import type { Counter } from '../main/core/counters'
import type { AuctionBet, AuctionLot, AuctionState } from '../main/core/auction'
import type { WheelItem } from '../main/core/wheel'
import type { ProfilePart, ProfileSummary } from '../main/core/profile'
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
  manualDonation: (d: { user: string; amount: number; currency: string; text: string; amountRub?: number }) => call('hub:manualDonation', d),
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
  infoDraft: (v: { title?: string; game?: string; ytCategory?: string; targets?: string[] }) => call('hub:infoDraft', v),
  infoApply: () => call('hub:infoApply'),
  infoSuggest: (q: string) => call<string[]>('hub:infoSuggest', q),
  infoFromTwitch: () => call('hub:infoFromTwitch'),
  infoOpen: (p: string) => call('hub:infoOpen', p),
  kickLogin: () => call('hub:kickLogin'),
  kickCancel: () => call('hub:kickCancel'),
  kickLogout: () => call('hub:kickLogout'),
  profileExport: (withMedia: boolean) => call<{ size: number } | null>('hub:profileExport', withMedia),
  profilePick: () => call<ProfileSummary | null>('hub:profilePick'),
  profileApply: (parts: ProfilePart[]) => call('hub:profileApply', parts),
  profileCancel: () => call('hub:profileCancel'),
  profileUndo: () => call('hub:profileUndo'),
  counterPut: (c: Partial<Counter> & { name: string }) => call<Counter>('hub:counterPut', c),
  counterRemove: (id: string) => call('hub:counterRemove', id),
  counterApply: (id: string, op: 'add' | 'sub' | 'set', n: number) => call<Counter | null>('hub:counterApply', id, op, n),
  aucLotAdd: (name: string) => call<AuctionLot>('hub:aucLotAdd', name),
  aucLotRename: (id: string, name: string) => call('hub:aucLotRename', id, name),
  aucLotApprove: (id: string) => call('hub:aucLotApprove', id),
  aucLotRemove: (id: string) => call('hub:aucLotRemove', id),
  aucLotMerge: (from: string, into: string) => call('hub:aucLotMerge', from, into),
  aucLotAddSum: (id: string, rub: number) => call('hub:aucLotAddSum', id, rub),
  aucBetAssign: (bet: string, lot: string) => call('hub:aucBetAssign', bet, lot),
  aucBetNewLot: (bet: string, name?: string) => call<AuctionLot>('hub:aucBetNewLot', bet, name),
  aucBetReject: (bet: string) => call('hub:aucBetReject', bet),
  aucBetReopen: (bet: string) => call('hub:aucBetReopen', bet),
  aucManualBet: (b: { user: string; rub: number; text: string }) => call<AuctionBet>('hub:aucManualBet', b),
  aucTimer: (op: 'start' | 'pause' | 'add' | 'sub' | 'set' | 'clear', sec?: number) => call('hub:aucTimer', op, sec),
  aucAccepting: (v: boolean) => call('hub:aucAccepting', v),
  aucFinish: () => call<AuctionState['winner']>('hub:aucFinish'),
  aucReset: (keepLots: boolean) => call('hub:aucReset', keepLots),
  aucClearArchive: () => call('hub:aucClearArchive'),
  wheelSetItems: (items: WheelItem[]) => call('hub:wheelSetItems', items),
  wheelLoadLots: () => call<number>('hub:wheelLoadLots'),
  wheelSpin: () => call('hub:wheelSpin'),
  wheelRestart: () => call('hub:wheelRestart'),
  wheelClearHistory: () => call('hub:wheelClearHistory'),
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
