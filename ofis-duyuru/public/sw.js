// Service Worker: telefon uygulaması kapalıyken bile push bildirimini yakalar.

self.addEventListener('push', (event) => {
  let data = { title: '📢 Duyuru', body: 'Yeni bir mesaj var.' };
  try {
    data = event.data.json();
  } catch (e) {
    // veri parse edilemezse varsayılanı kullan
  }

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Acil duyurularda titreşim deseni farklı olsun
    vibrate: data.urgent ? [200, 100, 200, 100, 200] : [100],
    tag: data.category || 'genel',
    renotify: true,
    requireInteraction: !!data.urgent,
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
