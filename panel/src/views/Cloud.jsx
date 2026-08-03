import { useEffect } from 'react'
// Живы ли облачные функции, с которыми говорит касса. Панель читает таблицы,
// и лежачая функция снаружи неотличима от «клиентов нет» — однажды уже вышло
// боком: trial не была выложена, таблица оставалась пустой, и это читалось
// как «демо никто не ставит».
import { useApi } from '../api'
import { Tag } from '../ui'

export const brokenCount = (rows) => (rows || []).filter(r => !r.ok).length

export default function Cloud({ onReload }) {
  const { data, error, loading, reload } = useApi('cloud')
  useEffect(() => { onReload?.(() => reload) }, [reload, onReload])
  if (error) return <div className="card" style={{ borderColor: 'var(--bad)' }}>{error}</div>
  if (loading && !data) return <div className="empty">Опрашиваю функции…</div>
  const rows = data?.rows || []
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
      {rows.map(r => (
        <div className="card" key={r.name} style={r.ok ? undefined : { borderColor: 'var(--bad)' }}>
          <div className="row">
            <b style={{ fontFamily: 'ui-monospace, monospace' }}>{r.name}</b>
            <Tag tone={r.ok ? 'ok' : 'bad'}>{r.ok ? 'работает' : 'не работает'}</Tag>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>{r.what}</div>
          <div className="muted2" style={{ marginTop: 4 }}>
            {r.verdict}{r.version ? ` · версия ${r.version}` : ''}
          </div>
        </div>
      ))}
    </div>
  )
}
