// Панель подписок iMag — Cloudflare Pages, «Advanced mode»: этот _worker.js
// лежит в корне сборки и обрабатывает все запросы (отдаёт страницу и API).
// Переменные окружения Pages-проекта: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// PANEL_PASSWORD; опционально OWNER_KASPI_PHONE (подставляется в текст клиенту).
// Сервис-role ключ живёт только здесь (server-side) — в браузер не попадает.

const sb = (env) => ({
  url: (env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  }
})

// Отдельный проект Supabase — тот же, что у монитора зала/мультикассы.
// Там живёт общий словарь штрихкодов (mon_barcodes), не в проекте лицензий.
const sb2 = (env) => ({
  url: (env.MONITOR_SUPABASE_URL || '').trim().replace(/\/$/, ''),
  headers: {
    apikey: env.MONITOR_SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.MONITOR_SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  }
})

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

// YYYY-MM-DD со сдвигом в днях. Панель и касса считают дни по-разному (у кассы
// местное время заведения), поэтому окна тут — грубые, «за последние N дней»,
// а не бухгалтерские периоды.
export const isoDay = (shift = 0) => new Date(Date.now() + shift * 86400000).toISOString().slice(0, 10)

// Свёртки по хвосту дней: выручка и чеки за 7 и 30 дней + средний чек.
// Средний чек считаем от ТРИДЦАТИ дней: недельный слишком прыгает на маленьких
// заведениях, где пара банкетов переворачивает картину.
export function window_(days) {
  const sum = (fromDay) => days.reduce((a, d) => d.day >= fromDay
    ? { revenue: a.revenue + d.revenue, receipts: a.receipts + d.receipts } : a,
    { revenue: 0, receipts: 0 })
  const w7 = sum(isoDay(-7)), w30 = sum(isoDay(-30)), prev = (() => {
    const from = isoDay(-14), to = isoDay(-7)
    return days.reduce((a, d) => d.day >= from && d.day < to ? a + d.revenue : a, 0)
  })()
  return {
    revenue7: w7.revenue, receipts7: w7.receipts,
    revenue30: w30.revenue, receipts30: w30.receipts,
    prevRevenue7: prev,
    avgCheck: w30.receipts ? Math.round(w30.revenue / w30.receipts) : 0,
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)

    // Старая страница целиком — временная подстраховка на время переезда на
    // React. Новый интерфейс пока не покрывает каталог, накладные, заявки и
    // облако; пока не покроет, здесь лежит рабочая панель со всем этим.
    // УДАЛИТЬ вместе с константой PAGE, как только перенос закончен.
    if (pathname === '/legacy') {
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    // Всё, что не API, — собранное приложение (Vite → dist). В «Advanced mode»
    // Pages статику сам не отдаёт: воркер перехватывает ВСЕ запросы, поэтому
    // ассеты берём явно через env.ASSETS.
    if (!pathname.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Сборка не найдена: проверьте build command и output directory', { status: 500 })
      const res = await env.ASSETS.fetch(request)
      // Одностраничное приложение: неизвестный путь — это не 404, а маршрут
      // внутри него, отдаём index.html.
      if (res.status === 404) return env.ASSETS.fetch(new URL('/', request.url))
      return res
    }

    // Автопинг (GitHub Actions, раз в день): лёгкий запрос в оба Supabase-проекта,
    // чтобы бесплатные проекты не заснули после 7 дней без активности. Доступен
    // без пароля — наружу уходят только булевы статусы, данных в ответе нет.
    if (pathname === '/api/keepalive') {
      const ping = async (p) => {
        if (!p.url) return false
        try {
          const r = await fetch(`${p.url}/rest/v1/`, { headers: p.headers })
          return r.ok
        } catch { return false }
      }
      const [licenses, monitor] = await Promise.all([ping(sb(env)), ping(sb2(env))])
      return json({ ok: licenses && monitor, licenses, monitor }, licenses && monitor ? 200 : 502)
    }

    // ponytail: простое сравнение пароля; при реальном риске перебора — Cloudflare Access
    if (!env.PANEL_PASSWORD || request.headers.get('x-panel-key') !== env.PANEL_PASSWORD) {
      return json({ error: 'Неверный пароль' }, 401)
    }
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405)

    const db = sb(env)
    if (!db.url || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Не заданы секреты SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500)
    }

    try {
      if (pathname === '/api/list') {
        const r = await fetch(`${db.url}/rest/v1/licenses?select=id,customer,machine_id,expires_at,terminals,revoked,activated_at,last_seen_at,notes,created_at&order=created_at.desc`, { headers: db.headers })
        if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
        return json({ rows: await r.json(), kaspiPhone: (env.OWNER_KASPI_PHONE || '').trim() })
      }

      // Пробные установки — воронка ДО оплаты. Касса без лицензии раз в сутки
      // сообщает своё состояние (Edge Function trial → таблица trials), но
      // посмотреть это было негде: ни вкладки, ни отчёта — только SQL руками.
      if (pathname === '/api/trials') {
        const r = await fetch(`${db.url}/rest/v1/trials?select=machine_id,started_at,status,business_type,app_version,last_seen_at,created_at&order=last_seen_at.desc`, { headers: db.headers })
        if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
        return json({ rows: await r.json() })
      }

      // --- Клиенты: лицензии/триалы, склеенные с дневными итогами ------------
      // Раньше панель показывала строки licenses и всё: ни выручки, ни среднего
      // чека, ни внятного «когда последний раз работал» (last_seen_at пишется
      // раз в сутки проверкой лицензии). Итоги приходят по тому же каналу
      // лицензии в usage_daily/usage_state — здесь они склеиваются с клиентом.
      //
      // Склейка в воркере, а не в SQL: таблицы в РАЗНЫХ ключах (лицензия — по
      // id, триал — по machine_id), клиентов десятки, дней сотни. Джойн на
      // такой объём в памяти дешевле, чем вьюха, которую потом надо помнить.
      if (pathname === '/api/clients') {
        const since = isoDay(-90)
        const [licR, trialR, dailyR, stateR] = await Promise.all([
          fetch(`${db.url}/rest/v1/licenses?select=id,customer,machine_id,expires_at,terminals,revoked,activated_at,last_seen_at,notes,created_at&order=created_at.desc`, { headers: db.headers }),
          fetch(`${db.url}/rest/v1/trials?select=machine_id,started_at,status,business_type,app_version,last_seen_at,created_at&order=last_seen_at.desc`, { headers: db.headers }),
          fetch(`${db.url}/rest/v1/usage_daily?select=subject,day,revenue,receipts&day=gte.${since}&order=day.asc&limit=20000`, { headers: db.headers }),
          fetch(`${db.url}/rest/v1/usage_state?select=subject,registers,locations,last_sale_at,updated_at&limit=5000`, { headers: db.headers }),
        ])
        for (const [name, r] of [['licenses', licR], ['trials', trialR], ['usage_daily', dailyR], ['usage_state', stateR]]) {
          // usage_* появились позже остальных: если SQL ещё не выполнен, таблицы
          // нет — это не повод отдать 502 и оставить владельца без панели вообще.
          if (!r.ok && (name === 'usage_daily' || name === 'usage_state')) continue
          if (!r.ok) return json({ error: `Supabase (${name}): ${r.status} ${await r.text()}` }, 502)
        }
        const daily = dailyR.ok ? await dailyR.json() : []
        const state = stateR.ok ? await stateR.json() : []
        const byDay = new Map(), byState = new Map()
        for (const d of daily) {
          if (!byDay.has(d.subject)) byDay.set(d.subject, [])
          byDay.get(d.subject).push({ day: d.day, revenue: Number(d.revenue) || 0, receipts: Number(d.receipts) || 0 })
        }
        for (const s of state) byState.set(s.subject, s)

        const decorate = (row, subject, kind) => {
          const days = byDay.get(subject) || []
          const st = byState.get(subject) || null
          return {
            ...row, subject, kind, days, telemetry: days.length > 0 || !!st,
            registers: st?.registers ?? null,
            locations: st?.locations ?? null,
            last_sale_at: st?.last_sale_at ?? null,
            ...window_(days),
          }
        }
        const licenses = (await licR.json()).map(r => decorate(r, r.id, 'license'))
        const trials = (await trialR.json()).map(r => decorate(r, r.machine_id, 'trial'))
        return json({ licenses, trials, kaspiPhone: (env.OWNER_KASPI_PHONE || '').trim() })
      }

      if (pathname === '/api/renew') {
        const { id, days } = await request.json()
        const n = Number(days)
        if (!id || !Number.isFinite(n) || n <= 0) return json({ error: 'Нужны id и положительное число дней' }, 400)

        const getRes = await fetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}&select=customer,expires_at`, { headers: db.headers })
        if (!getRes.ok) return json({ error: `Supabase: ${getRes.status}` }, 502)
        const rows = await getRes.json()
        if (!rows.length) return json({ error: 'Лицензия не найдена' }, 404)

        // Та же логика, что в license-renew.mjs: продлеваем от сегодня или от
        // текущего срока — что позже; заодно снимаем revoked (оплатил = вернули).
        const now = new Date()
        const cur = rows[0].expires_at ? new Date(rows[0].expires_at) : null
        const base = cur && cur > now ? cur : now
        const newExpires = new Date(base.getTime() + n * 86400000).toISOString()

        const patch = await fetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ expires_at: newExpires, revoked: false })
        })
        if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
        return json({ ok: true, customer: rows[0].customer, expires_at: newExpires })
      }

      if (pathname === '/api/issue') {
        // Новая лицензия под активацию по коду: строка в таблице, id = код
        // активации (его вводят на кассе; .lic подписывает функция activate).
        const { customer, days, terminals, notes } = await request.json()
        if (!customer || !String(customer).trim()) return json({ error: 'Укажите клиента' }, 400)
        const n = Number(days)
        const body = {
          customer: String(customer).trim(),
          expires_at: Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 86400000).toISOString() : null,
          terminals: Math.max(1, Number(terminals) || 1),
          notes: (notes || '').trim() || null
        }
        const ins = await fetch(`${db.url}/rest/v1/licenses`, {
          method: 'POST',
          headers: { ...db.headers, Prefer: 'return=representation' },
          body: JSON.stringify(body)
        })
        if (!ins.ok) return json({ error: `Supabase: ${ins.status} ${await ins.text()}` }, 502)
        const [row] = await ins.json()
        return json({ ok: true, id: row.id, expires_at: row.expires_at })
      }

      if (pathname === '/api/revoke') {
        const { id, revoked } = await request.json()
        if (!id || typeof revoked !== 'boolean') return json({ error: 'Нужны id и revoked (true/false)' }, 400)
        const patch = await fetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ revoked })
        })
        if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
        return json({ ok: true })
      }

      if (pathname === '/api/notes') {
        const { id, notes } = await request.json()
        if (!id) return json({ error: 'Нужен id' }, 400)
        const patch = await fetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ notes: (notes || '').trim() || null })
        })
        if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
        return json({ ok: true })
      }

      // --- Вкладка «Облако»: живы ли облачные функции ------------------------
      // Панель, как и вся админка, читает только таблицы. Функция при этом
      // может лежать — и снаружи это неотличимо от «клиентов нет». Однажды
      // уже вышло боком: `trial` не была выложена, таблица оставалась пустой,
      // и это читалось как «демо никто не ставит». Спрашиваем сами функции:
      // на GET они отдают только версию и готовность, без данных и ключей.
      if (pathname === '/api/cloud') {
        const mon = sb2(env)
        const fns = [
          { name: 'activate',           base: db.url,  what: 'выдаёт лицензию при активации по коду' },
          { name: 'status',             base: db.url,  what: 'проверка лицензии и автопродление срока' },
          { name: 'claim',              base: db.url,  what: 'касса забирает одобренную заявку' },
          { name: 'request-activation', base: db.url,  what: 'касса присылает заявку на активацию' },
          { name: 'trial',              base: db.url,  what: 'телеметрия пробных установок' },
          { name: 'parse-invoice',      base: mon.url, what: 'распознавание накладной по фото' },
        ]
        const probe = async (f) => {
          if (!f.base) return { name: f.name, what: f.what, ok: false, verdict: 'не задан адрес проекта' }
          try {
            const r = await fetch(`${f.base}/functions/v1/${f.name}`, { method: 'GET' })
            const text = await r.text()
            let d = {}
            try { d = JSON.parse(text) } catch { /* не JSON — значит код старый */ }
            if (r.status === 404) return { name: f.name, what: f.what, ok: false, verdict: 'не выложена' }
            // Версию умеет называть только код, выложенный после 03.08.2026.
            // Без этого различия «старая, но живая» выглядела бы как «нет вовсе».
            if (!d.version) return { name: f.name, what: f.what, ok: false, verdict: 'старая версия — выложите заново' }
            // Функция может отвечать и при этом не работать: нет таблицы или
            // не задан ключ подписи. Тихий отказ — самый дорогой.
            const bad = []
            if (d.table_activation_requests === 'no_table') bad.push('нет таблицы activation_requests')
            if (d.table_licenses === 'no_table') bad.push('нет таблицы licenses')
            if (d.signing_key === 'missing') bad.push('не задан LICENSE_PRIVATE_KEY')
            return { name: f.name, what: f.what, version: d.version, ok: bad.length === 0, verdict: bad.join(' · ') || 'работает' }
          } catch {
            return { name: f.name, what: f.what, ok: false, verdict: 'не отвечает' }
          }
        }
        return json({ rows: await Promise.all(fns.map(probe)) })
      }

      // --- Вкладка «Заявки»: активация без ввода кода ------------------------
      // Касса шлёт заявку (функция request-activation), владелец одобряет,
      // касса сама забирает лицензию (claim). Заявок не было видно нигде:
      // код компьютера приходилось выпрашивать у клиента — ровно то, ради
      // чего заявки и делались.
      if (pathname.startsWith('/api/requests/')) {
        if (pathname === '/api/requests/list') {
          const r = await fetch(`${db.url}/rest/v1/activation_requests?select=machine_id,shop,contact,business_type,app_version,status,license_id,created_at,updated_at,decided_at&order=created_at.desc&limit=200`, { headers: db.headers })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          return json({ rows: await r.json() })
        }

        // Одобрение = строка в licenses с этим machine_id: отдельного
        // «выключателя» нет, claim ищет именно лицензию. Статус заявки здесь
        // НЕ трогаем — его ставит claim, когда касса реально забрала лицензию.
        // Иначе «одобрено» появлялось бы сразу и скрывало случай «одобрили, а
        // касса так и не пришла».
        if (pathname === '/api/requests/approve') {
          const { machine_id, customer, days, terminals } = await request.json()
          const mid = String(machine_id || '').trim().toUpperCase()
          if (!mid) return json({ error: 'Нужен код компьютера' }, 400)
          if (!String(customer || '').trim()) return json({ error: 'Укажите клиента' }, 400)

          // Повторное одобрение завело бы вторую лицензию на ту же машину:
          // claim берёт самую свежую, а старая осталась бы висеть в списке.
          const dup = await fetch(`${db.url}/rest/v1/licenses?machine_id=eq.${encodeURIComponent(mid)}&select=id,revoked`, { headers: db.headers })
          if (!dup.ok) return json({ error: `Supabase: ${dup.status} ${await dup.text()}` }, 502)
          const live = (await dup.json()).filter(l => l.revoked !== true)
          if (live.length) return json({ error: `На этот компьютер уже выпущена лицензия ${live[0].id}` }, 409)

          const n = Number(days)
          const ins = await fetch(`${db.url}/rest/v1/licenses`, {
            method: 'POST',
            headers: { ...db.headers, Prefer: 'return=representation' },
            body: JSON.stringify({
              customer: String(customer).trim(),
              machine_id: mid,
              expires_at: Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 86400000).toISOString() : null,
              terminals: Math.max(1, Number(terminals) || 1),
              notes: 'Одобрено по заявке из панели'
            })
          })
          if (!ins.ok) return json({ error: `Supabase: ${ins.status} ${await ins.text()}` }, 502)
          const [row] = await ins.json()
          return json({ ok: true, id: row.id, expires_at: row.expires_at })
        }

        if (pathname === '/api/requests/reject') {
          const { machine_id } = await request.json()
          const mid = String(machine_id || '').trim().toUpperCase()
          if (!mid) return json({ error: 'Нужен код компьютера' }, 400)
          const patch = await fetch(`${db.url}/rest/v1/activation_requests?machine_id=eq.${encodeURIComponent(mid)}`, {
            method: 'PATCH',
            headers: { ...db.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'rejected', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }
      }

      // --- Вкладка «Штрихкоды»: общий словарь mon_barcodes (проект монитора) ---
      if (pathname.startsWith('/api/catalog/')) {
        const db2 = sb2(env)
        if (!db2.url || !env.MONITOR_SUPABASE_SERVICE_ROLE_KEY) {
          return json({ error: 'Не заданы секреты MONITOR_SUPABASE_URL / MONITOR_SUPABASE_SERVICE_ROLE_KEY' }, 500)
        }

        if (pathname === '/api/catalog/pending') {
          const r = await fetch(`${db2.url}/rest/v1/mon_barcodes?status=eq.pending&order=updated_at.desc&limit=200`, {
            headers: { ...db2.headers, Prefer: 'count=exact' }
          })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const total = Number((r.headers.get('content-range') || '').split('/')[1])
          return json({ rows: await r.json(), total: Number.isFinite(total) ? total : null })
        }

        if (pathname === '/api/catalog/list') {
          const { q, page } = await request.json()
          const term = String(q || '').trim()
          const per = 200
          const off = Math.max(0, Number(page) || 0) * per
          // order=barcode.asc — стабильная пагинация (updated_at «плавает»),
          // и одинаковые штрихкоды идут подряд, значит дубли схлопываются в пределах страницы.
          let qs = `status=eq.approved&order=barcode.asc&limit=${per}&offset=${off}`
          if (term) qs += `&or=(barcode.ilike.*${encodeURIComponent(term)}*,name.ilike.*${encodeURIComponent(term)}*)`
          const r = await fetch(`${db2.url}/rest/v1/mon_barcodes?${qs}`, { headers: { ...db2.headers, Prefer: 'count=exact' } })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const total = Number((r.headers.get('content-range') || '').split('/')[1])
          const all = await r.json()
          // Разные магазины могут завести один штрихкод под свою цену — в каталоге
          // дублей одного штрихкода не показываем, оставляем первую запись.
          const seen = new Set()
          const rows = all.filter(row => (seen.has(row.barcode) ? false : (seen.add(row.barcode), true)))
          return json({ rows, total: Number.isFinite(total) ? total : null })
        }

        if (pathname === '/api/catalog/approve') {
          const { venue_id, barcode } = await request.json()
          if (!venue_id || !barcode) return json({ error: 'Нужны venue_id и barcode' }, 400)
          const patch = await fetch(`${db2.url}/rest/v1/mon_barcodes?venue_id=eq.${encodeURIComponent(venue_id)}&barcode=eq.${encodeURIComponent(barcode)}`, {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'approved' })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }

        if (pathname === '/api/catalog/reject' || pathname === '/api/catalog/delete') {
          const { venue_id, barcode } = await request.json()
          if (!venue_id || !barcode) return json({ error: 'Нужны venue_id и barcode' }, 400)
          const del = await fetch(`${db2.url}/rest/v1/mon_barcodes?venue_id=eq.${encodeURIComponent(venue_id)}&barcode=eq.${encodeURIComponent(barcode)}`, {
            method: 'DELETE',
            headers: { ...db2.headers, Prefer: 'return=minimal' }
          })
          if (!del.ok) return json({ error: `Supabase: ${del.status} ${await del.text()}` }, 502)
          return json({ ok: true })
        }

        if (pathname === '/api/catalog/bulkCategory') {
          // Массовая смена категории у выбранных карточек. Матч по barcode —
          // применяется ко всем заведениям (как и категоризация SQL-скриптом).
          // updated_at НЕ трогаем — не провоцируем ресинк на кассах.
          const { barcodes, category } = await request.json()
          const list = Array.isArray(barcodes) ? [...new Set(barcodes.map(b => String(b).trim()).filter(Boolean))] : []
          if (!list.length) return json({ error: 'Не выбраны штрихкоды' }, 400)
          if (list.length > 500) return json({ error: 'За раз не больше 500 штрихкодов' }, 400)
          const cat = String(category || '').trim() || null
          const inList = list.map(b => encodeURIComponent('"' + b.replace(/"/g, '') + '"')).join(',')
          const patch = await fetch(`${db2.url}/rest/v1/mon_barcodes?barcode=in.(${inList})`, {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ category: cat })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true, count: list.length })
        }

        if (pathname === '/api/catalog/similar') {
          // Подсказка «похожие карточки» при модерации: SQL-функция
          // mon_match_product (sql/mon_matching.sql) — сперва выученный алиас,
          // иначе топ похожих названий по триграммам.
          const { q, limit } = await request.json()
          const term = String(q || '').trim()
          if (!term) return json({ error: 'Нужен текст для поиска' }, 400)
          const r = await fetch(`${db2.url}/rest/v1/rpc/mon_match_product`, {
            method: 'POST',
            headers: db2.headers,
            body: JSON.stringify({ q: term, max_results: Math.max(1, Math.min(10, Number(limit) || 5)) })
          })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          return json({ rows: await r.json() })
        }

        if (pathname === '/api/catalog/upsert') {
          const { venue_id, barcode, name, category, price, unit } = await request.json()
          if (!barcode || !String(barcode).trim()) return json({ error: 'Укажите штрихкод' }, 400)
          if (!name || !String(name).trim()) return json({ error: 'Укажите название' }, 400)
          const n = price === '' || price === null || price === undefined ? null : Number(price)
          if (n !== null && !Number.isFinite(n)) return json({ error: 'Некорректная цена' }, 400)
          const body = {
            venue_id: (venue_id && String(venue_id).trim()) || 'panel-owner',
            barcode: String(barcode).trim(),
            name: String(name).trim(),
            category: String(category || '').trim() || null,
            price: n,
            unit: String(unit || '').trim() || null,
            status: 'approved',
            updated_at: new Date().toISOString()
          }
          const r = await fetch(`${db2.url}/rest/v1/mon_barcodes?on_conflict=venue_id,barcode`, {
            method: 'POST',
            headers: { ...db2.headers, Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify(body)
          })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const [row] = await r.json()
          return json({ ok: true, row })
        }

        return json({ error: 'Неизвестный путь' }, 404)
      }

      // --- Вкладка «Приёмки»: разбор ИИ-распознаваний mon_ai_invoices (монитор) ---
      if (pathname.startsWith('/api/invoices/')) {
        const db2 = sb2(env)
        if (!db2.url || !env.MONITOR_SUPABASE_SERVICE_ROLE_KEY) {
          return json({ error: 'Не заданы секреты MONITOR_SUPABASE_URL / MONITOR_SUPABASE_SERVICE_ROLE_KEY' }, 500)
        }

        if (pathname === '/api/invoices/pending') {
          const r = await fetch(`${db2.url}/rest/v1/mon_ai_invoices?reviewed_at=is.null&order=created_at.desc&limit=100`, {
            headers: { ...db2.headers, Prefer: 'count=exact' }
          })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const total = Number((r.headers.get('content-range') || '').split('/')[1])
          return json({ rows: await r.json(), total: Number.isFinite(total) ? total : null })
        }

        if (pathname === '/api/invoices/review') {
          const { id } = await request.json()
          if (!id) return json({ error: 'Нужен id' }, 400)
          // «Разобрано»: ставим reviewed_at и стираем фото (image_b64=null);
          // распознанный JSON остаётся навсегда.
          const patch = await fetch(`${db2.url}/rest/v1/mon_ai_invoices?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ reviewed_at: new Date().toISOString(), image_b64: null })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }

        if (pathname === '/api/invoices/delete') {
          const { id } = await request.json()
          if (!id) return json({ error: 'Нужен id' }, 400)
          const del = await fetch(`${db2.url}/rest/v1/mon_ai_invoices?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { ...db2.headers, Prefer: 'return=minimal' }
          })
          if (!del.ok) return json({ error: `Supabase: ${del.status} ${await del.text()}` }, 502)
          return json({ ok: true })
        }

        return json({ error: 'Неизвестный путь' }, 404)
      }

      return json({ error: 'Неизвестный путь' }, 404)
    } catch (e) {
      return json({ error: String(e?.message ?? e) }, 500)
    }
  }
}

const PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>iMag — подписки</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#141210;--bg2:#191614;--panel:#201c19;--panel2:#272220;
    --b:#332d29;--b2:#443c37;
    --fg:#f7f4f0;--mut:#b6ada4;--mut2:#8a8078;
    --brand:oklch(0.76 0.16 62);--brand2:oklch(0.70 0.17 55);
    --ok:oklch(0.80 0.15 155);--warn:oklch(0.82 0.14 78);--bad:oklch(0.72 0.18 27);
    --accent-fg:#1a1410;
  }
  :root[data-theme="light"]{
    --bg:#f5f1ec;--bg2:#efe9e2;--panel:#ffffff;--panel2:#f6f2ec;
    --b:#e6ddd3;--b2:#d6cabb;
    --fg:#241f1a;--mut:#5e564d;--mut2:#8a8078;
    --brand:oklch(0.58 0.16 55);--brand2:oklch(0.52 0.17 50);
    --ok:oklch(0.52 0.14 155);--warn:oklch(0.58 0.13 70);--bad:oklch(0.55 0.19 27);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--bg)}
  body{font-family:"IBM Plex Sans",system-ui,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased;min-height:100vh}
  input,button,textarea{font-family:inherit}
  input[type=number]::-webkit-inner-spin-button{opacity:.4}
  button{cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}

  @keyframes toastIn{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  @keyframes ovIn{from{opacity:0}to{opacity:1}}
  @keyframes dlgIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
  @keyframes growB{from{transform:scaleY(0)}to{transform:scaleY(1)}}

  .loginwrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .loginbox{width:320px;max-width:100%;background:var(--panel);border:1px solid var(--b);border-radius:16px;padding:24px}
  .loginbox h1{font-family:"Space Grotesk";font-weight:700;font-size:20px;margin-bottom:4px;color:var(--fg)}
  .loginbox .sub{color:var(--mut2);font-size:12.5px;margin-bottom:16px}
  .loginbox input{width:100%;height:42px;padding:0 13px;background:var(--bg2);border:1px solid var(--b2);border-radius:10px;color:var(--fg);font-size:14px;outline:none;margin-bottom:12px}
  .loginbox input:focus{border-color:var(--brand)}
  .loginbox button{width:100%;height:42px;border-radius:10px;background:var(--brand);border:1px solid var(--brand);color:var(--accent-fg);font-size:14px;font-weight:700}

  .topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;padding:0 18px;height:60px;
    background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--b)}
  .logo{display:flex;align-items:center;gap:11px}
  .logo-sq{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;
    background:var(--brand);color:var(--accent-fg);font-family:"Space Grotesk";font-weight:700;font-size:19px;
    box-shadow:0 3px 14px oklch(0.76 0.16 62 / .35)}
  .logo-name{font-family:"Space Grotesk";font-weight:700;font-size:17px;letter-spacing:-.01em;color:var(--fg);line-height:1.2}
  .logo-sub{font-size:10.5px;color:var(--mut2);letter-spacing:.04em;text-transform:uppercase}
  .tabs-deco{display:flex;gap:2px;margin-left:8px}
  .tabs-deco button{padding:7px 13px;border-radius:8px;font-size:13px;font-weight:500;color:var(--mut2);background:transparent;border:none}
  .tabs-deco button.active{font-weight:600;color:var(--fg);background:var(--panel2)}
  .navbadge{margin-left:6px;font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;
    background:var(--warn);color:var(--accent-fg);font-variant-numeric:tabular-nums}
  .simrow{padding:8px 16px 10px 60px;border-bottom:1px solid var(--b);background:var(--bg2);
    font-size:12px;color:var(--mut2);line-height:2}
  .simhit{display:inline-block;margin-right:6px;padding:2px 9px;border-radius:999px;
    background:var(--panel2);border:1px solid var(--b2);color:var(--mut);font-size:11.5px}
  .simhit.same{color:var(--warn);border-color:var(--warn);font-weight:600}
  .topbar-right{margin-left:auto;display:flex;align-items:center;gap:9px}
  .icon-btn{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;
    background:var(--panel);border:1px solid var(--b2);color:var(--mut);font-size:15px}
  .btn{height:36px;padding:0 14px;border-radius:9px;background:var(--panel);border:1px solid var(--b2);
    color:var(--fg);font-size:13px;font-weight:600}
  .btn:hover{border-color:var(--brand)}
  .btn.pri{padding:0 16px;background:var(--brand);border:1px solid var(--brand);
    color:var(--accent-fg);font-weight:700;box-shadow:0 3px 14px oklch(0.76 0.16 62 / .3)}
  .btn.pri:hover{background:var(--brand2)}

  .wrap{max-width:1200px;margin:0 auto;padding:30px 28px 80px}
  .titlerow{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
  .titlerow h1{font-family:"Space Grotesk";font-weight:700;font-size:30px;letter-spacing:-.02em;color:var(--fg)}
  .titlerow .sub{color:var(--mut2);font-size:13.5px;margin-top:5px}
  .sync{font-family:"Space Grotesk";font-size:12.5px;color:var(--mut2);text-align:right;line-height:1.5}
  .sync .now{color:var(--ok);font-weight:600}

  .statgrid{display:grid;grid-template-columns:repeat(4,1fr) 1.5fr;gap:12px;margin-bottom:22px}
  .stat{text-align:left;background:var(--panel);border:1px solid var(--b);border-radius:14px;padding:14px 16px}
  .stat:hover{border-color:var(--b2)}
  .stat.active{border-color:var(--brand);box-shadow:0 0 0 3px oklch(0.76 0.16 62 / .12)}
  .stat .lbl{font-size:12px;font-weight:600;color:var(--mut);letter-spacing:.01em}
  .stat .val{font-family:"Space Grotesk";font-weight:700;font-size:32px;line-height:1;margin-top:12px;font-variant-numeric:tabular-nums}
  .stat .hint{font-size:11px;color:var(--mut2);margin-top:7px}
  .chartcard{background:var(--panel);border:1px solid var(--b);border-radius:14px;padding:14px 16px 12px;display:flex;flex-direction:column}
  .chartcard .chead{display:flex;align-items:baseline;justify-content:space-between}
  .chartcard .ctitle{font-size:12px;font-weight:600;color:var(--mut)}
  .chartcard .ctotal{font-family:"Space Grotesk";font-weight:700;font-size:16px;color:var(--fg)}
  .chartcard .cdelta{font-size:11px;color:var(--ok);font-weight:600;margin-left:6px}
  .chartbars{flex:1;display:flex;align-items:flex-end;gap:8px;margin-top:12px;min-height:52px}
  .chartbars .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px}
  .chartbars .colbar{width:100%;height:52px;display:flex;align-items:flex-end}
  .chartbars .bar{width:100%;min-height:6px;border-radius:5px 5px 2px 2px;transform-origin:bottom;
    animation:growB .5s cubic-bezier(.2,.8,.2,1) both;background:color-mix(in srgb,var(--brand) 42%,transparent)}
  .chartbars .bar.last{background:var(--brand)}
  .chartbars .m{font-size:9.5px;color:var(--mut2);font-family:"Space Grotesk"}

  .filterbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .segtabs{display:flex;gap:3px;background:var(--panel);border:1px solid var(--b);border-radius:11px;padding:4px}
  .segtabs button{display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:8px;border:none;
    font-size:13px;font-weight:600;background:transparent;color:var(--mut)}
  .segtabs button.active{background:var(--brand);color:var(--accent-fg)}
  .segtabs .badge{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--panel2);
    color:var(--mut2);font-variant-numeric:tabular-nums}
  .segtabs button.active .badge{background:rgba(0,0,0,.18);color:var(--accent-fg)}
  .searchwrap{position:relative;flex:1;min-width:200px}
  .searchwrap .ic{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--mut2);font-size:14px}
  .searchwrap input{width:100%;height:42px;padding:0 14px 0 34px;background:var(--panel);border:1px solid var(--b);
    border-radius:11px;color:var(--fg);font-size:14px;outline:none}
  .searchwrap input:focus{border-color:var(--brand)}
  .count{font-size:12.5px;color:var(--mut2);font-variant-numeric:tabular-nums;white-space:nowrap}

  #bulkbar,#catBulkbar{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:11px 16px;
    background:oklch(0.76 0.16 62 / .1);border:1px solid var(--brand);border-radius:12px;animation:rise .18s ease}
  #bulkbar .lbl,#catBulkbar .lbl{font-size:13px;font-weight:600;color:var(--fg)}
  #bulkbar .sp,#catBulkbar .sp{flex:1}
  #bulkbar button,#catBulkbar button{height:34px;padding:0 13px;border-radius:8px;font-size:12.5px;font-weight:700;border:1px solid var(--b2);background:var(--panel);color:var(--fg);cursor:pointer}
  #bulkbar button.pri,#catBulkbar button.pri{background:var(--brand);border-color:var(--brand);color:var(--accent-fg)}
  #bulkbar button.bad,#catBulkbar button.bad{color:var(--bad);font-weight:600}
  #bulkbar button.ok,#catBulkbar button.ok{color:var(--ok);font-weight:600}
  #bulkbar button.plain,#catBulkbar button.plain{background:transparent;color:var(--mut);font-weight:600}

  /* Плавающая панель массовых действий каталога — всегда видна при скролле. */
  @keyframes riseX{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
  #catListBulkbar{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;
    display:flex;align-items:center;gap:14px;padding:11px 15px 11px 18px;
    background:color-mix(in srgb,var(--panel) 90%,transparent);backdrop-filter:blur(16px);
    border:1px solid var(--brand);border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.4);animation:riseX .18s ease}
  #catListBulkbar .lbl{font-size:13px;font-weight:700;color:var(--fg);white-space:nowrap}
  #catListBulkbar .sp{width:2px}
  #catListBulkbar button{height:34px;padding:0 15px;border-radius:9px;font-size:12.5px;font-weight:700;
    border:1px solid var(--b2);background:var(--panel2);color:var(--fg);cursor:pointer}
  #catListBulkbar button.pri{background:var(--brand);border-color:var(--brand);color:var(--accent-fg)}
  #catListBulkbar button.plain{background:transparent;border-color:transparent;color:var(--mut)}

  .pager{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:16px}
  .pager button{height:34px;padding:0 16px;border-radius:9px;background:var(--panel);border:1px solid var(--b2);
    color:var(--fg);font-size:13px;font-weight:600;cursor:pointer}
  .pager button:disabled{opacity:.4;cursor:default}
  .pager .pinfo{font-size:12.5px;color:var(--mut2);font-variant-numeric:tabular-nums;white-space:nowrap}

  .tablewrap{background:var(--panel);border:1px solid var(--b);border-radius:15px;overflow:hidden}
  .catscroll{overflow-x:auto}
  .grid-row{display:grid;grid-template-columns:44px 1.9fr 1.4fr 1.1fr 60px 1fr 150px;align-items:center;padding:0 16px}
  .thead{height:44px;border-bottom:1px solid var(--b);background:var(--bg2)}
  .thead .h{color:var(--mut);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;background:none;border:none}
  .thead button.h{text-align:left}
  .thead .center{text-align:center}
  .thead .right{text-align:right}
  .trow{height:60px;border-bottom:1px solid var(--b);transition:background .12s}
  .trow.sel{background:oklch(0.76 0.16 62 / .07)}
  .trow input[type=checkbox],.rcard input[type=checkbox]{width:16px;height:16px;accent-color:var(--brand);cursor:pointer}
  .cust-cell{min-width:0}
  .cust-name{font-weight:600;font-size:14px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cust-id-row{display:flex;align-items:center;gap:6px;margin-top:3px;min-width:0}
  .cust-id{font-family:"IBM Plex Mono";font-size:10.5px;color:var(--mut2);cursor:pointer;min-width:0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cust-id:hover{color:var(--brand)}
  .note-ic{font-size:11px;color:var(--mut2);cursor:pointer;opacity:.5;flex-shrink:0}
  .note-ic:hover{opacity:1;color:var(--brand)}
  .note-ic.has{opacity:1;color:var(--warn)}
  .pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;padding:4px 10px;
    border-radius:999px;white-space:nowrap}
  .pill.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent);border:1px solid color-mix(in srgb,var(--ok) 40%,transparent)}
  .pill.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent);border:1px solid color-mix(in srgb,var(--warn) 40%,transparent)}
  .pill.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 14%,transparent);border:1px solid color-mix(in srgb,var(--bad) 40%,transparent)}
  .term{text-align:center;font-family:"Space Grotesk";font-weight:600;font-size:14px;color:var(--fg)}
  .exp{font-size:13px;color:var(--mut);font-variant-numeric:tabular-nums}
  .acts{display:flex;gap:6px;justify-content:flex-end}
  .acts button{height:30px;padding:0 11px;border-radius:7px;background:var(--panel2);border:1px solid var(--b2);
    color:var(--fg);font-size:12px;font-weight:600}
  .acts button:hover{border-color:var(--brand)}
  .acts button.revoke{color:var(--bad)}
  .acts button.unrevoke{color:var(--ok)}

  .card-view{display:none}
  .rcard{padding:13px 15px;border-bottom:1px solid var(--b)}
  .rcard.sel{background:oklch(0.76 0.16 62 / .07)}
  .rcard .top{display:flex;align-items:flex-start;gap:11px}
  .rcard .top input{margin-top:2px;flex-shrink:0}
  .rcard .name-wrap{min-width:0;flex:1}
  .rcard .name{font-weight:600;font-size:15px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rcard .idl{font-family:"IBM Plex Mono";font-size:10.5px;color:var(--mut2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .rcard .meta{display:flex;flex-wrap:wrap;gap:5px 16px;margin:11px 0 12px;padding-left:28px;font-size:12.5px;color:var(--mut2)}
  .rcard .meta b{color:var(--mut);font-weight:600}
  .rcard .actrow{display:flex;gap:8px;padding-left:28px}
  .rcard .actrow button{flex:1;height:38px;border-radius:9px;background:var(--panel2);border:1px solid var(--b2);
    color:var(--fg);font-size:13px;font-weight:600}
  .rcard .actrow button.revoke{color:var(--bad)}
  .rcard .actrow button.unrevoke{color:var(--ok)}

  .empty{padding:56px 0;text-align:center;color:var(--mut2);font-size:14px}

  #catDelBtn{color:var(--bad);margin-right:auto}
  #catPrice::-webkit-inner-spin-button{opacity:.4}

  dialog{width:440px;max-width:calc(100vw - 40px);background:var(--panel);border:1px solid var(--b2);
    border-radius:16px;padding:24px;color:var(--fg);box-shadow:0 8px 30px rgba(0,0,0,.35);animation:dlgIn .2s ease}
  dialog::backdrop{background:rgba(0,0,0,.72);animation:ovIn .15s ease}
  #dlg{width:420px}
  dialog h3{font-family:"Space Grotesk";font-weight:700;font-size:18px;color:var(--fg);margin-bottom:4px}
  dialog .dsub{font-size:12.5px;color:var(--mut2);margin-bottom:18px}
  dialog label{display:block;font-size:12px;font-weight:600;color:var(--mut);margin-bottom:6px}
  dialog input{width:100%;height:42px;padding:0 13px;background:var(--bg2);border:1px solid var(--b2);
    border-radius:10px;color:var(--fg);font-size:14px;outline:none;margin-bottom:14px}
  dialog input:focus{border-color:var(--brand)}
  dialog .drow2{display:flex;gap:12px;margin-bottom:16px}
  dialog .drow2 .fld{flex:1}
  dialog .drow2 .fld input{margin-bottom:0}
  dialog .hint{font-size:10.5px;color:var(--mut2);margin-top:5px}
  dialog .quickdays{display:flex;gap:8px;margin-bottom:16px}
  dialog .quickdays input{width:110px;margin-bottom:0}
  dialog .quickdays button{height:42px;padding:0 14px;border-radius:10px;background:var(--bg2);border:1px solid var(--b2);
    color:var(--mut);font-size:13px;font-weight:600}
  dialog .quickdays button:hover{border-color:var(--brand)}
  dialog .msgbox{width:100%;height:110px;background:var(--bg2);border:1px solid var(--b);border-radius:10px;padding:12px 13px;
    font-family:"IBM Plex Mono";font-size:11.5px;color:var(--mut);line-height:1.55;margin-bottom:14px;resize:none;outline:none}
  dialog .drow{display:flex;gap:10px;justify-content:flex-end}
  dialog .drow button{height:40px;padding:0 15px;border-radius:10px;font-size:13px;font-weight:600}
  dialog button.ghost{background:transparent;border:1px solid var(--b2);color:var(--mut)}
  dialog button.sec{background:var(--panel2);border:1px solid var(--b2);color:var(--fg)}
  dialog button.pri{background:var(--brand);border:1px solid var(--brand);color:var(--accent-fg);font-weight:700;padding:0 18px}

  .toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:60;padding:10px 18px;border-radius:11px;
    font-size:13px;font-weight:600;animation:toastIn .2s ease;box-shadow:0 8px 30px rgba(0,0,0,.35);
    background:var(--brand);color:var(--accent-fg);border:1px solid var(--brand)}
  .toast.err{background:color-mix(in srgb,var(--bad) 18%,var(--panel));color:var(--bad);border:1px solid var(--bad)}

  /* Гамбургер виден только на узком экране; на широком меню и так помещается */
  .mobile-only{display:none}
  .nav-backdrop{display:none}

  @media (max-width:760px){
    .wrap{padding:20px 14px 70px}
    .desktop-only{display:none}
    .mobile-only{display:flex}
    .statgrid{grid-template-columns:1fr 1fr;gap:10px}
    .chartcard{grid-column:1 / -1}
    .table-desktop{display:none}
    .card-view{display:block}

    /* Шесть вкладок в строку на телефон не влезают: раньше они уезжали за край
       и часть разделов была недоступна. Теперь — выездная панель сбоку, как в
       мобильных сайтах: помещается сколько угодно пунктов, и добавление
       седьмого ничего не сломает. */
    .topbar{gap:10px;padding:0 12px}
    .logo-sub{display:none}
    .tabs-deco{position:fixed;top:0;left:0;z-index:40;display:flex;flex-direction:column;gap:4px;
      width:264px;max-width:82vw;height:100dvh;margin:0;padding:14px 12px;overflow-y:auto;
      background:var(--bg2);border-right:1px solid var(--b);
      transform:translateX(-100%);transition:transform .22s ease;
      /* aria-hidden убирает пункты из-под пальца и из читалки, пока меню закрыто */
      visibility:hidden}
    .tabs-deco.open{transform:none;visibility:visible}
    .tabs-deco button{display:flex;align-items:center;justify-content:space-between;
      width:100%;padding:13px 14px;font-size:15px;border-radius:10px;text-align:left}
    .tabs-deco button.active{background:var(--brand);color:var(--accent-fg)}
    .nav-backdrop{position:fixed;inset:0;z-index:35;background:rgba(0,0,0,.45)}
    .nav-backdrop.open{display:block}
  }
</style>
</head>
<body>
<script>document.documentElement.setAttribute('data-theme', localStorage.getItem('panel_theme') || 'dark')</script>

<div id="login" class="loginwrap" style="display:none">
  <div class="loginbox">
    <h1>iMag — подписки</h1>
    <div class="sub">Введите пароль панели</div>
    <input id="pw" type="password" placeholder="Пароль панели" />
    <button onclick="savePw()">Войти</button>
  </div>
</div>

<div id="app" style="display:none">
  <header class="topbar">
    <div class="logo">
      <div class="logo-sq">i</div>
      <div>
        <div class="logo-name">iMag</div>
        <div class="logo-sub">Касса · подписки</div>
      </div>
    </div>
    <button id="menuBtn" class="icon-btn mobile-only" onclick="toggleMenu()" aria-label="Меню">☰</button>
    <div id="navBackdrop" class="nav-backdrop" onclick="toggleMenu(false)"></div>
    <nav id="nav" class="tabs-deco">
      <button id="navSubs" class="active" onclick="switchView('subs')">Подписки</button>
      <button id="navTrials" onclick="switchView('trials')">Триалы<span id="navTrialsBadge" class="navbadge" style="display:none"></span></button>
      <button id="navReq" onclick="switchView('req')">Заявки<span id="navReqBadge" class="navbadge" style="display:none"></span></button>
      <button id="navCat" onclick="switchView('cat')">Штрихкоды<span id="navCatBadge" class="navbadge" style="display:none"></span></button>
      <button id="navInv" onclick="switchView('inv')">Приёмки<span id="navInvBadge" class="navbadge" style="display:none"></span></button>
      <button id="navCloud" onclick="switchView('cloud')">Облако<span id="navCloudBadge" class="navbadge" style="display:none"></span></button>
    </nav>
    <div class="topbar-right">
      <button id="themeBtn" class="icon-btn" onclick="toggleTheme()" title="Сменить тему">☀</button>
      <button id="refreshBtn" class="btn desktop-only" onclick="load()">Обновить</button>
      <button class="btn pri" onclick="openIssue()">+ Выпустить</button>
    </div>
  </header>

  <main class="wrap">
  <div id="viewSubs">
    <div class="titlerow">
      <div>
        <h1>Подписки</h1>
        <div class="sub">Продление и отзыв применяются кассой при ближайшей проверке связи</div>
      </div>
      <div class="sync">
        <div>Синхронизировано</div>
        <div class="now">● сейчас</div>
      </div>
    </div>

    <div id="stats" class="statgrid"></div>

    <div class="filterbar">
      <div id="tabs" class="segtabs"></div>
      <div class="searchwrap">
        <span class="ic">⌕</span>
        <input id="q" type="search" oninput="render()" placeholder="Поиск по клиенту, ID активации или коду ПК…" />
      </div>
      <div class="count" id="count"></div>
    </div>

    <div id="bulkbar" style="display:none"></div>

    <div class="tablewrap">
      <div class="table-desktop">
        <div id="thead" class="grid-row thead"></div>
        <div id="tbody"></div>
      </div>
      <div class="card-view" id="cards"></div>
      <div id="empty" class="empty" style="display:none">Ничего не найдено</div>
    </div>
  </div>

  <div id="viewCat" style="display:none">
    <div class="titlerow">
      <div>
        <h1>Штрихкоды</h1>
        <div class="sub">Общий словарь товаров — кассы дополняют сами, здесь одобряете, правите и добавляете свои</div>
      </div>
    </div>

    <div class="titlerow" style="margin-bottom:14px">
      <div><h1 style="font-size:18px">На одобрении</h1></div>
      <div class="count" id="catPendCount"></div>
    </div>
    <div id="catBulkbar" style="display:none"></div>
    <div class="tablewrap catscroll" style="margin-bottom:28px">
      <div class="grid-row thead" style="grid-template-columns:44px 130px 200px 120px 80px 60px 230px">
        <div><input type="checkbox" id="catPendAll" onchange="toggleCatPendAll(this.checked)" /></div>
        <div class="h">Штрихкод</div>
        <div class="h">Название</div>
        <div class="h">Категория</div>
        <div class="h right">Цена</div>
        <div class="h center">Ед.</div>
        <div class="h right">Действия</div>
      </div>
      <div id="catPendBody"></div>
      <div id="catPendEmpty" class="empty" style="display:none">Нет заявок на одобрение</div>
    </div>

    <div class="filterbar">
      <div style="margin-right:auto"><h1 style="font-size:18px">Каталог</h1></div>
      <div class="searchwrap">
        <span class="ic">⌕</span>
        <input id="catq" type="search" oninput="catPage=0;loadCatList()" placeholder="Поиск по штрихкоду или названию…" />
      </div>
      <div class="count" id="catListCount"></div>
      <button class="btn pri" onclick="openCatEdit(null)">+ Штрихкод</button>
    </div>
    <div id="catListBulkbar" style="display:none"></div>
    <div class="tablewrap catscroll">
      <div class="grid-row thead" style="grid-template-columns:44px 130px 220px 130px 90px 70px 60px">
        <div><input type="checkbox" id="catListAll" onchange="toggleCatListAll(this.checked)" /></div>
        <div class="h">Штрихкод</div>
        <div class="h">Название</div>
        <div class="h">Категория</div>
        <div class="h right">Цена</div>
        <div class="h center">Ед.</div>
        <div class="h right"></div>
      </div>
      <div id="catBody"></div>
      <div id="catEmpty" class="empty" style="display:none">Ничего не найдено</div>
    </div>
    <div class="pager" id="catPager" style="display:none"></div>
  </div>

  <div id="viewInv" style="display:none">
    <div class="titlerow">
      <div>
        <h1>Приёмки (ИИ)</h1>
        <div class="sub">Распознанные накладные на разбор. Сверьте фото с результатом, «Разобрано» — фото удалится, данные останутся. «×N» у позиции — распознанная фасовка (блок).</div>
      </div>
      <div class="count" id="invCount"></div>
    </div>
    <div id="invEmpty" class="empty" style="display:none">Нет накладных на разбор</div>
    <div id="invList"></div>
  </div>

  <div id="viewReq" style="display:none">
    <div class="titlerow">
      <div>
        <h1>Заявки на активацию</h1>
        <div class="sub">Касса присылает заявку сама — код компьютера спрашивать у клиента не нужно. После одобрения касса заберёт лицензию при ближайшем выходе в интернет.</div>
      </div>
      <div class="count" id="reqCount"></div>
    </div>
    <div id="reqEmpty" class="empty" style="display:none">Заявок нет</div>
    <div id="reqList"></div>
  </div>

  <div id="viewTrials" style="display:none">
    <div class="titlerow">
      <div>
        <h1>Пробные установки</h1>
        <div class="sub">Кто поставил кассу и ещё не заплатил. Касса без лицензии сама сообщает состояние раз в сутки. Самые тёплые — «истёк, но кассу открывают»: продукт нужен, а денег пока не отдали.</div>
      </div>
      <div class="count" id="trialsCount"></div>
    </div>
    <div id="trialsEmpty" class="empty" style="display:none">Пробных установок нет</div>
    <div id="trialsList"></div>
  </div>

  <div id="viewCloud" style="display:none">
    <div class="titlerow">
      <div>
        <h1>Облако</h1>
        <div class="sub">Панель читает базу, а касса разговаривает с этими функциями. Если функция лежит, база просто остаётся пустой — со стороны это выглядит как «клиентов нет».</div>
      </div>
      <button class="btn" onclick="loadCloud()">Проверить снова</button>
    </div>
    <div id="cloudList"></div>
  </div>
  </main>
</div>

<dialog id="dlgIssue">
  <h3>Выпустить лицензию</h3>
  <div class="dsub">Создаётся код активации — клиент вводит его на кассе</div>
  <label>Клиент</label>
  <input id="isCust" placeholder="Название точки" />
  <div class="drow2">
    <div class="fld">
      <label>Срок, дней</label>
      <input id="isDays" type="number" min="0" value="30" />
      <div class="hint">0 = бессрочная</div>
    </div>
    <div class="fld">
      <label>Касс</label>
      <input id="isTerm" type="number" min="1" value="1" />
    </div>
  </div>
  <textarea id="isMsg" class="msgbox" readonly style="display:none"></textarea>
  <div class="drow">
    <button id="isCopyBtn" class="sec" onclick="copyIssue()" style="display:none">Скопировать текст</button>
    <button class="ghost" onclick="dlgIssue.close()">Закрыть</button>
    <button id="doIssueBtn" class="pri" onclick="doIssue()">Выпустить</button>
  </div>
</dialog>

<dialog id="dlgCat">
  <h3 id="dlgCatTitle">Штрихкод</h3>
  <label>Штрихкод</label>
  <input id="catBarcode" placeholder="4870000000000" />
  <label>Название</label>
  <input id="catName" placeholder="Название товара" />
  <div class="drow2">
    <div class="fld">
      <label>Категория</label>
      <input id="catCategory" list="catCatList" placeholder="выбрать или вписать новую" />
      <!-- Канонический список категорий (совпадает с sql/mon_matching-категоризацией).
           datalist = выпадающий список существующих + свободный ввод новой.
           ponytail: статичный список; если категории должны тянуться из БД живьём —
           добавить эндпоинт /api/catalog/categories (distinct) и заполнять отсюда. -->
      <datalist id="catCatList">
        <option value="Кондитерка и сладости"></option>
        <option value="Гигиена и косметика"></option>
        <option value="Хозтовары и посуда"></option>
        <option value="Молочка и яйца"></option>
        <option value="Канцтовары"></option>
        <option value="Одежда и бельё"></option>
        <option value="Игрушки"></option>
        <option value="Бакалея"></option>
        <option value="Снеки"></option>
        <option value="Мясо и колбасы"></option>
        <option value="Чай и кофе"></option>
        <option value="Бытовая химия"></option>
        <option value="Соусы и специи"></option>
        <option value="Алкоголь"></option>
        <option value="Вода и соки"></option>
        <option value="Напитки б/а"></option>
        <option value="Электроника и аксессуары"></option>
        <option value="Аксессуары"></option>
        <option value="Хлеб и выпечка"></option>
        <option value="Заморозка и мороженое"></option>
        <option value="Табак и вейпы"></option>
        <option value="Зоотовары"></option>
        <option value="Детское питание"></option>
        <option value="Рыба и морепродукты"></option>
        <option value="Пиво"></option>
        <option value="Консервы"></option>
      </datalist>
    </div>
    <div class="fld">
      <label>Ед.</label>
      <input id="catUnit" placeholder="шт / кг…" />
    </div>
  </div>
  <label>Цена</label>
  <input id="catPrice" type="number" min="0" step="0.01" placeholder="необязательно" />
  <div class="drow">
    <button id="catDelBtn" class="ghost" onclick="deleteCatRow()">Удалить</button>
    <button class="ghost" onclick="dlgCat.close()">Отмена</button>
    <button id="catSaveBtn" class="pri" onclick="saveCatRow()">Сохранить</button>
  </div>
</dialog>

<dialog id="dlgBulkCat">
  <h3>Категория для выбранных</h3>
  <div class="dsub" id="dlgBulkCatCount"></div>
  <label>Категория</label>
  <input id="bulkCatCategory" list="catCatList" placeholder="выбрать, вписать новую или оставить пустой = снять" />
  <div class="drow">
    <button class="ghost" onclick="dlgBulkCat.close()">Отмена</button>
    <button id="bulkCatSaveBtn" class="pri" onclick="applyBulkCat()">Применить</button>
  </div>
</dialog>

<dialog id="dlg">
  <h3>Продлить подписку</h3>
  <div class="dsub" id="dlgTitle"></div>
  <label>Дней</label>
  <div class="quickdays">
    <input id="dlgDays" type="number" min="1" value="30" />
    <button onclick="$('dlgDays').value=30">30 дн</button>
    <button onclick="$('dlgDays').value=90">90 дн</button>
    <button onclick="$('dlgDays').value=365">1 год</button>
  </div>
  <textarea id="dlgMsg" class="msgbox" readonly style="display:none"></textarea>
  <div class="drow">
    <button id="rnCopyBtn" class="sec" onclick="copyMsg()" style="display:none">Скопировать текст</button>
    <button class="ghost" onclick="dlg.close()">Закрыть</button>
    <button id="doRenewBtn" class="pri" onclick="doRenew()">Продлить</button>
  </div>
</dialog>

<script>
let rows = [], kaspiPhone = '', renewId = null, lastShownIds = []
let theme = localStorage.getItem('panel_theme') || 'dark'
let filter = 'all'
let sort = { col: null, dir: 'asc' }
let selected = new Set()

const $ = id => document.getElementById(id)
const pw = () => localStorage.getItem('panel_pw') || ''

function savePw(){ localStorage.setItem('panel_pw', $('pw').value); boot() }
function logout(){ localStorage.removeItem('panel_pw'); boot() }

function applyTheme(){
  document.documentElement.setAttribute('data-theme', theme)
  $('themeBtn').textContent = theme === 'dark' ? '☀' : '☾'
}
function toggleTheme(){
  theme = theme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('panel_theme', theme)
  applyTheme()
}

async function api(path, body){
  const r = await fetch('/api/' + path, { method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-panel-key': pw() },
    body: JSON.stringify(body || {}) })
  const d = await r.json().catch(() => ({}))
  if (r.status === 401){ logout(); throw new Error('Неверный пароль') }
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status))
  return d
}

function toast(msg, err){
  const t = document.createElement('div')
  t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg
  document.body.appendChild(t); setTimeout(() => t.remove(), 3200)
}

const fmtDate = s => s ? new Date(s).toLocaleDateString('ru-RU') : '—'
const daysLeft = s => s ? Math.ceil((new Date(s) - Date.now()) / 86400000) : null
const daysAgo  = s => s ? Math.floor((Date.now() - new Date(s)) / 86400000) : null
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const sortKey = r => r.revoked ? 1e9 : (daysLeft(r.expires_at) ?? 1e8)

function bucket(r){
  if (r.revoked) return 'revoked'
  const d = daysLeft(r.expires_at)
  if (d === null) return 'active'
  if (d <= 0) return 'expired'
  if (d <= 7) return 'soon'
  return 'active'
}
function statusInfo(r){
  if (r.revoked) return { kind:'bad', text:'отозвана' }
  const d = daysLeft(r.expires_at)
  if (d === null) return { kind:'ok', text:'бессрочная' }
  if (d <= 0) return { kind:'bad', text:'истекла' }
  if (d <= 7) return { kind:'warn', text:'через ' + d + ' дн' }
  return { kind:'ok', text:'до ' + fmtDate(r.expires_at) }
}
function seenInfo(r){
  if (!r.activated_at) return { text:'не активирована', color:'var(--mut2)' }
  const d = daysAgo(r.last_seen_at)
  if (d === null) return { text:'связи не было', color:'var(--mut2)' }
  if (d > 7) return { text: d + ' дн назад', color:'var(--warn)' }
  return { text: d === 0 ? 'сегодня' : d + ' дн назад', color:'var(--mut)' }
}

function setFilter(name){
  filter = (filter === name && name !== 'all') ? 'all' : name
  render()
}
function toggleSort(col){
  if (sort.col === col) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc'
  else { sort.col = col; sort.dir = 'asc' }
  render()
}
function toggleSelect(id, on){
  if (on) selected.add(id); else selected.delete(id)
  render()
}
function toggleSelectAll(on, ids){
  ids.forEach(id => on ? selected.add(id) : selected.delete(id))
  render()
}
function onSelectAllChange(cb){ toggleSelectAll(cb.checked, lastShownIds) }
function clearSelection(){ selected.clear(); render() }
function copyId(id){ navigator.clipboard.writeText(id); toast('ID скопирован') }
function copyText(t){ navigator.clipboard.writeText(t); toast('Скопировано') }
async function editNotes(id){
  const r = rows.find(x => x.id === id)
  const val = prompt('Заметка для ' + ((r && r.customer) || id) + ':', (r && r.notes) || '')
  if (val === null) return
  try { await api('notes', { id, notes: val }); toast('Заметка сохранена'); load() }
  catch(e){ toast(e.message, true) }
}

const MONTHS_RU = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек']
function chartData(){
  const now = new Date()
  const buckets = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    buckets.push({ y: d.getFullYear(), m: d.getMonth(), label: MONTHS_RU[d.getMonth()], count: 0 })
  }
  rows.forEach(r => {
    if (!r.created_at) return
    const d = new Date(r.created_at)
    const b = buckets.find(x => x.y === d.getFullYear() && x.m === d.getMonth())
    if (b) b.count++
  })
  const max = Math.max(1, ...buckets.map(b => b.count))
  return buckets.map((b, i) => ({ y:b.y, m:b.m, label:b.label, count:b.count,
    pct: Math.max(4, Math.round(b.count / max * 100)), last: i === buckets.length - 1 }))
}

function render(){
  const q = $('q').value.trim().toLowerCase()
  const counts = {
    all: rows.length,
    soon: rows.filter(r => bucket(r) === 'soon').length,
    expired: rows.filter(r => bucket(r) === 'expired').length,
    revoked: rows.filter(r => r.revoked).length
  }

  const cd = chartData()
  const total = cd.reduce((a,b) => a + b.count, 0)
  const prevB = cd[cd.length - 2], lastB = cd[cd.length - 1]
  const delta = prevB && prevB.count > 0 ? Math.round((lastB.count - prevB.count) / prevB.count * 100) : null

  const statDefs = [
    { key:'all', label:'Всего', value:counts.all, color:'var(--fg)', hint:'все лицензии' },
    { key:'soon', label:'Истекает ≤7 дн', value:counts.soon, color:'var(--warn)', hint:'нужно продлить' },
    { key:'expired', label:'Истекло', value:counts.expired, color:'var(--bad)', hint:'просрочены' },
    { key:'revoked', label:'Отозвано', value:counts.revoked, color:'var(--mut)', hint:'заблокированы' }
  ]
  $('stats').innerHTML = statDefs.map(s =>
    '<button class="stat' + (filter === s.key ? ' active' : '') + '" data-filter="' + s.key + '" onclick="setFilter(this.dataset.filter)">' +
      '<div class="lbl">' + s.label + '</div>' +
      '<div class="val" style="color:' + s.color + '">' + s.value + '</div>' +
      '<div class="hint">' + s.hint + '</div>' +
    '</button>'
  ).join('') +
  '<div class="chartcard">' +
    '<div class="chead"><div class="ctitle">Выпущено, 6 мес</div>' +
    '<div class="ctotal">' + total + (delta !== null ? '<span class="cdelta">' + (delta >= 0 ? '↑ ' : '↓ ') + Math.abs(delta) + '%</span>' : '') + '</div></div>' +
    '<div class="chartbars">' + cd.map((b, i) =>
      '<div class="col"><div class="colbar"><div class="bar' + (b.last ? ' last' : '') + '" style="height:' + b.pct + '%;animation-delay:' + (i * 0.05) + 's"></div></div><div class="m">' + b.label + '</div></div>'
    ).join('') + '</div>' +
  '</div>'

  const tabDefs = [ {key:'all',label:'Все'}, {key:'soon',label:'Истекают'}, {key:'expired',label:'Истекли'}, {key:'revoked',label:'Отозваны'} ]
  $('tabs').innerHTML = tabDefs.map(t =>
    '<button class="' + (filter === t.key ? 'active' : '') + '" data-filter="' + t.key + '" onclick="setFilter(this.dataset.filter)">' + t.label +
      '<span class="badge">' + counts[t.key] + '</span></button>'
  ).join('')

  let shown = rows.filter(r => filter === 'all' || bucket(r) === filter)
  shown = shown.filter(r => !q || (r.customer || '').toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || (r.machine_id || '').toLowerCase().includes(q))
  if (sort.col === 'customer') {
    const m = sort.dir === 'asc' ? 1 : -1
    shown = [...shown].sort((a,b) => m * (a.customer||'').localeCompare(b.customer||'', 'ru'))
  } else if (sort.col === 'expires') {
    const m = sort.dir === 'asc' ? 1 : -1
    shown = [...shown].sort((a,b) => m * ((a.expires_at ? +new Date(a.expires_at) : Infinity) - (b.expires_at ? +new Date(b.expires_at) : Infinity)))
  } else {
    shown = [...shown].sort((a,b) => sortKey(a) - sortKey(b))
  }

  $('count').textContent = shown.length + ' из ' + rows.length

  ;[...selected].forEach(id => { if (!rows.some(r => r.id === id)) selected.delete(id) })

  lastShownIds = shown.map(r => r.id)
  const allSel = lastShownIds.length > 0 && lastShownIds.every(id => selected.has(id))
  const custArrow = sort.col === 'customer' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''
  const expArrow = sort.col === 'expires' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''
  $('thead').innerHTML =
    '<div><input type="checkbox" ' + (allSel ? 'checked' : '') + ' onchange="onSelectAllChange(this)" /></div>' +
    '<button class="h" data-col="customer" onclick="toggleSort(this.dataset.col)">Клиент' + custArrow + '</button>' +
    '<div class="h">Статус</div>' +
    '<div class="h">На связи</div>' +
    '<div class="h center">Касс</div>' +
    '<button class="h" data-col="expires" onclick="toggleSort(this.dataset.col)">До' + expArrow + '</button>' +
    '<div class="h right">Действия</div>'

  if (!shown.length) {
    $('tbody').innerHTML = ''
    $('cards').innerHTML = ''
    $('empty').style.display = 'block'
  } else {
    $('empty').style.display = 'none'
    $('tbody').innerHTML = shown.map(r => rowHtml(r)).join('')
    $('cards').innerHTML = shown.map(r => cardHtml(r)).join('')
  }

  if (selected.size > 0) {
    const selRows = [...selected].map(id => rows.find(r => r.id === id)).filter(Boolean)
    const allRevoked = selRows.length > 0 && selRows.every(r => r.revoked)
    $('bulkbar').style.display = 'flex'
    $('bulkbar').innerHTML =
      '<span class="lbl">Выбрано: ' + selected.size + '</span><div class="sp"></div>' +
      '<button class="pri" onclick="bulkRenew()">Продлить на 30 дн</button>' +
      (allRevoked
        ? '<button class="ok" onclick="bulkSetRevoked(false)">Вернуть</button>'
        : '<button class="bad" onclick="bulkSetRevoked(true)">Отозвать</button>') +
      '<button class="plain" onclick="clearSelection()">Снять</button>'
  } else {
    $('bulkbar').style.display = 'none'
    $('bulkbar').innerHTML = ''
  }
}

function rowHtml(r){
  const st = statusInfo(r), sn = seenInfo(r)
  const sel = selected.has(r.id)
  const expText = r.expires_at ? fmtDate(r.expires_at) : (r.revoked ? '—' : 'бессрочно')
  const noteTitle = r.notes ? esc(r.notes) : 'Добавить заметку'
  return '<div class="grid-row trow' + (sel ? ' sel' : '') + '">' +
    '<div><input type="checkbox" data-id="' + r.id + '" ' + (sel ? 'checked' : '') + ' onchange="toggleSelect(this.dataset.id, this.checked)" /></div>' +
    '<div class="cust-cell"><div class="cust-name">' + esc(r.customer || '(без имени)') + '</div>' +
      '<div class="cust-id-row">' +
        '<span class="cust-id" data-id="' + r.id + '" title="ID активации — скопировать" onclick="copyId(this.dataset.id)">' + r.id + '</span>' +
        '<span class="note-ic' + (r.notes ? ' has' : '') + '" data-id="' + r.id + '" title="' + noteTitle + '" onclick="editNotes(this.dataset.id)">✎</span>' +
      '</div>' +
      (r.machine_id
        ? '<div class="cust-id-row"><span class="cust-id" data-m="' + esc(r.machine_id) + '" title="Код компьютера — скопировать" onclick="copyText(this.dataset.m)">🖥 ' + esc(r.machine_id) + '</span></div>'
        : '<div class="cust-id-row"><span class="cust-id" style="opacity:.5">🖥 ещё не активирована</span></div>') +
    '</div>' +
    '<div><span class="pill ' + st.kind + '">' + st.text + '</span></div>' +
    '<div style="color:' + sn.color + ';font-size:12.5px">' + sn.text + '</div>' +
    '<div class="term">' + (r.terminals ?? 1) + '</div>' +
    '<div class="exp">' + expText + '</div>' +
    '<div class="acts">' +
      '<button data-id="' + r.id + '" onclick="openRenew(this.dataset.id)">Продлить</button>' +
      (r.revoked
        ? '<button class="unrevoke" data-id="' + r.id + '" onclick="revoke(this.dataset.id, false)">Вернуть</button>'
        : '<button class="revoke" data-id="' + r.id + '" onclick="revoke(this.dataset.id, true)">Отозвать</button>') +
    '</div>' +
  '</div>'
}
function cardHtml(r){
  const st = statusInfo(r), sn = seenInfo(r)
  const sel = selected.has(r.id)
  const expText = r.expires_at ? fmtDate(r.expires_at) : (r.revoked ? '—' : 'бессрочно')
  const noteTitle = r.notes ? esc(r.notes) : 'Добавить заметку'
  return '<div class="rcard' + (sel ? ' sel' : '') + '">' +
    '<div class="top"><input type="checkbox" data-id="' + r.id + '" ' + (sel ? 'checked' : '') + ' onchange="toggleSelect(this.dataset.id, this.checked)" />' +
      '<div class="name-wrap"><div class="name">' + esc(r.customer || '(без имени)') + '</div>' +
      '<div class="cust-id-row"><span class="idl">' + r.id + '</span>' +
        '<span class="note-ic' + (r.notes ? ' has' : '') + '" data-id="' + r.id + '" title="' + noteTitle + '" onclick="editNotes(this.dataset.id)">✎</span>' +
      '</div>' +
      (r.machine_id
        ? '<div class="cust-id-row"><span class="idl" data-m="' + esc(r.machine_id) + '" title="Код компьютера — скопировать" onclick="copyText(this.dataset.m)">🖥 ' + esc(r.machine_id) + '</span></div>'
        : '<div class="cust-id-row"><span class="idl" style="opacity:.5">🖥 ещё не активирована</span></div>') +
      '</div>' +
      '<span class="pill ' + st.kind + '">' + st.text + '</span></div>' +
    '<div class="meta">' +
      '<span>Касс: <b>' + (r.terminals ?? 1) + '</b></span>' +
      '<span>До: <b>' + expText + '</b></span>' +
      '<span style="color:' + sn.color + '">На связи: ' + sn.text + '</span>' +
    '</div>' +
    '<div class="actrow">' +
      '<button data-id="' + r.id + '" onclick="openRenew(this.dataset.id)">Продлить</button>' +
      (r.revoked
        ? '<button class="unrevoke" data-id="' + r.id + '" onclick="revoke(this.dataset.id, false)">Вернуть</button>'
        : '<button class="revoke" data-id="' + r.id + '" onclick="revoke(this.dataset.id, true)">Отозвать</button>') +
    '</div>' +
  '</div>'
}

async function load(){
  const btn = $('refreshBtn')
  btn.disabled = true; btn.textContent = 'Обновление…'
  try { const d = await api('list'); rows = d.rows; kaspiPhone = d.kaspiPhone; render() }
  catch(e){ toast(e.message, true) }
  finally { btn.disabled = false; btn.textContent = 'Обновить' }
}

const dlgIssue = $('dlgIssue')
function openIssue(){
  $('isCust').value = ''; $('isDays').value = 30; $('isTerm').value = 1
  $('isMsg').value = ''; $('isMsg').style.display = 'none'
  $('isCopyBtn').style.display = 'none'
  $('doIssueBtn').disabled = false
  dlgIssue.showModal(); $('isCust').focus()
}
async function doIssue(){
  $('doIssueBtn').disabled = true
  try {
    const d = await api('issue', { customer: $('isCust').value, days: Number($('isDays').value), terminals: Number($('isTerm').value) })
    toast('Выпущена: ' + d.id)
    $('isMsg').value = 'Код активации iMag Касса: ' + d.id + '\\n' +
      (d.expires_at ? 'Действует до: ' + fmtDate(d.expires_at) + '\\n' : 'Бессрочная\\n') +
      'Введите код на экране активации приложения — касса привяжется к этому компьютеру автоматически.'
    $('isMsg').style.display = 'block'
    $('isCopyBtn').style.display = ''
    load()
  } catch(e){ toast(e.message, true); $('doIssueBtn').disabled = false }
}
function copyIssue(){ navigator.clipboard.writeText($('isMsg').value); toast('Скопировано') }

const dlg = $('dlg')
function openRenew(id){
  renewId = id
  const r = rows.find(x => x.id === id)
  $('dlgTitle').textContent = 'Продлить: ' + ((r && r.customer) || id)
  $('dlgDays').value = 30
  $('dlgMsg').value = ''; $('dlgMsg').style.display = 'none'
  $('rnCopyBtn').style.display = 'none'
  $('doRenewBtn').disabled = false
  dlg.showModal()
}
async function doRenew(){
  const days = Number($('dlgDays').value)
  $('doRenewBtn').disabled = true
  try {
    const d = await api('renew', { id: renewId, days })
    toast('Продлено до ' + fmtDate(d.expires_at))
    $('dlgMsg').value = 'Здравствуйте! iMag Касса (' + d.customer + ') продлена на ' + days +
      ' дн, до ' + fmtDate(d.expires_at) + '.' + (kaspiPhone ? ' Оплата: Kaspi ' + kaspiPhone + '.' : '') +
      ' Касса подхватит продление сама при ближайшей проверке связи.'
    $('dlgMsg').style.display = 'block'
    $('rnCopyBtn').style.display = ''
    load()
  } catch(e){ toast(e.message, true); $('doRenewBtn').disabled = false }
}
function copyMsg(){ navigator.clipboard.writeText($('dlgMsg').value); toast('Скопировано') }

async function revoke(id, flag){
  const r = rows.find(x => x.id === id)
  if (flag && !confirm('Отозвать лицензию «' + ((r && r.customer) || id) + '»? Касса клиента заблокируется при ближайшей проверке связи.')) return
  try { await api('revoke', { id, revoked: flag }); toast(flag ? 'Отозвана' : 'Возвращена'); load() }
  catch(e){ toast(e.message, true) }
}

async function bulkRenew(){
  const ids = [...selected]; if (!ids.length) return
  const res = await Promise.allSettled(ids.map(id => api('renew', { id, days: 30 })))
  const ok = res.filter(r => r.status === 'fulfilled').length
  toast(ok === ids.length ? ('Продлено: ' + ok) : ('Продлено: ' + ok + ', ошибок: ' + (ids.length - ok)), ok < ids.length)
  clearSelection(); load()
}
async function bulkSetRevoked(flag){
  const ids = [...selected]; if (!ids.length) return
  if (flag && !confirm('Отозвать ' + ids.length + ' лицензий?')) return
  const res = await Promise.allSettled(ids.map(id => api('revoke', { id, revoked: flag })))
  const ok = res.filter(r => r.status === 'fulfilled').length
  const verb = flag ? 'Отозвано' : 'Возвращено'
  toast(ok === ids.length ? (verb + ': ' + ok) : (verb + ': ' + ok + ', ошибок: ' + (ids.length - ok)), ok < ids.length)
  clearSelection(); load()
}

// --- Вкладка «Штрихкоды»: общий словарь mon_barcodes (проект монитора) ---
let view = 'subs'
let catPending = [], catPendTotal = null, catRows = [], catListTotal = null, catPage = 0, catSelected = new Set(), catListSel = new Set(), catEditKey = null

// Выездное меню на телефоне. На широком экране класс open ни на что не влияет:
// там .tabs-deco — обычная строка вкладок, drawer-стили живут в @media.
function toggleMenu(force){
  const nav = $('nav'), bd = $('navBackdrop')
  const open = force === undefined ? !nav.classList.contains('open') : !!force
  nav.classList.toggle('open', open)
  bd.classList.toggle('open', open)
}

const VIEWS = ['subs','trials','req','cat','inv','cloud']
const NAV_ID = { subs:'navSubs', trials:'navTrials', req:'navReq', cat:'navCat', inv:'navInv', cloud:'navCloud' }
const VIEW_ID = { subs:'viewSubs', trials:'viewTrials', req:'viewReq', cat:'viewCat', inv:'viewInv', cloud:'viewCloud' }

async function switchView(v){
  view = v
  for (const k of VIEWS){
    $(VIEW_ID[k]).style.display = k === v ? '' : 'none'
    $(NAV_ID[k]).className = k === v ? 'active' : ''
  }
  toggleMenu(false)   // выбрал раздел — панель уезжает, как и ждут от мобильного меню
  if (v === 'trials') await loadTrials()
  if (v === 'cat') await Promise.all([loadCatPending(), loadCatList()])
  if (v === 'inv') await loadInv()
  if (v === 'req') await loadReq()
  if (v === 'cloud') await loadCloud()
}

// ── Вкладка «Триалы»: воронка до оплаты ──
// Разбор по состояниям, а не просто список: горящие и «истёк, но открывают» —
// это разные разговоры с клиентом, и глазами по датам их не разделишь.
const TRIAL_DAYS = 14   // как в кассе (license.service TRIAL_DAYS)
const BIZ = { shop:'магазин', cafe:'кафе', sauna:'сауна' }

function trialState(r, now){
  const DAY = 86400000
  const seenAgo = Math.floor((now - new Date(r.last_seen_at).getTime()) / DAY)
  const startedAgo = r.started_at ? Math.floor((now - new Date(r.started_at).getTime()) / DAY) : null
  const left = startedAgo == null ? null : TRIAL_DAYS - startedAgo
  if (r.status === 'licensed') return { key:'licensed' }
  if (r.status === 'expired' && seenAgo <= 3) return { key:'lapsed', label:'истёк, но кассу открывают', tone:'hot', seenAgo, left }
  if (left != null && left <= 3 && left > 0) return { key:'hot', label: left === 1 ? 'заканчивается завтра' : 'осталось ' + left + ' дн', tone:'warn', seenAgo, left }
  if (r.status === 'expired') return { key:'dead', label:'истёк, кассу не открывают', tone:'mut', seenAgo, left }
  if (seenAgo >= 3) return { key:'quiet', label:'молчит ' + seenAgo + ' дн', tone:'mut', seenAgo, left }
  return { key:'live', label: left == null ? 'идёт' : 'осталось ' + left + ' дн', tone:'ok', seenAgo, left }
}

let trialRows = []
async function loadTrials(){
  try {
    const d = await api('trials')
    trialRows = (d.rows || []).filter(r => r.status !== 'licensed')
    const now = Date.now()
    const states = trialRows.map(r => ({ r, s: trialState(r, now) }))
    // Бейджем — только те, с кем есть что делать прямо сейчас. Тихие и мёртвые
    // в счётчик не идут: он должен звать к действию, а не показывать объём базы.
    const actionable = states.filter(x => x.s.key === 'lapsed' || x.s.key === 'hot').length
    $('trialsCount').textContent = trialRows.length
      ? (actionable ? 'требуют внимания: ' + actionable : 'всего ' + trialRows.length)
      : ''
    $('navTrialsBadge').style.display = actionable > 0 ? '' : 'none'
    $('navTrialsBadge').textContent = actionable
    const ORDER = { lapsed:0, hot:1, live:2, quiet:3, dead:4 }
    states.sort((a,b) => (ORDER[a.s.key] - ORDER[b.s.key]) || (a.s.seenAgo - b.s.seenAgo))
    renderTrials(states)
  } catch(e){ toast(e.message, true) }
}

function renderTrials(states){
  if (!states.length){ $('trialsList').innerHTML = ''; $('trialsEmpty').style.display = 'block'; return }
  $('trialsEmpty').style.display = 'none'
  const COLOR = { hot:'var(--warn)', warn:'var(--warn)', ok:'var(--mut)', mut:'var(--mut2)' }
  $('trialsList').innerHTML = states.map(({ r, s }) =>
    '<div class="tablewrap" style="padding:14px;margin-bottom:10px">' +
      '<div style="font-weight:600;color:' + COLOR[s.tone] + '">' + esc(s.label) + '</div>' +
      // Код компьютера целиком читать незачем — хвоста хватает, чтобы отличать
      // установки друг от друга; полный код нужен только при одобрении заявки.
      '<div class="exp">…' + esc(String(r.machine_id || '').slice(-6)) + ' · ' +
        esc(BIZ[r.business_type] || r.business_type || 'тип не указан') +
        (r.app_version ? ' · версия ' + esc(r.app_version) : '') + '</div>' +
      '<div class="exp">начало ' + (r.started_at ? fmtDate(r.started_at) : '—') +
        ' · последний раз ' + fmtDate(r.last_seen_at) + '</div>' +
    '</div>').join('')
}

// ── Вкладка «Заявки на активацию» ──
let reqRows = []
async function loadReq(){
  try {
    const d = await api('requests/list')
    reqRows = d.rows || []
    // Ждут решения = заявка есть, а лицензии по ней ещё нет. Именно это
    // число выносим бейджем: остальные строки — история.
    const pending = reqRows.filter(r => r.status !== 'rejected' && !r.license_id).length
    $('reqCount').textContent = pending ? 'ждут решения: ' + pending : 'всего ' + reqRows.length
    $('navReqBadge').style.display = pending > 0 ? '' : 'none'
    $('navReqBadge').textContent = pending
    renderReq()
  } catch(e){ toast(e.message, true) }
}
function renderReq(){
  if (!reqRows.length){ $('reqList').innerHTML = ''; $('reqEmpty').style.display = 'block'; return }
  $('reqEmpty').style.display = 'none'
  $('reqList').innerHTML = reqRows.map(r => {
    const decided = r.status === 'rejected' ? 'отклонена'
      : r.license_id ? 'одобрена, лицензия ' + esc(r.license_id)
      : 'ждёт решения'
    // Значения — через data-*, как в остальных таблицах панели: название
    // точки с апострофом («Кафе У Ани'с») внутри onclick оборвало бы строку.
    const actions = (r.status !== 'rejected' && !r.license_id)
      ? '<button class="btn pri" data-mid="' + esc(r.machine_id) + '" data-shop="' + esc(r.shop || '') +
          '" onclick="approveReq(this.dataset.mid, this.dataset.shop)">Одобрить</button> ' +
        '<button class="btn" data-mid="' + esc(r.machine_id) +
          '" onclick="rejectReq(this.dataset.mid)">Отклонить</button>'
      : ''
    return '<div class="tablewrap" style="padding:14px;margin-bottom:10px">' +
      '<div style="font-weight:600">' + esc(r.shop || 'Без названия') + '</div>' +
      '<div class="exp">Код ПК: ' + esc(r.machine_id) + '</div>' +
      '<div class="exp">' + esc(r.contact || 'контакт не указан') + ' · ' + esc(r.business_type || '—') +
        ' · версия ' + esc(r.app_version || '—') + ' · ' + fmtDate(r.created_at) + '</div>' +
      '<div class="exp" style="margin-bottom:8px">' + decided + '</div>' +
      actions +
    '</div>'
  }).join('')
}
async function approveReq(machineId, shop){
  const customer = prompt('Клиент (как назвать в списке лицензий):', shop || '')
  if (customer === null) return
  const days = prompt('Срок, дней (0 = бессрочная):', '30')
  if (days === null) return
  try {
    const d = await api('requests/approve', { machine_id: machineId, customer, days: Number(days), terminals: 1 })
    toast('Одобрено: ' + d.id)
    await Promise.all([loadReq(), load()])
  } catch(e){ toast(e.message, true) }
}
async function rejectReq(machineId){
  if (!confirm('Отклонить заявку с этого компьютера?')) return
  try { await api('requests/reject', { machine_id: machineId }); toast('Отклонена'); loadReq() }
  catch(e){ toast(e.message, true) }
}

// ── Вкладка «Облако»: живы ли функции, с которыми говорит касса ──
async function loadCloud(){
  try {
    const d = await api('cloud')
    const rows = d.rows || []
    const bad = rows.filter(r => !r.ok).length
    $('navCloudBadge').style.display = bad > 0 ? '' : 'none'
    $('navCloudBadge').textContent = bad
    $('cloudList').innerHTML = rows.map(r =>
      '<div class="tablewrap" style="padding:14px;margin-bottom:10px">' +
        '<div style="font-weight:600">' + (r.ok ? '✅ ' : '❌ ') + esc(r.name) + '</div>' +
        '<div class="exp">' + esc(r.what) + '</div>' +
        '<div class="exp">' + esc(r.verdict) + (r.version ? ' · версия ' + esc(r.version) : '') + '</div>' +
      '</div>').join('')
  } catch(e){ toast(e.message, true) }
}

// ── Вкладка «Приёмки»: разбор ИИ-распознаваний накладных ──
let invRows = []
async function loadInv(){
  try {
    const d = await api('invoices/pending')
    invRows = d.rows || []
    const n = d.total ?? invRows.length
    $('invCount').textContent = invRows.length + (d.total != null ? ' из ' + d.total : '')
    $('navInvBadge').style.display = n > 0 ? '' : 'none'
    $('navInvBadge').textContent = n
    renderInv()
  } catch(e){ toast(e.message, true) }
}
function renderInv(){
  if (!invRows.length){ $('invList').innerHTML = ''; $('invEmpty').style.display = 'block'; return }
  $('invEmpty').style.display = 'none'
  $('invList').innerHTML = invRows.map(r => {
    const photo = r.image_b64
      ? '<img src="data:' + esc(r.image_mime || 'image/jpeg') + ';base64,' + r.image_b64 + '" style="max-width:260px;max-height:360px;border-radius:8px;object-fit:contain" />'
      : '<div style="color:var(--muted,#888);font-size:13px">фото удалено</div>'
    const items = (r.items || []).map(it =>
      '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,.15);font-size:13px">' +
        '<span>' + esc(it.name || '') + (it.pack_size && it.pack_size > 1 ? ' <b style="color:var(--pri,#6a5acd)">×' + it.pack_size + '</b>' : '') + '</span>' +
        '<span style="white-space:nowrap;opacity:.8">' + esc(String(it.quantity ?? it.qty ?? '')) + (it.unit ? ' ' + esc(it.unit) : '') + (it.price != null ? ' · ' + it.price : '') + '</span>' +
      '</div>').join('')
    const dt = r.created_at ? new Date(r.created_at).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : ''
    return '<div style="border:1px solid rgba(128,128,128,.25);border-radius:12px;padding:14px;margin-bottom:14px">' +
      '<div style="margin-bottom:10px"><b>' + esc(r.supplier || 'Без поставщика') + '</b> · ' + (r.item_count || 0) + ' поз. · ' + esc(dt) + (r.model ? ' · <span style="opacity:.6">' + esc(r.model) + '</span>' : '') + '</div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap"><div>' + photo + '</div><div style="flex:1;min-width:220px">' + items + '</div></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button class="btn pri" data-id="' + r.id + '" onclick="reviewInv(this.dataset.id)">Разобрано</button>' +
        '<button class="btn ghost revoke" data-id="' + r.id + '" onclick="deleteInv(this.dataset.id)">Удалить</button>' +
      '</div></div>'
  }).join('')
}
async function reviewInv(id){
  try { await api('invoices/review', { id: Number(id) }); toast('Разобрано — фото удалено'); await loadInv() }
  catch(e){ toast(e.message, true) }
}
async function deleteInv(id){
  if (!confirm('Удалить запись распознавания целиком?')) return
  try { await api('invoices/delete', { id: Number(id) }); toast('Удалено'); await loadInv() }
  catch(e){ toast(e.message, true) }
}

const catKey = r => r.venue_id + '::' + r.barcode  // разделитель печатный: ключ попадает в data-атрибут чекбокса, а NUL там ломается
let catSimilar = {} // ключ заявки -> {loading:true} | {rows:[...], error?}

async function showCatSimilar(vid, bc){
  const r = catPending.find(x => x.venue_id === vid && x.barcode === bc)
  if (!r) return
  const k = catKey(r)
  if (catSimilar[k]){ delete catSimilar[k]; renderCatPending(); return } // повторный клик — скрыть
  catSimilar[k] = { loading: true }
  renderCatPending()
  try {
    const d = await api('catalog/similar', { q: r.name })
    catSimilar[k] = { rows: d.rows || [] }
  } catch(e){
    catSimilar[k] = { rows: [], error: e.message }
  }
  renderCatPending()
}
function simRowHtml(r, sim){
  let inner
  if (sim.loading) inner = 'Ищем похожие…'
  else if (!sim.rows.length) inner = sim.error ? ('Ошибка: ' + esc(sim.error)) : 'Похожих в каталоге нет — это новый товар'
  else inner = 'Похожие в каталоге: ' + sim.rows.map(s => {
    const label = s.match_kind === 'alias' ? 'алиас' : Math.round((s.score || 0) * 100) + '%'
    const dup = s.barcode === r.barcode
    return '<span class="simhit' + (dup ? ' same' : '') + '" title="' + esc(s.barcode) + '">' +
      esc(s.name) + ' · ' + label + (dup ? ' · тот же штрихкод!' : '') + '</span>'
  }).join(' ')
  return '<div class="simrow">' + inner + '</div>'
}

async function loadCatPending(){
  try {
    const d = await api('catalog/pending')
    catPending = d.rows || []; catPendTotal = d.total ?? null
    catSimilar = {}
    $('catPendCount').textContent = catPendTotal !== null ? (catPending.length + ' из ' + catPendTotal) : ''
    const n = catPendTotal ?? catPending.length
    $('navCatBadge').style.display = n > 0 ? '' : 'none'
    $('navCatBadge').textContent = n
    renderCatPending()
  } catch(e){ toast(e.message, true) }
}
function toggleCatSel(key, on){
  if (on) catSelected.add(key); else catSelected.delete(key)
  renderCatPending()
}
function toggleCatPendAll(on){
  catPending.forEach(r => { const k = catKey(r); if (on) catSelected.add(k); else catSelected.delete(k) })
  renderCatPending()
}
function renderCatPending(){
  const keys = catPending.map(catKey)
  ;[...catSelected].forEach(k => { if (!keys.includes(k)) catSelected.delete(k) })
  $('catPendAll').checked = keys.length > 0 && keys.every(k => catSelected.has(k))

  if (!catPending.length){
    $('catPendBody').innerHTML = ''
    $('catPendEmpty').style.display = 'block'
  } else {
    $('catPendEmpty').style.display = 'none'
    $('catPendBody').innerHTML = catPending.map(r => {
      const k = catKey(r), sel = catSelected.has(k), sim = catSimilar[k]
      return '<div class="grid-row trow' + (sel ? ' sel' : '') + '" style="grid-template-columns:44px 130px 200px 120px 80px 60px 230px">' +
        '<div><input type="checkbox" data-k="' + esc(k) + '" ' + (sel ? 'checked' : '') + ' onchange="toggleCatSel(this.dataset.k, this.checked)" /></div>' +
        '<div class="cust-id">' + esc(r.barcode) + '</div>' +
        '<div class="cust-name">' + esc(r.name || '') + '</div>' +
        '<div class="exp">' + esc(r.category || '—') + '</div>' +
        '<div class="exp" style="text-align:right">' + (r.price != null ? r.price : '—') + '</div>' +
        '<div class="term">' + esc(r.unit || '—') + '</div>' +
        '<div class="acts">' +
          '<button data-vid="' + esc(r.venue_id) + '" data-bc="' + esc(r.barcode) + '" onclick="showCatSimilar(this.dataset.vid,this.dataset.bc)" title="Похожие карточки в каталоге">≈</button>' +
          '<button data-vid="' + esc(r.venue_id) + '" data-bc="' + esc(r.barcode) + '" onclick="openCatEditPending(this.dataset.vid,this.dataset.bc)" title="Править перед одобрением">✎</button>' +
          '<button data-vid="' + esc(r.venue_id) + '" data-bc="' + esc(r.barcode) + '" onclick="approveCat(this.dataset.vid,this.dataset.bc)">Одобрить</button>' +
          '<button class="revoke" data-vid="' + esc(r.venue_id) + '" data-bc="' + esc(r.barcode) + '" onclick="rejectCat(this.dataset.vid,this.dataset.bc)">Отклонить</button>' +
        '</div>' +
      '</div>' + (sim ? simRowHtml(r, sim) : '')
    }).join('')
  }

  if (catSelected.size > 0){
    $('catBulkbar').style.display = 'flex'
    $('catBulkbar').innerHTML =
      '<span class="lbl">Выбрано: ' + catSelected.size + '</span><div class="sp"></div>' +
      '<button class="pri" onclick="bulkApproveCat()">Одобрить выбранные</button>' +
      '<button class="bad" onclick="bulkRejectCat()">Отклонить выбранные</button>' +
      '<button class="plain" onclick="catSelected.clear();renderCatPending()">Снять</button>'
  } else {
    $('catBulkbar').style.display = 'none'
    $('catBulkbar').innerHTML = ''
  }
}
async function approveCat(venue_id, barcode){
  try { await api('catalog/approve', { venue_id, barcode }); toast('Одобрено'); loadCatPending(); loadCatList() }
  catch(e){ toast(e.message, true) }
}
async function rejectCat(venue_id, barcode){
  try { await api('catalog/reject', { venue_id, barcode }); toast('Отклонено'); loadCatPending() }
  catch(e){ toast(e.message, true) }
}
async function bulkApproveCat(){
  const items = catPending.filter(r => catSelected.has(catKey(r))); if (!items.length) return
  const res = await Promise.allSettled(items.map(r => api('catalog/approve', { venue_id: r.venue_id, barcode: r.barcode })))
  const ok = res.filter(r => r.status === 'fulfilled').length
  toast(ok === items.length ? ('Одобрено: ' + ok) : ('Одобрено: ' + ok + ', ошибок: ' + (items.length - ok)), ok < items.length)
  catSelected.clear(); loadCatPending(); loadCatList()
}
async function bulkRejectCat(){
  const items = catPending.filter(r => catSelected.has(catKey(r))); if (!items.length) return
  if (!confirm('Отклонить ' + items.length + ' заявок?')) return
  const res = await Promise.allSettled(items.map(r => api('catalog/reject', { venue_id: r.venue_id, barcode: r.barcode })))
  const ok = res.filter(r => r.status === 'fulfilled').length
  toast(ok === items.length ? ('Отклонено: ' + ok) : ('Отклонено: ' + ok + ', ошибок: ' + (items.length - ok)), ok < items.length)
  catSelected.clear(); loadCatPending()
}

async function loadCatList(){
  try {
    const d = await api('catalog/list', { q: $('catq').value, page: catPage })
    catRows = d.rows || []; catListTotal = d.total ?? null
    $('catListCount').textContent = catListTotal !== null ? (catListTotal + ' всего') : ''
    renderCatList(); renderCatPager()
  } catch(e){ toast(e.message, true) }
}
function renderCatPager(){
  const per = 200, total = catListTotal || 0, pages = Math.max(1, Math.ceil(total / per))
  const el = $('catPager'); if (!el) return
  if (total <= per){ el.style.display = 'none'; el.innerHTML = ''; return }
  el.style.display = 'flex'
  const from = catPage * per + 1, to = Math.min((catPage + 1) * per, total)
  el.innerHTML =
    '<button ' + (catPage <= 0 ? 'disabled' : '') + ' onclick="gotoCatPage(' + (catPage - 1) + ')">← Назад</button>' +
    '<span class="pinfo">' + from + '–' + to + ' из ' + total + '  •  стр ' + (catPage + 1) + ' / ' + pages + '</span>' +
    '<button ' + (catPage >= pages - 1 ? 'disabled' : '') + ' onclick="gotoCatPage(' + (catPage + 1) + ')">Вперёд →</button>'
}
function gotoCatPage(p){ catPage = Math.max(0, p); loadCatList() }
function catListKey(r){ return r.barcode }
function renderCatList(){
  const keys = catRows.map(catListKey)
  // Выбор НЕ обрезаем по текущей странице — он копится между страницами,
  // массовая смена применяется ко всем выбранным штрихкодам сразу.
  if (!catRows.length){
    $('catBody').innerHTML = ''
    $('catEmpty').style.display = 'block'
  } else {
    $('catEmpty').style.display = 'none'
    $('catBody').innerHTML = catRows.map(r => {
      const k = catListKey(r), sel = catListSel.has(k)
      return '<div class="grid-row trow' + (sel ? ' sel' : '') + '" style="grid-template-columns:44px 130px 220px 130px 90px 70px 60px">' +
        '<div><input type="checkbox" data-k="' + esc(k) + '" ' + (sel ? 'checked' : '') + ' onchange="toggleCatListSel(this.dataset.k, this.checked)" /></div>' +
        '<div class="cust-id">' + esc(r.barcode) + '</div>' +
        '<div class="cust-name">' + esc(r.name || '') + '</div>' +
        '<div class="exp">' + esc(r.category || '—') + '</div>' +
        '<div class="exp" style="text-align:right">' + (r.price != null ? r.price : '—') + '</div>' +
        '<div class="term">' + esc(r.unit || '—') + '</div>' +
        '<div class="acts"><button data-vid="' + esc(r.venue_id) + '" data-bc="' + esc(r.barcode) + '" onclick="openCatEditFromRow(this.dataset.vid,this.dataset.bc)">✎</button></div>' +
      '</div>'
    }).join('')
  }
  const all = $('catListAll'); if (all) all.checked = keys.length > 0 && keys.every(k => catListSel.has(k))
  const bar = $('catListBulkbar')
  if (catListSel.size > 0){
    bar.style.display = 'flex'
    bar.innerHTML = '<span class="lbl">Выбрано: ' + catListSel.size + '</span><div class="sp"></div>' +
      '<button class="pri" onclick="openBulkCat()">Сменить категорию</button>' +
      '<button class="plain" onclick="catListSel.clear();renderCatList()">Снять</button>'
  } else { bar.style.display = 'none'; bar.innerHTML = '' }
}
function toggleCatListSel(k, on){ if (on) catListSel.add(k); else catListSel.delete(k); renderCatList() }
function toggleCatListAll(on){ catRows.forEach(r => { const k = catListKey(r); if (on) catListSel.add(k); else catListSel.delete(k) }); renderCatList() }
const dlgBulkCat = $('dlgBulkCat')
function openBulkCat(){
  if (!catListSel.size) return
  $('dlgBulkCatCount').textContent = 'Товаров выбрано: ' + catListSel.size
  $('bulkCatCategory').value = ''
  $('bulkCatSaveBtn').disabled = false
  dlgBulkCat.showModal()
  $('bulkCatCategory').focus()
}
async function applyBulkCat(){
  $('bulkCatSaveBtn').disabled = true
  try {
    const d = await api('catalog/bulkCategory', { barcodes: [...catListSel], category: $('bulkCatCategory').value })
    toast('Категория проставлена: ' + (d.count ?? catListSel.size))
    dlgBulkCat.close(); catListSel.clear(); loadCatList()
  } catch(e){ toast(e.message, true); $('bulkCatSaveBtn').disabled = false }
}
function findCatRow(venue_id, barcode){ return catRows.find(r => r.venue_id === venue_id && r.barcode === barcode) }
function openCatEditFromRow(venue_id, barcode){ openCatEdit(findCatRow(venue_id, barcode)) }
function findPendRow(venue_id, barcode){ return catPending.find(r => r.venue_id === venue_id && r.barcode === barcode) }
function openCatEditPending(venue_id, barcode){ openCatEdit(findPendRow(venue_id, barcode), true) }

const dlgCat = $('dlgCat')
// pending=true — правка карточки из очереди: сохранение через upsert её же и
// одобряет (status='approved'), поэтому кнопка «Сохранить и одобрить».
function openCatEdit(row, pending){
  catEditKey = row ? { venue_id: row.venue_id, barcode: row.barcode } : null
  $('dlgCatTitle').textContent = pending ? 'Править перед одобрением' : (row ? 'Правка штрихкода' : 'Новый штрихкод')
  $('catBarcode').value = row ? row.barcode : ''
  $('catBarcode').readOnly = !!row
  $('catName').value = row ? (row.name || '') : ''
  $('catCategory').value = row ? (row.category || '') : ''
  $('catPrice').value = row && row.price != null ? row.price : ''
  $('catUnit').value = row ? (row.unit || '') : ''
  $('catDelBtn').style.display = row && !pending ? '' : 'none'
  $('catSaveBtn').textContent = pending ? 'Сохранить и одобрить' : 'Сохранить'
  $('catSaveBtn').disabled = false
  dlgCat.showModal()
  $('catName').focus()
}
async function saveCatRow(){
  $('catSaveBtn').disabled = true
  try {
    await api('catalog/upsert', {
      venue_id: catEditKey ? catEditKey.venue_id : undefined,
      barcode: $('catBarcode').value,
      name: $('catName').value,
      category: $('catCategory').value,
      price: $('catPrice').value,
      unit: $('catUnit').value
    })
    toast('Сохранено')
    dlgCat.close()
    loadCatList(); loadCatPending()   // обновляем и каталог, и очередь (правка из очереди её одобряет)
  } catch(e){ toast(e.message, true); $('catSaveBtn').disabled = false }
}
async function deleteCatRow(){
  if (!catEditKey) return
  if (!confirm('Удалить штрихкод ' + $('catBarcode').value + ' из каталога?')) return
  try {
    await api('catalog/delete', catEditKey)
    toast('Удалено')
    dlgCat.close()
    loadCatList()
  } catch(e){ toast(e.message, true) }
}

function boot(){
  applyTheme()
  const has = !!pw()
  $('login').style.display = has ? 'none' : 'flex'
  $('app').style.display = has ? '' : 'none'
  // Очередь модерации грузим сразу при входе: и бейдж «на модерации N» виден
  // без перехода на вкладку, и проект монитора получает активность (не заснёт).
  // Заявки и состояние облака — тем же приёмом: смысл в том, чтобы поломка
  // и новая заявка находили владельца сами, а не ждали, пока он зайдёт.
  if (has){ load(); loadCatPending(); loadReq(); loadCloud(); loadTrials() }
}
;[dlgIssue, dlg].forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close() }))
// Диалоги правки категории (dlgCat, dlgBulkCat) НЕ закрываем случайным кликом по
// фону и клавишей Esc — чтобы не потерять введённое. Только кнопки Отмена/Сохранить.
;[dlgCat, dlgBulkCat].forEach(d => d.addEventListener('cancel', e => e.preventDefault()))
boot()
</script>
</body>
</html>`
