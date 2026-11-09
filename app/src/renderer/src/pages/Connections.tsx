import { useState } from 'react'
import type { ConnStatus, HubSnapshot, Platform } from '../../../main/core/types'
import { PlatIcon, fmtTime } from '../ui'

const STATE_LABEL: Record<ConnStatus['state'], string> = { off: 'Не настроено', connecting: 'Подключение…', ok: 'Подключено', error: 'Ошибка' }
const STAGE: Partial<Record<Platform, string>> = {
  twitch: 'этап 1', youtube: 'этап 2', vk: 'этап 2', kick: 'этап 2',
  donationalerts: 'этап 3', donatepay: 'этап 3', donatex: 'этап 3', boosty: 'этап 3'
}

export function Connections({ snap }: { snap: HubSnapshot }) {
  const [sel, setSel] = useState<Platform>('obs')
  const cur = snap.connections.find((c) => c.id === sel) ?? snap.connections[0]
  const active = snap.connections.filter((c) => c.state === 'ok').length

  return (
    <>
      <div className="head">
        <div>
          <h1>Все площадки. Одно приложение.</h1>
          <p>Прямые подключения без посредников. Здесь же видно, что именно отвалилось и почему.</p>
        </div>
        <div className="actions small muted"><span className="dot ok" /> {active} активно</div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
        <div className="grid g2" style={{ alignContent: 'start' }}>
          {snap.connections.map((c) => (
            <div key={c.id} className={`card conn ${sel === c.id ? 'sel' : ''}`} onClick={() => setSel(c.id)}>
              <div className="top">
                <PlatIcon p={c.id} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="name">{c.name}</div>
                  <div className="small muted ellipsis">{c.state === 'off' && STAGE[c.id] ? `Появится: ${STAGE[c.id]}` : c.detail}</div>
                </div>
                <span className={`dot ${c.state}`} />
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>{STATE_LABEL[c.state]}</div>
            </div>
          ))}
        </div>

        <div className="card" style={{ alignSelf: 'start', position: 'sticky', top: 0 }}>
          <h3><PlatIcon p={cur.id} /> {cur.name} <span className={`r dot ${cur.state}`} /></h3>
          <p className="muted" style={{ marginTop: 0 }}>{STATE_LABEL[cur.state]} · {cur.detail}</p>
          {cur.id === 'obs' && <ObsForm snap={snap} />}
          {cur.state === 'off' && cur.id !== 'obs' && cur.id !== 'hub' && (
            <div className="note">Подключение появится на {STAGE[cur.id]}. Вход — напрямую через ваше собственное приложение на площадке; токены шифруются Windows и не покидают ПК.</div>
          )}
          <h3 style={{ marginTop: 20 }}>Журнал</h3>
          <div className="log">
            {cur.log.length ? cur.log.map((l, i) => (
              <div key={i} className={l.level}><time>{fmtTime(l.ts)}</time>{l.text}</div>
            )) : <div className="muted">Пусто</div>}
          </div>
        </div>
      </div>
    </>
  )
}

function ObsForm({ snap }: { snap: HubSnapshot }) {
  const [url, setUrl] = useState(snap.obsConfig.url)
  const [pass, setPass] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (clear = false): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await window.hub.obsConfigure(url, clear ? '' : pass || undefined)
      setPass('')
      setMsg(clear ? 'Пароль удалён' : 'Сохранено')
    } catch (e) {
      setMsg((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="field">
        <label>Адрес obs-websocket</label>
        <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </div>
      <div className="field">
        <label>Пароль {snap.obsConfig.hasPassword ? '(сохранён, зашифрован — введите новый, чтобы заменить)' : ''}</label>
        <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={snap.obsConfig.hasPassword ? '••••••••' : 'OBS → Инструменты → Настройки WebSocket-сервера'} />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn primary sm" disabled={busy} onClick={() => void save()}>Сохранить и подключить</button>
        <button className="btn sm" disabled={busy} onClick={() => void window.hub.obsReconnect()}>Переподключить</button>
        {snap.obsConfig.hasPassword && <button className="btn sm" disabled={busy} onClick={() => void save(true)}>Удалить пароль</button>}
      </div>
      {msg && <p className="small muted">{msg}</p>}
    </div>
  )
}
