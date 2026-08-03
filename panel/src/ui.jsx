// Мелкие кирпичики панели. Своя графика вместо библиотеки: линия по тридцати
// точкам — это два десятка строк, а библиотека тянет сотни килобайт в бандл.
import { useEffect, useState } from 'react'
import { money } from './api'

export function Tile({ label, value, hint, tone }) {
  return (
    <div className="card">
      <div className="tile-label">{label}</div>
      <div className="tile-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  )
}

export function Tag({ tone, children }) {
  return <span className={'tag' + (tone ? ' ' + tone : '')}><i className="dot" />{children}</span>
}

/** Линия выручки по дням. days: [{day, revenue}] уже отсортированы по дате. */
export function Chart({ days, height = 160 }) {
  if (!days || days.length < 2) return <div className="empty">Мало данных для графика</div>
  const w = 600, h = height, pad = 4
  const max = Math.max(...days.map(d => d.revenue), 1)
  const x = i => pad + (i * (w - pad * 2)) / (days.length - 1)
  const y = v => h - pad - (v / max) * (h - pad * 2 - 14)
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.revenue).toFixed(1)}`).join(' ')
  const area = `${line} L${x(days.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
      aria-label={`Выручка по дням, максимум ${money(max)}`}>
      <path d={area} fill="var(--accent)" opacity=".12" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2"
        vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={x(days.length - 1)} cy={y(days[days.length - 1].revenue)} r="3.5" fill="var(--accent)" />
    </svg>
  )
}

/** Та же линия, но в размер ячейки таблицы. */
export function Spark({ days }) {
  if (!days || days.length < 2) return <span className="muted2">—</span>
  const w = 84, h = 22
  const max = Math.max(...days.map(d => d.revenue), 1)
  const pts = days.map((d, i) =>
    `${(i * w / (days.length - 1)).toFixed(1)},${(h - 2 - (d.revenue / max) * (h - 4)).toFixed(1)}`)
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5"
        vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

// ── Тосты ─────────────────────────────────────────────────────────────
let push = () => {}
export const toast = {
  ok: (m) => push(m, false),
  err: (m) => push(m, true),
}
export function Toasts() {
  const [items, setItems] = useState([])
  useEffect(() => {
    push = (text, err) => {
      const id = Date.now() + Math.random()
      setItems(v => [...v, { id, text, err }])
      setTimeout(() => setItems(v => v.filter(t => t.id !== id)), 3400)
    }
  }, [])
  return (
    <div className="toasts">
      {items.map(t => <div key={t.id} className={'toast' + (t.err ? ' err' : '')}>{t.text}</div>)}
    </div>
  )
}
