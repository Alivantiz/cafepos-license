import { useEffect, useState } from 'react'
// Разбор ИИ-распознаваний накладных: фото, что распозналось, и решение —
// «разобрано» (фото удаляется) или «удалить целиком».
import { api, useApi } from '../api'
import { toast, confirmDialog, Modal } from '../ui'

// Выбор модели распознавания. Открывается кликом по нынешней модели: сперва
// показываем, как модели показали себя на ЖИВЫХ накладных и сколько это стоит,
// и только потом даём переключить.
//
// Качество считается по самой накладной, без ручной разметки: количество × цена
// должно давать сумму строки, сумма строк — напечатанный итог, а у штрихкода
// есть контрольная цифра.
function ModelPicker() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [budget, setBudget] = useState('')

  const load = async () => {
    try {
      const d = await api('invoices/models', {})
      setData(d); setBudget(String(d.budget || ''))
    } catch (e) { toast.err(e.message) }
  }
  useEffect(() => { load() }, [])

  const pick = async (m) => {
    if (!await confirmDialog({
      title: 'Сменить модель распознавания',
      message: `Все накладные всех магазинов будут распознаваться моделью «${m.name}» — примерно ${m.kzt} тг за накладную. Действует сразу, выкладка не нужна.`,
      confirmText: 'Сменить',
    })) return
    setBusy(true)
    try { await api('invoices/setModel', { model: m.id }); toast.ok('Модель сменена'); await load() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const saveBudget = async () => {
    setBusy(true)
    try { await api('invoices/setModel', { budget: Number(budget) || 0 }); toast.ok('Бюджет сохранён'); await load() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const now = data?.models?.find(m => m.id === data.current)
  const label = now?.name ?? (data?.current || 'модель по умолчанию')

  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="Какой моделью распознаются накладные">
        Модель: {label}
      </button>
      {open && (
        <Modal title="Модель распознавания" onClose={() => setOpen(false)}>
          {!data ? <div className="empty">Загрузка…</div> : (
            <>
              <div className="muted2" style={{ marginBottom: 10 }}>
                За месяц распознано {data.done}, потрачено{' '}
                {data.spentReal ? '' : '≈'}{data.spent.toLocaleString('ru-RU')} тг
                {data.spentReal
                  ? <span title="Счёт Anthropic по отчёту Usage & Cost"> (по счёту)</span>
                  : <span title="Число распознаваний × цена выбранной модели. Точную сумму даст админский ключ Anthropic"> (оценка)</span>}
                {data.budget > 0 && <> из {data.budget.toLocaleString('ru-RU')} — осталось{' '}
                  <b style={{ color: data.spent > data.budget ? 'var(--bad)' : 'var(--ok)' }}>
                    {Math.max(0, data.budget - data.spent).toLocaleString('ru-RU')} тг
                  </b></>}
              </div>

              {/* Ошибку отчёта прячем не молча: без неё непонятно, почему
                  вместо счёта показана оценка. */}
              {data.costError && (
                <div className="muted2" style={{ color: 'var(--bad)', marginBottom: 10 }}>
                  Счёт получить не удалось: {data.costError}
                </div>
              )}

              {!data.models.length && (
                <div className="empty">
                  Функция parse-invoice не ответила списком моделей — выберите её версию не ниже
                  2026-08-20.3 и проверьте, что в секретах есть хотя бы один ключ провайдера.
                </div>
              )}

              {data.models.map(m => {
                const st = data.stats.find(x => x.model === m.id)
                const cur = m.id === data.current
                return (
                  <div key={m.id} className="card" style={{ marginBottom: 10, borderColor: cur ? 'var(--ok)' : undefined }}>
                    <div className="row">
                      <b>{m.name}</b>
                      <span className="muted2">≈{m.kzt} тг за накладную · {m.note}</span>
                      <span style={{ marginLeft: 'auto' }}>
                        {cur ? <span className="tag ok">сейчас</span>
                          : <button className="btn sm" disabled={busy} onClick={() => pick(m)}>Выбрать</button>}
                      </span>
                    </div>
                    {/* Без накладных на этой модели сравнивать нечего — так и пишем,
                        вместо прочерков, которые выглядят как ноль процентов. */}
                    <div className="muted2" style={{ marginTop: 6 }}>
                      {st
                        ? <>на {st.invoices} накладных: суммы строк сходятся {st.sumPct ?? '—'}%,
                            штрихкоды {st.codePct ?? '—'}%, итог документа {st.totalPct ?? '—'}%</>
                        : 'на этой модели накладных ещё не было'}
                    </div>
                  </div>
                )
              })}

              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <input value={budget} onChange={e => setBudget(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric" placeholder="Бюджет на месяц, тг" style={{ flex: 1, minWidth: 0 }} />
                <button className="btn sm" disabled={busy} onClick={saveBudget}>Сохранить</button>
              </div>
              <div className="muted2" style={{ marginTop: 8 }}>
                Доли считаются по самой накладной: количество × цена должно давать сумму строки,
                сумма строк — напечатанный итог, а у штрихкода сходится контрольная цифра.
                Список моделей приходит от самой функции и собран из её ключей: добавишь ключ
                нового провайдера — его модели появятся здесь сами. Баланса счёта в API нет ни у
                кого, поэтому «осталось» считается от бюджета, который ты задаёшь тут же.
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  )
}

// Количество, цена и сумма строки. Раньше писали «15 уп · 800», и это читалось
// как «15 упаковок за 800» — хотя 800 это цена ОДНОЙ упаковки, а строка стоит
// 12 000. Показываем умножение целиком, чтобы читать было нечего.
function Money({ it }) {
  const num = (v) => Number(String(v ?? '').replace(',', '.')) || 0
  const qty = it.quantity ?? it.qty
  const price = it.price
  const sum = num(qty) * num(price)
  const printed = num(it.line_total)
  // Напечатанная сумма расходится с умножением — распознавание ошиблось в
  // цифре, и это надо видеть: на такой строке разъезжается вся приёмка.
  const off = printed > 0 && Math.abs(printed - sum) > 1
  const fmt = (n) => Math.round(n).toLocaleString('ru-RU')
  if (qty == null && price == null) return null
  return (
    <>
      {qty ?? ''}{it.unit ? ' ' + it.unit : ''}
      {price != null && <> × {fmt(num(price))}</>}
      {price != null && qty != null && <> = {fmt(sum)}</>}
      {off && (
        <b style={{ color: 'var(--bad)' }} title="В накладной напечатана другая сумма строки — проверьте цифры">
          {' '}(в накладной {fmt(printed)})
        </b>
      )}
    </>
  )
}

export default function Invoices({ onReload }) {
  // «Разобранные» — журнал: фото у них уже стёрто, но распознанный текст цел,
  // и по нему можно привязать коды, если выяснилось, что привязано не то.
  const [reviewed, setReviewed] = useState(false)
  const { data, error, loading, reload } = useApi('invoices/pending', { reviewed })
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
  // Ручная привязка одной строки: «4605627000662 ?» → поправить цифру и
  // привязать, не уходя во вкладку «Названия».
  const [edit, setEdit] = useState(null)     // `${id}:${index}`
  const [val, setVal] = useState('')
  const open = (id, i, code) => { setEdit(`${id}:${i}`); setVal(code || '') }
  const bindOne = async (id, index) => {
    try {
      const r = await api('invoices/bindOne', { id: Number(id), index, barcode: val })
      toast.ok(r.note || (r.checksum
        ? 'Привязано — уедет на кассы'
        : 'Привязано как есть — контрольная цифра у этого кода не сходится'))
      setEdit(null); reload()
    } catch (e) { toast.err(e.message) }
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

  const mb = (b) => b >= 1048576 ? Math.round(b / 1048576) + ' МБ' : Math.round(b / 1024) + ' КБ'

  return (
    <>
      <div className="row stickybar" style={{ marginBottom: 12 }}>
        {[[false, 'Неразобранные'], [true, 'Разобранные']].map(([id, label]) => (
          <button key={String(id)} className={'btn sm' + (reviewed === id ? ' pri' : '')}
            onClick={() => setReviewed(id)}>{label}</button>
        ))}
        <ModelPicker />
        {/* Место кончается молча: база бесплатного тарифа не бесконечная, а
            весит в ней именно base64 фотографий. */}
        {data?.photos?.count > 0 && (
          <span className="muted2" style={{ marginLeft: 'auto' }}>
            фото хранится у {data.photos.count} накладных
            {data.photos.approx_bytes ? ` · ≈${mb(data.photos.approx_bytes)}` : ''}
          </span>
        )}
      </div>

      {!rows.length && (
        <div className="empty">{reviewed ? 'Разобранных накладных пока нет' : 'Неразобранных накладных нет'}</div>
      )}

      {/* Раньше писали «показано 40 из 137», а посмотреть остальное было
          нечем. Объясняем, что список сам сократится по мере разбора. */}
      {!reviewed && rows.length > 0 && data?.total != null && (
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
                  flexWrap: 'wrap',
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
                        ? <b onClick={() => open(r.id, i, it.code_bad)} style={{ color: 'var(--bad)', cursor: 'pointer' }}
                            title="Контрольная цифра не сходится — распознавание ошиблось в цифре. Нажмите, чтобы поправить и привязать">
                            {it.code_bad} ?{' '}
                          </b>
                        : <span onClick={() => open(r.id, i, '')} style={{ cursor: 'pointer' }}
                            title="Штрихкода в этой строке распознавание не вернуло. Нажмите, чтобы вбить его с бумаги">
                            без кода{' '}
                          </span>}
                    <Money it={it} />
                  </span>
                  {/* Чем красный код МОГ быть: замена одной цифры, прошедшая
                      контрольную сумму и нашедшаяся в справочнике. Название
                      рядом — чтобы согласиться глазами, а не вслепую. */}
                  {it.code_fix?.length > 0 && edit !== `${r.id}:${i}` && (
                    <div className="muted2" style={{ width: '100%', paddingBottom: 4 }}>
                      {it.code_fix.map(f => (
                        <div key={f.barcode} style={{ padding: '2px 0' }}>
                          похоже, <b style={{ fontVariantNumeric: 'tabular-nums' }}>{f.barcode}</b> — {f.name}
                          <button className="btn sm" style={{ marginLeft: 8 }}
                            onClick={() => { open(r.id, i, f.barcode) }}>подставить</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Правка кода на месте. Контрольную сумму тут не требуем:
                      владелец держит накладную в руках, а панель — нет. Но если
                      код не сходится, скажем об этом после привязки. */}
                  {edit === `${r.id}:${i}` && (
                    <div className="row" style={{ gap: 8, width: '100%', padding: '6px 0' }}>
                      <input value={val} onChange={e => setVal(e.target.value.replace(/\D/g, ''))}
                        inputMode="numeric" autoFocus placeholder="Штрихкод с бумаги"
                        onKeyDown={e => { if (e.key === 'Enter') bindOne(r.id, i) }}
                        style={{ flex: 1, minWidth: 140, fontVariantNumeric: 'tabular-nums' }} />
                      <button className="btn sm pri" disabled={val.length < 8} onClick={() => bindOne(r.id, i)}>Привязать</button>
                      <button className="btn sm ghost" onClick={() => setEdit(null)}>Отмена</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            {!reviewed && (
              <button className="btn pri" disabled={busy === r.id} onClick={() => review(r.id)}>
                {busy === r.id ? 'Секунду…' : 'Разобрано'}
              </button>
            )}
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
