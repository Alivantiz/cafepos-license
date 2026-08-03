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
import { window_, isoDay } from './public/_worker.js'

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

  for (const view of ['summary', 'clients', 'trials', 'requests', 'catalog', 'invoices', 'cloud']) {
    globalThis.location = { hash: '#/' + view, href: 'https://x.test/#/' + view }
    const html = renderToString(React.createElement(App))
    assert.ok(html.includes('iMag'), `вкладка «${view}» отрисовалась`)
  }
  console.log('отрисовка вкладок: OK')
}

try {
  await testServerRoutes()
  testUsageWindows()
  await testViewsRender()
  console.log('ВСЁ OK')
} catch (e) {
  console.error('УПАЛО:', e.message)
  process.exit(1)
}
