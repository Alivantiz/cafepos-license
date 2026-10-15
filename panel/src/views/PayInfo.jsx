// «Оплата лицензии»: цена, Kaspi QR и контакты, которые касса показывает на
// экране активации. Раньше всё это было прошито в коде кассы — смена QR или
// цены означала новый релиз и месяцы старых реквизитов у тех, кто не обновился.
// Касса забирает это без пароля (GET /api/pay-info), сохраняет панель (POST).
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { api, money, fmtDate } from '../api'
import { toast } from '../ui'

// Что подставить, пока реквизиты ни разу не сохраняли: ровно то, что сейчас
// прошито в кассе, плюс QR владельца. Сохранить остаётся одной кнопкой.
const DEFAULTS = {
  price: 8000,
  kaspi_qr_url: 'https://qr.kaspi.kz/1117901981537202655411295603746268576476',
  holder: 'Руслан И.',
  phone: '77064060303',
  whatsapp: '',
  note: '',
}

const digits = (s) => String(s ?? '').replace(/\D/g, '')
export const prettyPhone = (s) => {
  const d = digits(s)
  return d.length === 11 ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9)}` : String(s ?? '')
}
const KASPI_RE = /^https:\/\/(?:qr|pay)\.kaspi\.kz\/\S+$/

// QR рисуем SVG-строкой, а не через canvas: так он одинаково работает и в
// браузере, и в тесте отрисовки.
function useQr(text) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!text) { setSrc(null); return }
    let alive = true
    QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then(svg => { if (alive) setSrc('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)) })
      .catch(() => { if (alive) setSrc(null) })
    return () => { alive = false }
  }, [text])
  return src
}

export default function PayInfo() {
  const [f, setF] = useState(null)          // форма; null — ещё грузится
  const [saved, setSaved] = useState(null)  // что сейчас видят кассы (null — не задано)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    // no-store: ответ кэшируется на пять минут для касс, а владелец после
    // сохранения должен видеть своё, а не вчерашнее.
    fetch('/api/pay-info', { cache: 'no-store' })
      .then(async r => {
        const d = await r.json().catch(() => ({}))
        if (r.status === 404) { setF({ ...DEFAULTS }); return }
        if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
        setSaved(d)
        setF({
          price: d.price, kaspi_qr_url: d.kaspi_qr_url || '', holder: d.holder || '',
          phone: d.phone, whatsapp: d.whatsapp === d.phone ? '' : d.whatsapp, note: d.note || '',
        })
      })
      .catch(e => { setLoadErr(e.message || 'Сервер не ответил'); setF({ ...DEFAULTS }) })
  }, [])

  const set = (k) => (e) => { setErr(''); setF(v => ({ ...v, [k]: e.target.value })) }

  const save = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api('pay-info', { ...f, price: Number(f.price) })
      setSaved(r.info)
      toast.ok('Сохранено — кассы подхватят в течение нескольких минут')
    } catch (e) { setErr(e.message); toast.err(e.message) } finally { setBusy(false) }
  }

  if (!f) return <div className="empty">Загрузка…</div>

  const qrUrl = f.kaspi_qr_url.trim()
  const qrOk = !qrUrl || KASPI_RE.test(qrUrl)

  return (
    <div className="payinfo">
      <div className="card payform">
        {loadErr && <div className="muted2" style={{ color: 'var(--bad)' }}>Не удалось прочитать сохранённое: {loadErr}</div>}
        <div className="muted2">
          {saved
            ? `Кассы показывают реквизиты, сохранённые ${fmtDate(saved.updated_at)}.`
            : 'Реквизиты ещё не сохранены — кассы показывают встроенные (8 000 ₸, перевод по номеру, без Kaspi QR).'}
        </div>
        <label>Цена, ₸
          <input type="number" min="1" step="1" inputMode="numeric" value={f.price} onChange={set('price')} />
        </label>
        <label>Ссылка Kaspi QR
          <input value={f.kaspi_qr_url} onChange={set('kaspi_qr_url')} placeholder="https://qr.kaspi.kz/…"
            inputMode="url" autoCapitalize="off" spellCheck={false}
            style={qrOk ? undefined : { borderColor: 'var(--bad)' }} />
          <span className="muted2">Kaspi → Kaspi QR → Поделиться — ссылка вида https://qr.kaspi.kz/…</span>
        </label>
        <label>Получатель
          <input value={f.holder} onChange={set('holder')} placeholder="как в Kaspi, например «Руслан И.»" />
        </label>
        <label>Телефон для перевода
          <input value={f.phone} onChange={set('phone')} placeholder="+7 706 406 03 03" inputMode="tel" />
        </label>
        <label>WhatsApp для чеков
          <input value={f.whatsapp} onChange={set('whatsapp')} placeholder={'как телефон: ' + prettyPhone(f.phone)} inputMode="tel" />
        </label>
        <label>Текст для клиента
          <textarea rows={2} maxLength={300} value={f.note} onChange={set('note')} placeholder="необязательно" />
        </label>
        {err && <div className="card" style={{ borderColor: 'var(--bad)', padding: '8px 12px' }}>{err}</div>}
        <div className="row">
          <button className="btn pri" disabled={busy || !qrOk} onClick={save}>
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {saved?.updated_at && !busy && !err && <span className="muted2">сохранено {new Date(saved.updated_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      </div>

      <div>
        <div className="muted2" style={{ marginBottom: 8 }}>Так это увидит клиент на экране активации</div>
        <PayPreview info={{
          price: Number(f.price) || 0,
          kaspi_qr_url: qrOk ? qrUrl || null : null,
          holder: f.holder.trim() || null,
          phone: digits(f.phone),
          whatsapp: digits(f.whatsapp) || digits(f.phone),
          note: f.note.trim() || null,
        }} />
      </div>
    </div>
  )
}

/** Тот же порядок, что в кассе: ① оплатить по Kaspi QR, ② прислать чек. */
export function PayPreview({ info }) {
  const kaspiQr = useQr(info.kaspi_qr_url)
  // В кассе в сообщение вписан код компьютера — здесь пример.
  const waQr = useQr(info.whatsapp
    ? `https://wa.me/${info.whatsapp}?text=${encodeURIComponent('Лицензия iMag. Магазин: —\nКод компьютера: (код кассы)')}`
    : null)
  return (
    <div className="card paypreview">
      <div className="paysteps">
        <div className="paystep">
          <b>① Оплатите {money(info.price)}</b>
          {info.kaspi_qr_url ? (
            <>
              <div className="qrtile">{kaspiQr && <img src={kaspiQr} alt="Kaspi QR" />}</div>
              <div className="muted2">Kaspi → Сканировать QR{info.holder ? ` · получатель ${info.holder}` : ''}</div>
            </>
          ) : (
            <div className="muted">Переводом на Kaspi по номеру <b>{prettyPhone(info.phone)}</b>
              {info.holder ? ` (${info.holder})` : ''}</div>
          )}
        </div>
        <div className="paystep">
          <b>② Отправьте чек</b>
          <div className="qrtile">{waQr && <img src={waQr} alt="QR WhatsApp" />}</div>
          <div className="muted2">WhatsApp {prettyPhone(info.whatsapp)} — код компьютера уже вписан</div>
        </div>
      </div>
      {info.note && <div className="muted" style={{ marginTop: 10 }}>{info.note}</div>}
    </div>
  )
}
