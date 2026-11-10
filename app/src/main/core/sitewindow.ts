import { BrowserWindow, session, shell, type Session } from 'electron'
import { UA } from './donations/common'

/** Кабинеты сервисов донатов, которые можно открыть прямо в Crossember. */
export type SiteId = 'donationalerts' | 'donatepay' | 'donatex' | 'boosty'

const SITES: Record<SiteId, { title: string; url: string; host: RegExp }> = {
  donationalerts: { title: 'DonationAlerts', url: 'https://www.donationalerts.com/dashboard', host: /(^|\.)donationalerts\.(com|ru)$/ },
  donatepay: { title: 'DonatePay', url: 'https://donatepay.ru/', host: /(^|\.)donatepay\.(ru|eu)$/ },
  donatex: { title: 'DonateX', url: 'https://donatex.gg/', host: /(^|\.)donatex\.gg$/ },
  boosty: { title: 'Boosty', url: 'https://boosty.to/', host: /(^|\.)boosty\.to$/ }
}

/** Сайты, через которые сервисы предлагают войти (Twitch, Google, VK…). Только для входа — всё остальное уходит в обычный браузер. */
const AUTH_HOSTS = /(^|\.)(twitch\.tv|google\.com|youtube\.com|gstatic\.com|kick\.com|facebook\.com|discord\.com|vk\.com|vk\.ru|vkontakte\.ru|tiktok\.com|telegram\.org|yandex\.ru|ya\.ru|mail\.ru|apple\.com|steamcommunity\.com|recaptcha\.net|hcaptcha\.com|cloudflare\.com)$/

export const isSiteId = (v: unknown): v is SiteId => typeof v === 'string' && v in SITES

const windows = new Map<SiteId, BrowserWindow>()
const prepared = new Set<SiteId>()

function allowed(id: SiteId, url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return u.protocol === 'about:'
    return SITES[id].host.test(u.hostname) || AUTH_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}

/**
 * Отдельная постоянная сессия для каждого сервиса: вход запоминается (cookie Chromium шифрует Windows),
 * а сайты не видят ни друг друга, ни данные Crossember. Разрешения (камера, уведомления…) и загрузки запрещены.
 */
export function siteSession(id: SiteId): Session {
  const ses = session.fromPartition(`persist:site-${id}`)
  if (!prepared.has(id)) {
    prepared.add(id)
    ses.setUserAgent(UA)
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.on('will-download', (e) => e.preventDefault())
  }
  return ses
}

function guard(id: SiteId, win: BrowserWindow): void {
  const wc = win.webContents
  // Новые окна: вход через Twitch/Google и т.п. — во всплывающем окне той же сессии; чужие ссылки — в обычный браузер.
  wc.setWindowOpenHandler(({ url }) => {
    if (allowed(id, url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: siteSession(id), sandbox: true, contextIsolation: true, nodeIntegration: false } } }
    }
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => guard(id, child))
  wc.on('will-navigate', (e, url) => {
    if (allowed(id, url)) return
    e.preventDefault()
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
  })
}

/** Открыть кабинет сервиса в окне Crossember (повторный вызов — показать уже открытое окно). */
export function openSite(id: SiteId): void {
  const open = windows.get(id)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    open.focus()
    return
  }
  const s = SITES[id]
  const win = new BrowserWindow({
    width: 1280, height: 860, title: `${s.title} — Crossember`, autoHideMenuBar: true, backgroundColor: '#0f0b0a',
    webPreferences: { session: siteSession(id), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  windows.set(id, win)
  win.on('closed', () => windows.delete(id))
  guard(id, win)
  void win.loadURL(s.url)
}

/** Выйти из кабинета: стереть cookie и данные сайта в его сессии. */
export async function clearSite(id: SiteId): Promise<void> {
  windows.get(id)?.close()
  await siteSession(id).clearStorageData()
}
