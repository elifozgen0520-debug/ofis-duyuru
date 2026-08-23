self.addEventListener('push', (event) => {
  let data = { title: '📢 Duyuru', body: 'Yeni bir mesaj var.' };
  try {
    data = event.data.json();
  } catch (e) {}

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
    image: data.image || undefined,
    silent: false,
    vibrate: [700, 200, 700, 200, 700, 200, 700, 200, 700, 200, 700],
    tag: data.id || 'duyuru-pwa',
    renotify: true,
    requireInteraction: true,
    data: { category: data.category || 'genel', urgent: !!data.urgent, id: data.id },
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
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