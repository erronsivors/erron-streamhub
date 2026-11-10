import { useEffect, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { StatsPeriod } from '../../../main/core/settings'
import type { StatsSnapshot } from '../../../main/core/stats'
import type { AlertTemplate } from '../../../main/core/templates'
import { Hint, NumberField, Toggle, errText } from '../components'
import { PlatIcon } from '../ui'
import { AlertEditor, blankTemplate } from './AlertEditor'
import { OverlayWarning } from './Rules'

const TESTS: { kind: Parameters<typeof window.hub.testEvent>[0]; label: string }[] = [
  { kind: 'donation', label: '₽ Донат' }, { kind: 'bigdonation', label: '₽ Крупный донат' }, { kind: 'sub', label: '★ Подписка' },
  { kind: 'boosty', label: 'B Подписка Boosty' }, { kind: 'gift', label: '🎁 Подарки' }, { kind: 'follow', label: '♥ Фоллоу' },
  { kind: 'raid', label: '↗ Рейд' }, { kind: 'bits', label: '◆ Биты' }, { kind: 'reward', label: '✦ Баллы' }
]

const PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: 'stream', label: 'Эфир' }, { id: 'today', label: 'Сегодня' }, { id: 'week', label: '7 дней' }, { id: 'month', label: '30 дней' }, { id: 'all', label: 'Всё время' }
]

const rub = (n: number): string => `${Math.round(n).toLocaleString('ru-RU')} ₽`

export function Alerts({ snap }: { snap: HubSnapshot }) {
  const q = snap.alerts
  const s = snap.settings.alerts
  const [editing, setEditing] = useState<AlertTemplate | null>(null)
  const setAlerts = (patch: Record<string, unknown>): void => void window.hub.setSettings({ alerts: patch })

  if (editing) return <AlertEditor key={editing.id} initial={editing} snap={snap} onClose={() => setEditing(null)} />

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

      <OverlayWarning snap={snap} />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)' }}>
        <div className="grid" style={{ alignContent: 'start' }}>
          <div className="card">
            <h3>Сейчас и очередь {q.paused && <span className="r tag">ПАУЗА</span>}</h3>
            {!s.enabled && <div className="note warnbox" style={{ marginBottom: 10 }}>Алерты выключены — события идут только в ленту.</div>}
            {q.current ? (
              <div className="row">
                <PlatIcon p={q.current.platform} />
                <div className="grow"><b className="ellipsis">{q.current.summary}</b><span className="small muted">показывается сейчас{q.current.test ? ' · тест' : ''}</span></div>
              </div>
            ) : <p className="muted small">Сейчас ничего не показывается.</p>}
            {q.queue.length > 0 && <div className="list" style={{ marginTop: 8 }}>
              {q.queue.map((a) => (
                <div key={a.id} className="row">
                  <PlatIcon p={a.platform} />
                  <div className="grow"><span className="ellipsis">{a.summary}</span></div>
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

          <TemplatesCard snap={snap} onEdit={setEditing} />
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

function TemplatesCard({ snap, onEdit }: { snap: HubSnapshot; onEdit: (t: AlertTemplate) => void }) {
  const [err, setErr] = useState<string | null>(null)
  const [del, setDel] = useState<string | null>(null)
  const wrap = (p: Promise<unknown>): void => { setErr(null); p.catch((e) => setErr(errText(e))) }
  const usedBy = (id: string): string[] => snap.rules.rules.filter((r) => r.actions.some((a) => a.type === 'alert' && a.templateId === id)).map((r) => r.name)
  return (
    <div className="card">
      <h3>Шаблоны алертов <Hint id="alertTemplate" /><button className="btn sm primary r" onClick={() => onEdit(blankTemplate())}>+ Новый</button></h3>
      <p className="small muted" style={{ marginTop: -6 }}>Как выглядит алерт: слои на холсте и таймлайне. Когда какой показывать — решают <b>Правила</b>.</p>
      <div className="list">{snap.templates.map((t) => {
        const used = usedBy(t.id)
        return (
          <div key={t.id} className="row tplrow">
            <div className="grow">
              <b className="ellipsis">{t.name}</b>
              <span className="small muted ellipsis" style={{ display: 'block' }}>
                {t.layers.length} сл. · {(t.durationMs / 1000).toFixed(1)} с · {used.length ? `правила: ${used.join(', ')}` : 'не используется в правилах'}
              </span>
            </div>
            <div className="tpl-tools">
            <button className="btn sm" title="Показать в оверлее на тестовом донате" onClick={() => wrap(window.hub.templateTest(t, 'donation'))}>Тест</button>
            <button className="btn sm" onClick={() => onEdit(structuredClone(t))}>Изменить</button>
            <button className="btn sm" title="Сделать копию" onClick={() => wrap(window.hub.templateDuplicate(t.id))}>⧉</button>
            {del === t.id
              ? <button className="btn sm" style={{ borderColor: '#ff7a84' }} onClick={() => { setDel(null); wrap(window.hub.templateRemove(t.id)) }}>Удалить?</button>
              : <button className="btn sm" title="Удалить" onClick={() => setDel(t.id)}>✕</button>}
            </div>
          </div>
        )
      })}</div>
      {!snap.templates.length && <p className="small muted">Шаблонов нет — создайте первый.</p>}
      {err && <p className="small" style={{ color: '#ff7a84' }}>{err}</p>}
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
