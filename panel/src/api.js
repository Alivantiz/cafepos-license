// Один вход в API панели. Пароль лежит в localStorage и уходит заголовком —
// тот же механизм, что был в старой странице, менять его незачем.
import { useEffect, useState, useCallback } from 'react'

export const pw = () => localStorage.getItem('panel_pw') || ''
export const setPw = (v) => localStorage.setItem('panel_pw', v)
export const logout = () => { localStorage.removeItem('panel_pw'); location.reload() }

export async function api(path, body) {
  const r = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-panel-key': pw() },
    body: JSON.stringify(body || {}),
  })
  const d = await r.json().catch(() => ({}))
  // 401 — пароль сменили или он неверен: выкидываем на экран входа сразу,
  // иначе панель молча показывала бы пустые списки.
  if (r.status === 401) { localStorage.removeItem('panel_pw'); location.reload(); throw new Error('Неверный пароль') }
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status))
  return d
}

/** Загрузка с состоянием. reload() — перечитать после действия. */
export function useApi(path, body) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [at, setAt] = useState(null)     // когда данные последний раз доехали
  const key = JSON.stringify(body || {})
  const reload = useCallback(() => {
    setLoading(true)
    api(path, JSON.parse(key))
      .then(d => { setData(d); setError(null); setAt(Date.now()) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [path, key])
  useEffect(() => { reload() }, [reload])
  return { data, error, loading, reload, at }
}

// ── Форматирование ────────────────────────────────────────────────────
export const fmtDate = (s) => s ? new Date(s).toLocaleDateString('ru-RU') : '—'
export const daysLeft = (s) => s ? Math.ceil((new Date(s) - Date.now()) / 86400000) : null
export const daysAgo = (s) => s ? Math.floor((Date.now() - new Date(s)) / 86400000) : null

/** Тенге без копеек. Крупные суммы сокращаем — в таблице важен порядок,
 *  а не точная цифра; точная видна в карточке. */
export function money(n, short = false) {
  const v = Math.round(Number(n) || 0)
  if (short && Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace('.0', '') + ' млн ₸'
  if (short && Math.abs(v) >= 10_000) return Math.round(v / 1000) + ' тыс ₸'
  return v.toLocaleString('ru-RU') + ' ₸'
}

export function agoText(s) {
  const d = daysAgo(s)
  if (d === null) return 'связи не было'
  if (d === 0) return 'сегодня'
  if (d === 1) return 'вчера'
  return d + ' дн назад'
}
