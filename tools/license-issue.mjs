// Выпуск лицензии в GitHub Actions. Приватный ключ берётся из secret LICENSE_PRIVATE_KEY.
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

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### ✅ Лицензия выпущена\n` +
    `- **Клиент:** ${customer}\n` +
    `- **ID:** \`${id}\`\n` +
    `- **Машина:** ${payload.machine ?? '(без привязки)'}\n` +
    `- **Срок до:** ${expires ?? '(бессрочно)'}\n\n` +
    `Скачайте артефакт **license** ниже и отправьте клиенту .lic.\n`)
}
