// Карточка клиента — то, чего в панели не было вообще: всё про одно заведение
// на одной странице. Раньше владелец видел строку таблицы и кнопку «Продлить»,
// а на вопрос «как у них дела» ответа не было нигде.
import { useState } from 'react'
import { api, fmtDate, daysLeft, daysAgo, money, agoText, agoFine } from '../api'
import { Tile, Chart, Tag, Modal, toast, confirmDialog, calendar, CopyBtn } from '../ui'

export default function ClientCard({ c, kaspiPhone, cities, onBack, onChanged, onIssueFor }) {
  const [renew, setRenew] = useState(false)
  const [edit, setEdit] = useState(false)
  const [snooze, setSnooze] = useState(false)
  const [notes, setNotes] = useState(c.notes || '')
  const [busy, setBusy] = useState(false)
  // Календарь, а не порядок точек: дни без продаж в данных отсутствуют,
  // и без раскладки провал «неделю не работали» на графике не виден.
  const days = calendar(c.days, 30)
  const trial = c.kind === 'trial'

  const save = async () => {
    setBusy(true)
    try { await api('edit', { id: c.id, notes }); toast.ok('Заметка сохранена'); onChanged() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }
  const setRevoked = async (flag) => {
    // Отзыв ломает работу клиента мгновенно, а кнопка стоит рядом с «Продлить».
    // Промах в восемь пикселей стоил бы звонка от клиента.
    if (flag && !await confirmDialog({
      title: 'Отозвать лицензию',
      message: `Касса у «${c.customer}» перестанет работать сразу после следующей проверки.`,
      confirmText: 'Отозвать',
    })) return
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

  // Уход с карточки терял набранную заметку молча. Предупреждаем.
  const dirty = notes !== (c.notes || '')
  const leave = async () => {
    if (dirty && !await confirmDialog({
      title: 'Заметка не сохранена',
      message: 'Уйти и потерять набранный текст?',
      confirmText: 'Уйти',
    })) return
    onBack()
  }

  // Отложенный клиент остаётся в списках и в цифрах — он лишь не попадает в
  // «требует внимания сегодня» до этой даты.
  const snoozedTill = c.snoozed_until && c.snoozed_until > new Date().toISOString().slice(0, 10)
    ? c.snoozed_until : null
  const unsnooze = async () => {
    setBusy(true)
    try { await api('edit', { id: c.id, snoozed_until: null }); toast.ok('Вернули во «внимание»'); onChanged() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const left = daysLeft(c.expires_at)
  const grow = c.prevRevenue7 > 0 ? Math.round((c.revenue7 - c.prevRevenue7) / c.prevRevenue7 * 100) : null

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn ghost" onClick={leave}>← Назад</button>
        <h1 style={{ marginLeft: 4 }}>{c.customer || c.machine_id || c.subject}</h1>
        {trial ? <Tag tone="warn">пробная установка</Tag>
          : c.revoked ? <Tag tone="bad">отозвана</Tag>
            : left !== null && left <= 0 ? <Tag tone="bad">истекла</Tag>
              : <Tag tone="ok">{left === null ? 'бессрочная' : `до ${fmtDate(c.expires_at)}`}</Tag>}
        {c.hidden && <Tag>скрыта из сводки</Tag>}
        {snoozedTill && <Tag>отложен до {fmtDate(snoozedTill)}</Tag>}
        {/* Телефон рядом с именем: сводка говорит «эта касса молчит, позвони» —
            значит звонить надо отсюда, а не искать контакт в заметке. */}
        {c.city && <span className="tag">{c.city}</span>}
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

      {/* SOS: касса сама сообщила, что заблокирована или на отсрочке. Свежее
          недели — тревога; старое не показываем: раз связь идёт и статуса
          нового нет, проблема решена. Журнал — не автоматом, а по кнопке:
          если он не пришёл за 15–20 минут, у кассы нет интернета, и это само
          по себе диагноз. */}
      {c.last_sos && daysAgo(c.last_sos_at) != null && daysAgo(c.last_sos_at) <= 7 && (
        <div className="card" style={{ borderColor: 'var(--bad)', marginBottom: 16 }}>
          <b style={{ color: 'var(--bad)' }}>Касса сообщала о проблеме</b>{' '}
          <span className="muted2">{agoText(c.last_sos_at)} · версия {c.last_sos.app || '—'}</span>
          <div className="muted2" style={{ marginTop: 4 }}>
            статус: <b>{c.last_sos.grace ? `${c.last_sos.grace} (дорабатывала смену по отсрочке)` : c.last_sos.status}</b>
          </div>
        </div>
      )}

      {c.kind !== 'trial' && c.id && <LogRequest c={c} onDone={onChanged} />}

      <div className="grid tiles" style={{ marginBottom: 16 }}>
        <Tile label="Выручка за 7 дней" value={money(c.revenue7 || 0)}
          hint={grow !== null ? `${grow >= 0 ? '+' : ''}${grow}% к прошлой неделе` : 'сравнить не с чем'}
          tone={grow !== null && grow < -30 ? 'bad' : undefined} />
        <Tile label="Выручка за 30 дней" value={money(c.revenue30 || 0)}
          hint={`${c.receipts30 || 0} чеков`} />
        <Tile label="Средний чек" value={c.avgCheck ? money(c.avgCheck) : '—'} hint="за 30 дней" />
        <Tile label="Последняя продажа"
          value={agoText(c.last_sale_at, c.telemetry ? 'продаж не было' : 'связи не было')}
          tone={(daysAgo(c.last_sale_at) ?? 99) >= 3 ? 'bad' : undefined}
          hint={c.last_sale_at ? fmtDate(c.last_sale_at)
            : c.usage_at ? `итоги от кассы: ${agoText(c.usage_at)}`
              : 'касса ещё не отчитывалась'} />
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
            {/* Значок, а не слово «копировать»: рядом с длинным кодом оно не
                помещалось в строку и уносило кнопку на следующую. */}
            <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all' }}>
              {c.subject}{' '}
              <CopyBtn text={c.subject} title="Скопировать код" />
            </dd>
            {/* У пробы код и «компьютер» — одно и то же, а терминалы и дата
                выпуска лицензии смысла не имеют: показывать их незачем. */}
            {!trial && <>
              <dt className="muted2">Компьютер</dt>
              <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                {c.machine_id || 'не привязана'}
                {c.machine_id && <> <CopyBtn text={c.machine_id} title="Скопировать код компьютера" /></>}</dd>
              <dt className="muted2">Терминалов</dt><dd style={{ margin: 0 }}>{c.terminals ?? 1}</dd>
              <dt className="muted2">Цена продления</dt>
              <dd style={{ margin: 0 }}>{c.price ? money(c.price) : <span className="muted2">не указана</span>}</dd>
              <dt className="muted2">Заведена</dt><dd style={{ margin: 0 }}>{fmtDate(c.created_at)}</dd>
            </>}
            <dt className="muted2">Связь</dt><dd style={{ margin: 0 }}>{agoFine(c.last_seen_at)}</dd>
            {trial && <><dt className="muted2">Проба с</dt><dd style={{ margin: 0 }}>{fmtDate(c.started_at)}</dd></>}
          </dl>
          {/* Горячий триал — главный повод действовать, а действия из карточки
              не было: приходилось идти в «Клиенты» и копировать код компьютера
              из другой вкладки. */}
          {trial && (
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn pri" onClick={() => onIssueFor?.(c)}>Выпустить лицензию</button>
            </div>
          )}
          {!trial && (
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn pri" onClick={() => setRenew(true)}>Продлить</button>
              <button className="btn" disabled={busy} onClick={() => setRevoked(!c.revoked)}>
                {c.revoked ? 'Вернуть доступ' : 'Отозвать'}
              </button>
              {/* «Позвонил, договорились на среду» — до среды дёргать не о чем,
                  но клиент продолжает висеть в блоке внимания каждый день. */}
              {snoozedTill
                ? <button className="btn ghost" disabled={busy} onClick={unsnooze}>Вернуть во «внимание»</button>
                : <button className="btn ghost" disabled={busy} onClick={() => setSnooze(true)}>Отложить</button>}
              <button className="btn ghost" disabled={busy} onClick={() => setHidden(!c.hidden)}>
                {c.hidden ? 'Вернуть в список' : 'Скрыть'}
              </button>
            </div>
          )}
        </div>

        {!trial && <History rows={c.renewals} />}

        {!trial && (
          <div className="card">
            <b>Заметка</b>
            <textarea rows={5} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Чем занимаются, кто контактное лицо, о чём договорились"
              style={{ marginTop: 10, resize: 'vertical' }} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" disabled={busy || !dirty} onClick={save}>Сохранить</button>
            </div>
          </div>
        )}
      </div>

      {renew && <RenewModal c={c} kaspiPhone={kaspiPhone}
        onClose={() => setRenew(false)} onDone={onChanged} />}
      {edit && <EditModal c={c} cities={cities} onClose={() => setEdit(false)}
        onDone={() => { setEdit(false); onChanged() }} />}
      {snooze && <SnoozeModal c={c} onClose={() => setSnooze(false)}
        onDone={() => { setSnooze(false); onChanged() }} />}
    </>
  )
}

// История продлений. Раньше от платежа не оставалось ничего, кроме сдвинутой
// даты: сколько клиент уже заплатил и как давно он с нами — узнать было негде.
function History({ rows }) {
  const list = rows || []
  const total = list.reduce((s, r) => s + (r.amount || 0), 0)
  return (
    <div className="card">
      <div className="row">
        <b>Продления</b>
        {total > 0 && <span className="muted2 spacer">всего {money(total)}</span>}
      </div>
      {!list.length && <div className="empty" style={{ padding: '18px 0' }}>
        Продлений ещё не было. Они начнут записываться с первого продления из панели.
      </div>}
      {list.slice(0, 12).map((r, i) => (
        <div key={i} className="row" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
          <span className="muted2">{fmtDate(r.created_at)}</span>
          <span>+{r.days} дн</span>
          <span className="spacer" />
          {r.amount ? <span>{money(r.amount)}</span> : <span className="muted2">сумма не записана</span>}
        </div>
      ))}
    </div>
  )
}

// «Отложить до даты»: клиент никуда не девается, но до этого дня не попадает
// в блок «требует внимания сегодня».
// Журнал кассы — по запросу. Кнопка ставит метку; касса при следующем выходе
// на связь досылает хвост лога. Здоровая звонит раз в 15 минут, а вот сломанная
// — раз в час: у неё нет читаемого файла лицензии, и в облако она выходит
// только вместе с SOS (SOS_EVERY_MS в license.service.ts). Обещать 15 минут
// нельзя ровно там, где журнал и нужен. Не пришёл за час — у кассы нет
// интернета, и это тоже ответ.
function LogRequest({ c, onDone }) {
  const [busy, setBusy] = useState(false)
  const ask = async () => {
    setBusy(true)
    try { await api('requestLog', { id: c.id }); toast.ok('Запрошено — касса дошлёт при выходе на связь'); onDone() }
    catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }
  const pending = c.log_requested_at && (!c.last_log_at || new Date(c.last_log_at) < new Date(c.log_requested_at))
  const fresh = c.last_log_at && c.log_requested_at && new Date(c.last_log_at) >= new Date(c.log_requested_at)
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row">
        <b>Журнал кассы</b>
        <span className="muted2">
          {fresh ? `получен ${agoFine(c.last_log_at)}`
            : pending ? `запрошен ${agoFine(c.log_requested_at)} — придёт при выходе кассы на связь: у работающей это 15 минут, у сломанной до часа`
              : 'запрашивается с кассы по кнопке, приходит при её выходе на связь'}
        </span>
        {/* Главный вопрос во время аварии — звонит ли касса вообще. Без этой
            строки «журнала нет» одинаково читается и как «кассу выключили», и
            как «журнал теряется по дороге», а это разные починки.
            Сравниваем не «сколько минут назад», а связь ПОСЛЕ запроса: если
            касса дозвонилась уже после того, как ты нажал кнопку, и журнала
            всё равно нет — виновата не касса и не интернет клиента. */}
        {pending && (
          <div className="muted2" style={{ marginTop: 6, width: '100%' }}>
            касса выходила на связь: <b>{agoFine(c.last_seen_at)}</b>
            {c.last_seen_at && new Date(c.last_seen_at) > new Date(c.log_requested_at)
              ? <> — уже ПОСЛЕ запроса. Касса и интернет ни при чём: журнал
                  теряется в облаке, звонить клиенту незачем</>
              : <> — запроса она ещё не видела. Ждём её следующего звонка</>}
          </div>
        )}
        <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={busy || !!pending} onClick={ask}>
          {pending ? 'Запрошен…' : 'Запросить лог'}
        </button>
      </div>
      {fresh && c.last_log && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted2" style={{ cursor: 'pointer' }}>показать журнал</summary>
          <pre style={{ margin: '6px 0 0', maxHeight: 320, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>{c.last_log}</pre>
        </details>
      )}
    </div>
  )
}

function SnoozeModal({ c, onClose, onDone }) {
  const plus = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)
  const [date, setDate] = useState(plus(7))
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { await api('edit', { id: c.id, snoozed_until: date }); toast.ok('Отложено'); onDone() }
    catch (e) { toast.err(e.message); setBusy(false) }
  }
  return (
    <Modal title="Отложить до даты" onClose={onClose} keepOpen>
      <div className="muted2">
        «{c.customer}» до этой даты не будет попадать в «требует внимания сегодня».
        В списке клиентов и в цифрах он остаётся.
      </div>
      <div className="row">
        {[3, 7, 30].map(d => (
          <button key={d} className="btn sm" onClick={() => setDate(plus(d))}>
            {d === 30 ? 'месяц' : d + ' дн'}
          </button>
        ))}
      </div>
      <label>До<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <div className="row">
        <button className="btn ghost spacer" onClick={onClose}>Отмена</button>
        <button className="btn pri" disabled={busy || !date} onClick={go}>
          {busy ? 'Секунду…' : 'Отложить'}
        </button>
      </div>
    </Modal>
  )
}

// Имя раньше задавалось один раз при выпуске и оставалось навсегда: опечатался —
// живи с ней. Телефона не было вовсе, число терминалов тоже не менялось.
function EditModal({ c, cities, onClose, onDone }) {
  const [f, setF] = useState({
    customer: c.customer || '', contact: c.contact || '', terminals: c.terminals ?? 1,
    price: c.price ?? '', city: c.city || '',
  })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))

  const go = async () => {
    setBusy(true)
    try {
      const r = await api('edit', {
        id: c.id, customer: f.customer, contact: f.contact, terminals: Number(f.terminals),
        price: f.price === '' ? null : Number(f.price), city: f.city,
      })
      // Частичное сохранение обязано быть видно: молчаливое «Сохранено» после
      // того, как город не записался, — худший исход.
      if (r?.warning) toast.err(r.warning); else toast.ok('Сохранено')
      onDone()
    } catch (e) { toast.err(e.message); setBusy(false) }
  }

  return (
    <Modal title="Изменить клиента" onClose={onClose} keepOpen>
      <label>Название<input value={f.customer} onChange={set('customer')} autoFocus /></label>
      <label>Телефон<input value={f.contact} onChange={set('contact')} placeholder="+7…" inputMode="tel" /></label>
      {/* Город — с подсказкой из уже заведённых: список сам сходится к одному
          написанию, а новый город просто вписывается сюда же. */}
      <label>Город
        <input value={f.city} onChange={set('city')} list="cities-dl" placeholder="Шиели" />
        <datalist id="cities-dl">{(cities || []).map(x => <option key={x} value={x} />)}</datalist>
      </label>
      <label>Терминалов<input type="number" min="1" value={f.terminals} onChange={set('terminals')} /></label>
      {/* Цена одного продления, а не «в месяц»: кто-то платит за месяц, кто-то
          за год — приводить к общему периоду значит гадать за клиента. */}
      <label>Цена продления, ₸
        <input type="number" min="0" value={f.price} onChange={set('price')} placeholder="сколько платит за раз" />
      </label>
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
  // Сумма подставляется из цены клиента: в 9 случаях из 10 платят ровно её,
  // а поправить разовую скидку можно прямо здесь.
  const [amount, setAmount] = useState(c.price ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const n = Number(days) || 0

  const go = async () => {
    setBusy(true)
    try {
      const r = await api('renew', { id: c.id, days: Number(days), amount: amount === '' ? null : Number(amount) })
      // Текст клиенту готовим здесь же: раньше владелец писал его руками
      // каждый раз, подставляя дату из головы.
      setMsg(`Здравствуйте! Подписка iMag продлена до ${fmtDate(r.expires_at)}.`
        + (kaspiPhone ? ` Оплата на Kaspi: ${kaspiPhone}.` : ''))
      toast.ok(`Продлено до ${fmtDate(r.expires_at)}`)
      // Карточку обновляем, но окно оставляем открытым: иначе готовый текст
      // клиенту не показывался вообще, и его писали руками.
      onDone()
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  return (
    <Modal title="Продлить подписку" onClose={onClose} keepOpen>
      <div className="muted2">{c.customer}</div>
      <div className="row">
        <input type="number" min="1" value={days} onChange={e => setDays(e.target.value)} style={{ maxWidth: 110 }} />
        {[30, 90, 365].map(d => (
          <button key={d} className="btn sm" onClick={() => setDays(d)}>{d === 365 ? '1 год' : d + ' дн'}</button>
        ))}
      </div>
      {/* Сумма нужна для истории платежей: без неё продление запишется, но на
          вопрос «сколько он всего заплатил» ответа опять не будет. */}
      <label>Сумма, ₸
        <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)}
          placeholder={c.price ? '' : 'необязательно'} />
      </label>
      {/* Дату видно ДО нажатия: раньше она появлялась только в ответе сервера */}
      <div className="muted2">
        {n > 0 ? `Продлится до ${fmtDate(new Date(Math.max(Date.now(), new Date(c.expires_at || 0).getTime()) + n * 86400000))}`
          : 'Укажите число дней'}
      </div>
      {msg && <>
        <textarea readOnly rows={3} value={msg} />
        <button className="btn" onClick={() => { navigator.clipboard.writeText(msg); toast.ok('Скопировано') }}>
          Скопировать текст клиенту
        </button>
      </>}
      <div className="row">
        <button className="btn ghost spacer" onClick={onClose}>Закрыть</button>
        <button className="btn pri" disabled={busy || n <= 0} onClick={go}>{busy ? 'Секунду…' : 'Продлить'}</button>
      </div>
    </Modal>
  )
}
