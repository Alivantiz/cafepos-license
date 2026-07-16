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
  .tabs-deco span{padding:7px 13px;border-radius:8px;font-size:13px;font-weight:500;color:var(--mut2)}
  .tabs-deco span.active{font-weight:600;color:var(--fg);background:var(--panel2)}
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

  #bulkbar{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding:11px 16px;
    background:oklch(0.76 0.16 62 / .1);border:1px solid var(--brand);border-radius:12px;animation:rise .18s ease}
  #bulkbar .lbl{font-size:13px;font-weight:600;color:var(--fg)}
  #bulkbar .sp{flex:1}
  #bulkbar button{height:34px;padding:0 13px;border-radius:8px;font-size:12.5px;font-weight:700;border:1px solid var(--b2);background:var(--panel);color:var(--fg)}
  #bulkbar button.pri{background:var(--brand);border-color:var(--brand);color:var(--accent-fg)}
  #bulkbar button.bad{color:var(--bad);font-weight:600}
  #bulkbar button.plain{background:transparent;color:var(--mut);font-weight:600}

  .tablewrap{background:var(--panel);border:1px solid var(--b);border-radius:15px;overflow:hidden}
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

  @media (max-width:760px){
    .wrap{padding:20px 14px 70px}
    .desktop-only{display:none}
    .statgrid{grid-template-columns:1fr 1fr;gap:10px}
    .chartcard{grid-column:1 / -1}
    .table-desktop{display:none}
    .card-view{display:block}
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
    <nav class="tabs-deco desktop-only">
      <span class="active">Подписки</span>
      <span aria-disabled="true">Клиенты</span>
      <span aria-disabled="true">Оплаты</span>
    </nav>
    <div class="topbar-right">
      <button id="themeBtn" class="icon-btn" onclick="toggleTheme()" title="Сменить тему">☀</button>
      <button id="refreshBtn" class="btn desktop-only" onclick="load()">Обновить</button>
      <button class="btn pri" onclick="openIssue()">+ Выпустить</button>
    </div>
  </header>

  <main class="wrap">
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
        <input id="q" type="search" oninput="render()" placeholder="Поиск по клиенту или ID активации…" />
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
  shown = shown.filter(r => !q || (r.customer || '').toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
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
    $('bulkbar').style.display = 'flex'
    $('bulkbar').innerHTML =
      '<span class="lbl">Выбрано: ' + selected.size + '</span><div class="sp"></div>' +
      '<button class="pri" onclick="bulkRenew()">Продлить на 30 дн</button>' +
      '<button class="bad" onclick="bulkRevoke()">Отозвать</button>' +
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
        '<span class="cust-id" data-id="' + r.id + '" title="Скопировать ID" onclick="copyId(this.dataset.id)">' + r.id + '</span>' +
        '<span class="note-ic' + (r.notes ? ' has' : '') + '" data-id="' + r.id + '" title="' + noteTitle + '" onclick="editNotes(this.dataset.id)">✎</span>' +
      '</div></div>' +
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
      '</div></div>' +
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
async function bulkRevoke(){
  const ids = [...selected]; if (!ids.length) return
  if (!confirm('Отозвать ' + ids.length + ' лицензий?')) return
  const res = await Promise.allSettled(ids.map(id => api('revoke', { id, revoked: true })))
  const ok = res.filter(r => r.status === 'fulfilled').length
  toast(ok === ids.length ? ('Отозвано: ' + ok) : ('Отозвано: ' + ok + ', ошибок: ' + (ids.length - ok)), ok < ids.length)
  clearSelection(); load()
}

function boot(){
  applyTheme()
  const has = !!pw()
  $('login').style.display = has ? 'none' : 'flex'
  $('app').style.display = has ? '' : 'none'
  if (has) load()
}
;[dlgIssue, dlg].forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close() }))
boot()
</script>
</body>
</html>`
