// Продление лицензии в GitHub Actions: правит expires_at прямо в таблице
// licenses (Supabase), без переподписи файла — касса подхватит новую дату
// сама при следующей проверке /status. Оплата подтверждается вручную (нет
// бизнес-API Kaspi для автоматического вебхука) — этот скрипт лишь убирает
// необходимость лезть в Table Editor руками.
// Сервис-role ключ — из secret SUPABASE_SERVICE_ROLE_KEY. Параметры — через
// переменные окружения (их подставляет workflow).
import { appendFileSync } from 'fs'

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url) { console.error('Не задан SUPABASE_URL'); process.exit(1) }
if (!key) { console.error('Не задан secret SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const id = (process.env.LICENSE_ID || '').trim()
if (!id) { console.error('Не указан LICENSE_ID'); process.exit(1) }

const days = Number(process.env.DAYS || '30')
if (!Number.isFinite(days) || days <= 0) { console.error('DAYS должен быть положительным числом'); process.exit(1) }

const amount = (process.env.AMOUNT || '').trim()
const kaspiPhone = (process.env.OWNER_KASPI_PHONE || '').trim()

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
}

const getRes = await fetch(`${url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}&select=customer,expires_at`, { headers })
if (!getRes.ok) { console.error(`Не удалось прочитать лицензию: ${getRes.status} ${await getRes.text()}`); process.exit(1) }
const rows = await getRes.json()
if (!rows.length) { console.error(`Лицензия с id=${id} не найдена в таблице licenses`); process.exit(1) }
const { customer, expires_at } = rows[0]

const now = new Date()
const current = expires_at ? new Date(expires_at) : null
const base = current && current > now ? current : now
const newExpires = new Date(base.getTime() + days * 86400000).toISOString()

const patchRes = await fetch(`${url}/rest/v1/licenses?id=eq.${encodeURIComponent(id)}`, {
  method: 'PATCH',
  headers: { ...headers, Prefer: 'return=minimal' },
  body: JSON.stringify({ expires_at: newExpires, revoked: false }),
})
if (!patchRes.ok) { console.error(`Не удалось продлить лицензию: ${patchRes.status} ${await patchRes.text()}`); process.exit(1) }

const message = [
  `Здравствуйте! Подходит срок продления iMag Касса (${customer}).`,
  `К оплате: ${amount || 'уточните сумму'} ₸ за ${days} дн.`,
  kaspiPhone ? `Kaspi: ${kaspiPhone}` : 'Kaspi: (номер не задан — добавьте secret OWNER_KASPI_PHONE)',
  'После оплаты касса продлится автоматически при следующей проверке связи.',
].join('\n')

console.log(`Продлено: customer="${customer}" id=${id} → новая дата окончания: ${newExpires}`)
console.log('\nТекст для отправки клиенту:\n' + message)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### ✅ Лицензия продлена\n` +
    `- **Клиент:** ${customer}\n` +
    `- **ID:** \`${id}\`\n` +
    `- **Новая дата окончания:** ${newExpires}\n\n` +
    `**Текст для клиента:**\n\`\`\`\n${message}\n\`\`\`\n`)
}
