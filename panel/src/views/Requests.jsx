// Заявки на активацию: касса шлёт заявку, владелец одобряет, касса сама
// забирает лицензию. Раньше код компьютера приходилось выпрашивать у клиента —
// ровно то, ради чего заявки и делались.
import { useState , useEffect} from 'react'
import { api, useApi, fmtDate } from '../api'
import { Tag, Modal, toast, confirmDialog } from '../ui'
import { BIZ } from './Trials'

/** Ждут решения = заявка есть, а лицензии по ней ещё нет. Остальное — история. */
export const pendingCount = (rows) =>
  (rows || []).filter(r => r.status !== 'rejected' && !r.license_id).length

export default function Requests({ onApproved, onReload }) {
  const { data, error, loading, reload } = useApi('requests/list')
  useEffect(() => { onReload?.(() => reload) }, [reload, onReload])
  const [approve, setApprove] = useState(null)
  const [tab, setTab] = useState('waiting')
  const [busy, setBusy] = useState(null)
  const rows = data?.rows || []

  const reject = async (r) => {
    if (busy) return
    if (!await confirmDialog({
      title: 'Отклонить заявку',
      message: `Заявка от «${r.shop || 'без названия'}» будет отклонена. Касса лицензию не получит.`,
      confirmText: 'Отклонить',
    })) return
    setBusy(r.machine_id)
    try { await api('requests/reject', { machine_id: r.machine_id }); toast.ok('Отклонена'); reload() }
    catch (e) { toast.err(e.message) } finally { setBusy(null) }
  }

  if (error) return <div className="card" style={{ borderColor: 'var(--bad)' }}>{error}</div>
  if (loading && !data) return <div className="empty">Загрузка…</div>
  if (!rows.length) return <div className="empty">Заявок нет</div>

  // Ждущие решения отдельно от истории: иначе через год это стена из двух сотен
  // карточек, среди которых надо найти одну новую.
  const waiting = rows.filter(r => r.status !== 'rejected' && !r.license_id)
  const history = rows.filter(r => !waiting.includes(r))
  const shown = tab === 'waiting' ? waiting : history

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className={'btn sm' + (tab === 'waiting' ? ' pri' : '')} onClick={() => setTab('waiting')}>
          Ждут решения{waiting.length ? ` ${waiting.length}` : ''}
        </button>
        <button className={'btn sm' + (tab === 'history' ? ' pri' : '')} onClick={() => setTab('history')}>
          История{history.length ? ` ${history.length}` : ''}
        </button>
      </div>
      {!shown.length && <div className="empty">
        {tab === 'waiting' ? 'Все заявки разобраны' : 'История пуста'}</div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        {shown.map(r => {
          const waiting = r.status !== 'rejected' && !r.license_id
          return (
            <div className="card" key={r.machine_id}>
              <div className="row">
                <b>{r.shop || 'Без названия'}</b>
                {waiting ? <Tag tone="warn">ждёт решения</Tag>
                  : r.status === 'rejected' ? <Tag tone="bad">отклонена</Tag>
                    : <Tag tone="ok">одобрена</Tag>}
              </div>
              <div className="muted2" style={{ marginTop: 6, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                {r.machine_id}
              </div>
              <div className="muted2" style={{ marginTop: 4 }}>
                {r.contact || 'контакт не указан'} · {BIZ[r.business_type] || r.business_type || '—'}
                {' · версия '}{r.app_version || '—'} · {fmtDate(r.created_at)}
              </div>
              {r.license_id && <div className="muted2" style={{ marginTop: 4 }}>лицензия {r.license_id}</div>}
              {waiting && (
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn pri" onClick={() => setApprove(r)}>Одобрить</button>
                  <button className="btn" disabled={busy === r.machine_id} onClick={() => reject(r)}>Отклонить</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {approve && <ApproveModal r={approve} onClose={() => setApprove(null)}
        onDone={() => { setApprove(null); reload(); onApproved() }} />}
    </>
  )
}

// Раньше одобрение спрашивало два подряд prompt() — имя и срок. Промахнулся в
// первом, отменил, начинай сначала. Здесь это одна форма.
function ApproveModal({ r, onClose, onDone }) {
  const [customer, setCustomer] = useState(r.shop || '')
  const [days, setDays] = useState(30)
  const [terminals, setTerminals] = useState(1)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    try {
      const d = await api('requests/approve', {
        machine_id: r.machine_id, customer, days: Number(days), terminals: Number(terminals),
      })
      toast.ok('Одобрено: ' + d.id)
      onDone()
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Одобрить заявку" onClose={onClose}>
      <label>Клиент — как назвать в списке
        <input value={customer} onChange={e => setCustomer(e.target.value)} autoFocus /></label>
      <div className="row">
        <label style={{ flex: 1 }}>Дней (0 — бессрочно)
          <input type="number" min="0" value={days} onChange={e => setDays(e.target.value)} /></label>
        <label style={{ flex: 1 }}>Терминалов
          <input type="number" min="1" value={terminals} onChange={e => setTerminals(e.target.value)} /></label>
      </div>
      <div className="muted2">Касса заберёт лицензию сама, вводить код клиенту не нужно.</div>
      <div className="row">
        <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
        <button className="btn pri" disabled={busy || !customer.trim()} onClick={go}>
          {busy ? 'Секунду…' : 'Одобрить'}
        </button>
      </div>
    </Modal>
  )
}
