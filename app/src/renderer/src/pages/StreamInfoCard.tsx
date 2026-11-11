import { useEffect, useRef, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { InfoPlatform } from '../../../main/core/streaminfo'
import type { Page } from '../App'
import { errText, Hint } from '../components'
import { PlatIcon } from '../ui'

const NAMES: Record<InfoPlatform, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', vk: 'VK Видео Live', goodgame: 'GoodGame' }
const ORDER: InfoPlatform[] = ['twitch', 'youtube', 'kick', 'vk', 'goodgame']
/** Категории YouTube — как в ядре (streaminfo.ts YT_CATEGORIES). */
const YT: [string, string][] = [['20', 'Видеоигры'], ['24', 'Развлечения'], ['22', 'Люди и блоги'], ['10', 'Музыка'], ['27', 'Образование'], ['28', 'Наука и техника'], ['17', 'Спорт'], ['26', 'Хобби и стиль'], ['23', 'Юмор']]

/** Название и категория эфира — сразу на всех площадках. */
export function StreamInfoCard({ snap, go }: { snap: HubSnapshot; go: (p: Page) => void }) {
  const st = snap.streamInfo
  const [title, setTitle] = useState(st.title)
  const [game, setGame] = useState(st.game)
  const [tips, setTips] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [showRecent, setShowRecent] = useState(false)
  const timer = useRef<number | null>(null)

  // Поля могли измениться из ядра (кнопка «Взять с Twitch», выбор из недавних).
  useEffect(() => { setTitle(st.title) }, [st.title])
  useEffect(() => { setGame(st.game) }, [st.game])

  const draft = (p: Parameters<typeof window.hub.infoDraft>[0]): void => { void window.hub.infoDraft(p) }
  const onGame = (v: string): void => {
    setGame(v)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { window.hub.infoSuggest(v).then(setTips).catch(() => setTips([])) }, 300)
  }
  const toggle = (p: InfoPlatform): void => draft({ targets: st.targets.includes(p) ? st.targets.filter((x) => x !== p) : [...st.targets, p] })
  const apply = (): void => {
    setErr(null)
    window.hub.infoDraft({ title, game }).then(() => window.hub.infoApply()).catch((e) => setErr(errText(e)))
  }
  const dirty = title !== st.title || game !== st.game
  const anyResult = ORDER.some((p) => st.targets.includes(p) && st.results[p])

  return (
    <div className="card sinfo">
      <h3>Название и категория эфира <Hint id="streamInfo" />
        <span className="r btnrow">
          {st.recent.length > 0 && <button className="btn sm" onClick={() => setShowRecent(!showRecent)}>Недавние {showRecent ? '▴' : '▾'}</button>}
          {st.access.twitch === 'ok' && <button className="btn sm" title="Подставить то, что сейчас стоит на Twitch" onClick={() => { setErr(null); window.hub.infoFromTwitch().catch((e) => setErr(errText(e))) }}>Взять с Twitch</button>}
        </span>
      </h3>
      {showRecent && (
        <div className="sinfo-recent">
          {st.recent.map((r, i) => (
            <button key={i} onClick={() => { setTitle(r.title); setGame(r.game); setShowRecent(false) }}>
              <span className="ellipsis">{r.title}</span>{r.game && <span className="muted small ellipsis">{r.game}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="sinfo-fields">
        <div className="field">
          <label>Название <span className="muted">{title.length}/140</span></label>
          <input className="input" value={title} maxLength={140} placeholder="Например: Проходим Elden Ring вслепую" onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== st.title && draft({ title })} />
        </div>
        <div className="field">
          <label>Игра или категория</label>
          <input className="input" list="sinfo-games" value={game} maxLength={100} placeholder="Just Chatting" onChange={(e) => onGame(e.target.value)} onBlur={() => game !== st.game && draft({ game })} />
          <datalist id="sinfo-games">{tips.map((t) => <option key={t} value={t} />)}</datalist>
        </div>
        <div className="field">
          <label>Раздел на YouTube</label>
          <select className="input" value={st.ytCategory} onChange={(e) => draft({ ytCategory: e.target.value })}>
            {YT.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </div>
      </div>

      <div className="sinfo-targets">
        {ORDER.map((p) => {
          const on = st.targets.includes(p)
          const r = on ? st.results[p] : undefined
          const a = st.access[p]
          const note = a === 'relogin' ? 'нужен повторный вход' : a === 'login' ? 'не выполнен вход' : a === 'unavailable' ? 'вход не настроен' : a === 'nochannel' ? 'нет ника канала' : a === 'manual' ? 'вручную' : ''
          return (
            <button key={p} className={`sinfo-t ${on ? 'on' : ''} ${r ? 's-' + r.state : ''}`} onClick={() => toggle(p)} title={r?.text ?? ''}>
              <PlatIcon p={p} />
              <span className="sinfo-t-text">
                <b>{NAMES[p]}</b>
                <span className="small">{r ? (r.state === 'ok' ? '✓ ' : r.state === 'error' ? '✕ ' : '') + r.text : on ? note || 'автоматически' : 'не менять'}</span>
              </span>
            </button>
          )
        })}
      </div>

      {st.targets.includes('twitch') && st.access.twitch === 'relogin' && (
        <div className="note warnbox btnrow" style={{ marginTop: 12 }}>
          <span style={{ flex: 1, minWidth: 220 }}>Чтобы менять название на Twitch, Crossember нужно новое разрешение. Выйдите и войдите в Twitch заново — один раз.</span>
          <button className="btn sm" onClick={() => go('connections')}>Подключения →</button>
        </div>
      )}
      {st.targets.includes('kick') && st.access.kick === 'login' && (
        <div className="note btnrow" style={{ marginTop: 12 }}>
          <span style={{ flex: 1, minWidth: 220 }}>{snap.kickAuth.pending ? 'Подтвердите вход в открывшемся браузере…' : 'Чат Kick читается без входа, а для смены названия нужно войти в Kick.'}</span>
          {snap.kickAuth.pending
            ? <button className="btn sm" onClick={() => void window.hub.kickCancel()}>Отмена</button>
            : <button className="btn sm" onClick={() => { setErr(null); window.hub.kickLogin().catch((e) => setErr(errText(e))) }}>Войти в Kick</button>}
        </div>
      )}
      {err && <div className="note warnbox" style={{ marginTop: 12 }}>{err}</div>}

      <div className="btnrow" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={st.busy || !title.trim() || !st.targets.length} onClick={apply}>{st.busy ? 'Применяю…' : 'Применить на выбранных'}</button>
        {dirty && <span className="tag warn">Не применено</span>}
        {!dirty && anyResult && !st.busy && <span className="small muted">Нажмите на площадку, чтобы включить или выключить её.</span>}
      </div>
    </div>
  )
}
