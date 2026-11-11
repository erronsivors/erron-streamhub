import { useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { LogBundle } from '../../../main/core/feedback'
import { Toggle } from '../components'

type Kind = 'bug' | 'idea' | 'other'
const KINDS: { id: Kind; name: string; ph: string }[] = [
  { id: 'bug', name: 'Ошибка', ph: 'Что делали, что ожидали и что произошло на самом деле. Если ошибка повторяется — как её вызвать.' },
  { id: 'idea', name: 'Предложение', ph: 'Чего не хватает или что сделать удобнее.' },
  { id: 'other', name: 'Другое', ph: 'Вопрос, отзыв — что угодно.' }
]

const kb = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`)

/** Обратная связь: письмо автору (Gmail или почтовая программа) и файл логов, который пользователь прикладывает сам. */
export function Feedback({ snap }: { snap: HubSnapshot }) {
  const crash = snap.feedback.crash
  const [kind, setKind] = useState<Kind>('bug')
  const [text, setText] = useState(crash ? `Ошибка: ${crash.text}\n\n` : '')
  const [contact, setContact] = useState('')
  const [withLogs, setWithLogs] = useState(true)
  const [bundle, setBundle] = useState<LogBundle | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async <T,>(p: Promise<T>, ok: (v: T) => void): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      ok(await p)
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setBusy(false)
    }
  }
  const pickKind = (k: Kind): void => {
    setKind(k)
    setWithLogs(k === 'bug')
  }
  const send = (via: 'gmail' | 'mailto'): void => void run(window.hub.feedbackSend({ kind, text, contact }, via, withLogs), (b) => {
    if (b) setBundle(b)
    setMsg({ ok: true, text: b
      ? `Письмо открыто${via === 'gmail' ? ' в браузере' : ''}. Перетащите в него файл «${b.name}» из открывшейся папки и нажмите «Отправить».`
      : `Письмо открыто${via === 'gmail' ? ' в браузере' : ''} — осталось нажать «Отправить».` })
  })

  return (
    <>
      <div className="head">
        <div>
          <h1>Обратная связь</h1>
          <p>Нашли ошибку или есть идея — напишите автору Crossember. Письмо уходит с вашей почты, Crossember сам ничего никуда не отправляет.</p>
        </div>
      </div>

      <div className="grid g2 feedback">
        <div className="card">
          <h3>Сообщение</h3>
          <div className="seg" style={{ marginBottom: 12 }}>
            {KINDS.map((k) => <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => pickKind(k.id)}>{k.name}</button>)}
          </div>
          <div className="field">
            <label>{kind === 'bug' ? 'Что случилось' : kind === 'idea' ? 'Что предложить' : 'Текст'}</label>
            <textarea className="input" rows={8} maxLength={4000} value={text} placeholder={KINDS.find((k) => k.id === kind)!.ph} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="field">
            <label>Как с вами связаться <span className="muted">(необязательно)</span></label>
            <input className="input" maxLength={200} value={contact} placeholder="Ник в Telegram или Discord" onChange={(e) => setContact(e.target.value)} />
          </div>
          <div className="btnrow" style={{ marginTop: 6 }}>
            <button className="btn primary" disabled={busy || !text.trim()} onClick={() => send('gmail')}>Написать в Gmail</button>
            <button className="btn" disabled={busy || !text.trim()} onClick={() => send('mailto')}>Почтовая программа</button>
          </div>
          {msg && <div className={`note ${msg.ok ? '' : 'warnbox'}`} style={{ marginTop: 12 }}>{msg.text}</div>}
          <p className="small muted" style={{ marginTop: 12 }}>
            Не открывается? Напишите на <b className="mono">{snap.feedback.email}</b>{' '}
            <button className="btn sm" onClick={() => { void window.hub.copy(snap.feedback.email); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Скопировано ✓' : 'Скопировать адрес'}</button>
          </p>
        </div>

        <div className="card">
          <h3>Логи</h3>
          <p className="small muted" style={{ marginTop: -6 }}>Журнал работы Crossember за последние дни — по нему автор поймёт, что сломалось. Он помогает разобрать ошибку, для предложений не нужен.</p>
          <Toggle on={withLogs} onChange={setWithLogs} label="Приложить логи к письму" />
          <div className="btnrow" style={{ marginTop: 10 }}>
            <button className="btn sm" disabled={busy} onClick={() => void run(window.hub.feedbackCollect(), (b) => setBundle(b))}>Собрать логи</button>
            <button className="btn sm" onClick={() => void window.hub.openLogsFolder()}>Папка журнала</button>
          </div>
          {bundle && (
            <div className="pchip" style={{ marginTop: 12 }}>
              <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}><b>{bundle.name}</b> · {kb(bundle.size)} · в «Загрузках»</span>
              <button className="btn sm" onClick={() => void window.hub.feedbackShowFile()}>Показать</button>
              <button className="btn sm" onClick={() => void window.hub.feedbackOpenFile()}>Открыть</button>
            </div>
          )}
          <div className="list small" style={{ marginTop: 14 }}>
            <div className="row">В логах есть: версия Crossember и Windows, состояние подключений, ошибки и предупреждения.</div>
            <div className="row">В логах нет: токенов, паролей, ключей ссылок, IP-адресов, почты, имени пользователя Windows и сообщений чата.</div>
            <div className="row">Перед отправкой файл можно открыть («Открыть») и проверить сами.</div>
          </div>
        </div>
      </div>
    </>
  )
}
