import { useEffect, useRef, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import { EventRow, useNow } from '../ui'
import { Hint, errText } from '../components'

const CURRENCIES: { id: string; label: string }[] = [
  { id: 'RUB', label: '₽ рубли' }, { id: 'USD', label: '$ доллары' }, { id: 'EUR', label: '€ евро' },
  { id: 'UAH', label: '₴ гривны' }, { id: 'KZT', label: '₸ тенге' }, { id: 'BYN', label: 'Br бел. рубли' }
]

/** Число из поля: «1 500,50» → 1500.5. */
const parseAmount = (s: string): number => Number(s.replace(/\s/g, '').replace(',', '.'))

/** Окно «Донат вручную»: наличные, перевод на карту — попадает в ленту, статистику, топы и правила. */
function ManualDonation({ onClose }: { onClose: () => void }) {
  const [user, setUser] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('RUB')
  const [rub, setRub] = useState('')
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    first.current?.focus()
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  const n = parseAmount(amount)
  const ok = user.trim().length > 0 && n > 0
  const save = async (): Promise<void> => {
    if (!ok || busy) return
    setBusy(true)
    setErr(null)
    try {
      const r = parseAmount(rub)
      await window.hub.manualDonation({ user: user.trim(), amount: n, currency, text: text.trim(), amountRub: currency !== 'RUB' && r > 0 ? r : undefined })
      onClose()
    } catch (e) {
      setErr(errText(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal narrow" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <h2>Донат вручную</h2>
        <p className="muted">Наличные, перевод на карту, подарок на стриме — запишется как обычный донат: в ленту, статистику и топ донатеров, сработают правила и алерты. В ленте будет пометка «вручную».</p>
        <div className="field" style={{ marginTop: 18 }}>
          <label>Кто задонатил</label>
          <input ref={first} className="input" value={user} maxLength={64} placeholder="Ник или имя" onChange={(e) => setUser(e.target.value)} />
        </div>
        <div className="grid g2" style={{ gap: 12 }}>
          <div className="field">
            <label>Сумма</label>
            <input className="input" inputMode="decimal" value={amount} placeholder="500" onChange={(e) => setAmount(e.target.value.replace(/[^\d\s.,]/g, ''))} />
          </div>
          <div className="field">
            <label>Валюта</label>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
        </div>
        {currency !== 'RUB' && (
          <div className="field">
            <label>Сколько это в рублях — для статистики и топа (можно оставить пустым)</label>
            <input className="input" inputMode="decimal" value={rub} placeholder="например, 4500" onChange={(e) => setRub(e.target.value.replace(/[^\d\s.,]/g, ''))} />
          </div>
        )}
        <div className="field">
          <label>Сообщение (необязательно)</label>
          <textarea className="input" rows={3} value={text} maxLength={500} placeholder="Что написал зритель — покажется в алерте и попадёт в озвучку" onChange={(e) => setText(e.target.value)} />
        </div>
        {err && <div className="note err">{err}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn primary" disabled={!ok || busy}>Добавить донат</button>
        </div>
      </form>
    </div>
  )
}

export function Events({ snap }: { snap: HubSnapshot }) {
  const now = useNow(15000)
  const [manual, setManual] = useState(false)
  const events = snap.events.filter((e) => e.type !== 'message')
  return (
    <>
      <div className="head">
        <div>
          <h1>События <Hint id="testEvents" /></h1>
          <p>Донаты, подписки, рейды и фолловы со всех площадок в одной ленте. Тестовые не идут в статистику.</p>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={() => setManual(true)}>＋ Донат вручную</button>
          <span className="sep-v" />
          <button className="btn sm" onClick={() => void window.hub.testEvent('follow')}>♥ Фоллоу</button>
          <button className="btn sm" onClick={() => void window.hub.testEvent('sub')}>★ Подписка</button>
          <button className="btn sm" onClick={() => void window.hub.testEvent('raid')}>↗ Рейд</button>
          <button className="btn primary sm" onClick={() => void window.hub.testEvent('donation')}>₽ Донат</button>
          <span className="small muted">Все виды тестов и очередь — в «Алертах»</span>
        </div>
      </div>
      <div className="card">
        {events.length ? <div className="list">{events.map((e) => <EventRow key={e.id} e={e} now={now} onReplay={e.type === 'system' ? undefined : () => void window.hub.alertReplay(e.id)} />)}</div>
          : <div className="empty">Пока пусто. Нажмите кнопку теста — событие появится здесь и в оверлее алертов.</div>}
      </div>
      {manual && <ManualDonation onClose={() => setManual(false)} />}
    </>
  )
}
