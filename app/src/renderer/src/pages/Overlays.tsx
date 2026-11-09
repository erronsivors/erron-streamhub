import { useState } from 'react'
import type { HubSnapshot, OverlayInfo } from '../../../main/core/types'
import type { AppSettings, ChatOverlaySettings, Theme } from '../../../main/core/settings'
import { Hint, NumberField, ThemePicker, Toggle } from '../components'

type Key = keyof AppSettings['overlays']
const KEY: Record<string, Key> = { alert: 'alert', chat: 'chat', 'chat-h': 'chatH', pinned: 'pinned' }
const DESC: Record<string, string> = {
  alert: 'Донаты, подписки, рейды, фолловы — по очереди, по центру экрана.',
  chat: 'Колонка чата: новые сообщения снизу.',
  'chat-h': 'Строка чата внизу экрана: новые сообщения слева.',
  pinned: 'Сообщение, которое вы закрепили в Мультичате (📌).'
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
