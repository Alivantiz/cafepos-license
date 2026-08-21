// Иконки панели: PNG 180/192/512 для apple-touch-icon и manifest.
// Рисуем headless-хромом. Две его особенности, из-за которых нельзя просто
// снять окно нужного размера: вьюпорт на 87px ниже окна (за пределами вьюпорта
// элементы не рисуются) и минимальная ширина окна 500px. Поэтому снимаем с
// запасом и обрезаем PNG до квадрата.
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { deflateSync, inflateSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = process.argv[2] || fileURLToPath(new URL('../panel/public/', import.meta.url))
const CHROME = '/opt/pw-browsers/chromium'
const GAP = 87
const MINW = 500
mkdirSync(OUT, { recursive: true })

// Знак: «iM» на фирменном фиолетовом (--primary кассы), под ним две полоски —
// чековая лента.
const html = (s) => `<!doctype html><meta charset="utf-8"><style>
*{margin:0;padding:0}
.ico{position:absolute;left:0;top:0;width:${s}px;height:${s}px;overflow:hidden;
  background:linear-gradient(160deg,#7C68D9 0%,#5B45B8 100%);
  display:flex;align-items:center;justify-content:center;
  font-family:"Helvetica Neue",Arial,sans-serif}
.m{color:#fff;font-size:${s * 0.4}px;font-weight:700;letter-spacing:${-s * 0.02}px;
  position:relative;top:${-s * 0.105}px}
.m b{font-weight:800}
.tape{position:absolute;left:${s * 0.27}px;right:${s * 0.27}px;bottom:${s * 0.285}px;
  height:${s * 0.05}px;background:rgba(255,255,255,.92);border-radius:${s * 0.025}px}
.tape2{position:absolute;left:${s * 0.35}px;right:${s * 0.35}px;bottom:${s * 0.2}px;
  height:${s * 0.05}px;background:rgba(255,255,255,.55);border-radius:${s * 0.025}px}
</style><div class="ico"><div class="m">i<b>M</b></div>
<div class="tape"></div><div class="tape2"></div></div>`

const crc32 = (buf) => {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// Обрезка PNG до квадрата size×size от левого верхнего угла.
function cropSquare(file, size) {
  const d = readFileSync(file)
  const w = d.readUInt32BE(16), h = d.readUInt32BE(20)
  const ct = d[25]
  if (ct !== 2 && ct !== 6) throw new Error('неожиданный colortype ' + ct)
  const bpp = ct === 2 ? 3 : 4
  let i = 8, idat = []
  while (i < d.length) {
    const ln = d.readUInt32BE(i), type = d.toString('ascii', i + 4, i + 8)
    if (type === 'IDAT') idat.push(d.subarray(i + 8, i + 8 + ln))
    i += 12 + ln
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp + 1
  // разворачиваем фильтры
  const rows = []
  let prev = Buffer.alloc(w * bpp)
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride]
    const line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride))
    for (let x = 0; x < line.length; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      if (f === 1) line[x] = (line[x] + a) & 255
      else if (f === 2) line[x] = (line[x] + b) & 255
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    rows.push(line); prev = line
  }
  const outStride = size * bpp + 1
  const out = Buffer.alloc(outStride * size)
  for (let y = 0; y < size; y++) {
    out[y * outStride] = 0
    rows[y].copy(out, y * outStride + 1, 0, size * bpp)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = ct
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

for (const size of [180, 192, 512]) {
  const page = resolve(OUT, `_icon${size}.html`)
  const png = join(OUT, `icon-${size}.png`)
  writeFileSync(page, html(size))
  execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${Math.max(MINW, size)},${size + GAP}`,
    `--screenshot=${png}`, 'file://' + page], { stdio: 'pipe' })
  cropSquare(png, size)
  rmSync(page)
  console.log('иконка', size)
}
