import { BrowserWindow, globalShortcut, screen } from 'electron'
import type { Settings } from './settings'
import type { Hub } from './hub'

export const FLOAT_HOTKEY = 'CommandOrControl+Shift+C'

/**
 * Чат поверх игры: прозрачное окно поверх всех окон, клики проходят сквозь него в игру.
 *
 * Почему это безопасно для античитов: окно — обычное окно Windows, Crossember НЕ внедряется в процесс игры,
 * не перехватывает отрисовку и не читает память. Горячая клавиша — стандартная регистрация Windows
 * (RegisterHotKey), без перехвата клавиатуры. Работает с играми в режиме «оконный без рамки».
 */
export class FloatChat {
  private win: BrowserWindow | null = null
  private editing = false
  private saveTimer: NodeJS.Timeout | null = null
  onChange: () => void = () => undefined

  constructor(private settings: Settings, private hub: Hub, private url: () => string) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  get isEditing(): boolean {
    return this.editing
  }

  /** Привести окно в соответствие с настройками (включено/выключено). */
  apply(): void {
    const on = this.settings.get().float.enabled
    if (on && !this.isOpen) this.open()
    if (!on && this.isOpen) this.close()
    // Размер/положение поменяли в настройках — применить к окну.
    const b = this.settings.get().float.bounds
    if (on && this.isOpen && b) {
      const cur = this.win!.getBounds()
      if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) this.win!.setBounds(b)
    }
  }

  private open(): void {
    const s = this.settings.get().float
    const area = screen.getPrimaryDisplay().workArea
    const b = s.bounds ?? { width: 380, height: 520, x: area.x + area.width - 400, y: area.y + area.height - 560 }
    const win = new BrowserWindow({
      ...b,
      transparent: true,
      frame: false,
      resizable: false, // прозрачные окна в Windows не тянутся за край — размер задаётся в настройках
      movable: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      title: 'Crossember — чат поверх игры',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true)
    win.setIgnoreMouseEvents(true, { forward: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.once('ready-to-show', () => win.showInactive())
    const save = (): void => {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => {
        if (!win.isDestroyed()) this.settings.patch({ float: { bounds: win.getBounds() } })
      }, 400)
    }
    win.on('moved', save)
    win.on('closed', () => {
      this.win = null
      this.editing = false
      this.onChange()
    })
    void win.loadURL(this.url())
    this.win = win

    if (!globalShortcut.isRegistered(FLOAT_HOTKEY)) {
      const ok = globalShortcut.register(FLOAT_HOTKEY, () => this.toggleEdit())
      if (!ok) this.hub.log('hub', 'warn', `Горячая клавиша ${FLOAT_HOTKEY} занята другой программой — используйте кнопку «Настроить положение»`)
    }
    this.onChange()
  }

  close(): void {
    globalShortcut.unregister(FLOAT_HOTKEY)
    if (this.isOpen) this.win!.close()
    this.win = null
    this.editing = false
    this.onChange()
  }

  /** Режим настройки: окно ловит мышь, его можно двигать и растягивать. Повторный вызов — снова «сквозное». */
  toggleEdit(force?: boolean): void {
    if (!this.isOpen) return
    const win = this.win!
    this.editing = force ?? !this.editing
    win.setIgnoreMouseEvents(!this.editing, { forward: true })
    win.setFocusable(this.editing)
    if (this.editing) win.focus()
    // Статичная строка, без данных пользователя.
    void win.webContents.executeJavaScript(`document.body.classList.toggle('edit', ${this.editing ? 'true' : 'false'})`)
    this.onChange()
  }

  /** Вернуть окно в угол основного экрана (если уехало за пределы). */
  reset(): void {
    this.settings.patch({ float: { bounds: null } })
    if (this.isOpen) {
      this.close()
      this.open()
    }
  }
}
