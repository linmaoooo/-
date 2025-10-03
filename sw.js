// --- PWA Service Worker (App Shell + runtime cache) ---
const CACHE_VERSION = 'v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './img/九宮格抽獎_背景圖.png',
  './img/九宮格抽獎_標題.png',
  './img/icon-192.png',
  './img/icon-512.png'
];

// 你有呼叫的雲端服務：一律走網路，不進快取（避免資料不一致）
const BYPASS_CACHE_HOSTS = [
  'script.google.com',        // Apps Script
  'sheets.googleapis.com',    // Google Sheets API
  'docs.google.com'           // 任意文件/圖片（若有）
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting(); // 立刻啟用新版本
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // 只攔 GET；POST/PUT（寫回 Sheets）一律放行到網路
  if (req.method !== 'GET') return;

  // 若是要打到 Google 服務，一律直連網路，不快取
  try {
    const url = new URL(req.url);
    if (BYPASS_CACHE_HOSTS.includes(url.hostname)) return;
  } catch (_) {}

  // 導航請求（使用者直接開頁）—優先離線回應 App Shell
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(cached => cached || fetch(req))
    );
    return;
  }

  // 其他靜態資源：Cache First，失敗再回網路
  event.respondWith(
    caches.match(req).then(cached =>
      cached ||
      fetch(req).then(res => {
        // 同源資源才寫入快取
        try {
          const url = new URL(req.url);
          if (location.origin === url.origin) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          }
        } catch (_) {}
        return res;
      })
    )
  );
});
