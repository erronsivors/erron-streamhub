import { useState } from 'react'
import type { SetupMode, Theme } from '../../../main/core/settings'
import { ThemePicker } from '../components'
import mark from '../assets/mark.svg'

/** Мастер первого запуска: режим 1/2 ПК и тема по умолчанию. Всё можно поменять позже в «Настройках». */
export function Wizard() {
  const [mode, setMode] = useState<SetupMode | null>(null)
  const [theme, setTheme] = useState<Theme>('general')

  const finish = (): void => {
    if (!mode) return
    void window.hub.setSettings({
      setupMode: mode,
      defaultTheme: theme,
      overlays: { alert: { theme }, chat: { theme }, chatH: { theme }, pinned: { theme } }
    })
  }

  return (
    <div className="modal-back">
      <div className="modal">
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          <img src={mark} alt="" />
          <div>
            <b>Crossember</b>
            <small>made by erron for friends</small>
          </div>
        </div>
        <h2>Добро пожаловать!</h2>
        <p className="muted">Два вопроса — и можно стримить. Ответы можно поменять в любой момент в «Настройках».</p>

        <h3>1. Сколько компьютеров у вас для стрима?</h3>
        <div className="grid g2" style={{ gap: 12 }}>
          <button className={`choice ${mode === 'one' ? 'on' : ''}`} onClick={() => setMode('one')}>
            <b>Один ПК</b>
            <span>Игра, OBS и Crossember на одном компьютере. Самый частый вариант.</span>
          </button>
          <button className={`choice ${mode === 'two' ? 'on' : ''}`} onClick={() => setMode('two')}>
            <b>Два ПК</b>
            <span>На одном играете, на другом OBS и трансляция. Crossember ставится на стрим-ПК рядом с OBS — там же общий чат всех площадок.</span>
          </button>
        </div>
        {mode === 'two' && (
          <div className="note" style={{ marginTop: 12 }}>
            Убедитесь, что Crossember установлен на <b>стрим-ПК (с OBS)</b>. Если захотите видеть чат ещё и на телефоне или игровом ПК — «Настройки → Чат на другом устройстве».
          </div>
        )}

        <h3>2. Стиль оверлеев по умолчанию</h3>
        <ThemePicker value={theme} onChange={setTheme} />
        <p className="small muted">«Общий» — нейтральный для любого канала. «У костра» — тёплый фирменный стиль ERRON. Для каждого оверлея можно выбрать свой.</p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn primary" disabled={!mode} onClick={finish}>Готово</button>
        </div>
      </div>
    </div>
  )
}
