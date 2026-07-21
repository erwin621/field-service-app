/* ============================================================
   SyncEngine — FieldOps offline data layer
   ------------------------------------------------------------
   Read-through ticket/draft cache + sequenced mutation outbox
   for offline checklist work and ticket submission.

   Drop in as a plain <script> tag BEFORE your main app script,
   same as CamModule / RouteState / GeoEngine. No bundler needed.

   Public API:
     SyncEngine.init()
     SyncEngine.cacheGet(key) / cacheSet(key, data)
     SyncEngine.getDraftRef(ticketId) / setDraftRef(ticketId, draftId)
     SyncEngine.request(ticketId, kind, spec) -> {ok, queued, data|error}
     SyncEngine.requestForm(ticketId, kind, url, formData) -> same shape,
       for call sites that already build a FormData directly (media/submit)
     SyncEngine.flush()
     SyncEngine.pendingCount(ticketId)
     SyncEngine.onSyncUpdate(fn)
   ============================================================ */

const SyncEngine = (function () {

  const DB_NAME = 'fieldops_offline';
  const DB_VERSION = 1;
  const STORE_CACHE = 'cache';
  const STORE_OUTBOX = 'outbox';
  const STORE_DRAFTS = 'draft_refs';

  let _db = null;
  let _dbPromise = null;
  let _seqCounter = 0;          // per-session ordering tiebreaker
  let _listeners = [];          // onSyncUpdate subscribers
  let _flushing = false;        // reentrancy guard
  let _retryTimer = null;

  // ─── low-level IndexedDB helpers ────────────────────────────

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_CACHE)) {
          db.createObjectStore(STORE_CACHE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          const os = db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
          os.createIndex('by_ticket', 'ticket_id', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          db.createObjectStore(STORE_DRAFTS, { keyPath: 'ticket_id' });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(store, mode) {
    return openDB().then(db => db.transaction(store, mode).objectStore(store));
  }

  function idbGet(store, key) {
    return tx(store, 'readonly').then(os => new Promise((res, rej) => {
      const r = os.get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    }));
  }

  function idbPut(store, value) {
    return tx(store, 'readwrite').then(os => new Promise((res, rej) => {
      const r = os.put(value);
      r.onsuccess = () => res(value);
      r.onerror = () => rej(r.error);
    }));
  }

  function idbDelete(store, key) {
    return tx(store, 'readwrite').then(os => new Promise((res, rej) => {
      const r = os.delete(key);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    }));
  }

  function idbGetAll(store) {
    return tx(store, 'readonly').then(os => new Promise((res, rej) => {
      const r = os.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    }));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ─── read-through cache (ticket lists, route data, etc.) ────

  function cacheGet(key) {
    return idbGet(STORE_CACHE, key).then(row => row ? row.data : null);
  }

  function cacheSet(key, data) {
    return idbPut(STORE_CACHE, { key, data, ts: Date.now() });
  }

  // ─── draft refs ──────────────────────────────────────────────
  // Cached the moment a ticket is claimed (while still online) so
  // offline checklist work always has a valid draft_id to attach to.
  // See integration note: prefetch on claim success.

  function getDraftRef(ticketId) {
    return idbGet(STORE_DRAFTS, ticketId).then(row => row ? row.draft_id : null);
  }

  function setDraftRef(ticketId, draftId) {
    return idbPut(STORE_DRAFTS, { ticket_id: ticketId, draft_id: draftId, cached_at: Date.now() });
  }

  // ─── outbox ──────────────────────────────────────────────────

  function enqueue(ticketId, kind, spec, presetId) {
    const item = {
      id: presetId || uuid(),
      ticket_id: ticketId,
      seq: Date.now() + (_seqCounter++ / 1000),   // preserves call order within a ticket
      kind,                                        // 'response' | 'media' | 'progress' | 'submit' | ...
      url: spec.url,
      method: spec.method || 'POST',
      json: spec.json || null,                     // JSON-body requests
      form: spec.form || null,                      // { fields: {...}, files: [{field, blob, filename}] }
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString()
    };
    // stamp a client-side idempotency key into the payload so a retried
    // request can be deduped server-side instead of double-inserting
    if (item.json) item.json.client_ref = item.id;
    if (item.form) item.form.fields = { ...(item.form.fields || {}), client_ref: item.id };

    return idbPut(STORE_OUTBOX, item).then(() => {
      _notify();
      registerBackgroundSync();
      // opportunistic immediate attempt in case connectivity is actually fine
      // and the original failure was a fluke (e.g. one dropped packet)
      scheduleFlush(500);
      return item.id;
    });
  }

  function pendingCount(ticketId) {
    return idbGetAll(STORE_OUTBOX).then(rows => {
      const pending = rows.filter(r => r.status === 'pending' || r.status === 'error');
      return ticketId ? pending.filter(r => r.ticket_id === ticketId).length : pending.length;
    });
  }

  function onSyncUpdate(fn) { _listeners.push(fn); }

  function _notify() {
    pendingCount().then(n => _listeners.forEach(fn => { try { fn(n); } catch (e) {} }));
  }

  // ─── the main entry point: try live, fall back to queue ───────
  //
  // IMPORTANT: this only queues on a genuine connectivity failure
  // (fetch throws / TypeError). A server response that arrives but
  // rejects the request (409 draft incomplete, 401, validation error)
  // is NOT queued — that's a real answer from the server and must
  // surface to the technician, not be silently retried later.

  async function request(ticketId, kind, spec) {
    // Generated up front (not just at enqueue time) so a request that's
    // actually processed by the server but whose response never makes it
    // back — a common field-connectivity failure mode, not just "never
    // sent" — is still protected by the same idempotency key on retry.
    const clientRef = uuid();
    const opts = { method: spec.method || 'POST' };
    let bodyForNetwork;

    if (spec.form) {
      const fd = new FormData();
      Object.entries({ ...(spec.form.fields || {}), client_ref: clientRef }).forEach(([k, v]) => fd.append(k, v));
      (spec.form.files || []).forEach(f => fd.append(f.field, f.blob, f.filename || 'upload'));
      bodyForNetwork = fd;
    } else if (spec.json) {
      opts.headers = { 'Content-Type': 'application/json' };
      bodyForNetwork = JSON.stringify({ ...spec.json, client_ref: clientRef });
    }
    if (bodyForNetwork !== undefined) opts.body = bodyForNetwork;

    try {
      const res = await fetch(spec.url, opts);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, queued: false, status: res.status, error: err.error || `Request failed (${res.status})` };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: true, queued: false, data };
    } catch (networkErr) {
      // fetch threw -> actual connectivity failure, not a server rejection
      const id = await enqueue(ticketId, kind, spec, clientRef);
      return { ok: true, queued: true, id };
    }
  }

  // Convenience path for call sites that already build a FormData object
  // directly (troubleshooting media, ticket submit) instead of the
  // {fields, files} shape — avoids having to restructure existing
  // FormData-building code just to use SyncEngine.
  async function requestForm(ticketId, kind, url, formData) {
    const clientRef = uuid();
    formData.append('client_ref', clientRef);
    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, queued: false, status: res.status, error: err.error || `Request failed (${res.status})` };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: true, queued: false, data };
    } catch (networkErr) {
      const spec = { url, method: 'POST', form: formDataToSpec(formData) };
      const id = await enqueue(ticketId, kind, spec, clientRef);
      return { ok: true, queued: true, id };
    }
  }

  function formDataToSpec(fd) {
    const fields = {};
    const files = [];
    for (const [key, value] of fd.entries()) {
      if (value instanceof Blob) {
        files.push({ field: key, blob: value, filename: value.name || 'upload' });
      } else {
        fields[key] = value;   // this app's forms don't repeat non-file field names
      }
    }
    return { fields, files };
  }

  // ─── replay engine ──────────────────────────────────────────
  // Groups queued items by ticket_id and replays each ticket's
  // items strictly in seq order. A failed item halts that ticket's
  // chain (later steps depend on earlier ones succeeding) but does
  // not block other tickets' independent queues.

  async function flush() {
    if (_flushing) return;
    if (!navigator.onLine) return;
    _flushing = true;
    try {
      const rows = await idbGetAll(STORE_OUTBOX);
      const pending = rows.filter(r => r.status === 'pending' || r.status === 'error');
      if (!pending.length) return;

      const byTicket = {};
      pending.forEach(r => { (byTicket[r.ticket_id] = byTicket[r.ticket_id] || []).push(r); });
      Object.values(byTicket).forEach(list => list.sort((a, b) => a.seq - b.seq));

      await Promise.all(Object.values(byTicket).map(replayChain));
    } finally {
      _flushing = false;
      _notify();
      const remaining = await pendingCount();
      if (remaining > 0) scheduleFlush(30000);  // gentle retry while work remains
    }
  }

  async function replayChain(items) {
    for (const item of items) {
      item.status = 'syncing';
      await idbPut(STORE_OUTBOX, item);

      const opts = { method: item.method };
      let body;
      if (item.form) {
        const fd = new FormData();
        Object.entries(item.form.fields || {}).forEach(([k, v]) => fd.append(k, v));
        (item.form.files || []).forEach(f => fd.append(f.field, f.blob, f.filename || 'upload'));
        body = fd;
      } else if (item.json) {
        opts.headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify(item.json);
      }
      if (body !== undefined) opts.body = body;

      try {
        const res = await fetch(item.url, opts);
        if (!res.ok) {
          // server rejected it even on replay (e.g. stale state) — stop this
          // ticket's chain here rather than firing later dependent steps
          item.status = 'error';
          item.attempts += 1;
          item.lastError = `HTTP ${res.status}`;
          await idbPut(STORE_OUTBOX, item);
          break;
        }
        await idbDelete(STORE_OUTBOX, item.id);
      } catch (networkErr) {
        // dropped again mid-replay — leave pending, stop this chain, try later
        item.status = 'pending';
        item.attempts += 1;
        item.lastError = String(networkErr);
        await idbPut(STORE_OUTBOX, item);
        break;
      }
    }
  }

  function scheduleFlush(delayMs) {
    clearTimeout(_retryTimer);
    _retryTimer = setTimeout(flush, delayMs);
  }

  function registerBackgroundSync() {
    // Chromium-only; iOS Safari has no SyncManager. The online-listener +
    // periodic retry below is the universal fallback for every platform.
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready
        .then(reg => reg.sync.register('fieldops-outbox'))
        .catch(() => {});
    }
  }

  // ─── wiring ─────────────────────────────────────────────────

  function init() {
    openDB().then(flush);
    window.addEventListener('online', () => scheduleFlush(0));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleFlush(0);
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'fieldops-sync-tick') scheduleFlush(0);
      });
    }
  }

  return {
    init, cacheGet, cacheSet, getDraftRef, setDraftRef,
    request, requestForm, flush, pendingCount, onSyncUpdate
  };

})();
