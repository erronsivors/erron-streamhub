import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HubEvent, HubSnapshot } from '../../../main/core/types'
import type { ChatOverlaySettings, Theme } from '../../../main/core/settings'
import {
  ANIM_IN, ANIM_IN_LABEL, ANIM_OUT, ANIM_OUT_LABEL, BG_LABEL, BG_STYLES, CHAT_EVENTS, CHAT_EVENT_LABEL, CHAT_FONTS, CHAT_SOURCES, COLOR_KEYS,
  COLOR_LABEL, DEFAULT_COLORS, FONT_LABEL, HIGHLIGHTS, HIGHLIGHT_LABEL, chatCss, eventView, isMention, sampleChat,
  type ChatEventView, type ChatLook, type TextStyle
} from '../../../main/core/chatstyle'
import type { Page } from '../App'
import { Hint, NumberField, ThemePicker, Toggle, errText } from '../components'

type Target = 'chat' | 'chatH' | 'float'
const TARGETS: { id: Target; label: string; mode: 'v' | 'h' | 'f' }[] = [
  { id: 'chat', label: 'Вертикальный', mode: 'v' },
  { id: 'chatH', label: 'Горизонтальный', mode: 'h' },
  { id: 'float', label: 'Поверх игры', mode: 'f' }
]
type Backdrop = 'dark' | 'light' | 'game' | 'check'
const BACKDROPS: { id: Backdrop; label: string }[] = [{ id: 'game', label: 'Игра' }, { id: 'dark', label: 'Тёмный' }, { id: 'light', label: 'Светлый' }, { id: 'check', label: 'Прозрачный' }]
const TAG: Record<string, string> = { twitch: 'Tw', youtube: 'YT', vk: 'VK', kick: 'K', goodgame: 'GG', donationalerts: 'DA', donatepay: 'DP', donatex: 'DX', boosty: 'B', hub: '₽' }
const SOURCE_LABEL: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', vk: 'VK Видео', kick: 'Kick', goodgame: 'GoodGame' }

type DeepPartialLook = { [K in keyof ChatLook]?: ChatLook[K] extends object ? Partial<ChatLook[K]> : ChatLook[K] }

export function ChatStyle({ snap, go }: { snap: HubSnapshot; go: (p: Page) => void }) {
  const [target, setTarget] = useState<Target>('chat')
  const [err, setErr] = useState<string | null>(null)
  const t = TARGETS.find((x) => x.id === target) ?? TARGETS[0]
  const cfg: ChatOverlaySettings & { bgOpacity?: number } = target === 'float' ? snap.settings.float : snap.settings.overlays[target]
  const look = cfg.look
  const wrap = (p: Promise<unknown>): void => { setErr(null); p.catch((e) => setErr(errText(e))) }
  const set = (patch: Record<string, unknown>): void => wrap(target === 'float' ? window.hub.setSettings({ float: patch }) : window.hub.setSettings({ overlays: { [target]: patch } }))
  const setLook = (patch: DeepPartialLook): void => set({ look: patch })
  const own = snap.platforms.find((p) => p.account)?.account ?? 'streamer'

  return (
    <>
      <div className="subnav">
        <button className="subnav-back" onClick={() => go('overlays')}>← Оверлеи</button>
        <div className="subtabs">
          {TARGETS.map((x) => <button key={x.id} className={target === x.id ? 'on' : ''} onClick={() => setTarget(x.id)}>{x.label}</button>)}
        </div>
      </div>
      <div className="head">
        <div>
          <h1>Оформление чата <Hint id="chatStyle" /></h1>
          <p>Как чат выглядит на стриме. Всё меняется сразу — и в предпросмотре, и в OBS.</p>
        </div>
      </div>
      {err && <div className="note err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="cs-grid" key={target}>
        <div className="cs-settings">
          <Block title="Лента сообщений" open>
            <div className="cs-row3">
              <NumberField label="Сообщений на экране" value={cfg.maxMessages} min={1} max={100} onChange={(v) => set({ maxMessages: v })} />
              <NumberField label="Исчезает через" value={cfg.hideAfterSec} min={0} max={3600} suffix="сек (0 — нет)" onChange={(v) => set({ hideAfterSec: v })} />
              <NumberField label="Отступ между" value={look.gap} min={0} max={40} suffix="px" onChange={(v) => setLook({ gap: v })} />
            </div>
            {t.mode !== 'h' && <Toggle on={look.newestTop} onChange={(v) => setLook({ newestTop: v })} label="Новые сообщения сверху" />}
            <div className="cs-row3">
              <Select label="Появление" value={look.animIn} options={ANIM_IN.map((a) => [a, ANIM_IN_LABEL[a]])} onChange={(v) => setLook({ animIn: v as ChatLook['animIn'] })} />
              <Select label="Исчезновение" value={look.animOut} options={ANIM_OUT.map((a) => [a, ANIM_OUT_LABEL[a]])} onChange={(v) => setLook({ animOut: v as ChatLook['animOut'] })} />
              <NumberField label="Длительность анимации" value={look.animMs} min={100} max={2000} suffix="мс" onChange={(v) => setLook({ animMs: v })} />
            </div>
          </Block>

          <Block title="Подложка">
            <div className="field"><label>Тема</label><ThemePicker value={cfg.theme} onChange={(th: Theme) => set({ theme: th })} /></div>
            <div className="field">
              <label>Под сообщением</label>
              <div className="seg">{BG_STYLES.map((b) => <button key={b} className={look.bg === b ? 'on' : ''} onClick={() => setLook({ bg: b })}>{BG_LABEL[b]}</button>)}</div>
            </div>
            <div className="cs-row3">
              {target === 'float'
                ? <NumberField label="Непрозрачность" value={cfg.bgOpacity ?? 55} min={0} max={100} suffix="%" onChange={(v) => set({ bgOpacity: v })} />
                : <NumberField label="Непрозрачность" value={look.opacity} min={0} max={100} suffix="%" onChange={(v) => setLook({ opacity: v })} />}
              <NumberField label="Скругление" value={look.radius} min={0} max={30} suffix="px" onChange={(v) => setLook({ radius: v })} />
            </div>
          </Block>

          <Block title="Состав строки">
            <div className="cs-toggles">
              <Toggle on={cfg.showPlatform} onChange={(v) => set({ showPlatform: v })} label="Значок площадки" />
              {cfg.showPlatform && <div className="seg">{(['dot', 'tag'] as const).map((p) => <button key={p} className={look.plat === p ? 'on' : ''} onClick={() => setLook({ plat: p })}>{p === 'dot' ? 'Точка' : 'Подпись Tw / YT'}</button>)}</div>}
            </div>
            <div className="cs-toggles">
              <Toggle on={cfg.showBadges} onChange={(v) => set({ showBadges: v })} label="Значки зрителя (Twitch)" />
              <Toggle on={look.showName} onChange={(v) => setLook({ showName: v })} label="Ник" />
              <Toggle on={look.showEmotes} onChange={(v) => setLook({ showEmotes: v })} label="Смайлы картинками" />
            </div>
            <div className="cs-row3">
              <div className="field"><label>Знак после ника</label><input className="input" maxLength={4} value={look.sep} onChange={(e) => setLook({ sep: e.target.value })} /></div>
              <NumberField label="Размер смайлов" value={look.emoteScale} min={50} max={300} suffix="%" onChange={(v) => setLook({ emoteScale: v })} />
            </div>
          </Block>

          <Block title="Площадки">
            <p className="small muted cs-note">Чьи чаты показывать. Ни одна не отмечена — показываются все подключённые.</p>
            <div className="cs-checks">
              {CHAT_SOURCES.map((p) => (
                <label key={p} className="cs-check">
                  <input type="checkbox" checked={look.platforms.includes(p)} onChange={(e) => setLook({ platforms: e.target.checked ? [...look.platforms, p] : look.platforms.filter((x) => x !== p) })} />
                  {SOURCE_LABEL[p]}
                </label>
              ))}
            </div>
          </Block>

          <Block title="События в ленте">
            <div className="cs-checks">
              {CHAT_EVENTS.map((k) => (
                <label key={k} className="cs-check">
                  <input type="checkbox" checked={look.events[k]} onChange={(e) => setLook({ events: { [k]: e.target.checked } })} />
                  {CHAT_EVENT_LABEL[k]}
                </label>
              ))}
              <label className="cs-check"><input type="checkbox" checked={cfg.showStatus} onChange={(e) => set({ showStatus: e.target.checked })} />Сбои площадок</label>
            </div>
            <Select label="Как выделять событие" value={look.highlight} options={HIGHLIGHTS.map((h) => [h, HIGHLIGHT_LABEL[h]])} onChange={(v) => setLook({ highlight: v as ChatLook['highlight'] })} />
            <div className="field">
              <label>Цвета событий — по площадке и сервису</label>
              <div className="cs-colors">
                {COLOR_KEYS.map((k) => (
                  <label key={k} className="cs-color">
                    <input type="color" value={look.colors[k]} onChange={(e) => setLook({ colors: { [k]: e.target.value } })} />
                    <span>{COLOR_LABEL[k]}</span>
                  </label>
                ))}
              </div>
              <button className="btn sm" style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={() => setLook({ colors: { ...DEFAULT_COLORS } })}>Вернуть цвета по умолчанию</button>
            </div>
          </Block>

          <Block title="Оформление текста">
            <div className="cs-row3">
              <NumberField label="Основной размер" value={cfg.fontSize} min={10} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
              <div className="field">
                <label>Настраивать</label>
                <div className="seg">
                  <button className={look.textMode === 'all' ? 'on' : ''} onClick={() => setLook({ textMode: 'all' })}>Всё вместе</button>
                  <button className={look.textMode === 'split' ? 'on' : ''} onClick={() => setLook({ textMode: 'split' })}>Отдельно</button>
                </div>
              </div>
            </div>
            {look.textMode === 'all'
              ? <TextEditor value={look.text} noSize onChange={(p) => setLook({ text: p })} />
              : <SplitText look={look} setLook={setLook} />}
          </Block>
        </div>

        <div className="cs-preview-col">
          <ChatPreview cfg={cfg} mode={t.mode} own={own} opacity={target === 'float' ? cfg.bgOpacity ?? 55 : look.opacity} />
        </div>
      </div>
    </>
  )
}

function Block({ title, open, children }: { title: string; open?: boolean; children: ReactNode }) {
  const [on, setOn] = useState(!!open)
  return (
    <div className={`card cs-block ${on ? 'open' : ''}`}>
      <button className="cs-block-head" onClick={() => setOn(!on)}><span className="cs-chev">▸</span>{title}</button>
      {on && <div className="cs-block-body">{children}</div>}
    </div>
  )
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  )
}

function SplitText({ look, setLook }: { look: ChatLook; setLook: (p: DeepPartialLook) => void }) {
  const [part, setPart] = useState<'name' | 'msg' | 'event'>('name')
  return (
    <>
      <div className="seg" style={{ marginBottom: 12 }}>
        {([['name', 'Ник'], ['msg', 'Сообщение'], ['event', 'Подпись события']] as const).map(([id, l]) => <button key={id} className={part === id ? 'on' : ''} onClick={() => setPart(id)}>{l}</button>)}
      </div>
      <TextEditor key={part} value={look[part]} nameColor={part === 'name'} onChange={(p) => setLook({ [part]: p })} />
    </>
  )
}

function TextEditor({ value, onChange, noSize, nameColor }: { value: TextStyle; onChange: (p: Partial<TextStyle>) => void; noSize?: boolean; nameColor?: boolean }) {
  return (
    <div className="cs-text">
      <div className="cs-row3">
        <Select label="Шрифт" value={value.font} options={CHAT_FONTS.map((f) => [f, FONT_LABEL[f]])} onChange={(v) => onChange({ font: v as TextStyle['font'] })} />
        {!noSize && <NumberField label="Размер" value={value.size} min={0} max={96} suffix="px (0 — основной)" onChange={(v) => onChange({ size: v })} />}
        <div className="field">
          <label>Толщина</label>
          <div className="seg">{([400, 600, 800] as const).map((w) => <button key={w} className={value.weight === w ? 'on' : ''} onClick={() => onChange({ weight: w })}>{w === 400 ? 'Обычный' : w === 600 ? 'Средний' : 'Жирный'}</button>)}</div>
        </div>
      </div>
      <div className="cs-toggles">
        <Toggle on={value.italic} onChange={(v) => onChange({ italic: v })} label="Курсив" />
        <Toggle on={value.upper} onChange={(v) => onChange({ upper: v })} label="ВЕРХНИЙ РЕГИСТР" />
        <label className="cs-check">
          <input type="checkbox" checked={!!value.color} onChange={(e) => onChange({ color: e.target.checked ? '#ffffff' : '' })} />
          {nameColor ? 'Свой цвет ника (вместо цвета из чата)' : 'Свой цвет'}
        </label>
        {value.color && <input type="color" className="cs-swatch" value={value.color} onChange={(e) => onChange({ color: e.target.value })} />}
      </div>
      <div className="cs-row3">
        <NumberField label="Межбуквенный интервал" value={value.letter} min={-2} max={20} suffix="px" onChange={(v) => onChange({ letter: v })} />
        <NumberField label="Высота строки" value={value.line} min={90} max={220} suffix="%" onChange={(v) => onChange({ line: v })} />
      </div>
      <div className="cs-row3">
        <div className="cs-pair">
          <NumberField label="Обводка" value={value.stroke} min={0} max={8} suffix="px" onChange={(v) => onChange({ stroke: v })} />
          <input type="color" className="cs-swatch" value={value.strokeColor} onChange={(e) => onChange({ strokeColor: e.target.value })} title="Цвет обводки" />
        </div>
        <div className="cs-pair">
          <NumberField label="Тень" value={value.shadow} min={0} max={30} suffix="px" onChange={(v) => onChange({ shadow: v })} />
          <input type="color" className="cs-swatch" value={value.shadowColor} onChange={(e) => onChange({ shadowColor: e.target.value })} title="Цвет тени" />
        </div>
      </div>
    </div>
  )
}

// ---------- Живой предпросмотр: тот же CSS, что уходит в OBS ----------

interface Item { e: HubEvent; view: ChatEventView | null; born: number }

function ChatPreview({ cfg, mode, own, opacity }: { cfg: ChatOverlaySettings; mode: 'v' | 'h' | 'f'; own: string; opacity: number }) {
  const [running, setRunning] = useState(true)
  const [backdrop, setBackdrop] = useState<Backdrop>('game')
  const [items, setItems] = useState<Item[]>(() => Array.from({ length: 8 }, (_, i) => { const e = sampleChat(i, own); return { e, view: eventView(e), born: 0 } }))
  const [sent, setSent] = useState(false)
  const seq = useRef(100)
  const listRef = useRef<HTMLDivElement>(null)
  const css = useMemo(() => chatCss({ ...cfg.look, opacity }, cfg.fontSize, '.cxp', mode), [cfg.look, cfg.fontSize, mode, opacity])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      const e = sampleChat(seq.current++, own)
      setItems((list) => [...list, { e, view: eventView(e), born: Date.now() }].slice(-60))
    }, 1300)
    return () => clearInterval(t)
  }, [running, own])

  // Строки собираются так же, как в chat.js оверлея (тот же набор классов), — и тем же способом: только textContent.
  useEffect(() => {
    const box = listRef.current
    if (!box) return
    const look = cfg.look
    const now = Date.now()
    const vis = items.filter((x) => {
      const plOk = !(CHAT_SOURCES as readonly string[]).includes(x.e.platform) || !look.platforms.length || look.platforms.includes(x.e.platform)
      if (!plOk) return false
      if (x.e.type === 'message') return true
      return !!x.view && look.events[x.view.kind]
    }).filter((x) => cfg.hideAfterSec === 0 || !x.born || now - x.born < cfg.hideAfterSec * 1000)
      .slice(-cfg.maxMessages)
    const newestFirst = mode === 'h' || look.newestTop
    const rows = vis.map((x) => buildRow(x, cfg, own, now))
    box.replaceChildren(...(newestFirst ? rows.reverse() : rows))
  }, [items, cfg, own, mode])

  const clear = (): void => setItems([])
  const testObs = (): void => { void window.hub.chatTest(); setSent(true); setTimeout(() => setSent(false), 3000) }

  return (
    <div className="card cs-preview">
      <h3>
        Предпросмотр
        <div className="seg r cs-bd">{BACKDROPS.map((b) => <button key={b.id} className={backdrop === b.id ? 'on' : ''} onClick={() => setBackdrop(b.id)}>{b.label}</button>)}</div>
      </h3>
      <style>{css}</style>
      <div className={`cs-stage bd-${backdrop} m-${mode}`}>
        <div className={`cxp t-${cfg.theme}`}>
          <div ref={listRef} className={`cx-list m-${mode} ${mode !== 'h' && cfg.look.newestTop ? 'top' : ''}`} />
        </div>
      </div>
      <div className="btnrow cs-actions">
        <button className="btn sm" onClick={() => setRunning(!running)}>{running ? '❚❚ Пауза' : '▶ Тестовый поток'}</button>
        <button className="btn sm" onClick={clear}>Очистить</button>
        <button className="btn sm primary" onClick={testObs}>{sent ? 'Отправлено в OBS ✓' : 'Тест в OBS'}</button>
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>Тестовые сообщения видны только здесь. «Тест в OBS» на несколько секунд пускает выдуманные сообщения в чаты в OBS — без алертов, правил и записи в базу.</p>
    </div>
  )
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function buildRow(x: Item, cfg: ChatOverlaySettings, own: string, now: number): HTMLElement {
  const look = cfg.look
  const fresh = x.born > 0 && now - x.born < 400
  const plat = (p: string): HTMLElement => {
    const s = el('span', 'plat', look.plat === 'tag' ? TAG[p] ?? '' : '')
    const c = (look.colors as Record<string, string>)[p]
    if (c) s.style.setProperty('--pc', c)
    return s
  }
  let row: HTMLElement
  if (x.e.type === 'message') {
    row = el('div', 'msg')
    if (look.events.mention && isMention(x.e.text ?? '', [own])) row.classList.add('mention')
    if (cfg.showPlatform) row.append(plat(x.e.platform))
    if (look.showName) {
      const name = el('span', 'name', x.e.user)
      if (look.textMode === 'split' && look.name.color) name.classList.add('fixed')
      else if (x.e.color && /^#[0-9a-fA-F]{6}$/.test(x.e.color)) name.style.color = x.e.color
      if (!look.sep) name.classList.add('nosep')
      row.append(name)
      if (look.sep) row.append(el('span', 'sep', look.sep))
    }
    row.append(el('span', 'text', x.e.text ?? ''))
  } else {
    const v = x.view as ChatEventView
    row = el('div', `msg ev ev-${v.kind}`)
    const c = look.colors[v.color]
    if (c) { row.style.setProperty('--ec', c); row.style.setProperty('--ecf', c + '4d') }
    const head = el('div', 'ev-head')
    if (cfg.showPlatform) head.append(plat(x.e.platform))
    head.append(el('span', 'name', x.e.user), el('span', 'ev-label', `${v.icon} ${v.label}`))
    if (v.detail) head.append(el('span', 'ev-detail', v.detail))
    row.append(head)
    if (v.body) {
      const body = el('div', 'ev-body')
      body.append(el('span', 'text', v.body))
      row.append(body)
    }
  }
  if (!fresh) row.classList.add('still')
  return row
}
