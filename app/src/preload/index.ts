import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HubSnapshot } from '../main/core/types'
import type { AppSettings } from '../main/core/settings'

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
  testEvent: (kind: 'donation' | 'sub' | 'follow' | 'raid' | 'message') => call('hub:testEvent', kind),
  twitchLogin: (role: Role) => call('hub:twitchLogin', role),
  twitchCancel: () => call('hub:twitchCancel'),
  twitchLogout: (role: Role) => call('hub:twitchLogout', role),
  twitchRestart: () => call('hub:twitchRestart'),
  chatSend: (text: string, as: Role) => call('hub:chatSend', text, as),
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
