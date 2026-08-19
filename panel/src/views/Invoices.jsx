import { useEffect, useState } from 'react'
// Разбор ИИ-распознаваний накладных: фото, что распозналось, и решение —
// «разобрано» (фото удаляется) или «удалить целиком».
import { api, useApi } from '../api'
import { toast, confirmDialog } from '../ui'

export default function Invoices({ onReload }) {
  const { data, error, loading, reload } = useApi('invoices/pending')
  useEffect(() => { onReload?.(() => reload) }, [reload, onReload])
  const rows = data?.rows || []

  // На медленной связи «Разобрано» нажимают дважды: второй запрос падал и
  // показывал ошибку поверх успеха. Блокируем строку на время запроса.
  const [busy, setBusy] = useState(null)
  const review = async (id) => {
    if (busy) return
    setBusy(id)
    try { await api('invoices/review', { id: Number(id) }); toast.ok('Разобрано — фото удалено'); reload() }
    catch (e) { toast.err(e.message) } finally { setBusy(null) }
  }
  // Коды из накладной — сразу в словарь написаний. Иначе владелец переписывает
  // те же цифры с фотографии руками, хотя распознавание их уже прочитало.
  const bindCodes = async (id) => {
    if (busy) return
    setBusy(id)
    try {
      const r = await api('invoices/bindCodes', { id: Number(id) })
      toast.ok(r.names
        ? `Привязано написаний: ${r.names}` + (r.left ? ` — осталось ${r.left}, нажмите ещё раз` : '')
        : 'Ничего не изменилось — эти названия уже разобраны или их нет в очереди')
      reload()
    } catch (e) { toast.err(e.message) } finally { setBusy(null) }
  }

  const remove = async (id) => {
    if (busy) return
    if (!await confirmDialog({
      title: 'Удалить распознавание',
      message: 'Запись и фото накладной будут удалены без возможности вернуть.',
      confirmText: 'Удалить',
    })) return
    setBusy(id)
    try { await api('invoices/delete', { id: Number(id) }); toast.ok('Удалено'); reload() }
    catch (e) { toast.err(e.message) } finally { setBusy(null) }
  }

  if (error) return <div className="card" style={{ borderColor: 'var(--bad)' }}>{error}</div>
  if (loading && !data) return <div className="empty">Загрузка…</div>
  if (!rows.length) return <div className="empty">Неразобранных накладных нет</div>

  return (
    <>
      {/* Раньше писали «показано 40 из 137», а посмотреть остальное было
          нечем. Объясняем, что список сам сократится по мере разбора. */}
      {data?.total != null && (
        <div className="muted2" style={{ marginBottom: 10 }}>
          показано {rows.length} из {data.total} — остальные появятся здесь по мере разбора
        </div>
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
                    {/* Состояние кода у КАЖДОЙ строки: иначе кнопка обещает
                        меньше привязок, чем кодов видно на фотографии, и
                        непонятно, каких именно строк не хватило. */}
                    {it.code
                      ? <b style={{
                          // Приглушённый — код есть, но привязывать нечего:
                          // магазин этот товар уже знает.
                          color: it.code_done ? 'var(--mut2)' : 'var(--ok)',
                          fontWeight: it.code_done ? 400 : 700,
                          fontVariantNumeric: 'tabular-nums',
                        }} title={it.code_done ? 'Уже разобрано — в очереди этого написания нет' : 'Привяжется кнопкой'}>{it.code} </b>
                      : it.code_bad
                        ? <b style={{ color: 'var(--bad)' }} title="Контрольная цифра не сходится — распознавание ошиблось в цифре">
                            {it.code_bad} ?{' '}
                          </b>
                        : <span title="Штрихкода в этой строке распознавание не вернуло">без кода </span>}
                    {it.quantity ?? it.qty ?? ''}{it.unit ? ' ' + it.unit : ''}
                    {it.price != null ? ' · ' + it.price : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn pri" disabled={busy === r.id} onClick={() => review(r.id)}>
              {busy === r.id ? 'Секунду…' : 'Разобрано'}
            </button>
            {/* Кнопка — только когда есть что привязывать. Но исчезнувшая
                кнопка молчит о том, почему её нет: сделано или читать нечего.
                Поэтому вместо неё пишем состояние словами. */}
            {r.code_count > 0
              ? <button className="btn" disabled={busy === r.id} onClick={() => bindCodes(r.id)}>
                  Привязать коды ({r.code_count})
                </button>
              : r.code_total > 0
                ? <span className="muted2" style={{ alignSelf: 'center' }}>
                    Коды привязаны — в очереди по этой накладной ничего не ждёт
                  </span>
                : null}
            <button className="btn ghost" disabled={busy === r.id} onClick={() => remove(r.id)}>Удалить</button>
          </div>
        </div>
      ))}
    </>
  )
}
