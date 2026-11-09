import { useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import { Hint, NumberField, ThemePicker, Toggle } from '../components'

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
              ? 'Crossember стоит на ПК с OBS. Чат и события на игровом ПК — в браузере (блок «Второй ПК»).'
              : 'Игра, OBS и Crossember на одном компьютере.'}
          </p>
          <h3 style={{ marginTop: 18 }}>Тема по умолчанию <Hint id="theme" /></h3>
          <ThemePicker value={s.defaultTheme} onChange={(t) => void window.hub.setSettings({ defaultTheme: t })} />
          <p className="small muted">Применяется к новым оверлеям. У каждого оверлея своя тема — в разделе «Оверлеи».</p>
          <button className="btn sm" onClick={() => void window.hub.setSettings({ overlays: { alert: { theme: s.defaultTheme }, chat: { theme: s.defaultTheme }, chatH: { theme: s.defaultTheme }, pinned: { theme: s.defaultTheme } } })}>
            Применить ко всем оверлеям
          </button>
        </div>

        {s.setupMode === 'two' && (
          <div className="card">
            <h3>Второй ПК: чат в браузере <Hint id="lan" /></h3>
            <div className="field">
              <label>Адрес этого ПК в домашней сети</label>
              <select className="input" value={s.lan.host} onChange={(e) => void window.hub.setSettings({ lan: { host: e.target.value } })}>
                <option value="">— выберите —</option>
                {(lan?.addresses ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {lan && lan.addresses.length === 0 && <span className="small muted">Не найдено подключений к домашней сети.</span>}
            </div>
            <NumberField label="Порт" value={s.lan.port} min={1024} max={65535} onChange={(v) => void window.hub.setSettings({ lan: { port: v } })} />
            <Toggle on={s.lan.enabled} onChange={(v) => void window.hub.setSettings({ lan: { enabled: v } })} label="Открыть чат для второго ПК" />
            {lan?.error && <div className="note warnbox" style={{ marginTop: 10 }}>{lan.error}</div>}
            {lan?.running && lan.url && (
              <div style={{ marginTop: 12 }}>
                <div className="url">
                  <code>{lan.url.replace(/k=.+$/, 'k=••••••')}</code>
                  <button className="btn sm" onClick={() => { void window.hub.copy(lan.url!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Скопировано ✓' : 'Скопировать'}</button>
                </div>
                <p className="small muted">Откройте эту ссылку в браузере на игровом ПК (можно отправить себе в мессенджер). Если не открывается — проверьте, что Windows разрешила доступ для частной сети.</p>
                <KeyRotate label="Перевыпустить ключ второго ПК" confirm={confirm === 'remote'} onAsk={() => setConfirm('remote')} onCancel={() => setConfirm(null)} onYes={() => { void window.hub.rotateKey('remote'); setConfirm(null) }} />
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
