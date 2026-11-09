import { useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'

export function Overlays({ snap }: { snap: HubSnapshot }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (id: string, url: string): void => {
    void window.hub.copy(url)
    setCopied(id)
    setTimeout(() => setCopied(null), 1500)
  }
  return (
    <>
      <div className="head">
        <div>
          <h1>Оверлеи для OBS</h1>
          <p>Каждый оверлей — одна ссылка для источника «Браузер». Обновляется сам, перегенерировать файлы не нужно.</p>
        </div>
      </div>
      {!snap.server ? <div className="note warnbox">Сервер оверлеев не запущен — см. «Подключения».</div> : (
        <div className="grid g2">
          {snap.server.overlays.map((o) => (
            <div className="card" key={o.id}>
              <h3>{o.name} <span className="r chip">{o.size}</span></h3>
              <div className="url">
                <code title="Ссылка содержит ключ доступа — не показывайте её в эфире">{o.url.replace(/k=.+$/, 'k=••••••')}</code>
                <button className="btn sm" onClick={() => copy(o.id, o.url)}>{copied === o.id ? 'Скопировано ✓' : 'Скопировать'}</button>
              </div>
              <p className="small muted">OBS → Источники → + → Браузер → вставить ссылку, ширина и высота как указано. Проверка: «События» → тестовый донат.</p>
            </div>
          ))}
          <div className="card">
            <h3>Скоро</h3>
            <p className="muted" style={{ margin: 0 }}>Вертикальный и горизонтальный чат, закреплённое сообщение, топ донатеров, последние подписки, цели и сбор средств.</p>
          </div>
        </div>
      )}
      <div className="note" style={{ marginTop: 18 }}>
        🔒 В ссылке есть ключ доступа. Если она где-то засветилась — «Настройки» → «Перевыпустить ключ», старые ссылки перестанут работать.
      </div>
    </>
  )
}
