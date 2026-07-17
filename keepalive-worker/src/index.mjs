// Автопинг Supabase-проектов через /api/keepalive панели. Секретов нет:
// ключи Supabase живут в переменных окружения Pages-проекта панели, наружу
// endpoint отдаёт только булевы статусы.

async function ping(env) {
  const url = (env.PANEL_URL || 'https://imag-license-panel.pages.dev').replace(/\/$/, '') + '/api/keepalive'
  try {
    const r = await fetch(url)
    const d = await r.json().catch(() => ({}))
    // console.log виден в дашборде: Workers → imag-keepalive → Logs
    console.log('keepalive', r.status, JSON.stringify(d))
    return { ok: r.ok && d.ok === true, status: r.status, licenses: d.licenses, monitor: d.monitor }
  } catch (e) {
    console.log('keepalive error', String(e))
    return { ok: false, error: String(e) }
  }
}

export default {
  // Срабатывает по cron из wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ping(env))
  },
  // Ручная проверка: открыть https://imag-keepalive.<subdomain>.workers.dev
  async fetch(request, env) {
    const r = await ping(env)
    return new Response(JSON.stringify(r), {
      status: r.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
