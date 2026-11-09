import { app, BrowserWindow, ipcMain, session, shell, clipboard, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { Store } from './core/db'
import { Secrets } from './core/secrets'
import { Hub } from './core/hub'
import { Settings, type AppSettings } from './core/settings'
import { OverlayServer } from './core/server'
import { ObsConnector } from './core/obs'
import { TwitchConnector } from './core/twitch'
import { ImageCache } from './core/imgcache'
import type { HubEvent, HubSnapshot, Platform } from './core/types'

// Один экземпляр приложения: второй запуск просто показывает окно.
if (!app.requestSingleInstanceLock()) app.quit()

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const resourcesDir = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')

let win: BrowserWindow | null = null
let store: Store
let settings: Settings
let hub: Hub
let server: OverlayServer
let obs: ObsConnector
let twitch: TwitchConnector

// Площадки следующих этапов — видны в «Подключениях» как «Не настроено».
const PLANNED: [Platform, string][] = [
  ['youtube', 'YouTube'], ['vk', 'VK Видео Live'], ['kick', 'Kick'],
  ['donationalerts', 'DonationAlerts'], ['donatepay', 'DonatePay'], ['donatex', 'DonateX'], ['boosty', 'Boosty']
]

function snapshot(): HubSnapshot {
  return {
    connections: hub.connections(),
    obs: obs.state,
    events: hub.recent(),
    chat: hub.recentChat(),
    pinned: hub.pinned,
    server: server.info(),
    obsConfig: obs.config(),
    settings: settings.get(),
    twitch: twitch.state()
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

/** IPC принимаем только от главного фрейма нашего окна. */
function trusted(e: IpcMainInvokeEvent): boolean {
  return !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame
}

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) throw new Error('untrusted sender')
    return fn(...args)
  })
}

const str = (v: unknown, max = 500): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('bad args')
  return v
}
const role = (v: unknown): 'broadcaster' | 'bot' => (v === 'bot' ? 'bot' : 'broadcaster')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f0b0a',
    title: 'Crossember',
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

  // Никаких переходов и новых окон внутри приложения; https-ссылки — во внешний браузер.
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
  settings = new Settings(store)
  const secrets = new Secrets(store)
  hub = new Hub()
  hub.register('hub', 'Сервер Crossember')
  obs = new ObsConnector(hub, store, secrets)
  const images = new ImageCache(join(app.getPath('userData'), 'cache', 'img'))
  images.preconnect()
  twitch = new TwitchConnector(hub, settings, secrets, images)
  for (const [id, name] of PLANNED) hub.register(id, name)
  hub.seed(store.recentEvents(100))
  if (!secrets.available()) hub.log('hub', 'error', 'Шифрование Windows недоступно — токены сохранять нельзя')

  for (const ev of ['status', 'delete', 'pinned', 'log']) hub.on(ev, pushUpdate)
  hub.on('event', (e: HubEvent) => {
    // Сообщения чата на диск не пишем (приватность); события — с пометкой test, статистика тестовые не считает.
    if (e.type !== 'message') store.addEvent(e)
    pushUpdate()
  })

  server = new OverlayServer(hub, store, settings, images, resourcesDir, app.getAppPath(), {
    send: (text) => twitch.send(text, 'broadcaster'),
    pin: (id) => hub.togglePin(id)
  })
  obs.onChange = pushUpdate
  twitch.onChange = pushUpdate

  let prev: AppSettings = settings.get()
  settings.onChange = (s) => {
    server.pushConfig()
    if (s.setupMode !== prev.setupMode || JSON.stringify(s.lan) !== JSON.stringify(prev.lan)) void server.applyLan().then(pushUpdate)
    if (s.twitch.customClientId !== prev.twitch.customClientId || s.twitch.thirdPartyEmotes !== prev.twitch.thirdPartyEmotes) void twitch.restart()
    prev = s
    pushUpdate()
  }

  // ---------- IPC: всё, что может интерфейс ----------
  handle('hub:snapshot', () => snapshot())
  handle('hub:settings', (patch) => settings.patch(patch))
  handle('hub:obsConfigure', (url, password) => obs.configure(str(url, 200).trim(), password === undefined ? undefined : str(password, 200)))
  handle('hub:obsReconnect', () => obs.reconnect())
  handle('hub:rotateKey', (which) => {
    server.rotate(which === 'remote' ? 'remote' : 'overlay')
    pushUpdate()
  })
  handle('hub:copy', (text) => clipboard.writeText(str(text, 2000)))
  handle('hub:openExternal', (url) => {
    const u = str(url, 300)
    if (/^https:\/\/(dev\.twitch\.tv|www\.twitch\.tv|obsproject\.com|github\.com)\//.test(u)) void shell.openExternal(u)
  })
  handle('hub:testEvent', (kind) => {
    const samples: Record<string, Omit<HubEvent, 'id' | 'ts'>> = {
      donation: { platform: 'donationalerts', type: 'donation', user: 'Тестовый зритель', amount: 500, currency: 'RUB', text: 'Привет со стрима! 🔥', test: true },
      sub: { platform: 'twitch', type: 'sub', user: 'night_raven', text: '3 мес. вместе', test: true },
      follow: { platform: 'twitch', type: 'follow', user: 'pixel_fox', test: true },
      raid: { platform: 'twitch', type: 'raid', user: 'kostya_play', amount: 42, text: '42 зрителя', test: true },
      message: { platform: 'twitch', type: 'message', user: 'test_viewer', userId: 'test', text: 'Тестовое сообщение: всем привет у костра! 🔥', parts: [{ t: 'text', v: 'Тестовое сообщение: всем привет у костра! 🔥' }], color: '#ffb27a', test: true }
    }
    const s = samples[String(kind)]
    if (s) hub.push(s)
  })
  handle('hub:twitchLogin', (r) => twitch.login(role(r)))
  handle('hub:twitchCancel', () => twitch.cancelLogin())
  handle('hub:twitchLogout', (r) => twitch.logout(role(r)))
  handle('hub:twitchRestart', () => twitch.restart())
  handle('hub:chatSend', (text, as) => twitch.send(str(text), role(as)))
  handle('hub:chatPin', (id) => hub.togglePin(id === null ? null : str(id, 100)))
  handle('hub:chatDelete', async (id) => {
    const m = hub.findMessage(str(id, 100))
    if (m?.test) return hub.deleteMessage(m.id)
    if (m?.platform === 'twitch') await twitch.deleteMessage(m.id)
  })
  handle('hub:chatBan', async (id, seconds) => {
    const m = hub.findMessage(str(id, 100))
    const sec = typeof seconds === 'number' ? seconds : 0
    if (m?.platform === 'twitch' && m.userId && !m.test) await twitch.ban(m.userId, sec, 'Crossember')
  })

  createWindow()

  try {
    await server.start()
  } catch (e) {
    hub.setStatus('hub', 'error', `Сервер не запустился: ${(e as Error).message}`)
  }
  await obs.start()
  void twitch.start()
  pushUpdate()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  twitch?.stop()
  void obs?.stop()
  void server?.stop()
  store?.close()
})
