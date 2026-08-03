import { useEffect, useState } from 'react'
import { api, useApi, pw, setPw, logout, fmtDate } from './api'
import { Toasts, Modal, toast } from './ui'
import Summary from './views/Summary'
import Clients from './views/Clients'
import ClientCard from './views/ClientCard'
import Trials, { actionableTrials } from './views/Trials'
import Requests, { pendingCount } from './views/Requests'
import Catalog from './views/Catalog'
import Invoices from './views/Invoices'
import Cloud, { brokenCount } from './views/Cloud'

const VIEWS = [
  { id: 'summary', label: 'Сводка' },
  { id: 'clients', label: 'Клиенты' },
  { id: 'trials', label: 'Пробные' },
  { id: 'requests', label: 'Заявки' },
  { id: 'catalog', label: 'Каталог' },
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
    try { await api('clients'); onOk() }
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

function Panel() {
  const [view, setView] = useState('summary')
  const [openClient, setOpenClient] = useState(null)   // subject открытой карточки
  const [menu, setMenu] = useState(false)
  const [issue, setIssue] = useState(false)
  const [theme, setTheme] = useState(localStorage.getItem('panel_theme') || 'dark')
  const [badges, setBadges] = useState({})
  const { data, error, loading, reload } = useApi('clients')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('panel_theme', theme)
  }, [theme])

  // Счётчики тянем при входе, а не при открытии вкладки: смысл бейджа в том,
  // чтобы новая заявка и поломка в облаке находили владельца сами.
  useEffect(() => {
    api('requests/list').then(d => setBadges(b => ({ ...b, requests: pendingCount(d.rows) }))).catch(() => {})
    api('cloud').then(d => setBadges(b => ({ ...b, cloud: brokenCount(d.rows) }))).catch(() => {})
    api('catalog/pending').then(d =>
      setBadges(b => ({ ...b, catalog: d.total ?? (d.rows || []).length }))).catch(() => {})
    api('invoices/pending').then(d =>
      setBadges(b => ({ ...b, invoices: d.total ?? (d.rows || []).length }))).catch(() => {})
  }, [])

  const trialsBadge = actionableTrials(data?.trials)

  const goto = (v) => { setView(v); setOpenClient(null); setMenu(false) }
  const open = (c) => { setOpenClient(c.subject); setMenu(false) }

  const all = [...(data?.licenses || []), ...(data?.trials || [])]
  // Держим subject, а не объект: после продления/отзыва список перечитывается,
  // и старый объект показывал бы вчерашние цифры.
  const current = openClient ? all.find(c => c.subject === openClient) : null

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
              {v.label}{n > 0 && <span className="count">{n}</span>}
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
          <button className="btn ghost sm spacer" onClick={reload} disabled={loading}>
            {loading ? 'Обновляю…' : 'Обновить'}
          </button>
        </div>

        {error && <div className="card" style={{ borderColor: 'var(--bad)' }}>{error}</div>}
        {!data && loading && <div className="empty">Загрузка…</div>}

        {data && current && (
          <ClientCard c={current} kaspiPhone={data.kaspiPhone} onBack={() => setOpenClient(null)}
            onChanged={reload} />
        )}
        {data && !current && view === 'summary' && (
          <Summary data={data} onOpen={open} onGoto={goto} />
        )}
        {data && !current && view === 'clients' && (
          <Clients data={data} onOpen={open} onIssue={() => setIssue(true)} />
        )}
        {data && !current && view === 'trials' && <Trials data={data} onOpen={open} />}
        {!current && view === 'requests' && (
          <Requests onApproved={() => {
            reload()
            api('requests/list').then(d => setBadges(b => ({ ...b, requests: pendingCount(d.rows) }))).catch(() => {})
          }} />
        )}
        {!current && view === 'catalog' && (
          <Catalog onCounts={(n) => setBadges(b => ({ ...b, catalog: n }))} />
        )}
        {!current && view === 'invoices' && <Invoices />}
        {!current && view === 'cloud' && <Cloud />}
      </main>

      {issue && <IssueModal onClose={() => setIssue(false)} onDone={() => { setIssue(false); reload() }} />}
      <Toasts />
    </div>
  )
}

function IssueModal({ onClose, onDone }) {
  const [f, setF] = useState({ customer: '', days: 30, terminals: 1, notes: '' })
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))

  const go = async () => {
    setBusy(true)
    try {
      const r = await api('issue', { ...f, days: Number(f.days), terminals: Number(f.terminals) })
      setCode(r.id)
      toast.ok('Лицензия выпущена')
      onDone()
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Выпустить лицензию" onClose={onClose}>
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
          <label>Клиент<input value={f.customer} onChange={set('customer')} autoFocus /></label>
          <div className="row">
            <label style={{ flex: 1 }}>Дней<input type="number" min="1" value={f.days} onChange={set('days')} /></label>
            <label style={{ flex: 1 }}>Терминалов<input type="number" min="1" value={f.terminals} onChange={set('terminals')} /></label>
          </div>
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
