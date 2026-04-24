/* ============================================================
   AlertTracker v4.0 — Professional Dashboard
   - Seeds from alert_data.json on first run (when the server DB is empty)
   - Shared data via /api/alerts (server.py) backed by SQLite (server_data.db)
   - XSS sanitization, 5s polling to pick up edits from other PCs
   ============================================================ */

const API_URL = '/api/alerts';
const POLL_INTERVAL_MS = 5000;

let alerts = [];
let filteredAlerts = [];
let selectedIds = new Set();
let editingId = null;
let deletingIds = [];
let lastServerSnapshot = '';    // last JSON string we saw from server, used to detect remote changes
let savePending = false;        // true while a PUT is in flight — pauses polling to avoid clobbering local edits



// ── Convert raw record to internal format ──
function toInternal(r, idx) {
    return {
        id: 'a_' + Date.now().toString(36) + '_' + idx + '_' + Math.random().toString(36).substr(2, 5),
        no: r["No"] || '',
        agency: r["Agency"] || '',
        incidentId: r["ID"] || '',
        releaseDate: r["Release Date"] || '',
        type: r["Type"] || '',
        ioc: r["IoC"] || '',
        status: r["Status"] || 'Open',
        remark: r["Remark"] || '',
        dateAdded: new Date().toISOString(),
        lastModified: new Date().toISOString()
    };
}

// ── Shared server storage (so every PC on the LAN sees the same data) ──
function saveData() {
    const payload = JSON.stringify(alerts);
    savePending = true;
    return fetch(API_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload
    }).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        lastServerSnapshot = payload;   // our write IS the new server state — don't re-pull it on next poll
    }).catch(e => {
        console.error('Save failed:', e);
        showToast('Failed to save to server', 'error');
    }).finally(() => {
        savePending = false;
    });
}

async function loadData() {
    try {
        const r = await fetch(API_URL, { cache: 'no-store' });
        if (!r.ok) return false;
        const data = await r.json();
        if (Array.isArray(data) && data.length > 0) {
            alerts = data;
            lastServerSnapshot = JSON.stringify(data);
            return true;
        }
        return false;
    } catch (e) {
        console.error('Load failed:', e);
        return false;
    }
}

// ── Poll the server so changes made on another PC show up here automatically ──
async function pollServer() {
    // Don't stomp on the user while they are editing or deleting,
    // and don't race our own PUT that's still in flight.
    if (savePending) return;
    if (editingId || deletingIds.length > 0) return;
    if (document.querySelector('.modal-overlay.active')) return;
    if (document.getElementById('detailOverlay')?.classList.contains('active')) return;

    try {
        const r = await fetch(API_URL, { cache: 'no-store' });
        if (!r.ok) return;
        const text = await r.text();
        if (text === lastServerSnapshot) return;   // nothing changed
        const data = JSON.parse(text);
        if (!Array.isArray(data)) return;

        lastServerSnapshot = text;
        alerts = data;

        // Prune selections that no longer exist
        const ids = new Set(alerts.map(a => a.id));
        [...selectedIds].forEach(id => { if (!ids.has(id)) selectedIds.delete(id); });

        applyFilters();
        renderTable();
        updateStats();
    } catch (e) {
        // silent — transient network blips shouldn't spam the UI
    }
}

// ── Init ──
async function init() {

    if (!(await loadData())) {
        // Server has no data yet — seed it from alert_data.json, then PUT to server
        try {
            const resp = await fetch('alert_data.json');
            const data = await resp.json();
            const jsonRecords = data.records || [];
            alerts = jsonRecords.map((r, i) => toInternal(r, i));
        } catch (err) {
            console.error('Failed to load alert_data.json:', err);
            alerts = [];
            showToast('Could not load alert_data.json — starting empty', 'error');
        }
        await saveData();
    }

    bindEvents();
    bindNav();
    applyFilters();
    renderTable();
    updateStats();   // also calls updateCharts() and renderRecent()

    // Dorking module (separate DB on the server)
    await loadDorks();
    bindDorkEvents();
    renderDorks();

    bindTicketEvents();
    bindSearchClears();

    // Keep this PC in sync with edits made on other PCs
    setInterval(pollServer, POLL_INTERVAL_MS);
}

// ── Filtering & Sorting ──
function applyFilters() {
    const search = document.getElementById('searchInput').value.toLowerCase().trim();
    const statusFilter = document.querySelector('.filter-btn.active')?.dataset.filter || 'all';
    const typeFilter = document.getElementById('typeFilter').value;
    const sortBy = document.getElementById('sortFilter').value;

    filteredAlerts = alerts.filter(a => {
        if (statusFilter !== 'all' && a.status.toLowerCase() !== statusFilter) return false;
        if (typeFilter !== 'all' && a.type !== typeFilter) return false;
        if (search) {
            const h = [a.agency, a.incidentId, a.type, a.ioc, a.remark, a.releaseDate, String(a.no)].join(' ').toLowerCase();
            if (!h.includes(search)) return false;
        }
        return true;
    });

    filteredAlerts.sort((a, b) => {
        switch (sortBy) {
            case 'agency': return String(a.agency).localeCompare(String(b.agency));
            case 'status': {
                const ord = { Open: 0, Waiting: 1, CTM: 2, Closed: 3 };
                return ((ord[a.status]??9) - (ord[b.status]??9)) || String(a.no).localeCompare(String(b.no), undefined, {numeric:true});
            }
            case 'date': return parseDate(b.releaseDate) - parseDate(a.releaseDate);
            case 'type': return a.type.localeCompare(b.type) || String(a.no).localeCompare(String(b.no), undefined, {numeric:true});
            default: return String(a.no).localeCompare(String(b.no), undefined, {numeric:true});
        }
    });
}

function parseDate(str) {
    if (!str) return new Date(0);
    const p = String(str).split('/');
    if (p.length === 3) {
        let [d,m,y] = p.map(Number);
        if ([d,m,y].some(Number.isNaN)) return new Date(0);
        if (y < 100) y += 2000;
        const dt = new Date(y, m-1, d);
        return isNaN(dt.getTime()) ? new Date(0) : dt;
    }
    if (p.length === 2) {
        let [d,m] = p.map(Number);
        if ([d,m].some(Number.isNaN)) return new Date(0);
        const dt = new Date(2026, m-1, d);
        return isNaN(dt.getTime()) ? new Date(0) : dt;
    }
    return new Date(0);
}

function getTypeStyle(type) {
    const s = {
        'Admin Login': { bg: '#dbeafe', color: '#1e40af' },
        'Debug Bar': { bg: '#e5e7eb', color: '#374151' },
        'Exposed Data': { bg: '#fef3c7', color: '#92400e' },
        'Index List': { bg: '#d1fae5', color: '#065f46' },
        'PHP Error': { bg: '#fee2e2', color: '#991b1b' },
        'PHP Info': { bg: '#fce7f3', color: '#9d174d' },
        'Vulnerability': { bg: '#e0e7ff', color: '#3730a3' },
        'Exposed Git Repo': { bg: '#fef9c3', color: '#854d0e' },
        'IDOR': { bg: '#ede9fe', color: '#5b21b6' },
        'Apache Tomcat': { bg: '#f5e6fe', color: '#7c3aed' },
        'WinDev/WebDev Error': { bg: '#f0fdf4', color: '#166534' },
        'phpMyAdmin': { bg: '#fff1f2', color: '#be123c' },
    };
    return s[type] || { bg: '#f3f4f6', color: '#4b5563' };
}

function statusCls(status) {
    return { 'Open':'status-open','Closed':'status-closed','Waiting':'status-waiting','CTM':'status-ctm' }[status] || '';
}

// ── Render Table ──
function renderTable() {
    const tbody = document.getElementById('resultsBody');
    if (filteredAlerts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><h3>No alerts match your filters</h3><p>Try adjusting your search or filter criteria</p></div></td></tr>`;
        document.getElementById('showingInfo').textContent = `Showing 0 of ${alerts.length} alerts`;
        syncSelectAll();
        updateBulkActions();
        return;
    }

    const rows = filteredAlerts.map((a, idx) => {
        const sel = selectedIds.has(a.id);
        const ts = getTypeStyle(a.type);
        const sc = statusCls(a.status);
        const rmk = a.remark ? `<span class="remark-text" title="${esc(a.remark)}">${esc(a.remark)}</span>` : `<span class="remark-text empty">—</span>`;
        const iocList = splitIocs(a.ioc);
        let ioc;
        if (iocList.length === 0) {
            ioc = `<span class="no-ioc">—</span>`;
        } else {
            const items = iocList.map((v, i) => `<a href="${esc(iocHref(v))}" target="_blank" rel="noopener noreferrer" class="url-link ioc-item" title="${esc(v)}"><span class="ioc-num">${i+1}.</span>${esc(truncUrl(v))}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg></a>`).join('');
            ioc = `<div class="ioc-stack${iocList.length>1?' multi':''}">${items}</div>`;
        }
        const rc = a.status === 'Closed' ? 'row-closed' : `row-${a.status.toLowerCase()}`;

        return `<tr class="${rc}" data-id="${a.id}">
            <td style="text-align:center"><label class="custom-checkbox"><input type="checkbox" class="row-check" data-id="${a.id}" ${sel?'checked':''}><span class="checkmark"></span></label></td>
            <td><span class="no-badge">${idx + 1}</span></td>
            <td><span class="agency-text">${esc(a.agency)}</span></td>
            <td><span class="incident-id">${esc(a.incidentId)||'—'}</span></td>
            <td><span class="date-text">${esc(a.releaseDate)||'—'}</span></td>
            <td><span class="type-badge" style="background:${ts.bg};color:${ts.color}">${esc(a.type)}</span></td>
            <td class="ioc-cell">${ioc}</td>
            <td><span class="status-badge ${sc}" data-id="${a.id}"><span class="status-dot"></span>${esc(a.status)}</span></td>
            <td><div class="remark-cell">${rmk}</div></td>
            <td><div class="action-btns">
                <button class="action-btn view" title="View" data-id="${a.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
                <button class="action-btn edit" title="Edit" data-id="${a.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                <button class="action-btn delete" title="Delete" data-id="${a.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
            </div></td></tr>`;
    }).join('');

    tbody.innerHTML = rows;
    document.getElementById('showingInfo').textContent = `Showing ${filteredAlerts.length} of ${alerts.length} alerts`;
    syncSelectAll();
    updateBulkActions();
}

// ── Stats ──
function updateStats() {
    const t = alerts.length;
    const o = alerts.filter(a => a.status === 'Open').length;
    const c = alerts.filter(a => a.status === 'Closed').length;
    const w = alerts.filter(a => a.status === 'Waiting').length;
    const m = alerts.filter(a => a.status === 'CTM').length;
    const p = t > 0 ? Math.round((c / t) * 100) : 0;
    animNum('statTotal', t); animNum('statOpen', o); animNum('statClosed', c);
    animNum('statWaiting', w); animNum('statCTM', m);
    animNum('statProgress', p, '%');
    document.getElementById('progressFill').style.width = p + '%';
    const nb = document.getElementById('navAlertCount');
    if (nb) nb.textContent = t;
    updateCharts();
    renderRecent();
}

// ── Navigation (sidebar views) ──
function bindNav() {
    const titles = {
        dashboard: { t: 'Dashboard', s: 'Overview of all security alerts' },
        alerts:    { t: 'Alerts',    s: 'Manage and triage all recorded alerts' },
        analytics: { t: 'Analytics', s: 'Deeper trends across agencies and types' },
        dorking:   { t: 'Dorking',   s: 'Saved dork queries for attack-surface recon' },
        ticket:    { t: 'Ticket Generator', s: 'Generate unique incident IDs (INC:YYYYMMDD-XXXXXX)' }
    };
    const go = view => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('view-active', v.id === 'view' + view.charAt(0).toUpperCase() + view.slice(1)));
        const meta = titles[view] || titles.dashboard;
        document.getElementById('pageTitle').textContent = meta.t;
        document.getElementById('pageSub').textContent = meta.s;
        // Hide alert-only top-bar actions on the Dorking and Ticket views
        const hideTopbar = view === 'dorking' || view === 'ticket';
        ['addNewBtn', 'exportBtn', 'importBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = hideTopbar ? 'none' : '';
        });
        // Lazy-load the Streamlit iframe the first time the Ticket view is opened
        if (view === 'ticket') initTicketGenerator();
        // Recompute chart sizes on show (Chart.js needs a visible canvas)
        requestAnimationFrame(updateCharts);
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarBackdrop')?.classList.remove('active');
    };
    document.querySelectorAll('[data-view]').forEach(btn => {
        btn.addEventListener('click', () => go(btn.dataset.view));
    });
    const tog = document.getElementById('sidebarToggle');
    if (tog) {
        tog.addEventListener('click', () => {
            const sb = document.getElementById('sidebar');
            if (!sb) return;
            sb.classList.toggle('open');
        });
    }
}

// ── Recent Alerts list (Dashboard view) ──
function renderRecent() {
    const el = document.getElementById('recentAlerts');
    if (!el) return;
    const recent = [...alerts]
        .sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0))
        .slice(0, 6);
    if (recent.length === 0) {
        el.innerHTML = '<div class="empty-state"><p>No alerts yet</p></div>';
        return;
    }
    el.innerHTML = recent.map(a => {
        const sc = statusCls(a.status);
        return `<div class="recent-item">
            <div class="recent-no">${esc(String(a.no || '—'))}</div>
            <div class="recent-meta">
                <div class="recent-agency" title="${esc(a.agency)}">${esc(a.agency || '—')}</div>
                <div class="recent-type">${esc(a.type || '—')}</div>
            </div>
            <span class="recent-date">${esc(a.releaseDate || '—')}</span>
            <span class="status-badge ${sc}"><span class="status-dot"></span>${esc(a.status)}</span>
        </div>`;
    }).join('');
}

// ── Charts ──
const _charts = {};
function chartColors() {
    const css = getComputedStyle(document.documentElement);
    const v = n => css.getPropertyValue(n).trim();
    return {
        open: v('--open-border') || '#22c55e',
        waiting: v('--waiting-border') || '#3b82f6',
        ctm: v('--ctm-border') || '#eab308',
        closed: v('--closed-border') || '#ef4444',
        accent: v('--accent') || '#6882f7',
        text: v('--text-secondary') || '#9ba3b8',
        grid: v('--border') || '#2d3154',
        bg: v('--bg-card') || '#1a1d2e'
    };
}

function destroyChart(key) {
    if (_charts[key]) { _charts[key].destroy(); _charts[key] = null; }
}

function updateCharts() {
    if (typeof Chart === 'undefined') return;
    const c = chartColors();
    const byStatus = { Open: 0, Waiting: 0, CTM: 0, Closed: 0 };
    alerts.forEach(a => { if (byStatus[a.status] != null) byStatus[a.status]++; });

    // Always tear down stale instances first so hidden views never hold outdated charts.
    ['status', 'type', 'agencies', 'progress', 'stacked'].forEach(destroyChart);
    const isVisible = el => !!el && el.offsetParent !== null;

    // Status donut
    const elStatus = document.getElementById('chartStatus');
    if (isVisible(elStatus)) {
        _charts.status = new Chart(elStatus, {
            type: 'doughnut',
            data: {
                labels: ['Open', 'Waiting', 'CTM', 'Closed'],
                datasets: [{
                    data: [byStatus.Open, byStatus.Waiting, byStatus.CTM, byStatus.Closed],
                    backgroundColor: [c.open, c.waiting, c.ctm, c.closed],
                    borderColor: c.bg, borderWidth: 3, hoverOffset: 6
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, cutout: '65%',
                plugins: { legend: { position: 'bottom', labels: { color: c.text, font: { size: 12, weight: '600' }, padding: 12, usePointStyle: true } } }
            }
        });
    }

    // Type bar
    const elType = document.getElementById('chartType');
    if (isVisible(elType)) {
        const byType = {};
        alerts.forEach(a => { const t = a.type || 'Unknown'; byType[t] = (byType[t] || 0) + 1; });
        const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8);
        _charts.type = new Chart(elType, {
            type: 'bar',
            data: {
                labels: entries.map(e => e[0]),
                datasets: [{
                    data: entries.map(e => e[1]),
                    backgroundColor: c.accent,
                    borderRadius: 6, borderSkipped: false, maxBarThickness: 28
                }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { beginAtZero: true, grid: { color: c.grid, drawBorder: false }, ticks: { color: c.text, precision: 0 } },
                    y: { grid: { display: false }, ticks: { color: c.text, font: { weight: '600' } } }
                }
            }
        });
    }

    // Analytics — Top Agencies
    const elAg = document.getElementById('chartAgencies');
    if (isVisible(elAg)) {
        const byAg = {};
        alerts.forEach(a => { const k = a.agency || 'Unknown'; byAg[k] = (byAg[k] || 0) + 1; });
        const top = Object.entries(byAg).sort((a, b) => b[1] - a[1]).slice(0, 10);
        _charts.agencies = new Chart(elAg, {
            type: 'bar',
            data: {
                labels: top.map(e => e[0].length > 26 ? e[0].slice(0, 26) + '…' : e[0]),
                datasets: [{ data: top.map(e => e[1]), backgroundColor: c.accent, borderRadius: 6, maxBarThickness: 22 }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { beginAtZero: true, grid: { color: c.grid }, ticks: { color: c.text, precision: 0 } },
                    y: { grid: { display: false }, ticks: { color: c.text, font: { size: 11, weight: '600' } } }
                }
            }
        });
    }

    // Analytics — Resolution Progress (closed vs remaining)
    const elProg = document.getElementById('chartProgress');
    if (isVisible(elProg)) {
        const closed = byStatus.Closed;
        const remaining = byStatus.Open + byStatus.Waiting + byStatus.CTM;
        _charts.progress = new Chart(elProg, {
            type: 'doughnut',
            data: {
                labels: ['Closed', 'Remaining'],
                datasets: [{
                    data: [closed, remaining],
                    backgroundColor: [c.closed, c.accent],
                    borderColor: c.bg, borderWidth: 3
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, cutout: '72%',
                plugins: { legend: { position: 'bottom', labels: { color: c.text, usePointStyle: true, padding: 14 } } }
            }
        });
    }

    // Analytics — Status by Type stacked
    const elSt = document.getElementById('chartStacked');
    if (isVisible(elSt)) {
        const typeMap = {};
        alerts.forEach(a => {
            const t = a.type || 'Unknown';
            if (!typeMap[t]) typeMap[t] = { Open: 0, Waiting: 0, CTM: 0, Closed: 0 };
            if (typeMap[t][a.status] != null) typeMap[t][a.status]++;
        });
        const labels = Object.keys(typeMap).sort((a, b) => {
            const sa = Object.values(typeMap[a]).reduce((x, y) => x + y, 0);
            const sb = Object.values(typeMap[b]).reduce((x, y) => x + y, 0);
            return sb - sa;
        }).slice(0, 10);
        const mk = (k, color) => ({ label: k, data: labels.map(l => typeMap[l][k]), backgroundColor: color, borderRadius: 4, borderSkipped: false });
        _charts.stacked = new Chart(elSt, {
            type: 'bar',
            data: { labels, datasets: [ mk('Open', c.open), mk('Waiting', c.waiting), mk('CTM', c.ctm), mk('Closed', c.closed) ] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { color: c.text, usePointStyle: true, padding: 12 } } },
                scales: {
                    x: { stacked: true, grid: { display: false }, ticks: { color: c.text, font: { size: 11 } } },
                    y: { stacked: true, beginAtZero: true, grid: { color: c.grid }, ticks: { color: c.text, precision: 0 } }
                }
            }
        });
    }
}

function animNum(id, target, suffix = '') {
    const el = document.querySelector(`#${id} .stat-value`); if (!el) return;
    const cur = parseInt(el.textContent) || 0;
    if (cur === target) { el.textContent = target + suffix; return; }
    const d = target - cur; const steps = Math.min(Math.abs(d), 20) || 1; const inc = d / steps; let s = 0;
    const t = setInterval(() => {
        s++;
        if (s >= steps) { el.textContent = target + suffix; clearInterval(t); }
        else el.textContent = Math.round(cur + inc * s) + suffix;
    }, 30);
}

// ── Events ──
function bindEvents() {
    const si = document.getElementById('searchInput');
    let debounce;
    si.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { applyFilters(); renderTable(); }, 200); });
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey||e.metaKey) && e.key === 'k') { e.preventDefault(); si.focus(); si.select(); }
        if (e.key === 'Escape') closeAllModals();
    });

    document.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active'); applyFilters(); renderTable();
    }));

    document.getElementById('typeFilter').addEventListener('change', () => { applyFilters(); renderTable(); });
    document.getElementById('sortFilter').addEventListener('change', () => { applyFilters(); renderTable(); });
    document.getElementById('selectAll').addEventListener('change', e => {
        if (e.target.checked) filteredAlerts.forEach(a => selectedIds.add(a.id)); else selectedIds.clear();
        renderTable();
    });

    document.getElementById('resultsBody').addEventListener('click', e => {
        const cb = e.target.closest('.row-check'); if (cb) { cb.checked ? selectedIds.add(cb.dataset.id) : selectedIds.delete(cb.dataset.id); syncSelectAll(); updateBulkActions(); return; }
        const v = e.target.closest('.action-btn.view'); if (v) { openDetail(v.dataset.id); return; }
        const ed = e.target.closest('.action-btn.edit'); if (ed) { openEditModal(ed.dataset.id); return; }
        const dl = e.target.closest('.action-btn.delete'); if (dl) { openDeleteModal([dl.dataset.id]); return; }
    });

    document.getElementById('bulkMarkOpen').addEventListener('click', () => bulkSet('Open'));
    document.getElementById('bulkMarkClosed').addEventListener('click', () => bulkSet('Closed'));
    document.getElementById('bulkMarkWaiting').addEventListener('click', () => bulkSet('Waiting'));
    document.getElementById('bulkMarkCTM').addEventListener('click', () => bulkSet('CTM'));
    document.getElementById('bulkDelete').addEventListener('click', () => openDeleteModal([...selectedIds]));

    // Modals
    document.getElementById('addNewBtn').addEventListener('click', openAddModal);
    document.getElementById('closeModal').addEventListener('click', () => closeModal('addModal'));
    document.getElementById('cancelModal').addEventListener('click', () => closeModal('addModal'));
    document.getElementById('saveNewBtn').addEventListener('click', saveNewAlert);
    document.getElementById('closeEditModal').addEventListener('click', () => closeModal('editModal'));
    document.getElementById('cancelEditModal').addEventListener('click', () => closeModal('editModal'));
    document.getElementById('saveEditBtn').addEventListener('click', saveEditAlert);
    document.getElementById('closeDeleteModal').addEventListener('click', () => closeModal('deleteModal'));
    document.getElementById('cancelDeleteModal').addEventListener('click', () => closeModal('deleteModal'));
    document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
    document.getElementById('closeDetail').addEventListener('click', closeDetail);
    document.getElementById('detailOverlay').addEventListener('click', e => { if (e.target.id === 'detailOverlay') closeDetail(); });
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
    document.getElementById('importFile').addEventListener('change', importData);
    document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) closeAllModals(); }));
}

function bulkSet(status) {
    selectedIds.forEach(id => { const a = alerts.find(x => x.id === id); if (a) { a.status = status; a.lastModified = new Date().toISOString(); } });
    saveData(); selectedIds.clear(); applyFilters(); renderTable(); updateStats();
    showToast(`Marked as ${status}`, status === 'Closed' ? 'success' : 'info');
}

// ── CRUD ──
const FIELD_MAX = { agency: 200, incidentId: 100, releaseDate: 20, type: 50, ioc: 10000, status: 20, remark: 2000, no: 20 };
const VALID_STATUSES = ['Open','Closed','Waiting','CTM'];

function clampField(v, max) {
    if (v == null) return '';
    return String(v).slice(0, max);
}

function openAddModal() {
    ['newAgency','newIncidentId','newIoC','newRemark'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('newReleaseDate').value = '';
    document.getElementById('newType').value = '';
    document.getElementById('newAlertStatus').value = '';
    document.getElementById('addModal').classList.add('active');
    setTimeout(() => document.getElementById('newAgency').focus(), 100);
}

function saveNewAlert() {
    const agency = document.getElementById('newAgency').value.trim();
    const type = document.getElementById('newType').value;
    const status = document.getElementById('newAlertStatus').value;
    if (!agency) { showToast('Agency name is required', 'error'); return; }
    if (agency.length > FIELD_MAX.agency) { showToast(`Agency too long (max ${FIELD_MAX.agency} chars)`, 'error'); return; }
    if (!type) { showToast('Please select a type', 'error'); return; }
    if (!status) { showToast('Please select a status', 'error'); return; }
    const maxNo = alerts.reduce((m, a) => { const n = parseInt(a.no); return isNaN(n) ? m : Math.max(m, n); }, 0);
    const now = new Date().toISOString();
    const rd = document.getElementById('newReleaseDate').value;
    let fd = '';
    if (rd) { const d = new Date(rd); fd = `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`; }
    alerts.push({
        id: 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2,6),
        no: String(maxNo + 1), agency: clampField(agency, FIELD_MAX.agency),
        incidentId: clampField(document.getElementById('newIncidentId').value.trim(), FIELD_MAX.incidentId),
        releaseDate: fd, type: clampField(type, FIELD_MAX.type),
        ioc: clampField(splitIocs(document.getElementById('newIoC').value).join('\n'), FIELD_MAX.ioc),
        status: status,
        remark: clampField(document.getElementById('newRemark').value.trim(), FIELD_MAX.remark),
        dateAdded: now, lastModified: now
    });
    saveData(); closeModal('addModal'); applyFilters(); renderTable(); updateStats();
    showToast(`Alert added: ${agency}`, 'success');
}

function openEditModal(id) {
    const a = alerts.find(x => x.id === id); if (!a) return; editingId = id;
    document.getElementById('editAgency').value = a.agency;
    document.getElementById('editIncidentId').value = a.incidentId;
    if (a.releaseDate) {
        const pd = parseDate(a.releaseDate);
        if (pd.getFullYear() > 1970) document.getElementById('editReleaseDate').value = `${pd.getFullYear()}-${String(pd.getMonth()+1).padStart(2,'0')}-${String(pd.getDate()).padStart(2,'0')}`;
        else document.getElementById('editReleaseDate').value = '';
    } else document.getElementById('editReleaseDate').value = '';
    document.getElementById('editType').value = a.type;
    document.getElementById('editIoC').value = splitIocs(a.ioc).join('\n');
    document.getElementById('editAlertStatus').value = a.status;
    document.getElementById('editRemark').value = a.remark;
    document.getElementById('editModal').classList.add('active');
}

function saveEditAlert() {
    if (!editingId) return; const a = alerts.find(x => x.id === editingId); if (!a) return;
    const agency = document.getElementById('editAgency').value.trim();
    if (!agency) { showToast('Agency name is required', 'error'); return; }
    if (agency.length > FIELD_MAX.agency) { showToast(`Agency too long (max ${FIELD_MAX.agency} chars)`, 'error'); return; }
    const rd = document.getElementById('editReleaseDate').value;
    let fd = ''; if (rd) { const d = new Date(rd); fd = `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}`; }
    a.agency = clampField(agency, FIELD_MAX.agency);
    a.incidentId = clampField(document.getElementById('editIncidentId').value.trim(), FIELD_MAX.incidentId);
    a.releaseDate = fd;
    a.type = clampField(document.getElementById('editType').value, FIELD_MAX.type);
    a.ioc = clampField(splitIocs(document.getElementById('editIoC').value).join('\n'), FIELD_MAX.ioc);
    a.status = document.getElementById('editAlertStatus').value;
    a.remark = clampField(document.getElementById('editRemark').value.trim(), FIELD_MAX.remark);
    a.lastModified = new Date().toISOString();
    saveData(); closeModal('editModal'); applyFilters(); renderTable(); updateStats();
    showToast(`Updated: ${agency}`, 'success'); editingId = null;
}

function openDeleteModal(ids) {
    deletingIds = ids;
    document.getElementById('deleteCount').textContent = ids.length === 1 ? '1 alert will be deleted' : `${ids.length} alerts will be deleted`;
    document.getElementById('deleteModal').classList.add('active');
}
function confirmDelete() {
    alerts = alerts.filter(a => !deletingIds.includes(a.id));
    deletingIds.forEach(id => selectedIds.delete(id));
    saveData(); closeModal('deleteModal'); applyFilters(); renderTable(); updateStats();
    showToast(`${deletingIds.length} alert(s) deleted`, 'info'); deletingIds = [];
}

// ── Detail Panel ──
function openDetail(id) {
    const a = alerts.find(x => x.id === id); if (!a) return;
    const sc = statusCls(a.status); const ts = getTypeStyle(a.type);
    document.getElementById('detailBody').innerHTML = `
        <div class="detail-field"><div class="detail-field-label">Status</div><div class="detail-field-value"><span class="status-badge ${sc}"><span class="status-dot"></span>${esc(a.status)}</span></div></div>
        <div class="detail-field"><div class="detail-field-label">Agency</div><div class="detail-field-value">${esc(a.agency)}</div></div>
        <div class="detail-field"><div class="detail-field-label">Incident ID</div><div class="detail-field-value" style="font-family:'JetBrains Mono',monospace;font-size:13px">${esc(a.incidentId)||'—'}</div></div>
        <div class="detail-field"><div class="detail-field-label">Alert No.</div><div class="detail-field-value">${esc(String(a.no))}</div></div>
        <div class="detail-field"><div class="detail-field-label">Release Date</div><div class="detail-field-value">${esc(a.releaseDate)||'—'}</div></div>
        <div class="detail-field"><div class="detail-field-label">Type</div><div class="detail-field-value"><span class="type-badge" style="background:${ts.bg};color:${ts.color}">${esc(a.type)}</span></div></div>
        <div class="detail-field"><div class="detail-field-label">IoC${splitIocs(a.ioc).length>1?` <span class="ioc-count">(${splitIocs(a.ioc).length})</span>`:''}</div><div class="detail-field-value">${splitIocs(a.ioc).length?`<ul class="ioc-list">${splitIocs(a.ioc).map(v=>`<li><a href="${esc(iocHref(v))}" target="_blank" rel="noopener noreferrer">${esc(v)}</a></li>`).join('')}</ul>`:'—'}</div></div>
        <div class="detail-field"><div class="detail-field-label">Remark</div><div class="detail-field-value">${esc(a.remark)||'—'}</div></div>
        <div class="detail-field"><div class="detail-field-label">Last Modified</div><div class="detail-field-value" style="font-size:12px;color:var(--text-muted)">${a.lastModified?new Date(a.lastModified).toLocaleString():'—'}</div></div>`;
    document.getElementById('detailOverlay').classList.add('active');
}
function closeDetail() { document.getElementById('detailOverlay').classList.remove('active'); }

// ── Export / Import ──
function exportData() {
    const blob = new Blob([JSON.stringify(alerts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `alerttracker_export_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Data exported', 'success');
}

function sanitizeImported(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const now = new Date().toISOString();
    const status = VALID_STATUSES.includes(entry.status) ? entry.status : 'Open';
    return {
        id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 80)
            : 'a_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2,6),
        no: clampField(entry.no, FIELD_MAX.no),
        agency: clampField(entry.agency, FIELD_MAX.agency),
        incidentId: clampField(entry.incidentId, FIELD_MAX.incidentId),
        releaseDate: clampField(entry.releaseDate, FIELD_MAX.releaseDate),
        type: clampField(entry.type, FIELD_MAX.type),
        ioc: clampField(entry.ioc, FIELD_MAX.ioc),
        status,
        remark: clampField(entry.remark, FIELD_MAX.remark),
        dateAdded: typeof entry.dateAdded === 'string' ? entry.dateAdded.slice(0, 40) : now,
        lastModified: typeof entry.lastModified === 'string' ? entry.lastModified.slice(0, 40) : now
    };
}

function importData(e) {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 20 * 1024 * 1024) { showToast('File too large (max 20 MB)', 'error'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = ev => {
        try {
            let imp = JSON.parse(ev.target.result);
            if (imp && typeof imp === 'object' && Array.isArray(imp.records)) {
                imp = imp.records.map((r,i) => toInternal(r,i));
            }
            if (!Array.isArray(imp)) { showToast('Invalid file format', 'error'); return; }
            const existing = new Set(alerts.map(a => a.id));
            let added = 0, skipped = 0;
            imp.forEach(raw => {
                const entry = sanitizeImported(raw);
                if (!entry) { skipped++; return; }
                if (existing.has(entry.id)) { skipped++; return; }
                alerts.push(entry); existing.add(entry.id); added++;
            });
            saveData(); applyFilters(); renderTable(); updateStats();
            showToast(`Imported ${added} new, ${skipped} skipped`, 'success');
        } catch (err) { showToast('Failed to parse file', 'error'); console.error(err); }
    };
    reader.readAsText(file); e.target.value = '';
}

// ── Helpers ──
function syncSelectAll() {
    const sa = document.getElementById('selectAll');
    if (!sa) return;
    if (filteredAlerts.length === 0) {
        sa.checked = false;
        sa.indeterminate = false;
        return;
    }
    const visibleSelected = filteredAlerts.filter(a => selectedIds.has(a.id)).length;
    sa.checked = visibleSelected === filteredAlerts.length;
    sa.indeterminate = visibleSelected > 0 && visibleSelected < filteredAlerts.length;
}

function updateBulkActions() {
    const el = document.getElementById('bulkActions');
    if (selectedIds.size > 0) { el.style.display = 'flex'; document.getElementById('selectedCount').textContent = selectedIds.size + ' selected'; }
    else el.style.display = 'none';
}
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
function closeAllModals() { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active')); closeDetail(); }

function showToast(message, type = 'info') {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div'); t.className = `toast ${type}`;
    const icons = {
        success:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>',
        error:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
        info:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
    };
    t.innerHTML = `${icons[type]||icons.info} <span>${esc(message)}</span>`;
    c.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
}

function esc(str) { if (!str) return ''; const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
function truncUrl(url) {
    try { const u = new URL(url); const p = u.pathname + u.search; return u.hostname + (p.length > 30 ? p.substring(0,30) + '…' : p); }
    catch { return url.length > 50 ? url.substring(0,50) + '…' : url; }
}
function splitIocs(str) {
    if (!str) return [];
    return String(str).split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
}
function iocHref(v) { return /^https?:\/\//i.test(v) ? v : 'https://' + v; }

// ── Reveal dashboard after intro ──
function revealDashboard() {
    document.getElementById('dashboardWrap').style.display = '';
    init();
}

/* ============================================================
   Ticket ID Generator (native port of Code.py)
   - Same CVCDVC algorithm + duplicate-check running server-side
   - Same save path (~/Documents/Generated Code/generated_codes.txt)
   ============================================================ */
const TICKET_API = '/api/tickets';
let _ticketInit = false;

async function initTicketGenerator() {
    if (_ticketInit) return;
    _ticketInit = true;
    loadTicketHistory();
}

async function loadTicketHistory() {
    const list = document.getElementById('ticketHistoryList');
    if (!list) return;
    list.innerHTML = '<div class="ticket-history-empty">Loading…</div>';
    try {
        const r = await fetch(TICKET_API, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (!Array.isArray(data) || data.length === 0) {
            list.innerHTML = '<div class="ticket-history-empty">No codes generated yet.</div>';
            return;
        }
        list.innerHTML = data.map(entry => `
            <div class="ticket-history-item">
                <div style="min-width:0;flex:1">
                    <div class="ticket-history-code">${esc(entry.code || '')}</div>
                    <div class="ticket-history-meta">${esc(entry.timestamp || '')}</div>
                </div>
                <button class="ticket-history-copy" data-copy="${esc(entry.code || '')}" title="Copy" aria-label="Copy code">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                </button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Ticket history load failed:', e);
        list.innerHTML = '<div class="ticket-history-empty">Failed to load history.</div>';
    }
}

async function generateTicket(e) {
    if (e) e.preventDefault();
    const prefix = document.getElementById('ticketPrefix').value;
    const dateRaw = document.getElementById('ticketDate').value.trim();
    const btn = document.getElementById('ticketGenerateBtn');
    const result = document.getElementById('ticketResult');
    const codeEl = document.getElementById('ticketResultCode');
    const metaEl = document.getElementById('ticketResultMeta');

    // Light client-side validation; server is authoritative.
    if (dateRaw && !/^\d{8}$/.test(dateRaw)) {
        showToast('Date must be 8 digits (YYYYMMDD) or empty', 'error');
        return;
    }

    btn.disabled = true;
    const origLabel = btn.querySelector('span')?.textContent;
    if (origLabel) btn.querySelector('span').textContent = 'Generating…';

    try {
        const r = await fetch(TICKET_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix, date: dateRaw })
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));

        codeEl.textContent = data.full_code;
        metaEl.textContent = `${data.timestamp}  •  attempt ${data.attempts}/1000`;
        result.hidden = false;
        showToast('New code generated', 'success');
        loadTicketHistory();
    } catch (err) {
        console.error('generateTicket failed:', err);
        showToast(err.message || 'Failed to generate code', 'error');
    } finally {
        btn.disabled = false;
        if (origLabel) btn.querySelector('span').textContent = origLabel;
    }
}

function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showToast('Copied to clipboard', 'success'))
            .catch(() => showToast('Copy failed', 'error'));
    } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showToast('Copied to clipboard', 'success'); }
        catch (_) { showToast('Copy failed', 'error'); }
        document.body.removeChild(ta);
    }
}

function bindTicketEvents() {
    document.getElementById('ticketForm')?.addEventListener('submit', generateTicket);
    document.getElementById('ticketHistoryRefresh')?.addEventListener('click', loadTicketHistory);
    document.getElementById('ticketCopyBtn')?.addEventListener('click', () => {
        const t = document.getElementById('ticketResultCode')?.textContent || '';
        copyToClipboard(t.trim());
    });
    document.getElementById('ticketHistoryList')?.addEventListener('click', e => {
        const btn = e.target.closest('[data-copy]');
        if (btn) copyToClipboard(btn.dataset.copy);
    });
}


// ── Search-box clear (×) buttons ──
function bindSearchClears() {
    document.querySelectorAll('.search-box').forEach(box => {
        const input = box.querySelector('input');
        const btn = box.querySelector('.search-clear');
        if (!input || !btn) return;
        const sync = () => box.classList.toggle('has-value', input.value.length > 0);
        input.addEventListener('input', sync);
        btn.addEventListener('click', () => {
            input.value = '';
            sync();
            input.focus();
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        sync();
    });
}

/* ============================================================
   Cinematic Cyber Intro (plays for ~3.5s, then hands off)
   ============================================================ */
function runCyberIntro(onDone) {
    const el = document.getElementById('introSplash');
    if (!el) { onDone(); return; }

    // Matrix rain
    const canvas = document.getElementById('introMatrix');
    let rafId = null;
    let audioCtx = null;
    if (canvas && canvas.getContext) {
        const ctx = canvas.getContext('2d');
        const charset = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF<>#$%*';
        let cols = 0, drops = [];
        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            cols = Math.floor(canvas.width / 16);
            drops = new Array(cols).fill(0).map(() => Math.random() * -50);
        };
        resize();
        window.addEventListener('resize', resize);

        const draw = () => {
            ctx.fillStyle = 'rgba(15, 17, 23, 0.20)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.font = '14px "JetBrains Mono", monospace';
            for (let i = 0; i < cols; i++) {
                const ch = charset[Math.floor(Math.random() * charset.length)];
                const x = i * 16;
                const y = drops[i] * 16;
                ctx.fillStyle = y < 40 ? '#e8eaf0' : 'rgba(104, 130, 247, 0.75)';
                ctx.fillText(ch, x, y);
                if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
                drops[i] += 1;
            }
            rafId = requestAnimationFrame(draw);
        };
        draw();
    }

    // Reveal boot-log lines on their declared delays
    document.querySelectorAll('#introBoot .boot-line').forEach(ln => {
        const d = parseInt(ln.dataset.delay || '0', 10);
        ln.style.animationDelay = d + 'ms';
    });

    // Soft digital "boot" sound via WebAudio (no external file needed)
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
            audioCtx = new AC();
            const playBeep = (freq, when, dur = 0.12, vol = 0.06) => {
                const o = audioCtx.createOscillator();
                const g = audioCtx.createGain();
                o.type = 'sine';
                o.frequency.setValueAtTime(freq, audioCtx.currentTime + when);
                g.gain.setValueAtTime(0, audioCtx.currentTime + when);
                g.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + when + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + when + dur);
                o.connect(g).connect(audioCtx.destination);
                o.start(audioCtx.currentTime + when);
                o.stop(audioCtx.currentTime + when + dur + 0.02);
            };
            // Browsers suspend until user gesture; this is best-effort only.
            if (audioCtx.state === 'running') {
                playBeep(440, 0.05);
                playBeep(660, 0.25);
                playBeep(880, 0.55, 0.18, 0.05);
                playBeep(1320, 2.6, 0.25, 0.05);
            }
        }
    } catch (_) { /* silent */ }

    // Subtle mouse parallax
    const content = document.getElementById('introContent');
    const onMove = (e) => {
        const x = (e.clientX / window.innerWidth  - 0.5) * 10;
        const y = (e.clientY / window.innerHeight - 0.5) * 10;
        if (content) content.style.transform = `translate(${x}px, ${y}px)`;
    };
    window.addEventListener('mousemove', onMove);

    // Allow click / key / touch to skip
    const finish = () => {
        el.classList.add('intro-fade-out');
        window.removeEventListener('mousemove', onMove);
        setTimeout(() => {
            el.classList.add('intro-hidden');
            if (rafId) cancelAnimationFrame(rafId);
            if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
            onDone();
        }, 650);
    };
    const skip = () => { clearTimeout(timer); finish(); };
    el.addEventListener('click', skip, { once: true });
    window.addEventListener('keydown', skip, { once: true });

    const timer = setTimeout(finish, 3800);
}

// ── Start ──
const INTRO_KEY = 'wwt_intro_last';
const INTRO_TTL_MS = 60 * 60 * 1000; // 1 hour

function shouldPlayIntro() {
    const last = parseInt(localStorage.getItem(INTRO_KEY) || '0', 10);
    return !(last && Date.now() - last < INTRO_TTL_MS);
}

function markIntroSeen() {
    try { localStorage.setItem(INTRO_KEY, String(Date.now())); } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {
    if (shouldPlayIntro()) {
        markIntroSeen();
        runCyberIntro(revealDashboard);
    } else {
        const el = document.getElementById('introSplash');
        if (el) el.remove();
        revealDashboard();
    }
});


/* ============================================================
   Dorking module — separate DB (/api/dorks, dorking_data.db)
   ============================================================ */
const DORK_API = '/api/dorks';
let dorks = [];
let editingDorkId = null;

async function loadDorks() {
    try {
        const r = await fetch(DORK_API, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        dorks = Array.isArray(data) ? data : [];
    } catch (e) {
        console.error('loadDorks failed:', e);
        dorks = [];
    }
    const nb = document.getElementById('navDorkCount');
    if (nb) nb.textContent = dorks.length;
}

function saveDorks() {
    const payload = JSON.stringify(dorks);
    return fetch(DORK_API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload
    }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); })
      .catch(e => { console.error('saveDorks failed:', e); showToast('Failed to save dorks', 'error'); });
}

function searchEngineUrl(engine, q) {
    const enc = encodeURIComponent(q);
    switch ((engine || 'google').toLowerCase()) {
        case 'bing':       return 'https://www.bing.com/search?q=' + enc;
        case 'duckduckgo': return 'https://duckduckgo.com/?q=' + enc;
        case 'yandex':     return 'https://yandex.com/search/?text=' + enc;
        default:           return 'https://www.google.com/search?q=' + enc;
    }
}

function runDork(query) {
    const engine = document.getElementById('dorkEngine')?.value || 'google';
    window.open(searchEngineUrl(engine, query), '_blank', 'noopener,noreferrer');
}

function refreshDorkCategoryUI() {
    const cats = [...new Set(dorks.map(d => d.category || 'Uncategorized'))].sort();
    const sel = document.getElementById('dorkCategoryFilter');
    if (sel) {
        const cur = sel.value;
        sel.innerHTML = '<option value="all">All Categories</option>' +
            cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        sel.value = cats.includes(cur) || cur === 'all' ? cur : 'all';
    }
    const catSel = document.getElementById('dorkCategory');
    if (catSel) {
        const cur = catSel.value;
        catSel.innerHTML =
            '<option value="" disabled>Please select...</option>' +
            cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') +
            '<option value="__new__">+ New category…</option>';
        // Restore selection if still valid
        if (cur && (cats.includes(cur) || cur === '__new__')) catSel.value = cur;
        else catSel.selectedIndex = 0;
    }
}

function renderDorks() {
    refreshDorkCategoryUI();
    const container = document.getElementById('dorkGroups');
    if (!container) return;
    const search = (document.getElementById('dorkSearch')?.value || '').toLowerCase().trim();
    const catFilter = document.getElementById('dorkCategoryFilter')?.value || 'all';

    const filtered = dorks.filter(d => {
        if (catFilter !== 'all' && (d.category || 'Uncategorized') !== catFilter) return false;
        if (!search) return true;
        const hay = `${d.title} ${d.query} ${d.description} ${d.category}`.toLowerCase();
        return hay.includes(search);
    });

    if (!filtered.length) {
        container.innerHTML = `<div class="dork-empty">No dorks match your filters. Click <strong>New Dork</strong> to add one.</div>`;
        return;
    }

    const groups = {};
    filtered.forEach(d => {
        const k = d.category || 'Uncategorized';
        (groups[k] = groups[k] || []).push(d);
    });

    const html = Object.keys(groups).sort().map(cat => {
        const items = groups[cat].map(d => `
            <button class="dork-card" data-id="${esc(d.id)}" data-action="run" type="button" title="Click to search">
                <div class="dork-card-head">
                    <div class="dork-card-title">${esc(d.title || '(untitled)')}</div>
                    <span class="dork-card-edit" data-id="${esc(d.id)}" data-action="edit" title="Edit" aria-label="Edit dork" role="button">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </span>
                </div>
                <div class="dork-card-query">${esc(d.query)}</div>
                ${d.description ? `<div class="dork-card-desc">${esc(d.description)}</div>` : ''}
                <div class="dork-card-foot">
                    <span class="dork-card-tag">${esc(d.category || 'Uncategorized')}</span>
                    <span class="dork-run-pill">
                        Run
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 17L17 7M9 7h8v8"/></svg>
                    </span>
                </div>
            </button>
        `).join('');
        return `
            <div class="dork-group">
                <div class="dork-group-title">
                    <span class="dork-group-icon">${categoryIconSvg(cat)}</span>
                    <div>
                        <h4>${esc(cat)}</h4>
                        <span class="dork-group-sub">${groups[cat].length} ${groups[cat].length === 1 ? 'query' : 'queries'}</span>
                    </div>
                    <span class="dork-group-count">${groups[cat].length}</span>
                </div>
                <div class="dork-grid">${items}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

function categoryIconSvg(cat) {
    const c = (cat || '').toLowerCase();
    const mk = (inner) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    if (c.includes('admin') || c.includes('login'))
        return mk('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>');
    if (c.includes('directory') || c.includes('listing'))
        return mk('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>');
    if (c.includes('exposed') || c.includes('file'))
        return mk('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>');
    if (c.includes('error') || c.includes('debug'))
        return mk('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>');
    if (c.includes('wordpress') || c.includes('joomla') || c.includes('drupal') || c.includes('cms'))
        return mk('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>');
    if (c.includes('server') || c.includes('service'))
        return mk('<rect x="2" y="4" width="20" height="6" rx="1"/><rect x="2" y="14" width="20" height="6" rx="1"/><path d="M6 7h.01M6 17h.01"/>');
    if (c.includes('vulnerab'))
        return mk('<path d="M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6z"/><path d="M9 12l2 2 4-4"/>');
    if (c.includes('seo') || c.includes('spam'))
        return mk('<path d="M3 3l18 18"/><path d="M10.5 6.5A6 6 0 0118 12m-2.1 4.2A6 6 0 016 12a6 6 0 012-4.5"/>');
    return mk('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>');
}

function openDorkModal(id) {
    editingDorkId = id || null;
    const title = document.getElementById('dorkModalTitle');
    const delBtn = document.getElementById('dorkDeleteBtn');

    // Rebuild the category <select> so it includes any freshly-added categories
    refreshDorkCategoryUI();
    const catSel = document.getElementById('dorkCategory');
    const catNew = document.getElementById('dorkCategoryNew');
    catNew.value = '';
    catNew.style.display = 'none';

    if (id) {
        const d = dorks.find(x => x.id === id);
        if (!d) return;
        title.lastChild.nodeValue = 'Edit Dork';
        document.getElementById('dorkTitle').value = d.title || '';
        document.getElementById('dorkQuery').value = d.query || '';
        document.getElementById('dorkDescription').value = d.description || '';
        // Select the existing category, or fall back to the "New" option if it's gone
        if (d.category && [...catSel.options].some(o => o.value === d.category)) {
            catSel.value = d.category;
        } else if (d.category) {
            catSel.value = '__new__';
            catNew.value = d.category;
            catNew.style.display = '';
        } else {
            catSel.selectedIndex = 0;
        }
        delBtn.style.display = '';
    } else {
        title.lastChild.nodeValue = 'New Dork';
        document.getElementById('dorkTitle').value = '';
        document.getElementById('dorkQuery').value = '';
        document.getElementById('dorkDescription').value = '';
        catSel.selectedIndex = 0;
        delBtn.style.display = 'none';
    }
    document.getElementById('dorkModal').classList.add('active');
    setTimeout(() => document.getElementById('dorkTitle').focus(), 50);
}

function closeDorkModal() {
    document.getElementById('dorkModal').classList.remove('active');
    editingDorkId = null;
}

async function saveDorkFromModal() {
    const title = document.getElementById('dorkTitle').value.trim();
    const catSel = document.getElementById('dorkCategory');
    const catNew = document.getElementById('dorkCategoryNew');
    let category;
    if (catSel.value === '__new__') {
        category = catNew.value.trim();
        if (!category) { showToast('Please enter the new category name', 'error'); return; }
    } else {
        category = catSel.value.trim();
    }
    if (!category) { showToast('Please select a category', 'error'); return; }

    const query = document.getElementById('dorkQuery').value.trim();
    const description = document.getElementById('dorkDescription').value.trim();

    if (!title)  { showToast('Title is required', 'error'); return; }
    if (!query)  { showToast('Query is required', 'error'); return; }
    if (query.length > 2000) { showToast('Query too long (max 2000 chars)', 'error'); return; }

    const now = new Date().toISOString();
    if (editingDorkId) {
        const d = dorks.find(x => x.id === editingDorkId);
        if (d) Object.assign(d, { title, category, query, description });
        showToast('Dork updated', 'success');
    } else {
        dorks.push({
            id: 'd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
            title, category, query, description, created_at: now
        });
        showToast('Dork added', 'success');
    }
    await saveDorks();
    closeDorkModal();
    renderDorks();
    const nb = document.getElementById('navDorkCount');
    if (nb) nb.textContent = dorks.length;
}

async function deleteDorkFromModal() {
    if (!editingDorkId) return;
    if (!confirm('Delete this dork?')) return;
    dorks = dorks.filter(x => x.id !== editingDorkId);
    await saveDorks();
    closeDorkModal();
    renderDorks();
    const nb = document.getElementById('navDorkCount');
    if (nb) nb.textContent = dorks.length;
    showToast('Dork deleted', 'info');
}

function bindDorkEvents() {
    document.getElementById('addDorkBtn')?.addEventListener('click', () => openDorkModal(null));
    document.getElementById('closeDorkModal')?.addEventListener('click', closeDorkModal);
    document.getElementById('cancelDorkModal')?.addEventListener('click', closeDorkModal);
    document.getElementById('saveDorkBtn')?.addEventListener('click', saveDorkFromModal);
    document.getElementById('dorkDeleteBtn')?.addEventListener('click', deleteDorkFromModal);

    document.getElementById('dorkSearch')?.addEventListener('input', renderDorks);
    document.getElementById('dorkCategoryFilter')?.addEventListener('change', renderDorks);

    document.getElementById('dorkCategory')?.addEventListener('change', e => {
        const inp = document.getElementById('dorkCategoryNew');
        if (!inp) return;
        if (e.target.value === '__new__') {
            inp.style.display = '';
            inp.value = '';
            setTimeout(() => inp.focus(), 30);
        } else {
            inp.style.display = 'none';
        }
    });

    document.getElementById('dorkModal')?.addEventListener('click', e => {
        if (e.target.id === 'dorkModal') closeDorkModal();
    });

    document.getElementById('dorkGroups')?.addEventListener('click', e => {
        const editBtn = e.target.closest('[data-action="edit"]');
        if (editBtn) {
            e.stopPropagation();
            openDorkModal(editBtn.dataset.id);
            return;
        }
        const card = e.target.closest('[data-action="run"]');
        if (card) {
            const d = dorks.find(x => x.id === card.dataset.id);
            if (d) runDork(d.query);
        }
    });
}
