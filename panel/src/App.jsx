import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, useApi, pw, setPw, logout, fmtDate } from './api'
import { Toasts, Confirms, Modal, toast } from './ui'
import Summary from './views/Summary'
import Clients from './views/Clients'
import ClientCard from './views/ClientCard'
import Trials, { actionableTrials } from './views/Trials'
import Requests, { pendingCount } from './views/Requests'
import Catalog from './views/Catalog'
import Aliases from './views/Aliases'
import Invoices from './views/Invoices'
import Cloud, { brokenCount } from './views/Cloud'

// Срочное — то, где ждут ответа или что-то сломалось. Каталог и накладные
// разбираются когда удобно, тревожить ими незачем.
const URGENT = new Set(['requests', 'cloud', 'trials'])

// Обычная подписка. Меняется руками в карточке, если у клиента своя цена.
const DEFAULT_PRICE = 8000

const VIEWS = [
  { id: 'summary', label: 'Сводка' },
  { id: 'clients', label: 'Клиенты' },
  { id: 'trials', label: 'Пробные' },
  { id: 'requests', label: 'Заявки' },
  { id: 'catalog', label: 'Каталог' },
  { id: 'aliases', label: 'Названия' },
  { id: 'invoices', label: 'Накладные' },
  { id: 'cloud', label: 'Облако' },
]

export default function App() {
  const [authed, setAuthed] = useState(!!pw())
  if (!authed) return <><Login onOk={() => setAuthed(true)} /><Toasts /></>
  return <Panel />
}

function Login({ onOk }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async (e) => {
    e.preventDefault()
    setBusy(true)
    setPw(value)
    // Проверяем пароль сразу, а не на первом же экране: иначе неверный пароль
    // выглядел бы как «панель не грузится».
    //
    // noReload: обычный api() на 401 перезагружает страницу (пароль сменили —
    // выкидываем на вход). Здесь мы УЖЕ на входе, и перезагрузка съедала бы
    // сообщение об ошибке: экран моргал, поле пустело, причина не называлась.
    try { await api('clients', {}, { noReload: true }); onOk() }
    catch (err) { localStorage.removeItem('panel_pw'); toast.err(err.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="login">
      <form className="card" onSubmit={go}>
        <div className="brand" style={{ padding: 0 }}>iMag — панель</div>
        <input type="password" autoFocus placeholder="Пароль" value={value}
          onChange={e => setValue(e.target.value)} />
        <button className="btn pri" disabled={busy || !value}>{busy ? 'Проверяю…' : 'Войти'}</button>
      </form>
    </div>
  )
}

// Вкладка и открытая карточка живут в адресе, а не только в памяти. Иначе F5
// всегда выкидывал на сводку — а обновление страницы это первое, что делают
// руками. Заодно работают «назад» и «вперёд» в браузере.
function readHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
  const [view, subject] = h.split('/')
  return { view: view || 'summary', subject: subject || null }
}

function Panel() {
  const [route, setRoute] = useState(readHash)
  const view = route.view
  const openClient = route.subject
  const setView = (v) => setRoute({ view: v, subject: null })
  const setOpenClient = (subject) => setRoute(r => ({ ...r, subject }))
  const [menu, setMenu] = useState(false)
  const [issue, setIssue] = useState(null)   // null | {} | {machine_id, customer}
  const [theme, setTheme] = useState(localStorage.getItem('panel_theme') || 'dark')
  const [badges, setBadges] = useState({})
  // Список клиентов с дневными итогами — самый тяжёлый запрос панели, и на
  // «Каталоге», «Заявках», «Накладных» и «Облаке» он не нужен ни для чего.
  // Грузим его только для тех вкладок, которые из него и состоят: открытие
  // панели больше не тянет разом данные всех вкладок.
  const needsClients = view === 'summary' || view === 'clients' || view === 'trials' || !!openClient
  const { data, error, loading, reload, at } = useApi('clients', undefined, needsClients)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('panel_theme', theme)
  }, [theme])

  useEffect(() => {
    const want = '#/' + route.view + (route.subject ? '/' + encodeURIComponent(route.subject) : '')
    if (location.hash !== want) history.replaceState(null, '', want)
  }, [route])

  // Кнопки «назад»/«вперёд» браузера меняют адрес мимо нас — слушаем.
  useEffect(() => {
    const onHash = () => setRoute(readHash())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  // Обновление без вебсокета. Данные меняются примерно раз в сутки (итоги
  // приходят одним пингом от кассы, лицензии правишь ты сам — и после каждого
  // действия панель перечитывает себя), так что держать соединение не за чем.
  //
  // Важно другое: вкладку оставляют открытой, и наутро в ней вчерашние цифры,
  // а «молчит N дней» и «истекает через N дней» считаются в момент отрисовки —
  // то есть врут. Достаточно перечитать в тот момент, когда на вкладку
  // ВЕРНУЛИСЬ: пока на неё не смотрят, свежесть цифр никому не нужна.
  //
  // Таймера «раз в пять минут» здесь был: он тянул из Supabase полный список
  // клиентов с дневными итогами 288 раз в сутки на каждую открытую вкладку —
  // за данные, которые обновляются раз в день. Это оплаченный трафик впустую.
  useEffect(() => {
    const fresh = () => { if (!document.hidden) reload() }
    document.addEventListener('visibilitychange', fresh)
    return () => document.removeEventListener('visibilitychange', fresh)
  }, [reload])

  // Счётчики: смысл бейджа в том, чтобы новая заявка и поломка в облаке
  // находили владельца сами. Раньше они тянулись ОДИН раз при входе — вкладка
  // висела день, заявка приходила, а красной точки не было. Обновляем по тому
  // же расписанию, что и клиентов.
  const reloadBadges = useCallback(() => {
    api('requests/list', { countOnly: true }).then(d =>
      setBadges(b => ({ ...b, requests: d.total ?? pendingCount(d.rows) }))).catch(() => {})
    api('cloud').then(d => setBadges(b => ({ ...b, cloud: brokenCount(d.rows) }))).catch(() => {})
    // countOnly: бейджу нужно только число. Без него открытие панели тянуло
    // сотню распознанных накладных ВМЕСТЕ С ФОТО в base64 — мегабайты ради
    // красной точки в меню.
    api('catalog/pending', { countOnly: true }).then(d =>
      setBadges(b => ({ ...b, catalog: d.total ?? (d.rows || []).length }))).catch(() => {})
    api('invoices/pending', { countOnly: true }).then(d =>
      setBadges(b => ({ ...b, invoices: d.total ?? (d.rows || []).length }))).catch(() => {})
    api('aliases/list', { countOnly: true }).then(d =>
      setBadges(b => ({ ...b, aliases: d.total ?? (d.rows || []).length }))).catch(() => {})
  }, [])

  // ОБЯЗАТЕЛЬНО useCallback. Стрелка прямо в JSX — новая функция на каждую
  // отрисовку, а «Каталог» держит её в зависимостях загрузки очереди: загрузка
  // → счётчик → перерисовка → новая функция → снова загрузка. Получался
  // бесконечный поток запросов, браузер начинал их отклонять
  // (ERR_INSUFFICIENT_RESOURCES), а на экран сыпались ошибки связи.
  const setCatalogCount = useCallback((n) => setBadges(b => ({ ...b, catalog: n })), [])
  // Та же причина, что и у «Каталога»: стрелка прямо в JSX закольцевала бы
  // загрузку очереди через счётчик.
  const setAliasCount = useCallback((n) => setBadges(b => ({ ...b, aliases: n })), [])

  useEffect(() => {
    reloadBadges()
    const fresh = () => { if (!document.hidden) reloadBadges() }
    document.addEventListener('visibilitychange', fresh)
    return () => document.removeEventListener('visibilitychange', fresh)
  }, [reloadBadges])

  // Купивших после пробы отсекает воркер — по machine_id лицензии, а не по
  // статусу строки (его этой строке никто не проставляет). Фильтр по статусу
  // оставлен как второй заслон: если триал когда-нибудь начнёт помечаться сам,
  // клиент не должен считаться и как проба, и как лицензия — плитка «на пробе»
  // врала бы, а в списке клиентов человек двоился.
  const trials = useMemo(
    () => (data?.trials || []).filter(t => t.status !== 'licensed'), [data])
  const cleanData = useMemo(
    () => data ? { ...data, trials } : null, [data, trials])

  const trialsBadge = actionableTrials(trials)

  // «Обновить» и время в шапке относились ТОЛЬКО к клиентам: остальные вкладки
  // грузятся своими хуками, и на «Заявках» кнопка дёргала невидимый запрос —
  // владелец жал и решал, что новых заявок нет. Вкладка регистрирует здесь свою
  // перезагрузку, шапка вызывает именно её.
  const [viewReload, setViewReload] = useState(null)
  const [clientsFilter, setClientsFilter] = useState('all')

  const all = [...(data?.licenses || []), ...trials]
  // Держим subject, а не объект: после продления/отзыва список перечитывается,
  // и старый объект показывал бы вчерашние цифры.
  const current = openClient ? all.find(c => c.subject === openClient) : null

  const isOwnData = needsClients
  const doReload = () => { reload(); reloadBadges(); if (!isOwnData) viewReload?.() }

  const goto = (v) => { setView(v); setMenu(false); setViewReload(null) }
  const open = (c) => { setOpenClient(c.subject); setMenu(false) }

  return (
    <div className="shell">
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <aside className={'side' + (menu ? ' open' : '')}>
        <div className="brand">iMag</div>
        {VIEWS.map(v => {
          const n = v.id === 'trials' ? trialsBadge : badges[v.id]
          return (
            <button key={v.id} className={'nav' + (view === v.id && !current ? ' active' : '')}
              onClick={() => goto(v.id)}>
              {v.label}{n > 0 && (
                <span className={'count' + (URGENT.has(v.id) ? ' urgent' : '')}>{n}</span>
              )}
            </button>
          )
        })}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button className="nav" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          </button>
          <button className="nav" onClick={logout}>Выйти</button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="btn ghost burger" onClick={() => setMenu(true)} aria-label="Меню">☰</button>
          {!current && <h1>{VIEWS.find(v => v.id === view)?.label}</h1>}
          {/* Время последней загрузки: без него не понять, свежие цифры или
              вкладка провисела ночь. Кнопка осталась — обновление само по себе
              работает, но иногда хочется дёрнуть прямо сейчас. */}
          {/* Кнопки «Обновить» нет: панель перечитывает себя при возврате к
              вкладке и раз в пять минут, а если хочется прямо сейчас — F5
              теперь оставляет на той же вкладке (адрес хранит её). Время
              загрузки оставлено: по нему видно, свежие цифры или нет. */}
          <span className="muted2 spacer">
            {loading ? 'обновляю…'
              : isOwnData && at
                ? 'данные на ' + new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
                : ''}
          </span>
        </div>

        {/* Ошибку фонового обновления не показываем баннером: он внезапно
            выталкивал содержимое вниз каждые пять минут. Баннер — только когда
            показывать вообще нечего. */}
        {error && !data && (
          <div className="card" style={{ borderColor: 'var(--bad)' }}>
            <b>Не удалось загрузить данные.</b>
            <div className="muted" style={{ margin: '6px 0 12px' }}>{error}</div>
            <button className="btn pri" onClick={doReload}>Повторить</button>
          </div>
        )}
        {!data && loading && <div className="empty">Загрузка…</div>}

        {data && current && (
          <ClientCard c={current} kaspiPhone={data.kaspiPhone} onBack={() => setOpenClient(null)}
            onChanged={reload}
            onIssueFor={(t) => setIssue({ machine_id: t.machine_id, customer: t.shop || '' })} />
        )}
        {data && !current && view === 'summary' && (
          <Summary data={cleanData} onOpen={open}
            onFilter={(f) => { setClientsFilter(f); goto('clients') }} />
        )}
        {data && !current && view === 'clients' && (
          <Clients key={clientsFilter} data={cleanData} onOpen={open}
            onIssue={() => setIssue({})} initialFilter={clientsFilter} />
        )}
        {data && !current && view === 'trials' && <Trials data={cleanData} onOpen={open} />}
        {!current && view === 'requests' && (
          <Requests onReload={setViewReload} onApproved={() => { reload(); reloadBadges() }} />
        )}
        {!current && view === 'catalog' && (
          <Catalog onReload={setViewReload} onCounts={setCatalogCount} />
        )}
        {!current && view === 'aliases' && (
          <Aliases onReload={setViewReload} onCounts={setAliasCount} />
        )}
        {!current && view === 'invoices' && <Invoices onReload={setViewReload} />}
        {!current && view === 'cloud' && <Cloud onReload={setViewReload} />}
      </main>

      {issue && <IssueModal pre={issue} onClose={() => setIssue(null)} onDone={reload} />}
      <Toasts />
      <Confirms />
    </div>
  )
}

function IssueModal({ pre, onClose, onDone }) {
  const [f, setF] = useState({
    // Цена по умолчанию — обычная подписка: её ставят почти всем, а руками
    // вбивать одно и то же число каждый раз незачем.
    customer: pre?.customer || '', contact: '', days: 30, terminals: 1, notes: '', price: DEFAULT_PRICE,
    // Из карточки триала лицензия сразу привязывается к его компьютеру —
    // иначе код приходилось копировать руками из другой вкладки.
    machine_id: pre?.machine_id || '',
  })
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))

  const go = async () => {
    setBusy(true)
    try {
      const r = await api('issue', {
        ...f, days: Number(f.days), terminals: Number(f.terminals),
        price: f.price === '' ? null : Number(f.price),
      })
      setCode(r.id)
      toast.ok('Лицензия выпущена')
      // Список перечитываем, но окно НЕ закрываем: раньше родитель закрывал его
      // в том же тике, и код активации не показывался вообще — за ним
      // приходилось лезть в карточку клиента.
      onDone()
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Выпустить лицензию" onClose={onClose} keepOpen>
      {code ? (
        <>
          <div className="muted">Код активации — клиент вводит его в кассе:</div>
          <textarea readOnly rows={2} value={code} style={{ fontFamily: 'ui-monospace, monospace' }} />
          <button className="btn pri" onClick={() => { navigator.clipboard.writeText(code); toast.ok('Скопировано') }}>
            Скопировать код
          </button>
          <button className="btn ghost" onClick={onClose}>Закрыть</button>
        </>
      ) : (
        <>
          {f.machine_id && (
            <div className="muted2">Для пробной установки …{f.machine_id.slice(-6)} — касса заберёт лицензию сама.</div>
          )}
          <label>Клиент<input value={f.customer} onChange={set('customer')} autoFocus /></label>
          {/* Телефон спрашиваем сразу: потом, когда касса замолчит и надо будет
              звонить, искать его будет негде. */}
          <label>Телефон<input value={f.contact} onChange={set('contact')} placeholder="+7…" inputMode="tel" /></label>
          <div className="row">
            <label style={{ flex: 1 }}>Дней<input type="number" min="1" value={f.days} onChange={set('days')} /></label>
            <label style={{ flex: 1 }}>Терминалов<input type="number" min="1" value={f.terminals} onChange={set('terminals')} /></label>
          </div>
          {/* Цена спрашивается здесь, а не потом в карточке: договариваются о
              ней ровно сейчас, а через неделю уже не вспомнить. */}
          <label>Цена подписки за {f.days || 30} дн, ₸
            <input type="number" min="0" value={f.price} onChange={set('price')} />
          </label>
          <label>Заметка<input value={f.notes} onChange={set('notes')} placeholder="необязательно" /></label>
          <div className="row">
            <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
            <button className="btn pri" disabled={busy || !f.customer.trim()} onClick={go}>
              {busy ? 'Секунду…' : 'Выпустить'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
