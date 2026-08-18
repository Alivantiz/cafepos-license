// Общий справочник штрихкодов: очередь на модерацию (карточки, присланные
// кассами) и сам каталог с поиском, страницами и массовой сменой категории.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { Modal, toast, confirmDialog, Suggest } from '../ui'

const PER_PAGE = 200
const PEND_PER = 200   // размер страницы очереди — тот же, что limit на сервере
const key = (r) => r.venue_id + '::' + r.barcode

// «Я эту карточку открывал» — личная метка модератора, а не свойство товара:
// другому вендору она ничего не сказала бы, а писать в облако на каждое
// открытие — лишние запросы. Поэтому браузер, а не база.
const SEEN_KEY = 'catalog_seen'
const seenLoad = () => {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) } catch { return new Set() }
}
const seenSave = (set) => {
  // Очередь идёт годами, localStorage не резиновый — держим последние 3000.
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-3000))) } catch { /* приватный режим */ }
}

// Телефон. За 700px семь колонок перестают помещаться: таблица уезжает вбок,
// и на экране остаётся один столбец штрихкодов — модерировать нечем.
function useNarrow() {
  const q = '(max-width: 700px)'
  // matchMedia может не быть — смоук-тест рендерит вкладки без настоящего окна.
  // Нет способа спросить ширину — считаем экран широким: таблица работает
  // везде, просто на телефоне неудобно, а падение ломает всю вкладку.
  const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null)
  const [narrow, setNarrow] = useState(() => mq()?.matches ?? false)
  useEffect(() => {
    const m = mq()
    if (!m?.addEventListener) return
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

export default function Catalog({ onCounts, onReload }) {
  const [pending, setPending] = useState(null)   // null — ещё не грузили
  const [pendTotal, setPendTotal] = useState(null)
  const [pendPage, setPendPage] = useState(0)
  const [sel, setSel] = useState(() => new Set())
  const [similar, setSimilar] = useState({})
  // Курсор очереди: строка, на которой стоит клавиатура. Разбор сотни карточек
  // мышью — сотня прицельных попаданий по мелкой кнопке; с клавишами это
  // «стрелка вниз — A» не глядя.
  const [cur, setCur] = useState(0)
  const curRef = useRef(null)

  const [rows, setRows] = useState(null)
  const [total, setTotal] = useState(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [listSel, setListSel] = useState(() => new Set())
  // Разбор мусора: очередь и каталог смотрят по одним и тем же двум признакам —
  // «только внутренние коды» и «изменено с такого-то дня». Отсюда общий фильтр
  // на обе таблицы: разбирать удобнее порциями, а не всё сразу сверху вниз.
  const narrow = useNarrow()
  const [seen, setSeen] = useState(seenLoad)
  const markSeen = (r) => setSeen(s => { const n = new Set(s); n.add(key(r)); seenSave(n); return n })
  // Открыл «править» — значит, разобрал. «Похожие» не в счёт: их жмут, не
  // читая карточку, и плёнка ложилась бы на то, что ты не разбирал.
  const openEdit = (r, pending) => { if (pending) markSeen(r); setEdit({ row: r, pending }) }

  // Клик по штрихкоду копирует его и считается «разобрал»: код нужен, чтобы
  // проверить товар в НКТ или в поиске, и это ровно тот момент, когда карточку
  // смотрят. Карточка при этом гаснет, но с места не двигается — вниз она
  // уедет при следующей загрузке списка.
  const copyCode = (r) => {
    try { navigator.clipboard?.writeText(r.barcode) } catch { /* нет доступа к буферу */ }
    markSeen(r)
    toast.ok(`Скопировано: ${r.barcode}`)
  }

  // Разобранные — в хвост, но НЕ на лету. Карточка, уезжающая вниз в момент
  // клика по штрихкоду, выдёргивается из-под глаз: код ещё проверяют в НКТ, а
  // строки уже нет на месте. Поэтому порядок считается по снимку отметок на
  // момент загрузки списка: пока разбираешь — ничего не двигается, а при
  // следующей загрузке разобранное собирается внизу.
  const seenRef = useRef(seen); seenRef.current = seen
  const [orderSeen, setOrderSeen] = useState(() => new Set())
  const view = useMemo(() => {
    const rows = pending || []
    return [...rows.map((r, i) => ({ r, i }))]
      .sort((a, b) => (orderSeen.has(key(a.r)) - orderSeen.has(key(b.r))) || a.i - b.i)
      .map(x => x.r)
  }, [pending, orderSeen])
  const [internalOnly, setInternalOnly] = useState(false)
  const [since, setSince] = useState('')
  const [sort, setSort] = useState('barcode')

  const [edit, setEdit] = useState(null)   // {row, pending}
  const [bulkCat, setBulkCat] = useState(false)
  const [catsMgr, setCatsMgr] = useState(false)
  // Существующие категории — один запрос на открытие вкладки. Без подсказки
  // одна и та же категория заводилась то «Напитки», то «напитки»: попасть в
  // уже заведённое название было нечем, а список их не показывал нигде.
  const [cats, setCats] = useState([])

  // onCounts держим в ссылке, а не в зависимостях загрузки. Иначе стоит
  // родителю передать стрелку прямо в JSX — и загрузка начинает перезапускать
  // сама себя по кругу: запрос → счётчик → перерисовка → новая функция →
  // запрос. Один раз это уже вылилось в бесконечный поток запросов к базе.
  const counts = useRef(onCounts)
  counts.current = onCounts
  const loadPending = useCallback(async () => {
    try {
      const d = await api('catalog/pending', { internalOnly, since, page: pendPage })
      setPending(d.rows || []); setPendTotal(d.total ?? null); setSimilar({}); setSel(new Set()); setCur(0)
      // Снимок отметок берём здесь: дальше он не меняется, и список стоит на
      // месте, пока с ним работают.
      setOrderSeen(new Set(seenRef.current))
      counts.current?.(d.total ?? (d.rows || []).length)
    } catch (e) { toast.err(e.message) }
  }, [internalOnly, since, pendPage])

  // Запрос на каждую букву возвращался вразнобой: в таблице оказывались
  // результаты позапрошлого запроса. Задержка + счётчик отсекают устаревшие.
  const seq = useRef(0)
  const loadList = useCallback(async () => {
    const my = ++seq.current
    try {
      const d = await api('catalog/list', { q, page, internalOnly, since, sort })
      if (my !== seq.current) return
      setRows(d.rows || []); setTotal(d.total ?? null)
    } catch (e) { if (my === seq.current) toast.err(e.message) }
  }, [q, page, internalOnly, since, sort])

  useEffect(() => { loadPending() }, [loadPending])
  // Список категорий перечитываем и после сохранения карточки: заведённая
  // только что категория иначе не появлялась в подсказке до перезагрузки
  // вкладки — и её заводили второй раз в другом написании.
  const loadCats = useCallback(() => {
    api('catalog/categories').then(d => setCats(d.rows || [])).catch(() => {})
  }, [])
  useEffect(() => { loadCats() }, [loadCats])
  useEffect(() => { const t = setTimeout(loadList, 300); return () => clearTimeout(t) }, [loadList])
  // Кнопка «Обновить» в шапке должна перечитывать ИМЕННО эту вкладку.
  useEffect(() => { onReload?.(() => () => { loadPending(); loadList() }) }, [loadPending, loadList, onReload])

  const loadSimilar = useCallback(async (r) => {
    const k = key(r)
    setSimilar(s => (s[k] ? s : { ...s, [k]: { loading: true } }))
    try {
      const d = await api('catalog/similar', { q: r.name })
      setSimilar(s => ({ ...s, [k]: { rows: d.rows || [] } }))
    } catch (e) { setSimilar(s => ({ ...s, [k]: { rows: [], error: e.message } })) }
  }, [])

  const showSimilar = (r) => {
    const k = key(r)
    if (similar[k]) { setSimilar(s => { const n = { ...s }; delete n[k]; return n }); return }
    loadSimilar(r)
  }

  // «Похожие» для строки под курсором — сами. Раньше на каждой карточке надо
  // было нажать «≈ похожие», чтобы понять, не заведено ли это вчера под другим
  // именем; при разборе очереди это нажатие на каждую строку. Грузим только
  // одну — ту, на которую смотрят, а не двести сразу.
  const focused = view[cur]
  useEffect(() => {
    if (!focused) return
    if (similar[key(focused)]) return
    const t = setTimeout(() => loadSimilar(focused), 250)
    return () => clearTimeout(t)
  }, [focused, similar, loadSimilar])

  // Вернуть карточку туда, откуда её только что убрали. Одобрение снимается
  // на сервере, отклонение (DELETE) восстанавливается из строки, которая всё
  // ещё лежит в браузере, — и возвращается в очередь, а не в каталог.
  const undoDecide = async (r, action) => {
    try {
      if (action === 'approve') await api('catalog/unapprove', { venue_id: r.venue_id, barcode: r.barcode })
      else await api('catalog/upsert', {
        venue_id: r.venue_id, barcode: r.barcode, name: r.name,
        category: r.category, price: r.price, unit: r.unit, status: 'pending',
      })
      toast.ok('Возвращено в очередь')
      loadPending(); loadList()
    } catch (e) { toast.err(e.message) }
  }

  const decide = async (r, action) => {
    // Спрашиваем только там, где вернуть нечем: отклонение — это DELETE, и
    // восстановить строку можно лишь из данных, которые есть в браузере. Есть
    // название — предложим «Отменить» в тосте, и лишний вопрос не нужен.
    const undoable = !!String(r.name || '').trim()
    if (action === 'reject' && !undoable && !await confirmDialog({
      title: 'Отклонить карточку',
      message: `«${r.barcode}» без названия — вернуть её будет нечем.`,
      confirmText: 'Отклонить',
    })) return
    try {
      await api('catalog/' + action, { venue_id: r.venue_id, barcode: r.barcode })
      const word = action === 'approve' ? 'Одобрено' : 'Отклонено'
      if (action === 'approve' || undoable) toast.undo(word, () => undoDecide(r, action))
      else toast.ok(word)
      // Строку убираем на месте, а не перечитываем очередь. При разборе с
      // клавиатуры перезагрузка после каждой карточки сбрасывала бы курсор в
      // начало и заново гоняла двести строк — работать стало бы медленнее, чем
      // мышью. Курсор остаётся на том же месте: под ним оказывается следующая.
      const k = key(r)
      setPending(p => (p || []).filter(x => key(x) !== k))
      setPendTotal(t => (typeof t === 'number' ? Math.max(0, t - 1) : t))
      setSel(s => { const n = new Set(s); n.delete(k); return n })
      counts.current?.((pendTotal ?? 1) - 1)
      if (action === 'approve') loadList()
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
    // Частичный успех: что не прошло — осталось в очереди, поэтому при ошибках
    // перечитываем список честно, а на полном успехе убираем строки на месте.
    if (ok === items.length) {
      const gone = new Set(items.map(key))
      setPending(p => (p || []).filter(x => !gone.has(key(x))))
      setPendTotal(t => (typeof t === 'number' ? Math.max(0, t - ok) : t))
      setSel(new Set())
      counts.current?.(Math.max(0, (pendTotal ?? ok) - ok))
    } else loadPending()
    if (action === 'approve') loadList()
  }

  // Клавиши разбора очереди: ↑↓ — по строкам, A — одобрить, D — пометить на
  // отклонение, пробел — отметить. Отклонение НЕ мгновенное намеренно: одобрить
  // можно передумать (карточка потом видна в каталоге и удаляется оттуда), а
  // «отклонить» — это DELETE навсегда. Поэтому D копит выбор, а спрашиваем один
  // раз на всю пачку кнопкой «Отклонить выбранные».
  useEffect(() => {
    if (!view.length || edit || bulkCat) return
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
      const last = view.length - 1
      const k = e.key.toLowerCase()
      if (e.key === 'ArrowDown') { e.preventDefault(); setCur(c => Math.min(c + 1, last)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setCur(c => Math.max(c - 1, 0)) }
      else if (k === 'a' || k === 'ф') {
        e.preventDefault()
        const r = view[Math.min(cur, last)]
        if (r) decide(r, 'approve')
      } else if (k === 'd' || k === 'в' || e.key === ' ') {
        e.preventDefault()
        const r = view[Math.min(cur, last)]
        if (!r) return
        const kk = key(r)
        setSel(s => { const n = new Set(s); n.has(kk) ? n.delete(kk) : n.add(kk); return n })
        if (e.key !== ' ') setCur(c => Math.min(c + 1, last))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Строка под курсором должна быть на экране — иначе «стрелка вниз» уводит
  // разбор за нижний край и приходится доскроливать мышью.
  useEffect(() => { curRef.current?.scrollIntoView({ block: 'nearest' }) }, [cur, pending])

  const bulkDelete = async () => {
    const list = [...listSel]
    if (!list.length) return
    if (!await confirmDialog({
      title: 'Удалить из общего справочника',
      message: `Карточек будет удалено: ${list.length}. Удаление идёт по штрихкоду — во всех заведениях сразу, как и смена категории.`,
      confirmText: 'Удалить',
    })) return
    try {
      const d = await api('catalog/bulkDelete', { barcodes: list })
      toast.ok(`Удалено: ${d.count}`)
      setListSel(new Set()); loadList()
    } catch (e) { toast.err(e.message) }
  }

  const pages = Math.max(1, Math.ceil((total || 0) / PER_PAGE))

  return (
    <>
      <div className="card" style={{ marginBottom: 16, padding: '10px 12px' }}>
        <div className="row filterbar">
          <label className="row" style={{ gap: 6, margin: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={internalOnly}
              onChange={e => { setInternalOnly(e.target.checked); setPage(0); setPendPage(0) }} />
            Только внутренние коды (2…)
          </label>
          <span className="muted2">изменено с</span>
          <input type="date" value={since} style={{ maxWidth: 160 }}
            onChange={e => { setSince(e.target.value); setPage(0); setPendPage(0) }} />
          <select value={sort} onChange={e => { setSort(e.target.value); setPage(0) }} style={{ maxWidth: 200 }}>
            <option value="barcode">каталог: по штрихкоду</option>
            <option value="updated">каталог: сначала свежие</option>
            <option value="stale">каталог: сначала нетронутые</option>
          </select>
          {(internalOnly || since || sort !== 'barcode') && (
            <button className="btn ghost sm" onClick={() => { setInternalOnly(false); setSince(''); setSort('barcode'); setPage(0); setPendPage(0) }}>
              Сбросить фильтр
            </button>
          )}
        </div>
        {internalOnly && (
          <div className="muted2" style={{ marginTop: 8 }}>
            Префикс «2» отдан магазинам под свои коды, но не все такие коды — свои:
            2900094315692 в НКТ значится альбомом. Смотрите на название, а не на цифры.
          </div>
        )}
      </div>

      <section style={{ marginBottom: 24 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>На модерации</h2>
          <span className="muted2">{pendTotal !== null ? `${pending?.length ?? 0} из ${pendTotal}` : ''}</span>
          {!narrow && (
            <span className="muted2" style={{ marginLeft: 'auto' }}>
              ↑↓ — по строкам · A — одобрить · D — пометить на отклонение
            </span>
          )}
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
            {narrow && (
              <div className="rowcards" style={{ padding: '0 8px 8px' }}>
                {view.map(r => {
                  const k = key(r), sim = similar[k]
                  return (
                    <div key={k} className={'rowcard' + (sel.has(k) ? ' sel' : '') + (seen.has(k) ? ' seen' : '')}>
                      <div className="nm">{r.name || 'без названия'}</div>
                      <button className="codebtn" title="Скопировать штрихкод"
                        onClick={() => copyCode(r)}>{r.barcode}</button>
                      <div className="meta">
                        {[r.category || 'без категории', r.price != null ? r.price + ' ₸' : null, r.unit]
                          .filter(Boolean).join(' · ')}
                      </div>
                      {sim && <div className="meta"><Similar r={r} sim={sim} /></div>}
                      <div className="acts">
                        <button className="btn pri" onClick={() => decide(r, 'approve')}>Одобрить</button>
                        <button className="btn" onClick={() => decide(r, 'reject')}>Отклонить</button>
                        <button className="btn ghost" title="Похожие в каталоге"
                          onClick={() => showSimilar(r)}>≈</button>
                        <button className="btn ghost" title="Править перед одобрением"
                          onClick={() => openEdit(r, true)}>✎</button>
                      </div>
                      <label className="pick">
                        <input type="checkbox" style={{ width: 'auto' }} checked={sel.has(k)}
                          onChange={e => setSel(s => {
                            const n = new Set(s); e.target.checked ? n.add(k) : n.delete(k); return n
                          })} />
                        отметить для массового действия
                      </label>
                    </div>
                  )
                })}
              </div>
            )}
            {!narrow && (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>
                      <input type="checkbox" style={{ width: 'auto' }}
                        checked={view.length > 0 && view.every(r => sel.has(key(r)))}
                        onChange={e => setSel(e.target.checked ? new Set(view.map(key)) : new Set())} />
                    </th>
                    <th>Штрихкод</th><th>Название</th><th>Категория</th>
                    <th className="num">Цена</th><th>Ед.</th><th />
                  </tr>
                </thead>
                <tbody>
                  {view.map((r, i) => {
                    const k = key(r), sim = similar[k]
                    return [
                      <tr key={k} ref={i === cur ? curRef : null} onClick={() => setCur(i)}
                        className={seen.has(k) ? 'seen' : undefined}
                        style={i === cur ? { background: 'var(--sel, rgba(125,125,255,.12))' } : undefined}>
                        <td><input type="checkbox" style={{ width: 'auto' }} checked={sel.has(k)}
                          onChange={e => setSel(s => {
                            const n = new Set(s); e.target.checked ? n.add(k) : n.delete(k); return n
                          })} /></td>
                        <td>
                          <button className="codebtn" title="Скопировать штрихкод"
                            onClick={e => { e.stopPropagation(); copyCode(r) }}>{r.barcode}</button>
                        </td>
                        <td className="name">{r.name || ''}</td>
                        <td className="muted">{r.category || '—'}</td>
                        <td className="num">{r.price ?? '—'}</td>
                        <td className="muted">{r.unit || '—'}</td>
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            <button className="btn ghost sm" title="Похожие карточки в каталоге"
                              onClick={() => showSimilar(r)}>≈ похожие</button>
                            <button className="btn ghost sm" title="Править перед одобрением"
                              onClick={() => openEdit(r, true)}>✎ править</button>
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
            )}
          </div>
        )}

        {/* Страницы очереди. Без них были видны только 200 самых свежих
            карточек, а всё, что глубже, недостижимо, пока не разберёшь верх. */}
        {pendTotal > PEND_PER && (
          <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
            <button className="btn sm" disabled={pendPage <= 0} onClick={() => setPendPage(p => p - 1)}>← Назад</button>
            <span className="muted2">
              стр {pendPage + 1} / {Math.max(1, Math.ceil(pendTotal / PEND_PER))}
            </span>
            <button className="btn sm" disabled={(pendPage + 1) * PEND_PER >= pendTotal}
              onClick={() => setPendPage(p => p + 1)}>Вперёд →</button>
          </div>
        )}
      </section>

      <section>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Каталог</h2>
          {/* «Всего» считается сервером до схлопывания дублей по штрихкоду,
              поэтому оно не сходится с числом строк — говорим это прямо. */}
          {/* «около»: число теперь оценочное. Точный подсчёт по справочнику в
              сотни тысяч строк — полный проход по таблице на каждую букву в
              поиске, из-за него запрос и повисал. */}
          <span className="muted2">{total !== null ? `около ${total} записей, дубли по штрихкоду схлопнуты` : ''}</span>
          <input placeholder="Поиск по названию или штрихкоду" value={q}
            onChange={e => { setQ(e.target.value); setPage(0) }} style={{ maxWidth: 280, marginLeft: 12 }} />
          <button className="btn spacer" onClick={() => setEdit({ row: null })}>Добавить штрихкод</button>
          <button className="btn" onClick={() => setCatsMgr(true)}>Категории</button>
        </div>

        {listSel.size > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="muted2">Выбрано: {listSel.size}</span>
            <button className="btn pri sm" onClick={() => setBulkCat(true)}>Сменить категорию</button>
            <button className="btn sm" onClick={bulkDelete}>Удалить выбранные</button>
            <button className="btn ghost sm" onClick={() => setListSel(new Set())}>Снять</button>
          </div>
        )}

        {rows === null ? <div className="empty">Загрузка…</div>
          : !rows.length ? <div className="empty">Ничего не найдено</div> : (
          <div className="card" style={{ padding: '14px 4px 4px' }}>
            {narrow && (
              <div className="rowcards" style={{ padding: '0 8px 8px' }}>
                {rows.map(r => (
                  <div key={r.barcode} className={'rowcard' + (listSel.has(r.barcode) ? ' sel' : '')}>
                    <div className="nm">{r.name || 'без названия'}</div>
                    <div className="code">{r.barcode}</div>
                    <div className="meta">
                      {[r.category || 'без категории', r.price != null ? r.price + ' ₸' : null, r.unit,
                        r.updated_at ? String(r.updated_at).slice(0, 10) : null].filter(Boolean).join(' · ')}
                    </div>
                    <div className="acts">
                      <button className="btn ghost" onClick={() => setEdit({ row: r })}>✎ править</button>
                    </div>
                    <label className="pick">
                      <input type="checkbox" style={{ width: 'auto' }} checked={listSel.has(r.barcode)}
                        onChange={e => setListSel(s => {
                          const n = new Set(s); e.target.checked ? n.add(r.barcode) : n.delete(r.barcode); return n
                        })} />
                      отметить
                    </label>
                  </div>
                ))}
              </div>
            )}
            {!narrow && (
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
                    <th className="num">Цена</th><th>Ед.</th><th>Изменено</th><th />
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
                      <td className="muted">{r.updated_at ? String(r.updated_at).slice(0, 10) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn ghost sm" onClick={() => setEdit({ row: r })}>✎ править</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
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

      {edit && <EditModal {...edit} cats={cats} onClose={() => setEdit(null)}
        onSaved={() => { setEdit(null); loadList(); loadPending(); loadCats() }} />}
      {catsMgr && <CategoriesModal onClose={() => setCatsMgr(false)}
        onDone={() => { loadCats(); loadList(); loadPending() }} />}
      {bulkCat && <BulkCategory count={listSel.size} barcodes={[...listSel]} cats={cats}
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
function EditModal({ row, pending, cats, onClose, onSaved }) {
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
      <label>Категория
        <Suggest value={f.category} onChange={v => setF(x => ({ ...x, category: v }))}
          options={cats} placeholder="начните вводить или выберите" />
      </label>
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

function BulkCategory({ count, barcodes, cats, onClose, onDone }) {
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
      <label>Категория
        <Suggest value={category} onChange={setCategory} options={cats}
          autoFocus placeholder="начните вводить или выберите" />
      </label>
      <div className="row">
        <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
        {/* Пустое поле стирало категорию у всех выбранных одним нажатием */}
        <button className="btn pri" disabled={busy || !category.trim()} onClick={go}>Применить</button>
      </div>
    </Modal>
  )
}

// Разбор категорий: переименовать, слить дубли, очистить ненужную. Отдельного
// списка категорий нет — категория это текст в карточке, поэтому «удалить»
// означает очистить поле у всех карточек, а «слить» — переименовать одну в
// имя другой. Карточки при этом не трогаются: пропадает только отнесение.
function CategoriesModal({ onClose, onDone }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)
  const [editing, setEditing] = useState(null)   // { from, to } — переименование
  const [moving, setMoving] = useState(null)    // { from, to, cnt } — перенос
  const [busy, setBusy] = useState(false)

  const load = () => {
    setRows(null); setErr(null)
    api('catalog/categoryStats').then(d => setRows(d.rows || [])).catch(e => setErr(e.message))
  }
  useEffect(load, [])

  const apply = async (from, to) => {
    setBusy(true)
    try {
      const d = await api('catalog/renameCategory', { from, to })
      toast.ok(to ? 'Категория переименована' : 'Категория очищена')
      setEditing(null); setMoving(null); load(); onDone?.()
      return d
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  // Числа может не быть: старая версия mon_categories счётчик не отдаёт. Тогда
  // говорим «все карточки», а не печатаем ноль — вопрос, который врёт цифрой,
  // хуже вопроса без цифры.
  const howMany = (cnt) => (cnt > 0 ? `${cnt} карточек` : 'все карточки с этой категорией')

  // Перенос = переименование в имя другой категории: карточки просто сходятся
  // под ним. Отдельного «удалить категорию» нет и быть не может — товары надо
  // куда-то деть, иначе они останутся без категории, а этого никто не просил.
  const move = async (from, to, cnt) => {
    const dst = String(to || '').trim()
    if (!dst) return
    if (!await confirmDialog({
      title: 'Перенести товары',
      message: `${howMany(cnt)} из «${from}» перейдут в «${dst}». Категория «${from}» исчезнет из списка.`,
      confirmText: 'Перенести',
    })) return
    apply(from, dst)
  }

  // Отдельный, намеренно неудобный путь: убрать категорию совсем. Нужен редко —
  // когда категория ошибочная, а куда девать товар, ещё не решили.
  const clear = async (name, cnt) => {
    if (!await confirmDialog({
      title: 'Оставить без категории',
      message: `${howMany(cnt)} из «${name}» останутся без категории. Сами карточки не пропадут, но искать их придётся поиском.`,
      confirmText: 'Оставить без категории',
    })) return
    apply(name, '')
  }

  const known = new Set((rows || []).map(r => r.category))

  return (
    <Modal title="Категории справочника" onClose={onClose} keepOpen>
      {err && <div className="muted" style={{ color: 'var(--bad)' }}>{err}</div>}
      {rows === null && !err && <div className="empty">Загрузка…</div>}
      {rows && !rows.length && <div className="empty">Категорий пока нет</div>}

      {rows && rows.map(r => (
        <div key={r.category} style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
          {editing?.from === r.category ? (
            <div className="row" style={{ gap: 8 }}>
              <input autoFocus value={editing.to} onChange={e => setEditing({ ...editing, to: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter' && editing.to.trim()) apply(editing.from, editing.to) }} />
              <button className="btn pri sm" disabled={busy || !editing.to.trim()}
                onClick={() => apply(editing.from, editing.to)}>Сохранить</button>
              <button className="btn ghost sm" onClick={() => setEditing(null)}>Отмена</button>
              {known.has(editing.to.trim()) && editing.to.trim() !== r.category && (
                <span className="muted2" style={{ flexBasis: '100%' }}>
                  Такая категория уже есть — карточки сольются в одну
                </span>
              )}
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <b style={{ fontWeight: 600 }}>{r.category}</b>
              {/* Старая версия функции счётчик не отдаёт — ноль тут значит
                  «неизвестно», и врать числом хуже, чем промолчать. */}
              {r.cnt > 0 && <span className="muted2">{r.cnt}</span>}
              <button className="btn ghost sm spacer" disabled={busy}
                onClick={() => setEditing({ from: r.category, to: r.category })}>Переименовать</button>
              <button className="btn ghost sm" disabled={busy}
                onClick={() => setMoving({ from: r.category, to: '', cnt: r.cnt })}>Перенести…</button>
            </div>
          )}
          {moving?.from === r.category && (
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <div style={{ flex: '1 1 220px' }}>
                <Suggest value={moving.to} onChange={v => setMoving({ ...moving, to: v })}
                  options={(rows || []).map(x => x.category).filter(x => x !== r.category)}
                  placeholder="в какую категорию перенести" autoFocus />
              </div>
              <button className="btn pri sm" disabled={busy || !moving.to.trim()}
                onClick={() => move(moving.from, moving.to, moving.cnt)}>Перенести</button>
              <button className="btn ghost sm" disabled={busy}
                onClick={() => clear(r.category, r.cnt)}>Без категории</button>
              <button className="btn ghost sm" onClick={() => setMoving(null)}>Отмена</button>
            </div>
          )}
        </div>
      ))}

      <div className="row">
        <span className="muted2 spacer">
          «Перенести» — товары уходят в выбранную категорию, а эта исчезает.
          Переименование в существующее имя сливает категории так же.
        </span>
        <button className="btn" onClick={onClose}>Закрыть</button>
      </div>
    </Modal>
  )
}
