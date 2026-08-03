// Выпуск лицензии ФАЙЛОМ — для кассы, которая никогда не выйдет в интернет.
// Кассе с интернетом это не нужно: код активации выдаётся в панели, она же
// продлевает и отзывает. Здесь единственное, чего панель не может, — подписать
// .lic: приватный ключ живёт в secret LICENSE_PRIVATE_KEY, а не в панели.
//
// Строку в таблице licenses заводим ОБЯЗАТЕЛЬНО, хотя оффлайн-касса в неё не
// заглянет: без строки лицензия не видна в панели, не продлевается и не
// отзывается — то есть выпущена и потеряна. Такая же строка, как у обычных.
// Входные параметры — через переменные окружения (их подставляет workflow).
import { sign as cryptoSign, createPrivateKey, randomUUID } from 'crypto'
import { mkdirSync, writeFileSync, appendFileSync } from 'fs'

const keyPem = process.env.LICENSE_PRIVATE_KEY
if (!keyPem) { console.error('Не задан secret LICENSE_PRIVATE_KEY'); process.exit(1) }

const customer = (process.env.CUSTOMER || '').trim()
if (!customer) { console.error('Не указан CUSTOMER'); process.exit(1) }

const machineRaw = (process.env.MACHINE || '').trim()
const days = Number(process.env.DAYS || '365')
const terminals = Number(process.env.TERMINALS || '1')
const id = (process.env.LICENSE_ID || '').trim() || randomUUID()

const now = new Date()
const expires = days > 0 ? new Date(now.getTime() + days * 86400000).toISOString() : null
const payload = {
  v: 1, id, customer,
  issued: now.toISOString(),
  expires,
  machine: machineRaw ? machineRaw.toUpperCase() : null,
  terminals
}

const priv = createPrivateKey(keyPem)
const dataB64 = Buffer.from(JSON.stringify(payload)).toString('base64')
const sig = cryptoSign(null, Buffer.from(dataB64, 'base64'), priv).toString('base64')
const content = JSON.stringify({ data: dataB64, sig })

mkdirSync('out', { recursive: true })
const safe = customer.replace(/[^\wА-Яа-яЁё-]+/g, '_')
writeFileSync(`out/${safe}.lic`, content)

console.log(`Выпущена лицензия: id=${id} customer="${customer}" machine=${payload.machine ?? '(без привязки)'} expires=${expires ?? '(бессрочно)'}`)

// Регистрация в панели. Файл уже подписан и лежит в out/ — падать из-за базы
// нельзя: лицензия годна и без строки, просто станет неуправляемой. Поэтому
// ошибку не глотаем, а выносим в отчёт заметно, чтобы завести руками.
let registered = null
const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  registered = 'не заданы секреты SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'
} else {
  try {
    const res = await fetch(`${url}/rest/v1/licenses`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        id, customer, machine_id: payload.machine, expires_at: expires, terminals,
        // Пометка нужна при разборе: у оффлайн-лицензии last_seen_at всегда
        // пустой, и без неё она выглядит как «выдали и не активировали».
        notes: 'Выпущена файлом (касса без интернета)',
      }),
    })
    if (!res.ok) registered = `${res.status} ${(await res.text()).slice(0, 200)}`
  } catch (e) {
    registered = e instanceof Error ? e.message : String(e)
  }
}
if (registered) console.error(`ВНИМАНИЕ: лицензия НЕ занесена в панель — ${registered}`)

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### ✅ Лицензия выпущена\n` +
    `- **Клиент:** ${customer}\n` +
    `- **ID:** \`${id}\`\n` +
    `- **Машина:** ${payload.machine ?? '(без привязки)'}\n` +
    `- **Срок до:** ${expires ?? '(бессрочно)'}\n\n` +
    (registered
      ? `> ⚠️ **В панель не занесена:** ${registered}\n> Лицензия рабочая, но продлить и отозвать её через панель не выйдет — заведите строку вручную.\n\n`
      : `Видна в панели — продление и отзыв как у обычных.\n\n`) +
    `Скачайте артефакт **license** ниже и отправьте клиенту .lic.\n`)
}
