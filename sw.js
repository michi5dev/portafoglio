// Quando modifichi l'app, aumenta questo numero: il telefono scaricherà i file nuovi.
const VERSIONE = 'portafoglio-v1';
const FILE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSIONE).then(c => c.addAll(FILE.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSIONE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'AGGIORNA') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSIONE);
    // Le pagine aprono sempre l'app salvata, anche con indirizzi diversi
    if (req.mode === 'navigate') {
      return (await cache.match('./index.html')) || fetch(req);
    }
    const salvato = await cache.match(req, { ignoreSearch: true });
    if (salvato) return salvato;
    try {
      const risposta = await fetch(req);
      if (risposta.ok) cache.put(req, risposta.clone());
      return risposta;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
