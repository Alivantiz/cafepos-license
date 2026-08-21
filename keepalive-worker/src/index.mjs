// Автопинг Supabase-проектов через /api/keepalive панели. Секретов нет:
// ключи Supabase живут в переменных окружения Pages-проекта панели, наружу
// endpoint отдаёт только булевы статусы.

// Должно совпадать с расписанием автопинга в wrangler.toml.
const DAILY = '47 15 * * *'

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

// Проверка событий панели: есть ли то, ради чего стоит будить телефон
// (касса сообщила о поломке, новая заявка, кончается подписка). Пароля не
// просит намеренно — endpoint данных наружу не отдаёт, а повторно одно и то же
// уведомление не пошлёт: панель помечает каждое событие в push_state.
//
// Живёт здесь, а не в GitHub Actions: расписание Actions отключается в
// репозитории без коммитов ~60 дней, а авария не ждёт коммита.
async function pushCheck(env) {
  const url = (env.PANEL_URL || 'https://imag-license-panel.pages.dev').replace(/\/$/, '') + '/api/push/check'
  try {
    const r = await fetch(url)
    const d = await r.json().catch(() => ({}))
    // Ничего не произошло — молчим в лог одной строкой, а не портянкой.
    if (d.ok && !d.sent) return { ok: true, quiet: true }
    console.log('push/check', r.status, JSON.stringify(d))
    return { ok: !!d.ok, ...d }
  } catch (e) {
    console.log('push/check error', String(e))
    return { ok: false, error: String(e) }
  }
}

export default {
  // Срабатывает по cron из wrangler.toml. Расписаний два: редкий автопинг
  // Supabase (раз в сутки достаточно, он про семидневный сон) и частая
  // проверка событий — авария у клиента не должна ждать до завтра.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (event.cron === DAILY) await ping(env)
      await pushCheck(env)
    })())
  },
  // Ручная проверка: открыть https://imag-keepalive.<subdomain>.workers.dev
  async fetch(request, env) {
    const r = await ping(env)
    const p = await pushCheck(env)
    return new Response(JSON.stringify({ ...r, push: p }), {
      status: r.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
