const CACHE = 'lingxi-v1';
const PRECACHE = ['./', './index.html', './xg.png', './manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(PRECACHE))
    );
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const url = e.request.url;

    // 跳过 API 调用和跨域请求
    if (url.includes('workers.dev') ||
        url.includes('deepseek') ||
        url.includes('googleapis') ||
        !url.startsWith(self.location.origin)) return;

    const isHTML = e.request.destination === 'document' || url.endsWith('.html') || url.endsWith('/');

    if (isHTML) {
        // HTML：网络优先，确保每次都拿到最新版本；离线时才用缓存兜底
        e.respondWith(
            fetch(e.request).then(resp => {
                if (resp && resp.ok) {
                    const clone = resp.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return resp;
            }).catch(() => caches.match(e.request))
        );
    } else {
        // 图片/其他静态资源：缓存优先
        e.respondWith(
            caches.match(e.request).then(cached => {
                if (cached) return cached;
                return fetch(e.request).then(resp => {
                    if (resp && resp.ok) {
                        const clone = resp.clone();
                        caches.open(CACHE).then(c => c.put(e.request, clone));
                    }
                    return resp;
                });
            })
        );
    }
});
