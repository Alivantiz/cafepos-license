// Словарь «как поставщик пишет товар в накладной» → штрихкод.
//
// Кассы шлют сюда имена, которые у них не сопоставились: имя, поставщик, его
// артикул — ни цен, ни остатков. Вендор привязывает штрихкод один раз, и все
// магазины начинают распознавать эту строку сами, включая те, где этого товара
// ещё не видели. Очередь идёт по частоте: сперва то, что реально возят.
import { useEffect, useState } from 'react'
import { api, useApi, fmtDate } from '../api'
import { toast, confirmDialog } from '../ui'

export const aliasPendingCount = (rows) => (rows || []).length

export default function Aliases({ onCounts, onReload }) {
  const [tab, setTab] = useState('pending')
  const { data, error, loading, reload } = useApi('aliases/list', { status: tab })
  useEffect(() => { onReload?.(() => reload) }, [reload, onReload])
  const rows = data?.rows || []
  useEffect(() => { if (tab === 'pending') onCounts?.(data?.total ?? rows.length) }, [data, tab])

  if (error) return <div className="card" style={{ borderColor: 'var(--bad)' }}>{error}</div>
  if (loading && !data) return <div className="empty">Загрузка…</div>

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        {[['pending', 'Ждут кода'], ['approved', 'Привязанные'], ['rejected', 'Отклонённые']].map(([id, label]) => (
          <button key={id} className={'btn sm' + (tab === id ? ' pri' : '')} onClick={() => setTab(id)}>{label}</button>
        ))}
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
          {data?.total != null ? `${data.total} всего` : ''}
        </span>
      </div>

      {!rows.length && (
        <div className="empty">
          {tab === 'pending'
            ? 'Пусто — всё, что кассы не смогли сопоставить, уже разобрано'
            : 'Здесь пока пусто'}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        {rows.map(r => <AliasCard key={r.id} r={r} onDone={reload} tab={tab} />)}
      </div>
    </>
  )
}

function AliasCard({ r, onDone, tab }) {
  // На «Привязанных» карточка тоже редактируемая: ошибиться кодом легко, а
  // исправить это раньше было нечем — только руками в базе.
  const bound = tab === 'approved'
  const editable = tab === 'pending' || bound
  const [bc, setBc] = useState(r.barcode || '')
  const [busy, setBusy] = useState(false)
  const [hints, setHints] = useState(null)

  // Подсказка из справочника: ищем по словам самого написания. Иначе штрихкод
  // пришлось бы искать во вкладке «Каталог» и переносить сюда руками.
  const suggest = async () => {
    setBusy(true)
    try {
      const words = String(r.raw_name || '').split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3)
      const d = await api('aliases/suggest', { q: words[0] || r.raw_name })
      setHints(d.rows || [])
      if (!(d.rows || []).length) toast.err('В справочнике похожего не нашлось')
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const bind = async () => {
    if (!/^\d{8,14}$/.test(bc.trim())) { toast.err('Штрихкод — 8–14 цифр'); return }
    if (bound && !await confirmDialog({
      title: 'Изменить штрихкод',
      message: `«${r.raw_name}» сейчас привязано к ${r.barcode}. Заменить на ${bc.trim()}? Новый код уедет на все кассы при следующем их запуске.`,
      confirmText: 'Заменить',
    })) return
    setBusy(true)
    try {
      // force — осознанная правка уже разобранной строки (см. aliasByNorm)
      await api('aliases/bind', { id: r.id, barcode: bc.trim(), force: bound })
      toast.ok(bound ? 'Код заменён — уедет на кассы' : 'Привязано — уедет на кассы'); onDone()
    }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const unbind = async () => {
    if (!await confirmDialog({
      title: 'Отвязать штрихкод',
      message: `«${r.raw_name}» вернётся в очередь «Ждут кода», а на кассах эта привязка пропадёт при следующем запуске. Продолжить?`,
      confirmText: 'Отвязать',
    })) return
    setBusy(true)
    try { await api('aliases/unbind', { id: r.id }); toast.ok('Отвязано'); onDone() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const reject = async () => {
    if (!await confirmDialog({
      title: 'Отклонить строку',
      message: `«${r.raw_name}» — это мусор из распознавания, а не товар? Строка уйдёт в отклонённые и больше не будет всплывать.`,
      confirmText: 'Отклонить',
    })) return
    setBusy(true)
    try { await api('aliases/reject', { id: r.id }); toast.ok('Отклонено'); onDone() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{r.raw_name}</div>
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        {r.supplier ? `${r.supplier} · ` : ''}
        {r.supplier_code ? `арт. ${r.supplier_code} · ` : ''}
        встречалось {r.hits || 1} раз{(r.hits || 1) > 1 ? 'а' : ''}
        {/* Из скольких магазинов пришло: сколько точек ждут этой привязки —
            главный довод разобрать строку сейчас, а не потом. */}
        {r.venues > 1 ? ` в ${r.venues} точках` : ''}
        {r.updated_at ? ` · ${fmtDate(r.updated_at)}` : ''}
      </div>

      {bound && (
        <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
          штрихкод <b>{r.barcode}</b>
        </div>
      )}

      {!editable ? (
        <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
          {r.barcode ? <>штрихкод <b>{r.barcode}</b></> : 'без кода'}
        </div>
      ) : (
        <>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <input value={bc} onChange={e => setBc(e.target.value.replace(/\D/g, ''))}
              placeholder="Штрихкод с упаковки" inputMode="numeric"
              style={{ flex: 1, minWidth: 0 }} />
            <button className="btn sm" disabled={busy} onClick={suggest}>Найти в справочнике</button>
          </div>

          {hints && !!hints.length && (
            <div style={{ marginTop: 8, maxHeight: 160, overflow: 'auto' }}>
              {hints.map(h => (
                <button key={h.barcode} className="btn sm" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}
                  onClick={() => setBc(h.barcode)}>
                  {h.name} <span className="muted">· {h.barcode}{h.category ? ` · ${h.category}` : ''}</span>
                </button>
              ))}
            </div>
          )}

          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="btn sm pri" disabled={busy} onClick={bind}>{bound ? 'Изменить код' : 'Привязать'}</button>
            {bound
              ? <button className="btn sm" disabled={busy} onClick={unbind}>Отвязать</button>
              : <button className="btn sm" disabled={busy} onClick={reject}>Мусор</button>}
          </div>
        </>
      )}
    </div>
  )
}
