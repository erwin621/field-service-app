/* ══════════════════════════════════════════════════════════════════════
   FieldOps Service Worker
   ────────────────────────────────────────────────────────────────────
   Scope: minimal and deliberately conservative. This exists to satisfy
   PWA installability and to give the "Offline access" claim in the
   Install FieldOps sheet something real behind it — it is NOT a
   general-purpose offline data layer for tickets/jobs.

     • App shell (/, manifest.json, icons) — cached for offline
       fallback, refreshed from the network first whenever online.
     • /api/*, /uploads/*, /version.json — NEVER intercepted. These
       always go straight to the network untouched, so ticket sync,
       notifications, photo uploads, and the app's own version check
       behave exactly as they did with no service worker at all.

   Bump CACHE_VERSION any time the app shell changes (in step with the
   version.json / APP_VERSION bumps already used elsewhere) — the old
   cache is deleted automatically on activate.
══════════════════════════════════════════════════════════════════════ */
const CACHE_VERSION='fieldops-shell-v1.4.0';
const APP_SHELL=[
  '/',
  '/manifest.json',
  '/sync-engine.js',
  '/icons/FO_192x192.png',
  '/icons/FO_512x512.png'
];

self.addEventListener('install',(event)=>{
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache)=>cache.addAll(APP_SHELL))
      .catch(()=>{/* a missing shell asset shouldn't block install — offline fallback just won't be complete */})
  );
  self.skipWaiting(); // new SW takes over immediately instead of waiting for all tabs to close
});

self.addEventListener('activate',(event)=>{
  event.waitUntil(
    caches.keys().then((keys)=>
      Promise.all(keys.filter((k)=>k!==CACHE_VERSION).map((k)=>caches.delete(k)))
    )
  );
  self.clients.claim(); // start controlling already-open tabs right away
});

self.addEventListener('fetch',(event)=>{
  const {request}=event;
  const url=new URL(request.url);

  // Only ever handle same-origin GETs. Everything else (POST/PUT/DELETE,
  // cross-origin requests like Google Fonts, etc.) is left completely
  // untouched and falls through to the browser's normal network handling.
  if(request.method!=='GET' || url.origin!==self.location.origin) return;

  // Live data and the app's own freshness check must never be served
  // from cache — always hit the network directly.
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname==='/version.json') return;

  const isAppShellDoc=request.mode==='navigate' || url.pathname==='/' || url.pathname==='/index.html';

  if(isAppShellDoc){
    // Network-first: online users always get the latest deployed code;
    // the cached shell is purely an offline fallback.
    event.respondWith(
      fetch(request)
        .then((response)=>{
          const copy=response.clone();
          caches.open(CACHE_VERSION).then((cache)=>cache.put('/',copy));
          return response;
        })
        .catch(()=>caches.match('/'))
    );
    return;
  }

  // Static assets (manifest, icons, etc.) — cache-first for speed, with
  // a network fallback that quietly refreshes the cache for next time.
  event.respondWith(
    caches.match(request).then((cached)=>{
      if(cached) return cached;
      return fetch(request).then((response)=>{
        if(response.ok){
          const copy=response.clone();
          caches.open(CACHE_VERSION).then((cache)=>cache.put(request,copy));
        }
        return response;
      }).catch(()=>cached);
    })
  );
});

// Chromium-only signal that connectivity is back. iOS/Safari never fires
// this — SyncEngine's own 'online' listener and periodic retry (in
// sync-engine.js) are what cover those platforms, so this is purely an
// extra nudge where the browser supports it, not something else depends on.
self.addEventListener('sync',(event)=>{
  if(event.tag==='fieldops-outbox'){
    event.waitUntil(
      self.clients.matchAll().then((clients)=>
        clients.forEach((c)=>c.postMessage({type:'fieldops-sync-tick'}))
      )
    );
  }
});
