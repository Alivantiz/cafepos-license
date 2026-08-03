// Карточка клиента — то, чего в панели не было вообще: всё про одно заведение
// на одной странице. Раньше владелец видел строку таблицы и кнопку «Продлить»,
// а на вопрос «как у них дела» ответа не было нигде.
import { useState } from 'react'
import { api, fmtDate, daysLeft, daysAgo, money, agoText } from '../api'
import { Tile, Chart, Tag, Modal, toast, confirmDialog } from '../ui'

export default function ClientCard({ c, kaspiPhone, onBack, onChanged }) {
  const [renew, setRenew] = useState(false)
  const [edit, setEdit] = useState(false)
  const [notes, setNotes] = useState(c.notes || '')
  const [busy, setBusy] = useState(false)
  const days = (c.days || []).slice(-30)
  const trial = c.kind === 'trial'

  const save = async () => {
    setBusy(true)
    try { await api('edit', { id: c.id, notes }); toast.ok('Заметка сохранена'); onChanged() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }
  const setRevoked = async (flag) => {
    setBusy(true)
    try {
      await api('revoke', { id: c.id, revoked: flag })
      toast.ok(flag ? 'Лицензия отозвана' : 'Лицензия возвращена'); onChanged()
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }
  // Скрытая лицензия продолжает работать у клиента — она лишь уходит из списка
  // и из подсчётов сводки. Для тестовых касс это и нужно: они портили средний
  // чек и оборот парка.
  const setHidden = async (flag) => {
    if (flag && !await confirmDialog({
      title: 'Скрыть клиента',
      message: `«${c.customer}» пропадёт из списка и перестанет учитываться в сводке. Лицензия при этом продолжит работать у клиента.`,
      confirmText: 'Скрыть',
    })) return
    setBusy(true)
    try {
      await api('edit', { id: c.id, hidden: flag })
      toast.ok(flag ? 'Скрыта из списка и сводки' : 'Возвращена в список'); onChanged()
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const left = daysLeft(c.expires_at)
  const grow = c.prevRevenue7 > 0 ? Math.round((c.revenue7 - c.prevRevenue7) / c.prevRevenue7 * 100) : null

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn ghost" onClick={onBack}>← Клиенты</button>
        <h1 style={{ marginLeft: 4 }}>{c.customer || c.machine_id || c.subject}</h1>
        {trial ? <Tag tone="warn">пробная установка</Tag>
          : c.revoked ? <Tag tone="bad">отозвана</Tag>
            : left !== null && left <= 0 ? <Tag tone="bad">истекла</Tag>
              : <Tag tone="ok">{left === null ? 'бессрочная' : `до ${fmtDate(c.expires_at)}`}</Tag>}
        {c.hidden && <Tag>скрыта из сводки</Tag>}
        {/* Телефон рядом с именем: сводка говорит «эта касса молчит, позвони» —
            значит звонить надо отсюда, а не искать контакт в заметке. */}
        {c.contact && <a className="tag" href={`tel:${String(c.contact).replace(/[^\d+]/g, '')}`}>{c.contact}</a>}
        {!trial && <button className="btn ghost sm spacer" onClick={() => setEdit(true)}>Изменить</button>}
      </div>

      {!c.telemetry && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warn)' }}>
          <b>Данных о работе нет.</b>{' '}
          <span className="muted">Касса ещё не обновилась до версии, которая отправляет итоги дня.
            Лицензия и связь при этом видны — они приходят по старому каналу.</span>
        </div>
      )}

      <div className="grid tiles" style={{ marginBottom: 16 }}>
        <Tile label="Выручка за 7 дней" value={money(c.revenue7 || 0, true)}
          hint={grow !== null ? `${grow >= 0 ? '+' : ''}${grow}% к прошлой неделе` : 'сравнить не с чем'}
          tone={grow !== null && grow < -30 ? 'bad' : undefined} />
        <Tile label="Выручка за 30 дней" value={money(c.revenue30 || 0, true)}
          hint={`${c.receipts30 || 0} чеков`} />
        <Tile label="Средний чек" value={c.avgCheck ? money(c.avgCheck) : '—'} hint="за 30 дней" />
        <Tile label="Последняя продажа" value={agoText(c.last_sale_at)}
          tone={(daysAgo(c.last_sale_at) ?? 99) >= 3 ? 'bad' : undefined}
          hint={c.last_sale_at ? fmtDate(c.last_sale_at) : 'ни одной продажи'} />
        <Tile label="Касс / точек" value={`${c.registers ?? '—'} / ${c.locations ?? '—'}`}
          hint={c.app_version ? 'версия ' + c.app_version : ''} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Выручка по дням</b><span className="muted2">последние 30 дней</span>
        </div>
        <Chart days={days} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <div className="card">
          <b>Лицензия</b>
          <dl style={{ margin: '10px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '7px 14px' }}>
            <dt className="muted2">Код</dt>
            <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}>
              {c.subject}{' '}
              <button className="btn ghost sm" onClick={() => {
                navigator.clipboard.writeText(c.subject); toast.ok('Скопировано')
              }}>копировать</button>
            </dd>
            <dt className="muted2">Компьютер</dt>
            <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              {c.machine_id || 'не привязана'}</dd>
            <dt className="muted2">Терминалов</dt><dd style={{ margin: 0 }}>{c.terminals ?? 1}</dd>
            <dt className="muted2">Заведена</dt><dd style={{ margin: 0 }}>{fmtDate(c.created_at)}</dd>
            <dt className="muted2">Связь</dt><dd style={{ margin: 0 }}>{agoText(c.last_seen_at)}</dd>
            {trial && <><dt className="muted2">Проба с</dt><dd style={{ margin: 0 }}>{fmtDate(c.started_at)}</dd></>}
          </dl>
          {!trial && (
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn pri" onClick={() => setRenew(true)}>Продлить</button>
              <button className="btn" disabled={busy} onClick={() => setRevoked(!c.revoked)}>
                {c.revoked ? 'Вернуть доступ' : 'Отозвать'}
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => setHidden(!c.hidden)}>
                {c.hidden ? 'Вернуть в список' : 'Скрыть'}
              </button>
            </div>
          )}
        </div>

        {!trial && (
          <div className="card">
            <b>Заметка</b>
            <textarea rows={5} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Чем занимаются, кто контактное лицо, о чём договорились"
              style={{ marginTop: 10, resize: 'vertical' }} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" disabled={busy || notes === (c.notes || '')} onClick={save}>Сохранить</button>
            </div>
          </div>
        )}
      </div>

      {renew && <RenewModal c={c} kaspiPhone={kaspiPhone}
        onClose={() => setRenew(false)} onDone={() => { setRenew(false); onChanged() }} />}
      {edit && <EditModal c={c} onClose={() => setEdit(false)}
        onDone={() => { setEdit(false); onChanged() }} />}
    </>
  )
}

// Имя раньше задавалось один раз при выпуске и оставалось навсегда: опечатался —
// живи с ней. Телефона не было вовсе, число терминалов тоже не менялось.
function EditModal({ c, onClose, onDone }) {
  const [f, setF] = useState({
    customer: c.customer || '', contact: c.contact || '', terminals: c.terminals ?? 1,
  })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))

  const go = async () => {
    setBusy(true)
    try {
      await api('edit', {
        id: c.id, customer: f.customer, contact: f.contact, terminals: Number(f.terminals),
      })
      toast.ok('Сохранено'); onDone()
    } catch (e) { toast.err(e.message); setBusy(false) }
  }

  return (
    <Modal title="Изменить клиента" onClose={onClose}>
      <label>Название<input value={f.customer} onChange={set('customer')} autoFocus /></label>
      <label>Телефон<input value={f.contact} onChange={set('contact')} placeholder="+7…" inputMode="tel" /></label>
      <label>Терминалов<input type="number" min="1" value={f.terminals} onChange={set('terminals')} /></label>
      <div className="row">
        <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
        <button className="btn pri" disabled={busy || !f.customer.trim()} onClick={go}>
          {busy ? 'Секунду…' : 'Сохранить'}
        </button>
      </div>
    </Modal>
  )
}

function RenewModal({ c, kaspiPhone, onClose, onDone }) {
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const go = async () => {
    setBusy(true)
    try {
      const r = await api('renew', { id: c.id, days: Number(days) })
      // Текст клиенту готовим здесь же: раньше владелец писал его руками
      // каждый раз, подставляя дату из головы.
      setMsg(`Здравствуйте! Подписка iMag продлена до ${fmtDate(r.expires_at)}.`
        + (kaspiPhone ? ` Оплата на Kaspi: ${kaspiPhone}.` : ''))
      toast.ok(`Продлено до ${fmtDate(r.expires_at)}`)
      onDone()
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Продлить подписку" onClose={onClose}>
      <div className="muted2">{c.customer}</div>
      <div className="row">
        <input type="number" min="1" value={days} onChange={e => setDays(e.target.value)} style={{ maxWidth: 110 }} />
        {[30, 90, 365].map(d => (
          <button key={d} className="btn sm" onClick={() => setDays(d)}>{d === 365 ? '1 год' : d + ' дн'}</button>
        ))}
      </div>
      {msg && <>
        <textarea readOnly rows={3} value={msg} />
        <button className="btn" onClick={() => { navigator.clipboard.writeText(msg); toast.ok('Скопировано') }}>
          Скопировать текст клиенту
        </button>
      </>}
      <div className="row">
        <button className="btn ghost spacer" onClick={onClose}>Закрыть</button>
        <button className="btn pri" disabled={busy} onClick={go}>{busy ? 'Секунду…' : 'Продлить'}</button>
      </div>
    </Modal>
  )
}
