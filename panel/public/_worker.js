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

// Любой запрос в Supabase — с ограничением по времени. Без него уснувший
// проект (бесплатный тариф засыпает) или тяжёлый запрос оставляли соединение
// висеть, и в браузере вкладка вечно показывала «Pending»: ни данных, ни
// ошибки, ни причины. Пятнадцать секунд — заведомо больше нормального ответа.
const SB_TIMEOUT_MS = 15_000
const sbFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(SB_TIMEOUT_MS) })

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
    return `В базе нет колонки${missing ? ' «' + missing + '»' : ''}. Выполните SQL из license-server/supabase/schema.sql (раздел про contact, hidden, price и snoozed_until) в Supabase → SQL Editor.`
  }
  return `Supabase: ${res.status} ${text}`
}

// ── Словарь написаний: строка на заведение, решение — одно ──────────────
// В mon_invoice_aliases ключ (venue_id, raw_name_norm): одно и то же написание
// присылает КАЖДОЕ заведение своей строкой. Для вендора это одна работа, а не
// пять: и очередь схлопываем по написанию, и решение применяем ко всем строкам
// с ним разом. Иначе «Маккофи 3в1» разбирается столько раз, сколько магазинов
// его возит, а кассы всё равно берут словарь через distinct on (raw_name_norm).
// Порог автодоверия: столько РАЗНЫХ точек должны независимо привязать один и
// тот же код к одному написанию, чтобы вендору осталось согласиться, а не
// искать код руками. Три — потому что две точки одной сети могут повторить
// одну и ту же ошибку внедренца, а три независимых магазина уже нет.
export const TRUST_VENUES = 3

export function groupAliases(rows) {
  const by = new Map()
  for (const r of rows || []) {
    const cur = by.get(r.raw_name_norm)
    if (!cur) {
      // codes: какой код прислали САМИ магазины (они привязали его сканером в
      // приёмке). Для очереди это не заявка, а готовый ответ — считаем, сколько
      // точек за каждый вариант.
      const codes = new Map()
      if (r.barcode) codes.set(String(r.barcode), 1)
      by.set(r.raw_name_norm, { ...r, hits: Number(r.hits) || 1, venues: 1, codes })
      continue
    }
    // hits складываем: очередь по частоте должна считать все точки, иначе
    // товар, который возят все понемногу, всегда уступает одному активному.
    cur.hits += Number(r.hits) || 1
    cur.venues += 1
    // Самое свежее время из всех точек: по нему «Привязанные» показывают то,
    // что вендор разобрал только что. Первая строка группы приходит по
    // частоте, а не по времени, и её updated_at может быть годовалым.
    if (r.updated_at && (!cur.updated_at || r.updated_at > cur.updated_at)) cur.updated_at = r.updated_at
    if (!cur.supplier && r.supplier) cur.supplier = r.supplier
    if (!cur.supplier_code && r.supplier_code) cur.supplier_code = r.supplier_code
    if (r.barcode) cur.codes.set(String(r.barcode), (cur.codes.get(String(r.barcode)) || 0) + 1)
  }
  return [...by.values()]
    .map(g => {
      // Лидер по числу точек. Спорное (две точки прислали РАЗНЫЕ коды) —
      // никогда не бесспорно: пусть смотрит человек.
      const sorted = [...g.codes.entries()].sort((a, b) => b[1] - a[1])
      const [barcode, venues] = sorted[0] ?? []
      const disputed = sorted.length > 1
      const { codes, ...rest } = g
      return {
        ...rest,
        proposed: barcode ?? null,
        proposed_venues: venues ?? 0,
        disputed,
        // Бесспорная строка: один вариант кода и он пришёл с трёх точек.
        trusted: !!barcode && !disputed && venues >= TRUST_VENUES,
      }
    })
    .sort((a, b) => b.hits - a.hits)
}

// Написание берём из базы по id, а НЕ из запроса: по нему решение уедет на все
// строки с этим написанием, и подменённая норма увела бы чужой товар на этот
// штрихкод — а это уже неверный остаток во всех магазинах.
async function aliasNorm(db2, id) {
  const r = await sbFetch(
    `${db2.url}/rest/v1/mon_invoice_aliases?id=eq.${encodeURIComponent(id)}&select=raw_name_norm`,
    { headers: db2.headers })
  if (!r.ok) return { ok: false, res: json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502) }
  const [row] = await r.json()
  if (!row) return { ok: false, res: json({ error: 'Строка не найдена' }, 404) }
  return { ok: true, value: row.raw_name_norm }
}

// По умолчанию — только ещё не разобранные: уже одобренное чужим кодом
// переписывать нельзя, иначе запоздалый клик по старому списку увёл бы товар.
// Исправление ошибки — отдельное осознанное действие (all: true), его шлёт
// вкладка «Привязанные» кнопками «Изменить код» и «Отвязать».
const aliasByNorm = (db2, norm, all = false) =>
  `${db2.url}/rest/v1/mon_invoice_aliases?raw_name_norm=eq.${encodeURIComponent(norm)}`
  + (all ? '' : '&status=eq.pending')

// Несколько написаний разом — одним запросом. Нужно там, где у одной строки
// накладной два возможных ключа (см. invoiceCodePairs): отдельными PATCH-ами
// они удваивают число внешних подзапросов, а их у воркера считаное количество.
const aliasByNorms = (db2, norms) =>
  `${db2.url}/rest/v1/mon_invoice_aliases?raw_name_norm=in.(`
  + norms.map(n => '"' + encodeURIComponent(n) + '"').join(',')
  + ')&status=eq.pending'

// ── Коды, уже приехавшие в распознанных накладных ──────────────────────────
// В mon_ai_invoices разобранный JSON лежит вечно (при «Разобрано» стирается
// только фото), и штрихкод в строке часто есть: колонкой либо напечатанный
// внутри наименования («Сметана Нежный 1,2% / ШК: 4650827100561»). Касса
// вынимает такой код сама, но лишь из НОВЫХ накладных — а в очереди написаний
// уже лежат названия, разобранные до этого. Переписывать их с фото руками —
// часы работы там, где ответ лежит в соседней таблице.
//
// Ключ обязан считаться ровно как на кассе (shared/product-name.ts `norm` плюс
// barcode-catalog.service.ts `invoiceNameKey`): по нему привязка ищет строки
// очереди, и разойдись формулы — она молча не найдёт ничего.
const KZ_FOLD = { 'ә': 'а', 'ғ': 'г', 'қ': 'к', 'ң': 'н', 'ө': 'о', 'ұ': 'у', 'ү': 'у', 'һ': 'х', 'і': 'и' }
export const invoiceNameKey = (raw) =>
  String(raw ?? '').replace(/\/\s*\d+\s*шт\.?/gi, ' ').trim().toLowerCase()
    .replace(/[әғқңөұүһі]/g, c => KZ_FOLD[c] ?? c)
    .replace(/[\s._\-]/g, '')

// Контрольная цифра — против ошибки распознавания в ОДНОЙ цифре: такой код
// почти всегда оказывается кодом чужого реального товара, и привязка развезёт
// ошибку по всем магазинам сразу.
export function validBarcode(code) {
  const s = String(code ?? '').trim()
  if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return false
  const d = s.split('').map(Number)
  const check = d.pop()
  let sum = 0
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w
  return (10 - (sum % 10)) % 10 === check
}

// Код строки накладной и имя без него. Повторяет barcodeFromName кассы
// (invoice-ai.service.ts): сперва отдельная колонка, потом код внутри имени.
// found — цифры, которые в строке ВООБЩЕ нашлись, годные или нет. Без этого
// пропущенная строка выглядит одинаково в двух совершенно разных случаях:
// «распознавание не прочитало код» и «прочитало с ошибкой в одной цифре».
// Владельцу это разные новости: в первом случае смотреть на фото, во втором —
// поправить одну цифру руками.
export function invoiceItemCode(it) {
  const raw = String(it?.name ?? '')
  const own = String(it?.barcode ?? '').trim()
  if (validBarcode(own)) return { barcode: own, raw, clean: raw, found: own }
  const m = raw.match(/(?:шк|штрих-?код|ean)\s*[:№#]?\s*(\d{8,14})/i)
    || raw.match(/(?:^|[\s(/|,;])(\d{12,14})(?=$|[\s)/|,;])/)
  const found = /^\d{8,14}$/.test(own) ? own : (m?.[1] ?? null)
  if (!m || !validBarcode(m[1])) return { barcode: null, raw, clean: raw, found }
  const clean = raw.replace(m[0], ' ').replace(/\s{2,}/g, ' ')
    .replace(/^[\s/|,;()\[\]-]+|[\s/|,;()\[\]-]+$/g, '').trim()
  return { barcode: m[1], raw, clean: clean || raw, found }
}

// Какие из написаний ещё ЖДУТ кода. Без этой проверки кнопка обещала «14», а
// привязывала 7: касса шлёт в очередь только те строки накладной, которые не
// сопоставила со своим товаром (invoice-ai.service.ts), — остальные там просто
// не лежат. Считать надо то, что реально изменится.
//
// Спрашиваем пачками по 120 ключей: список in.(…) уходит в адресную строку, а
// она не резиновая. Не получилось — возвращаем null: пусть кнопка считает по
// старому и обещает лишнего, это лучше, чем спрятать её совсем.
async function pendingNorms(db2, keys) {
  const out = new Set()
  for (let i = 0; i < keys.length && i < 600; i += 120) {
    const r = await sbFetch(aliasByNorms(db2, keys.slice(i, i + 120)) + '&select=raw_name_norm',
      { headers: db2.headers })
    if (!r.ok) return null
    for (const row of await r.json().catch(() => [])) out.add(row.raw_name_norm)
  }
  return out
}

// Ключи одной строки накладной. Их два: старые строки очереди приехали с кодом
// ВНУТРИ имени, новые (после релиза кассы, которая его вырезает) — уже без
// него. Какой из них лежит в базе, отсюда не видно, поэтому ищем по обоим.
export function itemKeys(it) {
  const { raw, clean } = invoiceItemCode(it)
  return [...new Set([invoiceNameKey(raw), invoiceNameKey(clean)])]
    // Кавычка порвала бы список in.(…), а короткий огрызок — это не название.
    .filter(k => k.length >= 4 && !k.includes('"'))
}

// Пары «написание → код» из одной накладной.
export function invoiceCodePairs(items) {
  const by = new Map()
  for (const it of items || []) {
    const { barcode, raw } = invoiceItemCode(it)
    if (!barcode) continue
    const keys = itemKeys(it)
    if (!keys.length) continue
    const id = keys.join('|')
    // Одно написание в накладной может идти несколькими строками (фасовки) —
    // привязываем один раз.
    if (!by.has(id)) by.set(id, { name: raw, barcode, keys })
  }
  return [...by.values()]
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
          const r = await sbFetch(`${p.url}/rest/v1/`, { headers: p.headers })
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
        // 35 дней, а не 90: панель нигде не показывает окно длиннее тридцати,
        // а лишние два месяца строк на каждого клиента гонялись из Supabase при
        // каждом обновлении — это оплаченный трафик за данные, которые никто
        // не рисует. Запас в пять дней — на разницу часовых поясов и на то,
        // что «за 30 дней» считается от сегодня.
        const since = isoDay(-35)
        const LIC_BASE = 'id,customer,machine_id,expires_at,terminals,revoked,activated_at,last_seen_at,notes,created_at'
        // Колонки, добавленные ALTER-ами позже базовой схемы: на проекте, где
        // SQL ещё не выполнили, запрос с ними падает целиком.
        const LIC_OPT = ['contact', 'hidden', 'price', 'snoozed_until', 'city']
        const licenses_ = (cols) => sbFetch(
          `${db.url}/rest/v1/licenses?select=${cols}&order=created_at.desc`, { headers: db.headers })
        let [licR, trialR, dailyR, stateR, renewR] = await Promise.all([
          licenses_(LIC_BASE + ',' + LIC_OPT.join(',')),
          sbFetch(`${db.url}/rest/v1/trials?select=machine_id,started_at,status,business_type,app_version,last_seen_at,created_at&order=last_seen_at.desc`, { headers: db.headers }),
          sbFetch(`${db.url}/rest/v1/usage_daily?select=subject,day,revenue,receipts&day=gte.${since}&order=day.asc&limit=20000`, { headers: db.headers }),
          sbFetch(`${db.url}/rest/v1/usage_state?select=subject,registers,locations,last_sale_at,updated_at&limit=5000`, { headers: db.headers }),
          // История продлений здесь же, а не отдельным запросом с карточки:
          // строк мало (одно продление на клиента в месяц), зато сводка может
          // сложить из них «получено за 30 дней» — свои деньги, а не чужие.
          sbFetch(`${db.url}/rest/v1/license_renewals?select=license_id,days,amount,to_expires,created_at&order=created_at.desc&limit=500`, { headers: db.headers }),
        ])
        // Пока ALTER-ы не выполнили, запрос с этими колонками падает целиком — и
        // панель осталась бы вообще без клиентов. Отступаем по одной колонке с
        // конца, а не сразу к базе: иначе непринятая price уносила бы и телефон,
        // который на этом проекте давно работает.
        for (let n = LIC_OPT.length - 1; n >= 0 && !licR.ok; n--) {
          licR = await licenses_(n ? LIC_BASE + ',' + LIC_OPT.slice(0, n).join(',') : LIC_BASE)
        }
        for (const [name, r] of [['licenses', licR], ['trials', trialR], ['usage_daily', dailyR], ['usage_state', stateR]]) {
          // usage_* появились позже остальных: если SQL ещё не выполнен, таблицы
          // нет — это не повод отдать 502 и оставить владельца без панели вообще.
          if (!r.ok && (name === 'usage_daily' || name === 'usage_state')) continue
          if (!r.ok) return json({ error: `Supabase (${name}): ${r.status} ${await r.text()}` }, 502)
        }
        const daily = dailyR.ok ? await dailyR.json() : []
        const state = stateR.ok ? await stateR.json() : []
        // Таблицы может не быть (SQL не выполнен) — это пустая история, а не
        // повод оставить владельца без списка клиентов.
        const renewals = renewR.ok ? await renewR.json() : []
        const byRenewal = new Map()
        for (const r of renewals) {
          if (!byRenewal.has(r.license_id)) byRenewal.set(r.license_id, [])
          byRenewal.get(r.license_id).push(r)
        }
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
            // Когда касса последний раз ПРИСЛАЛА итоги. Без этого «продаж нет»
            // не отличить от «касса молчит»: обе выглядят пустой датой продажи.
            usage_at: st?.updated_at ?? null,
            ...window_(days),
          }
        }
        const licenses = (await licR.json()).map(r =>
          ({ ...decorate(r, r.id, 'license'), renewals: byRenewal.get(r.id) || [] }))
        // Один ПК — одна карточка. После активации касса перестаёт слать /trial
        // (license.service.ts: с лицензией работает /status), поэтому строка в
        // trials навсегда застывает в статусе «пробный» и клиент двоился — и в
        // пробных, и в платящих. Отсекаем по machine_id, а не по статусу:
        // статус «licensed» этой строке никто никогда не проставлял. По факту
        // лицензии чинятся и уже накопленные строки, без переустановки касс.
        const licensedMachines = new Set(
          licenses.map(l => String(l.machine_id || '').trim()).filter(Boolean))
        // Лицензия выдана, но ещё не активирована (machine_id пустой) — триал
        // прятать нечем и не нужно: человек всё ещё на пробе.
        const trials = (await trialR.json())
          .filter(r => !licensedMachines.has(String(r.machine_id || '').trim()))
          .map(r => decorate(r, r.machine_id, 'trial'))
        return json({ licenses, trials, kaspiPhone: (env.OWNER_KASPI_PHONE || '').trim() })
      }

      if (pathname === '/api/renew') {
        const { id, days, amount } = await request.json()
        const n = Number(days)
        if (!id || !Number.isFinite(n) || n <= 0) return json({ error: 'Нужны id и положительное число дней' }, 400)

        const getRes = await sbFetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}&select=customer,expires_at`, { headers: db.headers })
        if (!getRes.ok) return json({ error: `Supabase: ${getRes.status}` }, 502)
        const rows = await getRes.json()
        if (!rows.length) return json({ error: 'Лицензия не найдена' }, 404)

        // Та же логика, что в license-renew.mjs: продлеваем от сегодня или от
        // текущего срока — что позже; заодно снимаем revoked (оплатил = вернули).
        const now = new Date()
        const cur = rows[0].expires_at ? new Date(rows[0].expires_at) : null
        const base = cur && cur > now ? cur : now
        const newExpires = new Date(base.getTime() + n * 86400000).toISOString()

        const patch = await sbFetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ expires_at: newExpires, revoked: false })
        })
        if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)

        // История продлений: раньше от платежа не оставалось ничего, кроме
        // сдвинутой даты. На вопрос «сколько он уже заплатил и как давно с
        // нами» ответить было нечем — а это первое, что смотрят перед скидкой
        // или перед тем, как отпускать клиента.
        //
        // Запись — не критичная часть продления: если таблицы ещё нет, подписка
        // всё равно продлена, и валить операцию из-за журнала нельзя.
        const paid = Number(amount)
        await sbFetch(`${db.url}/rest/v1/license_renewals`, {
          method: 'POST',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            license_id: String(id), days: n,
            amount: Number.isFinite(paid) && paid > 0 ? Math.round(paid) : null,
            from_expires: rows[0].expires_at || null, to_expires: newExpires,
          })
        }).catch(() => {})
        return json({ ok: true, customer: rows[0].customer, expires_at: newExpires })
      }


      if (pathname === '/api/issue') {
        // Новая лицензия под активацию по коду: строка в таблице, id = код
        // активации (его вводят на кассе; .lic подписывает функция activate).
        const { customer, days, terminals, notes, contact, price, machine_id } = await request.json()
        if (!customer || !String(customer).trim()) return json({ error: 'Укажите клиента' }, 400)
        const n = Number(days)
        const body = {
          customer: String(customer).trim(),
          expires_at: Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 86400000).toISOString() : null,
          terminals: Math.max(1, Number(terminals) || 1),
          notes: (notes || '').trim() || null
        }
        // Телефон и цена — в отдельной пачке: их колонки добавлены ALTER-ами
        // позже, и на проекте, где SQL ещё не выполнили, лишнее поле уронило бы
        // весь выпуск лицензии. Поэтому при отказе пробуем ещё раз без них.
        const extra = {}
        const phone = (contact || '').trim()
        if (phone) extra.contact = phone
        const p = Number(price)
        if (Number.isFinite(p) && p >= 0) extra.price = Math.round(p)

        // Выпуск для конкретного компьютера (из карточки пробной установки):
        // лицензия сразу привязана, и касса забирает её сама функцией claim —
        // код клиенту диктовать не надо. Та же защита от дубля, что у одобрения
        // заявки: вторая живая лицензия на ту же машину сломала бы claim.
        const mid = String(machine_id || '').trim().toUpperCase()
        if (mid) {
          const dup = await sbFetch(`${db.url}/rest/v1/licenses?machine_id=eq.${encodeURIComponent(mid)}&select=id,revoked`, { headers: db.headers })
          if (!dup.ok) return json({ error: `Supabase: ${dup.status} ${await dup.text()}` }, 502)
          const live = (await dup.json()).filter(l => l.revoked !== true)
          if (live.length) return json({ error: `На этот компьютер уже выпущена лицензия ${live[0].id}` }, 409)
          body.machine_id = mid
        }
        const insert = (b) => sbFetch(`${db.url}/rest/v1/licenses`, {
          method: 'POST',
          headers: { ...db.headers, Prefer: 'return=representation' },
          body: JSON.stringify(b)
        })
        let ins = await insert({ ...body, ...extra })
        // Выпуск лицензии — то, ради чего панель вообще нужна: ронять его
        // из-за невыполненного ALTER нельзя. Лучше без телефона и цены.
        if (!ins.ok && Object.keys(extra).length) ins = await insert(body)
        if (!ins.ok) return json({ error: await sqlHint(ins, ['contact', 'price']) }, 502)
        const [row] = await ins.json()
        return json({ ok: true, id: row.id, expires_at: row.expires_at })
      }

      if (pathname === '/api/revoke') {
        const { id, revoked } = await request.json()
        if (!id || typeof revoked !== 'boolean') return json({ error: 'Нужны id и revoked (true/false)' }, 400)
        const patch = await sbFetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
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
        // Город ставит вендор при одобрении, а не касса в заявке: в свободное
        // поле на кассе впишут что угодно, и «Шиели»/«шиели»/«Шиели р-н»
        // разъедутся в три разных города. Здесь список сам собой сходится к
        // тем названиям, что уже есть.
        if ('city' in body) patch.city = String(body.city ?? '').trim() || null
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
        // Цена ОДНОГО продления, а не «в месяц»: кто-то платит помесячно, кто-то
        // за год — приводить это к общему периоду значит гадать. Панель ставит
        // сумму в календарь платежей ровно в тот день, когда лицензия истекает.
        if ('price' in body) {
          if (body.price === null || body.price === '') patch.price = null
          else {
            const n = Number(body.price)
            if (!Number.isFinite(n) || n < 0) return json({ error: 'Цена — число от 0' }, 400)
            patch.price = Math.round(n)
          }
        }
        // «Отложить»: клиент остаётся в списке и в цифрах, но до этой даты не
        // попадает в «требует внимания сегодня». Без этого молчащая касса, про
        // которую уже позвонили и договорились, висела в блоке каждый день и
        // приучала не читать его вовсе.
        if ('snoozed_until' in body) {
          const v = String(body.snoozed_until ?? '').trim()
          if (!v) patch.snoozed_until = null
          else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return json({ error: 'Дата — в виде ГГГГ-ММ-ДД' }, 400)
          else patch.snoozed_until = v
        }
        if (!Object.keys(patch).length) return json({ error: 'Нечего менять' }, 400)

        const patchLic = (p) => sbFetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify(p)
        })
        const r = await patchLic(patch)
        if (r.ok) return json({ ok: true })
        // Колонка city добавлена ALTER-ом позже остальных. Пока SQL не выполнен,
        // PATCH с ней падает ЦЕЛИКОМ — и правка имени, телефона и цены пропадает
        // заодно с городом, хотя к городу отношения не имеет. Сохраняем всё
        // остальное и честно говорим, что город не записан.
        if ('city' in patch) {
          const { city, ...rest } = patch
          if (Object.keys(rest).length) {
            const r2 = await patchLic(rest)
            if (r2.ok) return json({
              ok: true,
              warning: 'Всё сохранено, кроме города: в базе нет колонки city. Выполните SQL из license-server/supabase/schema.sql в Supabase → SQL Editor.'
            })
          }
        }
        return json({ error: await sqlHint(r, ['contact', 'hidden', 'price', 'snoozed_until', 'city']) }, 502)
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
            const r = await sbFetch(`${f.base}/functions/v1/${f.name}`, { method: 'GET' })
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
          // countOnly — для красной точки в меню: «ждут решения» это заявка без
          // лицензии и не отклонённая, ровно тот же отбор, что в списке.
          const { countOnly } = await request.json().catch(() => ({}))
          const qs = countOnly
            ? 'select=machine_id&status=neq.rejected&license_id=is.null&limit=1'
            : 'select=machine_id,shop,contact,business_type,app_version,status,license_id,created_at,updated_at,decided_at&order=created_at.desc&limit=200'
          const r = await sbFetch(`${db.url}/rest/v1/activation_requests?${qs}`,
            { headers: countOnly ? { ...db.headers, Prefer: 'count=exact' } : db.headers })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const total = Number((r.headers.get('content-range') || '').split('/')[1])
          return json({ rows: await r.json(), total: Number.isFinite(total) ? total : null })
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
          const dup = await sbFetch(`${db.url}/rest/v1/licenses?machine_id=eq.${encodeURIComponent(mid)}&select=id,revoked`, { headers: db.headers })
          if (!dup.ok) return json({ error: `Supabase: ${dup.status} ${await dup.text()}` }, 502)
          const live = (await dup.json()).filter(l => l.revoked !== true)
          if (live.length) return json({ error: `На этот компьютер уже выпущена лицензия ${live[0].id}` }, 409)

          const n = Number(days)
          const ins = await sbFetch(`${db.url}/rest/v1/licenses`, {
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
          const patch = await sbFetch(`${db.url}/rest/v1/activation_requests?machine_id=eq.${encodeURIComponent(mid)}`, {
            method: 'PATCH',
            headers: { ...db.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'rejected', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }
      }

      // --- Вкладка «Штрихкоды»: общий словарь mon_barcodes (проект монитора) ---
      // ── Словарь написаний из накладных ────────────────────────────────
      // Кассы шлют сюда имена, которые у них не сопоставились. Вендор
      // привязывает штрихкод один раз — и все магазины начинают распознавать
      // эту строку сами. Очередь отсортирована по частоте: сперва то, что
      // реально возят, а не то, что пришло последним.
      if (pathname.startsWith('/api/aliases/')) {
        const db2 = sb2(env)
        if (!db2.url || !env.MONITOR_SUPABASE_SERVICE_ROLE_KEY) {
          return json({ error: 'Не заданы секреты MONITOR_SUPABASE_URL / MONITOR_SUPABASE_SERVICE_ROLE_KEY' }, 500)
        }

        if (pathname === '/api/aliases/list') {
          const { status, countOnly } = await request.json().catch(() => ({}))
          const st = status === 'approved' || status === 'rejected' ? status : 'pending'
          // Считаем РАЗНЫЕ написания, а не строки: одно и то же название
          // присылает каждое заведение своей строкой, и бейдж, считающий строки,
          // обещал бы работы втрое больше, чем есть на самом деле.
          if (countOnly) {
            const r = await sbFetch(
              `${db2.url}/rest/v1/mon_invoice_aliases?select=raw_name_norm&status=eq.${st}&limit=5000`,
              { headers: db2.headers })
            if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
            return json({ rows: [], total: new Set((await r.json()).map(x => x.raw_name_norm)).size })
          }
          // Забираем ВСЕ строки статуса, а не первую тысячу. Группировка идёт по
          // написанию и складывает строки разных заведений — оборви выборку на
          // середине, и «прислали три точки» превратится в «одна», то есть
          // бесспорное перестанет быть бесспорным. Плюс хвост очереди раньше
          // был недостижим. Групп после схлопывания в разы меньше строк, поэтому
          // отдаём их целиком, а листает уже панель.
          const raw = []
          for (let from = 0; from < 20000; from += 1000) {
            const r = await sbFetch(
              `${db2.url}/rest/v1/mon_invoice_aliases?status=eq.${st}&order=hits.desc,updated_at.desc&limit=1000&offset=${from}`,
              { headers: db2.headers })
            if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
            const part = await r.json()
            raw.push(...part)
            if (part.length < 1000) break
          }
          const rows = groupAliases(raw)
          return json({ rows, total: rows.length })
        }

        // Подсказка модератору: что вообще лежит в справочнике под похожим
        // именем. Иначе штрихкод пришлось бы искать в другой вкладке и носить
        // его сюда руками.
        if (pathname === '/api/aliases/suggest') {
          const { q } = await request.json().catch(() => ({}))
          const needle = String(q || '').trim()
          if (needle.length < 3) return json({ rows: [] })
          const r = await sbFetch(
            `${db2.url}/rest/v1/mon_barcodes?select=barcode,name,category,unit&status=eq.approved&name=ilike.*${encodeURIComponent(needle)}*&limit=20`,
            { headers: db2.headers })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          return json({ rows: await r.json() })
        }

        // Привязка кода = одобрение. Кассы тянут только строки со статусом
        // approved И непустым кодом, поэтому одно без другого смысла не имеет.
        if (pathname === '/api/aliases/bind') {
          const { id, barcode, force } = await request.json()
          const bc = String(barcode || '').trim()
          if (!id || !/^\d{8,14}$/.test(bc)) return json({ error: 'Нужны id и штрихкод из 8–14 цифр' }, 400)
          const norm = await aliasNorm(db2, id)
          if (!norm.ok) return norm.res
          const patch = await sbFetch(aliasByNorm(db2, norm.value, force === true), {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ barcode: bc, status: 'approved', updated_at: new Date().toISOString() })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }

        // Бесспорные строки — одним нажатием. Одобряем только то, где сами
        // магазины независимо привязали ОДИН и тот же код с трёх точек: искать
        // такой код руками нечего, а очередь без этого растёт быстрее, чем
        // вендор успевает её разбирать.
        if (pathname === '/api/aliases/approve-trusted') {
          const r = await sbFetch(
            `${db2.url}/rest/v1/mon_invoice_aliases?status=eq.pending&limit=5000`,
            { headers: db2.headers })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const trusted = groupAliases(await r.json()).filter(g => g.trusted)
          // Больше 40 за вызов не берём. У каждой строки свой код, одним PATCH
          // их не одобрить, а на бесплатном тарифе Cloudflare воркеру положено
          // не больше 50 ВНЕШНИХ подзапросов на вызов: полсотни бесспорных
          // строк — и кнопка просто отваливалась бы с ошибкой посередине.
          // Остаток возвращаем числом, чтобы панель сказала «нажмите ещё раз».
          const batch = trusted.slice(0, 40)
          let approved = 0
          for (const g of batch) {
            const patch = await sbFetch(aliasByNorm(db2, g.raw_name_norm), {
              method: 'PATCH',
              headers: { ...db2.headers, Prefer: 'return=minimal' },
              body: JSON.stringify({ barcode: g.proposed, status: 'approved', updated_at: new Date().toISOString() })
            })
            if (patch.ok) approved++
          }
          return json({ ok: true, approved, left: Math.max(0, trusted.length - batch.length) })
        }

        // Ошиблись кодом — строка возвращается в очередь без кода. Кассы
        // забирают только approved с непустым кодом и замещают зеркало целиком,
        // поэтому снятая привязка исчезает и у них (при следующем запуске).
        if (pathname === '/api/aliases/unbind') {
          const { id } = await request.json()
          if (!id) return json({ error: 'Нужен id' }, 400)
          const norm = await aliasNorm(db2, id)
          if (!norm.ok) return norm.res
          const patch = await sbFetch(aliasByNorm(db2, norm.value, true), {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ barcode: null, status: 'pending', updated_at: new Date().toISOString() })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }

        // Мусор из распознавания («итого», «н д с», обрывки шапки) — в
        // отклонённые, а не удалять: иначе та же касса пришлёт его снова.
        if (pathname === '/api/aliases/reject') {
          const { id } = await request.json()
          if (!id) return json({ error: 'Нужен id' }, 400)
          const norm = await aliasNorm(db2, id)
          if (!norm.ok) return norm.res
          const patch = await sbFetch(aliasByNorm(db2, norm.value), {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'rejected', updated_at: new Date().toISOString() })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }

        return json({ error: 'Неизвестный маршрут' }, 404)
      }

      if (pathname.startsWith('/api/catalog/')) {
        const db2 = sb2(env)
        // Внутримагазинный код: EAN-13 с префиксом «2». Отдаём его отдельным
        // фильтром, а не чистим скопом: в KZ этот диапазон встречается и на
        // настоящих товарах (2900094315692 — альбом, есть в НКТ), так что
        // отличить «своё, напечатанное кассой» от заводского может только
        // человек, глядя на название.
        const INTERNAL_FILTER = `&barcode=match.${encodeURIComponent('^2[0-9]{12}$')}`
        // «Изменено с» — чтобы разбирать очередь порциями по дню, а не
        // проматывать одно и то же сверху вниз.
        const sinceFilter = (v) => {
          const d = String(v || '').trim()
          return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `&updated_at=gte.${d}` : ''
        }
        if (!db2.url || !env.MONITOR_SUPABASE_SERVICE_ROLE_KEY) {
          return json({ error: 'Не заданы секреты MONITOR_SUPABASE_URL / MONITOR_SUPABASE_SERVICE_ROLE_KEY' }, 500)
        }

        if (pathname === '/api/catalog/pending') {
          // Та же экономия, что у накладных: бейджу нужно число, а не двести
          // карточек товаров на каждое открытие панели.
          const { countOnly, internalOnly, since, page } = await request.json().catch(() => ({}))
          // Страницы. Без них очередь показывала 200 самых свежих карточек, а
          // всё, что глубже, было недостижимо в принципе: разобрать хвост можно
          // было только разобрав сперва весь верх.
          const off = Math.max(0, Number(page) || 0) * 200
          const qs = countOnly
            ? 'select=barcode&status=eq.pending&limit=1'
            : `status=eq.pending&order=updated_at.desc&limit=200&offset=${off}${internalOnly ? INTERNAL_FILTER : ''}${sinceFilter(since)}`
          const r = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?${qs}`, {
            headers: { ...db2.headers, Prefer: 'count=exact' }
          })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const total = Number((r.headers.get('content-range') || '').split('/')[1])
          return json({ rows: await r.json(), total: Number.isFinite(total) ? total : null })
        }

        // Существующие категории — для подсказки при вводе. Без неё одна и та же
        // категория заводилась то «Напитки», то «напитки», то «Вода/напитки»:
        // руками попасть в уже заведённое название нечем.
        if (pathname === '/api/catalog/categories') {
          const seen = new Set()
          // Сперва функция: она делает настоящий distinct по всему справочнику.
          // Выборка строк ниже — запасной путь, пока mon_categories не выложена;
          // она берёт ПЕРВЫЕ 5000 строк, а не все категории, поэтому заведённая
          // на дальней карточке категория в подсказку не попадала.
          const rpc = await sbFetch(`${db2.url}/rest/v1/rpc/mon_categories`, {
            method: 'POST', headers: db2.headers, body: '{}'
          })
          if (rpc.ok) {
            for (const row of await rpc.json()) {
              // Функция отдаёт объекты {category}, но пустая категория внутри
              // объекта — это null, а не сам объект: без явной проверки строка
              // превращалась в «[object Object]» и попадала в подсказку.
              const c = String(typeof row === 'string' ? row : (row?.category ?? '')).trim()
              if (c) seen.add(c)
            }
            return json({ rows: [...seen].sort((a, b) => a.localeCompare(b, 'ru')) })
          }
          const r = await sbFetch(
            `${db2.url}/rest/v1/mon_barcodes?select=category&category=not.is.null&limit=5000`,
            { headers: db2.headers })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          for (const row of await r.json()) {
            const c = String(row.category || '').trim()
            if (c) seen.add(c)
          }
          return json({ rows: [...seen].sort((a, b) => a.localeCompare(b, 'ru')) })
        }

        // Разбор самих категорий: сколько карточек в каждой, чтобы видеть дубли
        // («Напитки» и «напитки») и понимать, что во что сливаешь.
        if (pathname === '/api/catalog/categoryStats') {
          const r = await sbFetch(`${db2.url}/rest/v1/rpc/mon_categories`, {
            method: 'POST', headers: db2.headers, body: '{}'
          })
          if (!r.ok) {
            return json({ error: 'Нужна функция mon_categories — выполните SQL из supabase/monitor-schema.sql' }, 502)
          }
          const rows = (await r.json()).map(x => ({ category: String(x.category ?? '').trim(), cnt: Number(x.cnt) || 0 }))
          return json({ rows: rows.filter(x => x.category) })
        }

        // Переименование категории = слияние: если такое имя уже есть, карточки
        // просто сойдутся в одну. Пустое имя очищает поле — карточки остаются,
        // пропадает только их отнесение к категории.
        if (pathname === '/api/catalog/renameCategory') {
          const { from, to } = await request.json()
          const src = String(from || '').trim()
          if (!src) return json({ error: 'Не указана категория' }, 400)
          const dst = String(to || '').trim() || null
          if (dst === src) return json({ error: 'Имя не изменилось' }, 400)
          const r = await sbFetch(
            `${db2.url}/rest/v1/mon_barcodes?category=eq.${encodeURIComponent(src)}`, {
              method: 'PATCH',
              headers: { ...db2.headers, Prefer: 'return=minimal' },
              body: JSON.stringify({ category: dst })
            })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          return json({ ok: true })
        }

        if (pathname === '/api/catalog/list') {
          const { q, page, internalOnly, since, sort } = await request.json()
          const term = String(q || '').trim()
          const per = 200
          const off = Math.max(0, Number(page) || 0) * per
          // order=barcode.asc — стабильная пагинация (updated_at «плавает»),
          // и одинаковые штрихкоды идут подряд, значит дубли схлопываются в пределах страницы.
          // По умолчанию порядок по штрихкоду: пагинация стабильна, а одинаковые
          // коды идут подряд и дубли схлопываются в пределах страницы. Сортировка
          // по дате нужна для разбора «что приехало недавно» — там дубли уже
          // могут разъехаться по страницам, это плата за свежесть сверху.
          const order = sort === 'updated' ? 'updated_at.desc'
            : sort === 'stale' ? 'updated_at.asc'   // «сначала нетронутые»: то, что правил только что, уезжает в хвост
            : 'barcode.asc'
          let qs = `status=eq.approved&order=${order}&limit=${per}&offset=${off}`
          qs += sinceFilter(since)
          if (term) qs += `&or=(barcode.ilike.*${encodeURIComponent(term)}*,name.ilike.*${encodeURIComponent(term)}*)`
          if (internalOnly) qs += INTERNAL_FILTER
          // count=estimated, а не exact: точный подсчёт по справочнику из сотен
          // тысяч строк — полный проход по таблице на КАЖДЫЙ ввод буквы в
          // поиске. Именно так запрос и повисал в «Pending». Оценки хватает:
          // число рядом со списком отвечает на «много или мало», а не на
          // «сколько ровно».
          const r = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?${qs}`, { headers: { ...db2.headers, Prefer: 'count=estimated' } })
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
          const patch = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?venue_id=eq.${encodeURIComponent(venue_id)}&barcode=eq.${encodeURIComponent(barcode)}`, {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'approved' })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }

        // Отмена одобрения: карточка возвращается в очередь. Нужна кнопке
        // «Отменить» в тосте — одобрить по ошибке легко, а искать потом эту
        // строку в каталоге из сотен тысяч записей нечем.
        if (pathname === '/api/catalog/unapprove') {
          const { venue_id, barcode } = await request.json()
          if (!venue_id || !barcode) return json({ error: 'Нужны venue_id и barcode' }, 400)
          const patch = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?venue_id=eq.${encodeURIComponent(venue_id)}&barcode=eq.${encodeURIComponent(barcode)}`, {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'pending' })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true })
        }

        if (pathname === '/api/catalog/reject' || pathname === '/api/catalog/delete') {
          const { venue_id, barcode } = await request.json()
          if (!venue_id || !barcode) return json({ error: 'Нужны venue_id и barcode' }, 400)
          const del = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?venue_id=eq.${encodeURIComponent(venue_id)}&barcode=eq.${encodeURIComponent(barcode)}`, {
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
          const patch = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?barcode=in.(${inList})`, {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=minimal' },
            body: JSON.stringify({ category: cat })
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          return json({ ok: true, count: list.length })
        }

        if (pathname === '/api/catalog/bulkDelete') {
          // Удаление выбранных карточек по штрихкоду — во всех заведениях сразу
          // (как и массовая смена категории). Нужно для разбора внутренних
          // кодов «2…»: их присылали импортом каталога десятками, а удалять по
          // одной кнопкой «отклонить» — работа на вечер.
          const { barcodes } = await request.json()
          const list = Array.isArray(barcodes) ? [...new Set(barcodes.map(b => String(b).trim()).filter(Boolean))] : []
          if (!list.length) return json({ error: 'Не выбраны штрихкоды' }, 400)
          if (list.length > 500) return json({ error: 'За раз не больше 500 штрихкодов' }, 400)
          const inList = list.map(b => encodeURIComponent('"' + b.replace(/"/g, '') + '"')).join(',')
          const del = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?barcode=in.(${inList})`, {
            method: 'DELETE',
            headers: { ...db2.headers, Prefer: 'return=minimal' }
          })
          if (!del.ok) return json({ error: `Supabase: ${del.status} ${await del.text()}` }, 502)
          return json({ ok: true, count: list.length })
        }

        if (pathname === '/api/catalog/similar') {
          // Подсказка «похожие карточки» при модерации: SQL-функция
          // mon_match_product (sql/mon_matching.sql) — сперва выученный алиас,
          // иначе топ похожих названий по триграммам.
          const { q, limit } = await request.json()
          const term = String(q || '').trim()
          if (!term) return json({ error: 'Нужен текст для поиска' }, 400)
          const r = await sbFetch(`${db2.url}/rest/v1/rpc/mon_match_product`, {
            method: 'POST',
            headers: db2.headers,
            body: JSON.stringify({ q: term, max_results: Math.max(1, Math.min(10, Number(limit) || 5)) })
          })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          return json({ rows: await r.json() })
        }

        if (pathname === '/api/catalog/upsert') {
          const { venue_id, barcode, name, category, price, unit, status } = await request.json()
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
            // По умолчанию — одобрено: руками вендор заводит уже готовую строку.
            // 'pending' приходит только от кнопки «Отменить» после отклонения:
            // карточка возвращается ровно туда, откуда её убрали, — в очередь.
            status: status === 'pending' ? 'pending' : 'approved',
            updated_at: new Date().toISOString()
          }
          const r = await sbFetch(`${db2.url}/rest/v1/mon_barcodes?on_conflict=venue_id,barcode`, {
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
          // countOnly — для красной точки в меню. Без него бейдж на КАЖДОМ
          // открытии панели тянул до сотни распознаваний целиком, вместе с
          // фотографиями накладных в base64: мегабайты трафика ради одной
          // цифры. Сами фото нужны только на открытой вкладке.
          const { countOnly } = await request.json().catch(() => ({}))
          // Двенадцать, а не сто. Каждая строка тащит ФОТО накладной в base64 —
          // сотня таких строк это десятки мегабайт, которые воркер ещё и
          // разбирает и собирает заново. На лимите памяти изолят просто
          // убивают, и браузер показывает «Failed to fetch» — причём не
          // обязательно на «Накладных»: вместе с изолятом умирают и запросы
          // соседних вкладок, отправленные в тот же момент.
          const qs = countOnly
            ? 'select=id&reviewed_at=is.null&limit=1'
            : 'reviewed_at=is.null&order=created_at.desc&limit=12'
          const r = await sbFetch(`${db2.url}/rest/v1/mon_ai_invoices?${qs}`, {
            headers: { ...db2.headers, Prefer: 'count=exact' }
          })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const total = Number((r.headers.get('content-range') || '').split('/')[1])
          const rows = await r.json()
          // Кнопка «Привязать коды» и пометки у строк. Помечаем КАЖДУЮ строку:
          // без этого непонятно, почему кнопка обещает меньше кодов, чем видно
          // на фотографии, и грешат на панель.
          if (!countOnly) {
            const pairs = rows.map(row => invoiceCodePairs(row.items))
            const waiting = await pendingNorms(db2, [...new Set(pairs.flat().flatMap(p => p.keys))])
            const isWaiting = (keys) => !waiting || keys.some(k => waiting.has(k))
            rows.forEach((row, i) => {
              row.code_count = pairs[i].filter(p => isWaiting(p.keys)).length
              // Сколько кодов в накладной вообще. Нужно, чтобы отличить
              // «работа сделана» от «читаемых кодов тут нет»: без этого
              // карточка молча остаётся без кнопки, и непонятно, что произошло.
              row.code_total = pairs[i].length
              const live = new Set(pairs[i].filter(p => isWaiting(p.keys)).map(p => p.barcode))
              for (const it of row.items || []) {
                const c = invoiceItemCode(it)
                it.code = c.barcode
                // Код есть, но привязывать нечего: магазин этот товар уже знает
                // либо написание разобрано раньше.
                it.code_done = !!c.barcode && !live.has(c.barcode)
                it.code_bad = c.barcode ? null : c.found
              }
            })
          }
          return json({ rows, total: Number.isFinite(total) ? total : null })
        }

        // Привязать коды прямо из накладной. Результат тот же, что от ручного
        // ввода в «Названиях», только без переписывания цифр с фотографии:
        // распознавание их уже прочитало, а очередь написаний ждёт именно их.
        if (pathname === '/api/invoices/bindCodes') {
          const { id } = await request.json()
          if (!id) return json({ error: 'Нужен id' }, 400)
          const r = await sbFetch(
            `${db2.url}/rest/v1/mon_ai_invoices?id=eq.${encodeURIComponent(id)}&select=items`,
            { headers: db2.headers })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const [row] = await r.json()
          if (!row) return json({ error: 'Накладная не найдена' }, 404)
          const pairs = invoiceCodePairs(row.items)
          // Не больше 40 за вызов: у каждого написания свой код, одним PATCH их
          // не привязать, а воркеру на бесплатном тарифе положено 50 внешних
          // подзапросов — остаток возвращаем числом, панель попросит нажать ещё.
          const batch = pairs.slice(0, 40)
          let bound = 0, names = 0
          for (const p of batch) {
            const patch = await sbFetch(aliasByNorms(db2, p.keys) + '&select=id', {
              method: 'PATCH',
              headers: { ...db2.headers, Prefer: 'return=representation' },
              body: JSON.stringify({
                barcode: p.barcode, status: 'approved', updated_at: new Date().toISOString(),
              }),
            })
            if (!patch.ok) continue
            const hit = await patch.json().catch(() => [])
            if (hit.length) { names++; bound += hit.length }
          }
          return json({ ok: true, codes: pairs.length, names, bound, left: Math.max(0, pairs.length - batch.length) })
        }

        // Один код на одну строку накладной — руками. Нужен там, где
        // распознавание ошиблось в цифре: владелец видит бумагу, панель нет.
        // Контрольную сумму здесь НЕ требуем (человек уже сверился с бумагой),
        // но говорим о ней в ответе: молча привязанный «не сходящийся» код —
        // это чужой товар во всех магазинах, и знать об этом надо.
        //
        // Название берём из накладной по номеру строки, а не из запроса: по
        // нему решение уедет на все точки с этим написанием.
        if (pathname === '/api/invoices/bindOne') {
          const { id, index, barcode } = await request.json()
          const bc = String(barcode || '').trim()
          if (!id || !Number.isInteger(index) || !/^\d{8,14}$/.test(bc)) {
            return json({ error: 'Нужны накладная, номер строки и штрихкод из 8–14 цифр' }, 400)
          }
          const r = await sbFetch(
            `${db2.url}/rest/v1/mon_ai_invoices?id=eq.${encodeURIComponent(id)}&select=items`,
            { headers: db2.headers })
          if (!r.ok) return json({ error: `Supabase: ${r.status} ${await r.text()}` }, 502)
          const [row] = await r.json()
          const it = (row?.items || [])[index]
          if (!it) return json({ error: 'Строка накладной не найдена' }, 404)
          const keys = itemKeys(it)
          if (!keys.length) return json({ error: 'У строки нет пригодного названия' }, 400)
          const patch = await sbFetch(aliasByNorms(db2, keys) + '&select=id', {
            method: 'PATCH',
            headers: { ...db2.headers, Prefer: 'return=representation' },
            body: JSON.stringify({
              barcode: bc, status: 'approved', updated_at: new Date().toISOString(),
            }),
          })
          if (!patch.ok) return json({ error: `Supabase: ${patch.status} ${await patch.text()}` }, 502)
          const hit = await patch.json().catch(() => [])
          return json({
            ok: true, bound: hit.length,
            checksum: validBarcode(bc),
            // Пусто — значит написания в очереди нет: его уже разобрали, и
            // менять код надо осознанно, во вкладке «Названия».
            note: hit.length ? null : 'В очереди этого написания нет — код уже привязан. Поменять его можно в «Названиях» → «Привязанные».',
          })
        }

        if (pathname === '/api/invoices/review') {
          const { id } = await request.json()
          if (!id) return json({ error: 'Нужен id' }, 400)
          // «Разобрано»: ставим reviewed_at и стираем фото (image_b64=null);
          // распознанный JSON остаётся навсегда.
          const patch = await sbFetch(`${db2.url}/rest/v1/mon_ai_invoices?id=eq.${encodeURIComponent(id)}`, {
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
          const del = await sbFetch(`${db2.url}/rest/v1/mon_ai_invoices?id=eq.${encodeURIComponent(id)}`, {
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
      // Истёкшее ожидание надо называть своим именем: «Pending» в браузере не
      // объясняет ничего, а причина почти всегда одна — уснувший бесплатный
      // проект Supabase, который просыпается от первого же запроса.
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        return json({ error: 'Supabase не ответил за 15 секунд. Похоже, проект заснул (бесплатный тариф) — откройте его в дашборде Supabase и повторите.' }, 504)
      }
      return json({ error: String(e?.message ?? e) }, 500)
    }
  }
}
