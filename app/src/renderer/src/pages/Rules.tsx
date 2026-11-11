import { useState, type ReactNode, type KeyboardEvent } from 'react'
import type { HubSnapshot, Platform } from '../../../main/core/types'
import type { Rule, RuleAction, TriggerType, TtsWhen } from '../../../main/core/rules'
import type { ObsAction } from '../../../main/core/templates'
import type { Counter, CounterOp } from '../../../main/core/counters'
import { Hint, Toggle, errText } from '../components'
import { PlatIcon, fmtTime } from '../ui'
import { ObsActionEditor, SoundSelect, VoiceSelect, previewSound, previewTts } from '../editors'

export const TRIGGERS: { id: TriggerType; label: string; ico: string; service?: boolean }[] = [
  { id: 'donation', label: 'Донат', ico: '₽' }, { id: 'sub', label: 'Подписка', ico: '★' }, { id: 'gift', label: 'Подарки', ico: '🎁' },
  { id: 'follow', label: 'Фоллоу', ico: '♥' }, { id: 'raid', label: 'Рейд', ico: '↗' }, { id: 'bits', label: 'Биты', ico: '◆' },
  { id: 'reward', label: 'Баллы', ico: '✦' }, { id: 'message', label: 'Сообщение в чате', ico: '💬' },
  { id: 'stream_start', label: 'Эфир начался', ico: '▶', service: true }, { id: 'stream_end', label: 'Эфир закончился', ico: '■', service: true },
  { id: 'timer', label: 'Каждые N минут', ico: '⏱', service: true }, { id: 'hotkey', label: 'Горячая клавиша', ico: '⌨', service: true }
]
const isService = (t: TriggerType): boolean => !!TRIGGERS.find((x) => x.id === t)?.service
const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'twitch', label: 'Twitch' }, { id: 'youtube', label: 'YouTube' }, { id: 'vk', label: 'VK' }, { id: 'kick', label: 'Kick' },
  { id: 'goodgame', label: 'GoodGame' }, { id: 'donationalerts', label: 'DonationAlerts' }, { id: 'donatepay', label: 'DonatePay' },
  { id: 'donatex', label: 'DonateX' }, { id: 'boosty', label: 'Boosty' }, { id: 'hub', label: 'Вручную' }
]
const ACTIONS: { type: RuleAction['type']; ico: string; title: string; desc: string }[] = [
  { type: 'alert', ico: '✦', title: 'Показать алерт', desc: 'Шаблон из раздела «Алерты»' },
  { type: 'tts', ico: '🗣', title: 'Озвучить', desc: 'Прочитать ник, сумму и сообщение' },
  { type: 'sound', ico: '♪', title: 'Звук', desc: 'Встроенный или свой файл' },
  { type: 'obs', ico: '◧', title: 'Действие в OBS', desc: 'Сцена, источник, фильтр, текст' },
  { type: 'counter', ico: '#', title: 'Счётчик', desc: 'Прибавить, отнять, установить' }
]
const COUNTER_OPS: { id: CounterOp; label: string }[] = [
  { id: 'add', label: 'Прибавить' }, { id: 'sub', label: 'Отнять' }, { id: 'set', label: 'Сделать равным' }, { id: 'amount', label: 'Прибавить сумму' }
]
/** Ключ из названия — как в ядре (counters.ts keyFrom). */
const keyFrom = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-zа-яё0-9_]/g, '').slice(0, 24)
const TTS_WHEN: { id: TtsWhen; label: string; short: string; hint: string }[] = [
  { id: 'with', label: 'Вместе с алертом', short: '', hint: 'Голос начинает почти сразу, пока алерт появляется.' },
  { id: 'afterIn', label: 'Когда алерт появится', short: 'после появления', hint: 'Сначала проходит анимация появления, потом голос.' },
  { id: 'delay', label: 'Через несколько секунд', short: 'с задержкой', hint: 'Своя пауза от начала алерта.' },
  { id: 'after', label: 'После алерта', short: 'после алерта', hint: 'Алерт отыгрывает полностью, озвучка звучит следом.' }
]
const RESULT: Record<string, string> = { done: 'выполнено', dry: 'проверка', cooldown: 'кулдаун', error: 'ошибка', test: 'тест' }
const AMOUNT_TYPES: TriggerType[] = ['donation', 'bits', 'raid', 'gift', 'sub']

const newRule = (): Rule => ({
  id: crypto.randomUUID(), name: '', enabled: true, types: ['donation'], platforms: [],
  filter: { minAmount: 0, maxAmount: 0, textContains: '', users: '', tests: 'any' }, cooldownSec: 0, cooldownPerUser: false, stop: false, actions: [],
  intervalMin: 15, onlyLive: true, hotkey: ''
})

/** Как подписать повод в строке правила: у таймера — интервал, у горячей клавиши — сочетание. */
function triggerLabel(r: Rule, t: TriggerType): string {
  if (t === 'timer') return `Каждые ${r.intervalMin} мин${r.onlyLive ? ' в эфире' : ''}`
  if (t === 'hotkey') return r.hotkey ? `Клавиша ${r.hotkey}` : 'Клавиша не задана'
  return TRIGGERS.find((y) => y.id === t)?.label ?? t
}

/** Сочетание из нажатия: Ctrl/Alt/Shift + буква, цифра, F1–F24, цифра доп. клавиатуры (формат Electron). */
function accelFrom(e: KeyboardEvent): string | null {
  const c = e.code
  let key: string | null = null
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3)
  else if (/^Digit[0-9]$/.test(c)) key = c.slice(5)
  else if (/^Numpad[0-9]$/.test(c)) key = 'num' + c.slice(6)
  else if (/^F([1-9]|1\d|2[0-4])$/.test(c)) key = c
  if (!key) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
  if (!mods.length && !key.startsWith('F')) return null
  return [...mods, key].join('+')
}

/** Поле записи горячей клавиши: нажмите сочетание — оно запишется. */
function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false)
  const [hint, setHint] = useState('')
  return (
    <span className="hotkey">
      <button type="button" className={`input mono hotkey-box ${rec ? 'rec' : ''}`}
        onFocus={() => { setRec(true); setHint('') }} onBlur={() => setRec(false)}
        onKeyDown={(e) => {
          if (e.key === 'Tab') return
          e.preventDefault()
          if (e.key === 'Escape') { (e.target as HTMLElement).blur(); return }
          if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return
          const a = accelFrom(e)
          if (a) { onChange(a); setHint(''); (e.target as HTMLElement).blur() } else setHint('Нужен Ctrl, Alt или Shift + буква или цифра (или F1–F24)')
        }}>
        {rec ? 'Нажмите сочетание…' : value || 'Нажмите, чтобы задать'}
      </button>
      {value && !rec && <button type="button" className="btn sm" title="Убрать сочетание" onClick={() => onChange('')}>✕</button>}
      {hint && <span className="small muted">{hint}</span>}
    </span>
  )
}

function newAction(type: RuleAction['type'], snap: HubSnapshot): RuleAction {
  if (type === 'alert') return { type, templateId: snap.templates[0]?.id ?? '' }
  if (type === 'tts') return { type, text: '{user} — {amount}. {message}', voice: '', rate: 0, volume: 100, when: 'with', delaySec: 2 }
  if (type === 'sound') return { type, sound: 'coin', volume: 80 }
  if (type === 'counter') return { type, counterId: snap.counters[0]?.id ?? '', op: 'add', value: 1 }
  const obs: ObsAction = { op: 'source', scene: '', source: '', filter: '', mode: 'show', media: 'restart', text: '', revertSec: 10 }
  return { type: 'obs', obs }
}

const unit = (r: Rule): string => r.types.length === 1 && r.types[0] === 'donation' ? ' ₽' : ''
const num = (n: number): string => n.toLocaleString('ru-RU')

function actionPill(a: RuleAction, snap: HubSnapshot): { ico: string; text: string } {
  if (a.type === 'alert') return { ico: '✦', text: `Алерт «${snap.templates.find((t) => t.id === a.templateId)?.name ?? 'не выбран'}»` }
  if (a.type === 'tts') {
    const w = TTS_WHEN.find((x) => x.id === a.when)
    return { ico: '🗣', text: a.when === 'delay' ? `Озвучка через ${a.delaySec} с` : w?.short ? `Озвучка ${w.short}` : 'Озвучка' }
  }
  if (a.type === 'sound') return { ico: '♪', text: 'Звук' }
  if (a.type === 'counter') {
    const c = snap.counters.find((x) => x.id === a.counterId)
    const how = a.op === 'add' ? `+${a.value}` : a.op === 'sub' ? `−${a.value}` : a.op === 'set' ? `= ${a.value}` : '+ сумма'
    return { ico: '#', text: `${c?.name ?? 'Счётчик не выбран'} ${how}` }
  }
  const o = a.obs
  const what = o.op === 'scene' ? `сцена «${o.scene || '?'}»` : o.op === 'filter' ? `фильтр «${o.filter || '?'}»` : o.op === 'text' ? `текст «${o.source || '?'}»` : `«${o.source || '?'}»`
  return { ico: '◧', text: `OBS: ${what}` }
}

/** Человеческое название, если пользователь его не задал. */
function autoName(r: Rule): string {
  const t = r.types.map((x) => TRIGGERS.find((y) => y.id === x)?.label).filter(Boolean).join(' / ') || 'Правило'
  return r.filter.minAmount && r.types.some((x) => !isService(x)) ? `${t} от ${num(r.filter.minAmount)}${unit(r)}` : t
}

export function OverlayWarning({ snap }: { snap: HubSnapshot }) {
  if (snap.alertOverlays > 0) return null
  return (
    <div className="note warnbox btnrow" style={{ marginBottom: 14 }}>
      <span style={{ flex: 1, minWidth: 240 }}>Оверлей «Алерты» сейчас нигде не открыт, поэтому алерты, звуки и озвучку некому показать. Добавьте его в OBS (раздел «Оверлеи») или откройте в браузере, чтобы проверить.</span>
      <button className="btn sm" onClick={() => void window.hub.openOverlay('alert')}>Открыть в браузере</button>
    </div>
  )
}

export function Rules({ snap }: { snap: HubSnapshot }) {
  const st = snap.rules
  const [editing, setEditing] = useState<Rule | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const wrap = (p: Promise<unknown>): void => { setErr(null); p.catch((e) => setErr(errText(e))) }
  const isNew = editing && !st.rules.some((r) => r.id === editing.id)

  return (
    <>
      <div className="head">
        <div>
          <h1>Правила <Hint id="rules" /></h1>
          <p>Что делать, когда на стриме что-то происходит. Правила проверяются сверху вниз.</p>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={() => wrap(window.hub.rulesFlags({ enabled: !st.enabled }))}>
            {st.enabled ? '■ Остановить все' : '▶ Включить все'}
          </button>
          <button className="btn sm primary" disabled={!!isNew} onClick={() => setEditing(newRule())}>+ Новое правило</button>
        </div>
      </div>
      <OverlayWarning snap={snap} />
      {!st.enabled && <div className="note warnbox" style={{ marginBottom: 14 }}>Все правила остановлены: события идут только в ленту.</div>}
      {st.dryRun && <div className="note" style={{ marginBottom: 14 }}>Режим проверки: в журнал пишется, что сработало бы, но ничего не выполняется.</div>}
      {err && <div className="note warnbox" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="rules-layout">
        <div className="rules">
          {isNew && <RuleEditor key={editing.id} rule={editing} snap={snap} onClose={() => setEditing(null)} />}
          {st.rules.map((r, i) => editing?.id === r.id
            ? <RuleEditor key={r.id} rule={editing} snap={snap} onClose={() => setEditing(null)} />
            : <RuleRow key={r.id} r={r} snap={snap} first={i === 0} last={i === st.rules.length - 1} wrap={wrap} onEdit={() => setEditing(structuredClone(r))} />)}
          {!st.rules.length && !editing && <div className="card"><p className="muted">Правил пока нет. Нажмите «+ Новое правило».</p></div>}
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <CountersCard snap={snap} />
          <div className="card">
            <h3>Журнал <button className="btn sm r" disabled={!st.log.length} onClick={() => wrap(window.hub.rulesClearLog())}>Очистить</button></h3>
            <Toggle on={st.dryRun} onChange={(v) => wrap(window.hub.rulesFlags({ dryRun: v }))} label={<>Проверять без выполнения <Hint id="dryRun" /></>} />
            {st.log.length ? <div className="list" style={{ marginTop: 8 }}>{st.log.map((l, i) => (
              <div key={i} className="row">
                <PlatIcon p={l.platform} />
                <div className="grow">
                  <b className="ellipsis">{l.ruleName} <span className={`tag ${l.result === 'cooldown' || l.result === 'error' ? 'warn' : l.result === 'test' || l.result === 'dry' ? 'test' : ''}`}>{RESULT[l.result]}</span></b>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>{l.user} · {l.detail}</span>
                </div>
                <span className="small muted">{fmtTime(l.ts)}</span>
              </div>
            ))}</div> : <p className="small muted">Здесь появится, какое правило на что сработало.</p>}
          </div>
        </div>
      </div>
    </>
  )
}

function RuleRow({ r, snap, first, last, wrap, onEdit }: { r: Rule; snap: HubSnapshot; first: boolean; last: boolean; wrap: (p: Promise<unknown>) => void; onEdit: () => void }) {
  const f = r.filter
  const conds: string[] = []
  const keyErr = snap.rules.hotkeyErrors[r.id]
  if (f.minAmount && f.maxAmount) conds.push(`${num(f.minAmount)}–${num(f.maxAmount)}${unit(r)}`)
  else if (f.minAmount) conds.push(`от ${num(f.minAmount)}${unit(r)}`)
  else if (f.maxAmount) conds.push(`до ${num(f.maxAmount)}${unit(r)}`)
  if (f.textContains) conds.push(`текст: ${f.textContains}`)
  if (f.users) conds.push(`ники: ${f.users}`)
  if (r.platforms.length) conds.push(r.platforms.map((p) => PLATFORMS.find((x) => x.id === p)?.label).join(', '))
  return (
    <div className={`rule ${r.enabled ? '' : 'off'}`}>
      <div className="rule-move">
        <button title="Выше" disabled={first} onClick={() => wrap(window.hub.ruleMove(r.id, -1))}>▲</button>
        <button title="Ниже" disabled={last} onClick={() => wrap(window.hub.ruleMove(r.id, 1))}>▼</button>
      </div>
      <Toggle on={r.enabled} onChange={(v) => wrap(window.hub.rulePut({ ...r, enabled: v }))} label="" />
      <div className="rule-body" onClick={onEdit}>
        <div className="rule-name">{r.name}</div>
        <div className="rule-flow">
          <span className="lbl">Когда</span>
          {r.types.length ? r.types.map((t) => { const x = TRIGGERS.find((y) => y.id === t)!; return <span key={t} className="pill"><i>{x.ico}</i>{triggerLabel(r, t)}</span> }) : <span className="pill dim">ничего не выбрано</span>}
          {conds.map((c) => <span key={c} className="pill dim">{c}</span>)}
          <span className="arrow">→</span>
          {r.actions.length ? r.actions.map((a, i) => { const p = actionPill(a, snap); return <span key={i} className={`pill act a-${a.type}`}><i>{p.ico}</i>{p.text}</span> }) : <span className="pill dim">нет действий</span>}
        </div>
        {keyErr && r.enabled && <div className="rule-meta warn">Горячая клавиша не работает: {keyErr}</div>}
        {(r.cooldownSec > 0 || r.stop) && <div className="rule-meta">{r.cooldownSec > 0 && `кулдаун ${r.cooldownSec} с${r.cooldownPerUser ? ' на зрителя' : ''}`}{r.cooldownSec > 0 && r.stop && ' · '}{r.stop && 'правила ниже не проверяются'}</div>}
      </div>
      <div className="rule-tools">
        <button className="btn sm" title="Выполнить действия на тестовом событии" onClick={() => wrap(window.hub.ruleTest(r.id, r.types[0] ?? 'donation'))}>Тест</button>
        <button className="btn sm" onClick={onEdit}>Изменить</button>
      </div>
    </div>
  )
}

function Step({ n, title, hint, children, aside }: { n: number; title: string; hint?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="step">
      <div className="step-n">{n}</div>
      <div className="step-body">
        <div className="step-title">{title} {hint && <Hint id={hint} />}{aside && <span className="step-aside">{aside}</span>}</div>
        {children}
      </div>
    </div>
  )
}

function NumIn({ value, onChange, min = 0, max = 10_000_000, width }: { value: number; onChange: (n: number) => void; min?: number; max?: number; width?: number }) {
  return (
    <input className="input mono" style={{ width: width ?? '100%' }} type="number" min={min} max={max} defaultValue={value} key={value}
      onBlur={(e) => { const n = Math.min(max, Math.max(min, Math.round(Number(e.target.value) || 0))); if (n !== value) onChange(n) }} />
  )
}

function RuleEditor({ rule, snap, onClose }: { rule: Rule; snap: HubSnapshot; onClose: () => void }) {
  const [r, setR] = useState<Rule>(rule)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [showText, setShowText] = useState(!!rule.filter.textContains)
  const [showUsers, setShowUsers] = useState(!!rule.filter.users)
  const [showPlat, setShowPlat] = useState(rule.platforms.length > 0)
  const exists = snap.rules.rules.some((x) => x.id === rule.id)
  const dirty = JSON.stringify(r) !== JSON.stringify(rule)
  const set = (p: Partial<Rule>): void => setR({ ...r, ...p })
  const setF = (p: Partial<Rule['filter']>): void => setR({ ...r, filter: { ...r.filter, ...p } })
  const setA = (i: number, a: RuleAction): void => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? a : x)) })
  const hasAmount = r.types.some((t) => AMOUNT_TYPES.includes(t))
  const hasViewer = r.types.some((t) => !isService(t))
  const keyErr = exists && dirty === false ? snap.rules.hotkeyErrors[r.id] : undefined
  const toggleType = (t: TriggerType): void => set({ types: r.types.includes(t) ? r.types.filter((x) => x !== t) : [...r.types, t] })
  const togglePlat = (p: Platform): void => set({ platforms: r.platforms.includes(p) ? r.platforms.filter((x) => x !== p) : [...r.platforms, p] })

  const save = (): void => {
    setErr(null)
    window.hub.rulePut({ ...r, name: r.name.trim() || autoName(r) }).then(onClose).catch((e) => setErr(errText(e)))
  }

  return (
    <div className="card ruleedit">
      <div className="btnrow" style={{ marginBottom: 6 }}>
        <input className="input ruleedit-name" value={r.name} maxLength={60} placeholder={autoName(r)} onChange={(e) => set({ name: e.target.value })} />
        {dirty && <span className="tag warn">Есть изменения</span>}
      </div>

      <Step n={1} title="Когда это происходит">
        <div className="chips big">
          {TRIGGERS.filter((x) => !x.service).map((x) => <button key={x.id} className={r.types.includes(x.id) ? 'on' : ''} onClick={() => toggleType(x.id)}><i>{x.ico}</i>{x.label}</button>)}
        </div>
        <div className="chips-label">Эфир и управление</div>
        <div className="chips big">
          {TRIGGERS.filter((x) => x.service).map((x) => <button key={x.id} className={r.types.includes(x.id) ? 'on' : ''} onClick={() => toggleType(x.id)}><i>{x.ico}</i>{x.label}</button>)}
        </div>
        {r.types.includes('timer') && (
          <div className="inline-cond">
            <span>Каждые</span><NumIn width={90} min={1} max={720} value={r.intervalMin} onChange={(n) => set({ intervalMin: n })} /><span>мин</span>
            <Toggle on={r.onlyLive} onChange={(v) => set({ onlyLive: v })} label="Только во время эфира" />
          </div>
        )}
        {r.types.includes('hotkey') && (
          <div className="inline-cond">
            <span>Сочетание</span><HotkeyInput value={r.hotkey} onChange={(v) => set({ hotkey: v })} />
            {keyErr && <span className="tag warn">{keyErr}</span>}
          </div>
        )}
        {(r.types.includes('stream_start') || r.types.includes('stream_end')) && (
          <p className="small muted" style={{ margin: '0 0 10px' }}>Начало и конец эфира Crossember узнаёт от OBS — он должен быть подключён (раздел «Подключения»).</p>
        )}
        {hasViewer && (!showPlat
          ? <button className="linkbtn" onClick={() => setShowPlat(true)}>Со всех площадок · выбрать конкретные</button>
          : <div className="chips">
              <button className={r.platforms.length === 0 ? 'on' : ''} onClick={() => set({ platforms: [] })}>Все площадки</button>
              {PLATFORMS.map((p) => <button key={p.id} className={r.platforms.includes(p.id) ? 'on' : ''} onClick={() => togglePlat(p.id)}>{p.label}</button>)}
            </div>)}
      </Step>

      {hasViewer && <Step n={2} title="Если" hint="ruleFilter" aside={!hasAmount && !showText && !showUsers ? 'необязательно' : undefined}>
        {hasAmount && (
          <div className="inline-cond">
            <span>Сумма от</span><NumIn width={120} value={r.filter.minAmount} onChange={(n) => setF({ minAmount: n })} />
            <span>до</span><NumIn width={120} value={r.filter.maxAmount} onChange={(n) => setF({ maxAmount: n })} />
            <span className="muted small">0 — без ограничения{r.types.includes('donation') ? ', донаты в рублях' : ''}</span>
          </div>
        )}
        {showText && (
          <div className="inline-cond">
            <span>В тексте есть</span>
            <input className="input" style={{ flex: 1 }} value={r.filter.textContains} maxLength={200} placeholder={r.types.includes('message') ? '!сцена, !привет' : 'слова через запятую'} onChange={(e) => setF({ textContains: e.target.value })} />
            <button className="btn sm" title="Убрать условие" onClick={() => { setF({ textContains: '' }); setShowText(false) }}>✕</button>
          </div>
        )}
        {showUsers && (
          <div className="inline-cond">
            <span>Только от</span>
            <input className="input" style={{ flex: 1 }} value={r.filter.users} maxLength={300} placeholder="ники через запятую" onChange={(e) => setF({ users: e.target.value })} />
            <button className="btn sm" title="Убрать условие" onClick={() => { setF({ users: '' }); setShowUsers(false) }}>✕</button>
          </div>
        )}
        <div className="btnrow">
          {!showText && <button className="linkbtn" onClick={() => setShowText(true)}>+ слово в тексте</button>}
          {!showUsers && <button className="linkbtn" onClick={() => setShowUsers(true)}>+ только определённые ники</button>}
        </div>
        {r.types.some(isService) && <p className="small muted" style={{ margin: '4px 0 0' }}>Условия относятся только к событиям зрителей; эфир, таймер и клавиша срабатывают без них.</p>}
      </Step>}

      <Step n={hasViewer ? 3 : 2} title="Тогда">
        {r.actions.map((a, i) => {
          const meta = ACTIONS.find((x) => x.type === a.type)!
          return (
            <div key={i} className={`action a-${a.type}`}>
              <div className="action-head">
                <i>{meta.ico}</i><b>{meta.title}</b>
                <button className="iconbtn" title="Убрать действие" onClick={() => set({ actions: r.actions.filter((_, j) => j !== i) })}>✕</button>
              </div>
              {a.type === 'alert' && (
                <>
                  <select className="input" value={a.templateId} onChange={(e) => setA(i, { ...a, templateId: e.target.value })}>
                    {!snap.templates.some((t) => t.id === a.templateId) && <option value={a.templateId}>— выберите шаблон —</option>}
                    {snap.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <p className="small muted" style={{ margin: '6px 0 0' }}>Как выглядит алерт, настраивается в «Алерты» → «Шаблоны».</p>
                </>
              )}
              {a.type === 'tts' && (
                <>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label>Что читать — {'{user}'} ник, {'{amount}'} сумма, {'{message}'} сообщение{snap.counters.length ? <>, счётчики: {snap.counters.slice(0, 3).map((c) => `{${c.key}}`).join(' ')}</> : null}</label>
                    <input className="input" value={a.text} maxLength={300} onChange={(e) => setA(i, { ...a, text: e.target.value })} />
                  </div>
                  <div className="inline-cond">
                    <span>Когда читать</span>
                    <select className="input" style={{ width: 'auto' }} value={a.when} onChange={(e) => setA(i, { ...a, when: e.target.value as TtsWhen })}>
                      {TTS_WHEN.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                    </select>
                    {a.when === 'delay' && <><NumIn width={80} max={60} value={a.delaySec} onChange={(n) => setA(i, { ...a, delaySec: n })} /><span>сек от начала</span></>}
                    <span className="muted small">{TTS_WHEN.find((w) => w.id === a.when)?.hint}</span>
                  </div>
                  <div className="action-grid">
                    <div className="field"><label>Голос</label><VoiceSelect allowDefault value={a.voice} onChange={(v) => setA(i, { ...a, voice: v })} /></div>
                    <div className="field"><label>Скорость</label><NumIn min={-10} max={10} value={a.rate} onChange={(n) => setA(i, { ...a, rate: n })} /></div>
                    <div className="field"><label>Громкость, %</label><NumIn max={100} value={a.volume} onChange={(n) => setA(i, { ...a, volume: n })} /></div>
                  </div>
                  <button className="btn sm" onClick={() => previewTts(snap, a.text.replace('{user}', 'Тестовый зритель').replace('{amount}', '500 рублей').replace('{message}', 'Привет со стрима!').replace(/\{([A-Za-zА-Яа-яЁё0-9_]{1,24})\}/g, (m, k: string) => String(snap.counters.find((c) => c.key === k)?.value ?? m))).catch((e) => setErr(errText(e)))}>▶ Послушать</button>
                </>
              )}
              {a.type === 'sound' && (
                <div className="action-grid">
                  <div className="field"><label>Звук</label><SoundSelect snap={snap} value={a.sound} onChange={(v) => setA(i, { ...a, sound: v })} /></div>
                  <div className="field"><label>Громкость, %</label><NumIn max={100} value={a.volume} onChange={(n) => setA(i, { ...a, volume: n })} /></div>
                  <div className="field"><label>&nbsp;</label><button className="btn sm" onClick={() => previewSound(snap, a.sound, a.volume / 100)}>▶ Послушать</button></div>
                </div>
              )}
              {a.type === 'obs' && <ObsActionEditor value={a.obs} onChange={(o) => setA(i, { ...a, obs: o })} />}
              {a.type === 'counter' && (snap.counters.length ? (
                <>
                  <div className="action-grid">
                    <div className="field"><label>Счётчик</label>
                      <select className="input" value={a.counterId} onChange={(e) => setA(i, { ...a, counterId: e.target.value })}>
                        {!snap.counters.some((c) => c.id === a.counterId) && <option value={a.counterId}>— выберите —</option>}
                        {snap.counters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                    <div className="field"><label>Что сделать</label>
                      <select className="input" value={a.op} onChange={(e) => setA(i, { ...a, op: e.target.value as CounterOp })}>
                        {COUNTER_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                      </select>
                    </div>
                    <div className="field"><label>{a.op === 'set' ? 'Значение' : 'На сколько'}</label>
                      {a.op === 'amount' ? <input className="input" disabled value="сумма события" /> : <NumIn max={1_000_000_000} value={a.value} onChange={(n) => setA(i, { ...a, value: n })} />}
                    </div>
                  </div>
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    {a.op === 'amount' ? 'Донаты — в рублях, биты, рейды и подарки — их количество. ' : ''}
                    Алерт и озвучка этого правила покажут уже новое значение. Кнопка «Тест» счётчик не меняет.
                  </p>
                </>
              ) : <p className="small muted" style={{ margin: 0 }}>Счётчиков пока нет — добавьте в карточке «Счётчики» справа.</p>)}
            </div>
          )
        })}
        {r.actions.length < 20 && (
          <>
            {r.actions.length > 0 && <div className="small muted" style={{ margin: '4px 0 8px' }}>Добавить ещё:</div>}
            <div className="tiles">
              {ACTIONS.map((x) => (
                <button key={x.type} className={`tile a-${x.type}`} onClick={() => set({ actions: [...r.actions, newAction(x.type, snap)] })}>
                  <i>{x.ico}</i><b>{x.title}</b><span>{x.desc}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </Step>

      <details className="more">
        <summary>Дополнительно: кулдаун, тестовые события, порядок</summary>
        <div className="more-body">
          <div className="inline-cond">
            <span>Не чаще раза в</span><NumIn width={100} max={86400} value={r.cooldownSec} onChange={(n) => set({ cooldownSec: n })} /><span>сек</span>
            <Hint id="ruleCooldown" />
          </div>
          {r.cooldownSec > 0 && <Toggle on={r.cooldownPerUser} onChange={(v) => set({ cooldownPerUser: v })} label="Считать отдельно для каждого зрителя" />}
          <div className="inline-cond">
            <span>Тестовые события</span>
            <select className="input" style={{ width: 'auto' }} value={r.filter.tests} onChange={(e) => setF({ tests: e.target.value as Rule['filter']['tests'] })}>
              <option value="any">тоже срабатывают</option><option value="real">не срабатывают</option><option value="test">только они</option>
            </select>
          </div>
          <Toggle on={r.stop} onChange={(v) => set({ stop: v })} label={<>Если сработало — правила ниже не проверять <Hint id="ruleStop" /></>} />
        </div>
      </details>

      {r.actions.some((a) => a.type === 'tts' || a.type === 'sound') && (
        <p className="small muted">Озвучка и звук играют вместе с первым алертом этого события (озвучка — в выбранный момент; алерт ждёт, пока голос договорит), а если алерта нет — сами по себе, в той же очереди.</p>
      )}
      {err && <p className="small" style={{ color: '#ff7a84' }}>{err}</p>}
      <div className="btnrow" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={save}>Сохранить</button>
        <button className="btn" onClick={onClose}>Отмена</button>
        {exists && (confirmDel
          ? <button className="btn" style={{ marginLeft: 'auto', borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => { void window.hub.ruleRemove(rule.id); onClose() }}>Точно удалить?</button>
          : <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setConfirmDel(true)}>Удалить</button>)}
      </div>
    </div>
  )
}

/** Карточка «Счётчики»: значения с кнопками −/+, добавление и правка. */
function CountersCard({ snap }: { snap: HubSnapshot }) {
  const [edit, setEdit] = useState<Counter | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const wrap = (p: Promise<unknown>, after?: () => void): void => { setErr(null); p.then(() => after?.()).catch((e) => setErr(errText(e))) }
  const isNew = !!edit && !snap.counters.some((c) => c.id === edit.id)
  const blank = (): Counter => ({ id: crypto.randomUUID(), name: '', key: '', value: 0 })

  return (
    <div className="card">
      <h3>Счётчики <Hint id="counters" /> <button className="btn sm r" disabled={isNew} onClick={() => { setErr(null); setEdit(blank()) }}>+ Счётчик</button></h3>
      <div className="list counters">
        {snap.counters.map((c) => edit?.id === c.id
          ? <CounterEdit key={c.id} c={edit} isNew={false} onChange={setEdit} onCancel={() => setEdit(null)} onSave={(x) => wrap(window.hub.counterPut(x), () => setEdit(null))} onRemove={() => wrap(window.hub.counterRemove(c.id), () => setEdit(null))} />
          : (
            <div key={c.id} className="row counter-row">
              <div className="grow" onClick={() => { setErr(null); setEdit({ ...c }) }} title="Изменить">
                <b className="ellipsis">{c.name}</b>
                <code className="counter-key">{`{${c.key}}`}</code>
              </div>
              <div className="counter-ctl">
                <button className="btn sm" title="Отнять 1" onClick={() => wrap(window.hub.counterApply(c.id, 'sub', 1))}>−</button>
                <span className="counter-val">{c.value.toLocaleString('ru-RU')}</span>
                <button className="btn sm" title="Прибавить 1" onClick={() => wrap(window.hub.counterApply(c.id, 'add', 1))}>+</button>
              </div>
            </div>
          ))}
        {isNew && edit && <CounterEdit c={edit} isNew onChange={setEdit} onCancel={() => setEdit(null)} onSave={(x) => wrap(window.hub.counterPut(x), () => setEdit(null))} />}
      </div>
      {!snap.counters.length && !edit && <p className="small muted">Счётчиков нет. Например: смерти, победы, «собрано на цель».</p>}
      {err && <p className="small" style={{ color: '#ff7a84', margin: '8px 0 0' }}>{err}</p>}
      <p className="small muted" style={{ margin: '10px 0 0' }}>В текстах алертов, озвучки и OBS пишите ключ в фигурных скобках. Менять счётчик по клавише — правило с поводом «Горячая клавиша» и действием «Счётчик». На экран — оверлей «Счётчики».</p>
    </div>
  )
}

function CounterEdit({ c, isNew, onChange, onSave, onCancel, onRemove }: {
  c: Counter; isNew: boolean; onChange: (c: Counter) => void; onSave: (c: Counter) => void; onCancel: () => void; onRemove?: () => void
}) {
  const [keyTouched, setKeyTouched] = useState(!isNew)
  const [confirmDel, setConfirmDel] = useState(false)
  return (
    <div className="counter-edit">
      <div className="action-grid">
        <div className="field"><label>Название</label>
          <input className="input" autoFocus value={c.name} maxLength={40} placeholder="Смерти"
            onChange={(e) => onChange({ ...c, name: e.target.value, key: keyTouched ? c.key : keyFrom(e.target.value) })} />
        </div>
        <div className="field"><label>Ключ для текстов</label>
          <input className="input mono" value={c.key} maxLength={24} placeholder="смерти"
            onChange={(e) => { setKeyTouched(true); onChange({ ...c, key: e.target.value.replace(/[^A-Za-zА-Яа-яЁё0-9_]/g, '') }) }} />
        </div>
        <div className="field"><label>Значение</label>
          <input className="input mono" type="number" value={c.value} onChange={(e) => onChange({ ...c, value: Math.round(Number(e.target.value) || 0) })} />
        </div>
      </div>
      <div className="btnrow">
        <button className="btn sm primary" disabled={!c.name.trim()} onClick={() => onSave({ ...c, name: c.name.trim(), key: c.key || keyFrom(c.name) })}>Сохранить</button>
        <button className="btn sm" onClick={onCancel}>Отмена</button>
        {!isNew && <button className="btn sm" onClick={() => onChange({ ...c, value: 0 })}>Обнулить</button>}
        {onRemove && (confirmDel
          ? <button className="btn sm" style={{ marginLeft: 'auto', borderColor: '#ff7a84', color: '#ff7a84' }} onClick={onRemove}>Точно удалить?</button>
          : <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setConfirmDel(true)}>Удалить</button>)}
      </div>
    </div>
  )
}
