// IndexedDB-Wrapper für den lokalen Offline-Datenspeicher.
// Stores:
//   meta                 – Key/Value (Token, Nutzer, letzter Sync-Zeitpunkt)
//   members / helpers    – gecachte Stammdaten
//   events               – gecachte Termine
//   attendance_members   – Präsenz-Einträge Mitglieder (Feld _pending markiert unsynchronisiert)
//   attendance_helpers   – Präsenz-Einträge Helfer   (Feld _pending markiert unsynchronisiert)
const IDB = (() => {
  const DB_NAME = 'jf-praesenz';
  const DB_VERSION = 1;
  const STORES = ['meta', 'members', 'helpers', 'events', 'attendance_members', 'attendance_helpers'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        for (const s of ['members', 'helpers', 'events', 'attendance_members', 'attendance_helpers']) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const os = t.objectStore(store);
      let result;
      Promise.resolve(fn(os)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  return {
    async getMeta(key) { return tx('meta', 'readonly', (os) => reqP(os.get(key))); },
    async setMeta(key, val) { return tx('meta', 'readwrite', (os) => os.put(val, key)); },
    async delMeta(key) { return tx('meta', 'readwrite', (os) => os.delete(key)); },

    async getAll(store) { return tx(store, 'readonly', (os) => reqP(os.getAll())); },
    async get(store, id) { return tx(store, 'readonly', (os) => reqP(os.get(id))); },
    async put(store, obj) { return tx(store, 'readwrite', (os) => os.put(obj)); },
    async del(store, id) { return tx(store, 'readwrite', (os) => os.delete(id)); },

    async replaceAll(store, items) {
      return tx(store, 'readwrite', (os) => {
        os.clear();
        for (const it of items) os.put(it);
      });
    },

    // Fügt Server-Daten ein, überschreibt aber lokale, noch nicht synchronisierte
    // Einträge (_pending) NICHT, damit Offline-Erfassungen nicht verloren gehen.
    async mergeServerAttendance(store, items) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        const os = t.objectStore(store);
        reqP(os.getAll()).then((existing) => {
          const pending = new Set(existing.filter((e) => e._pending).map((e) => e.id));
          os.clear();
          // vorhandene pending-Einträge behalten
          existing.filter((e) => e._pending).forEach((e) => os.put(e));
          // Server-Einträge einspielen, sofern nicht lokal pending
          items.filter((it) => !pending.has(it.id)).forEach((it) => os.put({ ...it, _pending: false }));
        });
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },

    async pending(store) {
      const all = await this.getAll(store);
      return all.filter((r) => r._pending);
    },

    async clearAll() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORES, 'readwrite');
        STORES.forEach((s) => t.objectStore(s).clear());
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },
  };
})();

window.IDB = IDB;
