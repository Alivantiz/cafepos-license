import { useEffect } from 'react'
// Разбор ИИ-распознаваний накладных: фото, что распозналось, и решение —
// «разобрано» (фото удаляется) или «удалить целиком».
import { api, useApi } from '../api'
import { toast, confirmDialog } from '../ui'

export default function Invoices({ onReload }) {
  const { data, error, loading, reload } = useApi('invoices/pending')
  useEffect(() => { onReload?.(() => reload) }, [reload, onReload])
  const rows = data?.rows || []

  const review = async (id) => {
    try { await api('invoices/review', { id: Number(id) }); toast.ok('Разобрано — фото удалено'); reload() }
    catch (e) { toast.err(e.message) }
  }
  const remove = async (id) => {
    if (!await confirmDialog({
      title: 'Удалить распознавание',
      message: 'Запись и фото накладной будут удалены без возможности вернуть.',
      confirmText: 'Удалить',
    })) return
    try { await api('invoices/delete', { id: Number(id) }); toast.ok('Удалено'); reload() }
    catch (e) { toast.err(e.message) }
  }

  if (error) return <div className="card" style={{ borderColor: 'var(--bad)' }}>{error}</div>
  if (loading && !data) return <div className="empty">Загрузка…</div>
  if (!rows.length) return <div className="empty">Неразобранных накладных нет</div>

  return (
    <>
      {data?.total != null && (
        <div className="muted2" style={{ marginBottom: 10 }}>показано {rows.length} из {data.total}</div>
      )}
      {rows.map(r => (
        <div className="card" key={r.id} style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <b>{r.supplier || 'Без поставщика'}</b>
            <span className="muted2">
              {r.item_count || 0} поз. · {r.created_at
                ? new Date(r.created_at).toLocaleString('ru-RU',
                  { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                : ''}
              {r.model ? ` · ${r.model}` : ''}
            </span>
          </div>
          <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
            {r.image_b64
              ? <img alt="Фото накладной" src={`data:${r.image_mime || 'image/jpeg'};base64,${r.image_b64}`}
                style={{ maxWidth: 260, maxHeight: 360, borderRadius: 8, objectFit: 'contain' }} />
              : <div className="muted2">фото удалено</div>}
            <div style={{ flex: 1, minWidth: 220 }}>
              {(r.items || []).map((it, i) => (
                <div key={i} className="row" style={{
                  justifyContent: 'space-between', gap: 12, padding: '4px 0',
                  borderBottom: '1px solid var(--line)', fontSize: 13,
                }}>
                  <span>
                    {it.name || ''}
                    {/* Кратность упаковки — то, из-за чего чаще всего ошибается
                        приёмка: показываем её отдельно и заметно. */}
                    {it.pack_size > 1 && <b style={{ color: 'var(--accent)' }}> ×{it.pack_size}</b>}
                  </span>
                  <span className="muted2" style={{ whiteSpace: 'nowrap' }}>
                    {it.quantity ?? it.qty ?? ''}{it.unit ? ' ' + it.unit : ''}
                    {it.price != null ? ' · ' + it.price : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn pri" onClick={() => review(r.id)}>Разобрано</button>
            <button className="btn ghost" onClick={() => remove(r.id)}>Удалить</button>
          </div>
        </div>
      ))}
    </>
  )
}
