import { useState } from 'react'
import type { ConnStatus, HubSnapshot, Platform } from '../../../main/core/types'
import { Hint, Toggle, errText } from '../components'
import { PlatIcon, fmtTime, useNow } from '../ui'

const STATE_LABEL: Record<ConnStatus['state'], string> = { off: 'Не подключено', connecting: 'Подключение…', ok: 'Подключено', error: 'Ошибка' }
const STAGE: Partial<Record<Platform, string>> = {
  youtube: 'этап 2', vk: 'этап 2',
  donationalerts: 'этап 3', donatepay: 'этап 3', donatex: 'этап 3', boosty: 'этап 3'
}
const HINT: Partial<Record<Platform, string>> = { obs: 'obs', twitch: 'twitch', goodgame: 'goodgame', kick: 'kick' }

export function Connections({ snap }: { snap: HubSnapshot }) {
  const [sel, setSel] = useState<Platform>('twitch')
  const cur = snap.connections.find((c) => c.id === sel) ?? snap.connections[0]
  const active = snap.connections.filter((c) => c.state === 'ok').length

  return (
    <>
      <div className="head">
        <div>
          <h1>Подключения</h1>
          <p>Прямые подключения без посредников. Здесь же видно, что отвалилось и почему.</p>
        </div>
        <div className="actions small muted"><span className="dot ok" /> {active} активно</div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)' }}>
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
            </div>
          ))}
        </div>

        <div className="card" style={{ alignSelf: 'start' }}>
          <h3><PlatIcon p={cur.id} /> {cur.name} {HINT[cur.id] && <Hint id={HINT[cur.id]!} />} <span className={`r dot ${cur.state}`} /></h3>
          <p className="muted" style={{ marginTop: 0 }}>{STATE_LABEL[cur.state]} · {cur.detail}</p>
          {cur.id === 'obs' && <ObsForm snap={snap} />}
          {cur.id === 'twitch' && <TwitchPanel snap={snap} />}
          {(cur.id === 'goodgame' || cur.id === 'kick') && <ChannelPanel key={cur.id} id={cur.id} snap={snap} />}
          {cur.state === 'off' && STAGE[cur.id] && (
            <div className="note">Подключение появится на {STAGE[cur.id]}. Вход — напрямую на площадке; токены шифруются Windows и не покидают ПК.</div>
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

function TwitchPanel({ snap }: { snap: HubSnapshot }) {
  const t = snap.twitch
  const s = snap.settings.twitch
  const now = useNow()
  const [err, setErr] = useState<string | null>(null)
  const [clientId, setClientId] = useState(s.customClientId)
  const [advanced, setAdvanced] = useState(false)

  const login = (role: 'broadcaster' | 'bot'): void => {
    setErr(null)
    window.hub.twitchLogin(role).catch((e) => setErr(errText(e)))
  }

  return (
    <div>
      {t.clientIdSource === 'none' && (
        <div className="note warnbox" style={{ marginBottom: 12 }}>
          В этой сборке ещё нет общего Client ID. Укажите свой ниже («Для опытных») — инструкция в подсказке «!».
        </div>
      )}

      {t.pending ? (
        <div className="note" style={{ marginBottom: 12 }}>
          <b>Подтвердите вход в Twitch{t.pending.role === 'bot' ? ' под аккаунтом бота' : ''}</b>
          <p style={{ margin: '8px 0' }}>Страница Twitch открылась в браузере. Если нет — откройте <b>twitch.tv/activate</b> и введите код:</p>
          <div className="code">{t.pending.userCode}</div>
          <p className="small muted">Осталось {Math.max(0, Math.round((t.pending.expiresAt - now) / 60000))} мин.</p>
          <button className="btn sm" onClick={() => void window.hub.twitchCancel()}>Отмена</button>
        </div>
      ) : null}

      <div className="row">
        <div className="grow">
          <b>Аккаунт канала</b>
          <span className="small muted" style={{ display: 'block' }}>{t.broadcaster ? `${t.broadcaster.name} · ${t.live ? `в эфире, зрителей: ${t.viewers ?? 0}` : 'не в эфире'}` : 'Не подключён'}</span>
        </div>
        {t.broadcaster
          ? <button className="btn sm" onClick={() => void window.hub.twitchLogout('broadcaster')}>Выйти</button>
          : <button className="btn primary sm" disabled={!!t.pending || t.clientIdSource === 'none'} onClick={() => login('broadcaster')}>Войти</button>}
      </div>

      <div className="row">
        <div className="grow">
          <b>Аккаунт-бот <Hint id="twitchBot" /></b>
          <span className="small muted" style={{ display: 'block' }}>{t.bot ? t.bot.name : 'Не обязателен'}</span>
        </div>
        {t.bot
          ? <button className="btn sm" onClick={() => void window.hub.twitchLogout('bot')}>Отключить</button>
          : <button className="btn sm" disabled={!!t.pending || !t.broadcaster} onClick={() => login('bot')}>Подключить бота</button>}
      </div>

      {t.bot && (
        <div className="field" style={{ marginTop: 12 }}>
          <label>Автоматические сообщения отправлять</label>
          <div className="seg">
            <button className={s.autoSendAs === 'broadcaster' ? 'on' : ''} onClick={() => void window.hub.setSettings({ twitch: { autoSendAs: 'broadcaster' } })}>от канала</button>
            <button className={s.autoSendAs === 'bot' ? 'on' : ''} onClick={() => void window.hub.setSettings({ twitch: { autoSendAs: 'bot' } })}>от бота</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Toggle on={s.thirdPartyEmotes} onChange={(v) => void window.hub.setSettings({ twitch: { thirdPartyEmotes: v } })}
          label={<>Смайлы 7TV, BTTV, FFZ {t.emotes.thirdParty > 0 && <span className="muted small">({t.emotes.thirdParty})</span>} <Hint id="emotes3p" /></>} />
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        {t.broadcaster && <button className="btn sm" onClick={() => void window.hub.twitchRestart()}>Переподключить</button>}
        <button className="btn sm" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Скрыть' : 'Для опытных'}</button>
      </div>

      {advanced && (
        <div className="field" style={{ marginTop: 12 }}>
          <label>Свой Client ID <Hint id="twitchClientId" /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" style={{ flex: 1 }} value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="пусто — общее приложение Crossember" spellCheck={false} />
            <button className="btn sm" onClick={() => void window.hub.setSettings({ twitch: { customClientId: clientId } })}>Сохранить</button>
          </div>
          <span className="small muted">Сейчас: {t.clientIdSource === 'custom' ? 'свой Client ID' : t.clientIdSource === 'shared' ? 'общее приложение Crossember' : 'не задан'}. После смены Client ID нужно войти заново.</span>
        </div>
      )}
      {err && <p className="small" style={{ color: '#ff7a84' }}>{err}</p>}
    </div>
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
      setMsg(errText(e))
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
        <label>Пароль {snap.obsConfig.hasPassword ? '(сохранён и зашифрован — введите новый, чтобы заменить)' : ''}</label>
        <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={snap.obsConfig.hasPassword ? '••••••••' : 'OBS → Инструменты → Настройки сервера WebSocket'} />
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

/** Площадки, которые читаются без входа: достаточно ника канала. */
function ChannelPanel({ id, snap }: { id: 'goodgame' | 'kick'; snap: HubSnapshot }) {
  const saved = snap.settings[id].channel
  const [nick, setNick] = useState(saved)
  const p = snap.platforms.find((x) => x.id === id)
  const site = id === 'goodgame' ? 'goodgame.ru/ник' : 'kick.com/ник'
  return (
    <div>
      <div className="field">
        <label>Ник канала (как в ссылке {site})</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ flex: 1 }} value={nick} onChange={(e) => setNick(e.target.value)} placeholder="например, erron" spellCheck={false} />
          <button className="btn primary sm" disabled={nick.trim() === saved} onClick={() => void window.hub.setSettings({ [id]: { channel: nick } })}>Сохранить</button>
          {saved && <button className="btn sm" onClick={() => { setNick(''); void window.hub.setSettings({ [id]: { channel: '' } }) }}>Отключить</button>}
        </div>
        <span className="small muted">Можно вставить ссылку на канал целиком — Crossember сам возьмёт ник.</span>
      </div>
      {p?.configured && <p className="small muted">{p.live ? 'В эфире · зрителей: ' + (p.viewers ?? 0) : 'Не в эфире'} · режим «только чтение»: писать в этот чат пока можно только на сайте площадки.</p>}
      {saved && <button className="btn sm" onClick={() => void window.hub.reconnect(id)}>Переподключить</button>}
    </div>
  )
}
