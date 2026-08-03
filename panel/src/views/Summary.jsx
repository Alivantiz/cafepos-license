// Главная — не список, а ответ на вопрос «что сегодня требует внимания».
// Прежняя панель открывалась таблицей лицензий, отсортированной по дате
// создания: чтобы понять, кому звонить, приходилось читать её глазами целиком.
import { daysLeft, daysAgo, money, fmtDate } from '../api'
import { Tile, Chart, Tag } from '../ui'

const isLive = (c) => !c.revoked && (c.expires_at === null || daysLeft(c.expires_at) > 0)

export default function Summary({ data, onOpen, onGoto }) {
  // Скрытые не участвуют в сводке ВООБЩЕ: тестовые кассы владельца, где чеки
  // пробиваются по сто тенге, тянули вниз средний чек всего парка и искажали
  // оборот — цифрам нельзя было верить.
  const licenses = (data.licenses || []).filter(c => !c.hidden)
  const trials = data.trials || []
  const live = licenses.filter(isLive)

  // Молчащие: не «давно не выходил на связь», а «давно не продавал». Касса
  // может исправно звонить за лицензией и при этом не пробить ни чека —
  // именно это и значит, что клиент отваливается.
  const silent = live.filter(c => c.telemetry && (daysAgo(c.last_sale_at) ?? 99) >= 3)
  const expiring = live.filter(c => { const d = daysLeft(c.expires_at); return d !== null && d <= 14 })
  const expired = licenses.filter(c => !c.revoked && c.expires_at && daysLeft(c.expires_at) <= 0)
  const hotTrials = trials.filter(t => (t.receipts7 || 0) > 0)

  // Выручка всех заведений за 30 дней — не твои деньги, а масштаб парка:
  // по нему видно, растёт ли то, на чём стоит касса.
  const gmv30 = licenses.reduce((s, c) => s + (c.revenue30 || 0), 0)

  // Суммарная кривая по дням: складываем все заведения по датам.
  const byDay = new Map()
  for (const c of licenses) for (const d of c.days || []) {
    byDay.set(d.day, (byDay.get(d.day) || 0) + d.revenue)
  }
  const series = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .slice(-30).map(([day, revenue]) => ({ day, revenue }))

  const noTelemetry = live.filter(c => !c.telemetry).length

  return (
    <>
      <div className="grid tiles" style={{ marginBottom: 16 }}>
        <Tile label="Платящих" value={live.length}
          hint={licenses.length > live.length ? `${licenses.length - live.length} неактивных` : 'все лицензии живы'} />
        <Tile label="На пробе" value={trials.length}
          hint={hotTrials.length ? `${hotTrials.length} уже торгуют` : 'торгующих нет'} />
        <Tile label="Истекает за 14 дней" value={expiring.length}
          tone={expiring.length ? 'warn' : undefined}
          hint={expired.length ? `${expired.length} уже истекли` : 'просроченных нет'} />
        <Tile label="Молчат 3+ дня" value={silent.length}
          tone={silent.length ? 'bad' : undefined} hint="нет продаж" />
        <Tile label="Оборот парка за 30 дней" value={money(gmv30, true)}
          hint={noTelemetry ? `${noTelemetry} без телеметрии` : 'по всем заведениям'} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Выручка всех заведений</b>
          <span className="muted2">последние 30 дней</span>
        </div>
        <Chart days={series} />
      </div>

      <Upcoming licenses={licenses} onOpen={onOpen} />

      <Attention title="Требует внимания сегодня" onGoto={onGoto} items={[
        ...expired.map(c => ({ c, why: 'лицензия истекла', tone: 'bad' })),
        ...expiring.map(c => ({ c, why: `истекает через ${daysLeft(c.expires_at)} дн`, tone: 'warn' })),
        ...silent.map(c => ({ c, why: `нет продаж ${daysAgo(c.last_sale_at)} дн`, tone: 'bad' })),
        ...hotTrials.map(c => ({ c, why: `на пробе, ${c.receipts7} чеков за неделю`, tone: 'ok' })),
      ]} onOpen={onOpen} />
    </>
  )
}

// Кто платит следующим и когда. Оплата подписки — это и есть продление, так
// что дата окончания лицензии и есть дата платежа; календарь просто ставит их
// по порядку, чтобы не выискивать глазами в общем списке.
//
// Суммы тут нет и не будет, пока цена не хранится: в licenses её нет вовсе.
function Upcoming({ licenses, onOpen }) {
  const rows = licenses
    .filter(c => !c.revoked && c.expires_at)
    .map(c => ({ c, left: daysLeft(c.expires_at) }))
    .filter(x => x.left <= 45)
    .sort((a, b) => a.left - b.left)
    .slice(0, 10)

  if (!rows.length) return null
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <b>Ближайшие платежи</b>
        <span className="muted2">оплата = продление подписки</span>
      </div>
      {rows.map(({ c, left }) => (
        <div key={c.subject} className="row"
          style={{ padding: '9px 0', borderTop: '1px solid var(--line)' }}>
          <button className="btn ghost sm" style={{ fontWeight: 550 }} onClick={() => onOpen(c)}>
            {c.customer}
          </button>
          {c.contact && <a className="muted2" href={`tel:${String(c.contact).replace(/[^\d+]/g, '')}`}>{c.contact}</a>}
          <span className="spacer" />
          <span className="muted2">{fmtDate(c.expires_at)}</span>
          <Tag tone={left <= 0 ? 'bad' : left <= 7 ? 'warn' : null}>
            {left <= 0 ? `просрочено ${-left} дн` : left === 0 ? 'сегодня' : `через ${left} дн`}
          </Tag>
        </div>
      ))}
    </div>
  )
}

function Attention({ title, items, onOpen }) {
  // Один клиент может попасть в список дважды (истекает И молчит) — показываем
  // обе причины в одной строке, иначе список раздувается дублями.
  const merged = new Map()
  for (const it of items) {
    const key = it.c.subject
    if (!merged.has(key)) merged.set(key, { c: it.c, whys: [], tone: it.tone })
    merged.get(key).whys.push(it.why)
    if (it.tone === 'bad') merged.get(key).tone = 'bad'
  }
  const list = [...merged.values()]
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}><b>{title}</b>
        <span className="muted2">{list.length ? `${list.length} шт` : ''}</span></div>
      {!list.length && <div className="empty">Всё спокойно — никого дёргать не надо</div>}
      {list.map(({ c, whys, tone }) => (
        <div key={c.subject} className="row" style={{ padding: '9px 0', borderTop: '1px solid var(--line)' }}>
          <button className="btn ghost sm" onClick={() => onOpen(c)} style={{ fontWeight: 550 }}>
            {c.customer || c.machine_id || c.subject}
          </button>
          <span className="muted2" style={{ color: `var(--${tone})` }}>{whys.join(' · ')}</span>
        </div>
      ))}
    </div>
  )
}
