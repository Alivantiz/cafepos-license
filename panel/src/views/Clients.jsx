// Список клиентов. Прежняя панель показывала имя, срок и кнопки; узнать,
// торгует ли заведение и сколько, было негде. Теперь в строке — живое:
// выручка за неделю, средний чек, когда последняя продажа.
import { useMemo, useState } from 'react'
import { daysLeft, daysAgo, fmtDate, money, agoText } from '../api'
import { Tag, Spark } from '../ui'

const status = (c) => {
  if (c.kind === 'trial') return { tone: 'warn', text: 'проба' }
  if (c.revoked) return { tone: 'bad', text: 'отозвана' }
  const d = daysLeft(c.expires_at)
  if (d === null) return { tone: 'ok', text: 'бессрочная' }
  if (d <= 0) return { tone: 'bad', text: 'истекла' }
  if (d <= 14) return { tone: 'warn', text: `${d} дн` }
  return { tone: 'ok', text: fmtDate(c.expires_at) }
}

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'live', label: 'Платящие' },
  { id: 'trial', label: 'Проба' },
  { id: 'silent', label: 'Молчат' },
  { id: 'expiring', label: 'Истекают' },
  { id: 'hidden', label: 'Скрытые' },
]

export default function Clients({ data, onOpen, onIssue }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState({ col: 'revenue7', dir: 'desc' })

  const all = useMemo(
    () => [...(data.licenses || []), ...(data.trials || [])],
    [data])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let list = all.filter(c => {
      if (needle && !((c.customer || '') + ' ' + (c.contact || '') + ' ' + (c.machine_id || '') + ' ' + c.subject)
        .toLowerCase().includes(needle)) return false
      const d = daysLeft(c.expires_at)
      // Скрытые видны только в своём фильтре — за этим их и скрывали.
      if (filter === 'hidden') return !!c.hidden
      if (c.hidden) return false
      if (filter === 'live') return c.kind === 'license' && !c.revoked && (d === null || d > 0)
      if (filter === 'trial') return c.kind === 'trial'
      if (filter === 'silent') return c.telemetry && (daysAgo(c.last_sale_at) ?? 99) >= 3
      if (filter === 'expiring') return c.kind === 'license' && !c.revoked && d !== null && d <= 14
      return true
    })
    const val = (c) => {
      if (sort.col === 'name') return (c.customer || c.machine_id || '').toLowerCase()
      if (sort.col === 'expires') return c.expires_at ? new Date(c.expires_at).getTime() : 8.64e15
      if (sort.col === 'sale') return c.last_sale_at ? new Date(c.last_sale_at).getTime() : 0
      return c[sort.col] || 0
    }
    return list.sort((a, b) => {
      const x = val(a), y = val(b)
      const r = x < y ? -1 : x > y ? 1 : 0
      return sort.dir === 'asc' ? r : -r
    })
  }, [all, q, filter, sort])

  const th = (col, label, num) => (
    <th className={'sortable' + (num ? ' num' : '')} onClick={() =>
      setSort(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'desc' })}>
      {label}{sort.col === col ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <input placeholder="Имя, код компьютера…" value={q} onChange={e => setQ(e.target.value)}
          style={{ maxWidth: 260 }} />
        {FILTERS.map(f => (
          <button key={f.id} className={'btn sm' + (filter === f.id ? ' pri' : '')}
            onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
        <button className="btn pri spacer" onClick={onIssue}>Выпустить лицензию</button>
      </div>

      <div className="card" style={{ padding: '14px 4px 4px' }}>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                {th('name', 'Клиент')}
                <th>Статус</th>
                {th('revenue7', 'Выручка 7 дн', true)}
                <th className="num">Динамика</th>
                {th('avgCheck', 'Средний чек', true)}
                {th('sale', 'Последняя продажа', true)}
                <th className="num">Касс</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(c => <Row key={c.subject} c={c} onOpen={onOpen} />)}
            </tbody>
          </table>
        </div>
        {!rows.length && <div className="empty">Никого не нашлось</div>}
      </div>
    </>
  )
}

function Row({ c, onOpen }) {
  const s = status(c)
  const grow = c.prevRevenue7 > 0 ? Math.round((c.revenue7 - c.prevRevenue7) / c.prevRevenue7 * 100) : null
  const stale = (daysAgo(c.last_sale_at) ?? 99) >= 3
  return (
    <tr onClick={() => onOpen(c)}>
      <td>
        <div className="name">{c.customer || c.machine_id || c.subject}</div>
        <div className="muted2">
          {/* Телефон прямо в строке: сводка зовёт позвонить — значит номер
              должен быть виден, не спрятан на два клика вглубь. */}
          {c.contact ? c.contact + ' · ' : ''}
          {c.kind === 'trial' ? 'пробная установка' : (c.machine_id ? 'активирована' : 'не активирована')}
        </div>
      </td>
      <td><Tag tone={s.tone}>{s.text}</Tag></td>
      {/* Телеметрия приходит только с версий, где она есть. Пустой график —
          это «нечего показать», и так и надо писать, а не рисовать ноль. */}
      {!c.telemetry ? (
        <td colSpan={5} className="muted2">данных нет — касса на старой версии</td>
      ) : (
        <>
          <td className="num">{money(c.revenue7, true)}</td>
          <td className="num">
            <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              {grow !== null && (
                <span className="muted2" style={{ color: grow >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
                  {grow >= 0 ? '+' : ''}{grow}%
                </span>
              )}
              <Spark days={(c.days || []).slice(-30)} />
            </div>
          </td>
          <td className="num">{c.avgCheck ? money(c.avgCheck) : '—'}</td>
          <td className="num" style={stale ? { color: 'var(--bad)' } : undefined}>{agoText(c.last_sale_at)}</td>
          <td className="num muted">{c.registers ?? '—'}</td>
        </>
      )}
    </tr>
  )
}
