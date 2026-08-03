// Воронка ДО оплаты. Разбор по состояниям, а не просто список: «истёк, но
// кассу открывают» и «истёк и не открывают» — это разные разговоры с клиентом,
// и глазами по датам их не разделить.
import { fmtDate, daysAgo, money } from '../api'
import { Tag, Spark } from '../ui'

const TRIAL_DAYS = 14   // как в кассе (license.service TRIAL_DAYS)
export const BIZ = { shop: 'магазин', cafe: 'кафе', sauna: 'сауна' }

export function trialState(r, now = Date.now()) {
  const DAY = 86400000
  const seenAgo = Math.floor((now - new Date(r.last_seen_at).getTime()) / DAY)
  const startedAgo = r.started_at ? Math.floor((now - new Date(r.started_at).getTime()) / DAY) : null
  const left = startedAgo == null ? null : TRIAL_DAYS - startedAgo
  if (r.status === 'licensed') return { key: 'licensed' }
  if (r.status === 'expired' && seenAgo <= 3)
    return { key: 'lapsed', label: 'истёк, но кассу открывают', tone: 'warn', seenAgo, left }
  if (left != null && left <= 3 && left > 0)
    return { key: 'hot', label: left === 1 ? 'заканчивается завтра' : `осталось ${left} дн`, tone: 'warn', seenAgo, left }
  if (r.status === 'expired')
    return { key: 'dead', label: 'истёк, кассу не открывают', tone: null, seenAgo, left }
  if (seenAgo >= 3) return { key: 'quiet', label: `молчит ${seenAgo} дн`, tone: null, seenAgo, left }
  return { key: 'live', label: left == null ? 'идёт' : `осталось ${left} дн`, tone: 'ok', seenAgo, left }
}

const ORDER = { lapsed: 0, hot: 1, live: 2, quiet: 3, dead: 4 }

/** Сколько триалов зовут к действию прямо сейчас — это и есть бейдж.
 *  Тихие и мёртвые не считаются: счётчик должен звать, а не мерить базу. */
export function actionableTrials(rows) {
  const now = Date.now()
  return (rows || []).filter(r => r.status !== 'licensed')
    .filter(r => ['lapsed', 'hot'].includes(trialState(r, now).key)).length
}

export default function Trials({ data, onOpen }) {
  const rows = (data.trials || []).filter(r => r.status !== 'licensed')
  const states = rows.map(r => ({ r, s: trialState(r) }))
    .sort((a, b) => (ORDER[a.s.key] - ORDER[b.s.key]) || (a.s.seenAgo - b.s.seenAgo))

  if (!states.length) return <div className="empty">Пробных установок нет</div>
  return (
    <div className="card" style={{ padding: '14px 4px 4px' }}>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Состояние</th><th>Установка</th>
              <th className="num">Чеков за 7 дней</th><th className="num">Выручка</th>
              <th className="num">Начало</th><th className="num">Последний раз</th>
            </tr>
          </thead>
          <tbody>
            {states.map(({ r, s }) => (
              <tr key={r.machine_id} onClick={() => onOpen(r)}>
                <td><Tag tone={s.tone}>{s.label}</Tag></td>
                <td>
                  {/* Код компьютера целиком читать незачем — хвоста хватает,
                      чтобы отличать установки; полный нужен при одобрении. */}
                  <div className="name">…{String(r.machine_id || '').slice(-6)}</div>
                  <div className="muted2">
                    {BIZ[r.business_type] || r.business_type || 'тип не указан'}
                    {r.app_version ? ` · версия ${r.app_version}` : ''}
                  </div>
                </td>
                {/* Торгует ли человек на пробе — главный признак готовности
                    платить, и раньше его не было видно вообще. */}
                <td className="num" style={r.receipts7 ? { color: 'var(--ok)' } : undefined}>
                  {r.telemetry ? (r.receipts7 || 0) : '—'}
                </td>
                <td className="num">
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                    {r.telemetry ? money(r.revenue7, true) : <span className="muted2">нет данных</span>}
                    <Spark days={(r.days || []).slice(-14)} />
                  </div>
                </td>
                <td className="num muted">{fmtDate(r.started_at)}</td>
                <td className="num muted">{daysAgo(r.last_seen_at) === 0 ? 'сегодня' : `${daysAgo(r.last_seen_at)} дн назад`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
