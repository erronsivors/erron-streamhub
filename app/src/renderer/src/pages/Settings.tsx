import { useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import { Hint, NumberField, ThemePicker, Toggle } from '../components'
import type { FloatChatSettings } from '../../../main/core/settings'

export function Settings({ snap }: { snap: HubSnapshot }) {
  const s = snap.settings
  const lan = snap.server?.lan
  const [confirm, setConfirm] = useState<'overlay' | 'remote' | null>(null)
  const [copied, setCopied] = useState(false)

  return (
    <>
      <div className="head">
        <div>
          <h1>Настройки</h1>
          <p>Режим работы, тема, второй ПК, ключи доступа.</p>
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>Режим работы <Hint id="mode" /></h3>
          <div className="seg">
            <button className={s.setupMode === 'one' ? 'on' : ''} onClick={() => void window.hub.setSettings({ setupMode: 'one' })}>1 ПК</button>
            <button className={s.setupMode === 'two' ? 'on' : ''} onClick={() => void window.hub.setSettings({ setupMode: 'two' })}>2 ПК</button>
          </div>
          <p className="small muted">
            {s.setupMode === 'two'
              ? 'Crossember стоит на стрим-ПК рядом с OBS — там же открыт общий чат всех площадок.'
              : 'Игра, OBS и Crossember на одном компьютере.'}
          </p>
          <h3 style={{ marginTop: 18 }}>Тема по умолчанию <Hint id="theme" /></h3>
          <ThemePicker value={s.defaultTheme} onChange={(t) => void window.hub.setSettings({ defaultTheme: t })} />
          <p className="small muted">Применяется к новым оверлеям. У каждого оверлея своя тема — в разделе «Оверлеи».</p>
          <button className="btn sm" onClick={() => void window.hub.setSettings({ overlays: { alert: { theme: s.defaultTheme }, chat: { theme: s.defaultTheme }, chatH: { theme: s.defaultTheme }, pinned: { theme: s.defaultTheme } } })}>
            Применить ко всем оверлеям
          </button>
        </div>

        <FloatCard snap={snap} />

        {(
          <div className="card">
            <h3>Чат на другом устройстве <Hint id="lan" /></h3>
            <p className="small muted" style={{ marginTop: -6 }}>Телефон, планшет или второй ПК в той же домашней сети: чат и события в обычном браузере.</p>
            <div className="field">
              <label>Адрес этого ПК в домашней сети</label>
              <select className="input" value={s.lan.host} onChange={(e) => void window.hub.setSettings({ lan: { host: e.target.value } })}>
                <option value="">— выберите —</option>
                {(lan?.addresses ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {lan && lan.addresses.length === 0 && <span className="small muted">Не найдено подключений к домашней сети.</span>}
            </div>
            <NumberField label="Порт" value={s.lan.port} min={1024} max={65535} onChange={(v) => void window.hub.setSettings({ lan: { port: v } })} />
            <Toggle on={s.lan.enabled} onChange={(v) => void window.hub.setSettings({ lan: { enabled: v } })} label="Открыть чат для другого устройства" />
            {lan?.error && <div className="note warnbox" style={{ marginTop: 10 }}>{lan.error}</div>}
            {lan?.running && lan.url && (
              <div style={{ marginTop: 12 }}>
                <div className="url">
                  <code>{lan.url.replace(/k=.+$/, 'k=••••••')}</code>
                  <button className="btn sm" onClick={() => { void window.hub.copy(lan.url!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Скопировано ✓' : 'Скопировать'}</button>
                </div>
                <p className="small muted">Откройте ссылку в браузере на телефоне, планшете или втором ПК (можно отправить себе в «Избранное» мессенджера). Если не открывается — проверьте, что Windows разрешила доступ для частной сети.</p>
                <KeyRotate label="Перевыпустить ключ ссылки" confirm={confirm === 'remote'} onAsk={() => setConfirm('remote')} onCancel={() => setConfirm(null)} onYes={() => { void window.hub.rotateKey('remote'); setConfirm(null) }} />
              </div>
            )}
          </div>
        )}

        <div className="card">
          <h3>Сервер оверлеев</h3>
          <div className="kv">
            <div><span>Адрес</span><b className="mono" style={{ fontSize: 15 }}>127.0.0.1</b></div>
            <div><span>Порт</span><b className="mono" style={{ fontSize: 15 }}>{snap.server?.port ?? '—'}</b></div>
          </div>
          <p className="small muted">Слушает только этот компьютер — из сети и интернета недоступен.</p>
          <h3 style={{ marginTop: 18 }}>Ключ оверлеев <Hint id="overlayKey" /></h3>
          <KeyRotate label="Перевыпустить ключ оверлеев" confirm={confirm === 'overlay'} onAsk={() => setConfirm('overlay')} onCancel={() => setConfirm(null)} onYes={() => { void window.hub.rotateKey('overlay'); setConfirm(null) }} />
        </div>

        <div className="card">
          <h3>Безопасность</h3>
          <div className="list small">
            <div className="row">🔒 Токены и пароли шифруются Windows (DPAPI), открытым текстом не хранятся</div>
            <div className="row">🛰 Никакой телеметрии и чужих серверов — площадки подключаются напрямую</div>
            <div className="row">🧱 Интерфейс изолирован: без доступа к системе, без переходов и новых окон</div>
            <div className="row">🧾 Текст из чата выводится только как текст — защита от внедрения кода</div>
            <div className="row">💬 Сообщения чата на диск не сохраняются</div>
          </div>
        </div>
      </div>
    </>
  )
}

function KeyRotate({ label, confirm, onAsk, onCancel, onYes }: { label: string; confirm: boolean; onAsk: () => void; onCancel: () => void; onYes: () => void }) {
  if (!confirm) return <button className="btn sm" onClick={onAsk}>{label}</button>
  return (
    <div>
      <p className="small muted">Старые ссылки перестанут работать — их нужно будет вставить заново.</p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn primary sm" onClick={onYes}>Да, перевыпустить</button>
        <button className="btn sm" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  )
}

function FloatCard({ snap }: { snap: HubSnapshot }) {
  const f = snap.settings.float
  const set = (p: Partial<FloatChatSettings>): void => void window.hub.setSettings({ float: p })
  const b = f.bounds ?? { x: 0, y: 0, width: 380, height: 520 }
  return (
    <div className="card">
      <h3>Чат поверх игры <Hint id="float" /></h3>
      <p className="small muted" style={{ marginTop: -6 }}>Прозрачное окно с чатом поверх всех окон. Клики проходят сквозь него в игру.</p>
      <Toggle on={f.enabled} onChange={(v) => set({ enabled: v })} label="Показывать чат поверх игры" />
      {f.enabled && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '6px 0 12px' }}>
            <button className={snap.float.editing ? 'btn sm primary' : 'btn sm'} onClick={() => void window.hub.floatEdit()}>
              {snap.float.editing ? 'Готово — закрепить' : 'Настроить положение'}
            </button>
            <button className="btn sm" onClick={() => void window.hub.floatReset()}>Вернуть в угол экрана</button>
          </div>
          <p className="small muted">Горячая клавиша: <b className="mono">{snap.float.hotkey}</b> — включить/выключить режим перетаскивания прямо в игре.</p>
          <div className="field">
            <label>Тема</label>
            <ThemePicker value={f.theme} onChange={(t) => set({ theme: t })} />
          </div>
          <div className="grid g3" style={{ gap: 10 }}>
            <NumberField label="Шрифт" value={f.fontSize} min={10} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
            <NumberField label="Сообщений" value={f.maxMessages} min={1} max={100} onChange={(v) => set({ maxMessages: v })} />
            <NumberField label="Скрывать через" value={f.hideAfterSec} min={0} max={3600} suffix="сек" onChange={(v) => set({ hideAfterSec: v })} />
            <NumberField label="Подложка" value={f.bgOpacity} min={0} max={100} suffix="%" onChange={(v) => set({ bgOpacity: v })} />
            <NumberField label="Ширина" value={b.width} min={200} max={4000} suffix="px" onChange={(v) => set({ bounds: { ...b, width: v } })} />
            <NumberField label="Высота" value={b.height} min={120} max={4000} suffix="px" onChange={(v) => set({ bounds: { ...b, height: v } })} />
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <Toggle on={f.showBadges} onChange={(v) => set({ showBadges: v })} label="Бейджи" />
            <Toggle on={f.showPlatform} onChange={(v) => set({ showPlatform: v })} label="Значок площадки" />
            <Toggle on={f.showStatus} onChange={(v) => set({ showStatus: v })} label="Строки о сбоях" />
          </div>
        </>
      )}
    </div>
  )
}
