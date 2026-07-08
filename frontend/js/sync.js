// Sync-Layer: Offline-Queue-Pattern.
// Präsenz-Einträge werden lokal in IndexedDB mit _pending=true gespeichert und
// bei bestehender Verbindung an /api/sync/push gesendet. /api/sync/bootstrap
// lädt den kompletten Datenstand zum lokalen Cachen.
const Sync = (() => {
  let syncing = false;
  const listeners = new Set();

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.random().toString(16).slice(2));

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  async function emit() {
    const pending = (await IDB.pending('attendance_members')).length
      + (await IDB.pending('attendance_helpers')).length;
    const state = { online: navigator.onLine, syncing, pending };
    listeners.forEach((fn) => fn(state));
  }

  // Vollständigen Serverstand laden und lokal cachen
  async function bootstrap() {
    const data = await API.get('/sync/bootstrap');
    await IDB.replaceAll('members', data.members);
    await IDB.replaceAll('helpers', data.helpers);
    await IDB.replaceAll('events', data.events);
    await IDB.mergeServerAttendance('attendance_members', data.attendance_members);
    await IDB.mergeServerAttendance('attendance_helpers', data.attendance_helpers);
    await IDB.setMeta('last_sync', data.server_time);
    await emit();
  }

  // Lokale, nicht synchronisierte Einträge an den Server schicken
  async function push() {
    const mPending = await IDB.pending('attendance_members');
    const hPending = await IDB.pending('attendance_helpers');
    if (mPending.length === 0 && hPending.length === 0) return { ok: true, pushed: 0 };

    const strip = (r) => { const { _pending, ...rest } = r; return rest; };
    const res = await API.post('/sync/push', {
      attendance_members: mPending.map(strip),
      attendance_helpers: hPending.map(strip),
    });

    // Ergebnisse verarbeiten: erfolgreiche Einträge als synchronisiert markieren
    for (const r of res.attendance_members || []) {
      if (r.ok && r.server) await IDB.put('attendance_members', { ...r.server, _pending: false });
    }
    for (const r of res.attendance_helpers || []) {
      if (r.ok && r.server) await IDB.put('attendance_helpers', { ...r.server, _pending: false });
    }
    return { ok: true, pushed: mPending.length + hPending.length };
  }

  // Kompletter Sync-Durchlauf: erst lokale Änderungen hochladen, dann neu laden
  async function run({ silent = false } = {}) {
    if (syncing || !navigator.onLine) { await emit(); return; }
    syncing = true;
    await emit();
    try {
      await push();
      await bootstrap();
    } catch (e) {
      if (!silent) console.warn('[sync] fehlgeschlagen:', e.message);
    } finally {
      syncing = false;
      await emit();
    }
  }

  // Präsenz eines Mitglieds lokal speichern (+ Sync-Versuch)
  async function saveMemberAttendance({ event_id, member_id, status, comment, userId }) {
    const existing = (await IDB.getAll('attendance_members'))
      .find((a) => a.event_id === event_id && a.member_id === member_id);
    const now = new Date().toISOString();
    const rec = {
      id: existing?.id || uuid(),
      event_id, member_id, status, comment: comment || null,
      entered_by: userId, entered_at: now, updated_at: now, _pending: true,
    };
    await IDB.put('attendance_members', rec);
    await emit();
    requestSync();
    return rec;
  }

  // Präsenz eines Helfers lokal speichern (+ Sync-Versuch)
  async function saveHelperAttendance({ event_id, helper_id, status, hours, comment, userId }) {
    const existing = (await IDB.getAll('attendance_helpers'))
      .find((a) => a.event_id === event_id && a.helper_id === helper_id);
    const now = new Date().toISOString();
    const rec = {
      id: existing?.id || uuid(),
      event_id, helper_id, status, hours: Number(hours) || 0, comment: comment || null,
      entered_by: userId, entered_at: now, updated_at: now, _pending: true,
    };
    await IDB.put('attendance_helpers', rec);
    await emit();
    requestSync();
    return rec;
  }

  // Sync anstoßen – nutzt Background Sync, wenn verfügbar, sonst direkt
  async function requestSync() {
    if (!navigator.onLine) return;
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register('jf-sync');
        // zusätzlich sofort versuchen (Background Sync feuert evtl. verzögert)
        run({ silent: true });
        return;
      } catch { /* Fallback unten */ }
    }
    run({ silent: true });
  }

  // Reagiert auf Online/Offline und Service-Worker-Nachrichten
  function init() {
    window.addEventListener('online', () => { emit(); run({ silent: true }); });
    window.addEventListener('offline', () => emit());
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'do-sync') run({ silent: true });
      });
    }
  }

  return {
    init, onChange, emit, run, bootstrap, push, requestSync,
    saveMemberAttendance, saveHelperAttendance, uuid,
  };
})();

window.Sync = Sync;
