// Главная — не список, а ответ на вопрос «что сегодня требует внимания».
// Прежняя панель открывалась таблицей лицензий, отсортированной по дате
// создания: чтобы понять, кому звонить, приходилось читать её глазами целиком.
import { daysLeft, daysAgo, money, fmtDate, isLive } from '../api'
import { Tile, Chart, Tag, calendar } from '../ui'

export default function Summary({ data, onOpen, onFilter }) {
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
  // Истёкшие берём только свежие: без окна клиент, ушедший год назад, висел бы
  // в списке «сегодня» вечно, и через полгода блок перестали бы читать.
  const expired = licenses.filter(c =>
    !c.revoked && c.expires_at && daysLeft(c.expires_at) <= 0 && daysLeft(c.expires_at) > -30)
  const lost = licenses.filter(c =>
    !c.revoked && c.expires_at && daysLeft(c.expires_at) <= -30).length
  const hotTrials = trials.filter(t => (t.receipts7 || 0) > 0)

  // Свои деньги, а не чужие. Оборот парка красив, но это выручка клиентов —
  // на неё нельзя ни жить, ни планировать. Считаем то, что приходит тебе:
  // сколько получено за месяц и сколько ждать в следующем.
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString()
  const income30 = licenses.reduce((s, c) =>
    s + (c.renewals || []).reduce((a, r) => a + (r.created_at >= monthAgo ? (r.amount || 0) : 0), 0), 0)
  const soon = licenses.filter(c => !c.revoked && c.expires_at
    && daysLeft(c.expires_at) > 0 && daysLeft(c.expires_at) <= 30)
  const expected30 = soon.reduce((s, c) => s + (c.price || 0), 0)
  const noPrice = soon.filter(c => !c.price).length

  // Суммарная кривая по дням: складываем все заведения по датам.
  const byDay = new Map()
  for (const c of licenses) for (const d of c.days || []) {
    byDay.set(d.day, (byDay.get(d.day) || 0) + d.revenue)
  }
  const series = calendar(
    [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([day, revenue]) => ({ day, revenue })), 30)

  const noTelemetry = live.filter(c => !c.telemetry).length
  const today = new Date().toISOString().slice(0, 10)

  // Ноль клиентов: плитки писали «все лицензии живы» и «всё спокойно» —
  // экран выглядел рабочим, хотя данных нет вовсе.
  if (!licenses.length && !trials.length) {
    return <div className="empty">
      Клиентов пока нет. Выпустите первую лицензию на вкладке «Клиенты».
    </div>
  }

  return (
    <>
      <div className="grid tiles" style={{ marginBottom: 16 }}>
        <Tile label="Платящих" value={live.length} onClick={() => onFilter("live")}
          hint={licenses.length > live.length ? `${licenses.length - live.length} неактивных` : 'все лицензии живы'} />
        <Tile label="На пробе" value={trials.length} onClick={() => onFilter("trial")}
          hint={hotTrials.length ? `${hotTrials.length} уже торгуют` : 'торгующих нет'} />
        <Tile label="Истекает за 14 дней" value={expiring.length} onClick={() => onFilter("expiring")}
          tone={expiring.length ? 'warn' : undefined}
          hint={expired.length ? `${expired.length} уже истекли` : lost ? `${lost} потеряны давно` : 'просроченных нет'} />
        <Tile label="Молчат 3+ дня" value={silent.length} onClick={() => onFilter("silent")}
          tone={silent.length ? 'bad' : undefined} hint="нет продаж" />
        <Tile label="Получено за 30 дней" value={money(income30, true)}
          hint="по записанным продлениям" />
        <Tile label="Ожидается за 30 дней" value={money(expected30, true)}
          hint={noPrice ? `у ${noPrice} из ${soon.length} не указана цена` : `${soon.length} продлений`} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          {/* Оборот парка — не твои деньги, отдельной плитки он больше не
              занимает. График оставлен как диагностика: по нему видно, что
              кассы работают, а не встали все разом. */}
          <b>Выручка всех заведений</b>
          <span className="muted2">
            последние 30 дней{noTelemetry ? ` · ${noTelemetry} без телеметрии` : ''}
          </span>
        </div>
        <Chart days={series} />
      </div>

      <Upcoming licenses={licenses} onOpen={onOpen} />

      <Attention title="Требует внимания сегодня" today={today} items={[
        ...expired.map(c => ({ c, why: 'лицензия истекла', tone: 'bad' })),
        ...expiring.map(c => ({ c, why: `истекает через ${daysLeft(c.expires_at)} дн`, tone: 'warn' })),
        // Пустая дата — не «нет продаж null дн», а «ни одной продажи»: касса
        // стоит и молчит с самой установки. Это другой разговор с клиентом.
        ...silent.map(c => ({
          c, tone: 'bad',
          why: c.last_sale_at ? `нет продаж ${daysAgo(c.last_sale_at)} дн` : 'ни одной продажи',
        })),
        ...hotTrials.map(c => ({ c, why: `на пробе, ${c.receipts7} чеков за неделю`, tone: 'ok' })),
      ]} onOpen={onOpen} />
    </>
  )
}

// Кто платит следующим и когда. Оплата подписки — это и есть продление, так
// что дата окончания лицензии и есть дата платежа; календарь просто ставит их
// по порядку, чтобы не выискивать глазами в общем списке.
function Upcoming({ licenses, onOpen }) {
  const rows = licenses
    .filter(c => !c.revoked && c.expires_at)
    .map(c => ({ c, left: daysLeft(c.expires_at) }))
    // Нижняя граница — та же, что у «истекли» в плитках: без неё ушедший
    // полгода назад клиент не просто висел в календаре, а занимал место в
    // первой десятке (сортировка по возрастанию) и вытеснял тех, кто платит
    // на следующей неделе. Итог по колонке при этом считал и его цену.
    .filter(x => x.left <= 45 && x.left > -30)
    .sort((a, b) => a.left - b.left)
    .slice(0, 10)

  if (!rows.length) return null
  const total = rows.reduce((s, x) => s + (x.c.price || 0), 0)
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <b>Ближайшие платежи</b>
        <span className="muted2">оплата = продление подписки</span>
        {/* Итог по колонке: главный вопрос к календарю — «сколько всего
            придёт», а складывать строки глазами владелец не должен. */}
        {total > 0 && <span className="spacer">{money(total)}</span>}
      </div>
      {rows.map(({ c, left }) => (
        <div key={c.subject} className="row"
          style={{ padding: '9px 0', borderTop: '1px solid var(--line)' }}>
          <button className="btn ghost sm" style={{ fontWeight: 550 }} onClick={() => onOpen(c)}>
            {c.customer}
          </button>
          {c.contact && <a className="muted2" href={`tel:${String(c.contact).replace(/[^\d+]/g, '')}`}>{c.contact}</a>}
          <span className="spacer" />
          {/* Цена продления стоит рядом с датой: «когда» без «сколько» —
              половина ответа. Без цены пишем прочерк, чтобы было видно, у кого
              её ещё не проставили. */}
          <span className={c.price ? '' : 'muted2'}>{c.price ? money(c.price) : '— ₸'}</span>
          <span className="muted2">{fmtDate(c.expires_at)}</span>
          <Tag tone={left <= 0 ? 'bad' : left <= 7 ? 'warn' : null}>
            {left < 0 ? `просрочено ${-left} дн` : left === 0 ? 'сегодня' : `через ${left} дн`}
          </Tag>
        </div>
      ))}
    </div>
  )
}

function Attention({ title, items, onOpen, today }) {
  // Один клиент может попасть в список дважды (истекает И молчит) — показываем
  // обе причины в одной строке, иначе список раздувается дублями.
  const merged = new Map()
  for (const it of items) {
    const key = it.c.subject
    if (!merged.has(key)) merged.set(key, { c: it.c, whys: [], tone: it.tone })
    merged.get(key).whys.push(it.why)
    if (it.tone === 'bad') merged.get(key).tone = 'bad'
  }
  // Отложенные: про них уже позвонили и договорились. Оставлять их в блоке
  // значило приучить владельца не читать блок вообще — «там всегда те же».
  const all = [...merged.values()]
  const list = all.filter(x => !(x.c.snoozed_until && x.c.snoozed_until > today))
  const snoozed = all.length - list.length
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}><b>{title}</b>
        <span className="muted2">
          {list.length ? `${list.length} шт` : ''}{snoozed ? ` · ${snoozed} отложено` : ''}
        </span></div>
      {!list.length && <div className="empty">Всё спокойно — никого дёргать не надо</div>}
      {list.map(({ c, whys, tone }) => (
        <div key={c.subject} className="row" style={{ padding: '9px 0', borderTop: '1px solid var(--line)' }}>
          <button className="btn ghost sm" onClick={() => onOpen(c)} style={{ fontWeight: 550 }}>
            {c.customer || c.machine_id || c.subject}
          </button>
          {/* Блок отвечает на «кому звонить» — значит номер должен быть здесь,
              а не в двух действиях отсюда. */}
          {c.contact && <><a className="tag" href={`tel:${String(c.contact).replace(/[^\d+]/g, '')}`}>{c.contact}</a>
            {/* Переписка в Казахстане идёт в вотсапе — без ссылки номер
                приходится копировать в другое приложение руками. */}
            <a className="tag" target="_blank" rel="noreferrer"
              href={`https://wa.me/${String(c.contact).replace(/\D/g, '')}`}>WhatsApp</a></>}
          <span className="muted2" style={{ color: `var(--${tone})` }}>{whys.join(' · ')}</span>
        </div>
      ))}
    </div>
  )
}
