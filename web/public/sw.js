/**
 * TermWatch の Service Worker。
 *
 * 役割は通知の受信と、タップで画面を開くことだけ。
 * オフライン用のキャッシュは持たない（PCが動いていなければ意味がないため）。
 */

self.addEventListener('push', (event) => {
  let payload = { title: 'TermWatch', body: '出力が止まりました' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed !== null) payload = parsed;
    }
  } catch {
    // 本文を読めなくても通知自体は出す。
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'TermWatch', {
      body: payload.body ?? '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'termwatch-idle',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    }),
  );
});
