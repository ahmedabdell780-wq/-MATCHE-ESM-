const CACHE_NAME = 'esm-messelmoun-v56';
const ASSETS = [
  './',
  './index.html',
  './logos.js',
  './league-logo.png',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './favicon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch((err) => console.warn('Cache addAll:', err));
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Network-first for HTML, stale-while-revalidate for others
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const isHtml = event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html') || event.request.url.includes('manifest.json');

  if (isHtml) {
    // Network-First: Always try to get the newest index.html from server
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
    );
  } else {
    // Stale-while-revalidate for assets
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        }).catch(() => {});
        return cached || fetchPromise;
      })
    );
  }
});

// Handling Notification Click (Focus window or open app)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const urlToOpen = d.url ? d.url : './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let client of windowClients) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          if (d.kind === 'message') client.postMessage({ type: 'open-message', teamId: d.teamId });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Push notification listener with Badge count support
self.addEventListener('push', (event) => {
  let data = { title: 'منصة مباريات رابطة تيبازة', body: 'تنبيه جديد بخصوص المباريات' };
  if (event.data) {
    try { data = event.data.json(); } catch(e) { data.body = event.data.text(); }
  }
  const options = {
    body: data.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || (data.kind === 'message' ? 'esm-msg' : undefined),
    renotify: !!(data.tag || data.kind === 'message'),
    data: { url: data.url || (data.kind === 'message' ? './index.html#msg' : './index.html'), kind: data.kind, teamId: data.teamId, dateOfArrival: Date.now() },
    actions: [{ action: 'open', title: 'فتح التطبيق' }]
  };
  
  const promiseChain = self.registration.showNotification(data.title, options).then(() => {
    if ('setAppBadge' in navigator) {
      const count = data.badge || 1;
      return navigator.setAppBadge(count).catch(() => {});
    }
  });

  event.waitUntil(promiseChain);
});
