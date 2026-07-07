// Отзыв лицензии в GitHub Actions: добавляет ID в revoked.json и пересобирает подписанный crl.json.
// Приватный ключ — из secret LICENSE_PRIVATE_KEY. ID — из переменной LICENSE_ID.
import { sign as cryptoSign, createPrivateKey } from 'crypto'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'

const keyPem = process.env.LICENSE_PRIVATE_KEY
if (!keyPem) { console.error('Не задан secret LICENSE_PRIVATE_KEY'); process.exit(1) }

const id = (process.env.LICENSE_ID || '').trim()
if (!id) { console.error('Не указан LICENSE_ID'); process.exit(1) }

let revoked = []
if (existsSync('revoked.json')) {
  try { revoked = JSON.parse(readFileSync('revoked.json', 'utf8')) } catch { revoked = [] }
}
revoked = [...new Set([...revoked, id])]
writeFileSync('revoked.json', JSON.stringify(revoked, null, 2))

const payload = { v: 1, issued: new Date().toISOString(), revoked }
const priv = createPrivateKey(keyPem)
const dataB64 = Buffer.from(JSON.stringify(payload)).toString('base64')
const sig = cryptoSign(null, Buffer.from(dataB64, 'base64'), priv).toString('base64')
writeFileSync('crl.json', JSON.stringify({ data: dataB64, sig }))

console.log(`Отозвано лицензий: ${revoked.length}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### 🚫 Лицензия отозвана\n- **ID:** \`${id}\`\n- Всего в списке отзыва: ${revoked.length}\n\n` +
    `\`crl.json\` обновлён и закоммичен — GitHub Pages раздаст новый список. ` +
    `Клиент заблокируется при следующей проверке (в течение суток / при появлении интернета).\n`)
}
