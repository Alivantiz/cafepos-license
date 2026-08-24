// Словарь «как поставщик пишет товар в накладной» → штрихкод.
//
// Кассы шлют сюда имена, которые у них не сопоставились: имя, поставщик, его
// артикул — ни цен, ни остатков. Вендор привязывает штрихкод один раз, и все
// магазины начинают распознавать эту строку сами, включая те, где этого товара
// ещё не видели. Очередь идёт по частоте: сперва то, что реально возят.
import { useEffect, useMemo, useState } from 'react'
import { api, useApi, fmtDate } from '../api'
import { toast, confirmDialog } from '../ui'

export const aliasPendingCount = (rows) => (rows || []).length

const PER_PAGE = 100

export default function Aliases({ onCounts, onReload }) {
  const [tab, setTab] = useState('pending')
  const [page, setPage] = useState(0)
  const { data, error, loading, reload } = useApi('aliases/list', { status: tab })
  useEffect(() => { onReload?.(() => reload) }, [reload, onReload])
  const [q, setQ] = useState('')
  const needle = q.trim()
  // Поиск — общий по всем трём вкладкам, а не по текущей. Внутри одной вкладки
  // он врал: у ждущих кода штрихкода ещё нет, и поиск по коду там не найдёт
  // ничего никогда, а вывод «этого написания в словаре нет вовсе» приходилось
  // собирать из трёх заходов вручную. Теперь пусто — значит правда нет.
  const searching = needle.length >= 3
  const [found, setFound] = useState(null)
  const [searchErr, setSearchErr] = useState(null)
  const [searchTick, setSearchTick] = useState(0)
  useEffect(() => {
    if (!searching) { setFound(null); setSearchErr(null); return }
    let alive = true
    const t = setTimeout(() => {
      api('aliases/search', { q: needle })
        .then(d => { if (alive) { setFound(d.rows || []); setSearchErr(null) } })
        .catch(e => { if (alive) { setFound([]); setSearchErr(e.message) } })
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [needle, searching, searchTick])

  // «Ждут кода» — очередь работы, там порядок по частоте: сперва то, что реально
  // возят. «Привязанные» и «Отклонённые» — журнал сделанного, и там нужен
  // обратный порядок: только что разобранное написание имеет частоту 1–2 и по
  // частоте улетало в конец списка, где владелец его не находил вовсе.
  const tabRows = useMemo(() => {
    let list = data?.rows || []
    if (tab !== 'pending') {
      list = [...list].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    }
    return list
  }, [data, tab])
  const rows = searching ? (found || []) : tabRows
  const afterChange = () => { reload(); if (searching) setSearchTick(t => t + 1) }
  useEffect(() => { if (tab === 'pending') onCounts?.(data?.total ?? tabRows.length) }, [data, tab])
  useEffect(() => { setPage(0) }, [tab, q])
  // Сервер отдаёт ВСЕ написания (после схлопывания их в разы меньше строк),
  // а карточки рисуем страницами: тысяча карточек в DOM тормозит прокрутку,
  // и разбирать такое полотно всё равно невозможно.
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE))
  const shown = rows.slice(page * PER_PAGE, (page + 1) * PER_PAGE)

  // Бесспорные — те, где сами магазины с трёх независимых точек привязали один
  // и тот же код. Искать в них нечего, а разбирать по одной — терять вечер.
  const trustedCount = tabRows.filter(r => r.trusted).length
  const [approving, setApproving] = useState(false)
  const approveTrusted = async () => {
    if (!await confirmDialog({
      title: 'Одобрить бесспорные?',
      message: `${trustedCount} — их код независимо привязали по три и больше магазинов. Спорные и одиночные останутся вам.`,
      confirmText: 'Одобрить',
    })) return
    setApproving(true)
    try {
      const r = await api('aliases/approve-trusted', {})
      // «Осталось» — не ошибка, а нормальный ход: за раз одобряется пачка,
      // иначе воркер упирается в лимит подзапросов Cloudflare.
      toast.ok(r.left ? `Одобрено: ${r.approved}, осталось ${r.left} — нажмите ещё раз` : `Одобрено: ${r.approved}`)
      reload()
    }
    catch (e) { toast.err(e.message) } finally { setApproving(false) }
  }

  if (error) return <div className="card" style={{ borderColor: 'var(--bad)' }}>{error}</div>
  if (loading && !data) return <div className="empty">Загрузка…</div>

  return (
    <>
      <div className="row stickybar" style={{ marginBottom: 14 }}>
        {[['pending', 'Ждут кода'], ['approved', 'Привязанные'], ['rejected', 'Отклонённые']].map(([id, label]) => (
          <button key={id} className={'btn sm' + (tab === id && !searching ? ' pri' : '')}
            // Пока идёт поиск, вкладки на выдачу не влияют: подсвеченная кнопка
            // тут врала бы, что находки именно из неё.
            style={searching ? { opacity: 0.5 } : undefined}
            onClick={() => { setQ(''); setTab(id) }}>{label}</button>
        ))}
        {tab === 'pending' && trustedCount > 0 && (
          <button className="btn sm pri" disabled={approving} onClick={approveTrusted}>
            {approving ? 'Одобряю…' : `Одобрить бесспорные · ${trustedCount}`}
          </button>
        )}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск по всем вкладкам: название или код"
          style={{ marginLeft: 'auto', maxWidth: 260 }} />
        <span className="muted" style={{ fontSize: 13 }}>
          {searching
            ? (found == null ? 'ищу…' : `${found.length} по всем вкладкам`)
            : data?.total != null ? `${data.total} всего` : ''}
        </span>
      </div>

      {searchErr && <div className="card" style={{ borderColor: 'var(--bad)' }}>{searchErr}</div>}

      {!rows.length && !searchErr && (
        <div className="empty">
          {searching
            ? found == null ? 'Ищу…'
              : <>
                  Этого написания в словаре нет вовсе — ни ждущих кода, ни
                  привязанных, ни отклонённых.
                  <div className="muted2" style={{ marginTop: 10 }}>
                    Значит касса его сюда не присылала: либо накладную с ним ещё
                    не разбирали, либо в накладной оно написано иначе.
                  </div>
                </>
            : needle ? 'Введите хотя бы три символа'
            : tab === 'pending'
              ? 'Пусто — всё, что кассы не смогли сопоставить, уже разобрано'
              : 'Здесь пока пусто'}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        {shown.map(r => (
          <AliasCard key={r.id} r={r} onDone={afterChange}
            tab={searching ? (r.status || 'pending') : tab}
            showStatus={searching} />
        ))}
      </div>

      {rows.length > PER_PAGE && (
        <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
          <button className="btn sm" disabled={page <= 0} onClick={() => setPage(p => p - 1)}>← Назад</button>
          <span className="muted2">
            {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, rows.length)} из {rows.length} · стр {page + 1} / {pages}
          </span>
          <button className="btn sm" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Вперёд →</button>
        </div>
      )}
    </>
  )
}

// Что за товар прячется за кодом. Соглашаться с чужой привязкой вслепую
// нельзя: код — это цифры, а ошибка тут разъезжается по всем магазинам.
function CodeName({ r }) {
  if (!r.code_names) return null            // спросить справочник не удалось
  if (!r.code_names.length) {
    return <div style={{ marginTop: 2 }}>в общем справочнике этого кода ещё нет</div>
  }
  return (
    <div style={{ marginTop: 2 }}>
      в справочнике: <b style={{ wordBreak: 'break-word' }}>{r.code_names[0]}</b>
      {/* Разные названия под одним кодом — сам по себе повод не соглашаться. */}
      {r.code_names.length > 1 && (
        <span style={{ color: 'var(--bad)' }}> · и ещё {r.code_names.length - 1}: {r.code_names.slice(1, 3).join(', ')}</span>
      )}
    </div>
  )
}

function AliasCard({ r, onDone, tab, showStatus }) {
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
      {/* В общем поиске находка приходит из любой вкладки. Называем вкладку
          прямо, а не состояние словами: искать её потом всё равно там. */}
      {showStatus && (
        <div style={{ marginBottom: 8 }}>
          <span className={'tag ' + (tab === 'approved' ? 'ok' : tab === 'rejected' ? 'bad' : 'warn')}>
            <span className="dot" />
            во вкладке «{tab === 'approved' ? 'Привязанные' : tab === 'rejected' ? 'Отклонённые' : 'Ждут кода'}»
          </span>
        </div>
      )}
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
          <CodeName r={r} />
        </div>
      )}

      {/* Код, который магазины привязали сами сканером в приёмке. Это не
          заявка «привяжите нам», а готовый ответ: остаётся согласиться. */}
      {editable && r.proposed && (
        <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
          {r.disputed
            ? <>точки прислали <b>разные</b> коды — нужен ваш выбор</>
            : <>магазины уже привязали <b>{r.proposed}</b> ({r.proposed_venues} {r.proposed_venues === 1 ? 'точка' : r.proposed_venues < 5 ? 'точки' : 'точек'})</>}
          {!r.disputed && <CodeName r={r} />}
          {!r.disputed && (
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setBc(r.proposed)}>
              подставить
            </button>
          )}
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
