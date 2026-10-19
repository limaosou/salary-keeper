/* Service Worker：网络优先 + 离线兜底
   目的是让「快捷指令自动打开页面」时即使网络不佳也能秒开，不是为了做离线应用 */
const CACHE = 'salary-keeper-v6';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/holidays.js',
  './js/storage.js',
  './js/salary.js',
  './js/geo.js',
  './js/app.js',
  './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())      // 个别资源失败也要完成安装
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;

  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});