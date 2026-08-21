// Service worker панели. Две задачи: показывать push-уведомления (без него
// iOS не отдаёт их вообще) и не оставлять приложение белым экраном, когда
// связь пропала на секунду.
//
// Кэш нарочно скупой: index.html всегда берётся из сети (иначе после деплоя
// панель неделю показывает старую сборку), в кэш кладутся только файлы из
// /assets/ — Vite подписывает их хешем в имени, устареть они не могут.
const CACHE = 'imag-panel-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return

  // Навигация: сеть, а при её отсутствии — последняя сохранённая оболочка.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req)
        const c = await caches.open(CACHE)
        c.put('/', res.clone())
        return res
      } catch {
        return (await caches.match('/')) || Response.error()
      }
    })())
    return
  }

  if (!url.pathname.startsWith('/assets/')) return
  e.respondWith((async () => {
    const hit = await caches.match(req)
    if (hit) return hit
    const res = await fetch(req)
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone())
    return res
  })())
})

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { body: e.data && e.data.text() } }
  e.waitUntil(self.registration.showNotification(d.title || 'iMag', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // tag: повторная проверка про то же событие заменяет уведомление, а не
    // копит их стопкой на экране блокировки.
    tag: d.tag || 'imag',
    renotify: !!d.tag,
    data: { url: d.url || '/' },
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/'
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      if (new URL(w.url).origin === location.origin) {
        await w.focus()
        if ('navigate' in w) await w.navigate(url).catch(() => {})
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})
