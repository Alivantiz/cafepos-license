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
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ rows: global.__TEST_ROWS__, kaspiPhone: '' }) })

  const src = fs.readFileSync(WORKER_PATH, 'utf8')
  const idx = src.indexOf('const PAGE')
  const PAGE = eval(src.slice(idx).replace(/^const PAGE = /, ''))
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert.strictEqual(scripts.length, 2, 'expected theme-restore script + main script')
  const mainScript = scripts[1]

  ;['pw', 'login', 'app', 'themeBtn', 'q', 'stats', 'tabs', 'count', 'bulkbar', 'thead', 'tbody', 'cards', 'empty',
    'dlgIssue', 'dlg', 'isCust', 'isDays', 'isTerm', 'isMsg', 'isCopyBtn', 'dlgTitle', 'dlgDays', 'dlgMsg', 'rnCopyBtn',
    'doIssueBtn', 'doRenewBtn', 'refreshBtn'].forEach(id => document.getElementById(id))

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
