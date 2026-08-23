self.addEventListener('push', (event) => {
  let data = { title: '📢 Duyuru', body: 'Yeni bir mesaj var.' };
  try {
    data = event.data.json();
  } catch (e) {}

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    image: data.image || undefined,
    vibrate: data.urgent ? [200, 100, 200, 100, 200] : [100],
    tag: data.category || 'genel',
    renotify: true,
    requireInteraction: !!data.urgent,
    data: { category: data.category || 'genel', urgent: !!data.urgent, id: data.id },
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'NOTIF_OPENED', ...data, title: event.notification.title, body: event.notification.body });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));