// Service worker: makes the app installable and shows alert pushes. No offline cache: the radar is live data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const d = e.data?.json() ?? {};
  e.waitUntil(self.registration.showNotification(d.title ?? "Flightradar", {
    body: d.body,
    tag: d.hex, // one notification per aircraft, a repeat replaces it
    icon: "/icon-192.png",
    data: { hex: d.hex },
  }));
});

// focus an open radar and select the aircraft, or open one
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hex = e.notification.data?.hex;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    if (windows[0]) {
      windows[0].postMessage({ select: hex });
      return windows[0].focus();
    }
    return self.clients.openWindow(hex ? `/?select=${hex}` : "/");
  }));
});
