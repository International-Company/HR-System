/* Service worker: Web Push only (no offline caching of HR data). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const lang = (self.navigator && self.navigator.language) || 'ar';
  const title = data.title ? (lang.startsWith('ar') ? data.title.ar : data.title.en) : 'HRMS';
  event.waitUntil(
    self.registration.showNotification(title, {
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.id || undefined,
      data: { link: data.link || '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/notifications';
  // Only same-origin relative links are opened.
  const target = link.startsWith('/') ? link : '/notifications';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(target);
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
