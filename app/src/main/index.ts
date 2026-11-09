import { app, BrowserWindow, ipcMain, session, shell, clipboard, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { Store } from './core/db'
import { Secrets } from './core/secrets'
import { Hub } from './core/hub'
import { OverlayServer } from './core/server'
import { ObsConnector } from './core/obs'
import type { HubEvent, HubSnapshot, Platform } from './core/types'

// Один экземпляр приложения: второй запуск просто показывает окно.
if (!app.requestSingleInstanceLock()) app.quit()

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')

let win: BrowserWindow | null = null
let store: Store
let hub: Hub
let server: OverlayServer
let obs: ObsConnector

// Площадки, которые появятся на следующих этапах — видны в «Подключениях» как «Не настроено».
const PLANNED: [Platform, string][] = [
  ['twitch', 'Twitch'], ['youtube', 'YouTube'], ['vk', 'VK Видео Live'], ['kick', 'Kick'],
  ['donationalerts', 'DonationAlerts'], ['donatepay', 'DonatePay'], ['donatex', 'DonateX'], ['boosty', 'Boosty']
]

function snapshot(): HubSnapshot {
  return {
    connections: hub.connections(),
    obs: obs.state,
    events: hub.recent(),
    server: server.info(),
    obsConfig: obs.config()
  }
}

let pushTimer: NodeJS.Timeout | null = null
/** Отправить интерфейсу свежий снимок (не чаще 10 раз в секунду). */
function pushUpdate(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    win?.webContents.send('hub:update', snapshot())
  }, 100)
}

/** IPC принимаем только от нашего окна. */
function trusted(e: IpcMainInvokeEvent): boolean {
  return !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender')
    return fn(...(args as A))
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f0b0a',
    title: 'ERRON StreamHub',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win?.show())

  // Никаких переходов и новых окон внутри приложения; http(s)-ссылки — во внешний браузер по явному клику.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!(isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL!))) e.preventDefault()
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  // Запрет всех разрешений (камера, микрофон, уведомления…). CSP интерфейса вшит в index.html при сборке.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  store = new Store(join(app.getPath('userData'), 'data'))
  const secrets = new Secrets(store)
  hub = new Hub()
  hub.register('hub', 'Сервер оверлеев')
  for (const [id, name] of PLANNED) hub.register(id, name)
  hub.seed(store.recentEvents(100))
  if (!secrets.available()) hub.log('hub', 'error', 'Шифрование Windows недоступно — токены сохранять нельзя')

  hub.on('status', pushUpdate)
  hub.on('event', (e: HubEvent) => {
    if (e.type !== 'message') store.addEvent(e)
    pushUpdate()
  })

  server = new OverlayServer(hub, store, resourcesDir, app.getAppPath())
  obs = new ObsConnector(hub, store, secrets)
  obs.onChange = pushUpdate

  handle('hub:snapshot', () => snapshot())
  handle('hub:obsConfigure', (url: unknown, password: unknown) => {
    if (typeof url !== 'string' || (password !== undefined && typeof password !== 'string')) throw new Error('bad args')
    return obs.configure(url.trim(), password as string | undefined)
  })
  handle('hub:obsReconnect', () => obs.reconnect())
  handle('hub:rotateOverlayKey', () => {
    server.rotateKey()
    pushUpdate()
  })
  handle('hub:copy', (text: unknown) => {
    if (typeof text === 'string' && text.length < 2000) clipboard.writeText(text)
  })
  handle('hub:testEvent', (kind: unknown) => {
    const samples: Record<string, Omit<HubEvent, 'id' | 'ts'>> = {
      donation: { platform: 'donationalerts', type: 'donation', user: 'Тестовый зритель', amount: 500, currency: 'RUB', text: 'Привет со стрима! 🔥', test: true },
      sub: { platform: 'twitch', type: 'sub', user: 'night_raven', text: '3 месяца вместе', test: true },
      follow: { platform: 'twitch', type: 'follow', user: 'pixel_fox', test: true },
      raid: { platform: 'twitch', type: 'raid', user: 'kostya_play', amount: 42, text: '42 зрителя', test: true }
    }
    const s = samples[String(kind)]
    if (s) hub.push(s)
  })

  createWindow()

  try {
    await server.start()
  } catch (e) {
    hub.setStatus('hub', 'error', `Сервер не запустился: ${(e as Error).message}`)
  }
  await obs.start()
  pushUpdate()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  void obs?.stop()
  void server?.stop()
  store?.close()
})
