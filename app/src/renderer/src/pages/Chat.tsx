import { useEffect, useRef, useState } from 'react'
import type { HubEvent, HubSnapshot, MsgPart } from '../../../main/core/types'
import { Hint, errText } from '../components'
import { PLATFORM, fmtTime } from '../ui'

// Картинки смайлов и бейджей — только из локального кэша Crossember: /e/<hash>.
const LOCAL_IMG = /^\/e\/[0-9a-f]{32}$/
let BASE = ''
const src = (u: string): string | null => (LOCAL_IMG.test(u) && BASE ? BASE + u : null)

function Parts({ m }: { m: HubEvent }) {
  const parts: MsgPart[] = m.parts?.length ? m.parts : [{ t: 'text', v: m.text ?? '' }]
  return (
    <>
      {parts.map((p, i) =>
        p.t === 'emote' && src(p.url) ? <img key={i} className="emote" src={src(p.url)!} alt={p.v} title={p.v} /> : <span key={i}>{p.v}</span>
      )}
    </>
  )
}

export function Chat({ snap }: { snap: HubSnapshot }) {
  const [text, setText] = useState('')
  const [as, setAs] = useState<'broadcaster' | 'bot'>('broadcaster')
  const [err, setErr] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [confirmBan, setConfirmBan] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [frozen, setFrozen] = useState<HubEvent[] | null>(null)
  const { twitch } = snap
  BASE = snap.server?.baseUrl ?? ''

  // Новые сообщения сверху. «Пауза чтения» замораживает ленту, чтобы спокойно прочитать.
  const messages = paused && frozen ? frozen : snap.chat
  useEffect(() => {
    if (paused) setFrozen(snap.chat)
    else setFrozen(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(errText(e))
    }
  }

  const send = (): void => {
    const t = text.trim()
    if (!t) return
    void act(async () => {
      await window.hub.chatSend(t, as)
      setText('')
    })
  }

  const canWrite = !!twitch.broadcaster
  return (
    <>
      <div className="head">
        <div>
          <h1>Мультичат <Hint id="chat" /></h1>
          <p>Все площадки в одной ленте. Клик по 📌 — вывести сообщение в оверлей «Закреп».</p>
        </div>
        <div className="actions">
          <button className={`btn sm ${paused ? 'primary' : ''}`} onClick={() => setPaused(!paused)}>{paused ? '▶ Продолжить' : '⏸ Пауза чтения'}</button>
          <button className="btn sm" onClick={() => void window.hub.testEvent('message')}>Тестовое сообщение</button>
          {snap.pinned && <button className="btn sm" onClick={() => void window.hub.chatPin(null)}>Снять закреп</button>}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 300px' }}>
        <div className="card chatbox">
          <div className="chatlist" ref={listRef}>
            {messages.length === 0 && (
              <div className="empty">
                {twitch.broadcaster ? 'Сообщений пока нет. Напишите что-нибудь в чат канала.' : 'Подключите Twitch в разделе «Подключения» — сообщения появятся здесь.'}
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`cmsg ${snap.pinned?.id === m.id ? 'pinned' : ''}`}>
                <span className="ctime">{fmtTime(m.ts).slice(0, 5)}</span>
                <span className="cplat" style={{ background: PLATFORM[m.platform].color }} title={m.platform} />
                {m.badges?.map((b, i) => (src(b.url) ? <img key={i} className="cbadge" src={src(b.url)!} alt={b.title} title={b.title} /> : null))}
                <b style={{ color: m.color ?? 'var(--light)' }}>{m.user}</b>
                {m.test && <span className="tag test">ТЕСТ</span>}
                <span className="ctext"><Parts m={m} /></span>
                <span className="cact">
                  <button title="Вывести в оверлей «Закреп»" onClick={() => void window.hub.chatPin(m.id)}>📌</button>
                  <button title="Удалить сообщение" onClick={() => void act(() => window.hub.chatDelete(m.id))}>🗑</button>
                  {!m.test && <button title="Таймаут 10 минут" onClick={() => void act(() => window.hub.chatBan(m.id, 600))}>⏱</button>}
                  {!m.test && (confirmBan === m.id
                    ? <button className="danger" title="Подтвердить бан" onClick={() => { setConfirmBan(null); void act(() => window.hub.chatBan(m.id, 0)) }}>Бан?</button>
                    : <button title="Забанить" onClick={() => setConfirmBan(m.id)}>⛔</button>)}
                </span>
              </div>
            ))}
          </div>
          <div className="chatinput">
            <input
              className="input"
              maxLength={500}
              value={text}
              disabled={!canWrite}
              placeholder={canWrite ? 'Написать в чат Twitch…' : 'Подключите Twitch, чтобы писать в чат'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            {twitch.bot && (
              <select className="input" value={as} onChange={(e) => setAs(e.target.value as 'broadcaster' | 'bot')}>
                <option value="broadcaster">от {twitch.broadcaster?.name ?? 'стримера'}</option>
                <option value="bot">от бота {twitch.bot.name}</option>
              </select>
            )}
            <button className="btn primary sm" disabled={!canWrite} onClick={send}>Отправить</button>
          </div>
          {err && <p className="small" style={{ color: '#ff7a84', margin: '6px 4px 0' }}>{err}</p>}
        </div>

        <div className="card" style={{ alignSelf: 'start' }}>
          <h3>Эфир</h3>
          <div className="kv">
            <div><span>Twitch</span><b>{twitch.viewers ?? '—'}</b></div>
            <div><span>Сообщений</span><b>{snap.chat.length}</b></div>
          </div>
          <h3 style={{ marginTop: 18 }}>Закреп в OBS</h3>
          {snap.pinned ? (
            <p className="small" style={{ margin: 0 }}><b>{snap.pinned.user}:</b> {snap.pinned.text}</p>
          ) : <p className="small muted" style={{ margin: 0 }}>Ничего не закреплено</p>}
        </div>
      </div>
    </>
  )
}
