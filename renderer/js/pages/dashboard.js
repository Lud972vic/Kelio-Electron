'use strict';

const DashboardPage = (() => {
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Tableau de bord</div>
          <div class="page-subtitle">Vue d'ensemble de l'application</div>
        </div>
      </div>

      <div class="stats-grid" id="statsGrid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));">
        ${_statCard('statEmployees',       '👤 Salariés')}
        ${_statCard('statClockings',       '⏱ Badgeages')}
        ${_statCard('statAbsenceFiles',    '📋 Fiches abs.')}
        ${_statCard('statAbsenceRequests', '📝 Dem. abs.')}
        ${_statCard('statSchedules',       '📅 Horaires')}
        ${_statCard('statJobAssign',       '🏷 Activités')}
        ${_statCard('statSectionAssign',   '📌 Services j/j')}
        ${_statCard('statOrga',            '🏢 Organi.')}
        ${_statCard('statTotals',          '📊 Compteurs')}
        ${_statCard('statRuns',            '🔄 Extractions')}
      </div>

      <div class="card" id="dbInfoCard">
        <div class="card-title">💾 Base de données SQLite</div>
        <div id="dbInfoContent"><span class="spinner"></span></div>
      </div>

      <div class="card">
        <div class="card-title">Dernières extractions</div>
        <div id="recentRuns"><div class="empty-state"><div class="empty-icon">◷</div><p>Chargement…</p></div></div>
      </div>
    `;

    container.addEventListener('click', (e) => {
      const card = e.target.closest('[data-nav-page]');
      if (card) App.navigate(card.dataset.navPage);
    });
    container.addEventListener('mouseover', (e) => {
      const card = e.target.closest('[data-nav-page]');
      if (card) card.style.borderColor = 'var(--color-accent)';
    });
    container.addEventListener('mouseout', (e) => {
      const card = e.target.closest('[data-nav-page]');
      if (card) card.style.borderColor = '';
    });

    loadStats();
    loadDbInfo();
    loadRecentRuns();
  }

  function _statCard(id, label) {
    return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value" id="${id}"><span class="spinner"></span></div></div>`;
  }

  function workflowCard(num, title, sub, page) {
    return `
      <div class="stat-card" style="cursor:pointer;transition:border-color 0.18s;" data-nav-page="${page}">
        <div class="stat-label">Étape ${num}</div>
        <div style="font-size:15px;font-weight:700;color:var(--color-text);margin:4px 0;">${Utils.esc(title)}</div>
        <div style="font-size:12px;color:var(--color-muted);">${Utils.esc(sub)}</div>
      </div>
    `;
  }

  async function loadStats() {
    const ids = ['statEmployees','statClockings','statAbsenceFiles','statAbsenceRequests',
                 'statSchedules','statJobAssign','statSectionAssign','statOrga','statTotals','statRuns'];
    try {
      const s = await window.KelioAPI.resultsStats();
      const fmt = n => Number(n ?? 0).toLocaleString('fr-FR');
      document.getElementById('statEmployees').textContent       = fmt(s.employees);
      document.getElementById('statClockings').textContent       = fmt(s.clockings);
      document.getElementById('statAbsenceFiles').textContent    = fmt(s.absenceFiles);
      document.getElementById('statAbsenceRequests').textContent = fmt(s.absenceRequests);
      document.getElementById('statSchedules').textContent       = fmt(s.schedules);
      document.getElementById('statJobAssign').textContent       = fmt(s.jobAssignments);
      document.getElementById('statSectionAssign').textContent   = fmt(s.sectionAssignments);
      document.getElementById('statOrga').textContent            = fmt(s.organization);
      document.getElementById('statTotals').textContent          = fmt(s.totals);
      document.getElementById('statRuns').textContent            = fmt(s.runs);
    } catch (e) {
      ids.forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '—'; });
    }
  }

  async function loadDbInfo() {
    const el = document.getElementById('dbInfoContent');
    try {
      const { sizeBytes, sqliteMaxBytes, freeBytes, totalBytes, path: dbPath } = await window.KelioAPI.dbInfo();

      const fmtSize = (b) => {
        if (b == null) return '—';
        if (b >= 1024**4) return (b / 1024**4).toFixed(2) + ' To';
        if (b >= 1024**3) return (b / 1024**3).toFixed(1) + ' Go';
        if (b >= 1024**2) return (b / 1024**2).toFixed(1) + ' Mo';
        return (b / 1024).toFixed(0) + ' Ko';
      };

      const limitSys   = totalBytes ?? null;
      const limitLabel = limitSys != null ? fmtSize(Math.min(limitSys, sqliteMaxBytes)) : fmtSize(sqliteMaxBytes);
      const pctDisk    = totalBytes != null ? Math.min(100, (sizeBytes / totalBytes) * 100) : 0;
      const pctFree    = totalBytes != null ? Math.min(100, (freeBytes  / totalBytes) * 100) : 0;
      const colorDisk  = pctDisk > 80 ? 'var(--color-danger)' : pctDisk > 50 ? '#f59e0b' : 'var(--color-success)';
      const colorFree  = pctFree < 10 ? 'var(--color-danger)' : pctFree < 25 ? '#f59e0b' : 'var(--color-success)';

      el.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;gap:32px;flex-wrap:wrap;font-size:13px;">
            <span>Taille DB : <strong>${fmtSize(sizeBytes)}</strong></span>
            <span>Disque libre : <strong style="color:${colorFree}">${fmtSize(freeBytes)}</strong></span>
            <span>Volume total : <strong>${fmtSize(totalBytes)}</strong></span>
            <span>Limite haute effective : <strong>${limitLabel}</strong>
              <span style="font-size:11px;color:var(--color-muted)"> (min volume FS, limite SQLite 17,5 To)</span>
            </span>
          </div>
          ${totalBytes != null ? `
          <div>
            <div style="font-size:11px;color:var(--color-muted);margin-bottom:4px;">Utilisation DB / volume total du disque</div>
            <div style="background:var(--color-border,#2a2a2a);border-radius:6px;height:10px;overflow:hidden;position:relative;">
              <div style="height:100%;width:${(100 - pctFree).toFixed(3)}%;background:#444;border-radius:6px;"></div>
              <div style="height:100%;width:${pctDisk.toFixed(3)}%;background:${colorDisk};border-radius:6px;position:absolute;top:0;left:0;transition:width 0.4s;"></div>
            </div>
            <div style="font-size:11px;color:var(--color-muted);margin-top:3px;">
              DB : ${pctDisk.toFixed(4)}% du volume — Libre : ${pctFree.toFixed(1)}%
            </div>
          </div>` : ''}
          <div style="font-size:11px;color:var(--color-muted);word-break:break-all;">${dbPath}</div>
        </div>
      `;
    } catch (e) {
      el.innerHTML = '<span style="color:var(--color-muted)">Impossible de lire les infos DB</span>';
    }
  }

  async function loadRecentRuns() {
    try {
      const runs = await window.KelioAPI.historyList({ limit: 5 });
      const el = document.getElementById('recentRuns');
      if (!runs || runs.length === 0) {
        el.innerHTML = Utils.emptyState('◷', 'Aucune extraction effectuée');
        return;
      }
      el.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Module</th><th>Période</th>
                <th>Du</th><th>Au</th><th>Statut</th>
                <th>Requêtes</th><th>Créé le</th>
              </tr>
            </thead>
            <tbody>
              ${runs.map(r => `
                <tr>
                  <td class="td-mono">${Utils.fmt(r.id)}</td>
                  <td>${Utils.fmt(r.module_code)}</td>
                  <td>${Utils.fmt(r.mode_periode)}</td>
                  <td>${Utils.fmtDate(r.date_from)}</td>
                  <td>${Utils.fmtDate(r.date_to)}</td>
                  <td>${Utils.statusBadge(r.status)}</td>
                  <td>${Utils.fmt(r.total_requests)}</td>
                  <td class="td-muted">${Utils.fmtDate(r.created_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      document.getElementById('recentRuns').innerHTML = Utils.emptyState('✕', 'Erreur de chargement');
    }
  }

  return { render };
})();
