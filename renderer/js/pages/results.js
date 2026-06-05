'use strict';

/**
 * @file results.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — PAGE "RÉSULTATS"
 * ============================================================
 *
 * Affiche les compteurs Kelio importés (table `kelio_resultat_total`).
 * Permet de filtrer par salarié, type de compteur, période, et d'exporter.
 *
 * CETTE TABLE EST LA PLUS VOLUMINEUSE :
 * Elle peut contenir des centaines de milliers de lignes.
 * C'est pourquoi la pagination est indispensable (PAGE_SIZE = 100).
 *
 * LES FILTRES DISPONIBLES :
 *   - Salarié (nom, matricule, clé)
 *   - Type de compteur (clé exacte)
 *   - Account type (catégorie de compteur)
 *   - Période (date résultat min/max)
 *
 * APPELÉ PAR : app.js (navigate('results'))
 */

const ResultsPage = (() => {
  const PAGE_SIZE = 100; // 100 lignes par page (plus que les salariés car tableau plus large)
  let _pageCourante = 1;
  let _filtres = {};

  const ACCOUNT_TYPES = [
    'ACCOUNT','LATENESS_EARLY_DEPARTURE','BALANCE','ABSENCE',
    'ABSENCE_BALANCE','OVERTIME_HOUR','SPECIAL_HOUR','BONUS','ON_CALL_DUTY','JOB',
  ];

  /**
   * Génère et injecte le HTML de la page Résultats.
   * Définit des dates par défaut, branche les événements, charge les données.
   *
   * @param {HTMLElement} container
   */
  async function render(container) {
    const today    = '2024-12-31';
    const firstDay = '2024-01-01';

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Résultats</div>
          <div class="page-subtitle">Compteurs importés depuis Kelio</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm" id="btnResHelp" title="Comprendre les compteurs">❓ Aide</button>
          <button class="btn btn-ghost btn-sm" id="btnResExport">↓ Export CSV</button>
        </div>
      </div>

      <div class="card">
        <div class="filters-bar" style="flex-wrap:wrap;gap:12px;">
          <div class="form-group">
            <label class="form-label">Salarié</label>
            <input type="text" class="form-control" id="resEmployee"
              placeholder="Nom, matricule, clé…" style="max-width:200px;" />
          </div>
          <div class="form-group">
            <label class="form-label">Type compteur</label>
            <input type="text" class="form-control" id="resTypeKey"
              placeholder="ex: HEURE_SUPP" style="max-width:160px;" />
          </div>
          <div class="form-group">
            <label class="form-label">Account type</label>
            <select class="form-control" id="resAccountType" style="max-width:200px;">
              <option value="">Tous</option>
              ${ACCOUNT_TYPES.map(a => `<option value="${Utils.esc(a)}">${Utils.esc(a)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Date début</label>
            <input type="date" class="form-control" id="resDateFrom" value="${firstDay}"
              style="max-width:160px;" />
          </div>
          <div class="form-group">
            <label class="form-label">Date fin</label>
            <input type="date" class="form-control" id="resDateTo" value="${today}"
              style="max-width:160px;" />
          </div>
          <button class="btn btn-ghost btn-sm" id="btnResReset" style="margin-top:18px;">
            ↺ Réinitialiser
          </button>
        </div>

        <div id="resTableWrap"><div style="padding:24px;text-align:center;"><span class="spinner"></span></div></div>
        <div class="pagination" id="resPagination"></div>
      </div>
    `;

    _pageCourante = 1;
    _filtres = { date_from: firstDay, date_to: today }; // Filtres par défaut

    document.getElementById('btnResHelp').addEventListener('click', _showHelp);
    document.getElementById('btnResExport').addEventListener('click', _export);
    document.getElementById('btnResReset').addEventListener('click', _reset);
    document.getElementById('resEmployee').addEventListener('input', _onSearch);
    document.getElementById('resTypeKey').addEventListener('input', _onSearch);
    document.getElementById('resAccountType').addEventListener('change', _onSearch);
    document.getElementById('resDateFrom').addEventListener('change', _onSearch);
    document.getElementById('resDateTo').addEventListener('change', _onSearch);

    await _load();
  }

  // Minuterie debounce : 350ms d'attente pour les filtres texte
  let _timerFiltres = null;

  /**
   * Collecte tous les filtres du formulaire et relance _load().
   * Utilisée par tous les champs de filtre (texte et select).
   * Debounce de 350ms pour les champs texte.
   */
  function _onSearch() {
    clearTimeout(_timerFiltres);
    _timerFiltres = setTimeout(() => {
      _filtres = {
        employee:     document.getElementById('resEmployee').value.trim(),
        type_key:     document.getElementById('resTypeKey').value.trim(),
        account_type: document.getElementById('resAccountType').value,
        date_from:    document.getElementById('resDateFrom').value,
        date_to:      document.getElementById('resDateTo').value,
      };
      _pageCourante = 1;
      _load();
    }, 350);
  }

  /**
   * Réinitialise tous les filtres à leurs valeurs par défaut.
   */
  function _reset() {
    document.getElementById('resEmployee').value    = '';
    document.getElementById('resTypeKey').value     = '';
    document.getElementById('resAccountType').value = '';
    document.getElementById('resDateFrom').value    = '2024-01-01';
    document.getElementById('resDateTo').value      = '2024-12-31';
    _filtres = { date_from: '2024-01-01', date_to: '2024-12-31' };
    _pageCourante = 1;
    _load();
  }

  /**
   * Charge et affiche les résultats (compteurs) selon les filtres actifs.
   * Construit le tableau HTML avec toutes les colonnes de kelio_resultat_total.
   */
  async function _load() {
    const conteneur = document.getElementById('resTableWrap');
    conteneur.innerHTML = '<div style="padding:24px;text-align:center;"><span class="spinner"></span></div>';

    try {
      const lignes = await window.KelioAPI.resultsList({
        ..._filtres,
        limit:  PAGE_SIZE,
        offset: (_pageCourante - 1) * PAGE_SIZE,
      });

      if (!lignes || lignes.length === 0) {
        conteneur.innerHTML = Utils.emptyState('◆', 'Aucun résultat pour ces critères');
        document.getElementById('resPagination').innerHTML = '';
        return;
      }

      conteneur.innerHTML = `
        <div style="font-size:12px;color:var(--color-muted);margin-bottom:8px;">
          Page ${_pageCourante} — ${lignes.length} ligne(s) affichée(s)
        </div>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Date résultat</th>
                <th>Salarié</th><th>Matricule</th><th>Nom</th><th>Prénom</th>
                <th>Section</th>
                <th>typeKey</th><th>Abrév.</th><th>Libellé</th>
                <th>Valeur</th>
                <th>Importe le</th>
              </tr>
            </thead>
            <tbody>
              ${lignes.map(r => `
                <tr>
                  <td>${Utils.fmtDate(r.result_date)}</td>
                  <td class="td-mono">${Utils.fmt(r.employee_key)}</td>
                  <td>${Utils.fmt(r.employee_identification_number)}</td>
                  <td><strong>${Utils.fmt(r.employee_surname)}</strong></td>
                  <td>${Utils.fmt(r.employee_first_name)}</td>
                  <td class="td-muted">${Utils.fmt(r.section_description)}</td>
                  <td class="td-mono">${Utils.fmt(r.type_key)}</td>
                  <td>${Utils.fmt(r.type_abbreviation)}</td>
                  <td>${Utils.fmt(r.type_description)}</td>
                  <td style="text-align:right;font-family:'Consolas',monospace;">${Utils.fmtNum(r.value_canonical)}</td>
                  <td class="td-muted">${Utils.fmtDate(r.imported_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      const elementPagination = document.getElementById('resPagination');
      Utils.buildPagination(elementPagination, {
        page:       _pageCourante,
        totalPages: lignes.length === PAGE_SIZE ? _pageCourante + 1 : _pageCourante,
        onChange:   (nouvelleP) => { _pageCourante = nouvelleP; _load(); },
      });
    } catch (erreur) {
      conteneur.innerHTML = Utils.emptyState('✕', `Erreur: ${erreur.message}`);
    }
  }

  /**
   * Exporte les résultats (avec filtres actifs) en CSV.
   */
  async function _export() {
    try {
      const reponse = await window.KelioAPI.exportCsv({ type: 'results', filters: _filtres });
      if (reponse.ok)                     Toast.success('Export CSV enregistré.');
      else if (reponse.reason !== 'annulé') Toast.error(`Export échoué: ${reponse.reason}`);
    } catch (erreur) {
      Toast.error(`Erreur export: ${erreur.message}`);
    }
  }

  /**
   * Affiche une modal d'aide expliquant les compteurs Kelio
   */
  function _showHelp() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="max-width:600px;">
        <div class="modal-header">
          <h3>◆ Compteurs Kelio - Aide</h3>
          <button class="modal-close" id="modalClose">×</button>
        </div>
        <div class="modal-body">
          <p style="line-height:1.6;">
            Les <strong>compteurs Kelio</strong> sont des valeurs calculées par le système Kelio pour chaque salarié. Ce sont des totaux agrégés qui résument l'activité RH.
          </p>
          <p style="margin-top:16px;"><strong>📊 Types de compteurs disponibles :</strong></p>
          <ul style="margin:12px 0;padding-left:20px;line-height:1.8;">
            <li><strong>ACCOUNT</strong> : Heures travaillées théoriques et réelles</li>
            <li><strong>LATENESS_EARLY_DEPARTURE</strong> : Retards et départs anticipés</li>
            <li><strong>BALANCE / ABSENCE_BALANCE</strong> : Soldes de congés et absences</li>
            <li><strong>ABSENCE</strong> : Heures d'absence par type</li>
            <li><strong>OVERTIME_HOUR</strong> : Heures supplémentaires</li>
            <li><strong>SPECIAL_HOUR</strong> : Heures spéciales (nuit, dimanche...)</li>
            <li><strong>BONUS</strong> : Primes et indemnités</li>
            <li><strong>ON_CALL_DUTY</strong> : Astreintes</li>
            <li><strong>JOB</strong> : Activités et postes</li>
          </ul>
          <p style="margin-top:16px;"><strong>💡 Utilisation typique :</strong></p>
          <ul style="margin:12px 0;padding-left:20px;line-height:1.8;">
            <li>Vérifier les soldes de congés d'un salarié</li>
            <li>Calculer les heures supplémentaires cumulées</li>
            <li>Analyser les retards fréquents</li>
            <li>Extraire les primes pour la paie</li>
          </ul>
          <div style="margin-top:16px;padding:12px;background:var(--color-bg-subtle);border-radius:6px;font-size:13px;">
            <strong>🔍 Conseil :</strong> Utilisez les filtres pour restreindre à un salarié ou une période. Exportez en CSV pour analyser les données dans Excel.
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" id="modalOk">Compris</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('modalClose').addEventListener('click', () => modal.remove());
    document.getElementById('modalOk').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  }

  return { render, _onSearch, _reset, _export };
})();
