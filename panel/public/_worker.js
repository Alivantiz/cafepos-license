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

// Человеческий текст вместо сырого ответа Supabase. Колонки contact/hidden
// добавляются отдельными ALTER, и пока их не выполнили, запись падала с
// «PGRST204 column ... does not exist» — владельцу такое сообщение не говорит
// ничего, а сделать надо ровно одну понятную вещь.
async function sqlHint(res, cols) {
  const text = await res.text()
  const missing = cols.find(c => text.includes(`'${c}'`) || text.includes(`"${c}"`))
  if (missing || /does not exist|PGRST204|42703/.test(text)) {
    return `В базе нет колонки${missing ? ' «' + missing + '»' : ''}. Выполните SQL из license-server/supabase/schema.sql (раздел про contact и hidden) в Supabase → SQL Editor.`
  }
  return `Supabase: ${res.status} ${text}`
}

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

    // Всё, что не API, — собранное приложение (Vite → dist). В «Advanced mode»
    // Pages статику сам не отдаёт: воркер перехватывает ВСЕ запросы, поэтому
    // ассеты берём явно через env.ASSETS.
    if (!pathname.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Сборка не найдена: проверьте build command и output directory', { status: 500 })
      const res = await env.ASSETS.fetch(request)
      // Одностраничное приложение: неизвестный путь — это не 404, а маршрут
      // внутри него, отдаём index.html.
      if (res.status === 404) return env.ASSETS.fetch(new Request(new URL('/', request.url)))
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
        const LIC_BASE = 'id,customer,machine_id,expires_at,terminals,revoked,activated_at,last_seen_at,notes,created_at'
        const licenses_ = (cols) => fetch(
          `${db.url}/rest/v1/licenses?select=${cols}&order=created_at.desc`, { headers: db.headers })
        let [licR, trialR, dailyR, stateR] = await Promise.all([
          licenses_(LIC_BASE + ',contact,hidden'),
          fetch(`${db.url}/rest/v1/trials?select=machine_id,started_at,status,business_type,app_version,last_seen_at,created_at&order=last_seen_at.desc`, { headers: db.headers }),
          fetch(`${db.url}/rest/v1/usage_daily?select=subject,day,revenue,receipts&day=gte.${since}&order=day.asc&limit=20000`, { headers: db.headers }),
          fetch(`${db.url}/rest/v1/usage_state?select=subject,registers,locations,last_sale_at,updated_at&limit=5000`, { headers: db.headers }),
        ])
        // contact/hidden добавлены позже отдельными ALTER. Пока их не выполнили,
        // запрос с этими колонками падает целиком — и панель осталась бы вообще
        // без клиентов. Повторяем без них: лучше без телефона, чем без списка.
        if (!licR.ok) licR = await licenses_(LIC_BASE)
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
        const { customer, days, terminals, notes, contact, machine_id } = await request.json()
        if (!customer || !String(customer).trim()) return json({ error: 'Укажите клиента' }, 400)
        const n = Number(days)
        const body = {
          customer: String(customer).trim(),
          expires_at: Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 86400000).toISOString() : null,
          terminals: Math.max(1, Number(terminals) || 1),
          notes: (notes || '').trim() || null
        }
        // Телефон — только если колонка уже есть: на проекте без ALTER лишнее
        // поле уронило бы весь выпуск лицензии.
        const phone = (contact || '').trim()
        if (phone) body.contact = phone

        // Выпуск для конкретного компьютера (из карточки пробной установки):
        // лицензия сразу привязана, и касса забирает её сама функцией claim —
        // код клиенту диктовать не надо. Та же защита от дубля, что у одобрения
        // заявки: вторая живая лицензия на ту же машину сломала бы claim.
        const mid = String(machine_id || '').trim().toUpperCase()
        if (mid) {
          const dup = await fetch(`${db.url}/rest/v1/licenses?machine_id=eq.${encodeURIComponent(mid)}&select=id,revoked`, { headers: db.headers })
          if (!dup.ok) return json({ error: `Supabase: ${dup.status} ${await dup.text()}` }, 502)
          const live = (await dup.json()).filter(l => l.revoked !== true)
          if (live.length) return json({ error: `На этот компьютер уже выпущена лицензия ${live[0].id}` }, 409)
          body.machine_id = mid
        }
        const ins = await fetch(`${db.url}/rest/v1/licenses`, {
          method: 'POST',
          headers: { ...db.headers, Prefer: 'return=representation' },
          body: JSON.stringify(body)
        })
        if (!ins.ok) return json({ error: await sqlHint(ins, ['contact']) }, 502)
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

      // Правка карточки клиента. Раньше правились только заметки: имя задавалось
      // один раз при выпуске и оставалось навсегда, телефона не было вовсе.
      //
      // Белый список полей, а не «что прислали, то и пишем»: срок, привязка к
      // машине и revoked меняются своими каналами со своей логикой (продление
      // считает от текущей даты, привязку ставит /activate). Попади они сюда —
      // и лицензию можно было бы «продлить» мимо всех проверок.
      if (pathname === '/api/edit') {
        const body = await request.json()
        const id = body?.id
        if (!id) return json({ error: 'Нужен id' }, 400)

        const patch = {}
        if ('customer' in body) {
          const v = String(body.customer ?? '').trim()
          if (!v) return json({ error: 'Имя клиента не может быть пустым' }, 400)
          patch.customer = v
        }
        if ('contact' in body) patch.contact = String(body.contact ?? '').trim() || null
        if ('notes' in body) patch.notes = String(body.notes ?? '').trim() || null
        if ('hidden' in body) {
          if (typeof body.hidden !== 'boolean') return json({ error: 'hidden — true или false' }, 400)
          patch.hidden = body.hidden
        }
        if ('terminals' in body) {
          const n = Number(body.terminals)
          if (!Number.isFinite(n) || n < 1) return json({ error: 'Терминалов — целое число от 1' }, 400)
          patch.terminals = Math.floor(n)
        }
        if (!Object.keys(patch).length) return json({ error: 'Нечего менять' }, 400)

        const r = await fetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify(patch)
        })
        if (!r.ok) return json({ error: await sqlHint(r, ['contact', 'hidden']) }, 502)
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
