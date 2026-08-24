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

// Под каким НАЗВАНИЕМ этот код лежит в общем справочнике. Без этого строка
// «магазины уже привязали 4870…» — просто цифры: согласиться с ними можно,
// только убедившись, что за кодом тот же товар, а не сосед по полке. Если
// точки записали код под разными названиями, это тоже видно — и это первый
// признак, что соглашаться не надо.
//
// Спрашиваем пачками по 150 кодов и не больше шести пачек: список уходит в
// адресную строку, а подзапросов у воркера считаное число. Не вышло — вернём
// null, карточка просто не покажет названия.
async function catalogNames(db2, codes) {
  const out = new Map()
  for (let i = 0; i < codes.length && i < 900; i += 150) {
    const r = await sbFetch(
      `${db2.url}/rest/v1/mon_barcodes?select=barcode,name&status=eq.approved&barcode=in.(`
      + codes.slice(i, i + 150).join(',') + ')&limit=1000',
      { headers: db2.headers })
    if (!r.ok) return null
    for (const row of await r.json().catch(() => [])) {
      const list = out.get(row.barcode) ?? []
      const name = String(row.name ?? '').trim()
      if (name && !list.includes(name)) list.push(name)
      out.set(row.barcode, list)
    }
  }
  return out
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
const aliasByNorms = (db2, norms, anyStatus = false) =>
  `${db2.url}/rest/v1/mon_invoice_aliases?raw_name_norm=in.(`
  + norms.map(n => '"' + encodeURIComponent(n) + '"').join(',')
  + ')' + (anyStatus ? '' : '&status=eq.pending')

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
  const map = await normStatuses(db2, keys)
  if (!map) return null
  return new Set([...map].filter(([, st]) => st === 'pending').map(([n]) => n))
}

/**
 * В каком состоянии написание в словаре: pending / approved / rejected — или
 * его там нет вовсе.
 *
 * Раньше спрашивали только про pending, и «не ждёт очереди» панель выдавала за
 * «уже привязано». Разница существенная: привязано — работа сделана; НЕ БЫЛО В
 * СЛОВАРЕ — работы не делал никто, и вендор ищет её результат во вкладке
 * «Названия», где ничего нет. Ровно так и вышло 24.08.2026.
 */
async function normStatuses(db2, keys) {
  const out = new Map()
  for (let i = 0; i < keys.length && i < 600; i += 120) {
    const r = await sbFetch(
      aliasByNorms(db2, keys.slice(i, i + 120), true) + '&select=raw_name_norm,status',
      { headers: db2.headers })
    if (!r.ok) return null
    for (const row of await r.json().catch(() => [])) {
      // Одно написание может лежать строкой на каждое заведение. Ждущая важнее:
      // пока хоть где-то ждёт, кнопка обязана её привязать.
      const prev = out.get(row.raw_name_norm)
      if (prev !== 'pending') out.set(row.raw_name_norm, row.status)
    }
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

// ── Модели распознавания ───────────────────────────────────────────────────
// Список НЕ хранится здесь: его отдаёт сама edge-функция, собирая из ключей,
// которые лежат у неё в секретах. Положил ключ нового провайдера — его модели
// появились в панели сами. Хранить копию списка тут значило бы, что панель
// предлагает то, чего функция вызвать не умеет.
const FN_URL = 'https://stdlphhidxzgtrzbcwhx.supabase.co/functions/v1/parse-invoice'
// Функция лицензий. Её служебный ответ на GET — единственный способ увидеть
// СНАРУЖИ, есть ли в облаке ключ подписи. Однажды его там не оказалось, и
// узналось это от клиентов: активация выдавала файл, который касса не может
// проверить, и та писала «повреждён или подделан».
const LIC_FN_URL = 'https://uvuzotcilselezjwrpmb.supabase.co/functions/v1/status'

// Денег от себя не выдумываем. Цена за миллион токенов — опубликованный
// прайс провайдера, он приходит вместе со списком моделей. А сколько стоила
// накладная, считается ТОЛЬКО по фактически потраченным токенам, записанным
// функцией. Нет записей — так и говорим: данных нет.
export const modelCost = (m, inTok, outTok) =>
  ((inTok || 0) / 1e6 * (m?.in ?? 0)) + ((outTok || 0) / 1e6 * (m?.out ?? 0))

// Функция отвечает на GET версией и списком моделей. Секретов там нет —
// только имена провайдеров, у которых нашёлся ключ.
async function fnModels() {
  try {
    const r = await sbFetch(FN_URL, { headers: { accept: 'application/json' } })
    if (!r.ok) return null
    const d = await r.json()
    return Array.isArray(d?.models) && d.models.length ? d : null
  } catch { return null }
}

// Фактический расход за период — Usage & Cost API Anthropic. Нужен АДМИНСКИЙ
// ключ организации, это не тот ключ, что распознаёт накладные. Нет ключа —
// функция вернёт null, и панель покажет оценку по числу распознаваний.
//
// Баланса в API нет вовсе (у Anthropic нет такого эндпоинта), поэтому
// «осталось» считается от бюджета, который вендор задаёт сам.
export async function anthropicCost(env, fromIso, toIso) {
  const key = env.ANTHROPIC_ADMIN_KEY
  if (!key) return null
  try {
    let usd = 0, page = null, guard = 0
    do {
      // limit=31: по умолчанию отчёт отдаёт СЕМЬ суточных корзин, то есть за
      // месяц вернулась бы первая неделя и счёт вышел бы втрое меньше.
      const url = 'https://api.anthropic.com/v1/organizations/cost_report'
        + `?starting_at=${fromIso}T00:00:00Z&ending_at=${toIso}T23:59:59Z&limit=31`
        + (page ? `&page=${encodeURIComponent(page)}` : '')
      const r = await sbFetch(url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })
      const text = await r.text()
      if (!r.ok) {
        // Отдельный случай: у ЛИЧНОГО аккаунта Admin API нет вовсе, ключ там не
        // создать — нужна организация. Голый 401 этого не объясняет.
        if (r.status === 401 || r.status === 403) {
          return { error: 'ключ не принят. Admin API есть только у организации, у личного аккаунта его нет' }
        }
        return { error: `${r.status} ${text.slice(0, 160)}` }
      }
      const d = JSON.parse(text)
      // Суммы приходят строками В ЦЕНТАХ («costs in USD, reported in lowest
      // units»). Считать их долларами значило бы завысить счёт в сто раз.
      for (const bucket of d?.data ?? []) {
        for (const item of bucket?.results ?? []) {
          const n = Number(item?.amount)
          if (Number.isFinite(n)) usd += n / 100
        }
      }
      page = d?.has_more ? d?.next_page : null
    } while (page && ++guard < 5)
    return { usd }
  } catch (e) {
    return { error: String(e).slice(0, 160) }
  }
}

// Качество модели считается по самой накладной, без ручной разметки: она
// проверяет себя трижды — количество × цена даёт сумму строки, сумма строк даёт
// напечатанный итог, а у штрихкода есть контрольная цифра. Три доли и есть
// ответ на вопрос «какую модель держать».
// Имя модели без провайдера. В базе лежат обе формы: старые распознавания
// записаны как «claude-sonnet-5», новые — как «anthropic:claude-sonnet-5».
// Сравнивать их как есть значит потерять всю прежнюю статистику.
export const bareModel = (v) => {
  const s = String(v ?? '')
  const i = s.indexOf(':')
  return i < 0 ? s : s.slice(i + 1)
}

export function modelStats(rows) {
  const by = new Map()
  const num = (v) => Number(String(v ?? '').replace(',', '.')) || 0
  for (const r of rows || []) {
    const id = bareModel(r.model || '—')
    const st = by.get(id) ?? { model: id, invoices: 0, lines: 0, sumOk: 0, sumAll: 0, codeOk: 0, codeAll: 0, totalOk: 0, totalAll: 0, tokIn: 0, tokOut: 0, paid: 0 }
    st.invoices++
    // paid — на скольких накладных расход записан. Старые распознавания его не
    // имеют, и делить на общее число накладных нельзя: получится цена ниже
    // настоящей, а выдуманные цены хуже отсутствующих.
    if (r.in_tokens != null || r.out_tokens != null) {
      st.paid++
      st.tokIn += Number(r.in_tokens) || 0
      st.tokOut += Number(r.out_tokens) || 0
    }
    let lineSum = 0
    for (const it of r.items || []) {
      st.lines++
      const mult = num(it.quantity ?? it.qty) * num(it.price)
      const printed = num(it.line_total)
      lineSum += printed || mult
      if (printed > 0) { st.sumAll++; if (Math.abs(printed - mult) <= 1) st.sumOk++ }
      const c = invoiceItemCode(it)
      if (c.found) { st.codeAll++; if (c.barcode) st.codeOk++ }
    }
    const declared = num(r.declared_total)
    if (declared > 0 && lineSum > 0) { st.totalAll++; if (Math.abs(declared - lineSum) <= 1) st.totalOk++ }
    by.set(id, st)
  }
  const pct = (ok, all) => (all ? Math.round(ok * 100 / all) : null)
  return [...by.values()]
    .map(s => ({ ...s, sumPct: pct(s.sumOk, s.sumAll), codePct: pct(s.codeOk, s.codeAll), totalPct: pct(s.totalOk, s.totalAll) }))
    .sort((a, b) => b.invoices - a.invoices)
}

// Коды, отличающиеся от прочитанного ОДНОЙ цифрой и проходящие контрольную
// сумму. Ошибка распознавания почти всегда такая: «6» вместо «0», «9» вместо
// «7». Из 117 замен контрольную проходит десяток, а дальше отсеет справочник —
// настоящий товар останется один. Это подсказка, а не привязка: решает человек.
export function oneDigitFixes(code) {
  const s = String(code ?? '').trim()
  if (!/^\d{8,14}$/.test(s)) return []
  const out = []
  for (let i = 0; i < s.length; i++) {
    for (let d = 0; d < 10; d++) {
      if (Number(s[i]) === d) continue
      const cand = s.slice(0, i) + d + s.slice(i + 1)
      if (validBarcode(cand)) out.push(cand)
    }
  }
  return out
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
  const all = [...by.values()]
  const dup = dupBarcodes(all)
  // Один код у нескольких написаний одной накладной — случай двусмысленный, и
  // РЕШАТЬ ЗА ВЕНДОРА тут нельзя.
  //
  // Иногда это ошибка распознавания: колонка штрихкодов на фото узкая, ИИ
  // протягивает первое значение вниз по столбцу — так пять разных напитков
  // получили один код. Привяжи их скопом, и общий словарь сломается у всех
  // касс сразу.
  //
  // А иногда это правда: «Сары-Агаш … 1,0 л» и «БОНУС! Сары-Аг … 1,0 л *6шт» —
  // один товар двумя строками, и одинаковый код у них законный. Отличить одно
  // от другого по названиям нельзя: «Мохито Lime & Mint 0,45» и «Мохито
  // Strawberry Lime & Mint 0,5» похожи сильнее, чем эта пара.
  //
  // Поэтому массовая кнопка их не берёт (там нельзя ошибиться молча), а
  // поштучно вендор привязывает через правку строки — глядя на фотографию.
  return all.filter(p => !dup.has(p.barcode))
}

/** Штрихкоды, которые в одной накладной достались разным написаниям. */
export function dupBarcodes(pairs) {
  const names = new Map()
  for (const p of pairs) {
    if (!names.has(p.barcode)) names.set(p.barcode, new Set())
    names.get(p.barcode).add(p.keys.join('|'))
  }
  return new Set([...names].filter(([, n]) => n.size > 1).map(([code]) => code))
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

// ── Push-уведомления вендору ───────────────────────────────────────────
// Панель ставится на телефон как приложение (манифест + service worker) и
// получает push: касса сообщила о поломке, пришла заявка, кончается лицензия.
// Раньше про аварию владелец узнавал звонком клиента — данные в панели были,
// но звать они не звали.
//
// Web Push сделан руками, без библиотек: в «Advanced mode» Pages воркер —
// один файл без сборщика, npm-зависимость сюда просто не попадёт. Всё, что
// нужно (ECDSA, ECDH, HKDF, AES-GCM), есть в Web Crypto.

export const b64u = {
  enc: (buf) => {
    const b = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec: (s) => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(t + '='.repeat((4 - t.length % 4) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  },
}

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// Пара ключей VAPID. Генерируется при первой подписке и лежит в push_state —
// это НЕ секрет в смысле «положи в настройки Cloudflare»: заводить руками
// ещё один секрет значит ещё один шаг, на котором всё встанет. Приватная
// часть не выходит за пределы воркера и Supabase, доступного только по
// service-role ключу.
export async function vapidKeys(db) {
  const r = await sbFetch(`${db.url}/rest/v1/push_state?key=eq.vapid&select=value`, { headers: db.headers })
  if (!r.ok) throw new Error('Нет таблицы push_state — выполните SQL из license-server/supabase/schema.sql')
  const rows = await r.json()
  if (rows[0]?.value?.pub) return rows[0].value
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const keys = {
    priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
    pub: b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)),
  }
  const w = await sbFetch(`${db.url}/rest/v1/push_state`, {
    method: 'POST',
    headers: { ...db.headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key: 'vapid', value: keys }),
  })
  if (!w.ok) throw new Error('Не удалось сохранить ключи push: ' + await w.text())
  return keys
}

// Подпись VAPID: JWT ES256 на адрес push-службы. Живёт 12 часов — служба
// отвергает токены со сроком больше суток.
async function vapidJwt(keys, audience, subject) {
  const te = new TextEncoder()
  const part = (o) => b64u.enc(te.encode(JSON.stringify(o)))
  const head = part({ typ: 'JWT', alg: 'ES256' })
  const body = part({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })
  const key = await crypto.subtle.importKey('jwk', keys.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(head + '.' + body))
  return `${head}.${body}.${b64u.enc(sig)}`
}

// Шифрование тела по RFC 8291 (aes128gcm). Push-служба содержимое не видит:
// ключ выводится из открытого ключа браузера и секрета подписки.
export async function encryptPush(text, p256dh, auth) {
  const ua = b64u.dec(p256dh)
  const authSecret = b64u.dec(auth)
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256))

  const hkdf = async (salt, ikm, info, len) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8))
  }
  const te = new TextEncoder()
  const ikm = await hkdf(authSecret, shared, cat(te.encode('WebPush: info\0'), ua, asPub), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 0x02 — признак последней записи (padding delimiter): запись всегда одна.
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aes, cat(te.encode(text), new Uint8Array([2]))))
  const head = new Uint8Array(21)
  head.set(salt, 0)
  new DataView(head.buffer).setUint32(16, 4096)   // размер записи
  head[20] = asPub.length                          // длина открытого ключа отправителя
  return cat(head, asPub, ct)
}

// Один пуш одной подписке. Возвращает HTTP-код службы: 404/410 значит, что
// подписка мертва (приложение удалили) — такую надо вычистить.
export async function pushOne(sub, payload, keys, subject) {
  const body = await encryptPush(JSON.stringify(payload), sub.p256dh, sub.auth)
  const jwt = await vapidJwt(keys, new URL(sub.endpoint).origin, subject)
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${keys.pub}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  return r.status
}

// Разослать всем подпискам. Мёртвые (404/410) удаляем сразу: иначе список
// растёт переустановками приложения, и каждая проверка стучится в никуда.
export async function pushAll(env, db, payload) {
  const list = Array.isArray(payload) ? payload : [payload]
  const keys = await vapidKeys(db)
  const r = await sbFetch(`${db.url}/rest/v1/push_subs?select=endpoint,p256dh,auth`, { headers: db.headers })
  if (!r.ok) throw new Error('Нет таблицы push_subs — выполните SQL из license-server/supabase/schema.sql')
  const subs = await r.json()
  const subject = env.VAPID_SUBJECT || 'https://imag-license-panel.pages.dev'
  const dead = []
  let sent = 0
  for (const s of subs) {
    for (const p of list) {
      let code = 0
      try { code = await pushOne(s, p, keys, subject) } catch { code = 0 }
      if (code === 404 || code === 410) { dead.push(s.endpoint); break }
      if (code >= 200 && code < 300) sent++
    }
  }
  for (const e of dead) {
    await sbFetch(`${db.url}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(e)}`,
      { method: 'DELETE', headers: db.headers }).catch(() => {})
  }
  return { subs: subs.length, sent, dead: dead.length }
}

// О чём вообще стоит будить телефон. Всё остальное (каталог, накладные,
// названия) — работа в очереди, она подождёт до утра.
export const EXPIRE_SOON_DAYS = 3

export function pushEvents({ licenses = [], requests = [] }, now = Date.now()) {
  const out = []
  const day = 86400000
  for (const l of licenses) {
    // Касса сама сказала «мне плохо». Ключ включает время SOS: второй сигнал
    // от той же кассы — это новая авария, а не повтор старой.
    if (l.last_sos_at && now - new Date(l.last_sos_at).getTime() < day) {
      const why = l.last_sos?.status || l.last_sos?.reason || 'не запускается'
      out.push({
        key: `sos:${l.id}:${l.last_sos_at}`,
        title: 'Касса не работает',
        body: `${l.customer || l.machine_id || l.id}: ${why}`,
        tag: 'sos',
        url: '/#/clients/' + encodeURIComponent(l.id),
      })
    }
    if (!l.revoked && !l.hidden && l.expires_at) {
      const left = Math.ceil((new Date(l.expires_at).getTime() - now) / day)
      if (left >= 0 && left <= EXPIRE_SOON_DAYS) {
        out.push({
          key: `exp:${l.id}:${l.expires_at}`,
          title: 'Заканчивается подписка',
          body: `${l.customer || l.id}: ${left <= 0 ? 'сегодня последний день' : 'осталось ' + left + ' дн'}`,
          tag: 'expire',
          url: '/#/clients/' + encodeURIComponent(l.id),
        })
      }
    }
  }
  for (const r of requests) {
    out.push({
      key: `req:${r.machine_id}`,
      title: 'Заявка на активацию',
      body: [r.shop, r.city_raw].filter(Boolean).join(', ') || r.machine_id || 'без имени',
      tag: 'request',
      url: '/#/requests',
    })
  }
  return out
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

    // Проверка событий: дёргает cron-воркер (imag-keepalive) раз в четверть
    // часа. Пароля не просит — как и /api/keepalive: данных наружу не отдаёт,
    // а разослать одно и то же дважды не может: ключ события пишется в
    // push_state с resolution=ignore-duplicates, и повторный вызов получает
    // в ответ пустой список «новых».
    if (pathname === '/api/push/check') {
      const db = sb(env)
      if (!db.url || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, error: 'нет ключей Supabase' }, 500)
      try {
        // Ни одной подписки — дальше можно не ходить: некому слать.
        const head = await sbFetch(`${db.url}/rest/v1/push_subs?select=endpoint&limit=1`, { headers: db.headers })
        if (!head.ok) return json({ ok: false, error: 'нет таблицы push_subs — не выполнен SQL' })
        if ((await head.json()).length === 0) return json({ ok: true, subs: 0, events: 0 })

        const day = 86400000
        const since = new Date(Date.now() - day).toISOString()
        const soon = new Date(Date.now() + EXPIRE_SOON_DAYS * day).toISOString()
        const LIC = 'id,customer,machine_id,expires_at,revoked,hidden'
        const get = async (q) => { const r = await sbFetch(`${db.url}/rest/v1/${q}`, { headers: db.headers }); return r.ok ? r.json() : [] }
        const [expiring, sos, reqs] = await Promise.all([
          get(`licenses?select=${LIC}&revoked=is.false&expires_at=lte.${soon}&limit=200`),
          // Колонок SOS может ещё не быть — тогда просто пусто, а не 502.
          get(`licenses?select=${LIC},last_sos,last_sos_at&last_sos_at=gte.${since}&limit=200`),
          get('activation_requests?select=machine_id,shop,city_raw&status=eq.pending&limit=100'),
        ])
        // Одна касса может попасть в оба списка — иначе pushEvents прошёл бы
        // по ней дважды и выдал одинаковые ключи.
        const byId = new Map()
        for (const l of [...expiring, ...sos]) byId.set(l.id, { ...byId.get(l.id), ...l })
        const events = pushEvents({ licenses: [...byId.values()], requests: reqs })
        if (!events.length) return json({ ok: true, events: 0 })

        // Заявка на «это событие моё»: строки, которые вернулись, до нас никто
        // не вставлял — про них и уведомляем. Уже существующие PostgREST
        // молча пропускает.
        const claim = await sbFetch(`${db.url}/rest/v1/push_state`, {
          method: 'POST',
          headers: { ...db.headers, Prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify(events.map(e => ({ key: e.key, value: {} }))),
        })
        const freshKeys = new Set((claim.ok ? await claim.json() : []).map(r => r.key))
        const fresh = events.filter(e => freshKeys.has(e.key))
        if (!fresh.length) return json({ ok: true, events: events.length, fresh: 0, sent: 0 })

        // Первая проверка после установки поднимет разом всю накопившуюся
        // очередь. Пять уведомлений подряд человек смахнёт не читая — сводим
        // в одно, а разбираться он пойдёт в панель.
        const payloads = fresh.length > 3
          ? [{ title: 'iMag: ' + fresh.length + ' событий', body: fresh.slice(0, 3).map(e => e.body).join('; ') + '…', tag: 'digest', url: '/' }]
          : fresh.map(e => ({ title: e.title, body: e.body, tag: e.tag, url: e.url }))
        const res = await pushAll(env, db, payloads)
        return json({ ok: true, events: events.length, fresh: fresh.length, ...res })
      } catch (e) {
        return json({ ok: false, error: String(e).slice(0, 200) }, 200)
      }
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
        // last_log здесь НЕТ намеренно: это до 30 КБ текста на клиента, и список
        // тащил бы их все при каждом обновлении панели ради строчки «получен
        // тогда-то». Сам журнал забирается по одному, когда его раскрывают
        // (/api/client/log). last_log_at остаётся — по нему считается, пришёл
        // ли ответ на запрос.
        const LIC_OPT = ['contact', 'hidden', 'price', 'snoozed_until', 'city',
          'last_sos', 'last_sos_at', 'log_requested_at', 'last_log_at']
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
        // Какие колонки пришлось выбросить — НЕ молча. Панель отступала тихо, и
        // отсутствующая колонка выглядела как «данных нет»: журнал кассы вечно
        // «запрошен», хотя сохранять его просто некуда. Вендор в этом случае
        // должен видеть причину у себя, а не искать её в Supabase.
        let missingCols = []
        for (let n = LIC_OPT.length - 1; n >= 0 && !licR.ok; n--) {
          missingCols = LIC_OPT.slice(n)
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
        return json({ licenses, trials, missingCols, kaspiPhone: (env.OWNER_KASPI_PHONE || '').trim() })
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
      // Здоровье облака лицензий: подписывает ли оно вообще. Секретов ответ не
      // содержит — только «ok/missing» и номер версии функции.
      // ── Push: подписка этого браузера ────────────────────────────────
      // Открытый ключ VAPID: браузер обязан передать его в subscribe().
      if (pathname === '/api/push/key') {
        return json({ key: (await vapidKeys(db)).pub })
      }

      // Подписка идемпотентна: панель переподписывается при каждом открытии,
      // потому что браузер может обновить endpoint сам и молча.
      if (pathname === '/api/push/subscribe') {
        const b = await request.json().catch(() => ({}))
        const s = b.sub || b
        const keys = s.keys || {}
        if (!s.endpoint || !keys.p256dh || !keys.auth) return json({ error: 'Подписка неполная' }, 400)
        const r = await sbFetch(`${db.url}/rest/v1/push_subs`, {
          method: 'POST',
          headers: { ...db.headers, Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify({
            endpoint: s.endpoint, p256dh: keys.p256dh, auth: keys.auth,
            label: b.label || null, failed_at: null,
          }),
        })
        if (!r.ok) return json({ error: 'Нет таблицы push_subs — выполните SQL из license-server/supabase/schema.sql' }, 502)
        return json({ ok: true })
      }

      if (pathname === '/api/push/unsubscribe') {
        const { endpoint } = await request.json().catch(() => ({}))
        if (!endpoint) return json({ error: 'Не указан endpoint' }, 400)
        await sbFetch(`${db.url}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`,
          { method: 'DELETE', headers: db.headers })
        return json({ ok: true })
      }

      // Проверочное уведомление. Без него «подписался» — это просто надпись:
      // разрешение выдано, а дойдёт ли до телефона, выяснялось бы аварией.
      if (pathname === '/api/push/test') {
        try {
          const res = await pushAll(env, db, {
            title: 'iMag', body: 'Уведомления работают', tag: 'test', url: '/',
          })
          return json(res)
        } catch (e) {
          return json({ error: String(e.message || e) }, 502)
        }
      }

      // Журнал одной кассы. Отдельно от списка клиентов: там он тянулся бы у
      // всех сразу и на каждое обновление панели.
      if (pathname === '/api/client/log') {
        const { id } = await request.json().catch(() => ({}))
        if (!id) return json({ error: 'Не указан клиент' }, 400)
        const r = await sbFetch(
          `${db.url}/rest/v1/licenses?select=last_log,last_log_at&id=eq.${encodeURIComponent(id)}`,
          { headers: db.headers })
        if (!r.ok) return json({ error: 'Журнал недоступен: ' + await r.text() }, 502)
        const row = (await r.json())[0] || {}
        return json({ text: row.last_log ?? null, at: row.last_log_at ?? null })
      }

      if (pathname === '/api/health') {
        try {
          const r = await sbFetch(LIC_FN_URL, { headers: { accept: 'application/json' } })
          if (!r.ok) return json({ ok: false, error: `функция лицензий: ${r.status}` })
          const d = await r.json()
          // Заодно считаем кассы, которые сами сообщили о беде за последнюю
          // неделю. Один дешёвый запрос на оба сигнала: бейдж в меню зовёт
          // владельца, а не ждёт, пока он откроет нужную карточку.
          // Кассы, которые сообщили о беде и ЕЩЁ НЕ вылечились. Считать по одному
          // last_sos_at нельзя: метка не гаснет, и починенный клиент неделю
          // держал бы красную точку. Приученный к вечно красному бейджу вендор
          // перестаёт его читать — это хуже, чем его отсутствие.
          //
          // Признак выздоровления — «связь» новее SOS. last_seen_at ставит
          // только ЗДОРОВЫЙ звонок кассы (у сломанной нет id лицензии, и
          // функция выходит раньше этой отметки), так что сравнение честное.
          const countUnresolvedSos = async (days) => {
            try {
              const since = new Date(Date.now() - days * 86400000).toISOString()
              const r2 = await sbFetch(
                `${db.url}/rest/v1/licenses?select=id,last_sos_at,last_seen_at&last_sos_at=gte.${since}&limit=500`,
                { headers: db.headers })
              if (!r2.ok) return 0
              const rows = await r2.json()
              return rows.filter(x => !x.last_seen_at
                || new Date(x.last_seen_at) < new Date(x.last_sos_at)).length
            } catch { return 0 }   // колонок ещё нет — просто ноль
          }
          const sos = await countUnresolvedSos(7)
          return json({
            ok: !!d?.ok,
            signing_key: d?.signing_key ?? null,
            table_licenses: d?.table_licenses ?? null,
            version: d?.version ?? null,
            sos,
          })
        } catch (e) {
          return json({ ok: false, error: `функция лицензий не ответила: ${String(e).slice(0, 120)}` })
        }
      }

      // «Запросить лог с кассы»: ставим метку, кассе её передаст функция
      // status при следующем выходе на связь (want_log), и та дошлёт журнал.
      // Молчание дольше 15–20 минут — тоже ответ: у кассы нет интернета,
      // и проблема не в лицензии.
      if (pathname === '/api/requestLog') {
        const { id } = await request.json()
        if (!id) return json({ error: 'Нужен id лицензии' }, 400)
        const r = await sbFetch(`${db.url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...db.headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ log_requested_at: new Date().toISOString() }),
        })
        if (!r.ok) return json({ error: await sqlHint(r, ['log_requested_at']) }, 502)
        return json({ ok: true })
      }

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
          const names = await catalogNames(db2,
            [...new Set(rows.map(g => g.barcode || g.proposed).filter(Boolean))])
          if (names) for (const g of rows) {
            const code = g.barcode || g.proposed
            // Пустой массив и null — разные вещи: «кода в справочнике нет» и
            // «спросить не удалось». Во втором случае карточка молчит.
            if (code) g.code_names = names.get(code) ?? []
          }
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
          const { countOnly, reviewed } = await request.json().catch(() => ({}))
          // Двенадцать, а не сто. Каждая строка тащит ФОТО накладной в base64 —
          // сотня таких строк это десятки мегабайт, которые воркер ещё и
          // разбирает и собирает заново. На лимите памяти изолят просто
          // убивают, и браузер показывает «Failed to fetch» — причём не
          // обязательно на «Накладных»: вместе с изолятом умирают и запросы
          // соседних вкладок, отправленные в тот же момент.
          // «Разобранные» — те же накладные, но уже без фотографий (их стирает
          // кнопка «Разобрано»). Нужны, когда выяснилось, что код привязан не
          // тот: распознанный текст остаётся навсегда, а вернуться к нему было
          // нечем — карточка исчезала из списка насовсем.
          const qs = countOnly
            ? 'select=id&reviewed_at=is.null&limit=1'
            : reviewed
              ? 'reviewed_at=not.is.null&order=reviewed_at.desc&limit=12'
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
            // Считаем повторы по ИСХОДНОМУ набору: invoiceCodePairs их уже
            // выбросил, и по его результату они не видны.
            const dups = rows.map(row => dupBarcodes((row.items || [])
              .map(it => ({ barcode: invoiceItemCode(it).barcode, keys: itemKeys(it) }))
              .filter(p => p.barcode && p.keys.length)))
            // Состояние КАЖДОГО написания, а не только «ждёт ли». Иначе строка
            // «этого написания нет в словаре» и строка «привязано» выглядят
            // одинаково серыми, и вендор ищет во вкладке «Названия» работу,
            // которой никто не делал.
            const allKeys = [...new Set(rows.flatMap(r2 => (r2.items || []).flatMap(itemKeys)))]
            const st = await normStatuses(db2, allKeys)
            const waiting = st && new Set([...st].filter(([, v]) => v === 'pending').map(([n]) => n))
            const isWaiting = (keys) => !waiting || keys.some(k => waiting.has(k))
            const known = (keys) => !st ? null : keys.some(k => st.has(k))
            rows.forEach((row, i) => {
              const dup = dups[i]
              row.code_dup_count = dup.size
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
                // Тот же код у другого товара этой накладной — ошибка чтения,
                // а не совпадение. Показываем словами, иначе строка выглядит
                // как «уже привязано» и вендор о ней не узнает.
                it.code_dup = !!c.barcode && dup.has(c.barcode)
                // Есть ли это написание в словаре вообще. null — спросить не
                // удалось (словарь недоступен), и врать в обе стороны нельзя.
                it.name_known = known(itemKeys(it))
              }
            })

            // Подсказка вместо красного кода: чем он МОГ быть. Перебираем
            // замены одной цифры и оставляем те, что нашлись в справочнике, —
            // случайное совпадение там почти невозможно, а сверять тринадцать
            // цифр с бумагой глазами приходилось на каждой строке.
            const bad = [...new Set(rows.flatMap(row =>
              (row.items || []).map(it => it.code_bad).filter(Boolean)))]
            if (bad.length) {
              const fixes = new Map(bad.map(b => [b, oneDigitFixes(b)]))
              const known = await catalogNames(db2, [...new Set([...fixes.values()].flat())])
              if (known) for (const row of rows) for (const it of row.items || []) {
                if (!it.code_bad) continue
                it.code_fix = (fixes.get(it.code_bad) || [])
                  .filter(c => (known.get(c) || []).length)
                  .slice(0, 3)
                  .map(c => ({ barcode: c, name: known.get(c)[0] }))
              }
            }
          }

          // Сколько места занято фотографиями. Считаем по средней из тех, что
          // уже приехали: точную сумму дал бы только SQL, а место кончается
          // молча — база бесплатного тарифа не бесконечная, и узнать об этом
          // хочется раньше, чем перестанут приходить накладные.
          let photos = null
          if (!countOnly) {
            const pr = await sbFetch(
              `${db2.url}/rest/v1/mon_ai_invoices?select=id&image_b64=not.is.null&limit=1`,
              { headers: { ...db2.headers, Prefer: 'count=exact' } })
            const cnt = pr.ok ? Number((pr.headers.get('content-range') || '').split('/')[1]) : NaN
            const have = rows.filter(x => x.image_b64).map(x => x.image_b64.length * 0.75)
            if (Number.isFinite(cnt) && have.length) {
              photos = { count: cnt, approx_bytes: Math.round(cnt * have.reduce((a, b) => a + b, 0) / have.length) }
            } else if (Number.isFinite(cnt)) {
              photos = { count: cnt, approx_bytes: null }
            }
          }
          return json({ rows, total: Number.isFinite(total) ? total : null, photos })
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
          // Ничего не изменилось — причин ДВЕ, и они требуют разных действий.
          // Раньше обе назывались «код уже привязан», и вендор шёл искать во
          // вкладке «Привязанные» то, чего там нет (24.08.2026).
          let note = null
          if (!hit.length) {
            const st = await normStatuses(db2, keys)
            const known = st && keys.some(k => st.has(k))
            note = known
              ? 'В очереди этого написания нет — код уже привязан. Поменять его можно в «Названиях» → «Привязанные».'
              : 'Этого написания нет в словаре: касса его туда не присылала, привязывать нечего. Оно попадёт в очередь, когда магазин впервые не сможет сопоставить эту строку.'
          }
          return json({ ok: true, bound: hit.length, checksum: validBarcode(bc), note })
        }

        // Что за модель сейчас распознаёт, как она себя показала на живых
        // накладных и во сколько это обходится. Одно окно вместо догадок.
        if (pathname === '/api/invoices/models') {
          // Каждый кусок окна добывается отдельно и падает отдельно. Раньше
          // любой сбойный запрос ронял весь ответ, и окно вечно показывало
          // «Загрузка…» — ни данных, ни причины.
          const notes = []
          const grab = async (what, url, headers) => {
            try {
              const r = await sbFetch(url, { headers })
              if (!r.ok) {
                const text = await r.text()
                notes.push(`${what}: ${/does not exist|PGRST205|PGRST204|42P01|42703/.test(text)
                  ? 'нет в базе (SQL из monitor-schema.sql не выполнен)'
                  : r.status + ' ' + text.slice(0, 120)}`)
                return null
              }
              return { rows: await r.json().catch(() => []), headers: r.headers }
            } catch (e) {
              notes.push(`${what}: ${String(e).slice(0, 120)}`)
              return null
            }
          }

          let current = null, topups = []
          const set = await grab('настройки', `${db2.url}/rest/v1/mon_settings?select=key,value`, db2.headers)
          for (const row of set?.rows ?? []) {
            if (row.key === 'invoice_model') current = typeof row.value === 'string' ? row.value : row.value?.model
            // ai_topups — журнал пополнений счёта: [{at, usd}]. Именно журнал, а
            // не одно число: остаток это ВСЕ пополнения минус ВЕСЬ расход с
            // первого из них, и второе пополнение не должно затирать первое.
            if (row.key === 'ai_topups' && Array.isArray(row.value)) topups = row.value
          }
          const added = topups.reduce((a, t) => a + (Number(t?.usd) || 0), 0)
          // Считать расход «с начала месяца» при накопительных пополнениях
          // нельзя: деньги положены раньше, и остаток вышел бы завышенным.
          const since = topups.map(t => String(t?.at || '')).filter(Boolean).sort()[0] || null

          // Качество — по последним распознаваниям. Фото не тянем: они тяжёлые,
          // а для счёта не нужны. Колонок расхода может ещё не быть — тогда
          // просим без них: качество показать всё равно можно.
          const cols = 'model,items,declared_total'
          let inv = await grab('накладные', `${db2.url}/rest/v1/mon_ai_invoices?select=${cols},in_tokens,out_tokens&order=created_at.desc&limit=300`, db2.headers)
          if (!inv) {
            notes.length = 0   // первая попытка — разведка, её жалобу не показываем
            inv = await grab('накладные', `${db2.url}/rest/v1/mon_ai_invoices?select=${cols}&order=created_at.desc&limit=300`, db2.headers)
          }
          const stats = modelStats(inv?.rows ?? [])

          const from = new Date().toISOString().slice(0, 8) + '01'
          const use = await grab('расход', `${db2.url}/rest/v1/mon_ai_usage?select=count&day=gte.${from}&limit=5000`, db2.headers)
          const done = (use?.rows ?? []).reduce((a, r) => a + (Number(r.count) || 0), 0)

          // Список моделей — у функции: он собран из её ключей.
          const fn = await fnModels()
          if (!fn) notes.push('модели: parse-invoice не отдала список (нужна версия ≥ 2026-08-20.3)')
          const models = fn?.models ?? []

          // Деньги — только настоящие. Считаются по записанным токенам и
          // опубликованному прайсу; накладные без записи в счёт не идут.
          // Какая модель работает СЕЙЧАС. Считаем здесь, один раз: имена
          // приходят в двух формах («claude-sonnet-5» у модели по умолчанию,
          // «anthropic:claude-sonnet-5» в списке), и сравнение их как есть уже
          // дважды давало пустоту — то нулевую статистику, то список, где ни
          // одна модель не помечена выбранной.
          const nowId = bareModel(current || fn?.model || '')
          for (const m of models) m.isCurrent = !!nowId && bareModel(m.id) === nowId

          // Статистику вешаем прямо на модель: сопоставление по имени —
          // единственное место, где можно снова разъехаться с базой.
          for (const m of models) {
            const st = stats.find(x => x.model === bareModel(m.id))
            if (!st) { m.stat = null; continue }
            st.usd = st.paid ? modelCost(m, st.tokIn, st.tokOut) : null
            st.usdPer = st.usd != null ? st.usd / st.paid : null
            m.stat = st
          }
          const measured = stats.reduce((a, s) => a + (s.usd || 0), 0)
          const paid = stats.reduce((a, s) => a + s.paid, 0)

          // Счёт организации, если задан админский ключ: он один знает ВСЁ, что
          // потрачено, включая накладные до появления записи токенов.
          const cost = await anthropicCost(env, since || from, new Date().toISOString().slice(0, 10))

          return json({
            current, done, notes,
            topups, added, since,
            // Модель по умолчанию — та, на которой функция работает, пока выбор
            // не сделан. Без неё панель показывала бы первую из списка, а это
            // другая модель и другая цена.
            fallback: fn?.model ?? null,
            models, providers: fn?.providers ?? [], fnVersion: fn?.version ?? null,
            billUsd: cost?.usd ?? null,
            costError: cost?.error ?? null,
            measuredUsd: paid ? measured : null,
            measuredOn: paid,
            stats,
          })
        }

        // Смена модели. Белый список — и здесь, и в функции: модель, которой
        // нет в списке, означала бы отказ распознавания у всех клиентов сразу.
        if (pathname === '/api/invoices/setModel') {
          const { model, topups } = await request.json()
          const patch = []
          if (model !== undefined) {
            // Сверяем с тем, что функция реально умеет вызвать: модель не из
            // её списка означала бы отказ распознавания у всех клиентов сразу.
            const fn = await fnModels()
            if (!fn) return json({ error: 'parse-invoice не отдала список моделей' }, 502)
            if (!fn.models.some(m => m.id === model)) return json({ error: 'Неизвестная модель' }, 400)
            patch.push({ key: 'invoice_model', value: model, updated_at: new Date().toISOString() })
          }
          if (topups !== undefined) {
            if (!Array.isArray(topups) || topups.length > 200) return json({ error: 'Список пополнений не принят' }, 400)
            const clean = topups
              .map(t => ({ at: String(t?.at || '').slice(0, 10), usd: Number(t?.usd) || 0 }))
              .filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.at) && t.usd > 0)
            patch.push({ key: 'ai_topups', value: clean, updated_at: new Date().toISOString() })
          }
          if (!patch.length) return json({ error: 'Нечего менять' }, 400)
          const up = await sbFetch(`${db2.url}/rest/v1/mon_settings?on_conflict=key`, {
            method: 'POST',
            headers: { ...db2.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify(patch),
          })
          if (!up.ok) {
            const text = await up.text()
            if (/does not exist|PGRST205|42P01/.test(text)) {
              return json({ error: 'Нет таблицы mon_settings (SQL из monitor-schema.sql не выполнен)' }, 502)
            }
            return json({ error: `Supabase: ${up.status} ${text}` }, 502)
          }
          return json({ ok: true })
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
