// Общий справочник штрихкодов: очередь на модерацию (карточки, присланные
// кассами) и сам каталог с поиском, страницами и массовой сменой категории.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Modal, toast, confirmDialog } from '../ui'

const PER_PAGE = 200
const key = (r) => r.venue_id + '::' + r.barcode

export default function Catalog({ onCounts, onReload }) {
  const [pending, setPending] = useState(null)   // null — ещё не грузили
  const [pendTotal, setPendTotal] = useState(null)
  const [sel, setSel] = useState(() => new Set())
  const [similar, setSimilar] = useState({})

  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [listSel, setListSel] = useState(() => new Set())

  const [edit, setEdit] = useState(null)   // {row, pending}
  const [bulkCat, setBulkCat] = useState(false)

  const loadPending = useCallback(async () => {
    try {
      const d = await api('catalog/pending')
      setPending(d.rows || []); setPendTotal(d.total ?? null); setSimilar({}); setSel(new Set())
      onCounts?.(d.total ?? (d.rows || []).length)
    } catch (e) { toast.err(e.message) }
  }, [onCounts])

  // Запрос на каждую букву возвращался вразнобой: в таблице оказывались
  // результаты позапрошлого запроса. Задержка + счётчик отсекают устаревшие.
  const seq = useRef(0)
  const loadList = useCallback(async () => {
    const my = ++seq.current
    try {
      const d = await api('catalog/list', { q, page })
      if (my !== seq.current) return
      setRows(d.rows || []); setTotal(d.total ?? null)
    } catch (e) { if (my === seq.current) toast.err(e.message) }
  }, [q, page])

  useEffect(() => { loadPending() }, [loadPending])
  useEffect(() => { const t = setTimeout(loadList, 300); return () => clearTimeout(t) }, [loadList])
  // Кнопка «Обновить» в шапке должна перечитывать ИМЕННО эту вкладку.
  useEffect(() => { onReload?.(() => () => { loadPending(); loadList() }) }, [loadPending, loadList, onReload])

  const showSimilar = async (r) => {
    const k = key(r)
    if (similar[k]) { setSimilar(s => { const n = { ...s }; delete n[k]; return n }) ; return }
    setSimilar(s => ({ ...s, [k]: { loading: true } }))
    try {
      const d = await api('catalog/similar', { q: r.name })
      setSimilar(s => ({ ...s, [k]: { rows: d.rows || [] } }))
    } catch (e) { setSimilar(s => ({ ...s, [k]: { rows: [], error: e.message } })) }
  }

  const decide = async (r, action) => {
    // «Отклонить» — это DELETE на сервере. Массовое отклонение спрашивало,
    // одиночное нет, хотя кнопка вплотную к «Одобрить».
    if (action === 'reject' && !await confirmDialog({
      title: 'Отклонить карточку',
      message: `«${r.name || r.barcode}» будет удалена из очереди без возможности вернуть.`,
      confirmText: 'Отклонить',
    })) return
    try {
      await api('catalog/' + action, { venue_id: r.venue_id, barcode: r.barcode })
      toast.ok(action === 'approve' ? 'Одобрено' : 'Отклонено')
      loadPending(); if (action === 'approve') loadList()
    } catch (e) { toast.err(e.message) }
  }

  const bulk = async (action) => {
    const items = (pending || []).filter(r => sel.has(key(r)))
    if (!items.length) return
    if (action === 'reject' && !await confirmDialog({
      title: 'Отклонить выбранные',
      message: `Заявок будет отклонено: ${items.length}.`,
      confirmText: 'Отклонить',
    })) return
    const res = await Promise.allSettled(
      items.map(r => api('catalog/' + action, { venue_id: r.venue_id, barcode: r.barcode })))
    const ok = res.filter(x => x.status === 'fulfilled').length
    const word = action === 'approve' ? 'Одобрено' : 'Отклонено'
    // Частичный успех обязан быть виден: молчаливое «готово» после половины
    // ошибок — худший исход массовой операции.
    if (ok === items.length) toast.ok(`${word}: ${ok}`)
    else toast.err(`${word}: ${ok}, ошибок: ${items.length - ok}`)
    loadPending(); if (action === 'approve') loadList()
  }

  const pages = Math.max(1, Math.ceil((total || 0) / PER_PAGE))

  return (
    <>
      <section style={{ marginBottom: 24 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>На модерации</h2>
          <span className="muted2">{pendTotal !== null ? `${pending.length} из ${pendTotal}` : ''}</span>
        </div>
        {pending === null ? <div className="empty">Загрузка…</div>
          : !pending.length ? <div className="empty">Очередь пуста</div> : (
          <div className="card" style={{ padding: '14px 4px 4px' }}>
            {sel.size > 0 && (
              <div className="row" style={{ padding: '0 12px 10px' }}>
                <span className="muted2">Выбрано: {sel.size}</span>
                <button className="btn pri sm spacer" onClick={() => bulk('approve')}>Одобрить выбранные</button>
                <button className="btn sm" onClick={() => bulk('reject')}>Отклонить выбранные</button>
                <button className="btn ghost sm" onClick={() => setSel(new Set())}>Снять</button>
              </div>
            )}
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input type="checkbox" style={{ width: 'auto' }}
                        checked={pending.length > 0 && pending.every(r => sel.has(key(r)))}
                        onChange={e => setSel(e.target.checked ? new Set(pending.map(key)) : new Set())} />
                    </th>
                    <th>Штрихкод</th><th>Название</th><th>Категория</th>
                    <th className="num">Цена</th><th>Ед.</th><th />
                  </tr>
                </thead>
                <tbody>
                  {pending.map(r => {
                    const k = key(r), sim = similar[k]
                    return [
                      <tr key={k}>
                        <td><input type="checkbox" style={{ width: 'auto' }} checked={sel.has(k)}
                          onChange={e => setSel(s => {
                            const n = new Set(s); e.target.checked ? n.add(k) : n.delete(k); return n
                          })} /></td>
                        <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{r.barcode}</td>
                        <td className="name">{r.name || ''}</td>
                        <td className="muted">{r.category || '—'}</td>
                        <td className="num">{r.price ?? '—'}</td>
                        <td className="muted">{r.unit || '—'}</td>
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            <button className="btn ghost sm" title="Похожие карточки в каталоге"
                              onClick={() => showSimilar(r)}>≈ похожие</button>
                            <button className="btn ghost sm" title="Править перед одобрением"
                              onClick={() => setEdit({ row: r, pending: true })}>✎ править</button>
                            <button className="btn pri sm" onClick={() => decide(r, 'approve')}>Одобрить</button>
                            <button className="btn sm" onClick={() => decide(r, 'reject')}>Отклонить</button>
                          </div>
                        </td>
                      </tr>,
                      sim && (
                        <tr key={k + '-sim'}>
                          <td colSpan={7} className="muted2" style={{ paddingTop: 0 }}>
                            <Similar r={r} sim={sim} />
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Каталог</h2>
          {/* «Всего» считается сервером до схлопывания дублей по штрихкоду,
              поэтому оно не сходится с числом строк — говорим это прямо. */}
          <span className="muted2">{total !== null ? `${total} записей, дубли по штрихкоду схлопнуты` : ''}</span>
          <input placeholder="Поиск по названию или штрихкоду" value={q}
            onChange={e => { setQ(e.target.value); setPage(0) }} style={{ maxWidth: 280, marginLeft: 12 }} />
          <button className="btn spacer" onClick={() => setEdit({ row: null })}>Добавить штрихкод</button>
        </div>

        {listSel.size > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="muted2">Выбрано: {listSel.size}</span>
            <button className="btn pri sm" onClick={() => setBulkCat(true)}>Сменить категорию</button>
            <button className="btn ghost sm" onClick={() => setListSel(new Set())}>Снять</button>
          </div>
        )}

        {rows === null ? <div className="empty">Загрузка…</div>
          : !rows.length ? <div className="empty">Ничего не найдено</div> : (
          <div className="card" style={{ padding: '14px 4px 4px' }}>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input type="checkbox" style={{ width: 'auto' }}
                        checked={rows.length > 0 && rows.every(r => listSel.has(r.barcode))}
                        onChange={e => setListSel(s => {
                          const n = new Set(s)
                          rows.forEach(r => e.target.checked ? n.add(r.barcode) : n.delete(r.barcode))
                          return n
                        })} />
                    </th>
                    <th>Штрихкод</th><th>Название</th><th>Категория</th>
                    <th className="num">Цена</th><th>Ед.</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.barcode}>
                      <td><input type="checkbox" style={{ width: 'auto' }} checked={listSel.has(r.barcode)}
                        onChange={e => setListSel(s => {
                          const n = new Set(s); e.target.checked ? n.add(r.barcode) : n.delete(r.barcode); return n
                        })} /></td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{r.barcode}</td>
                      <td className="name">{r.name || ''}</td>
                      <td className="muted">{r.category || '—'}</td>
                      <td className="num">{r.price ?? '—'}</td>
                      <td className="muted">{r.unit || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn ghost sm" onClick={() => setEdit({ row: r })}>✎ править</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {total > PER_PAGE && (
          <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
            <button className="btn sm" disabled={page <= 0} onClick={() => setPage(p => p - 1)}>← Назад</button>
            <span className="muted2">
              {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, total)} из {total} · стр {page + 1} / {pages}
            </span>
            <button className="btn sm" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Вперёд →</button>
          </div>
        )}
      </section>

      {edit && <EditModal {...edit} onClose={() => setEdit(null)}
        onSaved={() => { setEdit(null); loadList(); loadPending() }} />}
      {bulkCat && <BulkCategory count={listSel.size} barcodes={[...listSel]}
        onClose={() => setBulkCat(false)}
        onDone={() => { setBulkCat(false); setListSel(new Set()); loadList() }} />}
    </>
  )
}

function Similar({ r, sim }) {
  if (sim.loading) return <>Ищем похожие…</>
  if (!sim.rows.length) return <>{sim.error ? 'Ошибка: ' + sim.error : 'Похожих в каталоге нет — это новый товар'}</>
  return (
    <>Похожие в каталоге:{' '}
      {sim.rows.map(s => {
        const dup = s.barcode === r.barcode
        return (
          <span key={s.barcode} title={s.barcode} style={{
            display: 'inline-block', margin: '2px 6px 2px 0', padding: '1px 7px',
            borderRadius: 999, background: 'var(--panel2)',
            color: dup ? 'var(--bad)' : 'inherit',
          }}>
            {s.name} · {s.match_kind === 'alias' ? 'алиас' : Math.round((s.score || 0) * 100) + '%'}
            {dup ? ' · тот же штрихкод!' : ''}
          </span>
        )
      })}
    </>
  )
}

// pending — правка карточки из очереди: сохранение через upsert её же и
// одобряет, поэтому кнопка называется иначе.
function EditModal({ row, pending, onClose, onSaved }) {
  const [f, setF] = useState({
    barcode: row?.barcode || '', name: row?.name || '', category: row?.category || '',
    price: row?.price ?? '', unit: row?.unit || '',
  })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))

  const save = async () => {
    setBusy(true)
    try {
      await api('catalog/upsert', { venue_id: row?.venue_id, ...f })
      toast.ok('Сохранено'); onSaved()
    } catch (e) { toast.err(e.message); setBusy(false) }
  }
  const remove = async () => {
    if (!await confirmDialog({
      title: 'Удалить из каталога',
      message: `Карточка этого заведения со штрихкодом ${f.barcode} будет удалена. Карточки других заведений с тем же штрихкодом останутся.`,
      confirmText: 'Удалить',
    })) return
    try {
      await api('catalog/delete', { venue_id: row.venue_id, barcode: row.barcode })
      toast.ok('Удалено'); onSaved()
    } catch (e) { toast.err(e.message) }
  }

  return (
    <Modal title={pending ? 'Править перед одобрением' : row ? 'Правка штрихкода' : 'Новый штрихкод'} onClose={onClose}>
      <label>Штрихкод<input value={f.barcode} onChange={set('barcode')} readOnly={!!row} /></label>
      <label>Название<input value={f.name} onChange={set('name')} autoFocus /></label>
      <label>Категория<input value={f.category} onChange={set('category')} /></label>
      <div className="row">
        <label style={{ flex: 1 }}>Цена<input value={f.price} onChange={set('price')} /></label>
        <label style={{ flex: 1 }}>Единица<input value={f.unit} onChange={set('unit')} /></label>
      </div>
      <div className="row">
        {row && !pending && <button className="btn ghost" onClick={remove}>Удалить</button>}
        <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
        <button className="btn pri" disabled={busy || !f.barcode.trim() || !f.name.trim()} onClick={save}>
          {pending ? 'Сохранить и одобрить' : 'Сохранить'}
        </button>
      </div>
    </Modal>
  )
}

function BulkCategory({ count, barcodes, onClose, onDone }) {
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const d = await api('catalog/bulkCategory', { barcodes, category })
      toast.ok('Категория проставлена: ' + (d.count ?? count)); onDone()
    } catch (e) { toast.err(e.message); setBusy(false) }
  }
  return (
    <Modal title="Сменить категорию" onClose={onClose}>
      <div className="muted2">Товаров выбрано: {count}</div>
      {/* Меняется у ВСЕХ заведений с этими штрихкодами, а не только там, откуда
          пришла карточка — про это окно раньше молчало. */}
      <div className="muted2">Категория поменяется у всех заведений с этими штрихкодами. Отката нет.</div>
      <label>Категория<input value={category} onChange={e => setCategory(e.target.value)} autoFocus /></label>
      <div className="row">
        <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
        {/* Пустое поле стирало категорию у всех выбранных одним нажатием */}
        <button className="btn pri" disabled={busy || !category.trim()} onClick={go}>Применить</button>
      </div>
    </Modal>
  )
}
