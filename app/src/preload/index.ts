import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HubSnapshot } from '../main/core/types'

// Интерфейс видит только эти функции — никакого прямого доступа к Node/Electron.
const api = {
  snapshot: (): Promise<HubSnapshot> => ipcRenderer.invoke('hub:snapshot'),
  obsConfigure: (url: string, password?: string): Promise<void> => ipcRenderer.invoke('hub:obsConfigure', url, password),
  obsReconnect: (): Promise<void> => ipcRenderer.invoke('hub:obsReconnect'),
  rotateOverlayKey: (): Promise<void> => ipcRenderer.invoke('hub:rotateOverlayKey'),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('hub:copy', text),
  testEvent: (kind: 'donation' | 'sub' | 'follow' | 'raid'): Promise<void> => ipcRenderer.invoke('hub:testEvent', kind),
  onUpdate: (cb: (s: HubSnapshot) => void): (() => void) => {
    const fn = (_e: IpcRendererEvent, s: HubSnapshot): void => cb(s)
    ipcRenderer.on('hub:update', fn)
    return () => ipcRenderer.removeListener('hub:update', fn)
  }
}

contextBridge.exposeInMainWorld('hub', api)
export type HubApi = typeof api
