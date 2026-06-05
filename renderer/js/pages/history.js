'use strict';

/**
 * @file history.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — PAGE "HISTORIQUE"
 * ============================================================
 *
 * Affiche la liste de tous les runs d'extraction effectués.
 * Permet de filtrer par module, statut, et de voir le détail d'un run
 * avec ses logs SOAP individuels.
 *
 * STRUCTURE :
 *   - Tableau des runs avec filtres (module, statut)
 *   - Card de détail (affichée sous le tableau au clic "Détail")
 *   - Bouton Export CSV
 *
 * APPELÉ PAR : app.js (navigate('history'))
 */

const HistoryPage = (() => {
  let _filtres = {}; // Filtres actifs (module_code, status)

  /**
   * Génère et injecte le HTML de la page.
   * Branche les événements et charge la liste initiale.
   *
   * @param {HTMLElement} container
   */
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Historique</div>
          <div class="page-subtitle">Journal de toutes les extractions effectuées</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="btnHistExport">↓ Export CSV</button>
      </div>

      <div class="card">
        <div class="filters-bar">
          <div class="form-group">
            <label class="form-label">Module</label>
            <select class="form-control" id="histModule" style="max-width:220px;">
              <option value="">Tous les modules</option>
              <option value="employees">Salariés</option>
              <option value="organization">Organigramme</option>
              <option value="clockings">Badgeages</option>
              <option value="absence-files">Fiches absence</option>
              <option value="absence-requests">Demandes absence</option>
              <option value="schedules">Horaires</option>
              <option value="job-assignments">Affectations activité</option>
              <option value="section-assignments">Services jour/jour</option>
              <option value="totals">Résultats / Compteurs</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Statut</label>
            <select class="form-control" id="histStatus" style="max-width:200px;">
              <option value="">Tous</option>
              <option value="TERMINE">Terminé</option>
              <option value="TERMINE_ERREURS">Terminé (erreurs)</option>
              <option value="EN_COURS">En cours</option>
              <option value="ERREUR">Erreur</option>
            </select>
          </div>
          <button class="btn btn-ghost btn-sm" id="btnHistReset" style="margin-top:18px;">
            ↺ Réinitialiser
          </button>
        </div>

        <div id="histTableWrap"><div style="padding:24px;text-align:center;"><span class="spinner"></span></div></div>
      </div>

      <!-- Détail run -->
      <div class="card" id="histDetailCard" style="display:none;">
        <div class="section-header">
          <div class="card-title" id="histDetailTitle">Détail du run</div>
          <button class="btn btn-ghost btn-sm" id="btnHistDetailClose">✕ Fermer</button>
        </div>
        <div id="histDetailContent"></div>
      </div>
    `;

    _filtres = {};

    document.getElementById('btnHistExport').addEventListener('click', _export);
    document.getElementById('btnHistReset').addEventListener('click', _reset);
    document.getElementById('histModule').addEventListener('change', _onFilter);
    document.getElementById('histStatus').addEventListener('change', _onFilter);
    document.getElementById('btnHistDetailClose')?.addEventListener('click', () => {
      document.getElementById('histDetailCard').style.display = 'none'; // Cache le panneau détail
    });

    await _load();
  }

  /**
   * Met à jour les filtres et recharge la liste.
   * Appelée à chaque changement de select (module ou statut).
   */
  function _onFilter() {
    _filtres = {
      module_code: document.getElementById('histModule').value || undefined,
      status:      document.getElementById('histStatus').value || undefined,
    };
    _load();
  }

  /**
   * Réinitialise les filtres et réaffiche tous les runs.
   */
  function _reset() {
    document.getElementById('histModule').value = '';
    document.getElementById('histStatus').value = '';
    _filtres = {};
    _load();
  }

  /**
   * Charge et affiche la liste des runs depuis la base SQLite.
   * Appelée à l'initialisation et après chaque changement de filtre.
   */
  async function _load() {
    const conteneur = document.getElementById('histTableWrap');
    conteneur.innerHTML = '<div style="padding:24px;text-align:center;"><span class="spinner"></span></div>';

    try {
      const runs = await window.KelioAPI.historyList({ ..._filtres, limit: 100 });

      if (!runs || runs.length === 0) {
        conteneur.innerHTML = Utils.emptyState('◗', 'Aucune extraction enregistrée');
        return;
      }

      conteneur.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Module</th><th>Mode</th>
                <th>Du</th><th>Au</th><th>Statut</th>
                <th>Total</th><th>OK</th><th>Erreurs</th>
                <th>Démarré</th><th>Terminé</th><th>Actions</th>
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
                  <td style="color:var(--color-success);">${Utils.fmt(r.ok_requests)}</td>
                  <td style="color:${r.error_requests > 0 ? 'var(--color-danger)' : 'inherit'};">${Utils.fmt(r.error_requests)}</td>
                  <td class="td-muted">${Utils.fmtDate(r.started_at)}</td>
                  <td class="td-muted">${Utils.fmtDate(r.ended_at)}</td>
                  <td>
                    <button class="btn btn-ghost btn-sm" data-run-id="${r.id}">
                      Détail
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      // Délégation d'événement : un seul listener pour tous les boutons "Détail"
      conteneur.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-run-id]');
        if (btn) _showDetail(parseInt(btn.dataset.runId, 10));
      });
    } catch (erreur) {
      conteneur.innerHTML = Utils.emptyState('✕', `Erreur: ${erreur.message}`);
    }
  }

  /**
   * Affiche le panneau de détail d'un run : métadonnées + logs SOAP.
   * Fait défiler jusqu'au panneau pour qu'il soit visible.
   *
   * @param {number} runId - ID du run à afficher
   */
  async function _showDetail(runId) {
    const cardDetail  = document.getElementById('histDetailCard');
    const titreDetail = document.getElementById('histDetailTitle');
    const contenu     = document.getElementById('histDetailContent');

    cardDetail.style.display = ''; // Rend visible la card
    titreDetail.textContent  = `Détail du run #${runId}`;
    contenu.innerHTML        = '<div style="text-align:center;padding:16px;"><span class="spinner"></span></div>';
    cardDetail.scrollIntoView({ behavior: 'smooth', block: 'start' }); // Scroll vers le bas

    try {
      const donnees = await window.KelioAPI.historyDetail(runId);
      if (!donnees) { contenu.innerHTML = Utils.emptyState('✕', 'Run introuvable'); return; }

      const { run, logs } = donnees;
      contenu.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px;">
          <div class="stat-card"><div class="stat-label">Module</div><div style="font-size:16px;font-weight:700;">${Utils.fmt(run.module_code)}</div></div>
          <div class="stat-card"><div class="stat-label">Statut</div>${Utils.statusBadge(run.status)}</div>
          <div class="stat-card"><div class="stat-label">Requêtes OK</div><div style="font-size:16px;font-weight:700;color:var(--color-success);">${run.ok_requests}</div></div>
          <div class="stat-card"><div class="stat-label">Erreurs</div><div style="font-size:16px;font-weight:700;color:var(--color-danger);">${run.error_requests}</div></div>
        </div>
        ${logs && logs.length > 0 ? `
          <div class="card-title" style="margin-bottom:8px;">Logs SOAP (${logs.length})</div>
          <div class="extraction-log" style="max-height:300px;">
            ${logs.map(l => `
              <div class="${l.is_success ? 'log-line-ok' : 'log-line-error'}">
                [${Utils.esc(String(l.created_at ?? '').slice(0,19))}]
                ${Utils.esc(l.service_name ?? '')} / ${Utils.esc(l.method_name ?? '')}
                ${l.employee_key ? '→ ' + Utils.esc(l.employee_key) : ''}
                ${l.duration_ms ? '(' + l.duration_ms + 'ms)' : ''}
                ${l.error_message ? ' — ' + Utils.esc(String(l.error_message).slice(0,120)) : ''}
              </div>
            `).join('')}
          </div>
        ` : '<div class="td-muted">Aucun log SOAP enregistré.</div>'}
      `;
    } catch (erreur) {
      contenu.innerHTML = Utils.emptyState('✕', `Erreur: ${erreur.message}`);
    }
  }

  /**
   * Exporte l'historique (avec les filtres actifs) en CSV.
   */
  async function _export() {
    try {
      const reponse = await window.KelioAPI.exportCsv({ type: 'history', filters: _filtres });
      if (reponse.ok)                     Toast.success('Export CSV enregistré.');
      else if (reponse.reason !== 'annulé') Toast.error(`Export échoué: ${reponse.reason}`);
    } catch (erreur) {
      Toast.error(`Erreur export: ${erreur.message}`);
    }
  }

  return { render, _onFilter, _reset, _showDetail, _export };
})();
