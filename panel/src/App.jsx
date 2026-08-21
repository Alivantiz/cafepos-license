import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { brokenCount } from './views/Cloud'
import { PushSettings } from './push'
import TabBar, { SettingsIcon } from './tabbar'

// Обычная подписка. Меняется руками в карточке, если у клиента своя цена.
const DEFAULT_PRICE = 8000

const LABELS = {
  summary: 'Сводка', clients: 'Клиенты', trials: 'Пробные', requests: 'Заявки',
  invoices: 'Накладные', catalog: 'Каталог', aliases: 'Названия',
}

// Разделов восемь, а МЕСТ — четыре. Восемь вкладок на телефоне не помещаются,
// и пятая «Ещё» списком — плохой ответ: что за ней спрятано, перестают
// открывать вовсе. Поэтому родственные экраны сложены в одно место с
// переключателем внутри:
//   «Пробные» — тот же список клиентов до оплаты, а не другой раздел;
//   накладные, каталог и названия — одна работа: разобрать товар. Прыгать
//   между тремя вкладками ради неё приходилось постоянно.
// «Облако» вкладкой не стало: это не место, а индикатор — открывается со
// строки состояния в «Клиентах», когда что-то сломалось.
const GROUPS = [
  { id: 'summary', label: 'Сводка', views: ['summary'] },
  { id: 'clients', label: 'Клиенты', views: ['clients', 'trials'], urgent: true },
  { id: 'requests', label: 'Заявки', views: ['requests'], urgent: true },
  { id: 'goods', label: 'Товары', views: ['invoices', 'catalog', 'aliases'] },
]
const groupOf = (view) => GROUPS.find(g => g.views.includes(view)) || GROUPS[0]

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
  const [settings, setSettings] = useState(false)
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
    // Системная строка в приложении с домашнего экрана красится в theme-color.
    // Без подмены светлая тема оставалась с чёрной полосой сверху.
    document.querySelector('meta[name=theme-color]')
      ?.setAttribute('content', theme === 'dark' ? '#0e1013' : '#f5f6f8')
  }, [theme])

  // Открытие карточки клиента — шаг ВГЛУБЬ: «назад» (и свайп от края) должны
  // вернуть к списку. Смена вкладки шагом не считается, иначе назад пришлось бы
  // жать столько раз, сколько вкладок пролистал.
  const prevRoute = useRef(route)
  useEffect(() => {
    const want = '#/' + route.view + (route.subject ? '/' + encodeURIComponent(route.subject) : '')
    if (location.hash !== want) {
      const deeper = route.subject && !prevRoute.current.subject
      history[deeper ? 'pushState' : 'replaceState'](null, '', want)
    }
    prevRoute.current = route
  }, [route])

  // Свайп от левого края — «назад», как в любом приложении на телефоне. В
  // приложении с домашнего экрана системного жеста нет: там нет и браузера,
  // чей это жест. Только когда есть куда возвращаться — иначе свайп закрывал бы
  // само приложение.
  useEffect(() => {
    if (!route.subject) return
    let x0 = null, y0 = 0
    const start = (e) => {
      const t = e.touches[0]
      x0 = t.clientX <= 28 ? t.clientX : null
      y0 = t.clientY
    }
    const end = (e) => {
      const t = e.changedTouches[0]
      if (x0 !== null && t.clientX - x0 > 70 && Math.abs(t.clientY - y0) < 60) history.back()
      x0 = null
    }
    addEventListener('touchstart', start, { passive: true })
    addEventListener('touchend', end, { passive: true })
    return () => { removeEventListener('touchstart', start); removeEventListener('touchend', end) }
  }, [route.subject])

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
    // Кассы, сообщившие о беде, плюс само облако лицензий. Без этой точки
    // владелец узнавал о поломке от клиента: данные в панели были, а звать
    // они не звали — надо было догадаться открыть нужную вкладку.
    api('health').then(d =>
      setBadges(b => ({ ...b, clients: (d.sos || 0) + (d.ok ? 0 : 1) }))).catch(() => {})
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

  // Города берём из самих клиентов, отдельного справочника нет: новый город
  // появляется в списке, как только его поставили первому клиенту. Так список
  // не расходится с тем, что есть на самом деле, и заводить его нечем не надо.
  const cities = useMemo(() => {
    const seen = new Set()
    for (const c of data?.licenses || []) if (c.city) seen.add(String(c.city).trim())
    return [...seen].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [data])

  const trialsBadge = actionableTrials(trials)
  // Счётчик места — сумма счётчиков всего, что в нём лежит: иначе очередь в
  // «Названиях» или лежачая облачная функция были бы не видны, пока не
  // откроешь нужный переключатель.
  const GROUP_BADGE = {
    summary: 0,
    // Облако живёт за строкой состояния в «Клиентах» — его беда считается тут же.
    clients: (badges.clients || 0) + (badges.cloud || 0) + trialsBadge,
    requests: badges.requests || 0,
    goods: (badges.invoices || 0) + (badges.catalog || 0) + (badges.aliases || 0),
  }

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

  const goto = (v) => { setView(v); setViewReload(null) }
  const open = (c) => setOpenClient(c.subject)

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">iMag</div>
        {GROUPS.map(g => {
          const n = GROUP_BADGE[g.id]
          return (
            <button key={g.id} className={'nav' + (g.views.includes(view) && !current ? ' active' : '')}
              onClick={() => goto(g.views[0])}>
              {g.label}{n > 0 && (
                <span className={'count' + (g.urgent ? ' urgent' : '')}>{n}</span>
              )}
            </button>
          )
        })}
        <div style={{ marginTop: 'auto' }}>
          <button className="nav" onClick={() => setSettings(true)}>Настройки</button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          {/* У места из одного экрана — обычный заголовок. Где экранов
              несколько, заголовок ЗАМЕНЯЕТСЯ переключателем: он и так называет
              раздел, а вторая строка сдвинула бы прилипшие панели вкладок. */}
          {!current && (groupOf(view).views.length > 1
            ? <div className="subtabs">
                {groupOf(view).views.map(v => (
                  <button key={v} className={'seg' + (v === view ? ' on' : '')}
                    onClick={() => goto(v)}>{LABELS[v]}</button>
                ))}
              </div>
            : <h1>{groupOf(view).label}</h1>)}
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
          <button className="btn ghost icon" onClick={() => setSettings(true)}
            aria-label="Настройки" title="Настройки"><SettingsIcon /></button>
        </div>

        {/* Ошибку фонового обновления не показываем баннером: он внезапно
            выталкивал содержимое вниз каждые пять минут. Баннер — только когда
            показывать вообще нечего. */}
        {/* Только на вкладках, которые из этих данных и состоят. Хук клиентов
            на остальных отключён и старую ошибку не сбрасывает — красная плашка
            «не удалось загрузить» висела поверх нормально загруженного
            «Каталога» или «Названий» и обвиняла в поломке не ту вкладку. */}
        {needsClients && error && !data && (
          <div className="card" style={{ borderColor: 'var(--bad)' }}>
            <b>Не удалось загрузить данные.</b>
            <div className="muted" style={{ margin: '6px 0 12px' }}>{error}</div>
            <button className="btn pri" onClick={doReload}>Повторить</button>
          </div>
        )}
        {!data && loading && <div className="empty">Загрузка…</div>}

        {data && current && (
          <ClientCard c={current} kaspiPhone={data.kaspiPhone} cities={cities} onBack={() => setOpenClient(null)}
            onChanged={reload}
            onIssueFor={(t) => setIssue({ machine_id: t.machine_id, customer: t.shop || '' })} />
        )}
        {data && !current && view === 'summary' && (
          <Summary data={cleanData} onOpen={open}
            onFilter={(f) => { setClientsFilter(f); goto('clients') }} />
        )}
        {data && !current && view === 'clients' && (
          <Clients key={clientsFilter} data={cleanData} onOpen={open} cities={cities}
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
      </main>

      {/* Места под большим пальцем. Ровно те же четыре, что и в боковом меню
          на большом экране — иначе это два разных приложения. */}
      <TabBar active={current ? null : groupOf(view).id}
        tabs={GROUPS.map(g => ({ id: g.id, label: g.label, badge: GROUP_BADGE[g.id], urgent: g.urgent }))}
        onPick={(id) => goto(GROUPS.find(g => g.id === id).views[0])} />

      {settings && (
        <Modal title="Настройки" onClose={() => setSettings(false)}>
          <h3 style={{ margin: '4px 0 0' }}>Уведомления</h3>
          <PushSettings />
          <div className="row" style={{ gap: 8, marginTop: 18 }}>
            <button className="btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            </button>
            <button className="btn ghost" onClick={logout}>Выйти</button>
          </div>
        </Modal>
      )}

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
  // Бессрочная лицензия — ОСОЗНАННОЕ действие, а не пустое поле. Раньше
  // Number('') давало 0, воркер на 0 ставил expires_at = null, и лицензия
  // навсегда выдавалась молча: стёр поле, чтобы вписать 90, отвлёкся — и
  // клиент бесплатно получил вечную. В списке это выглядело просто прочерком
  // в сроке, неотличимо от «ещё не активирована».
  const [forever, setForever] = useState(false)
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))
  const daysOk = forever || Number(f.days) > 0

  const go = async () => {
    setBusy(true)
    try {
      const r = await api('issue', {
        ...f, days: forever ? 0 : Number(f.days), terminals: Number(f.terminals),
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
            <label style={{ flex: 1 }}>
              Дней
              {forever
                ? <input value="без срока" readOnly disabled />
                : <input type="number" min="1" value={f.days} onChange={set('days')} />}
            </label>
            <label style={{ flex: 1 }}>Терминалов<input type="number" min="1" value={f.terminals} onChange={set('terminals')} /></label>
          </div>
          <label className="row" style={{ alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={forever} onChange={e => setForever(e.target.checked)} style={{ width: 'auto' }} />
            Бессрочная — без даты окончания
          </label>
          {/* Цена спрашивается здесь, а не потом в карточке: договариваются о
              ней ровно сейчас, а через неделю уже не вспомнить. */}
          <label>Цена подписки{forever ? '' : ` за ${f.days || 30} дн`}, ₸
            <input type="number" min="0" value={f.price} onChange={set('price')} />
          </label>
          <label>Заметка<input value={f.notes} onChange={set('notes')} placeholder="необязательно" /></label>
          <div className="row">
            <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
            <button className="btn pri" disabled={busy || !f.customer.trim() || !daysOk} onClick={go}>
              {busy ? 'Секунду…' : forever ? 'Выпустить бессрочную' : 'Выпустить'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
