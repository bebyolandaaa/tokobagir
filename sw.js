// ================================================
// TOKO BAGIR - sw.js (Service Worker)
// Notifikasi push ke HP walaupun tab tidak aktif
// ================================================
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || '🛒 Toko Bagir', {
      body: data.body || 'Ada notifikasi baru',
      icon: data.icon || '/favicon.ico',
      badge: data.badge || '/favicon.ico',
      vibrate: [200, 100, 200],
      tag: data.tag || 'toko-bagir',
      data: data.url || '/',
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) { list[0].focus(); return; }
      clients.openWindow(e.notification.data || '/');
    })
  );
});

// Background sync — cek notif baru setiap 30 detik via periodic bg fetch
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-notif') {
    e.waitUntil(checkAndNotify());
  }
});

async function checkAndNotify() {
  try {
    const cache = await caches.open('bagir-notif-v1');
    const countRes = await cache.match('last-notif-count');
    const lastCount = countRes ? Number(await countRes.text()) : 0;

    // Ambil token dari cache
    const tokenRes = await cache.match('admin-token');
    if (!tokenRes) return;
    const token = await tokenRes.text();
    if (!token) return;

    // Ambil API URL dari cache
    const urlRes = await cache.match('api-url');
    const apiUrl = urlRes ? await urlRes.text() : '';
    if (!apiUrl) return;

    const resp = await fetch(`${apiUrl}?action=getNotifications`);
    const data = await resp.json();
    if (!data.success) return;

    const unread = (data.data || []).filter(n => n.isRead !== true && n.isRead !== 'true');
    const count  = unread.length;

    if (count > lastCount && unread[0]) {
      const n = unread[0];
      await self.registration.showNotification('🛒 Toko Bagir — Pesanan Baru!', {
        body: n.message,
        tag: 'bagir-order-' + n.id,
        vibrate: [200, 100, 200],
      });
    }
    await cache.put('last-notif-count', new Response(String(count)));
  } catch(e) {}
}