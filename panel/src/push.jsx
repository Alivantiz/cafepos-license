// Уведомления на телефон вендора. Работает только у приложения, поставленного
// на домашний экран: закладка Safari push не получает — это ограничение iOS,
// а не настройка, поэтому первым делом объясняем, что нажать.
import { useEffect, useState } from 'react'
import { api } from './api'
import { toast } from './ui'

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => matchMedia('(display-mode: standalone)').matches
  || navigator.standalone === true

// applicationServerKey принимает только байты, а ключ приходит строкой base64url.
function keyBytes(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - t.length % 4) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/** Раздел «Уведомления» окна настроек. Своего окна нет намеренно: настройки
 *  сами открыты окном, а окно поверх окна на телефоне не закрыть. */
export function PushSettings() {
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)

  // Браузер может обновить endpoint подписки сам и молча — тогда на сервере
  // остаётся мёртвый адрес, и уведомления просто перестают приходить. Поэтому
  // при каждом открытии панели переотправляем то, что есть.
  useEffect(() => {
    if (!supported()) return
    let alive = true
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(async sub => {
        if (!alive || !sub) return
        setOn(true)
        await api('push/subscribe', { sub: sub.toJSON() }).catch(() => {})
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const enable = async () => {
    setBusy(true)
    try {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') throw new Error('Уведомления запрещены — включите их в настройках телефона')
      const reg = await navigator.serviceWorker.ready
      const { key } = await api('push/key')
      const sub = await reg.pushManager.getSubscription()
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })
      await api('push/subscribe', { sub: sub.toJSON(), label: navigator.userAgent.slice(0, 100) })
      setOn(true)
      toast.ok('Уведомления включены')
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api('push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
        await sub.unsubscribe()
      }
      setOn(false)
      toast.ok('Уведомления выключены')
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  const check = async () => {
    setBusy(true)
    try {
      const r = await api('push/test')
      // «Отправлено 0» значит, что подписки на сервере нет: сказать «отправил»
      // и оставить телефон молчать — худший из ответов.
      toast[r.sent ? 'ok' : 'err'](r.sent
        ? `Отправлено на ${r.sent} устр.`
        : 'Ни одно устройство не подписано')
    } catch (e) { toast.err(e.message) } finally { setBusy(false) }
  }

  if (!supported()) {
    return isIOS() && !installed()
      ? <p className="muted">
          На iPhone уведомления получает только приложение с домашнего экрана.
          В Safari: «Поделиться» → «На экран «Домой»», открыть iMag оттуда и
          включить здесь.
        </p>
      : <p className="muted">Этот браузер не умеет push-уведомления.</p>
  }
  return (
    <>
      <p className="muted">
        Приходят три вещи: касса сообщила о поломке, новая заявка на активацию,
        у клиента заканчивается подписка. Очередь каталога и накладных не
        тревожит.
      </p>
      <div className="row" style={{ gap: 8 }}>
        {on
          ? <button className="btn" disabled={busy} onClick={disable}>Выключить</button>
          : <button className="btn pri" disabled={busy} onClick={enable}>Включить</button>}
        <button className="btn ghost" disabled={busy || !on} onClick={check}>Проверить</button>
      </div>
    </>
  )
}
