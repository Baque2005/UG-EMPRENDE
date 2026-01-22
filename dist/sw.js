/* Service Worker: recibe push y muestra notificación */
self.addEventListener('push', function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Notificación', body: event.data?.text() || '' };
  }

  const title = data.title || 'Notificación';
  const options = {
    body: data.body || data.message || '',
    data: { url: data.url },
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-72.png',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  if (url) {
    event.waitUntil(clients.matchAll({ type: 'window' }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    }));
  }
});
