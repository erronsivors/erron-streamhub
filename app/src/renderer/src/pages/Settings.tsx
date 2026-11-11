import { useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import { Hint, NumberField, ThemePicker, Toggle } from '../components'
import type { FloatChatSettings, TtsSettings } from '../../../main/core/settings'
import { VoiceSelect, previewTts } from '../editors'
import { errText } from '../components'
import type { ProfilePart, ProfileSummary } from '../../../main/core/profile'

export function Settings({ snap }: { snap: HubSnapshot }) {
  const s = snap.settings
  const lan = snap.server?.lan
  const [confirm, setConfirm] = useState<'overlay' | 'remote' | null>(null)
  const [copied, setCopied] = useState(false)

  return (
    <>
      <div className="head">
        <div>
          <h1>Настройки</h1>
          <p>Режим работы, тема, второй ПК, ключи доступа, профиль.</p>
        </div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>Режим работы <Hint id="mode" /></h3>
          <div className="seg">
            <button className={s.setupMode === 'one' ? 'on' : ''} onClick={() => void window.hub.setSettings({ setupMode: 'one' })}>1 ПК</button>
            <button className={s.setupMode === 'two' ? 'on' : ''} onClick={() => void window.hub.setSettings({ setupMode: 'two' })}>2 ПК</button>
          </div>
          <p className="small muted">
            {s.setupMode === 'two'
              ? 'Crossember стоит на стрим-ПК рядом с OBS — там же открыт общий чат всех площадок.'
              : 'Игра, OBS и Crossember на одном компьютере.'}
          </p>
          <h3 style={{ marginTop: 18 }}>Тема по умолчанию <Hint id="theme" /></h3>
          <ThemePicker value={s.defaultTheme} onChange={(t) => void window.hub.setSettings({ defaultTheme: t })} />
          <p className="small muted">Применяется к новым оверлеям. У каждого оверлея своя тема — в разделе «Оверлеи».</p>
          <button className="btn sm" onClick={() => void window.hub.setSettings({ overlays: { alert: { theme: s.defaultTheme }, chat: { theme: s.defaultTheme }, chatH: { theme: s.defaultTheme }, pinned: { theme: s.defaultTheme } } })}>
            Применить ко всем оверлеям
          </button>
        </div>

        <FloatCard snap={snap} />
        <TtsCard snap={snap} />
        <ProfileCard snap={snap} />

        {(
          <div className="card">
            <h3>Чат на другом устройстве <Hint id="lan" /></h3>
            <p className="small muted" style={{ marginTop: -6 }}>Телефон, планшет или второй ПК в той же домашней сети: чат и события в обычном браузере.</p>
            <div className="field">
              <label>Адрес этого ПК в домашней сети</label>
              <select className="input" value={s.lan.host} onChange={(e) => void window.hub.setSettings({ lan: { host: e.target.value } })}>
                <option value="">— выберите —</option>
                {(lan?.addresses ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {lan && lan.addresses.length === 0 && <span className="small muted">Не найдено подключений к домашней сети.</span>}
            </div>
            <NumberField label="Порт" value={s.lan.port} min={1024} max={65535} onChange={(v) => void window.hub.setSettings({ lan: { port: v } })} />
            <Toggle on={s.lan.enabled} onChange={(v) => void window.hub.setSettings({ lan: { enabled: v } })} label="Открыть чат для другого устройства" />
            <Toggle on={s.lan.control} onChange={(v) => void window.hub.setSettings({ lan: { control: v } })} label="Разрешить там кнопки дока (алерты, аукцион, сбор, розыгрыш…)" />
            {s.lan.control && <p className="small muted" style={{ margin: '2px 0 0' }}>На устройстве откроется тот же набор блоков, что выбран в «Оверлеи → Док для OBS». Выключено — только чат и события.</p>}
            {lan?.error && <div className="note warnbox" style={{ marginTop: 10 }}>{lan.error}</div>}
            {lan?.running && lan.url && (
              <div style={{ marginTop: 12 }}>
                <div className="url">
                  <code>{lan.url.replace(/k=.+$/, 'k=••••••')}</code>
                  <button className="btn sm" onClick={() => { void window.hub.copy(lan.url!); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Скопировано ✓' : 'Скопировать'}</button>
                </div>
                <p className="small muted">Откройте ссылку в браузере на телефоне, планшете или втором ПК (можно отправить себе в «Избранное» мессенджера). Если не открывается — проверьте, что Windows разрешила доступ для частной сети.</p>
                <KeyRotate label="Перевыпустить ключ ссылки" confirm={confirm === 'remote'} onAsk={() => setConfirm('remote')} onCancel={() => setConfirm(null)} onYes={() => { void window.hub.rotateKey('remote'); setConfirm(null) }} />
              </div>
            )}
          </div>
        )}

        <div className="card">
          <h3>Сервер оверлеев</h3>
          <div className="kv">
            <div><span>Адрес</span><b className="mono" style={{ fontSize: 15 }}>127.0.0.1</b></div>
            <div><span>Порт</span><b className="mono" style={{ fontSize: 15 }}>{snap.server?.port ?? '—'}</b></div>
          </div>
          <p className="small muted">Слушает только этот компьютер — из сети и интернета недоступен.</p>
          <h3 style={{ marginTop: 18 }}>Ключ оверлеев <Hint id="overlayKey" /></h3>
          <KeyRotate label="Перевыпустить ключ оверлеев" confirm={confirm === 'overlay'} onAsk={() => setConfirm('overlay')} onCancel={() => setConfirm(null)} onYes={() => { void window.hub.rotateKey('overlay'); setConfirm(null) }} />
        </div>

        <div className="card">
          <h3>Безопасность</h3>
          <div className="list small">
            <div className="row">🔒 Токены и пароли шифруются Windows (DPAPI), открытым текстом не хранятся</div>
            <div className="row">🛰 Никакой телеметрии и чужих серверов — площадки подключаются напрямую</div>
            <div className="row">🧱 Интерфейс изолирован: без доступа к системе, без переходов и новых окон</div>
            <div className="row">🧾 Текст из чата выводится только как текст — защита от внедрения кода</div>
            <div className="row">💬 Сообщения чата на диск не сохраняются (для «Аналитики» — только ник и счётчики, выключается там же)</div>
          </div>
        </div>
      </div>
    </>
  )
}

const PARTS: { id: ProfilePart; label: string; count: (s: ProfileSummary) => string }[] = [
  { id: 'settings', label: 'Настройки', count: (s) => (s.settings ? 'оверлеи, озвучка, площадки, тема' : 'нет в файле') },
  { id: 'rules', label: 'Правила и счётчики', count: (s) => `${s.rules} правил, ${s.counters} счётчиков` },
  { id: 'templates', label: 'Шаблоны алертов', count: (s) => `${s.templates} шт.` },
  { id: 'media', label: 'Картинки, видео и звуки', count: (s) => `${s.media + s.sounds} файлов` }
]
const has = (s: ProfileSummary, p: ProfilePart): boolean =>
  p === 'settings' ? s.settings : p === 'rules' ? s.rules + s.counters > 0 : p === 'templates' ? s.templates > 0 : s.media + s.sounds > 0
const mb = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`)
const when = (ts: number): string => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/** Профиль: сохранить всё в один файл и загрузить обратно (на этом или другом ПК). */
function ProfileCard({ snap }: { snap: HubSnapshot }) {
  const [withMedia, setWithMedia] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pick, setPick] = useState<ProfileSummary | null>(null)
  const [parts, setParts] = useState<ProfilePart[]>([])
  const [confirmUndo, setConfirmUndo] = useState(false)
  const run = (p: Promise<unknown>, ok?: (v: unknown) => void): void => {
    setBusy(true); setMsg(null)
    p.then((v) => ok?.(v)).catch((e) => setMsg({ ok: false, text: errText(e) })).finally(() => setBusy(false))
  }
  const last = snap.profile.lastBackup

  return (
    <div className="card">
      <h3>Профиль <Hint id="profile" /></h3>
      <p className="small muted" style={{ marginTop: -6 }}>Все настройки, правила, счётчики, шаблоны алертов и свои файлы — в одном файле. Для переезда на другой ПК или на всякий случай. Токенов и паролей в файле нет.</p>
      {!pick ? (
        <>
          <Toggle on={withMedia} onChange={setWithMedia} label="Вместе с картинками, видео и звуками" />
          <div className="btnrow" style={{ marginTop: 10 }}>
            <button className="btn sm primary" disabled={busy} onClick={() => run(window.hub.profileExport(withMedia), (r) => r && setMsg({ ok: true, text: `Профиль сохранён (${mb((r as { size: number }).size)}).` }))}>Сохранить в файл…</button>
            <button className="btn sm" disabled={busy} onClick={() => run(window.hub.profilePick(), (r) => {
              if (!r) return
              const s = r as ProfileSummary
              setPick(s)
              setParts(PARTS.filter((p) => has(s, p.id)).map((p) => p.id))
            })}>Загрузить из файла…</button>
          </div>
        </>
      ) : (
        <div className="profile-pick">
          <div className="small muted">Файл от {pick.createdAt ? when(pick.createdAt) : 'неизвестной даты'} · {mb(pick.size)}. Что загрузить:</div>
          <div className="profile-parts">
            {PARTS.map((p) => {
              const avail = has(pick, p.id)
              return (
                <label key={p.id} className={`profile-part ${avail ? '' : 'off'}`}>
                  <input type="checkbox" disabled={!avail} checked={avail && parts.includes(p.id)}
                    onChange={(e) => setParts(e.target.checked ? [...parts, p.id] : parts.filter((x) => x !== p.id))} />
                  <span><b>{p.label}</b><span className="small muted">{p.count(pick)}</span></span>
                </label>
              )
            })}
          </div>
          <p className="small muted" style={{ margin: '8px 0 10px' }}>Выбранное заменит текущее. Перед этим Crossember сам сохранит резервную копию — вернуть можно одной кнопкой. Свои картинки и звуки только добавляются, ничего не удаляется.</p>
          <div className="btnrow">
            <button className="btn sm primary" disabled={busy || !parts.length} onClick={() => run(window.hub.profileApply(parts), () => { setPick(null); setMsg({ ok: true, text: 'Профиль загружен.' }) })}>Загрузить</button>
            <button className="btn sm" disabled={busy} onClick={() => { void window.hub.profileCancel(); setPick(null) }}>Отмена</button>
          </div>
        </div>
      )}
      {msg && <div className={`note ${msg.ok ? '' : 'warnbox'}`} style={{ marginTop: 12 }}>{msg.text}</div>}
      {last && !pick && (
        <div className="profile-undo">
          <span className="small muted">Резервная копия до загрузки профиля: {when(last)}</span>
          {confirmUndo
            ? <span className="btnrow"><button className="btn sm" disabled={busy} onClick={() => { setConfirmUndo(false); run(window.hub.profileUndo(), () => setMsg({ ok: true, text: 'Вернули как было до загрузки профиля.' })) }}>Да, вернуть</button><button className="btn sm" onClick={() => setConfirmUndo(false)}>Нет</button></span>
            : <button className="btn sm" disabled={busy} onClick={() => setConfirmUndo(true)}>Вернуть как было</button>}
        </div>
      )}
    </div>
  )
}

export function KeyRotate({ label, confirm, onAsk, onCancel, onYes }: { label: string; confirm: boolean; onAsk: () => void; onCancel: () => void; onYes: () => void }) {
  if (!confirm) return <button className="btn sm" onClick={onAsk}>{label}</button>
  return (
    <div>
      <p className="small muted">Старые ссылки перестанут работать — их нужно будет вставить заново.</p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn primary sm" onClick={onYes}>Да, перевыпустить</button>
        <button className="btn sm" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  )
}

function FloatCard({ snap }: { snap: HubSnapshot }) {
  const f = snap.settings.float
  const set = (p: Partial<FloatChatSettings>): void => void window.hub.setSettings({ float: p })
  const b = f.bounds ?? { x: 0, y: 0, width: 380, height: 520 }
  return (
    <div className="card">
      <h3>Чат поверх игры <Hint id="float" /></h3>
      <p className="small muted" style={{ marginTop: -6 }}>Прозрачное окно с чатом поверх всех окон. Клики проходят сквозь него в игру.</p>
      <Toggle on={f.enabled} onChange={(v) => set({ enabled: v })} label="Показывать чат поверх игры" />
      {f.enabled && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '6px 0 12px' }}>
            <button className={snap.float.editing ? 'btn sm primary' : 'btn sm'} onClick={() => void window.hub.floatEdit()}>
              {snap.float.editing ? 'Готово — закрепить' : 'Настроить положение'}
            </button>
            <button className="btn sm" onClick={() => void window.hub.floatReset()}>Вернуть в угол экрана</button>
          </div>
          <p className="small muted">Горячая клавиша: <b className="mono">{snap.float.hotkey}</b> — включить/выключить режим перетаскивания прямо в игре.</p>
          <div className="field">
            <label>Тема</label>
            <ThemePicker value={f.theme} onChange={(t) => set({ theme: t })} />
          </div>
          <div className="grid g3" style={{ gap: 10 }}>
            <NumberField label="Шрифт" value={f.fontSize} min={10} max={72} suffix="px" onChange={(v) => set({ fontSize: v })} />
            <NumberField label="Сообщений" value={f.maxMessages} min={1} max={100} onChange={(v) => set({ maxMessages: v })} />
            <NumberField label="Скрывать через" value={f.hideAfterSec} min={0} max={3600} suffix="сек" onChange={(v) => set({ hideAfterSec: v })} />
            <NumberField label="Подложка" value={f.bgOpacity} min={0} max={100} suffix="%" onChange={(v) => set({ bgOpacity: v })} />
            <NumberField label="Ширина" value={b.width} min={200} max={4000} suffix="px" onChange={(v) => set({ bounds: { ...b, width: v } })} />
            <NumberField label="Высота" value={b.height} min={120} max={4000} suffix="px" onChange={(v) => set({ bounds: { ...b, height: v } })} />
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <Toggle on={f.showBadges} onChange={(v) => set({ showBadges: v })} label="Бейджи" />
            <Toggle on={f.showPlatform} onChange={(v) => set({ showPlatform: v })} label="Значок площадки" />
            <Toggle on={f.showStatus} onChange={(v) => set({ showStatus: v })} label="Строки о сбоях" />
          </div>
        </>
      )}
    </div>
  )
}

function TtsCard({ snap }: { snap: HubSnapshot }) {
  const s = snap.settings.tts
  const set = (p: Partial<TtsSettings>): void => void window.hub.setSettings({ tts: p })
  const [text, setText] = useState('Тестовый зритель — 500 рублей. Привет со стрима!')
  const [bad, setBad] = useState(s.badWords)
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="card">
      <h3>Озвучка <Hint id="tts" /></h3>
      <p className="small muted" style={{ marginTop: -6 }}>Голоса Windows — работают сразу, без установки. Озвучку включают правила (раздел «Правила») или слой «Озвучка» в шаблоне алерта.</p>
      <div className="field"><label>Голос</label><VoiceSelect value={s.voice} onChange={(v) => set({ voice: v })} /></div>
      <div className="grid g3" style={{ gap: 10 }}>
        <NumberField label="Скорость" value={s.rate} min={-10} max={10} suffix="−10…10" onChange={(v) => set({ rate: v })} />
        <NumberField label="Громкость" value={s.volume} min={0} max={100} suffix="%" onChange={(v) => set({ volume: v })} />
        <NumberField label="Читать сообщение до" value={s.maxChars} min={20} max={500} suffix="символов" onChange={(v) => set({ maxChars: v })} />
      </div>
      <Toggle on={s.stripLinks} onChange={(v) => set({ stripLinks: v })} label="Не читать ссылки" />
      <div className="field" style={{ marginTop: 10 }}>
        <label>Не читать слова (через запятую, слово вырезается целиком)</label>
        <input className="input" value={bad} maxLength={2000} onChange={(e) => setBad(e.target.value)} onBlur={() => bad !== s.badWords && set({ badWords: bad })} />
      </div>
      <div className="field">
        <label>Проверить голос</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ flex: 1 }} value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
          <button className="btn sm" onClick={() => { setErr(null); previewTts(snap, text).catch((e) => setErr(errText(e))) }}>▶ Послушать</button>
        </div>
        {err && <span className="small" style={{ color: '#ff7a84' }}>{err}</span>}
      </div>
      <p className="small muted">Здесь голос звучит в колонках ПК. На стриме озвучку играет оверлей «Алерты» — её слышно в OBS. Silero и свой голос появятся позже.</p>
    </div>
  )
}
