// Haupt-App: Routing, Ansichten und Bedienlogik.
// Alle Ansichten lesen offline-first aus IndexedDB; der Sync-Layer hält den
// lokalen Cache aktuell und schickt Präsenz-Einträge an das Backend.
(() => {
  'use strict';

  const STATUS = {
    present:   { label: 'Anwesend',      cls: 'present' },
    excused:   { label: 'Entschuldigt',  cls: 'excused' },
    unexcused: { label: 'Fehlt',         cls: 'unexcused' },
  };
  const EVENT_TYPES = ['Praktische Übung', 'Theorie', 'Freizeit', 'Sonstiges'];

  const state = { user: null, view: 'events', params: {} };

  // ---------- Hilfsfunktionen ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  // Alter in vollen Jahren aus einem Geburtsdatum (ISO yyyy-mm-dd)
  function ageYears(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return null;
    const today = new Date();
    let age = today.getFullYear() - y;
    if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
    return age >= 0 && age < 130 ? age : null;
  }
  function toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  // Anzeigetext der Terminart (bei "Sonstiges" mit Beschreibung)
  function typeLabel(ev) {
    return ev.type === 'Sonstiges' && ev.type_detail ? `Sonstiges: ${ev.type_detail}` : ev.type;
  }
  const closedBadge = (ev) => ev.closed ? '<span class="badge badge-closed">🔒 Abgeschlossen</span>' : '';

  // ---------- Jahrgang (Saison): 1. September – 31. August ----------
  // Startjahr = bei Monat >= September das laufende Jahr, sonst das Vorjahr.
  const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  function seasonStart(iso) {
    if (!iso) return null;
    const [y, m] = iso.split('-').map(Number);
    return m >= 9 ? y : y - 1;
  }
  const seasonLabel = (s) => `${s} – ${s + 1}`;
  const currentSeason = () => seasonStart(new Date().toISOString().slice(0, 10));
  function weekday(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
  }
  // Datum bzw. Datumsbereich (bei mehrtägigen "Sonstiges"-Terminen mit Enddatum)
  function dateRange(ev) {
    return ev.end_date && ev.end_date > ev.date
      ? `${fmtDate(ev.date)} – ${fmtDate(ev.end_date)}`
      : fmtDate(ev.date);
  }

  // Dauer eines Termins in Stunden (für Helfer-Stunden-Default)
  function eventDurationHours(ev) {
    if (!ev.start_time || !ev.end_time) return 2;
    const [sh, sm] = ev.start_time.split(':').map(Number);
    const [eh, em] = ev.end_time.split(':').map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    return diff > 0 ? Math.round((diff / 60) * 100) / 100 : 2;
  }

  // ---------- Daten aus dem lokalen Cache ----------
  const data = {
    async events() {
      const evs = await IDB.getAll('events');
      const today = new Date().toISOString().slice(0, 10);
      // Kommende Termine zuerst (nächster ganz oben, aufsteigend),
      // vergangene danach (jüngster zuerst, absteigend).
      const upcoming = evs.filter((e) => (e.date || '') >= today)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const past = evs.filter((e) => (e.date || '') < today)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return [...upcoming, ...past];
    },
    async members() {
      return (await IDB.getAll('members'))
        .filter((m) => m.active)
        .sort((a, b) => (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name));
    },
    async helpers() {
      return (await IDB.getAll('helpers'))
        .filter((h) => h.active)
        .sort((a, b) => a.display_name.localeCompare(b.display_name));
    },
    async memberAttendance(eventId) {
      return (await IDB.getAll('attendance_members')).filter((a) => a.event_id === eventId);
    },
    async helperAttendance(eventId) {
      return (await IDB.getAll('attendance_helpers')).filter((a) => a.event_id === eventId);
    },
  };

  // ---------- Modal ----------
  function openModal(title, bodyHtml, onMount) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-head"><h2>${esc(title)}</h2><button class="btn btn-ghost modal-close">✕</button></div>
          <div class="modal-body">${bodyHtml}</div>
        </div>
      </div>`;
    const close = () => { root.innerHTML = ''; };
    root.querySelector('.modal-close').onclick = close;
    root.querySelector('.modal-overlay').onclick = (e) => { if (e.target.classList.contains('modal-overlay')) close(); };
    if (onMount) onMount(root, close);
    return close;
  }

  // ---------- Navigation ----------
  function navigate(view, params = {}) {
    state.view = view;
    state.params = params;
    render();
  }

  function renderNav() {
    const nav = $('#bottom-nav');
    const items = [
      { view: 'events', label: 'Termine', icon: '📅' },
      { view: 'roster', label: 'Mitglieder', icon: '👥' },
      { view: 'stats', label: 'Statistik', icon: '📊' },
    ];
    if (state.user.role === 'admin') {
      items.push({ view: 'admin', label: 'Verwaltung', icon: '⚙️' });
    }
    nav.innerHTML = items.map((it) => `
      <button class="nav-btn ${state.view === it.view ? 'active' : ''}" data-view="${it.view}">
        <span class="nav-icon">${it.icon}</span><span>${it.label}</span>
      </button>`).join('');
    nav.querySelectorAll('.nav-btn').forEach((b) =>
      b.onclick = () => navigate(b.dataset.view));
  }

  // ---------- Render-Dispatcher ----------
  async function render() {
    if (!state.user) return; // nicht rendern, solange nicht angemeldet
    $('#user-label').textContent = state.user ? state.user.name : '';
    renderNav();
    const main = $('#main-content');
    main.scrollTop = 0;
    try {
      if (state.view === 'events') return await renderEvents(main);
      if (state.view === 'event') return await renderEventDetail(main, state.params.id);
      if (state.view === 'roster') return await renderRoster(main);
      if (state.view === 'stats') return await renderStats(main);
      if (state.view === 'admin') return await renderAdmin(main);
    } catch (e) {
      main.innerHTML = `<div class="card error-msg">Fehler: ${esc(e.message)}</div>`;
    }
  }

  // ---------- Ansicht: Termine ----------
  async function renderEvents(main) {
    const events = await data.events();
    const today = new Date().toISOString().slice(0, 10);

    // Jahrgang-Auswahl: alle vorhandenen Jahrgänge + der aktuelle (auch ohne Termine),
    // neuester oben. Standard: aktueller Jahrgang (springt ab 1. September von allein weiter).
    const seasons = [...new Set([currentSeason(), ...events.map((e) => seasonStart(e.date))])]
      .filter((s) => s !== null).sort((a, b) => b - a);
    const selected = state.params.season != null ? Number(state.params.season) : currentSeason();

    const inSeason = events.filter((e) => seasonStart(e.date) === selected);
    const open = inSeason.filter((e) => !e.closed);
    const closed = inSeason.filter((e) => e.closed).sort((a, b) => b.date.localeCompare(a.date));
    const upcoming = open.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const pastOpen = open.filter((e) => e.date < today).sort((a, b) => b.date.localeCompare(a.date));
    const next = upcoming[0] || null;
    const rest = [...upcoming.slice(1), ...pastOpen];

    const secLabel = (text, count) =>
      `<div class="sec-label">${text}${count ? ` <span class="sec-count">${count}</span>` : ''}</div>`;

    let listHtml = '';
    if (next) listHtml += secLabel('Nächster Termin') + eventCard(next, true);
    if (rest.length) listHtml += secLabel('Weitere Termine', rest.length) + rest.map((e) => eventCard(e)).join('');
    if (!next && !rest.length) listHtml += '<div class="empty">Keine kommenden Termine in diesem Jahrgang.</div>';
    if (closed.length) {
      listHtml += secLabel('Abgeschlossene Termine', closed.length)
        + `<div class="closed-block">${closed.map((e) => eventCard(e)).join('')}</div>`;
    }
    if (!inSeason.length) listHtml = '<div class="empty">In diesem Jahrgang gibt es noch keine Termine.</div>';

    main.innerHTML = `
      <div class="page-head">
        <h1>Termine</h1>
        <button class="btn btn-primary" id="new-event">+ Termin</button>
      </div>
      <div class="card season-bar">
        <label for="season-select">Jahrgang</label>
        <span class="season-spacer"></span>
        <select id="season-select" class="season-select">
          ${seasons.map((s) => `<option value="${s}" ${s === selected ? 'selected' : ''}>${seasonLabel(s)}</option>`).join('')}
        </select>
      </div>
      <div class="list">${listHtml}</div>`;

    $('#new-event').onclick = () => eventForm();
    $('#season-select').onchange = (e) => navigate('events', { season: Number(e.target.value) });
    main.querySelectorAll('[data-event]').forEach((c) =>
      c.onclick = () => navigate('event', { id: Number(c.dataset.event) }));
  }

  function eventCard(ev, isNext = false) {
    return `
      <div class="card event-card ${isNext ? 'next' : ''}" data-event="${ev.id}">
        ${isNext ? '<span class="next-flag">Nächster Termin</span>' : ''}
        <div class="event-date">
          <span class="event-day">${dateRange(ev)}</span>
          <span class="event-weekday">${weekday(ev.date)}</span>
          <span class="badge badge-type">${esc(typeLabel(ev))}</span>
          ${closedBadge(ev)}
        </div>
        <div class="event-meta">
          ${ev.start_time ? `🕒 ${esc(ev.start_time)}${ev.end_time ? '–' + esc(ev.end_time) : ''}` : ''}
          ${ev.location ? ` · 📍 ${esc(ev.location)}` : ''}
        </div>
        ${ev.note ? `<div class="event-note">${esc(ev.note)}</div>` : ''}
      </div>`;
  }

  // ---------- Ansicht: Präsenz-Erfassung ----------
  async function renderEventDetail(main, eventId) {
    // Beim Öffnen (online) frischen Serverstand holen, damit Abschluss-Status,
    // Erfasser-Sperre und fremde Einträge aktuell angezeigt werden.
    if (navigator.onLine) { try { await Sync.bootstrap(); } catch { /* offline -> Cache */ } }
    const ev = await IDB.get('events', eventId);
    if (!ev) { main.innerHTML = '<div class="card">Termin nicht gefunden.</div>'; return; }
    const [members, helpers, mAtt, hAtt] = await Promise.all([
      data.members(), data.helpers(), data.memberAttendance(eventId), data.helperAttendance(eventId),
    ]);
    const mMap = new Map(mAtt.map((a) => [a.member_id, a]));
    const hMap = new Map(hAtt.map((a) => [a.helper_id, a]));
    const canEditEvent = state.user.role === 'admin' || (!ev.closed && ev.created_by === state.user.id);
    const isAdmin = state.user.role === 'admin';

    // Helfer dürfen nur die EIGENE Präsenz eintragen -> nur sich selbst anzeigen.
    const visibleHelpers = isAdmin ? helpers : helpers.filter((h) => h.id === state.user.id);
    const helperLabel = isAdmin ? `Betreuer (${visibleHelpers.length})` : 'Eigene Präsenz';
    const part = state.params.part === 'helper' ? 'helper' : 'member';

    // Erfasser der Mitglieder-Präsenz (frühester Eintrag). Solange offen, dürfen
    // nur dieser Helfer + Admin die Mitglieder-Präsenz ändern.
    const recorder = mAtt.length
      ? [...mAtt].sort((a, b) => (a.entered_at || '').localeCompare(b.entered_at || ''))[0].entered_by
      : null;
    const memberEditable = isAdmin || (!ev.closed && (recorder === null || recorder === state.user.id));
    const helperEditable = isAdmin || !ev.closed;

    const memberNote = memberEditable ? '' : (ev.closed
      ? '<div class="lock-note">🔒 Termin abgeschlossen – Änderungen nur durch die Leitung.</div>'
      : '<div class="lock-note">🔒 Bereits von einem anderen Helfer erfasst – Korrekturen nur durch die Leitung.</div>');
    const helperNote = helperEditable ? '' : '<div class="lock-note">🔒 Termin abgeschlossen – Stunden nur durch die Leitung änderbar.</div>';

    main.innerHTML = `
      <div class="page-head">
        <button class="btn btn-ghost" id="back">‹ Zurück</button>
        ${canEditEvent ? '<button class="btn btn-outline" id="edit-event">Bearbeiten</button>' : ''}
      </div>
      <div class="card event-summary">
        <div class="event-date"><span class="event-day">${dateRange(ev)}</span><span class="event-weekday">${weekday(ev.date)}</span><span class="badge badge-type">${esc(typeLabel(ev))}</span>${closedBadge(ev)}</div>
        <div class="event-meta">
          ${ev.start_time ? `🕒 ${esc(ev.start_time)}${ev.end_time ? '–' + esc(ev.end_time) : ''}` : ''}
          ${ev.location ? ` · 📍 ${esc(ev.location)}` : ''}
        </div>
        ${ev.note ? `<div class="event-note">${esc(ev.note)}</div>` : ''}
        ${isAdmin ? `<button class="btn ${ev.closed ? 'btn-outline' : 'btn-danger'} btn-close" id="toggle-close">${ev.closed ? '🔓 Termin wieder öffnen' : '🔒 Termin abschließen'}</button>` : ''}
      </div>

      <div class="card att-switch">
        <label>Präsenz erfassen für
          <select id="att-part">
            <option value="member" ${part === 'member' ? 'selected' : ''}>Mitglieder (${members.length})</option>
            <option value="helper" ${part === 'helper' ? 'selected' : ''}>${helperLabel}</option>
          </select>
        </label>
      </div>

      <div class="list attendance-list ${part === 'member' ? '' : 'hidden'}" id="member-list">
        ${memberNote}
        ${members.map((m) => attendanceRow('member', m.id, `${m.last_name}, ${m.first_name}`, mMap.get(m.id), memberEditable)).join('')
          || '<div class="empty">Keine aktiven Mitglieder.</div>'}
      </div>

      <div class="list attendance-list ${part === 'helper' ? '' : 'hidden'}" id="helper-list">
        ${helperNote}
        ${visibleHelpers.map((h) => helperRow(h, hMap.get(h.id), eventDurationHours(ev), helperEditable)).join('')
          || '<div class="empty">Keine Betreuer.</div>'}
      </div>`;

    $('#back').onclick = () => navigate('events');
    if (canEditEvent) $('#edit-event').onclick = () => eventForm(ev);

    // Admin: Termin abschließen / wieder öffnen
    const toggle = $('#toggle-close');
    if (toggle) toggle.onclick = async () => {
      if (!navigator.onLine) { toast('Aktion benötigt eine Verbindung', 'error'); return; }
      const closing = !ev.closed;
      if (closing && !confirm('Termin abschließen? Helfer können danach keine Präsenz/Stunden mehr ändern.')) return;
      try {
        await API.post(`/events/${eventId}/${closing ? 'close' : 'reopen'}`);
        await Sync.bootstrap();
        toast(closing ? 'Termin abgeschlossen' : 'Termin wieder geöffnet', 'success');
        render();
      } catch (err) { toast(err.message, 'error'); }
    };

    // Umschalten zwischen Mitglieder- und Helfer-Erfassung
    $('#att-part').onchange = (e) => {
      const p = e.target.value;
      state.params.part = p;
      $('#member-list').classList.toggle('hidden', p !== 'member');
      $('#helper-list').classList.toggle('hidden', p !== 'helper');
      $('#main-content').scrollTop = 0;
    };

    // Status-Buttons Mitglieder (nur wenn erlaubt)
    if (memberEditable) main.querySelectorAll('#member-list .status-btn').forEach((btn) => {
      btn.onclick = async () => {
        const memberId = Number(btn.closest('[data-row]').dataset.row);
        await Sync.saveMemberAttendance({
          event_id: eventId, member_id: memberId, status: btn.dataset.status, userId: state.user.id,
        });
        markRow(btn, btn.dataset.status);
      };
    });

    // Status-Buttons + Stunden Helfer (nur wenn erlaubt)
    if (helperEditable) {
      main.querySelectorAll('#helper-list .status-btn').forEach((btn) => {
        btn.onclick = async () => {
          const row = btn.closest('[data-row]');
          const helperId = Number(row.dataset.row);
          const hoursInput = row.querySelector('.hours-input');
          const hours = btn.dataset.status === 'present' ? parseFloat(hoursInput.value) || 0 : 0;
          await Sync.saveHelperAttendance({
            event_id: eventId, helper_id: helperId, status: btn.dataset.status, hours, userId: state.user.id,
          });
          markRow(btn, btn.dataset.status);
          row.querySelector('.hours-wrap').classList.toggle('hidden', btn.dataset.status !== 'present');
        };
      });
      main.querySelectorAll('#helper-list .hours-input').forEach((inp) => {
        inp.onchange = async () => {
          const row = inp.closest('[data-row]');
          const active = row.querySelector('.status-btn.active');
          if (active && active.dataset.status === 'present') {
            await Sync.saveHelperAttendance({
              event_id: eventId, helper_id: Number(row.dataset.row), status: 'present',
              hours: parseFloat(inp.value) || 0, userId: state.user.id,
            });
            toast('Stunden gespeichert');
          }
        };
      });
    }
  }

  function markRow(btn, status) {
    const group = btn.closest('.status-group');
    group.querySelectorAll('.status-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const row = btn.closest('[data-row]');
    row.classList.remove('present', 'excused', 'unexcused', 'unset');
    row.classList.add(status);
    setDot(row, true); // optimistisch als "nicht synchronisiert" markieren
  }

  // Zeigt/entfernt den Pending-Punkt einer Präsenz-Zeile ohne Neuaufbau der Liste
  function setDot(row, pending) {
    const name = row.querySelector('.att-name');
    let dot = name.querySelector('.pending-dot');
    if (pending && !dot) {
      dot = document.createElement('span');
      dot.className = 'pending-dot';
      dot.title = 'lokal gespeichert, nicht synchronisiert';
      dot.textContent = '●';
      name.appendChild(document.createTextNode(' '));
      name.appendChild(dot);
    } else if (!pending && dot) {
      dot.remove();
    }
  }

  // Aktualisiert nur die Pending-Punkte der aktuell sichtbaren Präsenz-Ansicht
  async function updatePendingDots() {
    const eventId = state.params.id;
    const mp = new Set((await IDB.pending('attendance_members')).filter((a) => a.event_id === eventId).map((a) => a.member_id));
    const hp = new Set((await IDB.pending('attendance_helpers')).filter((a) => a.event_id === eventId).map((a) => a.helper_id));
    document.querySelectorAll('#member-list .attendance-row').forEach((row) => setDot(row, mp.has(Number(row.dataset.row))));
    document.querySelectorAll('#helper-list .attendance-row').forEach((row) => setDot(row, hp.has(Number(row.dataset.row))));
  }

  function statusButtons(current, disabled) {
    return `<div class="status-group">
      ${Object.entries(STATUS).map(([key, s]) => `
        <button class="status-btn status-${s.cls} ${current === key ? 'active' : ''}" data-status="${key}" ${disabled ? 'disabled' : ''}>${s.label}</button>
      `).join('')}
    </div>`;
  }

  function attendanceRow(kind, id, name, att, editable = true) {
    const status = att?.status;
    const pending = att?._pending;
    return `
      <div class="card attendance-row ${status || 'unset'} ${editable ? '' : 'locked'}" data-row="${id}" data-kind="${kind}">
        <div class="att-name">${esc(name)} ${pending ? '<span class="pending-dot" title="lokal gespeichert, nicht synchronisiert">●</span>' : ''}</div>
        ${statusButtons(status, !editable)}
      </div>`;
  }

  function helperRow(h, att, defaultHours, editable = true) {
    const status = att?.status;
    const pending = att?._pending;
    const hours = att?.hours ?? defaultHours;
    const showHours = status === 'present' || !status;
    return `
      <div class="card attendance-row ${status || 'unset'} ${editable ? '' : 'locked'}" data-row="${h.id}" data-kind="helper">
        <div class="att-name">${esc(h.display_name)} ${pending ? '<span class="pending-dot" title="nicht synchronisiert">●</span>' : ''}</div>
        ${statusButtons(status, !editable)}
        <div class="hours-wrap ${showHours ? '' : 'hidden'}">
          <label class="hours-label">Stunden
            <input type="number" class="hours-input" min="0" step="0.25" value="${hours}" ${editable ? '' : 'disabled'} />
          </label>
        </div>
      </div>`;
  }

  // ---------- Termin-Formular ----------
  function eventForm(ev = null) {
    const isEdit = !!ev;
    const body = `
      <form id="event-form" class="form">
        <label>Datum<input type="date" name="date" value="${ev?.date || new Date().toISOString().slice(0, 10)}" required /></label>
        <div class="form-row">
          <label>Beginn<input type="time" name="start_time" value="${ev?.start_time || '10:00'}" /></label>
          <label>Ende<input type="time" name="end_time" value="${ev?.end_time || '12:00'}" /></label>
        </div>
        <label>Art
          <select name="type" id="ev-type">${EVENT_TYPES.map((t) => `<option ${ev?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
        <div id="ev-sonstiges" class="ev-sonstiges ${ev?.type === 'Sonstiges' ? '' : 'hidden'}">
          <label>Beschreibung (bei „Sonstiges")
            <input type="text" name="type_detail" value="${esc(ev?.type_detail || '')}" placeholder="Was habt ihr gemacht?" />
          </label>
          <label>Enddatum (optional, bei mehrtägigen Terminen)
            <input type="date" name="end_date" value="${ev?.end_date || ''}" />
          </label>
          <p class="field-hint">Für mehrtägige Termine (z. B. JugendCamp). Die Präsenz zählt trotzdem nur einmal – das Enddatum dient nur der Übersicht.</p>
        </div>
        <label>Ort<input type="text" name="location" value="${esc(ev?.location || '')}" /></label>
        <label>Notiz<textarea name="note" rows="2">${esc(ev?.note || '')}</textarea></label>
        <div class="form-actions">
          ${isEdit && state.user.role === 'admin' ? '<button type="button" class="btn btn-danger" id="del-event">Löschen</button>' : '<span></span>'}
          <button type="submit" class="btn btn-primary">${isEdit ? 'Speichern' : 'Anlegen'}</button>
        </div>
      </form>`;
    openModal(isEdit ? 'Termin bearbeiten' : 'Neuer Termin', body, (root, close) => {
      // Zusatzfelder (Beschreibung + Enddatum) nur bei "Sonstiges" zeigen
      const typeSel = root.querySelector('#ev-type');
      const sonstiges = root.querySelector('#ev-sonstiges');
      typeSel.onchange = () => sonstiges.classList.toggle('hidden', typeSel.value !== 'Sonstiges');
      root.querySelector('#event-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = Object.fromEntries(fd.entries());
        if (payload.type === 'Sonstiges' && !String(payload.type_detail || '').trim()) {
          toast('Bitte bei „Sonstiges" kurz beschreiben, was gemacht wurde', 'error'); return;
        }
        if (payload.end_date && payload.date && payload.end_date < payload.date) {
          toast('Das Enddatum darf nicht vor dem Startdatum liegen', 'error'); return;
        }
        try {
          if (!navigator.onLine) { toast('Termine benötigen eine Verbindung', 'error'); return; }
          if (isEdit) await API.put('/events/' + ev.id, payload);
          else await API.post('/events', payload);
          await Sync.bootstrap();
          close();
          toast('Termin gespeichert', 'success');
          if (state.view === 'event') navigate('events'); else render();
        } catch (err) { toast(err.message, 'error'); }
      };
      const del = root.querySelector('#del-event');
      if (del) del.onclick = async () => {
        if (!confirm('Diesen Termin wirklich löschen? Alle Präsenz-Einträge gehen verloren.')) return;
        try {
          await API.del('/events/' + ev.id);
          await Sync.bootstrap();
          close();
          navigate('events');
          toast('Termin gelöscht', 'success');
        } catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  // ---------- Ansicht: Statistik ----------
  async function renderStats(main) {
    const year = state.params.year || new Date().getFullYear();
    const from = state.params.from ?? `${year}-01-01`;
    const to = state.params.to ?? `${year}-12-31`;
    const type = state.params.type || '';
    const tab = state.params.tab || 'members';

    const [events, members, helpers, mAtt, hAtt] = await Promise.all([
      data.events(), data.members(), data.helpers(),
      IDB.getAll('attendance_members'), IDB.getAll('attendance_helpers'),
    ]);
    const evMap = new Map(events.map((e) => [e.id, e]));
    const inRange = (a) => {
      const e = evMap.get(a.event_id);
      if (!e) return false;
      if (from && e.date < from) return false;
      if (to && e.date > to) return false;
      if (type && e.type !== type) return false;
      return true;
    };

    // Mitglieder-Statistik
    const mStats = members.map((m) => {
      const rec = mAtt.filter((a) => a.member_id === m.id && inRange(a));
      const c = countStatus(rec);
      return { name: `${m.last_name}, ${m.first_name}`, ...c };
    }).sort((a, b) => b.quote - a.quote);

    // Helfer-Statistik (mit Stunden)
    const hStats = helpers.map((h) => {
      const rec = hAtt.filter((a) => a.helper_id === h.id && inRange(a));
      const c = countStatus(rec);
      const hours = rec.filter((r) => r.status === 'present').reduce((s, r) => s + (Number(r.hours) || 0), 0);
      return { name: h.display_name, ...c, hours: Math.round(hours * 100) / 100 };
    }).sort((a, b) => b.hours - a.hours);

    main.innerHTML = `
      <div class="page-head"><h1>Statistik</h1></div>
      <div class="card filter-bar">
        <div class="form-row">
          <label>Von<input type="date" id="f-from" value="${from}" /></label>
          <label>Bis<input type="date" id="f-to" value="${to}" /></label>
        </div>
        <label>Terminart
          <select id="f-type"><option value="">Alle</option>${EVENT_TYPES.map((t) => `<option ${type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
        ${state.user.role === 'admin' ? '<button class="btn btn-outline" id="export-btn">⬇ Excel-Export</button>' : ''}
      </div>
      <div class="tabs">
        <button class="tab ${tab === 'members' ? 'active' : ''}" data-tab="members">Mitglieder</button>
        <button class="tab ${tab === 'helpers' ? 'active' : ''}" data-tab="helpers">Betreuer</button>
      </div>
      ${tab === 'members' ? statsTableMembers(mStats) : statsTableHelpers(hStats)}`;

    const applyFilter = () => navigate('stats', {
      from: $('#f-from').value, to: $('#f-to').value, type: $('#f-type').value, tab,
    });
    $('#f-from').onchange = applyFilter;
    $('#f-to').onchange = applyFilter;
    $('#f-type').onchange = applyFilter;
    main.querySelectorAll('.tab').forEach((t) => t.onclick = () =>
      navigate('stats', { from, to, type, tab: t.dataset.tab }));
    const exp = $('#export-btn');
    if (exp) exp.onclick = async () => {
      try {
        const blob = await API.downloadExport({ from, to, ...(type ? { type } : {}) });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `praesenz_${from}_${to}.xlsx`; a.click();
        URL.revokeObjectURL(url);
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  function countStatus(records) {
    const present = records.filter((r) => r.status === 'present').length;
    const excused = records.filter((r) => r.status === 'excused').length;
    const unexcused = records.filter((r) => r.status === 'unexcused').length;
    const total = present + excused + unexcused;
    return { present, excused, unexcused, total, quote: total ? Math.round((present / total) * 1000) / 10 : 0 };
  }

  function statsTableMembers(rows) {
    if (!rows.length) return '<div class="empty">Keine Daten im gewählten Zeitraum.</div>';
    return `<div class="table-wrap"><table class="stats-table">
      <thead><tr><th>Mitglied</th><th>Anw.</th><th>Entsch.</th><th>Unentsch.</th><th>Quote</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="td-name">${esc(r.name)}</td>
        <td class="num ok">${r.present}</td><td class="num warn">${r.excused}</td>
        <td class="num bad">${r.unexcused}</td><td class="num"><b>${r.quote}%</b></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  function statsTableHelpers(rows) {
    if (!rows.length) return '<div class="empty">Keine Daten im gewählten Zeitraum.</div>';
    return `<div class="table-wrap"><table class="stats-table">
      <thead><tr><th>Betreuer</th><th>Std.</th><th>Anw.</th><th>Entsch.</th><th>Unentsch.</th><th>Quote</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="td-name">${esc(r.name)}</td>
        <td class="num"><b>${r.hours}</b></td>
        <td class="num ok">${r.present}</td><td class="num warn">${r.excused}</td>
        <td class="num bad">${r.unexcused}</td><td class="num">${r.quote}%</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  // ---------- Ansicht: Verwaltung (nur Admin) ----------
  async function renderAdmin(main) {
    const sub = state.params.sub || 'users';
    main.innerHTML = `
      <div class="page-head"><h1>Verwaltung</h1></div>
      <div class="tabs">
        <button class="tab ${sub === 'users' ? 'active' : ''}" data-sub="users">Helfer</button>
        <button class="tab ${sub === 'sync' ? 'active' : ''}" data-sub="sync">Sync</button>
      </div>
      <div id="admin-body"></div>`;
    main.querySelectorAll('.tab').forEach((t) => t.onclick = () => navigate('admin', { sub: t.dataset.sub }));
    const body = $('#admin-body');
    if (sub === 'sync') return adminSync(body);
    return adminUsers(body);
  }

  // ---------- Ansicht: Mitglieder (Roster) ----------
  // Admin kann bearbeiten/anlegen; Helfer sehen die Liste nur (inkl.
  // Notfallkontakt), ohne Änderungsmöglichkeit.
  async function renderRoster(main) {
    const isAdmin = state.user.role === 'admin';
    let members;
    try { members = await API.get('/members' + (isAdmin ? '?includeInactive=1' : '')); }
    catch { members = await data.members(); }
    main.innerHTML = `
      <div class="page-head"><h1>Mitglieder</h1>${isAdmin ? '<button class="btn btn-primary" id="add-m">+ Mitglied</button>' : ''}</div>
      ${isAdmin ? '' : '<p class="hint-line">Nur Ansicht – Änderungen nimmt die Jugendfeuerwehr-Leitung vor.</p>'}
      <div class="list">${members.map((m) => memberCard(m, isAdmin)).join('') || '<div class="empty">Noch keine Mitglieder.</div>'}</div>`;
    if (isAdmin) {
      $('#add-m').onclick = () => memberForm();
      main.querySelectorAll('[data-edit]').forEach((b) =>
        b.onclick = () => memberForm(members.find((m) => m.id === Number(b.dataset.edit))));
    }
  }

  function memberCard(m, isAdmin) {
    const contact = (m.emergency_contact || m.emergency_phone)
      ? `<div class="muted small">📞 ${esc(m.emergency_contact || 'Notfall')}${m.emergency_phone
          ? `: <a class="contact-tel" href="tel:${esc(String(m.emergency_phone).replace(/\s/g, ''))}">${esc(m.emergency_phone)}</a>` : ''}</div>`
      : '';
    return `
      <div class="card list-row ${m.active ? '' : 'inactive'}">
        <div>
          <b>${esc(m.last_name)}, ${esc(m.first_name)}</b>${m.active ? '' : ' <span class="badge">inaktiv</span>'}
          ${m.birth_date ? `<div class="muted small">geb. ${fmtDate(m.birth_date)}${ageYears(m.birth_date) !== null ? ` (${ageYears(m.birth_date)} Jahre)` : ''}</div>` : ''}
          ${contact}
        </div>
        ${isAdmin ? `<button class="btn btn-outline" data-edit="${m.id}">Bearbeiten</button>` : ''}
      </div>`;
  }

  function memberForm(m = null) {
    const isEdit = !!m;
    const body = `
      <form id="m-form" class="form">
        <div class="form-row">
          <label>Vorname<input name="first_name" value="${esc(m?.first_name || '')}" required /></label>
          <label>Nachname<input name="last_name" value="${esc(m?.last_name || '')}" required /></label>
        </div>
        <label>Geburtsdatum<input type="date" name="birth_date" value="${m?.birth_date || ''}" /></label>
        <label>Notfallkontakt<input name="emergency_contact" value="${esc(m?.emergency_contact || '')}" placeholder="z.B. Mutter (Name)" /></label>
        <label>Telefon Eltern / Notfall<input type="tel" name="emergency_phone" value="${esc(m?.emergency_phone || '')}" placeholder="z.B. 0170 1234567" /></label>
        ${isEdit ? `<label class="check"><input type="checkbox" name="active" ${m.active ? 'checked' : ''} /> aktiv</label>` : ''}
        <div class="form-actions">
          ${isEdit ? '<button type="button" class="btn btn-danger" id="del-m">Löschen/Inaktiv</button>' : '<span></span>'}
          <button type="submit" class="btn btn-primary">${isEdit ? 'Speichern' : 'Anlegen'}</button>
        </div>
      </form>`;
    openModal(isEdit ? 'Mitglied bearbeiten' : 'Neues Mitglied', body, (root, close) => {
      root.querySelector('#m-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const payload = {
          first_name: fd.get('first_name'), last_name: fd.get('last_name'),
          birth_date: fd.get('birth_date') || null,
          emergency_contact: fd.get('emergency_contact') || null,
          emergency_phone: fd.get('emergency_phone') || null,
        };
        if (isEdit) payload.active = fd.get('active') ? 1 : 0;
        try {
          if (isEdit) await API.put('/members/' + m.id, payload);
          else await API.post('/members', payload);
          await Sync.bootstrap();
          close(); render(); toast('Gespeichert', 'success');
        } catch (err) { toast(err.message, 'error'); }
      };
      const del = root.querySelector('#del-m');
      if (del) del.onclick = async () => {
        if (!confirm('Mitglied löschen? Bei vorhandenen Einträgen wird es nur inaktiv gesetzt.')) return;
        try { await API.del('/members/' + m.id); await Sync.bootstrap(); close(); render(); toast('Erledigt', 'success'); }
        catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  async function adminUsers(body) {
    const users = await API.get('/users');
    body.innerHTML = `
      <div class="page-head"><h2>Benutzer</h2><button class="btn btn-primary" id="add-u">+ Benutzer</button></div>
      <div class="list">${users.map((u) => `
        <div class="card list-row ${u.active ? '' : 'inactive'}">
          <div><b>${esc(u.display_name)}</b> <span class="badge">${u.role === 'admin' ? 'Admin' : 'Helfer'}</span>
            ${u.active ? '' : '<span class="badge">inaktiv</span>'}
            <div class="muted small">@${esc(u.username)}</div></div>
          <button class="btn btn-outline" data-edit="${u.id}">Bearbeiten</button>
        </div>`).join('')}</div>`;
    $('#add-u').onclick = () => userForm();
    body.querySelectorAll('[data-edit]').forEach((b) =>
      b.onclick = () => userForm(users.find((u) => u.id === Number(b.dataset.edit))));
  }

  function userForm(u = null) {
    const isEdit = !!u;
    const body = `
      <form id="u-form" class="form">
        <label>Anzeigename<input name="display_name" value="${esc(u?.display_name || '')}" required /></label>
        <label>Benutzername<input name="username" value="${esc(u?.username || '')}" ${isEdit ? 'disabled' : 'required'} /></label>
        <label>Rolle
          <select name="role"><option value="helper" ${u?.role === 'helper' ? 'selected' : ''}>Helfer</option>
          <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Administrator</option></select>
        </label>
        <label>PIN (4-6 Ziffern)${isEdit ? ' – leer lassen für unverändert' : ''}
          <input name="pin" inputmode="numeric" pattern="[0-9]*" ${isEdit ? '' : 'required'} /></label>
        ${isEdit ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} /> aktiv</label>` : ''}
        <div class="form-actions">
          ${isEdit ? '<button type="button" class="btn btn-danger" id="del-u">Löschen</button>' : '<span></span>'}
          <button type="submit" class="btn btn-primary">${isEdit ? 'Speichern' : 'Anlegen'}</button>
        </div>
      </form>`;
    openModal(isEdit ? 'Benutzer bearbeiten' : 'Neuer Benutzer', body, (root, close) => {
      root.querySelector('#u-form').onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          if (isEdit) {
            const payload = { display_name: fd.get('display_name'), role: fd.get('role'), active: fd.get('active') ? 1 : 0 };
            if (fd.get('pin')) payload.pin = fd.get('pin');
            await API.put('/users/' + u.id, payload);
          } else {
            await API.post('/users', {
              display_name: fd.get('display_name'), username: fd.get('username'),
              role: fd.get('role'), pin: fd.get('pin'),
            });
          }
          // Helfer-Cache auffrischen, damit neue Helfer sofort in Präsenz/Statistik erscheinen
          await Sync.bootstrap().catch(() => {});
          close(); adminUsers($('#admin-body')); toast('Gespeichert', 'success');
        } catch (err) { toast(err.message, 'error'); }
      };
      const del = root.querySelector('#del-u');
      if (del) del.onclick = async () => {
        if (!confirm('Benutzer löschen? Bei vorhandenen Einträgen wird er nur inaktiv gesetzt.')) return;
        try { await API.del('/users/' + u.id); close(); adminUsers($('#admin-body')); toast('Erledigt', 'success'); }
        catch (err) { toast(err.message, 'error'); }
      };
    });
  }

  async function adminSync(body) {
    let rows = [];
    try { rows = await API.get('/sync/status'); }
    catch { body.innerHTML = '<div class="empty">Sync-Status nur online verfügbar.</div>'; return; }
    body.innerHTML = `
      <div class="page-head"><h2>Sync-Status der Betreuer</h2></div>
      <div class="table-wrap"><table class="stats-table">
        <thead><tr><th>Betreuer</th><th>Einträge</th><th>Letzte Erfassung</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="td-name">${esc(r.display_name)}</td>
          <td class="num">${(r.member_entries || 0) + (r.helper_entries || 0)}</td>
          <td>${lastEntry(r)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Hinweis: Nicht synchronisierte Einträge liegen lokal auf dem jeweiligen Gerät und erscheinen erst nach erfolgreichem Sync.</p>`;
  }
  function lastEntry(r) {
    const dates = [r.last_member_entry, r.last_helper_entry].filter(Boolean).sort();
    const last = dates[dates.length - 1];
    return last ? new Date(last + (last.includes('T') ? '' : 'Z')).toLocaleString('de-DE') : '–';
  }

  // ---------- Sync-Badge ----------
  function updateSyncBadge(st) {
    const badge = $('#sync-badge');
    const banner = $('#offline-banner');
    banner.classList.toggle('hidden', st.online);
    if (!st.online) {
      badge.className = 'sync-badge offline';
      badge.textContent = st.pending ? `📴 ${st.pending}` : '📴';
    } else if (st.syncing) {
      badge.className = 'sync-badge syncing';
      badge.textContent = '🔄';
    } else if (st.pending) {
      badge.className = 'sync-badge pending';
      badge.textContent = `☁ ${st.pending}`;
    } else {
      badge.className = 'sync-badge ok';
      badge.textContent = '✓';
    }
    onSyncSettle(st);
  }

  // Nach abgeschlossenem Sync die aktuelle Ansicht auffrischen.
  // Listen-Ansichten werden neu gerendert; in der Präsenz-Erfassung werden nur
  // die Pending-Punkte aktualisiert, um schnelles Antippen nicht zu stören.
  function onSyncSettle(st) {
    if (!state.user) return; // nur wenn angemeldet
    if (!st.online || st.syncing) return;
    if (document.querySelector('.modal-overlay')) return; // laufende Eingabe nicht unterbrechen
    if (state.view === 'event') updatePendingDots();
    else if (state.view === 'events' || state.view === 'stats' || state.view === 'roster') render();
  }

  // ---------- Auth / Boot ----------
  async function showLogin() {
    $('#login-view').classList.remove('hidden');
    $('#app-view').classList.add('hidden');
  }
  async function showApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    render();
  }

  async function doLogin(username, pin) {
    const res = await API.post('/auth/login', { username, pin });
    API.setToken(res.token);
    await IDB.setMeta('token', res.token);
    await IDB.setMeta('user', res.user);
    state.user = res.user;
    // Erst Daten laden, dann App anzeigen (kein leeres Aufblitzen der Liste)
    try { await Sync.run({ silent: true }); } catch { /* offline unwahrscheinlich beim Login */ }
    await showApp();
  }

  async function logout() {
    await IDB.clearAll();
    state.user = null;
    API.setToken(null);
    showLogin();
  }

  async function boot() {
    // Service Worker registrieren + automatische Aktualisierung.
    // Damit die installierte Homescreen-App neue Versionen von allein übernimmt:
    // Beim Öffnen nach Updates suchen; sobald eine neue Version die Kontrolle
    // übernimmt, die Seite EINMAL neu laden. Beim allerersten Installieren (noch
    // kein aktiver Worker) wird NICHT neu geladen, um eine Schleife zu vermeiden.
    if ('serviceWorker' in navigator) {
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return;
        reloaded = true;
        window.location.reload();
      });
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        reg.update().catch(() => {});
        // Bei Rückkehr in die App (aus dem Hintergrund) erneut nach Updates suchen
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      } catch (e) { console.warn('SW', e); }
    }
    Sync.init();
    Sync.onChange(updateSyncBadge);
    Sync.emit();

    // Login-Formular
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      $('#login-error').textContent = '';
      try {
        await doLogin($('#login-username').value.trim(), $('#login-pin').value);
      } catch (err) {
        $('#login-error').textContent = err.message;
      }
    };
    $('#logout-btn').onclick = () => { if (confirm('Abmelden? Nicht synchronisierte Einträge gehen dabei verloren, wenn sie noch nicht hochgeladen wurden.')) logout(); };

    window.addEventListener('auth-expired', async () => {
      // Ungültiges Token nicht erneut verwenden: Sitzung lokal verwerfen.
      // (Nur die Sitzung, nicht die offline gespeicherten Einträge.)
      state.user = null;
      API.setToken(null);
      await IDB.delMeta('token');
      await IDB.delMeta('user');
      toast('Sitzung abgelaufen', 'error');
      showLogin();
    });

    // Vom Server abgelehnte Änderungen (z.B. gesperrter Termin) melden + Ansicht auffrischen
    window.addEventListener('sync-rejected', (e) => {
      const msgs = e.detail || [];
      if (msgs.length) toast(msgs[0], 'error');
      if (state.view === 'event') renderEventDetail($('#main-content'), state.params.id);
    });

    // Gespeicherte Sitzung wiederherstellen
    const token = await IDB.getMeta('token');
    const user = await IDB.getMeta('user');
    if (token && user) {
      API.setToken(token);
      state.user = user;
      await showApp();
      Sync.run({ silent: true });
    } else {
      showLogin();
    }
  }

  boot();
})();
