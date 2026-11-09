import { useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'

export function Settings({ snap }: { snap: HubSnapshot }) {
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <div className="head">
        <div>
          <h1>Настройки</h1>
          <p>Сервер оверлеев, ключи доступа и безопасность.</p>
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>Сервер оверлеев</h3>
          <div className="kv">
            <div><span>Адрес</span><b className="mono" style={{ fontSize: 15 }}>127.0.0.1</b></div>
            <div><span>Порт</span><b className="mono" style={{ fontSize: 15 }}>{snap.server?.port ?? '—'}</b></div>
          </div>
          <p className="small muted">Слушает только этот компьютер — из сети и интернета недоступен. Доступ с игрового ПК (пульт) появится отдельным переключателем.</p>
        </div>
        <div className="card">
          <h3>Ключ оверлеев</h3>
          <p className="muted" style={{ marginTop: 0 }}>Перевыпуск ключа отключит все текущие ссылки оверлеев — их нужно будет заново вставить в OBS.</p>
          {!confirm ? <button className="btn sm" onClick={() => setConfirm(true)}>Перевыпустить ключ</button> : (
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn primary sm" onClick={() => { void window.hub.rotateOverlayKey(); setConfirm(false) }}>Да, перевыпустить</button>
              <button className="btn sm" onClick={() => setConfirm(false)}>Отмена</button>
            </div>
          )}
        </div>
        <div className="card">
          <h3>Безопасность</h3>
          <div className="list small">
            <div className="row">🔒 Токены и пароли шифруются Windows (DPAPI), открытым текстом не хранятся</div>
            <div className="row">🛰 Никакой телеметрии и чужих серверов — площадки подключаются напрямую</div>
            <div className="row">🧱 Интерфейс изолирован: без доступа к Node, без навигации и новых окон</div>
            <div className="row">🧾 Текст из чата и донатов в оверлеях выводится только как текст (защита от внедрения кода)</div>
          </div>
        </div>
      </div>
    </>
  )
}
