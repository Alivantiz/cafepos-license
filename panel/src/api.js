// Один вход в API панели. Пароль лежит в localStorage и уходит заголовком —
// тот же механизм, что был в старой странице, менять его незачем.
import { useEffect, useState, useCallback } from 'react'

export const pw = () => localStorage.getItem('panel_pw') || ''
export const setPw = (v) => localStorage.setItem('panel_pw', v)
export const logout = () => { localStorage.removeItem('panel_pw'); location.reload() }

export async function api(path, body, opts) {
  let r
  try {
    r = await fetch('/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-panel-key': pw() },
      body: JSON.stringify(body || {}),
    })
  } catch {
    // Браузерное «Failed to fetch» не говорит владельцу ничего и выглядит как
    // поломка вкладки. На деле это оборванное соединение: связь пропала или
    // сервер не смог ответить на этот запрос.
    throw new Error('Сервер не ответил — проверьте связь и обновите страницу')
  }
  const d = await r.json().catch(() => ({}))
  // 401 — пароль сменили или он неверен: выкидываем на экран входа сразу,
  // иначе панель молча показывала бы пустые списки.
  //
  // Кроме самого экрана входа (noReload): там перезагрузка съедала сообщение
  // об ошибке — страница моргала, поле пустело, причина не называлась.
  if (r.status === 401) {
    localStorage.removeItem('panel_pw')
    if (!opts?.noReload) location.reload()
    throw new Error('Неверный пароль')
  }
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status))
  return d
}

/**
 * Загрузка с состоянием. reload() — перечитать после действия.
 *
 * enabled=false — не ходить на сервер вовсе. Нужно, чтобы открытие панели не
 * тянуло данные ВСЕХ вкладок разом: список клиентов с дневными итогами самый
 * тяжёлый запрос, а на «Каталоге» или «Заявках» он не нужен ни для чего.
 */
export function useApi(path, body, enabled = true) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(enabled)
  const [at, setAt] = useState(null)     // когда данные последний раз доехали
  const key = JSON.stringify(body || {})
  const reload = useCallback(() => {
    if (!enabled) return
    setLoading(true)
    api(path, JSON.parse(key))
      .then(d => { setData(d); setError(null); setAt(Date.now()) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [path, key, enabled])
  useEffect(() => { reload() }, [reload])
  return { data, error, loading, reload, at }
}

// ── Форматирование ────────────────────────────────────────────────────
export const fmtDate = (s) => s ? new Date(s).toLocaleDateString('ru-RU') : '—'
export const daysLeft = (s) => s ? Math.ceil((new Date(s) - Date.now()) / 86400000) : null
export const daysAgo = (s) => s ? Math.floor((Date.now() - new Date(s)) / 86400000) : null

// Живая лицензия. Общий предикат для сводки и списка: плитки сводки
// кликабельные и ведут в «Клиенты» с фильтром — если считать по-разному,
// плитка обещает одно число, а список показывает другое.
export const isLive = (c) =>
  c.kind !== 'trial' && !c.revoked && (c.expires_at === null || daysLeft(c.expires_at) > 0)

/** Тенге без копеек. Крупные суммы сокращаем — в таблице важен порядок,
 *  а не точная цифра; точная видна в карточке. */
export function money(n, short = false) {
  const v = Math.round(Number(n) || 0)
  // Порог сокращения — миллион, а не десять тысяч: раньше в одной колонке
  // оказывались «9 999 ₸» и «12 тыс ₸», и сравнить их глазами было нельзя.
  // Разряды и у сокращённых сумм разделяем так же, как у полных.
  if (short && Math.abs(v) >= 1_000_000) {
    return (v / 1_000_000).toFixed(1).replace('.0', '').replace('.', ',') + ' млн ₸'
  }
  return v.toLocaleString('ru-RU') + ' ₸'
}

// empty — что писать, когда даты нет. По умолчанию «связи не было», но у
// последней ПРОДАЖИ пустая дата чаще значит другое: касса на связи и исправно
// шлёт итоги, просто ещё ничего не продала. Одним текстом на оба случая панель
// врала — и сама себе противоречила подписью «ни одной продажи».
export function agoText(s, empty = 'связи не было') {
  const d = daysAgo(s)
  if (d === null) return empty
  if (d === 0) return 'сегодня'
  if (d === 1) return 'вчера'
  return d + ' дн назад'
}
