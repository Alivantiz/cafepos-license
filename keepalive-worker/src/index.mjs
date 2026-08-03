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

// Ежедневные отчёты владельцу: лицензии на контроль + воронка триалов.
// Логика живёт в панели (/api/cron/daily) рядом с данными, здесь только
// будильник. Маршрут закрыт паролем панели — держим его секретом Worker'а
// (`wrangler secret put PANEL_PASSWORD`), отдельный ключ заводить незачем.
async function daily(env) {
  const url = (env.PANEL_URL || 'https://imag-license-panel.pages.dev').replace(/\/$/, '') + '/api/cron/daily'
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'x-panel-key': env.PANEL_PASSWORD || '' } })
    const d = await r.json().catch(() => ({}))
    console.log('daily', r.status, JSON.stringify(d))
    return { ok: r.ok && d.ok === true, status: r.status, ...d }
  } catch (e) {
    console.log('daily error', String(e))
    return { ok: false, error: String(e) }
  }
}

// Два расписания в одном Worker'е: какое сработало — видно в event.cron.
// Держать ради отчёта отдельный Worker незачем, а cron-триггеров у одного
// может быть сколько угодно.
const DAILY_CRON = '0 4 * * *'   // 09:00 по Алматы

export default {
  // Срабатывает по cron из wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === DAILY_CRON ? daily(env) : ping(env))
  },
  // Ручная проверка: открыть https://imag-keepalive.<subdomain>.workers.dev
  // (?daily=1 — прогнать отчёты сейчас, не дожидаясь утра)
  async fetch(request, env) {
    const r = new URL(request.url).searchParams.has('daily') ? await daily(env) : await ping(env)
    return new Response(JSON.stringify(r), {
      status: r.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
