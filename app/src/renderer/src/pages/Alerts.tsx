import { useEffect, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { AlertKind, AlertRule, AlertTier, StatsPeriod } from '../../../main/core/settings'
import type { AlertItem } from '../../../main/core/alerts'
import type { StatsSnapshot } from '../../../main/core/stats'
import { Hint, NumberField, Toggle, errText } from '../components'
import { PlatIcon } from '../ui'
import { SOUND_LABEL, playBuiltin } from '../sounds'

const KINDS: { id: AlertKind; label: string; amount?: string }[] = [
  { id: 'donation', label: 'Донат', amount: '₽' },
  { id: 'sub', label: 'Подписка' },
  { id: 'gift', label: 'Подарки', amount: 'подписок' },
  { id: 'follow', label: 'Фоллоу' },
  { id: 'raid', label: 'Рейд', amount: 'зрителей' },
  { id: 'bits', label: 'Биты', amount: 'бит' },
  { id: 'reward', label: 'Баллы' }
]

const TESTS: { kind: Parameters<typeof window.hub.testEvent>[0]; label: string }[] = [
  { kind: 'donation', label: '₽ Донат' }, { kind: 'bigdonation', label: '₽ Крупный донат' }, { kind: 'sub', label: '★ Подписка' },
  { kind: 'boosty', label: 'B Подписка Boosty' }, { kind: 'gift', label: '🎁 Подарки' }, { kind: 'follow', label: '♥ Фоллоу' },
  { kind: 'raid', label: '↗ Рейд' }, { kind: 'bits', label: '◆ Биты' }, { kind: 'reward', label: '✦ Баллы' }
]

const PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: 'stream', label: 'Эфир' }, { id: 'today', label: 'Сегодня' }, { id: 'week', label: '7 дней' }, { id: 'month', label: '30 дней' }, { id: 'all', label: 'Всё время' }
]

const rub = (n: number): string => `${Math.round(n).toLocaleString('ru-RU')} ₽`
const titleText = (a: AlertItem): string => a.title.map((p) => p.v).join('')

export function Alerts({ snap }: { snap: HubSnapshot }) {
  const q = snap.alerts
  const s = snap.settings.alerts
  const [kind, setKind] = useState<AlertKind>('donation')
  const setAlerts = (patch: Record<string, unknown>): void => void window.hub.setSettings({ alerts: patch })

  return (
    <>
      <div className="head">
        <div>
          <h1>Алерты <Hint id="alerts" /></h1>
          <p>Одна очередь на все площадки и сервисы донатов. Показываются в оверлее «Алерты» по одному.</p>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={() => void window.hub.alertPause(!q.paused)}>{q.paused ? '▶ Продолжить' : '❚❚ Пауза'}</button>
          <button className="btn sm" disabled={!q.current} onClick={() => void window.hub.alertSkip()}>⏭ Пропустить</button>
          <button className="btn sm" disabled={!q.current && !q.queue.length} onClick={() => void window.hub.alertStopAll()}>■ Стоп всё</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)' }}>
        <div className="grid" style={{ alignContent: 'start' }}>
          <div className="card">
            <h3>Сейчас и очередь {q.paused && <span className="r tag">ПАУЗА</span>}</h3>
            {!s.enabled && <div className="note warnbox" style={{ marginBottom: 10 }}>Алерты выключены — события идут только в ленту.</div>}
            {q.current ? (
              <div className="row">
                <PlatIcon p={q.current.platform} />
                <div className="grow"><b className="ellipsis">{q.current.kicker}: {titleText(q.current)}</b><span className="small muted">показывается сейчас{q.current.test ? ' · тест' : ''}</span></div>
              </div>
            ) : <p className="muted small">Сейчас ничего не показывается.</p>}
            {q.queue.length > 0 && <div className="list" style={{ marginTop: 8 }}>
              {q.queue.map((a) => (
                <div key={a.id} className="row">
                  <PlatIcon p={a.platform} />
                  <div className="grow"><span className="ellipsis">{a.kicker}: {titleText(a)}</span></div>
                  <button className="btn sm" title="Убрать из очереди" onClick={() => void window.hub.alertRemove(a.id)}>✕</button>
                </div>
              ))}
            </div>}
          </div>

          <div className="card">
            <h3>Проверка <Hint id="testEvents" /></h3>
            <p className="small muted" style={{ marginTop: -6 }}>Тестовые события видны в оверлеях с пометкой «ТЕСТ» и не попадают в статистику.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {TESTS.map((t) => <button key={t.kind} className="btn sm" onClick={() => void window.hub.testEvent(t.kind)}>{t.label}</button>)}
            </div>
          </div>

          <div className="card">
            <h3>Шаблоны <Hint id="alertTemplate" /></h3>
            <div className="seg" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              {KINDS.map((k) => <button key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>{k.label}{!s.rules[k.id].enabled ? ' ·выкл' : ''}</button>)}
            </div>
            <RuleEditor key={kind} kind={kind} rule={s.rules[kind]} amount={KINDS.find((k) => k.id === kind)!.amount} snap={snap} masterVolume={s.volume} />
          </div>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <div className="card">
            <h3>Общие настройки</h3>
            <Toggle on={s.enabled} onChange={(v) => setAlerts({ enabled: v })} label="Показывать алерты" />
            <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
              <NumberField label="Пауза между алертами" value={s.gapSec} min={0} max={30} suffix="сек" onChange={(v) => setAlerts({ gapSec: v })} />
              <NumberField label="Общая громкость" value={s.volume} min={0} max={100} suffix="%" onChange={(v) => setAlerts({ volume: v })} />
            </div>
            <p className="small muted">Звук идёт из источника «Браузер» в OBS. Если его не слышно — в свойствах источника включите «Управлять аудио через OBS» и проверьте микшер. <Hint id="alertSound" /></p>
          </div>
          <SoundsCard snap={snap} />
          <StatsCard snap={snap} />
        </div>
      </div>
    </>
  )
}

function SoundSelect({ value, onChange, snap }: { value: string; onChange: (v: string) => void; snap: HubSnapshot }) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {Object.entries(SOUND_LABEL).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
      {snap.sounds.map((x) => <option key={x.id} value={x.id}>Свой: {x.name}</option>)}
    </select>
  )
}

function preview(sound: string, volume: number): void {
  if (sound.startsWith('custom:')) return
  playBuiltin(sound, volume)
}

function RuleEditor({ kind, rule, amount, snap, masterVolume }: { kind: AlertKind; rule: AlertRule; amount?: string; snap: HubSnapshot; masterVolume: number }) {
  const [kicker, setKicker] = useState(rule.kicker)
  const [title, setTitle] = useState(rule.title)
  const set = (patch: Partial<AlertRule>): void => void window.hub.setSettings({ alerts: { rules: { [kind]: patch } } })
  const setTiers = (tiers: AlertTier[]): void => set({ tiers })
  const vol = (rule.volume * masterVolume) / 10000

  return (
    <div>
      <Toggle on={rule.enabled} onChange={(v) => set({ enabled: v })} label="Алерт для этого события" />
      <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
        <div className="field">
          <label>Верхняя строка</label>
          <input className="input" value={kicker} maxLength={60} onChange={(e) => setKicker(e.target.value)} onBlur={() => kicker !== rule.kicker && set({ kicker })} />
        </div>
        <div className="field">
          <label>Главная строка</label>
          <input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== rule.title && set({ title })} />
        </div>
      </div>
      <p className="small muted" style={{ marginTop: -4 }}>Подстановки: <code>{'{user}'}</code> — ник, <code>{'{amount}'}</code> — сумма{amount ? ` (${amount})` : ''}, <code>{'{platform}'}</code> — площадка.</p>
      <div className="grid g3" style={{ gap: 10 }}>
        <NumberField label="Показывать" value={rule.durationSec} min={2} max={60} suffix="сек" onChange={(v) => set({ durationSec: v })} />
        {amount && <NumberField label="Минимум" value={rule.minAmount} min={0} max={10000000} suffix={`${amount} (0 — все)`} onChange={(v) => set({ minAmount: v })} />}
        <NumberField label="Громкость" value={rule.volume} min={0} max={100} suffix="%" onChange={(v) => set({ volume: v })} />
      </div>
      <div className="field">
        <label>Звук <Hint id="alertSound" /></label>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}><SoundSelect value={rule.sound} onChange={(v) => set({ sound: v })} snap={snap} /></div>
          <button className="btn sm" disabled={rule.sound === 'none' || rule.sound.startsWith('custom:')} title="Послушать" onClick={() => preview(rule.sound, vol)}>▶</button>
        </div>
      </div>
      {kind !== 'follow' && kind !== 'reward' && <Toggle on={rule.showMessage} onChange={(v) => set({ showMessage: v })} label="Показывать сообщение зрителя" />}

      {amount && (
        <div style={{ marginTop: 14 }}>
          <b>Варианты по сумме <Hint id="alertTiers" /></b>
          {rule.tiers.map((t, i) => (
            <div key={i} className="grid" style={{ gridTemplateColumns: '110px 1fr 150px 90px 36px', gap: 8, alignItems: 'end', marginTop: 8 }}>
              <div className="field" style={{ margin: 0 }}><label>От, {amount}</label>
                <input className="input" type="number" min={1} defaultValue={t.from} onBlur={(e) => setTiers(rule.tiers.map((x, j) => (j === i ? { ...x, from: Number(e.target.value) || 1 } : x)))} /></div>
              <div className="field" style={{ margin: 0 }}><label>Верхняя строка</label>
                <input className="input" defaultValue={t.kicker} maxLength={60} onBlur={(e) => setTiers(rule.tiers.map((x, j) => (j === i ? { ...x, kicker: e.target.value } : x)))} /></div>
              <div className="field" style={{ margin: 0 }}><label>Звук</label>
                <SoundSelect value={t.sound} snap={snap} onChange={(v) => { setTiers(rule.tiers.map((x, j) => (j === i ? { ...x, sound: v } : x))); preview(v, vol) }} /></div>
              <div className="field" style={{ margin: 0 }}><label>Сек</label>
                <input className="input" type="number" min={2} max={60} defaultValue={t.durationSec} onBlur={(e) => setTiers(rule.tiers.map((x, j) => (j === i ? { ...x, durationSec: Number(e.target.value) || 6 } : x)))} /></div>
              <button className="btn sm" title="Удалить вариант" onClick={() => setTiers(rule.tiers.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {rule.tiers.length < 5 && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setTiers([...rule.tiers, { from: (rule.tiers.at(-1)?.from ?? 500) * 2, kicker: rule.kicker, sound: rule.sound, durationSec: rule.durationSec }])}>+ Вариант</button>
          )}
        </div>
      )}
    </div>
  )
}

function SoundsCard({ snap }: { snap: HubSnapshot }) {
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="card">
      <h3>Свои звуки <Hint id="alertSound" /></h3>
      <p className="small muted" style={{ marginTop: -6 }}>mp3, wav или ogg до 5 МБ. Файл копируется в папку Crossember — исходник можно удалить.</p>
      {snap.sounds.length ? <div className="list">{snap.sounds.map((x) => (
        <div key={x.id} className="row">
          <div className="grow ellipsis">{x.name}</div>
          <button className="btn sm" onClick={() => void window.hub.soundRemove(x.id)}>Удалить</button>
        </div>
      ))}</div> : <p className="small muted">Пока нет — используются встроенные.</p>}
      <button className="btn sm" style={{ marginTop: 8 }} onClick={() => { setErr(null); window.hub.soundAdd().catch((e) => setErr(errText(e))) }}>+ Добавить звук</button>
      {err && <p className="small" style={{ color: '#ff7a84' }}>{err}</p>}
    </div>
  )
}

function StatsCard({ snap }: { snap: HubSnapshot }) {
  const [period, setPeriod] = useState<StatsPeriod>('stream')
  const [st, setSt] = useState<StatsSnapshot | null>(null)
  const latest = snap.events[0]?.id
  useEffect(() => {
    let alive = true
    void window.hub.stats(period).then((x) => alive && setSt(x))
    return () => { alive = false }
  }, [period, latest])

  return (
    <div className="card">
      <h3>Статистика <Hint id="stats" /></h3>
      <div className="seg" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {PERIODS.map((p) => <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>)}
      </div>
      {st && <>
        {st.streamFallback && <p className="small muted" style={{ marginTop: -4 }}>Эфир сейчас не идёт — показано за сегодня.</p>}
        <div className="kv">
          <div><span>Донаты</span><b>{rub(st.donations.rub)}</b></div>
          <div><span>Донатов</span><b>{st.donations.count}</b></div>
          <div><span>Подписки</span><b>{(st.counts.sub ?? 0) + (st.counts.gift ?? 0)}</b></div>
          <div><span>Фолловы · рейды</span><b>{st.counts.follow ?? 0} · {st.counts.raid ?? 0}</b></div>
        </div>
        {st.byPlatform.length > 0 && <div className="list" style={{ marginTop: 10 }}>
          {st.byPlatform.map((p) => (
            <div key={p.platform} className="row"><PlatIcon p={p.platform} /><div className="grow">{snap.connections.find((c) => c.id === p.platform)?.name ?? p.platform}</div><span className="small muted">{p.count} шт.</span><b style={{ marginLeft: 10 }}>{rub(p.rub)}</b></div>
          ))}
        </div>}
        <h3 style={{ marginTop: 16 }}>Топ донатеров</h3>
        {st.top.length ? <div className="list">{st.top.map((t, i) => (
          <div key={t.user + i} className="row"><b style={{ width: 22 }}>{i + 1}</b><div className="grow ellipsis">{t.user}</div><span className="small muted">{t.count} шт.</span><b style={{ marginLeft: 10 }}>{rub(t.rub)}</b></div>
        ))}</div> : <p className="small muted">Пока нет донатов за этот период.</p>}
      </>}
    </div>
  )
}
