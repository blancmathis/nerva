const SHELL_CACHE_PREFIX = "codex-pad-shell-";
const SHELL_CACHE = "__CODEX_PAD_SHELL_CACHE__";
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/app-meta.json",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];
const BUILD_ASSET_URLS = __NERVA_BUILD_ASSETS__;
const SHELL_ASSET_PATTERN = /(?:src|href)=["'](\/assets\/[^"'<>]+)["']/g;

function expectedContentType(pathname) {
  if (pathname.endsWith(".js")) return "javascript";
  if (pathname.endsWith(".css")) return "text/css";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webmanifest")) return "application/manifest+json";
  if (pathname.endsWith(".json")) return "application/json";
  return null;
}

async function fetchShellResource(pathname) {
  const response = await fetch(new Request(pathname, { cache: "reload" }));
  if (!response.ok) throw new Error(`Unable to cache ${pathname} (${response.status})`);
  const expected = expectedContentType(pathname);
  const actual = response.headers.get("content-type") ?? "";
  if (expected !== null && !actual.toLowerCase().includes(expected)) {
    throw new Error(`Refusing invalid shell resource ${pathname} (${actual || "missing content type"})`);
  }
  return response;
}

async function cacheShell() {
  const response = await fetch(new Request("/", { cache: "reload" }));
  if (!response.ok) throw new Error(`Unable to cache the PWA shell (${response.status})`);
  const rootContentType = response.headers.get("content-type") ?? "";
  if (!rootContentType.toLowerCase().includes("text/html")) {
    throw new Error(`Refusing invalid PWA shell (${rootContentType || "missing content type"})`);
  }
  const markup = await response.clone().text();
  const assets = [...markup.matchAll(SHELL_ASSET_PATTERN)].map((match) => match[1]);
  // Every emitted JS/CSS chunk is part of the atomic shell, including lazy
  // offline-first surfaces such as Capture Inbox, Drawing and Review.
  const resources = [...SHELL_URLS, ...new Set([...assets, ...BUILD_ASSET_URLS])];
  try {
    const cache = await caches.open(SHELL_CACHE);
    const fetched = await Promise.all(resources.map(async (pathname) => [pathname, await fetchShellResource(pathname)]));
    await Promise.all(fetched.map(([pathname, resource]) => cache.put(pathname, resource)));
    // Commit the shell document only after every referenced startup asset is
    // present, so a failed upgrade cannot replace a bootable offline shell.
    await cache.put("/", response);
  } catch (error) {
    await caches.delete(SHELL_CACHE);
    throw error;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      )),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    // A new release gets its own atomically installed cache. Never overwrite
    // the last bootable root document before that release's assets are ready.
    event.respondWith(fetch(request).catch(async () => (await caches.match("/")) ?? Response.error()));
    return;
  }

  const shellAsset = url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/icons/")
    || url.pathname === "/app-meta.json"
    || url.pathname === "/manifest.webmanifest";
  if (!shellAsset) return;
  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })),
  );
});

function safePushPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const kinds = new Set(["approval", "question", "error", "completed", "results"]);
  if (data.version !== 1 || !kinds.has(data.kind)) return null;
  const title = typeof data.title === "string" ? data.title.trim().slice(0, 100) : "";
  const body = typeof data.body === "string" ? data.body.trim().slice(0, 240) : "";
  const tag = typeof data.tag === "string" ? data.tag.trim().slice(0, 160) : "nerva-update";
  const badgeCount = Number.isSafeInteger(data.badgeCount) && data.badgeCount >= 0 && data.badgeCount <= 12
    ? data.badgeCount
    : 0;
  const target = data.target && typeof data.target === "object" && !Array.isArray(data.target)
    ? data.target
    : null;
  const threadId = typeof target?.threadId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(target.threadId)
    ? target.threadId.toLowerCase()
    : null;
  const safeTarget = target?.view === "mission"
    ? { view: "mission" }
    : target?.view === "session" && threadId !== null
      ? { view: "session", threadId }
      : null;
  if (!title || safeTarget === null) return null;
  const url = safeTarget.view === "mission"
    ? "/?open=mission"
    : `/?open=session&thread=${encodeURIComponent(safeTarget.threadId)}`;
  return { title, body, tag, url, target: safeTarget, badgeCount };
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = null;
    try { payload = safePushPayload(event.data?.json()); } catch { /* reject malformed push payloads */ }
    if (!payload) return;
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url, target: payload.target },
    });
    if ("setAppBadge" in self.navigator) {
      if (payload.badgeCount === 0 && "clearAppBadge" in self.navigator) await self.navigator.clearAppBadge();
      else if (payload.badgeCount > 0) await self.navigator.setAppBadge(payload.badgeCount);
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  const target = event.notification.data?.target;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      existing.postMessage({ type: "nerva-notification-open", target });
      await existing.focus();
      return;
    }
    await self.clients.openWindow(url);
  })());
});
