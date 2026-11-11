import { useState } from 'react'
import type { HubSnapshot, OverlayInfo } from '../../../main/core/types'
import type { AppSettings, ChatOverlaySettings, StatsPeriod, Theme } from '../../../main/core/settings'
import { Hint, NumberField, ThemePicker, Toggle } from '../components'

type Key = keyof AppSettings['overlays']
const KEY: Record<string, Key> = { alert: 'alert', chat: 'chat', 'chat-h': 'chatH', pinned: 'pinned', top: 'top', last: 'last', counter: 'counter', auction: 'auction', wheel: 'wheel', goal: 'goal', giveaway: 'giveaway' }
const DESC: Record<string, string> = {
  alert: 'Донаты, подписки, рейды, фолловы — по очереди, по центру экрана.',
  chat: 'Колонка чата: новые сообщения снизу.',
  'chat-h': 'Строка чата внизу экрана: новые сообщения слева.',
  pinned: 'Сообщение, которое вы закрепили в Мультичате (📌).',
  top: 'Самые щедрые зрители за эфир, день, неделю, месяц или всё время. Тестовые донаты не считаются.',
  last: 'Последний донат (и последняя подписка) — строкой поверх сцены.',
  counter: 'Смерти, победы и другие счётчики из раздела «Правила». Число коротко подпрыгивает, когда меняется.',
  auction: 'Таймер и топ лотов с полосками доли, в конце — победитель. Ники и сообщения зрителей не показываются.',
  wheel: 'Появляется, когда крутите колесо, показывает итог и само прячется. Источник можно держать включённым всегда.',
  goal: 'Цель с полоской прогресса и этапами, последний донат, топ сбора и срок. Этап или цель достигнуты — короткий праздник.',
  giveaway: 'Во время приёма — слово для участия, число участников и таймер. При выборе ники прокручиваются до победителя.'
}

export function Overlays({ snap }: { snap: HubSnapshot }) {
  return (
    <>
      <div className="head">
        <div>
          <h1>Оверлеи для OBS <Hint id="overlays" /></h1>
          <p>Каждый оверлей — одна ссылка для источника «Браузер». Настройки применяются в OBS сразу.</p>
        </div>
        <div className="actions">
          <button className="btn sm" onClick={() => void window.hub.testEvent('message')}>Тест: сообщение</button>
          <button className="btn sm" onClick={() => void window.hub.testEvent('donation')}>Тест: донат</button>
        </div>
      </div>
      {!snap.server ? <div className="note warnbox">Сервер оверлеев не запущен — смотрите «Подключения».</div> : (
        <div className="grid g2">
          {snap.server.overlays.map((o) => <OverlayCard key={o.id} o={o} snap={snap} />)}
        </div>
      )}
      <div className="note" style={{ marginTop: 18 }}>
        🔒 В ссылках есть ключ доступа. Если ссылка засветилась — «Настройки → Ключ оверлеев → Перевыпустить».
      </div>
    </>
  )
}

function OverlayCard({ o, snap }: { o: OverlayInfo; snap: HubSnapshot }) {
  const [copied, setCopied] = useState(false)
  const key = KEY[o.id]
  const cfg = snap.settings.overlays[key]
  const set = (patch: Record<string, unknown>): void => void window.hub.setSettings({ overlays: { [key]: patch } })

  return (
    <div className="card">
      <h3>{o.name} <span className="r chip">{o.size}</span></h3>
      <p className="small muted" style={{ marginTop: -6 }}>{DESC[o.id]}</p>
      <div className="url">
        <code title="Ссылка содержит ключ доступа — не показывайте её в эфире">{o.url.replace(/k=.+$/, 'k=••••••')}</code>
        <button className="btn sm" onClick={() => { void window.hub.copy(o.url); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Скопировано ✓' : 'Скопировать'}</button>
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label>Тема <Hint id="theme" /></label>
        <ThemePicker value={cfg.theme} onChange={(t: Theme) => set({ theme: t })} />
      </div>
      {(key === 'chat' || key === 'chatH') && <ChatSettings c={cfg as ChatOverlaySettings} set={set} />}
      {key === 'top' && <TopSettings c={cfg as AppSettings['overlays']['top']} set={set} />}
      {key === 'last' && (
        <>
          <NumberField label="Размер шрифта" value={(cfg as { fontSize: number }).fontSize} min={12} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
          <Toggle on={(cfg as AppSettings['overlays']['last']).showSub} onChange={(v) => set({ showSub: v })} label="Показывать последнюю подписку" />
        </>
      )}
      {key === 'counter' && <CounterSettings c={cfg as AppSettings['overlays']['counter']} snap={snap} set={set} />}
      {key === 'auction' && <AuctionOverlaySettings c={cfg as AppSettings['overlays']['auction']} set={set} />}
      {key === 'giveaway' && (
        <div className="grid g3" style={{ gap: 10 }}>
          <NumberField label="Шрифт" value={(cfg as AppSettings['overlays']['giveaway']).fontSize} min={12} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
          <NumberField label="Прокрутка" value={(cfg as AppSettings['overlays']['giveaway']).revealSec} min={2} max={20} suffix="сек" onChange={(v) => set({ revealSec: v })} />
          <NumberField label="Скрыть итог через" value={(cfg as AppSettings['overlays']['giveaway']).hideAfterSec} min={0} max={600} suffix="сек (0 — нет)" onChange={(v) => set({ hideAfterSec: v })} />
        </div>
      )}
      {key === 'goal' && <GoalOverlaySettings c={cfg as AppSettings['overlays']['goal']} set={set} />}
      {key === 'wheel' && <NumberField label="Скрыть после итога через" value={(cfg as AppSettings['overlays']['wheel']).hideAfterSec} min={0} max={600} suffix="сек (0 — не скрывать)" onChange={(v) => set({ hideAfterSec: v })} />}
      {key === 'pinned' && (
        <NumberField label="Размер шрифта" value={(cfg as { fontSize: number }).fontSize} min={12} max={96} suffix="px" onChange={(v) => set({ fontSize: v })} />
      )}
    </div>
  )
}

function ChatSettings({ c, set }: { c: ChatOverlaySettings; set: (p: Record<string, unknown>) => void }) {
  return (
    <>
      <div className="grid g3" style={{ gap: 10 }}>
        <NumberField label="Шрифт" value={c.fontSize} min={10} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
        <NumberField label="Сообщений" value={c.maxMessages} min={1} max={100} onChange={(v) => set({ maxMessages: v })} />
        <NumberField label="Скрывать через" value={c.hideAfterSec} min={0} max={3600} suffix="сек (0 — нет)" onChange={(v) => set({ hideAfterSec: v })} />
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <Toggle on={c.showBadges} onChange={(v) => set({ showBadges: v })} label="Бейджи" />
        <Toggle on={c.showPlatform} onChange={(v) => set({ showPlatform: v })} label="Значок площадки" />
        <Toggle on={c.showStatus} onChange={(v) => set({ showStatus: v })} label={<>Строки о сбоях площадок <Hint id="showStatus" /></>} />
      </div>
    </>
  )
}

function CounterSettings({ c, snap, set }: { c: AppSettings['overlays']['counter']; snap: HubSnapshot; set: (p: Record<string, unknown>) => void }) {
  const all = c.ids.length === 0
  const toggle = (id: string): void => {
    const cur = all ? [] : c.ids.filter((x) => snap.counters.some((k) => k.id === x))
    set({ ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }
  return (
    <>
      <div className="field">
        <label>Какие показывать</label>
        {snap.counters.length ? (
          <div className="chips">
            <button className={all ? 'on' : ''} onClick={() => set({ ids: [] })}>Все</button>
            {snap.counters.map((k) => <button key={k.id} className={!all && c.ids.includes(k.id) ? 'on' : ''} onClick={() => toggle(k.id)}>{k.name}</button>)}
          </div>
        ) : <p className="small muted" style={{ margin: 0 }}>Счётчиков пока нет — добавьте в «Правила» → «Счётчики».</p>}
      </div>
      <div className="grid g2" style={{ gap: 10 }}>
        <div className="field">
          <label>Расположение</label>
          <div className="seg">
            <button className={c.layout === 'column' ? 'on' : ''} onClick={() => set({ layout: 'column' })}>Столбиком</button>
            <button className={c.layout === 'row' ? 'on' : ''} onClick={() => set({ layout: 'row' })}>В строку</button>
          </div>
        </div>
        <NumberField label="Размер шрифта" value={c.fontSize} min={12} max={96} suffix="px" onChange={(v) => set({ fontSize: v })} />
      </div>
    </>
  )
}

function AuctionOverlaySettings({ c, set }: { c: AppSettings['overlays']['auction']; set: (p: Record<string, unknown>) => void }) {
  return (
    <>
      <div className="field">
        <label>Что показывать у лота</label>
        <div className="seg">
          <button className={c.show === 'sum' ? 'on' : ''} onClick={() => set({ show: 'sum' })}>Сумму</button>
          <button className={c.show === 'pct' ? 'on' : ''} onClick={() => set({ show: 'pct' })}>Долю, %</button>
          <button className={c.show === 'both' ? 'on' : ''} onClick={() => set({ show: 'both' })}>Обе</button>
        </div>
      </div>
      <div className="grid g2" style={{ gap: 10 }}>
        <NumberField label="Сколько лотов" value={c.count} min={1} max={20} onChange={(v) => set({ count: v })} />
        <NumberField label="Размер шрифта" value={c.fontSize} min={12} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
      </div>
      <Toggle on={c.showTimer} onChange={(v) => set({ showTimer: v })} label="Показывать таймер" />
    </>
  )
}

function GoalOverlaySettings({ c, set }: { c: AppSettings['overlays']['goal']; set: (p: Record<string, unknown>) => void }) {
  return (
    <>
      <div className="grid g2" style={{ gap: 10 }}>
        <NumberField label="Размер шрифта" value={c.fontSize} min={12} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
        <NumberField label="Сколько в топе" value={c.topCount} min={1} max={5} onChange={(v) => set({ topCount: v })} />
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <Toggle on={c.showStages} onChange={(v) => set({ showStages: v })} label="Этапы на полоске" />
        <Toggle on={c.showLast} onChange={(v) => set({ showLast: v })} label="Последний донат" />
        <Toggle on={c.showTop} onChange={(v) => set({ showTop: v })} label="Топ сбора" />
        <Toggle on={c.showTimer} onChange={(v) => set({ showTimer: v })} label="Срок" />
        <Toggle on={c.celebrate} onChange={(v) => set({ celebrate: v })} label="Праздник при достижении" />
      </div>
    </>
  )
}

const PERIODS: [StatsPeriod, string][] = [['stream', 'Эфир'], ['today', 'Сегодня'], ['week', '7 дней'], ['month', '30 дней'], ['all', 'Всё время']]

function TopSettings({ c, set }: { c: AppSettings['overlays']['top']; set: (p: Record<string, unknown>) => void }) {
  return (
    <>
      <div className="field">
        <label>Период <Hint id="stats" /></label>
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {PERIODS.map(([id, l]) => <button key={id} className={c.period === id ? 'on' : ''} onClick={() => set({ period: id })}>{l}</button>)}
        </div>
      </div>
      <div className="grid g2" style={{ gap: 10 }}>
        <NumberField label="Сколько человек" value={c.count} min={1} max={20} onChange={(v) => set({ count: v })} />
        <NumberField label="Размер шрифта" value={c.fontSize} min={12} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
      </div>
    </>
  )
}
