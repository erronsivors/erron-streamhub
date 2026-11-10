import { app, BrowserWindow, dialog, ipcMain, session, shell, clipboard, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { Store } from './core/db'
import { Secrets } from './core/secrets'
import { Hub } from './core/hub'
import { Settings, type AppSettings } from './core/settings'
import { OverlayServer } from './core/server'
import { ObsConnector } from './core/obs'
import { TwitchConnector } from './core/twitch'
import { ImageCache } from './core/imgcache'
import { FloatChat, FLOAT_HOTKEY } from './core/floatchat'
import { ChatRegistry } from './core/connector'
import { GoodGameConnector } from './core/goodgame'
import { KickConnector } from './core/kick'
import { VkConnector } from './core/vk'
import { YoutubeConnector } from './core/youtube'
import { AlertEngine, fill } from './core/alerts'
import { TemplateStore, sanitizeTemplate, sanitizeObs } from './core/templates'
import { RuleEngine } from './core/rules'
import { MediaLibrary } from './core/media'
import { WindowsTts } from './core/tts'
import { Stats } from './core/stats'
import { SoundLibrary } from './core/sounds'
import type { DonationConnector } from './core/donations/common'
import { DonationAlertsConnector } from './core/donations/donationalerts'
import { DonatePayConnector } from './core/donations/donatepay'
import { DonateXConnector } from './core/donations/donatex'
import { BoostyConnector } from './core/donations/boosty'
import { clearSite, isSiteId, openSite } from './core/sitewindow'
import type { StatsPeriod } from './core/settings'
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
let youtube: YoutubeConnector
let floatChat: FloatChat
const chats = new ChatRegistry()
let alerts: AlertEngine
let stats: Stats
let sounds: SoundLibrary
let media: MediaLibrary
let tts: WindowsTts
let templates: TemplateStore
let rules: RuleEngine
let da: DonationAlertsConnector
let dp: DonatePayConnector
let dx: DonateXConnector
let boosty: BoostyConnector
let donations: DonationConnector[] = []

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
    twitch: twitch.state(),
    youtube: youtube.state(),
    platforms: chats.states(),
    alerts: alerts.state(),
    donations: donations.map((d) => d.state()),
    sounds: sounds.list(),
    media: media.list(),
    templates: templates.all(),
    rules: rules.state(),
    alertOverlays: server ? server.openCount('alert') : 0,
    float: { open: floatChat?.isOpen ?? false, editing: floatChat?.isEditing ?? false, hotkey: FLOAT_HOTKEY.replace('CommandOrControl', 'Ctrl') }
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

/** Тестовые события: кнопки «Проверка», тест правил и шаблонов. */
const SAMPLES: Record<string, Omit<HubEvent, 'id' | 'ts'>> = {
  donation: { platform: 'donationalerts', type: 'donation', user: 'Тестовый зритель', amount: 500, currency: 'RUB', amountRub: 500, text: 'Привет со стрима! 🔥', test: true },
  sub: { platform: 'twitch', type: 'sub', user: 'night_raven', text: '3 мес. вместе', test: true },
  follow: { platform: 'twitch', type: 'follow', user: 'pixel_fox', test: true },
  raid: { platform: 'twitch', type: 'raid', user: 'kostya_play', amount: 42, test: true },
  bigdonation: { platform: 'donatex', type: 'donation', user: 'Щедрый гость', amount: 5000, currency: 'RUB', amountRub: 5000, text: 'Это на новый микрофон!', test: true },
  gift: { platform: 'twitch', type: 'gift', user: 'santa_claws', amount: 5, test: true },
  bits: { platform: 'twitch', type: 'bits', user: 'bit_master', amount: 300, text: 'Держи биты!', test: true },
  reward: { platform: 'twitch', type: 'reward', user: 'lucky_cat', text: 'Спой песню', test: true },
  boosty: { platform: 'boosty', type: 'sub', user: 'Верный подписчик', amount: 300, currency: 'RUB', text: 'Уровень «Костёр»', test: true },
  message: { platform: 'twitch', type: 'message', user: 'test_viewer', userId: 'test', text: 'Тестовое сообщение: всем привет у костра! 🔥', parts: [{ t: 'text', v: 'Тестовое сообщение: всем привет у костра! 🔥' }], color: '#ffb27a', test: true }
}
/** Тестовое событие без отправки в ленту (для проверки правила или шаблона). */
const sampleEvent = (kind: unknown): HubEvent => ({ ...(SAMPLES[String(kind)] ?? SAMPLES.donation), id: `test-${Date.now()}`, ts: Date.now() })

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
  chats.add(twitch)
  youtube = new YoutubeConnector(hub, settings, secrets, resourcesDir)
  chats.add(youtube)
  youtube.onChange = pushUpdate
  const goodgame = new GoodGameConnector(hub, settings, images, join(app.getPath('userData'), 'cache'))
  const kick = new KickConnector(hub, settings, images)
  const vk = new VkConnector(hub, settings, images)
  chats.add(goodgame)
  chats.add(kick)
  chats.add(vk)
  goodgame.onChange = pushUpdate
  kick.onChange = pushUpdate
  vk.onChange = pushUpdate
  da = new DonationAlertsConnector(hub, settings, secrets, store)
  dp = new DonatePayConnector(hub, secrets, store)
  dx = new DonateXConnector(hub, settings, secrets, store)
  boosty = new BoostyConnector(hub, settings, secrets, store)
  donations = [da, dp, dx, boosty]
  for (const d of donations) d.onChange = pushUpdate
  tts = new WindowsTts(app.getPath('userData'), hub)
  media = new MediaLibrary(app.getPath('userData'), store)
  templates = new TemplateStore(store)
  templates.onChange = pushUpdate
  const runObs = (a: Parameters<ObsConnector['run']>[0], e: HubEvent): Promise<void> => obs.run(a, (s) => fill(s, e))
  alerts = new AlertEngine(hub, settings, tts, runObs)
  alerts.on('change', pushUpdate)
  rules = new RuleEngine(hub, store, settings, templates, { play: (plan, e, force) => alerts.play(plan, e, force), obs: runObs })
  rules.on('change', pushUpdate)
  stats = new Stats(store, () => (obs.state.streaming ? obs.state.streamStartedAt : null))
  sounds = new SoundLibrary(app.getPath('userData'), store)
  hub.seed(store.recentEvents(100))
  if (!secrets.available()) hub.log('hub', 'error', 'Шифрование Windows недоступно — токены сохранять нельзя')

  for (const ev of ['status', 'delete', 'pinned', 'log']) hub.on(ev, pushUpdate)
  hub.on('event', (e: HubEvent) => {
    // Сообщения чата на диск не пишем (приватность); события — с пометкой test, статистика тестовые не считает.
    if (e.type !== 'message') store.addEvent(e)
    pushUpdate()
  })

  server = new OverlayServer(hub, store, settings, images, resourcesDir, app.getAppPath(), {
    send: (text) => chats.send(text, chats.states().filter((p) => p.canSend).map((p) => p.id), 'broadcaster'),
    pin: (id) => hub.togglePin(id)
  }, { alerts, stats, sounds, media, tts })
  obs.onChange = pushUpdate
  server.onClients = pushUpdate
  floatChat = new FloatChat(settings, hub, () => server.overlayUrl('float'))
  floatChat.onChange = pushUpdate
  twitch.onChange = pushUpdate

  let prev: AppSettings = settings.get()
  settings.onChange = (s) => {
    server.pushConfig()
    if (s.setupMode !== prev.setupMode || JSON.stringify(s.lan) !== JSON.stringify(prev.lan)) void server.applyLan().then(pushUpdate)
    floatChat.apply()
    if (s.goodgame.channel !== prev.goodgame.channel) void goodgame.restart()
    if (s.kick.channel !== prev.kick.channel) void kick.restart()
    if (s.youtube.customClientId !== prev.youtube.customClientId) void youtube.logout()
    if (s.vk.channel !== prev.vk.channel) void vk.restart()
    if (s.donationalerts.customClientId !== prev.donationalerts.customClientId) void da.logout()
    if (s.donatex.customClientId !== prev.donatex.customClientId && dx.state().method === 'oauth') void dx.logout()
    if (s.boosty.poll !== prev.boosty.poll) void boosty.restart()
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
    if (/^https:\/\/(dev\.twitch\.tv|www\.twitch\.tv|obsproject\.com|github\.com|console\.cloud\.google\.com|www\.donationalerts\.com|donatepay\.ru|donatex\.gg|boosty\.to)\//.test(u)) void shell.openExternal(u)
  })
  handle('hub:testEvent', (kind) => {
    const x = SAMPLES[String(kind)]
    if (x) hub.push(x)
  })
  // ---------- Алерты, статистика, звуки ----------
  handle('hub:alertPause', (v) => alerts.setPaused(v === true))
  handle('hub:alertSkip', () => alerts.skip())
  handle('hub:alertStopAll', () => alerts.stopAll())
  handle('hub:alertRemove', (id) => alerts.remove(str(id, 100)))
  handle('hub:alertReplay', (id) => {
    const e = hub.recent().find((x) => x.id === str(id, 100))
    return e ? rules.replay(e) : false
  })
  // ---------- Правила ----------
  handle('hub:rulePut', (r) => rules.put(r))
  handle('hub:ruleRemove', (id) => rules.remove(str(id, 100)))
  handle('hub:ruleMove', (id, dir) => rules.move(str(id, 100), dir === -1 ? -1 : 1))
  handle('hub:ruleTest', (id, kind) => rules.test(str(id, 100), sampleEvent(kind)))
  handle('hub:rulesFlags', (p) => rules.setFlags((p && typeof p === 'object' ? p : {}) as { enabled?: unknown; dryRun?: unknown }))
  handle('hub:rulesClearLog', () => rules.clearLog())
  // ---------- Шаблоны алертов (конструктор) ----------
  handle('hub:templatePut', (t) => templates.put(t))
  handle('hub:templateRemove', (id) => {
    templates.remove(str(id, 100))
    rules.forgetTemplate(String(id))
  })
  handle('hub:templateDuplicate', (id) => templates.duplicate(str(id, 100)))
  handle('hub:templateTest', (t, kind) => alerts.enqueue(sanitizeTemplate(t), sampleEvent(kind), true))
  handle('hub:mediaAdd', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: 'Картинка или видео для алерта', properties: ['openFile'], filters: [{ name: 'Картинки и видео', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'webm', 'mp4'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const info = media.add(r.filePaths[0])
    pushUpdate()
    return info
  })
  handle('hub:mediaRemove', (id) => {
    const used = templates.usedMedia()
    if (used.has(str(id, 100))) throw new Error('Файл используется в шаблоне — сначала уберите его из слоёв')
    media.remove(String(id))
    pushUpdate()
  })
  // ---------- OBS-действия и озвучка ----------
  handle('hub:openOverlay', (id) => {
    const o = server.info().overlays.find((x) => x.id === id)
    if (o && /^http:\/\/127\.0\.0\.1:\d+\/o\/[\w-]+\?k=[\w-]+$/.test(o.url)) void shell.openExternal(o.url)
  })
  handle('hub:obsCatalog', () => obs.catalog())
  handle('hub:obsTest', (a) => obs.run(sanitizeObs(a), (s) => fill(s, sampleEvent('donation'))))
  handle('hub:ttsVoices', () => tts.voices())
  handle('hub:ttsTest', async (text) => {
    const s = settings.get().tts
    const r = await tts.synth(str(text, 500), s.voice, s.rate)
    return `/t/${r.file}`
  })
  handle('hub:stats', (period) => {
    const p = (['stream', 'today', 'week', 'month', 'all'] as StatsPeriod[]).includes(period as StatsPeriod) ? (period as StatsPeriod) : 'stream'
    return stats.snapshot(p)
  })
  handle('hub:soundAdd', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: 'Звук для алерта', properties: ['openFile'], filters: [{ name: 'Звук', extensions: ['mp3', 'wav', 'ogg'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const info = sounds.add(r.filePaths[0])
    pushUpdate()
    return info
  })
  handle('hub:soundRemove', (id) => {
    sounds.remove(str(id, 100))
    pushUpdate()
  })
  // ---------- Сервисы донатов ----------
  handle('hub:daLogin', () => da.login())
  handle('hub:daCancel', () => da.cancelLogin())
  handle('hub:dpKey', (key) => dp.setKey(str(key, 300)))
  handle('hub:dxLogin', () => dx.login())
  handle('hub:dxCancel', () => dx.cancelLogin())
  handle('hub:dxToken', (t) => dx.setToken(str(t, 4000)))
  handle('hub:boostyLogin', () => boosty.login())
  handle('hub:boostyCancel', () => boosty.cancelLogin())
  handle('hub:openSite', (id) => { if (isSiteId(id)) openSite(id) })
  handle('hub:clearSite', (id) => (isSiteId(id) ? clearSite(id) : undefined))
  handle('hub:donationLogout', (p) => donations.find((d) => d.id === p)?.logout())
  handle('hub:floatEdit', () => floatChat.toggleEdit())
  handle('hub:floatReset', () => floatChat.reset())
  handle('hub:reconnect', (p) => {
    if (p === 'obs') return obs.reconnect()
    const d = donations.find((x) => x.id === p)
    if (d) return d.restart()
    return chats.get(p as Platform)?.restart()
  })
  handle('hub:twitchLogin', (r) => twitch.login(role(r)))
  handle('hub:twitchCancel', () => twitch.cancelLogin())
  handle('hub:twitchLogout', (r) => twitch.logout(role(r)))
  handle('hub:twitchRestart', () => twitch.restart())
  handle('hub:youtubeLogin', () => youtube.login())
  handle('hub:youtubeCancel', () => youtube.cancelLogin())
  handle('hub:youtubeLogout', () => youtube.logout())
  handle('hub:youtubeSecret', (v) => youtube.setCustomSecret(typeof v === 'string' ? str(v, 200) : null))
  handle('hub:chatSend', (text, as, targets) => {
    const list = Array.isArray(targets) ? (targets.filter((t) => typeof t === 'string') as Platform[]) : []
    return chats.send(str(text), list, role(as))
  })
  handle('hub:chatPin', (id) => hub.togglePin(id === null ? null : str(id, 100)))
  handle('hub:chatDelete', async (id) => {
    const m = hub.findMessage(str(id, 100))
    if (!m) return
    if (m.test) return hub.deleteMessage(m.id)
    await chats.get(m.platform)?.deleteMessage?.(m)
  })
  handle('hub:chatBan', async (id, seconds) => {
    const m = hub.findMessage(str(id, 100))
    const sec = typeof seconds === 'number' ? seconds : 0
    if (m && !m.test) await chats.get(m.platform)?.ban?.(m, sec)
  })

  createWindow()

  try {
    await server.start()
  } catch (e) {
    hub.setStatus('hub', 'error', `Сервер не запустился: ${(e as Error).message}`)
  }
  await obs.start()
  void chats.startAll()
  for (const d of donations) void d.start().catch(() => undefined)
  floatChat.apply()
  pushUpdate()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  floatChat?.close()
  chats.stopAll()
  for (const d of donations) d.stop()
  alerts?.dispose()
  tts?.dispose()
  void obs?.stop()
  void server?.stop()
  store?.close()
})
