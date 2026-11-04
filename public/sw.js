/* Push delivery only. Personal pages and API responses are never cached here. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function safeUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    return url.origin === self.location.origin && ["http:", "https:"].includes(url.protocol) ? url.href : new URL("/", self.location.origin).href;
  } catch { return new URL("/", self.location.origin).href; }
}
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { payload = {}; }
  event.waitUntil(self.registration.showNotification(typeof payload.title === "string" ? payload.title : "TMI 세탁실 알림", {
    body: typeof payload.body === "string" ? payload.body : "내 대기와 사용 현황을 확인해 주세요.",
    icon: "/pwa-192.png",
    badge: "/pwa-icon.svg",
    tag: payload.eventId || payload.tag || undefined,
    data: { url: safeUrl(payload.url || payload.data?.url) },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && "focus" in client) {
        await client.navigate(url);
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
