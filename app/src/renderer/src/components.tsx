import { createContext, useContext, useState, type ReactNode } from 'react'
import type { SetupMode, Theme } from '../../main/core/settings'
import { hintText } from './hints'

export const ModeContext = createContext<SetupMode | null>(null)

/** Значок «!» с всплывающей подсказкой (наведение или фокус с клавиатуры). */
export function Hint({ id }: { id: string }) {
  const mode = useContext(ModeContext)
  const h = hintText(id, mode)
  if (!h) return null
  return (
    <span className="hint" tabIndex={0} aria-label={`Подсказка: ${h.title}`}>
      !
      <span className="hint-pop" role="tooltip">
        <b>{h.title}</b>
        {h.body}
      </span>
    </span>
  )
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="sw" />
      <span>{label}</span>
    </label>
  )
}

export function ThemePicker({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="seg">
      <button className={value === 'general' ? 'on' : ''} onClick={() => onChange('general')}>Общий</button>
      <button className={value === 'campfire' ? 'on' : ''} onClick={() => onChange('campfire')}>У костра</button>
    </div>
  )
}

export function NumberField({ label, value, min, max, onChange, suffix }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string }) {
  const [v, setV] = useState(String(value))
  return (
    <div className="field">
      <label>{label}</label>
      <div className="numrow">
        <input
          className="input mono"
          type="number"
          min={min}
          max={max}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => {
            const n = Math.min(max, Math.max(min, Number(v) || min))
            setV(String(n))
            if (n !== value) onChange(n)
          }}
        />
        {suffix && <span className="muted small">{suffix}</span>}
      </div>
    </div>
  )
}

/** Превращает «Error invoking remote method 'x': Error: текст» в «текст». */
export function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
