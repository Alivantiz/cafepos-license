// Мелкие кирпичики панели. Своя графика вместо библиотеки: линия по тридцати
// точкам — это два десятка строк, а библиотека тянет сотни килобайт в бандл.
import { useEffect, useRef, useState } from 'react'
import { money } from './api'

export function Tile({ label, value, hint, tone, onClick }) {
  // Кликабельная плитка — не украшение: «Молчат 4» без перехода означало идти
  // в «Клиенты» и выбирать фильтр руками, в главном же сценарии.
  const Box = onClick ? 'button' : 'div'
  return (
    <Box className={'card' + (onClick ? ' tile-link' : '')} onClick={onClick}
      type={onClick ? 'button' : undefined}>
      <div className="tile-label">{label}</div>
      <div className="tile-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </Box>
  )
}

/**
 * Копирование одним значком. Слово «копировать» рядом с кодом лицензии не
 * помещалось в строку и уносило кнопку на следующую — код визуально
 * разваливался на две части. Значок влезает всегда; что он делает, говорят
 * подсказка и aria-label.
 */
export function CopyBtn({ text, title = 'Скопировать' }) {
  const [done, setDone] = useState(false)
  return (
    <button className="btn ghost icon" title={title} aria-label={title}
      onClick={() => {
        navigator.clipboard.writeText(text)
        toast.ok('Скопировано')
        // Отметка на кнопке: тост живёт три секунды и уезжает, а «я это уже
        // копировал» полезно видеть на самом месте.
        setDone(true); setTimeout(() => setDone(false), 1600)
      }}>
      {done
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>}
    </button>
  )
}

/**
 * Поле с подсказкой из существующих значений. Своё, а не <datalist>: тот
 * рисует сам браузер — белый системный список поверх тёмной панели, неотличимый
 * от автозаполнения Chrome, и стилизовать его нечем.
 */
export function Suggest({ value, onChange, options, placeholder, autoFocus }) {
  const [open, setOpen] = useState(false)
  // Куда показывать список. На широком экране — панелью СБОКУ от окна: форма
  // не разъезжается, список виден целиком, и не надо крутить окно. Если справа
  // места нет (узкое окно, телефон) — обычным списком под полем.
  //
  // position: fixed обязателен: у окна своя прокрутка (overflow: auto), и
  // всё, что позиционировано внутри него обычным образом, ею и обрезается.
  const [side, setSide] = useState(null)
  const box = useRef(null)
  const SIDE_MIN_WIDTH = 260
  const SIDE_PAD = 16   // отступ от краёв экрана

  const show = () => {
    const modal = box.current?.closest('.modal')
    const r = modal?.getBoundingClientRect()
    // Панель во всю высоту экрана, а не в высоту окна: категорий два десятка, и
    // упирать список в короткое окно значило прокручивать его при том, что
    // справа полэкрана пустого.
    setSide(r && window.innerWidth - r.right >= SIDE_MIN_WIDTH
      ? { left: r.right + 10, top: SIDE_PAD, maxHeight: window.innerHeight - SIDE_PAD * 2 }
      : null)
    setOpen(true)
  }

  const term = String(value || '').trim().toLowerCase()
  const list = (options || []).filter(o => !term || o.toLowerCase().includes(term)).slice(0, 50)
  const items = (
    // onMouseDown с preventDefault: без него поле теряет фокус раньше, чем
    // проходит клик, и выбрать мышью ничего нельзя.
    <div className={side ? 'suggest-list suggest-side' : 'suggest-list'} style={side || undefined}
      onMouseDown={e => e.preventDefault()}>
      {list.map(o => (
        <button key={o} type="button" className="suggest-item"
          onClick={() => { onChange(o); setOpen(false) }}>{o}</button>
      ))}
    </div>
  )

  return (
    <div ref={box}>
      <input value={value} placeholder={placeholder} autoFocus={autoFocus}
        onChange={e => { onChange(e.target.value); if (!open) show() }}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }} />
      {open && list.length > 0 && items}
    </div>
  )
}

export function Tag({ tone, children }) {
  return <span className={'tag' + (tone ? ' ' + tone : '')}><i className="dot" />{children}</span>
}

/**
 * Раскладка по календарю. usage_daily НЕ содержит дней без продаж, поэтому
 * рисовать по порядку точек нельзя: заведение, отработавшее четыре дня из
 * тридцати, давало такую же гладкую линию, как работавшее каждый день, а
 * провал «пять дней стояли» не был виден вовсе — хотя именно его и ищут.
 */
export function calendar(days, tail) {
  if (!days || !days.length) return []
  const byDay = new Map(days.map(d => [d.day, d.revenue]))
  const last = new Date(days[days.length - 1].day + 'T00:00:00Z')
  const out = []
  for (let i = tail - 1; i >= 0; i--) {
    const t = new Date(last.getTime() - i * 86400000).toISOString().slice(0, 10)
    out.push({ day: t, revenue: byDay.get(t) || 0 })
  }
  // Хвост обрезаем по первому дню, о котором вообще есть данные: у нового
  // клиента иначе рисовались бы три недели нулей до его появления.
  const from = days[0].day
  return out.filter(d => d.day >= from)
}

/** Линия выручки по дням. days: [{day, revenue}] уже отсортированы по дате. */
export function Chart({ days, height = 160 }) {
  if (!days || days.length < 2) return <div className="empty">Мало данных для графика</div>
  const w = 600, h = height, pad = 4
  const max = Math.max(...days.map(d => d.revenue), 1)
  const x = i => pad + (i * (w - pad * 2)) / (days.length - 1)
  const y = v => h - pad - (v / max) * (h - pad * 2 - 14)
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.revenue).toFixed(1)}`).join(' ')
  const area = `${line} L${x(days.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`
  return (
    <>
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
      aria-label={`Выручка по дням, максимум ${money(max)}`}>
      <path d={area} fill="var(--accent)" opacity=".12" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2"
        vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {/* Овал вместо точки: preserveAspectRatio="none" тянет всё по X, поэтому
          круг рисуем эллипсом с обратной пропорцией и не у самого края. */}
      <ellipse cx={Math.min(x(days.length - 1), w - 6)} cy={y(days[days.length - 1].revenue)}
        rx={w / 220} ry="3.5" fill="var(--accent)" />
    </svg>
    <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
      <span className="muted2">{days[0].day.slice(8) + '.' + days[0].day.slice(5, 7)}</span>
      <span className="muted2">максимум {money(max, true)}</span>
      <span className="muted2">{money(days[days.length - 1].revenue, true)} — последний день</span>
    </div>
    </>
  )
}

/** Та же линия, но в размер ячейки таблицы. */
export function Spark({ days }) {
  if (!days || days.length < 2) return <span className="muted2">—</span>
  const w = 84, h = 22
  const max = Math.max(...days.map(d => d.revenue), 1)
  const pts = days.map((d, i) =>
    `${(i * w / (days.length - 1)).toFixed(1)},${(h - 2 - (d.revenue / max) * (h - 4)).toFixed(1)}`)
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5"
        vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Modal({ title, onClose, children, keepOpen }) {
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape' && !keepOpen) onClose() }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onClose, keepOpen])
  return (
    // Клик по фону закрывает только там, где терять нечего. У форм промах мимо
    // окна стирал введённое без предупреждения — а у выпуска лицензии уносил
    // ещё и показанный код активации.
    <div className="backdrop" onClick={keepOpen ? undefined : onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        {/* Крестик обязателен: Escape на телефоне не нажать, а окно занимает
            весь экран — промахнуться по фону некуда. Показываем и у keepOpen:
            он защищает от СЛУЧАЙНОГО закрытия, а не от намеренного. */}
        {/* Шапка НЕ прокручивается вместе с содержимым: у высокого окна
            (выбор модели, выпуск лицензии) крестик уезжал за верхний край, и
            закрыть его на телефоне становилось нечем — Escape там не нажать. */}
        <div className="row modal-head" style={{ alignItems: 'flex-start' }}>
          <h3 style={{ flex: 1, minWidth: 0 }}>{title}</h3>
          <button className="btn sm ghost" onClick={onClose} aria-label="Закрыть" title="Закрыть"
            style={{ marginLeft: 8, lineHeight: 1 }}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

// ── Подтверждение ─────────────────────────────────────────────────────
// Своё окно вместо window.confirm: системное выглядит чужим, показывает адрес
// сайта вместо вопроса и на телефоне выезжает поверх всего.
let ask = () => Promise.resolve(false)
export const confirmDialog = (opts) =>
  ask(typeof opts === 'string' ? { message: opts } : opts)

export function Confirms() {
  const [state, setState] = useState(null)
  useEffect(() => {
    ask = (o) => new Promise(resolve => setState({ ...o, resolve }))
  }, [])
  if (!state) return null
  const done = (v) => { state.resolve(v); setState(null) }
  return (
    <Modal title={state.title || 'Подтвердите'} onClose={() => done(false)}>
      <div className="muted">{state.message}</div>
      <div className="row">
        {/* Фокус на «Отмена», а не на подтверждении: случайный Enter не должен
            удалять. Подтверждение опасного действия — красное, чтобы не
            выглядело как «Сохранить». */}
        <button className="btn ghost spacer" autoFocus onClick={() => done(false)}>
          {state.cancelText || 'Отмена'}
        </button>
        <button className="btn danger" onClick={() => done(true)}>
          {state.confirmText || 'Да'}
        </button>
      </div>
    </Modal>
  )
}

// ── Тосты ─────────────────────────────────────────────────────────────
let push = () => {}
export const toast = {
  ok: (m) => push(m, false),
  err: (m) => push(m, true),
  // Действие с возвратом. Живёт дольше обычного тоста: за 3 секунды понять,
  // что одобрил не то, и попасть в кнопку — нереально.
  undo: (m, onUndo) => push(m, false, onUndo),
}
export function Toasts() {
  const [items, setItems] = useState([])
  useEffect(() => {
    push = (text, err, onUndo) => {
      const id = Date.now() + Math.random()
      // Одно и то же сообщение не дублируем: при череде отказов подряд экран
      // забивался десятком одинаковых плашек, за которыми не было видно ни
      // содержимого, ни того, что ошибка, вообще-то, одна.
      // Тосты с «Отменить» — исключение: каждый относится к своей карточке,
      // и схлопнув их, мы отняли бы возможность вернуть одну из двух.
      setItems(v => (!onUndo && v.some(t => t.text === text)) ? v : [...v, { id, text, err, onUndo }])
      setTimeout(() => setItems(v => v.filter(t => t.id !== id)), onUndo ? 9000 : 3400)
    }
  }, [])
  return (
    <div className="toasts">
      {items.map(t => (
        <div key={t.id} className={'toast' + (t.err ? ' err' : '')}>
          {t.text}
          {t.onUndo && (
            <button className="undo" onClick={() => {
              setItems(v => v.filter(x => x.id !== t.id))
              t.onUndo()
            }}>Отменить</button>
          )}
        </div>
      ))}
    </div>
  )
}
