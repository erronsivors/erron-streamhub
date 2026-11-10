import { useState } from 'react'
import type { HubSnapshot, Platform } from '../../../main/core/types'
import type { DonationServiceState } from '../../../main/core/donations/common'
import { Hint, Toggle, errText } from '../components'

const DONATION_IDS = new Set<Platform>(['donationalerts', 'donatepay', 'donatex', 'boosty'])
export const isDonationService = (p: Platform): boolean => DONATION_IDS.has(p)

function useAction(): [string | null, (p: Promise<unknown>) => void, boolean] {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = (p: Promise<unknown>): void => {
    setErr(null)
    setBusy(true)
    p.catch((e) => setErr(errText(e))).finally(() => setBusy(false))
  }
  return [err, run, busy]
}

function Account({ st, label, onLogout }: { st: DonationServiceState; label: string; onLogout: () => void }) {
  return (
    <div className="row">
      <div className="grow">
        <b>{label}</b>
        <span className="small muted" style={{ display: 'block' }}>{st.account ?? 'Подключено'}{st.method === 'token' ? ' · по личному токену' : st.method === 'key' ? ' · по API-ключу' : ''}</span>
      </div>
      <button className="btn sm" onClick={onLogout}>Отключить</button>
    </div>
  )
}

const Err = ({ err }: { err: string | null }) => (err ? <p className="small" style={{ color: '#ff7a84' }}>{err}</p> : null)

export function DonationPanel({ id, snap }: { id: Platform; snap: HubSnapshot }) {
  const st = snap.donations.find((d) => d.id === id)
  if (!st) return null
  return (
    <>
      {id === 'donationalerts' && <DaPanel st={st} snap={snap} />}
      {id === 'donatepay' && <DpPanel st={st} />}
      {id === 'donatex' && <DxPanel st={st} snap={snap} />}
      {id === 'boosty' && <BoostyPanel st={st} snap={snap} />}
      <Cabinet id={id} />
    </>
  )
}

/** Кабинет сервиса в окне Crossember: виджеты, цели, модерация — без отдельного браузера. */
function Cabinet({ id }: { id: Platform }) {
  const [cleared, setCleared] = useState(false)
  return (
    <div className="row" style={{ marginTop: 14 }}>
      <div className="grow">
        <b>Кабинет на сайте <Hint id="cabinet" /></b>
        <span className="small muted" style={{ display: 'block' }}>Настройки сервиса прямо в Crossember. Вход запоминается.</span>
      </div>
      <button className="btn primary sm" onClick={() => void window.hub.openSite(id)}>Открыть кабинет</button>
      <button className="btn sm" style={{ marginLeft: 8 }} title="Забыть вход в кабинет на этом ПК" onClick={() => void window.hub.clearSite(id).then(() => { setCleared(true); setTimeout(() => setCleared(false), 2000) })}>{cleared ? 'Готово ✓' : 'Выйти'}</button>
    </div>
  )
}

function DaPanel({ st, snap }: { st: DonationServiceState; snap: HubSnapshot }) {
  const [err, run] = useAction()
  const [advanced, setAdvanced] = useState(false)
  const [clientId, setClientId] = useState(snap.settings.donationalerts.customClientId)
  return (
    <div>
      {!st.canLogin && <div className="note warnbox" style={{ marginBottom: 12 }}>В этой сборке ещё нет общего приложения DonationAlerts. Укажите ID своего приложения ниже («Для опытных») — инструкция в подсказке «!».</div>}
      {st.pending && (
        <div className="note" style={{ marginBottom: 12 }}>
          <b>Подтвердите вход в DonationAlerts</b>
          <p style={{ margin: '8px 0' }}>Страница DonationAlerts открылась в браузере. Войдите и нажмите «Разрешить».</p>
          <button className="btn sm" onClick={() => void window.hub.daCancel()}>Отмена</button>
        </div>
      )}
      {st.method ? <Account st={st} label="Аккаунт DonationAlerts" onLogout={() => void window.hub.donationLogout('donationalerts')} /> : (
        <div className="row">
          <div className="grow"><b>Аккаунт DonationAlerts</b><span className="small muted" style={{ display: 'block' }}>Не подключён · донаты придут мгновенно</span></div>
          <button className="btn primary sm" disabled={st.pending || !st.canLogin} onClick={() => run(window.hub.daLogin())}>Войти</button>
        </div>
      )}
      <p className="small muted">Подписки Boosty тоже можно получать через DonationAlerts <Hint id="boostyViaDa" /></p>
      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        {st.method && <button className="btn sm" onClick={() => void window.hub.reconnect('donationalerts')}>Переподключить</button>}
        <button className="btn sm" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Скрыть' : 'Для опытных'}</button>
      </div>
      {advanced && (
        <div className="field" style={{ marginTop: 12 }}>
          <label>ID своего приложения DonationAlerts <Hint id="daClientId" /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" style={{ flex: 1 }} value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="пусто — общее приложение Crossember" spellCheck={false} />
            <button className="btn sm" onClick={() => void window.hub.setSettings({ donationalerts: { customClientId: clientId } })}>Сохранить</button>
          </div>
          <span className="small muted">Адрес перенаправления в приложении DA: <code>http://127.0.0.1:47834/da/callback</code>. После смены ID нужно войти заново.</span>
        </div>
      )}
      <Err err={err} />
    </div>
  )
}

function DpPanel({ st }: { st: DonationServiceState }) {
  const [err, run, busy] = useAction()
  const [key, setKey] = useState('')
  return (
    <div>
      {st.method ? <Account st={st} label="Аккаунт DonatePay" onLogout={() => void window.hub.donationLogout('donatepay')} /> : (
        <div className="field">
          <label>API-ключ DonatePay <Hint id="donatepay" /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" style={{ flex: 1 }} type="password" value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="donatepay.ru → Настройки → API" spellCheck={false} />
            <button className="btn primary sm" disabled={busy || !key} onClick={() => run(window.hub.dpKey(key).then(() => setKey('')))}>{busy ? 'Проверяем…' : 'Подключить'}</button>
          </div>
          <span className="small muted">Ключ шифруется Windows и хранится только на этом ПК. Проверка займёт до 20 секунд — так требует DonatePay.</span>
        </div>
      )}
      <p className="small muted">Новые донаты проверяются раз в 20 секунд (ограничение DonatePay), поэтому алерт может появиться с небольшой задержкой.</p>
      {st.method && <button className="btn sm" onClick={() => void window.hub.reconnect('donatepay')}>Переподключить</button>}
      <Err err={err} />
    </div>
  )
}

function DxPanel({ st, snap }: { st: DonationServiceState; snap: HubSnapshot }) {
  const [err, run, busy] = useAction()
  const [token, setToken] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [clientId, setClientId] = useState(snap.settings.donatex.customClientId)
  return (
    <div>
      {st.pending && (
        <div className="note" style={{ marginBottom: 12 }}>
          <b>Подтвердите вход в DonateX</b>
          <p style={{ margin: '8px 0' }}>Страница DonateX открылась в браузере. Войдите и разрешите доступ.</p>
          <button className="btn sm" onClick={() => void window.hub.dxCancel()}>Отмена</button>
        </div>
      )}
      {st.method ? <Account st={st} label="Аккаунт DonateX" onLogout={() => void window.hub.donationLogout('donatex')} /> : (
        <>
          <div className="row">
            <div className="grow"><b>Войти через DonateX</b><span className="small muted" style={{ display: 'block' }}>{st.canLogin ? 'Достаточно войти в свой аккаунт DonateX' : 'Скоро: у Crossember пока нет приложения DonateX'}</span></div>
            <button className="btn primary sm" disabled={st.pending || !st.canLogin} onClick={() => run(window.hub.dxLogin())}>Войти</button>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>{st.canLogin ? 'Или' : 'Пока можно так:'} личный токен DonateX <Hint id="donatex" /></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input mono" style={{ flex: 1 }} type="password" value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="donatex.gg → Настройки → API и доступ" spellCheck={false} />
              <button className="btn sm" disabled={busy || !token} onClick={() => run(window.hub.dxToken(token).then(() => setToken('')))}>Подключить</button>
            </div>
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        {st.method && <button className="btn sm" onClick={() => void window.hub.reconnect('donatex')}>Переподключить</button>}
        <button className="btn sm" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Скрыть' : 'Для опытных'}</button>
      </div>
      {advanced && (
        <div className="field" style={{ marginTop: 12 }}>
          <label>client_id своего приложения DonateX</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" style={{ flex: 1 }} value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="пусто — общее приложение Crossember" spellCheck={false} />
            <button className="btn sm" onClick={() => void window.hub.setSettings({ donatex: { customClientId: clientId } })}>Сохранить</button>
          </div>
          <span className="small muted">Публичный клиент с PKCE. Адрес перенаправления: <code>http://127.0.0.1:47835/dx/callback</code>.</span>
        </div>
      )}
      <Err err={err} />
    </div>
  )
}

function BoostyPanel({ st, snap }: { st: DonationServiceState; snap: HubSnapshot }) {
  const [err, run] = useAction()
  return (
    <div>
      <div className="note" style={{ marginBottom: 12 }}>
        Самый надёжный способ получать подписки Boosty — через DonationAlerts <Hint id="boostyViaDa" />. Ниже — прямое подключение (неофициальное, только чтение).
      </div>
      {st.pending && (
        <div className="note" style={{ marginBottom: 12 }}>
          <b>Войдите в Boosty в открывшемся окне</b>
          <p style={{ margin: '8px 0' }}>Окно закроется само после входа. Пароль вводится на сайте Boosty — Crossember его не видит.</p>
          <button className="btn sm" onClick={() => void window.hub.boostyCancel()}>Отмена</button>
        </div>
      )}
      {st.method ? <Account st={st} label="Аккаунт Boosty" onLogout={() => void window.hub.donationLogout('boosty')} /> : (
        <div className="row">
          <div className="grow"><b>Аккаунт Boosty <Hint id="boosty" /></b><span className="small muted" style={{ display: 'block' }}>Не подключён</span></div>
          <button className="btn primary sm" disabled={st.pending} onClick={() => run(window.hub.boostyLogin())}>Войти</button>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Toggle on={snap.settings.boosty.poll} onChange={(v) => void window.hub.setSettings({ boosty: { poll: v } })}
          label={<>Получать события напрямую (раз в минуту) <Hint id="boostyPoll" /></>} />
      </div>
      {st.method && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => void window.hub.reconnect('boosty')}>Переподключить</button>}
      <Err err={err} />
    </div>
  )
}
