import { app, BrowserWindow, dialog, globalShortcut, ipcMain, powerMonitor, session, shell, clipboard, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { release } from 'node:os'
import { Logger } from './core/logger'
import { FEEDBACK_EMAIL, bundleText, composeUrls, sanitizeForm, writeBundle, type LogBundle, type SystemInfo } from './core/feedback'
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
import { AlertEngine, fill, setVarsSource } from './core/alerts'
import { Counters } from './core/counters'
import { Auction } from './core/auction'
import { Wheel } from './core/wheel'
import { Fundraiser, type GoalReached } from './core/goal'
import { Giveaway, type GiveawayWinner } from './core/giveaway'
import { Analytics, CHAT_PLATFORMS, isAnalyticsPeriod, type ChatPlatform } from './core/analytics'
import { Profiles, type ProfilePart } from './core/profile'
import { KickAuth } from './core/kickauth'
import { StreamInfo, INFO_PLATFORMS, type InfoPlatform } from './core/streaminfo'
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
const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) app.quit()

// Журнал на диске (только у первого экземпляра — второй сразу закрывается и метку запуска трогать не должен).
const logger: Logger | null = firstInstance ? new Logger(join(app.getPath('userData'), 'logs')) : null
const startedAt = Date.now()
if (logger) {
  logger.info('app', `Запуск Crossember ${app.getVersion()} · Electron ${process.versions.electron} · Windows ${release()} ${process.arch}`)
  logger.onCrash = () => pushUpdate()
  process.on('uncaughtException', (e) => logger.fatal('main', e))
  process.on('unhandledRejection', (e) => logger.error('main', `Необработанная ошибка: ${e instanceof Error ? e.stack ?? e.message : String(e)}`))
  // Ошибки и предупреждения из консоли — тоже в журнал.
  for (const lvl of ['error', 'warn'] as const) {
    const orig = console[lvl].bind(console)
    console[lvl] = (...a: unknown[]) => {
      orig(...a)
      logger.write(lvl, 'console', a.map((x) => (x instanceof Error ? x.stack ?? x.message : typeof x === 'string' ? x : safeJson(x))).join(' '))
    }
  }
  app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') logger.error('app', `Процесс ${d.type} завершился: ${d.reason} (код ${d.exitCode})`) })
}
function safeJson(x: unknown): string {
  try { return JSON.stringify(x) } catch { return String(x) }
}
let lastBundle: LogBundle | null = null
const sysInfo = (): SystemInfo => ({
  version: app.getVersion(), electron: process.versions.electron, os: `Windows ${release()}`, arch: process.arch,
  setupMode: settings?.get().setupMode ?? 'не выбран', uptimeMin: Math.round((Date.now() - startedAt) / 60000)
})
function collectLogs(): LogBundle {
  if (!logger) throw new Error('Журнал недоступен')
  lastBundle = writeBundle(app.getPath('downloads'), bundleText(sysInfo(), hub.connections(), logger))
  logger.info('feedback', `Собран файл логов ${lastBundle.name}`)
  return lastBundle
}

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
let counters: Counters
let auction: Auction
let wheel: Wheel
let goal: Fundraiser
let giveaway: Giveaway
let analytics: Analytics
let profiles: Profiles
let kickAuth: KickAuth
let streamInfo: StreamInfo
let da: DonationAlertsConnector
let dp: DonatePayConnector
let dx: DonateXConnector
let boosty: BoostyConnector
let donations: DonationConnector[] = []

/** Свои аккаунты (каналы на площадках и бот Twitch) — не зрители. */
function ownAccounts(): string[] {
  const bot = twitch.state().bot?.name
  return [...chats.states().map((p) => p.account), bot].filter((x): x is string => !!x)
}

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
    counters: counters.list(),
    profile: profiles.state(),
    streamInfo: streamInfo.state(),
    kickAuth: kickAuth.state(),
    auction: auction.state(),
    wheel: wheel.state(),
    goal: goal.state(),
    giveaway: giveaway.state(),
    feedback: { email: FEEDBACK_EMAIL, crash: logger?.crash() ?? null },
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
  goal_stage: { platform: 'hub', type: 'system', user: 'Играю в хоррор', amount: 5000, currency: 'RUB', amountRub: 5000, text: 'Собрано 5 000 ₽ из 10 000 ₽', test: true },
  goal_done: { platform: 'hub', type: 'system', user: 'Новая камера', amount: 10000, currency: 'RUB', amountRub: 10000, text: 'Собрано 10 000 ₽ из 10 000 ₽', test: true },
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
  // Интерфейс упал — в журнал, плашка и перезагрузка (не больше трёх раз подряд).
  let reloads = 0
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return
    logger?.fatal('interface', new Error(`Интерфейс аварийно закрылся: ${d.reason} (код ${d.exitCode})`))
    if (reloads++ < 3) win?.webContents.reload()
  })
  win.on('session-end', () => logger?.close())
  win.webContents.on('unresponsive', () => logger?.warn('interface', 'Интерфейс не отвечает'))

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
  hub.on('log', (id: string, level: 'info' | 'warn' | 'error', text: string) => logger?.write(level, id, text))
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
  kickAuth = new KickAuth(hub, secrets, resourcesDir)
  kickAuth.onChange = pushUpdate
  streamInfo = new StreamInfo(store, settings, twitch, youtube, kickAuth)
  streamInfo.on('change', pushUpdate)
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
  counters = new Counters(store)
  counters.on('change', pushUpdate)
  setVarsSource(() => counters.vars())
  auction = new Auction(store, settings, hub)
  auction.on('change', pushUpdate)
  wheel = new Wheel(store, settings)
  wheel.on('change', pushUpdate)
  // Колесо крутили по лотам аукциона — победитель колеса становится победителем аукциона.
  wheel.on('winner', (it: { lotId?: string }) => { if (it.lotId) auction.setWinner(it.lotId) })
  goal = new Fundraiser(store, hub)
  goal.on('change', pushUpdate)
  giveaway = new Giveaway(store, settings, hub)
  giveaway.on('change', pushUpdate)
  // Розыгрыш: объявления в чат на всех площадках, где можно писать.
  const announce = (tpl: string, vars: Record<string, string>): void => {
    const cfg = settings.get().giveaway
    if (!cfg.announce || !tpl.trim()) return
    const text = tpl.replace(/\{(приз|слово|победители)\}/g, (_, k: string) => vars[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, 450)
    const targets = chats.states().filter((p) => p.canSend).map((p) => p.id)
    if (!targets.length) return
    chats.send(text, targets, 'broadcaster').catch((e: Error) => hub.log('hub', 'warn', `Розыгрыш: не удалось написать в чат — ${e.message}`))
  }
  giveaway.on('opened', (prize: string) => {
    const cfg = settings.get().giveaway
    announce(cfg.startText, { приз: prize || 'розыгрыш', слово: cfg.keyword, победители: '' })
  })
  giveaway.on('drawn', (list: GiveawayWinner[]) => {
    const cfg = settings.get().giveaway
    const st = giveaway.state()
    announce(cfg.winText, { приз: st.prize || 'розыгрыш', слово: cfg.keyword, победители: list.map((w) => w.user).join(', ') })
  })
  rules = new RuleEngine(hub, store, settings, templates, {
    play: (plan, e, force) => alerts.play(plan, e, force),
    obs: runObs,
    isLive: () => obs.state.streaming || !!twitch?.live || !!youtube?.live
  }, counters)
  rules.on('change', () => { syncHotkeys(); pushUpdate() })
  obs.onStream = (live) => rules.fireService(live ? 'stream_start' : 'stream_end')
  // Сбор средств: этап или цель достигнуты — повод для правил (алерт, звук, озвучка).
  goal.on('reached', (r: GoalReached) => {
    const rub = (n: number): string => `${Math.round(n).toLocaleString('ru-RU')} ₽`
    rules.fireGoal(r.kind === 'goal' ? 'goal_done' : 'goal_stage', r.name, r.collected, `Собрано ${rub(r.collected)} из ${rub(r.target)}`)
  })
  profiles = new Profiles(app.getPath('userData'), store, settings, rules, templates, counters)
  syncHotkeys()
  stats = new Stats(store, () => (obs.state.streaming ? obs.state.streamStartedAt : null))
  // Аналитика: эфир идёт, если OBS в эфире или площадка сообщает «в эфире»; свои аккаунты не считаются.
  analytics = new Analytics(store, settings, () => {
    const ps = chats.states()
    const viewers: Partial<Record<ChatPlatform, number>> = {}
    for (const p of ps) if (p.live && p.viewers !== null && (CHAT_PLATFORMS as readonly string[]).includes(p.id)) viewers[p.id as ChatPlatform] = p.viewers
    return {
      live: obs.state.streaming || ps.some((p) => p.live),
      startedAt: obs.state.streaming ? obs.state.streamStartedAt : null,
      viewers,
      own: ownAccounts()
    }
  })
  sounds = new SoundLibrary(app.getPath('userData'), store)
  hub.seed(store.recentEvents(100))
  hub.known = (id) => store.hasEvent(id)
  if (!secrets.available()) hub.log('hub', 'error', 'Шифрование Windows недоступно — токены сохранять нельзя')

  for (const ev of ['status', 'delete', 'pinned', 'log']) hub.on(ev, pushUpdate)
  hub.on('event', (e: HubEvent) => {
    // Сообщения чата на диск не пишем (приватность); события — с пометкой test, статистика тестовые не считает.
    if (e.type !== 'message') store.addEvent(e)
    // Для аналитики — только ник и +1 к счётчику, без текста (если включено в «Аналитике»).
    else analytics.onEvent(e)
    pushUpdate()
  })

  server = new OverlayServer(hub, store, settings, images, resourcesDir, app.getAppPath(), {
    send: (text) => chats.send(text, chats.states().filter((p) => p.canSend).map((p) => p.id), 'broadcaster'),
    pin: (id) => hub.togglePin(id),
    // Кнопки дока (OBS и второе устройство): те же действия, что в разделах приложения, — только этот список.
    dock: {
      'alerts.pause': (v) => alerts.setPaused(v === true),
      'alerts.skip': () => alerts.skip(),
      'alerts.stopAll': () => alerts.stopAll(),
      'alerts.remove': (id) => alerts.remove(str(id, 100)),
      test: (kind) => {
        const x = SAMPLES[String(kind)]
        if (x) hub.push(x)
      },
      'auction.timer': (op, sec) => auction.timer(str(op, 10), sec),
      'auction.accepting': (v) => auction.setAccepting(v === true),
      'auction.finish': () => { auction.finish() },
      'goal.accepting': (v) => goal.setAccepting(v === true),
      'goal.extend': (min) => goal.extend(min),
      'goal.add': (rub) => { goal.addHand(rub, 'из дока') },
      'giveaway.start': () => giveaway.start('', settings.get().giveaway.defaultMin),
      'giveaway.extend': (min) => giveaway.extend(min),
      'giveaway.close': () => giveaway.close(false),
      'giveaway.draw': () => giveaway.draw(settings.get().giveaway.winners),
      'giveaway.reroll': (key) => giveaway.reroll(str(key, 100)),
      'wheel.spin': () => { wheel.spin() },
      counter: (id, op) => counters.apply(str(id, 100), op === 'sub' ? 'sub' : 'add', 1)
    }
  }, { alerts, stats, sounds, media, tts, counters, auction, wheel, goal, giveaway, own: ownAccounts })
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
    server.rotate(which === 'remote' ? 'remote' : which === 'dock' ? 'dock' : 'overlay')
    pushUpdate()
  })
  handle('hub:copy', (text) => clipboard.writeText(str(text, 2000)))
  // ---------- Журнал и обратная связь ----------
  let uiErrors = 0
  setInterval(() => { uiErrors = 0 }, 60_000)
  handle('hub:logError', (text) => { if (++uiErrors <= 20) logger?.error('interface', str(text, 1500)) })
  handle('hub:crashDismiss', () => { logger?.dismissCrash(); pushUpdate() })
  handle('hub:feedbackCollect', () => collectLogs())
  handle('hub:feedbackShowFile', () => { if (lastBundle) shell.showItemInFolder(lastBundle.path) })
  handle('hub:feedbackOpenFile', () => { if (lastBundle) void shell.openPath(lastBundle.path) })
  handle('hub:openLogsFolder', () => { if (logger) void shell.openPath(logger.dir) })
  handle('hub:feedbackSend', async (form, via, withLogs) => {
    const f = sanitizeForm(form)
    if (!f.text) throw new Error('Напишите, что случилось или что предложить')
    // Логи старше 10 минут собираем заново, чтобы в файл попало свежее.
    const bundle = withLogs === true ? (lastBundle && Date.now() - lastBundle.createdAt < 600_000 ? lastBundle : collectLogs()) : null
    const urls = composeUrls(f, sysInfo(), bundle)
    await shell.openExternal(via === 'mailto' ? urls.mailto : urls.gmail)
    if (bundle) shell.showItemInFolder(bundle.path)
    logger?.info('feedback', `Открыто письмо (${via === 'mailto' ? 'почтовая программа' : 'Gmail'}, ${f.kind}${bundle ? ', с логами' : ''})`)
    return bundle
  })
  handle('hub:openExternal', (url) => {
    const u = str(url, 300)
    if (/^https:\/\/(dev\.twitch\.tv|www\.twitch\.tv|obsproject\.com|github\.com|console\.cloud\.google\.com|www\.donationalerts\.com|donatepay\.ru|donatex\.gg|boosty\.to)\//.test(u)) void shell.openExternal(u)
  })
  handle('hub:testEvent', (kind) => {
    const x = SAMPLES[String(kind)]
    if (x) hub.push(x)
  })
  // Ручной донат (наличные, перевод): как настоящий — лента, статистика, топы, правила; площадка «Вручную».
  handle('hub:manualDonation', (v) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const user = str(o.user, 64).trim()
    const amount = typeof o.amount === 'number' && Number.isFinite(o.amount) ? Math.round(o.amount * 100) / 100 : 0
    const currency = ['RUB', 'USD', 'EUR', 'UAH', 'KZT', 'BYN'].includes(o.currency as string) ? (o.currency as string) : 'RUB'
    const rubRaw = typeof o.amountRub === 'number' && Number.isFinite(o.amountRub) ? Math.round(o.amountRub * 100) / 100 : 0
    if (!user) throw new Error('Укажите имя')
    if (!(amount > 0) || amount > 10_000_000) throw new Error('Сумма должна быть больше нуля')
    hub.push({
      platform: 'hub', type: 'donation', user, amount, currency, manual: true,
      text: str(o.text, 500).trim() || undefined,
      amountRub: currency === 'RUB' ? amount : rubRaw > 0 && rubRaw <= 100_000_000 ? rubRaw : undefined
    })
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
  // ---------- Название и категория эфира ----------
  handle('hub:infoDraft', (v) => streamInfo.setDraft(v))
  handle('hub:infoApply', () => streamInfo.apply())
  handle('hub:infoSuggest', (q) => streamInfo.suggest(str(q, 100)))
  handle('hub:infoFromTwitch', () => streamInfo.loadFromTwitch())
  handle('hub:infoOpen', (p) => { if ((INFO_PLATFORMS as readonly unknown[]).includes(p)) return streamInfo.openManual(p as InfoPlatform) })
  handle('hub:kickLogin', () => kickAuth.login())
  handle('hub:kickCancel', () => kickAuth.cancelLogin())
  handle('hub:kickLogout', () => kickAuth.logout())
  // ---------- Профиль: сохранить в файл / загрузить ----------
  handle('hub:profileExport', async (withMedia) => {
    if (!win) return null
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const r = await dialog.showSaveDialog(win, {
      title: 'Сохранить профиль Crossember',
      defaultPath: join(app.getPath('documents'), `Crossember-профиль-${stamp}.crossember`),
      filters: [{ name: 'Профиль Crossember', extensions: ['crossember'] }]
    })
    if (r.canceled || !r.filePath) return null
    return profiles.exportTo(r.filePath, withMedia !== false)
  })
  handle('hub:profilePick', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: 'Загрузить профиль Crossember', properties: ['openFile'], filters: [{ name: 'Профиль Crossember', extensions: ['crossember'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    return profiles.inspect(r.filePaths[0])
  })
  handle('hub:profileApply', async (parts) => {
    await profiles.apply((Array.isArray(parts) ? parts : []).filter((p): p is ProfilePart => typeof p === 'string'))
    pushUpdate()
  })
  handle('hub:profileCancel', () => profiles.cancel())
  handle('hub:profileUndo', async () => {
    await profiles.undo()
    pushUpdate()
  })
  // ---------- Счётчики ----------
  handle('hub:counterPut', (c) => counters.put(c))
  handle('hub:counterRemove', (id) => {
    counters.remove(str(id, 100))
    rules.forgetCounter(String(id))
  })
  handle('hub:counterApply', (id, op, n) => {
    const v = typeof n === 'number' && Number.isFinite(n) ? Math.abs(Math.round(n)) : 1
    return counters.apply(str(id, 100), op === 'sub' ? 'sub' : op === 'set' ? 'set' : 'add', v)
  })
  // ---------- Аукцион ----------
  handle('hub:aucLotAdd', (name) => auction.addLot(str(name, 200)))
  handle('hub:aucLotRename', (id, name) => auction.renameLot(str(id, 100), str(name, 200)))
  handle('hub:aucLotApprove', (id) => auction.approveLot(str(id, 100)))
  handle('hub:aucLotRemove', (id) => auction.removeLot(str(id, 100)))
  handle('hub:aucLotMerge', (from, into) => auction.mergeLots(str(from, 100), str(into, 100)))
  handle('hub:aucLotAddSum', (id, n) => auction.addToLot(str(id, 100), n))
  handle('hub:aucBetAssign', (bet, lot) => auction.assignBet(str(bet, 100), str(lot, 100)))
  handle('hub:aucBetNewLot', (bet, name) => auction.betToNewLot(str(bet, 100), typeof name === 'string' ? str(name, 200) : undefined))
  handle('hub:aucBetReject', (bet) => auction.rejectBet(str(bet, 100)))
  handle('hub:aucBetReopen', (bet) => auction.reopenBet(str(bet, 100)))
  handle('hub:aucManualBet', (v) => auction.manualBet(v))
  handle('hub:aucTimer', (op, sec) => auction.timer(str(op, 10), sec))
  handle('hub:aucAccepting', (v) => auction.setAccepting(v === true))
  handle('hub:aucFinish', () => auction.finish())
  handle('hub:aucReset', (keepLots) => auction.reset(keepLots === true))
  handle('hub:aucClearArchive', () => auction.clearArchive())
  // ---------- Колесо ----------
  handle('hub:wheelSetItems', (list) => wheel.setItems(list))
  handle('hub:wheelLoadLots', () => wheel.loadLots(auction.state().lots))
  handle('hub:wheelSpin', () => { wheel.spin() })
  handle('hub:wheelRestart', () => wheel.restart())
  handle('hub:wheelClearHistory', () => wheel.clearHistory())
  // ---------- Сбор средств ----------
  handle('hub:goalStart', (v) => { goal.start(v) })
  handle('hub:goalEdit', (v) => goal.edit(v))
  handle('hub:goalFinish', () => goal.finish())
  handle('hub:goalAccepting', (v) => goal.setAccepting(v === true))
  handle('hub:goalDuration', (min) => goal.setDuration(min))
  handle('hub:goalExtend', (min) => goal.extend(min))
  handle('hub:goalAdd', (rub, note) => { goal.addHand(rub, typeof note === 'string' ? str(note, 300) : '') })
  handle('hub:goalToggleGift', (id) => goal.toggleGift(str(id, 100)))
  handle('hub:goalClearArchive', () => goal.clearArchive())
  // ---------- Розыгрыш ----------
  handle('hub:gwStart', (prize, min) => giveaway.start(typeof prize === 'string' ? str(prize, 200) : '', min))
  handle('hub:gwExtend', (min) => giveaway.extend(min))
  handle('hub:gwClose', () => giveaway.close(false))
  handle('hub:gwPrize', (prize) => giveaway.setPrize(str(prize, 200)))
  handle('hub:gwRemove', (key) => giveaway.removeEntry(str(key, 100)))
  handle('hub:gwFakes', (n) => giveaway.addFakes(n))
  handle('hub:gwDraw', (n) => giveaway.draw(n))
  handle('hub:gwReroll', (key) => giveaway.reroll(str(key, 100)))
  handle('hub:gwReset', () => giveaway.reset())
  handle('hub:gwClearArchive', () => giveaway.clearArchive())
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
  handle('hub:chatTest', () => server.testChat())
  // ---------- Аналитика (только локально) ----------
  handle('hub:analytics', (period) => analytics.report(isAnalyticsPeriod(period) ? period : 'month'))
  handle('hub:analyticsStream', (id) => analytics.stream(str(id, 100)))
  handle('hub:analyticsMerge', (refs) => analytics.merge(refs))
  handle('hub:analyticsUnmerge', (ref) => analytics.unmerge(ref))
  handle('hub:analyticsDismiss', (key) => analytics.dismiss(key))
  handle('hub:analyticsForget', (id) => analytics.forget(id))
  handle('hub:analyticsClear', () => analytics.clear())
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
/** Горячие клавиши правил: занимаются глобально (работают, даже когда в фокусе игра). */
const ruleKeys = new Map<string, string>()
let ruleKeysSig = ''
function syncHotkeys(): void {
  const want = rules.hotkeys()
  const sig = JSON.stringify(want)
  if (sig === ruleKeysSig) return
  ruleKeysSig = sig
  for (const accel of ruleKeys.keys()) globalShortcut.unregister(accel)
  ruleKeys.clear()
  const errors: Record<string, string> = {}
  const floatKey = FLOAT_HOTKEY.replace('CommandOrControl', 'Ctrl')
  for (const { id, accel } of want) {
    if (accel === floatKey) errors[id] = 'это сочетание занято плавающим чатом'
    else if (ruleKeys.has(accel)) errors[id] = 'это сочетание уже у другого правила'
    else if (globalShortcut.register(accel, () => rules.fireRule(id, 'hotkey'))) ruleKeys.set(accel, id)
    else errors[id] = 'это сочетание занято другой программой'
  }
  rules.setHotkeyErrors(errors)
}

// Выключение Windows — это нормальный выход, не «неожиданное закрытие».
app.on('ready', () => powerMonitor.on('shutdown', () => logger?.close()))

app.on('before-quit', () => {
  logger?.info('app', 'Выход')
  logger?.close()
  for (const accel of ruleKeys.keys()) globalShortcut.unregister(accel)
  rules?.dispose()
  auction?.stop()
  wheel?.stop()
  goal?.stop()
  giveaway?.stop()
  analytics?.stop()
  kickAuth?.cancelLogin()
  floatChat?.close()
  chats.stopAll()
  for (const d of donations) d.stop()
  alerts?.dispose()
  tts?.dispose()
  void obs?.stop()
  void server?.stop()
  store?.close()
})
