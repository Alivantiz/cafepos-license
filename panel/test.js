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

  const authed = (path, body) => worker.fetch(new Request('https://x.test' + path, {
    method: 'POST', headers: { 'x-panel-key': 'secret' }, body: JSON.stringify(body || {})
  }), { PANEL_PASSWORD: 'secret', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'k' })

  const noSecrets = await worker.fetch(new Request('https://x.test/api/db/tables', {
    method: 'POST', headers: { 'x-panel-key': 'secret' }
  }), { PANEL_PASSWORD: 'secret' })
  assert.strictEqual(noSecrets.status, 500, 'db route without Supabase secrets should 500')

  const badTable = await authed('/api/db/rows', { table: 'x; drop' })
  assert.strictEqual(badTable.status, 400, 'non-identifier table name should 400')

  const badPk = await authed('/api/db/update', { table: 'licenses', pk: 'id=1', pkValue: 'a', values: { customer: 'x' } })
  assert.strictEqual(badPk.status, 400, 'non-identifier pk name should 400')

  const noPkValue = await authed('/api/db/delete', { table: 'licenses', pk: 'id' })
  assert.strictEqual(noPkValue.status, 400, 'delete without pkValue should 400')

  const emptyInsert = await authed('/api/db/insert', { table: 'licenses', values: {} })
  assert.strictEqual(emptyInsert.status, 400, 'insert without values should 400')

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
    if (u.includes('/api/db/tables')) return { tables: [
      { name: 'barcodes', columns: [
        { name: 'id', type: 'integer', format: 'bigint', pk: true },
        { name: 'barcode', type: 'string', format: 'text', pk: false },
        { name: 'name', type: 'string', format: 'text', pk: false }
      ] },
      { name: 'licenses', columns: [
        { name: 'id', type: 'string', format: 'uuid', pk: true },
        { name: 'customer', type: 'string', format: 'text', pk: false },
        { name: 'terminals', type: 'integer', format: 'integer', pk: false }
      ] }
    ] }
    if (u.includes('/api/db/rows')) return { rows: [{ id: 1, barcode: '4870001234567', name: 'Товар' }], total: 1 }
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
    'navSubs', 'navDb', 'viewSubs', 'viewDb', 'dbTable', 'dbq', 'dbCount', 'dbGrid', 'dbEmpty', 'dbMore',
    'dlgDb', 'dlgDbTitle', 'dlgDbSub', 'dbFields', 'dbDelBtn', 'dbSaveBtn'].forEach(id => document.getElementById(id))

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
  await switchView('db')
  global.__RESULT__.dbTablesLen = dbTables.length
  global.__RESULT__.dbTableName = dbTable
  global.__RESULT__.dbPkName = dbPk()
  global.__RESULT__.dbGridHtml = document.getElementById('dbGrid').innerHTML
  global.__RESULT__.dbCountText = document.getElementById('dbCount').textContent
  global.__RESULT__.dbViewShown = document.getElementById('viewDb').style.display
  global.__RESULT__.subsViewHidden = document.getElementById('viewSubs').style.display
  await switchView('subs')
  global.__RESULT__.dbViewHiddenBack = document.getElementById('viewDb').style.display
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

  assert.strictEqual(res.dbTablesLen, 2, 'switchView(db) should load the table list')
  assert.strictEqual(res.dbTableName, 'barcodes', 'a barcode-looking table should be picked by default')
  assert.strictEqual(res.dbPkName, 'id', 'pk should be detected from the <pk/> column flag')
  assert.ok(res.dbGridHtml.includes('barcode'), 'db grid header should include column names')
  assert.ok(res.dbGridHtml.includes('4870001234567'), 'db grid body should include loaded row values')
  assert.strictEqual(res.dbCountText, '1 из 1', 'db count should reflect loaded rows and total')
  assert.strictEqual(res.dbViewShown, '', 'db view should be visible after switchView(db)')
  assert.strictEqual(res.subsViewHidden, 'none', 'subs view should hide when db view is active')
  assert.strictEqual(res.dbViewHiddenBack, 'none', 'switching back should hide the db view')

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
