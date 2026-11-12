import React, { useEffect, useState } from 'react'
import type { HubSnapshot } from '../../../main/core/types'
import type { PollView, VoteKind, VoteState } from '../../../main/core/vote'
import type { VoteSettings } from '../../../main/core/settings'
import { Hint, NumberField, Toggle, errText } from '../components'
import { fmtTime, useNow } from '../ui'
import { HotkeyInput } from './Rules'

const mmss = (ms: number): string => {
  const t = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(t / 60)
  const s = t % 60
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
const num = (n: number): string => n.toLocaleString('ru-RU')
const votesWord = (n: number): string => {
  const a = n % 10
  const b = n % 100
  return a === 1 && b !== 11 ? 'голос' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'голоса' : 'голосов'
}
const PLAT: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', vk: 'VK', kick: 'Kick', goodgame: 'GoodGame', donationalerts: 'DonationAlerts', donatepay: 'DonatePay', donatex: 'DonateX', boosty: 'Boosty', hub: 'Crossember', obs: 'OBS' }
const VIA: Record<string, string> = { chat: 'чат', donation: 'донат', points: 'баллы', manual: 'вручную' }

type Wrap = (p: Promise<unknown>, after?: () => void) => void

export function Vote({ snap }: { snap: HubSnapshot }) {
  const v = snap.vote
  const cfg = snap.settings.vote
  const [kind, setKind] = useState<VoteKind>(() => (v.long?.open && !v.quick ? 'long' : 'quick'))
  const [err, setErr] = useState<string | null>(null)
  const wrap: Wrap = (p, after) => { setErr(null); p.then(() => after?.()).catch((e) => setErr(errText(e))) }
  const poll = kind === 'quick' ? v.quick : v.long
  const tab = (k: VoteKind, label: string): React.ReactElement => {
    const p = k === 'quick' ? v.quick : v.long
    return (
      <button className={kind === k ? 'on' : ''} onClick={() => { setKind(k); setErr(null) }}>
        {label}
        {p?.open && <span className="dot live" />}
        {!!p?.pending.length && <span className="nav-cnt">{p.pending.length}</span>}
      </button>
    )
  }

  return (
    <>
      <div className="head">
        <div>
          <h1>Голосование <Hint id="vote" /></h1>
          <p>Быстрое — на эфир, с таймером. Долгое — между эфирами, на экране появляется иногда.</p>
        </div>
      </div>
      <div className="seg vote-tabs">
        {tab('quick', 'Быстрое')}
        {tab('long', 'Долгое')}
      </div>
      {err && <div className="note err" style={{ marginBottom: 14 }}>{err}</div>}
      {poll ? <PollCard key={poll.id} p={poll} v={v} cfg={cfg} wrap={wrap} /> : <NewPoll key={kind} kind={kind} cfg={cfg} wrap={wrap} />}
      <div className="grid auc-grid">
        <div className="auc-side">
          {poll && poll.source === 'own' && <PendingCard p={poll} wrap={wrap} />}
          {poll && <RecentCard p={poll} />}
          {!poll && <HowCard kind={kind} cfg={cfg} />}
        </div>
        <div className="auc-side">
          <SettingsCard cfg={cfg} v={v} />
          <ArchiveCard v={v} wrap={wrap} />
        </div>
      </div>
    </>
  )
}

// ---------- Новое голосование ----------

function NewPoll({ kind, cfg, wrap }: { kind: VoteKind; cfg: VoteSettings; wrap: Wrap }) {
  const [source, setSource] = useState<'own' | 'twitch'>('own')
  const [title, setTitle] = useState('')
  const [opts, setOpts] = useState<string[]>(['', ''])
  const [sec, setSec] = useState(cfg.defaultSec)
  const [suggest, setSuggest] = useState(kind === 'long')
  const [points, setPoints] = useState(0)
  const tw = kind === 'quick' && source === 'twitch'
  const maxOpts = tw ? 5 : 20
  const maxLen = tw ? 25 : 60
  const filled = opts.map((o) => o.trim()).filter(Boolean)
  const can = tw ? title.trim() && filled.length >= 2 : filled.length > 0 || suggest
  const start = (): void => wrap(window.hub.voteStart({ kind, source: tw ? 'twitch' : 'own', title: title.trim(), options: filled, sec: kind === 'quick' ? sec : 0, suggest: !tw && suggest, twitchPoints: tw ? points : 0 }))

  return (
    <div className="card vote-new">
      <h3>{kind === 'quick' ? 'Новое быстрое голосование' : 'Новое долгое голосование'}</h3>
      {kind === 'quick' && (
        <div className="field">
          <label>Откуда голоса</label>
          <div className="seg">
            <button className={source === 'own' ? 'on' : ''} onClick={() => setSource('own')}>Своё: чат и донаты</button>
            <button className={source === 'twitch' ? 'on' : ''} onClick={() => setSource('twitch')}>Голосование Twitch</button>
          </div>
          {tw && <p className="small muted" style={{ margin: '6px 0 0' }}>Создаётся на самом Twitch — зрители голосуют кнопкой в чате Twitch, голоса приходят сюда. Только для компаньонов и партнёров: 2–5 вариантов до 25 символов, от 15 секунд до 30 минут. Первый раз понадобится заново войти в Twitch (новое разрешение).</p>}
        </div>
      )}
      <div className="field">
        <label>Вопрос{tw ? '' : ' (можно без него)'}</label>
        <input className="input" value={title} maxLength={tw ? 60 : 120} placeholder={kind === 'quick' ? 'Что ответим стражнику?' : 'Следующая игра на стриме'} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Варианты</label>
        <div className="vote-opts-edit">
          {opts.map((o, i) => (
            <div key={i} className="auc-add">
              <span className="vote-num">{i + 1}</span>
              <input className="input" value={o} maxLength={maxLen} placeholder={`Вариант ${i + 1}`}
                onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => { if (e.key === 'Enter' && i === opts.length - 1 && opts.length < maxOpts) setOpts([...opts, '']) }} />
              <button className="btn sm" disabled={opts.length <= 1} title="Убрать" onClick={() => setOpts(opts.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8 }}><button className="btn sm" disabled={opts.length >= maxOpts} onClick={() => setOpts([...opts, ''])}>+ вариант</button></div>
      </div>
      <div className="grid g2" style={{ gap: 10 }}>
        {kind === 'quick' && <NumberField label={tw ? 'Длительность' : 'Таймер (0 — без таймера)'} value={sec} min={tw ? 15 : 0} max={tw ? 1800 : 86_400} suffix="сек" onChange={setSec} />}
        {tw && <NumberField label="Доп. голос за баллы (0 — нет)" value={points} min={0} max={1_000_000} suffix="баллов" onChange={setPoints} />}
      </div>
      {!tw && <Toggle on={suggest} onChange={setSuggest} label={`Зрители могут предлагать варианты${cfg.suggestCmd ? ` (${cfg.suggestCmd} …)` : ''} — через одобрение`} />}
      <div className="btnrow" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={!can} onClick={start}>▶ Начать голосование</button>
        {!can && <span className="small muted">{tw ? 'Нужен вопрос и хотя бы 2 варианта' : 'Добавьте вариант или разрешите предложения зрителей'}</span>}
      </div>
    </div>
  )
}

function HowCard({ kind, cfg }: { kind: VoteKind; cfg: VoteSettings }) {
  return (
    <div className="card">
      <h3>Как голосуют зрители</h3>
      <ul className="vote-how">
        {cfg.chat && <li>Пишут в чат номер («2»), порядковое слово («второй!») или название — {kind === 'long' ? `или командой «${cfg.voteCmd} 2», если одновременно идёт быстрое` : 'на любой площадке'}. Один голос на зрителя, первый окончательный.</li>}
        {cfg.rubPerVote > 0 && <li>Донат с #номером или названием: каждые {num(cfg.rubPerVote)} ₽ — голос, сколько угодно раз.</li>}
        {cfg.pointsReward && <li>Награда «{cfg.pointsReward}» за баллы Twitch: каждые {num(cfg.pointsPerVote)} баллов — голос.</li>}
        {kind === 'long' && <li>На экране долгое появляется {cfg.autoShowMin > 0 ? `само раз в ${cfg.autoShowMin} мин на ${cfg.showSec} с во время эфира, ` : ''}по кнопке{cfg.hotkey ? `, клавише ${cfg.hotkey}` : ''}{cfg.showCmd ? ` и по команде «${cfg.showCmd}»` : ''}.</li>}
      </ul>
    </div>
  )
}

// ---------- Идущее голосование ----------

function PollCard({ p, v, cfg, wrap }: { p: PollView; v: VoteState; cfg: VoteSettings; wrap: Wrap }) {
  const now = useNow(250)
  const [title, setTitle] = useState(p.title)
  const [add, setAdd] = useState('')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => setTitle(p.title), [p.title])
  const own = p.source === 'own'
  const left = p.timer.endsAt ? p.timer.endsAt - now : p.timer.pausedLeft ?? 0
  const hasTimer = !!(p.timer.endsAt || p.timer.pausedLeft)
  const shown = p.kind === 'long' && !!v.showUntil && v.showUntil > now
  const max = Math.max(1, ...p.ranked.map((o) => o.votes))
  const status = p.result ? 'Итог объявлен' : p.timeUp ? 'Время вышло' : p.open ? '● Приём голосов' : 'Приём закрыт'
  const addOpt = (): void => { if (add.trim()) wrap(window.hub.voteOptAdd(p.kind, add.trim()), () => setAdd('')) }

  return (
    <>
      {p.result && (
        <div className="card auc-winner">
          <div className="grow">
            <div className="auc-kicker">{p.result.tie ? 'Ничья' : 'Итог голосования'}</div>
            <div className="auc-wname">{p.result.name}</div>
            <div className="small muted">{num(p.result.votes)} {votesWord(p.result.votes)} из {num(p.total)}{p.title ? ` · ${p.title}` : ''}</div>
          </div>
          {p.kind === 'long' && <button className="btn" onClick={() => wrap(window.hub.voteShow(!shown))}>{shown ? 'Спрятать с экрана' : 'Показать на экране'}</button>}
        </div>
      )}
      <div className="card gw-control">
        <div className="gw-clock-box">
          {p.kind === 'quick' ? (
            <>
              <div className={`auc-clock ${p.timer.endsAt && left < 15_000 ? 'low' : ''} ${!p.timer.endsAt ? 'idle' : ''}`}>{hasTimer ? mmss(left) : p.timeUp ? '00:00' : '—:—'}</div>
              <div className="small muted">{p.source === 'twitch' ? 'голосование Twitch' : p.open ? (p.timer.endsAt ? 'закроется само' : 'без таймера') : status.toLowerCase()}</div>
            </>
          ) : (
            <>
              <div className={`auc-clock ${shown ? '' : 'idle vote-word'}`}>{shown ? mmss((v.showUntil ?? now) - now) : 'скрыто'}</div>
              <div className="small muted">{shown ? 'на экране' : v.nextAutoShow ? `покажется само через ${mmss(v.nextAutoShow - now)}` : cfg.autoShowMin > 0 ? 'само покажется во время эфира' : 'показ — по кнопке'}</div>
            </>
          )}
        </div>
        <div className="auc-ctl">
          <div className="gw-prize">
            <input className="input" value={title} maxLength={120} disabled={!own} placeholder="Вопрос (можно без него)" onChange={(e) => setTitle(e.target.value)}
              onBlur={() => { if (title.trim() !== p.title) wrap(window.hub.voteTitle(p.kind, title.trim())) }} />
          </div>
          <div className="btnrow">
            {p.open && <button className="btn primary" onClick={() => wrap(window.hub.voteFinish(p.kind))}>■ Завершить и показать итог</button>}
            {own && !p.result && <button className="btn" onClick={() => wrap(window.hub.voteOpen(p.kind, !p.open))}>{p.open ? 'Пауза' : 'Продолжить приём'}</button>}
            {own && p.kind === 'quick' && !p.result && (
              <>
                <button className="btn" onClick={() => wrap(window.hub.voteTimer('add', 30))}>+30 с</button>
                <button className="btn" disabled={!hasTimer} onClick={() => wrap(window.hub.voteTimer('sub', 30))}>−30 с</button>
              </>
            )}
            {p.kind === 'long' && !p.result && <button className="btn" onClick={() => wrap(window.hub.voteShow(!shown))}>{shown ? 'Спрятать' : `Показать на ${cfg.showSec} с`}</button>}
          </div>
          <div className="btnrow">
            {own && <Toggle on={p.suggest} onChange={(x) => wrap(window.hub.voteSuggest(p.kind, x))} label="Предложения зрителей" />}
            <span className="grow" />
            {confirm ? (
              <>
                <button className="btn" style={{ borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.voteClose(p.kind), () => setConfirm(false))}>{p.open ? 'Да, закрыть без итога' : 'Да, убрать'}</button>
                <button className="btn" onClick={() => setConfirm(false)}>Отмена</button>
              </>
            ) : <button className="btn" onClick={() => setConfirm(true)} title="Голосование уйдёт в архив и пропадёт с экрана">{p.result ? 'Новое голосование' : 'Закрыть'}</button>}
          </div>
        </div>
        <div className="auc-stats">
          <div><b>{num(p.total)}</b><span>{votesWord(p.total)}</span></div>
          {own && <div><b>{num(p.chatVoters)}</b><span>в чате</span></div>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <h3>Варианты <span className="r chip">{p.options.length}</span></h3>
        {!p.options.length && <p className="small muted" style={{ margin: '0 0 10px' }}>Вариантов пока нет — добавьте свои или одобрите предложения зрителей.</p>}
        {p.ranked.map((o, i) => <OptionRow key={o.id} p={p} o={o} lead={i === 0 && o.votes > 0} max={max} wrap={wrap} />)}
        {own && (
          <div className="auc-add" style={{ marginTop: 12 }}>
            <input className="input" value={add} maxLength={60} placeholder="Новый вариант" onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addOpt() }} />
            <button className="btn" disabled={!add.trim()} onClick={addOpt}>Добавить</button>
          </div>
        )}
      </div>
    </>
  )
}

function OptionRow({ p, o, lead, max, wrap }: { p: PollView; o: PollView['ranked'][number]; lead: boolean; max: number; wrap: Wrap }) {
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState(o.name)
  const [n, setN] = useState('')
  const [del, setDel] = useState(false)
  const own = p.source === 'own'
  const pct = p.total > 0 ? Math.round((o.votes / p.total) * 1000) / 10 : 0
  const parts = [o.chat && `чат ${num(o.chat)}`, o.paid && `донаты и баллы ${num(o.paid)}`, o.tw && `Twitch ${num(o.tw)}`].filter(Boolean).join(' · ')
  return (
    <div className="auc-lot">
      <div className="auc-lot-line" onClick={() => own && setEdit(!edit)} style={own ? undefined : { cursor: 'default' }}>
        <span className="vote-num">{o.num}</span>
        <div className="grow">
          <div className="auc-lot-name"><b className="ellipsis">{o.name}</b></div>
          <div className="auc-bar"><div className={lead ? 'lead' : ''} style={{ width: `${(o.votes / max) * 100}%` }} /></div>
        </div>
        <div className="auc-sum vote-sum"><b>{num(o.votes)}</b><span>{pct.toLocaleString('ru-RU')}%{parts ? ` · ${parts}` : ''}</span></div>
      </div>
      {edit && own && (
        <div className="auc-lot-edit">
          <div className="auc-add">
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <button className="btn sm" disabled={!name.trim() || name.trim() === o.name} onClick={() => wrap(window.hub.voteOptRename(p.kind, o.id, name.trim()))}>Переименовать</button>
          </div>
          <div className="auc-add" style={{ marginTop: 8 }}>
            <input className="input mono" value={n} inputMode="numeric" placeholder="голосов: 5 или −2" onChange={(e) => setN(e.target.value.replace(/[^\d-]/g, '').slice(0, 8))} />
            <button className="btn sm" disabled={!Number(n)} onClick={() => wrap(window.hub.voteOptVotes(p.kind, o.id, Number(n)), () => setN(''))} title="Например, донат наличными или поправить ошибку">Добавить голоса вручную</button>
            {del ? (
              <>
                <button className="btn sm" style={{ borderColor: '#ff7a84', color: '#ff7a84' }} onClick={() => wrap(window.hub.voteOptRemove(p.kind, o.id))}>Да, удалить с голосами</button>
                <button className="btn sm" onClick={() => setDel(false)}>Отмена</button>
              </>
            ) : <button className="btn sm" onClick={() => setDel(true)}>Удалить</button>}
          </div>
        </div>
      )}
    </div>
  )
}

function PendingCard({ p, wrap }: { p: PollView; wrap: Wrap }) {
  if (!p.suggest && !p.pending.length) return null
  return (
    <div className="card">
      <h3>Предложения зрителей <Hint id="voteQueue" /> {p.pending.length > 0 && <span className="r chip auc-warn">{p.pending.length}</span>}</h3>
      {!p.pending.length && <p className="small muted" style={{ margin: 0 }}>Пока пусто. Предложения появятся здесь и будут ждать вашего решения.</p>}
      {p.pending.map((x) => <PendingRow key={x.id} p={p} x={x} wrap={wrap} />)}
    </div>
  )
}

function PendingRow({ p, x, wrap }: { p: PollView; x: PollView['pending'][number]; wrap: Wrap }) {
  const [name, setName] = useState(x.text)
  const [into, setInto] = useState('')
  return (
    <div className="auc-bet">
      <div className="auc-bet-head">
        <b className="ellipsis">{x.user}</b>
        <span className="small muted">{PLAT[x.platform] ?? x.platform} · {VIA[x.via]}{x.raw ? ` · ${x.raw}` : ''}{x.weight > 0 ? ` · +${num(x.weight)} ${votesWord(x.weight)}` : ''}</span>
        <span className="grow" />
        <span className="small muted">{fmtTime(x.ts)}</span>
      </div>
      <div className="auc-add">
        <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button className="btn sm primary" disabled={!name.trim()} onClick={() => wrap(window.hub.voteApprove(p.kind, x.id, name.trim()))}>Добавить</button>
      </div>
      <div className="auc-add">
        {p.options.length > 0 && (
          <>
            <select className="input" value={into} onChange={(e) => setInto(e.target.value)}>
              <option value="">— в существующий вариант —</option>
              {p.options.map((o) => <option key={o.id} value={o.id}>{o.num}. {o.name}</option>)}
            </select>
            <button className="btn sm" disabled={!into} onClick={() => wrap(window.hub.voteApprove(p.kind, x.id, undefined, into))}>В вариант</button>
          </>
        )}
        <button className="btn sm" onClick={() => wrap(window.hub.voteReject(p.kind, x.id))}>Отклонить</button>
      </div>
    </div>
  )
}

function RecentCard({ p }: { p: PollView }) {
  return (
    <div className="card">
      <h3>Последние голоса</h3>
      {!p.recent.length && <p className="small muted" style={{ margin: 0 }}>{p.source === 'twitch' ? 'Twitch присылает только итоги по вариантам, без ников.' : 'Пока никто не голосовал.'}</p>}
      <div className="auc-history">
        {p.recent.map((r, i) => (
          <div key={i} className="goal-top-row">
            <span className="grow ellipsis">{r.user}<span className="small muted"> · {PLAT[r.platform] ?? r.platform} · {VIA[r.via]}</span></span>
            <span className="small muted">{fmtTime(r.ts)}</span>
            <b style={{ fontFamily: 'var(--f-text)', minWidth: 70, textAlign: 'right' }}>№{r.num}{r.weight !== 1 ? ` · ${r.weight > 0 ? '+' : ''}${num(r.weight)}` : ''}</b>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- Настройки и архив ----------

function TextSetting({ label, value, max, placeholder, onSave }: { label: string; value: string; max: number; placeholder?: string; onSave: (v: string) => void }) {
  const [x, setX] = useState(value)
  useEffect(() => setX(value), [value])
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input" value={x} maxLength={max} placeholder={placeholder} onChange={(e) => setX(e.target.value)} onBlur={() => { if (x.trim() !== value) onSave(x.trim()) }} />
    </div>
  )
}

function SettingsCard({ cfg, v }: { cfg: VoteSettings; v: VoteState }) {
  const set = (p: Partial<VoteSettings>): void => void window.hub.setSettings({ vote: p })
  return (
    <div className="card">
      <h3>Правила голосования</h3>
      <div className="vote-sep">Голоса</div>
      <Toggle on={cfg.chat} onChange={(x) => set({ chat: x })} label="Голоса из чата (1 на зрителя, первый окончательный)" />
      <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
        <NumberField label="Голос за каждые, ₽ (0 — донаты не считаются)" value={cfg.rubPerVote} min={0} max={10_000_000} suffix="₽" onChange={(x) => set({ rubPerVote: x })} />
        <TextSetting label="Команда голоса за долгое" value={cfg.voteCmd} max={30} onSave={(x) => set({ voteCmd: x })} />
        <TextSetting label="Награда за баллы — голоса" value={cfg.pointsReward} max={45} placeholder="Название награды Twitch" onSave={(x) => set({ pointsReward: x })} />
        <NumberField label="Голос за каждые, баллов" value={cfg.pointsPerVote} min={1} max={10_000_000} suffix="баллов" onChange={(x) => set({ pointsPerVote: x })} />
      </div>
      <div className="vote-sep">Предложения зрителей</div>
      <div className="grid g2" style={{ gap: 10 }}>
        <TextSetting label="Команда (пусто — выкл.)" value={cfg.suggestCmd} max={30} onSave={(x) => set({ suggestCmd: x })} />
        <TextSetting label="Награда за баллы — предложить" value={cfg.suggestReward} max={45} placeholder="Название награды Twitch" onSave={(x) => set({ suggestReward: x })} />
        <NumberField label="Донат от, ₽ (0 — нет)" value={cfg.suggestDonMin} min={0} max={10_000_000} suffix="₽" onChange={(x) => set({ suggestDonMin: x })} />
      </div>
      <div className="vote-sep">Долгое на экране</div>
      <div className="grid g2" style={{ gap: 10 }}>
        <NumberField label="Само раз в (0 — нет)" value={cfg.autoShowMin} min={0} max={600} suffix="мин" onChange={(x) => set({ autoShowMin: x })} />
        <NumberField label="Показывать" value={cfg.showSec} min={5} max={600} suffix="сек" onChange={(x) => set({ showSec: x })} />
        <TextSetting label="Команда зрителей (пусто — выкл.)" value={cfg.showCmd} max={30} onSave={(x) => set({ showCmd: x })} />
        <NumberField label="Кулдаун команды (на всех)" value={cfg.showCooldownSec} min={0} max={3600} suffix="сек" onChange={(x) => set({ showCooldownSec: x })} />
      </div>
      <div className="field">
        <label>Горячая клавиша «показать / спрятать»</label>
        <HotkeyInput value={cfg.hotkey} onChange={(x) => set({ hotkey: x })} />
        {v.hotkeyError && <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>Не работает: {v.hotkeyError}</div>}
      </div>
      <div className="vote-sep">Быстрое</div>
      <NumberField label="Таймер по умолчанию (0 — без таймера)" value={cfg.defaultSec} min={0} max={86_400} suffix="сек" onChange={(x) => set({ defaultSec: x })} />
      <div className="vote-sep">Чат</div>
      <Toggle on={cfg.announce} onChange={(x) => set({ announce: x })} label="Писать в чат о старте и итоге" />
      {cfg.announce && (
        <>
          <TextSetting label="При старте" value={cfg.startText} max={300} onSave={(x) => set({ startText: x })} />
          <TextSetting label="Итог" value={cfg.winText} max={300} onSave={(x) => set({ winText: x })} />
          <p className="small muted" style={{ margin: 0 }}>Подстановки: {'{вопрос}'}, {'{варианты}'}, {'{победитель}'}, {'{голоса}'}. О старте голосования Twitch не пишем — Twitch показывает его сам.</p>
        </>
      )}
    </div>
  )
}

function ArchiveCard({ v, wrap }: { v: VoteState; wrap: Wrap }) {
  if (!v.archive.length) return null
  return (
    <div className="card">
      <h3>Прошлые голосования <button className="r btn sm" onClick={() => wrap(window.hub.voteClearArchive())}>Очистить</button></h3>
      {v.archive.map((x, i) => (
        <div key={i} className="goal-top-row">
          <span className="grow ellipsis">{x.title || (x.kind === 'long' ? 'Долгое голосование' : 'Голосование')}<span className="small muted"> · {new Date(x.ts).toLocaleDateString('ru-RU')} · {num(x.total)} {votesWord(x.total)}{x.source === 'twitch' ? ' · Twitch' : ''}</span></span>
          <b style={{ fontFamily: 'var(--f-text)' }}>{x.winner ?? '—'}</b>
        </div>
      ))}
    </div>
  )
}
