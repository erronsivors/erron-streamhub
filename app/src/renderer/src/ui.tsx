import { useEffect, useState } from 'react'
import type { HubEvent, Platform } from '../../main/core/types'

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function fmtAgo(ts: number, now: number): string {
  const s = Math.floor((now - ts) / 1000)
  if (s < 30) return 'сейчас'
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} мин`
  if (s < 86400) return `${Math.floor(s / 3600)} ч`
  return new Date(ts).toLocaleDateString('ru-RU')
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU')
}

export const PLATFORM: Record<Platform, { short: string; color: string }> = {
  twitch: { short: 'Tw', color: '#9146ff' },
  youtube: { short: 'YT', color: '#ff0033' },
  vk: { short: 'VK', color: '#0077ff' },
  kick: { short: 'K', color: '#29b32b' },
  goodgame: { short: 'GG', color: '#233056' },
  donationalerts: { short: 'DA', color: '#f57d07' },
  donatepay: { short: 'DP', color: '#2a9d8f' },
  donatex: { short: 'DX', color: '#7b5cff' },
  boosty: { short: 'B', color: '#f15f2c' },
  obs: { short: 'OBS', color: '#302e31' },
  hub: { short: 'H', color: '#9a3fd6' }
}

const PLATFORM_NAME: Partial<Record<Platform, string>> = {
  twitch: 'Twitch', youtube: 'YouTube', vk: 'VK Видео Live', kick: 'Kick', goodgame: 'GoodGame',
  donationalerts: 'DonationAlerts', donatepay: 'DonatePay', donatex: 'DonateX', boosty: 'Boosty'
}

export function PlatIcon({ p }: { p: Platform }) {
  const d = PLATFORM[p]
  return (
    <span className="plat" style={{ background: d.color, fontSize: d.short.length > 2 ? 11 : 14 }}>
      {d.short}
    </span>
  )
}

const TYPE_LABEL: Record<HubEvent['type'], string> = {
  message: 'сообщение', donation: 'донат', follow: 'фоллоу', sub: 'подписка', gift: 'подарочная подписка',
  raid: 'рейд', bits: 'биты', reward: 'награда', system: 'система'
}
const TYPE_ICO: Record<HubEvent['type'], string> = {
  message: '💬', donation: '₽', follow: '♥', sub: '★', gift: '🎁', raid: '↗', bits: '◆', reward: '✦', system: 'i'
}

export function EventRow({ e, now, onReplay }: { e: HubEvent; now: number; onReplay?: () => void }) {
  const amount = e.type === 'donation' && e.amount ? ` · ${e.amount.toLocaleString('ru-RU')} ${e.currency === 'RUB' ? '₽' : e.currency ?? ''}` : ''
  return (
    <div className="row">
      <span className="ico" style={{ color: 'var(--light)' }}>{TYPE_ICO[e.type]}</span>
      <div className="grow">
        <b className="ellipsis">
          {e.user} · {TYPE_LABEL[e.type]}{amount} {e.test && <span className="tag test">ТЕСТ</span>}
        </b>
        <span className="small muted ellipsis" style={{ display: 'block' }}>{e.text || PLATFORM_NAME[e.platform] || e.platform}</span>
      </div>
      <span className="small muted">{fmtAgo(e.ts, now)}</span>
      {onReplay && <button className="btn sm" style={{ marginLeft: 8 }} title="Показать алерт ещё раз" onClick={onReplay}>↻</button>}
    </div>
  )
}
