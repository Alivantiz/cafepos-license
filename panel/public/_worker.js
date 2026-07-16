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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)

    if (pathname === '/' || pathname === '/index.html') {
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    if (!pathname.startsWith('/api/')) return new Response('Not found', { status: 404 })

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
<style>
  :root{--bg:#0a0a0b;--panel:#18181b;--b:#27272a;--b2:#3f3f46;--fg:#fafafa;--mut:#a1a1aa;--mut2:#71717a;
    --pri:hsl(243 80% 62%);--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}
  *{box-sizing:border-box;margin:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg);
    min-height:100vh;padding:24px 16px}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:20px;margin-bottom:4px}
  .sub{color:var(--mut2);font-size:13px;margin-bottom:18px}
  .bar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  input[type=search],input[type=password]{flex:1;min-width:160px;background:var(--panel);border:1px solid var(--b2);
    border-radius:10px;padding:9px 12px;color:var(--fg);font-size:14px;outline:none}
  input:focus{border-color:var(--pri)}
  button{background:var(--panel);border:1px solid var(--b2);border-radius:9px;padding:8px 13px;color:var(--fg);
    font-size:13px;font-weight:600;cursor:pointer}
  button:hover{border-color:var(--pri)}
  button.pri{background:var(--pri);border-color:var(--pri);color:#fff}
  .card{background:var(--panel);border:1px solid var(--b);border-radius:14px;padding:14px 16px;margin-bottom:10px}
  .row1{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cust{font-weight:700;font-size:15px}
  .pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap}
  .pill.ok{background:#052e1a;color:var(--ok);border:1px solid #14532d}
  .pill.warn{background:#2a1a05;color:var(--warn);border:1px solid #78350f}
  .pill.bad{background:#2d0a0a;color:var(--bad);border:1px solid #7f1d1d}
  .pill.mut{background:#1c1c1f;color:var(--mut);border:1px solid var(--b2)}
  .meta{color:var(--mut2);font-size:12px;margin-top:6px;display:flex;gap:14px;flex-wrap:wrap}
  .meta b{color:var(--mut);font-weight:600}
  .acts{margin-left:auto;display:flex;gap:8px}
  .idline{font-family:ui-monospace,monospace;font-size:11px;color:var(--mut2);margin-top:6px;word-break:break-all;cursor:pointer}
  .idline:hover{color:var(--mut)}
  .empty{color:var(--mut2);text-align:center;padding:40px 0}
  .toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#052e1a;border:1px solid #14532d;
    color:var(--ok);padding:9px 16px;border-radius:10px;font-size:13px;z-index:10;max-width:90vw}
  .toast.err{background:#2d0a0a;border-color:#7f1d1d;color:var(--bad)}
  dialog{background:var(--panel);border:1px solid var(--b2);border-radius:14px;color:var(--fg);padding:20px;
    max-width:420px;width:92vw}
  dialog::backdrop{background:rgba(0,0,0,.72)}
  dialog h3{font-size:15px;margin-bottom:12px}
  dialog .drow{display:flex;gap:8px;margin:12px 0}
  dialog input[type=number]{width:100px;background:var(--bg);border:1px solid var(--b2);border-radius:9px;
    padding:8px 10px;color:var(--fg);font-size:14px}
  dialog textarea{width:100%;height:120px;background:var(--bg);border:1px solid var(--b2);border-radius:9px;
    padding:8px 10px;color:var(--mut);font-size:12px;resize:none;margin-top:10px}
  .stat{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .st{background:var(--panel);border:1px solid var(--b);border-radius:11px;padding:9px 14px;font-size:12px;color:var(--mut)}
  .st b{display:block;font-size:18px;color:var(--fg);font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div class="wrap">
  <h1>Подписки iMag</h1>
  <div class="sub">Таблица licenses · продление и отзыв применяются кассой при ближайшей проверке связи</div>

  <div id="login" class="bar" style="display:none">
    <input id="pw" type="password" placeholder="Пароль панели" />
    <button class="pri" onclick="savePw()">Войти</button>
  </div>

  <div id="app" style="display:none">
    <div class="stat" id="stats"></div>
    <div class="bar">
      <input id="q" type="search" placeholder="Поиск по клиенту / ID…" oninput="render()" />
      <button class="pri" onclick="openIssue()">+ Выпустить</button>
      <button onclick="load()">Обновить</button>
      <button onclick="logout()" title="Забыть пароль на этом устройстве">Выйти</button>
    </div>
    <div id="list"></div>
  </div>
</div>

<dialog id="dlgIssue">
  <h3>Выпустить лицензию</h3>
  <div class="drow"><input id="isCust" style="flex:1;background:var(--bg);border:1px solid var(--b2);border-radius:9px;padding:8px 10px;color:var(--fg);font-size:14px" placeholder="Клиент (название точки)" /></div>
  <div class="drow">
    <input id="isDays" type="number" min="0" value="30" /> <span style="align-self:center;color:var(--mut)">дней (0 = бессрочная)</span>
  </div>
  <div class="drow">
    <input id="isTerm" type="number" min="1" value="1" /> <span style="align-self:center;color:var(--mut)">касс</span>
    <span style="flex:1"></span>
    <button onclick="dlgIssue.close()">Отмена</button>
    <button class="pri" onclick="doIssue()">Выпустить</button>
  </div>
  <textarea id="isMsg" readonly placeholder="После выпуска здесь появится код активации и текст для клиента"></textarea>
  <div class="drow"><span style="flex:1"></span><button onclick="copyIssue()">Скопировать текст</button></div>
</dialog>

<dialog id="dlg">
  <h3 id="dlgTitle"></h3>
  <div class="drow">
    <input id="dlgDays" type="number" min="1" value="30" /> <span style="align-self:center;color:var(--mut)">дней</span>
    <span style="flex:1"></span>
    <button onclick="dlg.close()">Отмена</button>
    <button class="pri" onclick="doRenew()">Продлить</button>
  </div>
  <textarea id="dlgMsg" readonly placeholder="После продления здесь появится текст для клиента"></textarea>
  <div class="drow"><span style="flex:1"></span><button onclick="copyMsg()">Скопировать текст</button></div>
</dialog>

<script>
let rows = [], kaspiPhone = '', renewId = null
const $ = id => document.getElementById(id)
const pw = () => localStorage.getItem('panel_pw') || ''

function savePw(){ localStorage.setItem('panel_pw', $('pw').value); boot() }
function logout(){ localStorage.removeItem('panel_pw'); boot() }

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
  document.body.appendChild(t); setTimeout(() => t.remove(), 3500)
}

const fmtDate = s => s ? new Date(s).toLocaleDateString('ru-RU') : '—'
const daysLeft = s => s ? Math.ceil((new Date(s) - Date.now()) / 86400000) : null
const daysAgo  = s => s ? Math.floor((Date.now() - new Date(s)) / 86400000) : null

function statusPill(r){
  if (r.revoked) return '<span class="pill bad">отозвана</span>'
  const d = daysLeft(r.expires_at)
  if (d === null) return '<span class="pill ok">бессрочная</span>'
  if (d <= 0) return '<span class="pill bad">истекла</span>'
  if (d <= 7) return '<span class="pill warn">истекает через ' + d + ' дн</span>'
  return '<span class="pill ok">до ' + fmtDate(r.expires_at) + ' (' + d + ' дн)</span>'
}
function seenPill(r){
  if (!r.activated_at) return '<span class="pill mut">не активирована</span>'
  const d = daysAgo(r.last_seen_at)
  if (d === null) return '<span class="pill mut">на связи не была</span>'
  if (d > 7) return '<span class="pill warn">на связи ' + d + ' дн назад</span>'
  return '<span class="pill mut">на связи: ' + (d === 0 ? 'сегодня' : d + ' дн назад') + '</span>'
}
// Сортировка: сначала требующие внимания (истекли/скоро), бессрочные в конце
const sortKey = r => r.revoked ? 1e9 : (daysLeft(r.expires_at) ?? 1e8)

function render(){
  const q = $('q').value.trim().toLowerCase()
  const shown = rows
    .filter(r => !q || (r.customer || '').toLowerCase().includes(q) || r.id.includes(q))
    .sort((a, b) => sortKey(a) - sortKey(b))
  const soon = rows.filter(r => !r.revoked && daysLeft(r.expires_at) !== null && daysLeft(r.expires_at) <= 7 && daysLeft(r.expires_at) > 0).length
  const dead = rows.filter(r => !r.revoked && daysLeft(r.expires_at) !== null && daysLeft(r.expires_at) <= 0).length
  $('stats').innerHTML =
    '<div class="st">Всего<b>' + rows.length + '</b></div>' +
    '<div class="st">Истекает ≤7 дн<b style="color:var(--warn)">' + soon + '</b></div>' +
    '<div class="st">Истекло<b style="color:var(--bad)">' + dead + '</b></div>' +
    '<div class="st">Отозвано<b>' + rows.filter(r => r.revoked).length + '</b></div>'
  $('list').innerHTML = shown.length ? shown.map(r =>
    '<div class="card">' +
      '<div class="row1">' +
        '<span class="cust">' + esc(r.customer || '(без имени)') + '</span>' +
        statusPill(r) + seenPill(r) +
        '<span class="acts">' +
          '<button onclick="openRenew(\\'' + r.id + '\\')">Продлить</button>' +
          (r.revoked
            ? '<button onclick="revoke(\\'' + r.id + '\\', false)">Вернуть</button>'
            : '<button onclick="revoke(\\'' + r.id + '\\', true)">Отозвать</button>') +
        '</span>' +
      '</div>' +
      '<div class="meta">' +
        '<span>Касс: <b>' + (r.terminals ?? 1) + '</b></span>' +
        '<span>Активирована: <b>' + fmtDate(r.activated_at) + '</b></span>' +
        (r.notes ? '<span>' + esc(r.notes) + '</span>' : '') +
      '</div>' +
      '<div class="idline" title="Скопировать ID" onclick="copyId(\\'' + r.id + '\\')">' + r.id + '</div>' +
    '</div>').join('') : '<div class="empty">Ничего не найдено</div>'
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))

async function load(){
  try { const d = await api('list'); rows = d.rows; kaspiPhone = d.kaspiPhone; render() }
  catch(e){ toast(e.message, true) }
}

const dlgIssue = $('dlgIssue')
function openIssue(){ $('isCust').value = ''; $('isMsg').value = ''; dlgIssue.showModal(); $('isCust').focus() }
async function doIssue(){
  try {
    const d = await api('issue', { customer: $('isCust').value, days: Number($('isDays').value), terminals: Number($('isTerm').value) })
    toast('Выпущена: ' + d.id)
    $('isMsg').value = 'Код активации iMag Касса: ' + d.id + '\\n' +
      (d.expires_at ? 'Действует до: ' + fmtDate(d.expires_at) + '\\n' : 'Бессрочная\\n') +
      'Введите код на экране активации приложения — касса привяжется к этому компьютеру автоматически.'
    load()
  } catch(e){ toast(e.message, true) }
}
function copyIssue(){ navigator.clipboard.writeText($('isMsg').value); toast('Скопировано') }

const dlg = $('dlg')
function openRenew(id){
  renewId = id
  const r = rows.find(x => x.id === id)
  $('dlgTitle').textContent = 'Продлить: ' + (r?.customer || id)
  $('dlgMsg').value = ''
  dlg.showModal()
}
async function doRenew(){
  const days = Number($('dlgDays').value)
  try {
    const d = await api('renew', { id: renewId, days })
    toast('Продлено до ' + fmtDate(d.expires_at))
    $('dlgMsg').value = 'Здравствуйте! iMag Касса (' + d.customer + ') продлена на ' + days +
      ' дн, до ' + fmtDate(d.expires_at) + '.' + (kaspiPhone ? ' Оплата: Kaspi ' + kaspiPhone + '.' : '') +
      ' Касса подхватит продление сама при ближайшей проверке связи.'
    load()
  } catch(e){ toast(e.message, true) }
}
function copyMsg(){ navigator.clipboard.writeText($('dlgMsg').value); toast('Скопировано') }
function copyId(id){ navigator.clipboard.writeText(id); toast('ID скопирован') }

async function revoke(id, flag){
  const r = rows.find(x => x.id === id)
  if (flag && !confirm('Отозвать лицензию «' + (r?.customer || id) + '»? Касса клиента заблокируется при ближайшей проверке связи.')) return
  try { await api('revoke', { id, revoked: flag }); toast(flag ? 'Отозвана' : 'Возвращена'); load() }
  catch(e){ toast(e.message, true) }
}

function boot(){
  const has = !!pw()
  $('login').style.display = has ? 'none' : 'flex'
  $('app').style.display = has ? '' : 'none'
  if (has) load()
}
boot()
</script>
</body>
</html>`
