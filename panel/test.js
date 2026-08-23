// Смоук-тест панели: серверные маршруты воркера + свёртки дневных итогов.
// Клиентская половина прежнего теста гоняла <script> из константы PAGE через
// DOM-заглушку — с переездом интерфейса на React страницы больше нет, и вместе
// с ней ушли те проверки. Осталось то, что реально может молча сломаться:
// маршруты, права, разбор ответов облака и арифметика денег.
// Запуск: node panel/test.js
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { window_, isoDay, groupAliases, invoiceItemCode, invoiceCodePairs, invoiceNameKey, oneDigitFixes, modelStats, modelCost, bareModel, anthropicCost, pushEvents, encryptPush, b64u, EXPIRE_SOON_DAYS } from './public/_worker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = path.join(__dirname, 'public', '_worker.js')

// Статику в «Advanced mode» отдаёт платформа, в тесте её нет — подставляем
// минимальную заглушку, иначе воркер честно ответит «сборка не найдена».
const ASSETS = {
  async fetch(req) {
    const u = new URL(req instanceof URL ? req.href : typeof req === 'string' ? req : req.url)
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return new Response('<!doctype html><title>iMag — панель</title>', {
        status: 200, headers: { 'Content-Type': 'text/html' },
      })
    }
    return new Response('not found', { status: 404 })
  },
}

async function testServerRoutes() {
  const tmp = path.join(os.tmpdir(), 'imag_panel_worker_test_' + Date.now() + '.mjs')
  fs.copyFileSync(WORKER_PATH, tmp)
  let worker
  try {
    const mod = await import(pathToFileURL(tmp).href)
    worker = mod.default
  } finally {
    fs.unlinkSync(tmp)
  }

  const home = await worker.fetch(new Request('https://x.test/'), { ASSETS })
  assert.strictEqual(home.status, 200, 'корень отдаёт собранное приложение')
  assert.ok((await home.text()).includes('<title>iMag'), 'это именно страница панели')

  // Неизвестный путь — не 404, а маршрут внутри одностраничного приложения.
  const spa = await worker.fetch(new Request('https://x.test/clients'), { ASSETS })
  assert.strictEqual(spa.status, 200, 'неизвестный путь отдаёт index.html, а не 404')

  // Без ASSETS воркер обязан сказать, ЧТО не так, а не отдать пустоту.
  const noAssets = await worker.fetch(new Request('https://x.test/'), {})
  assert.strictEqual(noAssets.status, 500, 'без сборки — внятная ошибка')
  assert.ok((await noAssets.text()).includes('Сборка не найдена'))

  const noAuth = await worker.fetch(new Request('https://x.test/api/clients', { method: 'POST' }), { PANEL_PASSWORD: 'secret' })
  assert.strictEqual(noAuth.status, 401, 'missing x-panel-key should 401')

  // keepalive доступен без пароля и методом GET; без секретов оба пинга падают → 502
  const keepalive = await worker.fetch(new Request('https://x.test/api/keepalive'), { PANEL_PASSWORD: 'secret' })
  assert.strictEqual(keepalive.status, 502, 'keepalive without Supabase secrets should 502')
  const ka = await keepalive.json()
  assert.deepStrictEqual(ka, { ok: false, licenses: false, monitor: false }, 'keepalive should report both projects down')

  const authed = (path, body) => worker.fetch(new Request('https://x.test' + path, {
    method: 'POST', headers: { 'x-panel-key': 'secret' }, body: JSON.stringify(body || {})
  }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k',
       MONITOR_SUPABASE_URL: 'https://mon.test', MONITOR_SUPABASE_SERVICE_ROLE_KEY: 'mk' })

  const noMonitorSecrets = await worker.fetch(new Request('https://x.test/api/catalog/pending', {
    method: 'POST', headers: { 'x-panel-key': 'secret' }
  }), { PANEL_PASSWORD: 'secret' })
  assert.strictEqual(noMonitorSecrets.status, 500, 'catalog route without monitor Supabase secrets should 500')

  const noBarcode = await authed('/api/catalog/upsert', { name: 'Товар' })
  assert.strictEqual(noBarcode.status, 400, 'upsert without barcode should 400')

  const noName = await authed('/api/catalog/upsert', { barcode: '123' })
  assert.strictEqual(noName.status, 400, 'upsert without name should 400')

  const badPrice = await authed('/api/catalog/upsert', { barcode: '123', name: 'Товар', price: 'abc' })
  assert.strictEqual(badPrice.status, 400, 'non-numeric price should 400')

  const noKeyApprove = await authed('/api/catalog/approve', { barcode: '123' })
  assert.strictEqual(noKeyApprove.status, 400, 'approve without venue_id should 400')

  const noKeyReject = await authed('/api/catalog/reject', { venue_id: 'v1' })
  assert.strictEqual(noKeyReject.status, 400, 'reject without barcode should 400')

  const noQuery = await authed('/api/catalog/similar', {})
  assert.strictEqual(noQuery.status, 400, 'similar without query text should 400')

  // Одобрение заявки создаёт лицензию — обе проверки обязаны отсекать запрос
  // ДО обращения к базе, иначе тест полез бы в сеть.
  const apprNoMid = await authed('/api/requests/approve', { customer: 'Кафе' })
  assert.strictEqual(apprNoMid.status, 400, 'approve without machine_id should 400')

  const apprNoCust = await authed('/api/requests/approve', { machine_id: 'AAAA-BBBB' })
  assert.strictEqual(apprNoCust.status, 400, 'approve without customer should 400')

  const rejNoMid = await authed('/api/requests/reject', {})
  assert.strictEqual(rejNoMid.status, 400, 'reject without machine_id should 400')

  // Правка карточки. Все проверки обязаны отсекать запрос ДО обращения к базе,
  // иначе тест полез бы в сеть.
  const editNoId = await authed('/api/edit', { customer: 'Кафе' })
  assert.strictEqual(editNoId.status, 400, 'правка без id — отказ')

  const editEmptyName = await authed('/api/edit', { id: 'x', customer: '   ' })
  assert.strictEqual(editEmptyName.status, 400, 'пустое имя клиента — отказ')

  const editNothing = await authed('/api/edit', { id: 'x' })
  assert.strictEqual(editNothing.status, 400, 'нечего менять — отказ')

  // Город: пустая строка обязана сохраняться как NULL, иначе фильтр «Все
  // города» показывал бы отдельный пустой город.
  {
    const real = global.fetch
    let body = null
    global.fetch = async (u, init) => { body = JSON.parse(init.body); return new Response('[]', { status: 200 }) }
    await authed('/api/edit', { id: 'x', city: '  ' })
    global.fetch = real
    assert.strictEqual(body.city, null, 'пустой город — NULL, а не пустая строка')
  }

  const editBadTerm = await authed('/api/edit', { id: 'x', terminals: 0 })
  assert.strictEqual(editBadTerm.status, 400, 'ноль терминалов — отказ')

  const editBadHidden = await authed('/api/edit', { id: 'x', hidden: 'да' })
  assert.strictEqual(editBadHidden.status, 400, 'hidden строкой — отказ')

  // Цена и «отложить до даты» — деньги и календарь: мусор в них тихо ломает
  // и плитку «ожидается за 30 дней», и блок внимания.
  const editBadPrice = await authed('/api/edit', { id: 'x', price: 'дорого' })
  assert.strictEqual(editBadPrice.status, 400, 'цена не числом — отказ')

  const editNegPrice = await authed('/api/edit', { id: 'x', price: -1 })
  assert.strictEqual(editNegPrice.status, 400, 'отрицательная цена — отказ')

  const editBadDate = await authed('/api/edit', { id: 'x', snoozed_until: '15.09.2026' })
  assert.strictEqual(editBadDate.status, 400, 'дата не в виде ГГГГ-ММ-ДД — отказ')

  // Белый список: срок и привязку через эту ручку менять нельзя — у них свои
  // каналы со своей логикой. Одни только запрещённые поля = «нечего менять».
  const editForbidden = await authed('/api/edit', { id: 'x', expires_at: '2099-01-01', machine_id: 'AAA', revoked: true })
  assert.strictEqual(editForbidden.status, 400, 'поля вне белого списка не проходят')

  // Выпуск лицензии сразу на компьютер (из карточки пробной установки): такая
  // лицензия забирается кассой сама. Вторая живая лицензия на ту же машину
  // сломала бы claim — проверка обязана сработать ДО вставки.
  {
    const real = global.fetch
    global.fetch = async (url) => String(url).includes('machine_id=eq.')
      ? new Response(JSON.stringify([{ id: 'уже-есть', revoked: false }]), { status: 200 })
      : new Response('[]', { status: 200 })
    const r = await authed('/api/issue', { customer: 'Кафе', days: 30, machine_id: 'aaaa-bbbb' })
    global.fetch = real
    assert.strictEqual(r.status, 409, 'дубль лицензии на ту же машину — отказ')
    assert.ok((await r.json()).error.includes('уже-есть'), 'в ошибке назван номер существующей лицензии')
  }

  // Продление — деньги клиента. Журнал продлений появился позже, и на проекте,
  // где SQL ещё не выполнили, его таблицы нет. Подписка обязана продлиться всё
  // равно: терять оплату из-за отсутствующего журнала нельзя.
  {
    const real = global.fetch
    let renewed = false
    global.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('license_renewals')) return new Response('{"code":"42P01"}', { status: 404 })
      if (init?.method === 'PATCH') { renewed = true; return new Response(null, { status: 204 }) }
      return new Response(JSON.stringify([{ customer: 'Кафе', expires_at: null }]), { status: 200 })
    }
    const r = await authed('/api/renew', { id: 'x', days: 30, amount: 15000 })
    global.fetch = real
    assert.strictEqual(r.status, 200, 'продление проходит даже без таблицы истории')
    assert.ok(renewed, 'срок лицензии при этом реально сдвинут')
  }

  const renewNoDays = await authed('/api/renew', { id: 'x' })
  assert.strictEqual(renewNoDays.status, 400, 'продление без числа дней — отказ')

  // Колонки contact/hidden добавляются отдельными ALTER. Пока их нет, Supabase
  // отвечает «PGRST204 column ... does not exist» — владельцу это не говорит
  // ничего. Подменяем fetch и проверяем, что наружу уходит инструкция.
  {
    const real = global.fetch
    global.fetch = async () => new Response(
      JSON.stringify({ code: 'PGRST204', message: "Column 'hidden' of relation 'licenses' does not exist" }),
      { status: 400 })
    const r = await authed('/api/edit', { id: 'x', hidden: true })
    global.fetch = real
    assert.strictEqual(r.status, 502)
    const d = await r.json()
    assert.ok(d.error.includes('нет колонки'), 'ошибка объясняет, ЧЕГО не хватает: ' + d.error)
    assert.ok(d.error.includes('schema.sql'), 'и говорит, что именно выполнить')
    assert.ok(!d.error.includes('PGRST204'), 'сырой код Supabase наружу не уходит')
  }

  // Бейдж в меню спрашивает только число. Если сюда вернётся полный список,
  // каждое открытие панели снова начнёт тянуть фотографии накладных.
  {
    const real = global.fetch
    let asked = ''
    global.fetch = async (url) => {
      asked = String(url)
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/7' } })
    }
    const r = await authed('/api/invoices/pending', { countOnly: true })
    global.fetch = real
    assert.strictEqual((await r.json()).total, 7, 'счётчик отдаётся')
    assert.ok(asked.includes('select=id'), 'фото не запрашиваются: ' + asked)
    assert.ok(asked.includes('limit=1'), 'строки не тянутся: ' + asked)
  }

  // Каталог — самая большая таблица во всём хозяйстве. Точный подсчёт по ней
  // это полный проход на каждую букву в поиске: запрос повисал в «Pending».
  {
    const real = global.fetch
    let prefer = ''
    global.fetch = async (url, init) => {
      prefer = init?.headers?.Prefer || ''
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/12345' } })
    }
    const r = await authed('/api/catalog/list', { q: '', page: 0 })
    global.fetch = real
    assert.strictEqual(r.status, 200)
    assert.strictEqual(prefer, 'count=estimated', 'каталог считается оценкой, а не полным проходом')
  }

  // Страницы очереди: без offset хвост очереди был недостижим — видны только
  // 200 самых свежих карточек, а разобрать их можно было только сверху.
  {
    const real = global.fetch
    let url = ''
    global.fetch = async (u) => { url = String(u); return new Response('[]', { status: 200, headers: { 'content-range': '0-0/500' } }) }
    await authed('/api/catalog/pending', { page: 2 })
    global.fetch = real
    assert.ok(url.includes('offset=400'), 'вторая страница очереди берётся со смещением')
  }

  // Фильтр внутренних кодов «2…» — ровно EAN-13, а не «всё, что начинается с 2»:
  // иначе под нож попадали бы восьмизначные заводские коды.
  {
    const real = global.fetch
    let url = ''
    global.fetch = async (u) => { url = String(u); return new Response('[]', { status: 200, headers: { 'content-range': '0-0/1' } }) }
    await authed('/api/catalog/pending', { internalOnly: true })
    global.fetch = real
    assert.ok(decodeURIComponent(url).includes('barcode=match.^2[0-9]{12}$'), 'фильтр внутренних кодов')
  }

  // Отмена одобрения возвращает карточку в очередь — без venue_id непонятно,
  // чью строку возвращать, значит запрос обязан отсекаться до базы.
  const unapNoKey = await authed('/api/catalog/unapprove', { barcode: '123' })
  assert.strictEqual(unapNoKey.status, 400, 'отмена одобрения без venue_id — отказ')

  // Отмена отклонения возвращает строку ИМЕННО в очередь: если бы upsert
  // молча ставил approved, отменённое отклонение втащило бы карточку в каталог.
  {
    const real = global.fetch
    let body = null
    global.fetch = async (u, init) => { body = JSON.parse(init.body); return new Response('[{}]', { status: 200 }) }
    await authed('/api/catalog/upsert', { venue_id: 'v1', barcode: '123', name: 'Товар', status: 'pending' })
    global.fetch = real
    assert.strictEqual(body.status, 'pending', 'статус pending доходит до базы')
  }
  {
    const real = global.fetch
    let body = null
    global.fetch = async (u, init) => { body = JSON.parse(init.body); return new Response('[{}]', { status: 200 }) }
    await authed('/api/catalog/upsert', { venue_id: 'v1', barcode: '123', name: 'Товар', status: 'что угодно' })
    global.fetch = real
    assert.strictEqual(body.status, 'approved', 'посторонний статус не проходит')
  }

  // Сортировка «сначала нетронутые» — правленое только что уезжает в хвост.
  {
    const real = global.fetch
    let url = ''
    global.fetch = async (u) => { url = String(u); return new Response('[]', { status: 200, headers: { 'content-range': '0-0/9' } }) }
    await authed('/api/catalog/list', { q: '', page: 0, sort: 'stale' })
    global.fetch = real
    assert.ok(url.includes('order=updated_at.asc'), 'нетронутые идут первыми')
  }

  // Переименование категории — массовая правка справочника: пустое имя-источник
  // задело бы всё подряд, а «переименовать в себя» просто гоняло бы базу впустую.
  const renNoFrom = await authed('/api/catalog/renameCategory', { to: 'Напитки' })
  assert.strictEqual(renNoFrom.status, 400, 'переименование без исходной категории — отказ')

  const renSame = await authed('/api/catalog/renameCategory', { from: 'Напитки', to: ' Напитки ' })
  assert.strictEqual(renSame.status, 400, 'имя не изменилось — отказ')

  // Пустое «во что» = очистить категорию: в базу уходит null, а не пустая
  // строка, иначе в списке появилась бы категория с именем «».
  {
    const real = global.fetch
    let body = null, url = ''
    global.fetch = async (u, init) => { url = String(u); body = JSON.parse(init.body); return new Response('', { status: 204 }) }
    await authed('/api/catalog/renameCategory', { from: 'Напитки', to: '  ' })
    global.fetch = real
    assert.strictEqual(body.category, null, 'очистка пишет null')
    assert.ok(decodeURIComponent(url).includes('category=eq.Напитки'), 'правим только эту категорию')
  }

  const bulkDelEmpty = await authed('/api/catalog/bulkDelete', { barcodes: [] })
  assert.strictEqual(bulkDelEmpty.status, 400, 'массовое удаление без выбора — отказ')

  const bulkDelMany = await authed('/api/catalog/bulkDelete', { barcodes: Array.from({ length: 501 }, (_, i) => String(i)) })
  assert.strictEqual(bulkDelMany.status, 400, 'больше 500 штрихкодов за раз — отказ')

  // Подсказка категорий: дубли и регистр схлопываются на сервере, иначе в
  // выпадающем списке было бы по три «Напитки» подряд.
  {
    const real = global.fetch
    global.fetch = async () => new Response(JSON.stringify(
      [{ category: 'Напитки' }, { category: ' Напитки ' }, { category: null }, { category: 'Бакалея' }]),
      { status: 200 })
    const r = await authed('/api/catalog/categories')
    global.fetch = real
    assert.deepStrictEqual((await r.json()).rows, ['Бакалея', 'Напитки'], 'категории без дублей и по алфавиту')
  }

  // /api/cloud опрашивает сами облачные функции — подменяем fetch, чтобы тест
  // не ходил в сеть и чтобы проверить РАЗБОР всех вариантов ответа.
  const realFetch = global.fetch
  global.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/functions/v1/trial')) return new Response('{"error":"not found"}', { status: 404 })
    if (u.endsWith('/functions/v1/status')) return new Response('старый ответ без версии', { status: 200 })
    if (u.endsWith('/functions/v1/activate')) {
      return new Response(JSON.stringify({ version: '1', table_licenses: 'ok', signing_key: 'missing' }), { status: 200 })
    }
    return new Response(JSON.stringify({ version: '1' }), { status: 200 })
  }
  const cloud = await authed('/api/cloud')
  global.fetch = realFetch

  assert.strictEqual(cloud.status, 200, '/api/cloud should answer 200')
  const cl = await cloud.json()
  assert.strictEqual(cl.rows.length, 6, 'cloud check should probe all six functions')
  const byName = Object.fromEntries(cl.rows.map(r => [r.name, r]))
  assert.strictEqual(byName.trial.verdict, 'не выложена', '404 should read as "not deployed"')
  assert.strictEqual(byName.status.verdict, 'старая версия — выложите заново', 'answer without a version should read as stale')
  assert.strictEqual(byName.claim.ok, true, 'a versioned healthy answer should read as working')
  assert.strictEqual(byName.activate.ok, false, 'missing signing key should mark activate as broken')
  assert.ok(byName.activate.verdict.includes('LICENSE_PRIVATE_KEY'), 'activate verdict should name the missing key')

  console.log('серверные маршруты: OK')
}

// ── Свёртки дневных итогов ────────────────────────────────────────────
// Единственная в панели логика, где можно молча посчитать деньги неверно.
function testUsageWindows() {
  const day = (shift) => isoDay(shift)

  // Ровно на границе окна: -7 входит, -8 нет. Иначе «выручка за неделю»
  // незаметно превращается в выручку за восемь дней.
  let w = window_([
    { day: day(-8), revenue: 1000, receipts: 1 },
    { day: day(-7), revenue: 2000, receipts: 2 },
    { day: day(0), revenue: 3000, receipts: 3 },
  ])
  assert.equal(w.revenue7, 5000, 'в неделю входят -7 и сегодня')
  assert.equal(w.receipts7, 5)
  assert.equal(w.revenue30, 6000, 'в месяц входит всё')

  // Средний чек считается от тридцати дней, а не от недели.
  w = window_([
    { day: day(-20), revenue: 10000, receipts: 5 },
    { day: day(-1), revenue: 5000, receipts: 5 },
  ])
  assert.equal(w.avgCheck, 1500, '15000 / 10')

  // Ноль чеков не должен давать NaN или деление на ноль.
  w = window_([{ day: day(-1), revenue: 0, receipts: 0 }])
  assert.equal(w.avgCheck, 0)

  // Прошлая неделя — окно [-14,-7), без пересечения с текущей: иначе процент
  // роста считался бы от куска самого себя и всегда выглядел бы приличным.
  w = window_([
    { day: day(-13), revenue: 1000, receipts: 1 },
    { day: day(-7), revenue: 9999, receipts: 1 },
    { day: day(-1), revenue: 2000, receipts: 1 },
  ])
  assert.equal(w.prevRevenue7, 1000, 'день -7 уже в текущей неделе, не в прошлой')
  assert.equal(w.revenue7, 11999)

  // Пустая история — все нули, ничего не падает.
  w = window_([])
  assert.deepEqual([w.revenue7, w.receipts7, w.revenue30, w.avgCheck, w.prevRevenue7], [0, 0, 0, 0, 0])

  console.log('свёртки итогов: OK')
}

// ── Отрисовка вкладок ─────────────────────────────────────────────────
// Сборка молча пропускает ошибки, которые случаются только при отрисовке. Так
// уже вышло: обращение к переменной до её объявления роняло «Заявки»,
// «Каталог», «Накладные» и «Облако» целиком — на сводке то же выражение
// обрывалось раньше по `||`, поэтому поломки не было видно вовсе.
//
// Рисуем каждую вкладку на сервере: сеть при этом не нужна (эффекты в SSR не
// выполняются), достаточно, чтобы отрисовка не бросила исключение.
async function testViewsRender() {
  const esbuild = await import('esbuild')
  // Собираем рядом с исходниками, а не в /tmp: оттуда node не находит react.
  const out = path.join(__dirname, '.app-render-test.mjs')
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'App.jsx')],
    bundle: true, format: 'esm', jsx: 'automatic', outfile: out,
    external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' },
  })

  // Панель написана для браузера: пароль лежит в localStorage, вкладка — в
  // адресе. В node этих объектов нет, подставляем самое необходимое.
  globalThis.localStorage = {
    store: { panel_pw: 'x' },
    getItem(k) { return this.store[k] ?? null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  }
  const { renderToString } = await import('react-dom/server')
  const React = await import('react')
  const { default: App } = await import(pathToFileURL(out).href)
  fs.unlinkSync(out)

  for (const view of ['summary', 'clients', 'trials', 'requests', 'catalog', 'aliases', 'invoices']) {
    globalThis.location = { hash: '#/' + view, href: 'https://x.test/#/' + view }
    const html = renderToString(React.createElement(App))
    assert.ok(html.includes('iMag'), `вкладка «${view}» отрисовалась`)
    // Нижняя панель мест — единственная навигация на телефоне: бокового меню
    // там больше нет, и если она пропадёт, переключаться станет нечем.
    assert.ok(html.includes('tabbar') && html.includes('Товары'),
      `на вкладке «${view}» есть нижняя панель мест`)
  }
  console.log('отрисовка вкладок: OK')
}

// ── Один ПК — одна карточка ───────────────────────────────────────────
// Купивший клиент оставался и в пробных, и в платящих: касса после активации
// перестаёт слать /trial, и строка в trials замирает навсегда. Отсекаем её по
// machine_id лицензии — здесь проверяем, что отсекаем ровно ту, что нужно.
async function testTrialsMerge() {
  const tmp = path.join(os.tmpdir(), 'imag_panel_merge_test_' + Date.now() + '.mjs')
  fs.copyFileSync(WORKER_PATH, tmp)
  let worker
  try {
    const mod = await import(pathToFileURL(tmp).href)
    worker = mod.default
  } finally {
    fs.unlinkSync(tmp)
  }

  const rows = (url) => {
    if (url.includes('/rest/v1/licenses')) return [
      { id: 1, customer: 'Магазин у дома', machine_id: 'PC-КУПИЛ', expires_at: null, revoked: false },
      { id: 2, customer: 'Выдана, но не ставили', machine_id: null, expires_at: null, revoked: false },
    ]
    if (url.includes('/rest/v1/trials')) return [
      { machine_id: 'PC-КУПИЛ', status: 'trial' },      // тот же ПК — карточка уже есть в лицензиях
      { machine_id: 'PC-ПРОБУЕТ', status: 'trial' },    // честный триал
      { machine_id: '', status: 'trial' },              // мусорная строка без ПК
    ]
    return []
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => new Response(JSON.stringify(rows(String(url))), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
  let data
  try {
    const res = await worker.fetch(new Request('https://x.test/api/clients', {
      method: 'POST', headers: { 'x-panel-key': 'secret' }, body: '{}',
    }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' })
    assert.strictEqual(res.status, 200, '/api/clients отвечает')
    data = await res.json()
  } finally {
    globalThis.fetch = realFetch
  }

  const machines = data.trials.map(t => t.machine_id)
  assert.ok(!machines.includes('PC-КУПИЛ'), 'купивший не двоится в пробных')
  assert.ok(machines.includes('PC-ПРОБУЕТ'), 'настоящий триал остался')
  assert.ok(machines.includes(''), 'лицензия без machine_id не прячет чужие триалы')
  assert.strictEqual(data.licenses.length, 2, 'лицензии не тронуты')
  console.log('склейка пробных с лицензиями: OK')
}

// Здоровье облака лицензий. Пустой секрет подписи однажды остановил кассы у
// клиентов, и заметили это они, а не вендор: снаружи это видно только через
// служебный ответ функции.
async function testHealthRoute() {
  const tmp = path.join(os.tmpdir(), 'imag_panel_health_test_' + Date.now() + '.mjs')
  fs.copyFileSync(WORKER_PATH, tmp)
  let worker
  try { worker = (await import(pathToFileURL(tmp).href)).default } finally { fs.unlinkSync(tmp) }
  const call = () => worker.fetch(new Request('https://x.test/api/health', {
    method: 'POST', headers: { 'x-panel-key': 'secret' }, body: '{}'
  }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' })

  const real = global.fetch
  const asked = []
  global.fetch = async (url) => {
    const u = String(url)
    asked.push(u)
    if (u.includes('/functions/v1/status')) {
      return new Response(JSON.stringify({ ok: false, signing_key: 'missing', table_licenses: 'ok', version: '7' }), { status: 200 })
    }
    // Кассы, сообщившие о беде за неделю: бейджу нужно только число.
    return new Response('[]', { status: 200, headers: { 'content-range': '0-0/2' } })
  }
  const d = await (await call()).json()
  global.fetch = real
  assert.ok(asked[0].includes('/functions/v1/status'), 'спрашиваем функцию лицензий: ' + asked[0])
  assert.strictEqual(d.signing_key, 'missing', 'состояние ключа подписи доезжает до панели')
  assert.strictEqual(d.ok, false)
  assert.strictEqual(d.sos, 2, 'и число касс, сообщивших о поломке — для красной точки в меню')
  assert.ok(asked.some(u => u.includes('last_sos_at=gte.')), 'считаем только свежие SOS')

  const real2 = global.fetch
  global.fetch = async () => { throw new Error('нет связи') }
  const down = await (await call()).json()
  global.fetch = real2
  assert.strictEqual(down.ok, false, 'функция не ответила — это тоже «не в порядке»')
  assert.ok(down.error, 'и причина названа')

  console.log('здоровье облака лицензий: OK')
}

// Маршруты словаря написаний: их четыре, и половина принимает id/штрихкод —
// молча проглоченный мусор здесь означает привязку не к тому товару во всех
// магазинах сразу.
async function testAliasRoutes() {
  const tmp = path.join(os.tmpdir(), 'imag_panel_alias_test_' + Date.now() + '.mjs')
  fs.copyFileSync(WORKER_PATH, tmp)
  let worker
  try { worker = (await import(pathToFileURL(tmp).href)).default } finally { fs.unlinkSync(tmp) }

  const call = (p, body) => worker.fetch(new Request('https://x.test' + p, {
    method: 'POST', headers: { 'x-panel-key': 'secret' }, body: JSON.stringify(body || {})
  }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k',
       MONITOR_SUPABASE_URL: 'https://mon.test', MONITOR_SUPABASE_SERVICE_ROLE_KEY: 'mk' })

  assert.strictEqual((await call('/api/aliases/bind', { id: 1 })).status, 400, 'привязка без штрихкода — 400')
  assert.strictEqual((await call('/api/aliases/bind', { id: 1, barcode: '123' })).status, 400, 'короткий штрихкод — 400')
  assert.strictEqual((await call('/api/aliases/bind', { barcode: '4870071003189' })).status, 400, 'привязка без id — 400')
  assert.strictEqual((await call('/api/aliases/reject', {})).status, 400, 'отклонение без id — 400')
  assert.strictEqual((await call('/api/aliases/нет-такого', {})).status, 404, 'неизвестный маршрут словаря — 404')

  // Предложенный магазинами код надо показывать вместе с ТОВАРОМ, за которым
  // он стоит: иначе согласиться с чужой привязкой можно только вслепую.
  {
    const real = global.fetch
    let askedCatalog = ''
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('mon_barcodes')) {
        askedCatalog = u
        return new Response(JSON.stringify([
          { barcode: '4870204391237', name: 'Пепси 0.5' },
          { barcode: '4870204391237', name: 'Pepsi 0,5 л' },
        ]), { status: 200 })
      }
      return new Response(JSON.stringify([
        { id: 1, raw_name_norm: 'пепси05', raw_name: 'Пепси 0.5', hits: 3, barcode: '4870204391237' },
      ]), { status: 200 })
    }
    const d = await (await call('/api/aliases/list', { status: 'pending' })).json()
    global.fetch = real
    assert.ok(askedCatalog.includes('status=eq.approved'), 'название берём из одобренного справочника')
    assert.deepStrictEqual(d.rows[0].code_names, ['Пепси 0.5', 'Pepsi 0,5 л'],
      'показываем ВСЕ названия под этим кодом — разнобой и есть повод не соглашаться')
  }

  const noSecrets = await worker.fetch(new Request('https://x.test/api/aliases/list', {
    method: 'POST', headers: { 'x-panel-key': 'secret' }, body: '{}'
  }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' })
  assert.strictEqual(noSecrets.status, 500, 'без секретов облака — внятная ошибка, а не пустота')

  // Подсказка по слишком короткому запросу не идёт в базу вовсе
  const short = await call('/api/aliases/suggest', { q: 'ко' })
  assert.strictEqual(short.status, 200)
  assert.deepStrictEqual((await short.json()).rows, [], 'запрос короче трёх букв — пустой ответ без похода в базу')

  // Ключ таблицы — (venue_id, raw_name_norm): одно написание лежит СТРОКОЙ НА
  // КАЖДОЕ заведение. Решение вендора обязано уходить на все строки с этим
  // написанием, иначе одобренное всплывает в очереди снова у каждой точки.
  {
    const real = global.fetch
    let patched = ''
    global.fetch = async (url, init) => {
      if (init?.method === 'PATCH') { patched = String(url); return new Response(null, { status: 204 }) }
      return new Response(JSON.stringify([{ raw_name_norm: 'маккофи 3в1' }]), { status: 200 })
    }
    const r = await call('/api/aliases/bind', { id: 7, barcode: '4870204391234' })
    global.fetch = real
    assert.strictEqual(r.status, 200, 'привязка проходит')
    assert.ok(patched.includes('raw_name_norm=eq.'), 'решение уходит по написанию, а не по id: ' + patched)
    assert.ok(!patched.includes('id=eq.7'), 'одна строка из многих не патчится в одиночку')
    assert.ok(patched.includes('status=eq.pending'), 'уже разобранное чужим кодом не переписываем')
  }

  // Исправление ошибки: «Изменить код» и «Отвязать» правят УЖЕ разобранные
  // строки — без force они бы молча не нашли ни одной (фильтр pending).
  {
    const real = global.fetch
    let patched = '', body = null
    global.fetch = async (url, init) => {
      if (init?.method === 'PATCH') { patched = String(url); body = JSON.parse(init.body); return new Response(null, { status: 204 }) }
      return new Response(JSON.stringify([{ raw_name_norm: 'маккофи 3в1' }]), { status: 200 })
    }
    const r = await call('/api/aliases/bind', { id: 7, barcode: '4870204391234', force: true })
    assert.strictEqual(r.status, 200, 'замена кода проходит')
    assert.ok(!patched.includes('status=eq.pending'), 'с force правим и разобранные: ' + patched)

    const u = await call('/api/aliases/unbind', { id: 7 })
    global.fetch = real
    assert.strictEqual(u.status, 200, 'отвязка проходит')
    assert.strictEqual(body.status, 'pending', 'отвязанное возвращается в очередь')
    assert.strictEqual(body.barcode, null, 'код снимается — кассы тянут только строки с кодом')
    assert.ok(!patched.includes('status=eq.pending'), 'отвязка ищет строку без фильтра по статусу')
  }
  assert.strictEqual((await call('/api/aliases/unbind', {})).status, 400, 'отвязка без id — 400')

  // Написание берётся из базы по id, а не из тела запроса: подменённая норма
  // увела бы чужой товар на этот штрихкод во всех магазинах разом.
  {
    const real = global.fetch
    global.fetch = async () => new Response('[]', { status: 200 })
    const r = await call('/api/aliases/bind', { id: 999, barcode: '4870204391234', raw_name_norm: 'чужое' })
    global.fetch = real
    assert.strictEqual(r.status, 404, 'несуществующая строка — отказ, а не привязка по присланной норме')
  }

  // Очередь схлопывается по написанию, hits складываются: товар, который возят
  // все понемногу, иначе всегда уступал бы одной активной точке.
  const grouped = groupAliases([
    { id: 1, raw_name_norm: 'а', raw_name: 'А', hits: 2, supplier: null },
    { id: 2, raw_name_norm: 'б', raw_name: 'Б', hits: 5, supplier: 'Поставщик' },
    { id: 3, raw_name_norm: 'а', raw_name: 'А', hits: 4, supplier: 'Второй' },
  ])
  assert.strictEqual(grouped.length, 2, 'одно написание — одна карточка')
  assert.strictEqual(grouped[0].raw_name_norm, 'а', 'сверху то, что встречается чаще суммарно')
  assert.strictEqual(grouped[0].hits, 6, 'hits всех точек сложены')
  assert.strictEqual(grouped[0].venues, 2, 'видно, сколько точек ждут привязки')
  assert.strictEqual(grouped[0].supplier, 'Второй', 'поставщик подхвачен у той строки, где он есть')

  // Магазины сами привязывают коды сканером в приёмке и присылают их сюда.
  // Сошлись три независимые точки на одном коде — вендору остаётся согласиться.
  const trusted = groupAliases([
    { id: 1, raw_name_norm: 'к', raw_name: 'К', hits: 1, barcode: '4870000000011' },
    { id: 2, raw_name_norm: 'к', raw_name: 'К', hits: 1, barcode: '4870000000011' },
    { id: 3, raw_name_norm: 'к', raw_name: 'К', hits: 1, barcode: '4870000000011' },
  ])[0]
  assert.strictEqual(trusted.proposed, '4870000000011', 'код предложен самими магазинами')
  assert.strictEqual(trusted.proposed_venues, 3, 'посчитано, сколько точек за него')
  assert.strictEqual(trusted.trusted, true, 'три точки — бесспорно')

  const twoOnly = groupAliases([
    { id: 1, raw_name_norm: 'д', raw_name: 'Д', hits: 1, barcode: '4870000000022' },
    { id: 2, raw_name_norm: 'д', raw_name: 'Д', hits: 1, barcode: '4870000000022' },
  ])[0]
  assert.strictEqual(twoOnly.trusted, false, 'двух точек мало: одна сеть может повторить ошибку внедренца')

  const conflict = groupAliases([
    { id: 1, raw_name_norm: 'с', raw_name: 'С', hits: 1, barcode: '4870000000033' },
    { id: 2, raw_name_norm: 'с', raw_name: 'С', hits: 1, barcode: '4870000000033' },
    { id: 3, raw_name_norm: 'с', raw_name: 'С', hits: 1, barcode: '4870000000033' },
    { id: 4, raw_name_norm: 'с', raw_name: 'С', hits: 1, barcode: '4870000000044' },
  ])[0]
  assert.strictEqual(conflict.disputed, true, 'точки прислали разные коды — это спор');
  assert.strictEqual(conflict.trusted, false, 'спорное не одобряем автоматом даже при трёх точках')

  // Время группы — самое свежее из всех точек. По нему «Привязанные» кладут
  // сверху то, что вендор разобрал только что: по частоте оно улетает в хвост,
  // где его не найти вовсе.
  const fresh = groupAliases([
    { id: 1, raw_name_norm: 'а', raw_name: 'А', hits: 9, updated_at: '2026-01-01T00:00:00Z' },
    { id: 2, raw_name_norm: 'а', raw_name: 'А', hits: 1, updated_at: '2026-08-19T10:00:00Z' },
  ])[0]
  assert.strictEqual(fresh.updated_at, '2026-08-19T10:00:00Z', 'берём самое свежее время, а не первое по частоте')

  const noCodes = groupAliases([{ id: 1, raw_name_norm: 'п', raw_name: 'П', hits: 3 }])[0]
  assert.strictEqual(noCodes.proposed, null, 'никто кода не прислал — предлагать нечего')
  assert.strictEqual(noCodes.trusted, false, 'без кода одобрять нечего')

  console.log('маршруты словаря написаний: OK')
}

// Коды из уже распознанных накладных. Тут две опасности: привязать код,
// прочитанный с ошибкой (уедет чужой товар во все магазины), и разойтись с
// кассой в подсчёте ключа (привязка молча не найдёт ни одной строки очереди).
async function testInvoiceCodes() {
  // Ключ считается как norm() кассы: регистр, пробелы и «/12 шт» не в счёт,
  // казахские буквы сводятся к русским парам.
  assert.strictEqual(invoiceNameKey('Сметана Нежный 1,2%'), 'сметананежный1,2%')
  assert.strictEqual(invoiceNameKey('Пепси 0.5 / 12 шт.'), 'пепси05')
  assert.strictEqual(invoiceNameKey('Жаннұр құрт'), invoiceNameKey('Жаннур курт'))

  // Колонка со штрихкодом — самый простой случай.
  assert.strictEqual(invoiceItemCode({ name: 'Пепси', barcode: '4870204391237' }).barcode, '4870204391237')
  // Внутренний код поставщика (5–8 цифр без контрольной) кодом не считаем.
  assert.strictEqual(invoiceItemCode({ name: 'Пепси', barcode: '12345' }).barcode, null)
  // Ошибка распознавания в одной цифре не проходит контрольную сумму.
  assert.strictEqual(invoiceItemCode({ name: 'Пепси', barcode: '4870204391234' }).barcode, null)

  // Код, напечатанный ВНУТРИ наименования: вынимаем и вырезаем из имени.
  const inName = invoiceItemCode({ name: 'Сметана Нежный 1,2% / ШК: 4870204391237' })
  assert.strictEqual(inName.barcode, '4870204391237', 'код из наименования найден')
  assert.strictEqual(inName.clean, 'Сметана Нежный 1,2%', 'имя очищено от кода')

  // Пары: два ключа на строку (имя с кодом и без), дубли схлопнуты, мусор отсеян.
  const pairs = invoiceCodePairs([
    { name: 'Сметана Нежный 1,2% / ШК: 4870204391237' },
    { name: 'Сметана Нежный 1,2% / ШК: 4870204391237' },
    { name: 'Итого', barcode: '' },
  ])
  assert.strictEqual(pairs.length, 1, 'одно написание — одна привязка')
  assert.strictEqual(pairs[0].keys.length, 2, 'ищем и по старому ключу (с кодом), и по новому')
  assert.ok(pairs[0].keys.includes(invoiceNameKey('Сметана Нежный 1,2%')), 'очищенный ключ в списке')

  // Битый код надо ОТЛИЧАТЬ от отсутствующего: в первом случае владелец
  // поправит одну цифру руками, во втором смотреть нечего.
  const bad = invoiceItemCode({ name: 'Пепси', barcode: '4870204391234' })
  assert.strictEqual(bad.barcode, null, 'код с неверной контрольной не привязываем')
  assert.strictEqual(bad.found, '4870204391234', 'но показываем: распознавание ошиблось в цифре')
  assert.strictEqual(invoiceItemCode({ name: 'Пепси' }).found, null, 'кода в строке нет вовсе')

  const tmp = path.join(os.tmpdir(), 'imag_panel_inv_test_' + Date.now() + '.mjs')
  fs.copyFileSync(WORKER_PATH, tmp)
  let worker
  try { worker = (await import(pathToFileURL(tmp).href)).default } finally { fs.unlinkSync(tmp) }
  const call = (p, body) => worker.fetch(new Request('https://x.test' + p, {
    method: 'POST', headers: { 'x-panel-key': 'secret' }, body: JSON.stringify(body || {})
  }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k',
       MONITOR_SUPABASE_URL: 'https://mon.test', MONITOR_SUPABASE_SERVICE_ROLE_KEY: 'mk' })

  assert.strictEqual((await call('/api/invoices/bindCodes', {})).status, 400, 'привязка без id — 400')

  {
    const real = global.fetch
    let patched = '', body = null
    global.fetch = async (url, init) => {
      if (init?.method === 'PATCH') {
        patched = String(url); body = JSON.parse(init.body)
        return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200 })
      }
      return new Response(JSON.stringify([{ items: [
        { name: 'Сметана Нежный 1,2% / ШК: 4870204391237' },
        { name: 'Пепси 0.5', barcode: '4870204391234' },   // битая контрольная — не берём
      ] }]), { status: 200 })
    }
    const r = await call('/api/invoices/bindCodes', { id: 5 })
    global.fetch = real
    const d = await r.json()
    assert.strictEqual(r.status, 200, 'привязка проходит')
    assert.strictEqual(d.codes, 1, 'в накладной один пригодный код')
    assert.strictEqual(d.names, 1, 'одно написание привязано')
    assert.strictEqual(d.bound, 2, 'решение уехало на все точки с этим написанием')
    assert.ok(patched.includes('raw_name_norm=in.'), 'ищем по обоим ключам одним запросом: ' + patched)
    assert.ok(patched.includes('status=eq.pending'), 'уже разобранное чужим кодом не переписываем')
    assert.strictEqual(body.barcode, '4870204391237')
    assert.strictEqual(body.status, 'approved', 'код без статуса кассы не заберут')
  }

  // Кнопка обязана обещать ровно то, что изменится: касса шлёт в очередь
  // только несопоставленные строки, и код, которого там нет, не привяжется.
  {
    const real = global.fetch
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('mon_invoice_aliases')) {
        // Ждёт кода только «Пепси»; сметана давно разобрана.
        return new Response(JSON.stringify([{ raw_name_norm: invoiceNameKey('Пепси 0.5') }]), { status: 200 })
      }
      return new Response(JSON.stringify([{ id: 5, items: [
        { name: 'Пепси 0.5', barcode: '4870204391237' },
        { name: 'Сметана Нежный 1,2% / ШК: 4605627012366' },
      ] }]), { status: 200, headers: { 'content-range': '0-0/1' } })
    }
    const r = await call('/api/invoices/pending', {})
    global.fetch = real
    const [row] = (await r.json()).rows
    assert.strictEqual(row.code_count, 1, 'считаем только то, что реально ждёт кода')
    assert.strictEqual(row.items[0].code_done, false, 'ждущая строка помечена как живая')
    assert.strictEqual(row.items[1].code_done, true, 'разобранная — приглушена')
    assert.strictEqual(row.code_total, 2, 'всего кодов в накладной — чтобы отличить «сделано» от «читать нечего»')
  }

  // Подсказка вместо красного кода: замена одной цифры, прошедшая контрольную
  // сумму. Из 117 замен их около десятка, а настоящий товар отсеет справочник.
  const fixes = oneDigitFixes('4605627012365')
  assert.ok(fixes.includes('4605627012366'), 'верный код среди кандидатов')
  assert.ok(fixes.length < 20, 'кандидатов десяток, а не сотня: ' + fixes.length)
  assert.ok(fixes.every(c => c.length === 13), 'длина не меняется')
  assert.deepStrictEqual(oneDigitFixes('12345'), [], 'на мусор кандидатов не строим')

  {
    const real = global.fetch
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('mon_barcodes')) {
        return new Response(JSON.stringify([{ barcode: '4605627012366', name: 'Сметановка 20% 185г' }]), { status: 200 })
      }
      if (u.includes('mon_invoice_aliases')) return new Response('[]', { status: 200 })
      return new Response(JSON.stringify([{ id: 5, items: [
        { name: 'Сметановка 20% 185г / ШК: 4605627012365' },   // распознано с ошибкой в цифре
      ] }]), { status: 200, headers: { 'content-range': '0-0/1' } })
    }
    const [row] = (await (await call('/api/invoices/pending', {})).json()).rows
    global.fetch = real
    assert.deepStrictEqual(row.items[0].code_fix,
      [{ barcode: '4605627012366', name: 'Сметановка 20% 185г' }],
      'подсказываем только те замены, что нашлись в справочнике')
  }

  // «Разобранные» — отдельный список: фото у них стёрто, а текст цел.
  {
    const real = global.fetch
    const asked = []
    global.fetch = async (url) => {
      asked.push(String(url))
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/3' } })
    }
    await call('/api/invoices/pending', { reviewed: true })
    global.fetch = real
    assert.ok(asked[0].includes('reviewed_at=not.is.null'), 'просим именно разобранные: ' + asked[0])
  }

  // Ручная привязка одной строки. Контрольной суммы не требуем — владелец
  // держит бумагу в руках, — но название берём из накладной, а не из запроса.
  assert.strictEqual((await call('/api/invoices/bindOne', { id: 5, index: 0 })).status, 400,
    'без штрихкода — 400')
  assert.strictEqual((await call('/api/invoices/bindOne', { id: 5, barcode: '4605627006662' })).status, 400,
    'без номера строки — 400')
  {
    const real = global.fetch
    let body = null, patched = ''
    global.fetch = async (url, init) => {
      if (init?.method === 'PATCH') {
        patched = String(url); body = JSON.parse(init.body)
        return new Response(JSON.stringify([{ id: 3 }]), { status: 200 })
      }
      return new Response(JSON.stringify([{ items: [{ name: 'Сметановка 20% 185г / ШК: 4605627012365' }] }]), { status: 200 })
    }
    const r = await call('/api/invoices/bindOne', { id: 5, index: 0, barcode: '4605627012365' })
    global.fetch = real
    const d = await r.json()
    assert.strictEqual(r.status, 200, 'привязка не сошедшегося кода проходит — решает человек')
    assert.strictEqual(d.checksum, false, 'но панель говорит, что контрольная не сошлась')
    assert.strictEqual(body.barcode, '4605627012365', 'привязан именно введённый код')
    assert.ok(patched.includes('raw_name_norm=in.'), 'ищем по написанию строки накладной: ' + patched)
  }
  {
    const real = global.fetch
    global.fetch = async (url, init) => init?.method === 'PATCH'
      ? new Response('[]', { status: 200 })
      : new Response(JSON.stringify([{ items: [{ name: 'Пепси 0.5' }] }]), { status: 200 })
    const d = await (await call('/api/invoices/bindOne', { id: 5, index: 0, barcode: '4870204391237' })).json()
    global.fetch = real
    assert.ok(d.note && d.note.includes('Названиях'), 'написания в очереди нет — объясняем, куда идти')
  }

  // Расход берётся только из записанных токенов: накладные без записи в счёт
  // не идут, иначе цена за накладную выйдет ниже настоящей.
  {
    const st = modelStats([
      { model: 'A', items: [], in_tokens: 4000, out_tokens: 5000 },
      { model: 'A', items: [] },                                    // старая, без записи
    ])[0]
    assert.strictEqual(st.invoices, 2, 'обе накладные посчитаны')
    assert.strictEqual(st.paid, 1, 'но расход известен только по одной')
    assert.strictEqual(st.tokOut, 5000, 'исходящие сложены — в них и размышления')
  }

  // Старые распознавания записаны как «claude-sonnet-5», новые — как
  // «anthropic:claude-sonnet-5». Сравнение как есть теряло всю прежнюю
  // статистику: у модели, которой распознано сто накладных, стоял ноль.
  assert.strictEqual(bareModel('anthropic:claude-sonnet-5'), 'claude-sonnet-5')
  assert.strictEqual(bareModel('claude-sonnet-5'), 'claude-sonnet-5')
  {
    const st = modelStats([
      { model: 'claude-sonnet-5', items: [] },
      { model: 'anthropic:claude-sonnet-5', items: [] },
    ])
    assert.strictEqual(st.length, 1, 'обе формы записи — одна модель')
    assert.strictEqual(st[0].invoices, 2)
  }

  // Качество модели считается по самой накладной: количество × цена = сумма
  // строки, сумма строк = напечатанный итог, у штрихкода сходится контрольная.
  {
    const st = modelStats([
      { model: 'A', declared_total: 1100, items: [
        { name: 'Пепси', quantity: 2, price: 500, line_total: 900, barcode: '4870204391237' },  // 2×500 ≠ 900
        { name: 'Кола', quantity: 1, price: 200, line_total: 200, barcode: '4870204391234' },   // код врёт
      ] },
    ])[0]
    assert.strictEqual(st.invoices, 1)
    assert.strictEqual(st.lines, 2)
    assert.strictEqual(st.sumPct, 50, 'одна строка из двух сходится по сумме')
    assert.strictEqual(st.codePct, 50, 'один код из двух проходит контрольную цифру')
    assert.strictEqual(st.totalPct, 100, 'итог 1100 = 900 + 200 — напечатанные суммы строк')
  }
  {
    const empty = modelStats([{ model: 'B', items: [{ name: 'Хлеб' }] }])[0]
    assert.strictEqual(empty.sumPct, null, 'без напечатанных сумм долю не выдумываем')
    assert.strictEqual(empty.codePct, null, 'без кодов — тоже')
  }

  // Смена модели сверяется со списком САМОЙ функции: панель не хранит копию,
  // иначе предлагала бы то, что функция вызвать не умеет.
  {
    const real = global.fetch
    let asked = ''
    global.fetch = async (url) => {
      asked = String(url)
      if (asked.includes('/functions/v1/parse-invoice')) {
        return new Response(JSON.stringify({
          version: 'x', providers: ['anthropic'],
          models: [{ id: 'anthropic:claude-sonnet-5', name: 'Sonnet 5', in: 2, out: 10 }],
        }), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }
    const bad = await call('/api/invoices/setModel', { model: 'anthropic:выдумка' })
    const ok = await call('/api/invoices/setModel', { model: 'anthropic:claude-sonnet-5' })
    global.fetch = real
    assert.strictEqual(bad.status, 400, 'модель не из списка функции — отказ')
    assert.strictEqual(ok.status, 200, 'модель из списка — принимается')
  }
  // Деньги считаются ТОЛЬКО по фактическим токенам и опубликованному прайсу.
  assert.strictEqual(modelCost({ in: 2, out: 10 }, 1e6, 1e6), 12, 'вход по своей цене, выход по своей')
  assert.strictEqual(modelCost({ in: 2, out: 10 }, 0, 0), 0, 'нет токенов — нет суммы')

  // Модель по умолчанию приходит без префикса, список — с префиксом. Пока их
  // сравнивали как есть, ни одна модель не была помечена «сейчас».
  {
    const real = global.fetch
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('/functions/v1/parse-invoice')) {
        return new Response(JSON.stringify({
          model: 'claude-sonnet-5',
          models: [
            { id: 'anthropic:claude-sonnet-5', name: 'Sonnet 5', in: 2, out: 10 },
            { id: 'anthropic:claude-haiku-4-5', name: 'Haiku 4.5', in: 1, out: 5 },
          ],
        }), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }
    const d = await (await call('/api/invoices/models', {})).json()
    global.fetch = real
    assert.strictEqual(d.models.filter(m => m.isCurrent).length, 1, 'ровно одна модель помечена текущей')
    assert.strictEqual(d.models.find(m => m.isCurrent).name, 'Sonnet 5', 'и это модель по умолчанию')
  }

  // Пополнения копятся списком, мусор в него не пускаем: остаток считается
  // от них, и одна кривая строка исказит его молча.
  {
    const real = global.fetch
    let body = null
    global.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('/functions/v1/parse-invoice')) {
        return new Response(JSON.stringify({ models: [{ id: 'a:b', name: 'B', in: 1, out: 5 }] }), { status: 200 })
      }
      if (init?.method === 'POST') { body = JSON.parse(init.body); return new Response(null, { status: 204 }) }
      return new Response('[]', { status: 200 })
    }
    const r = await call('/api/invoices/setModel', { topups: [
      { at: '2026-08-01', usd: 5 },
      { at: 'вчера', usd: 3 },      // без даты — не пополнение
      { at: '2026-08-10', usd: 0 }, // ноль тоже
    ] })
    global.fetch = real
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(body[0].value, [{ at: '2026-08-01', usd: 5 }], 'остались только настоящие пополнения')
  }

  // Фактический расход берём у Anthropic, но только если задан админский ключ:
  // без него панель обязана честно показывать оценку, а не ноль.
  assert.strictEqual(await anthropicCost({}, '2026-08-01', '2026-08-20'), null, 'нет ключа — нет цифры')
  {
    const real = global.fetch
    let asked = ''
    global.fetch = async (url) => {
      asked = String(url)
      // Отчёт отдаёт суммы СТРОКАМИ В ЦЕНТАХ — 250 центов это $2.50.
      return new Response(JSON.stringify({
        data: [{ results: [{ amount: '200' }, { amount: '50' }] }], has_more: false,
      }), { status: 200 })
    }
    const c = await anthropicCost({ ANTHROPIC_ADMIN_KEY: 'k' }, '2026-08-01', '2026-08-20')
    global.fetch = real
    assert.strictEqual(c.usd, 2.5, 'центы переводим в доллары, а не считаем долларами')
    assert.ok(asked.includes('limit=31'), 'просим месяц целиком: по умолчанию отчёт даёт 7 суток')
    assert.strictEqual(c.kzt, undefined, 'в тенге ничего не пересчитываем — курс не наш')
  }
  {
    const real = global.fetch
    global.fetch = async () => new Response('no', { status: 401 })
    const c = await anthropicCost({ ANTHROPIC_ADMIN_KEY: 'k' }, '2026-08-01', '2026-08-20')
    global.fetch = real
    assert.ok(c.error.includes('организации'), 'у личного аккаунта Admin API нет — говорим это прямо')
  }

  console.log('коды из накладных: OK')
}


// Шифрование push сделано руками по RFC 8291, и проверить его иначе как
// расшифровав нечем: push-служба на кривое тело отвечает 201 и молча ничего
// не показывает. Здесь тест играет за браузер — заводит свою пару ключей и
// разбирает то, что отдал воркер.
async function testPushCrypto() {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const text = JSON.stringify({ title: 'iMag', body: 'Касса не работает' })

  const body = new Uint8Array(await encryptPush(text, b64u.enc(uaPub), b64u.enc(auth)))
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)
  assert.strictEqual(rs, 4096, 'размер записи в заголовке')
  assert.strictEqual(body[20], 65, 'длина открытого ключа отправителя')
  const asPub = body.slice(21, 21 + 65)
  const ct = body.slice(21 + 65)

  const hkdf = async (s_, ikm, info, len) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s_, info }, k, len * 8))
  }
  const cat = (...ps) => {
    const out = new Uint8Array(ps.reduce((n, x) => n + x.length, 0))
    let o = 0; for (const x of ps) { out.set(x, o); o += x.length }
    return out
  }
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256))
  const te = new TextEncoder()
  const ikm = await hkdf(auth, shared, cat(te.encode('WebPush: info\0'), uaPub, asPub), 32)
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ct))
  assert.strictEqual(plain[plain.length - 1], 2, 'признак последней записи')
  assert.strictEqual(new TextDecoder().decode(plain.slice(0, -1)), text, 'браузер прочитает то же, что отправили')

  // base64url без «=» и без «+/» — иначе браузер не примет ключ VAPID.
  const enc = b64u.enc(new Uint8Array([251, 255, 190, 0]))
  assert.ok(!/[+/=]/.test(enc), 'base64url, а не обычный base64: ' + enc)
  assert.deepStrictEqual([...b64u.dec(enc)], [251, 255, 190, 0], 'обратный разбор')
  console.log('шифрование push: OK')
}

function testPushEvents() {
  const now = Date.parse('2026-08-21T10:00:00Z')
  const day = 86400000
  const lic = (o) => ({ id: 'L1', customer: 'Марал', revoked: false, hidden: false, ...o })

  // SOS: ключ включает время — вторая авария у той же кассы это новое событие.
  const a = pushEvents({ licenses: [lic({ last_sos_at: new Date(now - 3600e3).toISOString(), last_sos: { status: 'blocked' } })] }, now)
  assert.strictEqual(a.length, 1)
  assert.ok(a[0].body.includes('Марал') && a[0].body.includes('blocked'))
  const b = pushEvents({ licenses: [lic({ last_sos_at: new Date(now - 2 * day).toISOString(), last_sos: {} })] }, now)
  assert.strictEqual(b.length, 0, 'позавчерашний SOS — уже не новость')

  // Окончание подписки: только ближние дни, и только у живых лицензий.
  const soon = new Date(now + 2 * day).toISOString()
  assert.strictEqual(pushEvents({ licenses: [lic({ expires_at: soon })] }, now).length, 1)
  assert.strictEqual(pushEvents({ licenses: [lic({ expires_at: soon, revoked: true })] }, now).length, 0, 'отозванная не тревожит')
  assert.strictEqual(pushEvents({ licenses: [lic({ expires_at: soon, hidden: true })] }, now).length, 0, 'скрытая (своя касса) не тревожит')
  assert.strictEqual(pushEvents({ licenses: [lic({ expires_at: new Date(now + (EXPIRE_SOON_DAYS + 5) * day).toISOString() })] }, now).length, 0)
  assert.strictEqual(pushEvents({ licenses: [lic({ expires_at: new Date(now - 5 * day).toISOString() })] }, now).length, 0,
    'просроченную неделю назад напоминать поздно — это уже разговор, а не срочность')

  // Ключ события устойчив: та же лицензия и та же дата — тот же ключ, значит
  // проверка раз в четверть часа не пришлёт одно и то же 96 раз в сутки.
  const k1 = pushEvents({ licenses: [lic({ expires_at: soon })] }, now)[0].key
  const k2 = pushEvents({ licenses: [lic({ expires_at: soon })] }, now + 3600e3)[0].key
  assert.strictEqual(k1, k2, 'ключ не зависит от момента проверки')

  const r = pushEvents({ requests: [{ machine_id: 'M1', shop: 'Гулдер', city_raw: 'Шиели' }] }, now)
  assert.strictEqual(r[0].key, 'req:M1')
  assert.ok(r[0].body.includes('Гулдер') && r[0].body.includes('Шиели'))
  console.log('события для уведомлений: OK')
}


// Маршрут проверки событий дёргается cron-воркером без пароля — и обязан
// быть безобидным: ничего не отдавать наружу и не слать одно и то же дважды.
async function testPushCheckRoute() {
  const tmp = path.join(os.tmpdir(), 'imag_panel_push_test_' + Date.now() + '.mjs')
  fs.copyFileSync(WORKER_PATH, tmp)
  let worker
  try { worker = (await import(pathToFileURL(tmp).href)).default } finally { fs.unlinkSync(tmp) }
  const ENV = { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' }
  const call = () => worker.fetch(new Request('https://x.test/api/push/check'), ENV)

  const real = global.fetch
  try {
    // Подписок нет — дальше воркер не ходит: некому слать.
    const asked = []
    global.fetch = async (url) => { asked.push(String(url)); return new Response('[]', { status: 200 }) }
    const empty = await (await call()).json()
    assert.strictEqual(empty.subs, 0, 'нет подписок — нет работы')
    assert.strictEqual(asked.length, 1, 'один запрос, а не выборка лицензий впустую')

    // Подписка есть, событие есть, но ключ уже занят прошлой проверкой —
    // уведомление НЕ уходит. Это единственная защита от 96 звонков в сутки.
    let pushed = 0
    global.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('push_subs')) return new Response(JSON.stringify([{ endpoint: 'https://push.test/1', p256dh: 'x', auth: 'y' }]), { status: 200 })
      if (u.includes('activation_requests')) return new Response(JSON.stringify([{ machine_id: 'M1', shop: 'Гулдер' }]), { status: 200 })
      if (u.includes('licenses')) return new Response('[]', { status: 200 })
      // push_state: POST с ignore-duplicates возвращает только новые строки
      if (u.includes('push_state') && init?.method === 'POST') return new Response('[]', { status: 201 })
      if (u.includes('push_state')) return new Response('[]', { status: 200 })
      pushed++
      return new Response('', { status: 201 })
    }
    const seen = await (await call()).json()
    assert.strictEqual(seen.events, 1, 'событие нашли')
    assert.strictEqual(seen.fresh, 0, 'но про него уже уведомляли')
    assert.strictEqual(pushed, 0, 'и второй раз не шлём')
  } finally { global.fetch = real }
  console.log('маршрут проверки событий: OK')
}


// Сводка на телефоне владельца: причина в блоке «требует внимания» — это
// текст, который он читает перед звонком клиенту. Касса, не пробившая ни
// одного чека, писала «нет продаж null дн».
async function testSummaryReasons() {
  const esbuild = await import('esbuild')
  const out = path.join(__dirname, '.summary-test.mjs')
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'views', 'Summary.jsx')],
    bundle: true, format: 'esm', jsx: 'automatic', outfile: out,
    external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' },
  })
  const { renderToString } = await import('react-dom/server')
  const React = await import('react')
  const { default: Summary } = await import(pathToFileURL(out).href)
  fs.unlinkSync(out)

  const year = new Date(Date.now() + 300 * 86400000).toISOString()
  const data = {
    licenses: [
      { subject: 'A', id: 'A', customer: 'Rich smart', expires_at: year, telemetry: true, last_sale_at: null },
      { subject: 'B', id: 'B', customer: 'Марал', expires_at: year, telemetry: true, last_sale_at: new Date(Date.now() - 5 * 86400000).toISOString() },
    ],
    trials: [],
  }
  const html = renderToString(React.createElement(Summary, { data, onOpen() {}, onFilter() {} }))
  assert.ok(!/null/.test(html), 'в причинах не должно быть «null»')
  assert.ok(html.includes('ни одной продажи'), 'касса без единого чека — это «ни одной продажи»')
  assert.ok(html.includes('нет продаж 5 дн'), 'а торговавшая пять дней назад — с числом дней')
  console.log('причины в сводке: OK')
}


// Колонка, которой нет в базе, выглядела как «данных нет»: журнал кассы вечно
// «запрошен», а сохранять его некуда. Панель отступала по колонкам МОЛЧА —
// и причину приходилось искать в Supabase, мимо самой панели.
async function testMissingColumns() {
  const tmp = path.join(os.tmpdir(), 'imag_panel_cols_test_' + Date.now() + '.mjs')
  fs.copyFileSync(WORKER_PATH, tmp)
  let worker
  try { worker = (await import(pathToFileURL(tmp).href)).default } finally { fs.unlinkSync(tmp) }

  const real = global.fetch
  try {
    // Supabase не принимает две последние колонки — как если бы ALTER не выполнили.
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('/licenses?select=')) {
        const asksLog = u.includes('last_log')
        if (asksLog) return new Response('{"message":"column licenses.last_log does not exist"}', { status: 400 })
        return new Response('[]', { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }
    const r = await worker.fetch(new Request('https://x.test/api/clients', {
      method: 'POST', headers: { 'x-panel-key': 'secret' }, body: '{}',
    }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' })
    const d = await r.json()
    assert.ok(Array.isArray(d.missingCols), 'панель отчитывается, что выбросила')
    assert.ok(d.missingCols.includes('last_log'), 'и называет колонку: ' + JSON.stringify(d.missingCols))
    assert.ok(Array.isArray(d.licenses), 'но клиентов всё равно отдаёт — без списка панель бесполезна')
  } finally { global.fetch = real }
  console.log('отсутствующие колонки названы: OK')
}


// Карточка клиента не покрывалась отрисовкой: она видна только при выбранном
// клиенте, и забытый импорт (useApi) собирался без ошибки, а падал уже у
// вендора — ровно посреди разбора аварии. Рендерим её отдельно.
async function testClientCardRender() {
  const esbuild = await import('esbuild')
  const out = path.join(__dirname, '.card-render-test.mjs')
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'views', 'ClientCard.jsx')],
    bundle: true, format: 'esm', jsx: 'automatic', outfile: out,
    external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' },
  })
  globalThis.localStorage ||= {
    store: { panel_pw: 'x' },
    getItem(k) { return this.store[k] ?? null },
    setItem(k, v) { this.store[k] = String(v) },
    removeItem(k) { delete this.store[k] },
  }
  const { renderToString } = await import('react-dom/server')
  const React = await import('react')
  const { default: ClientCard } = await import(pathToFileURL(out).href)
  fs.unlinkSync(out)

  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
  const c = {
    subject: 'a1', id: 'a1', customer: 'Назым', kind: 'license', machine_id: 'M1',
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    last_seen_at: new Date(Date.now() - 9 * 60000).toISOString(),
    log_requested_at: new Date(Date.now() - 53 * 60000).toISOString(),
    last_log_at: null, telemetry: true, days: [{ day: day(1), revenue: 1000, receipts: 2 }],
    renewals: [],
  }
  const html = renderToString(React.createElement(ClientCard, {
    c, onBack() {}, onChanged() {}, kaspiPhone: '', cities: [], missingCols: ['last_log', 'last_log_at'],
  }))
  assert.ok(html.includes('Назым'), 'карточка отрисовалась')
  // Связь после запроса — значит виновата не касса, и это должно быть сказано.
  assert.ok(html.includes('ПОСЛЕ запроса'), 'сказано, что касса выходила на связь после запроса')
  // Колонок нет — сохранять журнал некуда, и молчать об этом нельзя.
  assert.ok(html.includes('нет колонок под журнал'), 'названа причина: нет колонок')
  console.log('карточка клиента: OK')
}

try {
  await testServerRoutes()
  await testAliasRoutes()
  await testHealthRoute()
  await testMissingColumns()
  await testInvoiceCodes()
  await testTrialsMerge()
  await testPushCrypto()
  await testPushCheckRoute()
  testPushEvents()
  testUsageWindows()
  await testViewsRender()
  await testSummaryReasons()
  await testClientCardRender()
  console.log('ВСЁ OK')
} catch (e) {
  console.error('УПАЛО:', e.message)
  process.exit(1)
}
