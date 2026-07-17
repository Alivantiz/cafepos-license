// Смоук-тест панели подписок: гоняет серверный fetch() и клиентский <script>
// из PAGE через DOM-заглушку, проверяет, что типовые сценарии не сломаны.
// Запуск: node panel/test.js
'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const WORKER_PATH = path.join(__dirname, 'public', '_worker.js')

function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, disabled: false,
    className: '', checked: false,
    addEventListener() {}, focus() {}, showModal() {}, close() {}
  }
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

  const home = await worker.fetch(new Request('https://x.test/'), {})
  assert.strictEqual(home.status, 200, 'GET / should return 200')
  const html = await home.text()
  assert.ok(html.includes('<title>iMag'), 'home page should contain the panel title')

  const notFound = await worker.fetch(new Request('https://x.test/nope'), {})
  assert.strictEqual(notFound.status, 404, 'unknown non-api path should 404')

  const noAuth = await worker.fetch(new Request('https://x.test/api/list', { method: 'POST' }), { PANEL_PASSWORD: 'secret' })
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

  console.log('server routes: OK')
}

async function testClientScript() {
  const elements = {}
  global.document = {
    getElementById(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id] },
    documentElement: { setAttribute() {} },
    createElement() { return makeEl('_dyn') },
    body: { appendChild() {} }
  }
  global.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null },
    setItem(k, v) { this._d[k] = v },
    removeItem(k) { delete this._d[k] }
  }
  // Node 21+ ships a built-in read-only `navigator` global — override via defineProperty.
  Object.defineProperty(global, 'navigator', {
    value: { clipboard: { writeText() { return Promise.resolve() } } },
    configurable: true, writable: true
  })
  global.confirm = () => true
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => {
    const u = String(url)
    if (u.includes('/api/catalog/pending')) return { total: 1, rows: [
      { venue_id: 'venue-1', barcode: '4870001234567', name: 'Кола 0.5', category: 'Напитки', price: 350, unit: 'шт', status: 'pending' }
    ] }
    if (u.includes('/api/catalog/similar')) return { rows: [
      { barcode: '4870005555555', name: 'Кола 0,5 ПЭТ', match_kind: 'fuzzy', score: 0.62 },
      { barcode: '4870001234567', name: 'Кола 0.5', match_kind: 'fuzzy', score: 0.95 }
    ] }
    if (u.includes('/api/catalog/list')) return { total: 1, rows: [
      { venue_id: 'panel-owner', barcode: '4870009999999', name: 'Хлеб', category: null, price: 200, unit: 'шт', status: 'approved' }
    ] }
    return { rows: global.__TEST_ROWS__, kaspiPhone: '' }
  } })

  const src = fs.readFileSync(WORKER_PATH, 'utf8')
  const idx = src.indexOf('const PAGE')
  const PAGE = eval(src.slice(idx).replace(/^const PAGE = /, ''))
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert.strictEqual(scripts.length, 2, 'expected theme-restore script + main script')
  const mainScript = scripts[1]

  ;['pw', 'login', 'app', 'themeBtn', 'q', 'stats', 'tabs', 'count', 'bulkbar', 'thead', 'tbody', 'cards', 'empty',
    'dlgIssue', 'dlg', 'isCust', 'isDays', 'isTerm', 'isMsg', 'isCopyBtn', 'dlgTitle', 'dlgDays', 'dlgMsg', 'rnCopyBtn',
    'doIssueBtn', 'doRenewBtn', 'refreshBtn',
    'navSubs', 'navCat', 'viewSubs', 'viewCat', 'catq', 'catBulkbar', 'catPendAll', 'catPendBody', 'catPendEmpty',
    'catPendCount', 'catListCount', 'catBody', 'catEmpty', 'dlgCat', 'dlgCatTitle', 'catBarcode', 'catName',
    'catCategory', 'catUnit', 'catPrice', 'catDelBtn', 'catSaveBtn', 'navCatBadge'].forEach(id => document.getElementById(id))

  const day = 86400000, now = Date.now()
  global.__TEST_ROWS__ = [
    { id: 'a', customer: 'Expired Co', expires_at: new Date(now - 3 * day).toISOString(), terminals: 1, activated_at: new Date(now - 10 * day).toISOString(), last_seen_at: new Date(now - 9 * day).toISOString(), revoked: false, notes: null, created_at: new Date(now - 50 * day).toISOString() },
    { id: 'b', customer: 'Soon Co', expires_at: new Date(now + 3 * day).toISOString(), terminals: 1, activated_at: new Date(now - 5 * day).toISOString(), last_seen_at: new Date().toISOString(), revoked: false, notes: 'важный клиент', created_at: new Date(now - 20 * day).toISOString() },
    { id: 'c', customer: 'Revoked Co', expires_at: new Date(now + 30 * day).toISOString(), terminals: 1, activated_at: new Date(now - 5 * day).toISOString(), last_seen_at: new Date().toISOString(), revoked: true, notes: null, created_at: new Date(now - 5 * day).toISOString() },
    { id: 'd', customer: 'Active Co', expires_at: new Date(now + 60 * day).toISOString(), terminals: 3, activated_at: new Date(now - 5 * day).toISOString(), last_seen_at: new Date().toISOString(), revoked: false, notes: null, created_at: new Date(now - 1 * day).toISOString() }
  ]

  // Driver runs INSIDE the same eval() as the script itself, so it shares its
  // real `let rows`/`render`/etc bindings (a separate eval() call would not).
  const driver = `
;(async () => {
  await load()
  global.__RESULT__ = {
    rowsLen: rows.length,
    bucketA: bucket(rows.find(r=>r.id==='a')),
    bucketB: bucket(rows.find(r=>r.id==='b')),
    bucketC: bucket(rows.find(r=>r.id==='c')),
    bucketD: bucket(rows.find(r=>r.id==='d')),
    tbodyLen: document.getElementById('tbody').innerHTML.length,
    cardsLen: document.getElementById('cards').innerHTML.length,
    chartBuckets: chartData().length,
    countText: document.getElementById('count').textContent
  }
  setFilter('revoked')
  global.__RESULT__.afterRevokedFilterCount = document.getElementById('count').textContent
  setFilter('revoked')
  global.__RESULT__.afterToggleBackCount = document.getElementById('count').textContent
  await switchView('cat')
  global.__RESULT__.navBadgeText = document.getElementById('navCatBadge').textContent
  global.__RESULT__.navBadgeShown = document.getElementById('navCatBadge').style.display
  global.__RESULT__.catPendingLen = catPending.length
  global.__RESULT__.catRowsLen = catRows.length
  global.__RESULT__.catPendBodyHtml = document.getElementById('catPendBody').innerHTML
  global.__RESULT__.catBodyHtml = document.getElementById('catBody').innerHTML
  global.__RESULT__.catPendCountText = document.getElementById('catPendCount').textContent
  global.__RESULT__.catListCountText = document.getElementById('catListCount').textContent
  global.__RESULT__.catViewShown = document.getElementById('viewCat').style.display
  global.__RESULT__.subsViewHidden = document.getElementById('viewSubs').style.display
  toggleCatPendAll(true)
  global.__RESULT__.catSelectedAfterAll = catSelected.size
  await showCatSimilar('venue-1', '4870001234567')
  global.__RESULT__.simHtml = document.getElementById('catPendBody').innerHTML
  await showCatSimilar('venue-1', '4870001234567')
  global.__RESULT__.simHtmlAfterToggle = document.getElementById('catPendBody').innerHTML
  await switchView('subs')
  global.__RESULT__.catViewHiddenBack = document.getElementById('viewCat').style.display
})()
`
  eval(mainScript + driver)
  await new Promise(r => setTimeout(r, 50))
  const res = global.__RESULT__

  assert.strictEqual(res.rowsLen, 4, 'load() should populate rows from the fetch mock')
  assert.strictEqual(res.bucketA, 'expired', 'past expires_at should bucket as expired')
  assert.strictEqual(res.bucketB, 'soon', 'expires_at within 7 days should bucket as soon')
  assert.strictEqual(res.bucketC, 'revoked', 'revoked flag wins regardless of dates')
  assert.strictEqual(res.bucketD, 'active', 'far-future expires_at should bucket as active')
  assert.ok(res.tbodyLen > 0, 'tbody should be populated after load()')
  assert.ok(res.cardsLen > 0, 'cards should be populated after load()')
  assert.strictEqual(res.chartBuckets, 6, 'chartData should always return 6 monthly buckets')
  assert.strictEqual(res.countText, '4 из 4', 'count should reflect all rows shown with no filter')
  assert.strictEqual(res.afterRevokedFilterCount, '1 из 4', 'revoked filter should narrow to the one revoked row')
  assert.strictEqual(res.afterToggleBackCount, '4 из 4', 'clicking the active filter again should reset to all')

  assert.strictEqual(res.navBadgeText, 1, 'nav badge should show the pending-queue total')
  assert.strictEqual(res.navBadgeShown, '', 'nav badge should be visible when the queue is non-empty')
  assert.strictEqual(res.catPendingLen, 1, 'switchView(cat) should load the pending queue')
  assert.strictEqual(res.catRowsLen, 1, 'switchView(cat) should load the approved catalog')
  assert.ok(res.catPendBodyHtml.includes('4870001234567'), 'pending queue should show the submitted barcode')
  assert.ok(res.catBodyHtml.includes('4870009999999'), 'catalog list should show the approved barcode')
  assert.strictEqual(res.catPendCountText, '1 из 1', 'pending count should reflect loaded rows and total')
  assert.strictEqual(res.catListCountText, '1 из 1', 'catalog count should reflect loaded rows and total')
  assert.strictEqual(res.catViewShown, '', 'catalog view should be visible after switchView(cat)')
  assert.strictEqual(res.subsViewHidden, 'none', 'subs view should hide when catalog view is active')
  assert.strictEqual(res.catSelectedAfterAll, 1, 'select-all on the pending queue should select every row')
  assert.ok(res.simHtml.includes('Кола 0,5 ПЭТ') && res.simHtml.includes('62%'), 'similar hint should list fuzzy matches with score')
  assert.ok(res.simHtml.includes('тот же штрихкод'), 'similar hint should flag a match with the same barcode')
  assert.ok(!res.simHtmlAfterToggle.includes('Похожие в каталоге'), 'second click should hide the similar hint')
  assert.strictEqual(res.catViewHiddenBack, 'none', 'switching back should hide the catalog view')

  console.log('client script: OK')
}

;(async () => {
  try {
    await testServerRoutes()
    await testClientScript()
    console.log('ALL OK')
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exit(1)
  }
})()
