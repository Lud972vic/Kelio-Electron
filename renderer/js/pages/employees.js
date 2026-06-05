'use strict';

/**
 * @file employees.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — PAGE "SALARIÉS"
 * ============================================================
 *
 * Affiche la liste paginée des salariés importés dans la base SQLite.
 * Permet de rechercher, filtrer (actifs/archivés), paginer et exporter.
 *
 * PAGINATION :
 * On n'affiche que PAGE_SIZE (50) salariés à la fois.
 * Utils.buildPagination() gère le rendu des boutons.
 * L'offset envoyé au backend est calculé : (page - 1) * PAGE_SIZE.
 *
 * RECHERCHE AVEC DÉLAI (DEBOUNCE) :
 * La recherche ne se déclenche pas à chaque frappe (trop d'appels DB).
 * On attend 300ms sans frappe avant de lancer _load(). C'est le pattern debounce.
 *
 * APPELÉ PAR : app.js (navigate('employees'))
 */

const EmployeesPage = (() => {
  const PAGE_SIZE = 50;    // Nombre de salariés par page
  let _pageCourante = 1;  // Page active (commence à 1)
  let _filtres = {};       // Filtres actuellement actifs

  /**
   * Génère et injecte le HTML de la page.
   * Réinitialise les filtres et la pagination, puis charge les données.
   *
   * @param {HTMLElement} container
   */
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Salariés</div>
          <div class="page-subtitle">Liste des salariés importés depuis Kelio</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm" id="btnEmpExport">↓ Export CSV</button>
        </div>
      </div>

      <div class="card">
        <div class="filters-bar">
          <div class="form-group">
            <label class="form-label">Recherche</label>
            <input type="text" class="form-control" id="empSearch"
              placeholder="Nom, prénom, matricule, clé…" style="max-width:260px;" />
          </div>
          <div class="form-group">
            <label class="form-label">Archivés</label>
            <select class="form-control" id="empArchived" style="max-width:150px;">
              <option value="">Tous</option>
              <option value="0">Actifs seulement</option>
              <option value="1">Archivés seulement</option>
            </select>
          </div>
          <button class="btn btn-ghost btn-sm" id="btnEmpReset" style="margin-top:18px;">
            ↺ Réinitialiser
          </button>
        </div>

        <div id="empTableWrap"><div class="empty-state"><div class="empty-icon">◉</div><p>Chargement…</p></div></div>
        <div class="pagination" id="empPagination"></div>
      </div>
    `;

    _pageCourante = 1;
    _filtres = {};

    document.getElementById('btnEmpExport').addEventListener('click', _export);
    document.getElementById('btnEmpReset').addEventListener('click', _reset);
    document.getElementById('empSearch').addEventListener('input', (e) => _onSearch(e.target.value));
    document.getElementById('empArchived').addEventListener('change', _onFilter);

    await _load();
  }

  // Minuterie pour le debounce de la recherche
  let _timerRecherche = null;

  /**
   * Déclenche une recherche après 300ms sans frappe (debounce).
   * Évite de faire un appel DB à chaque touche pressée.
   *
   * @param {string} valeur - Texte saisi dans le champ recherche
   */
  function _onSearch(valeur) {
    clearTimeout(_timerRecherche);
    _timerRecherche = setTimeout(() => {
      _filtres.q = valeur.trim();
      _pageCourante = 1; // Revenir à la première page après une recherche
      _load();
    }, 300);
  }

  /**
   * Applique le filtre actif/archivé et recharge la liste.
   * La valeur du select peut être '' (tous), '0' (actifs), '1' (archivés).
   */
  function _onFilter() {
    const valeurSelect = document.getElementById('empArchived').value;
    if (valeurSelect === '') {
      delete _filtres.archived; // Pas de filtre = afficher tous
    } else {
      _filtres.archived = valeurSelect === '1'; // true = archivés
    }
    _pageCourante = 1;
    _load();
  }

  /**
   * Réinitialise tous les filtres et affiche la liste complète.
   */
  function _reset() {
    document.getElementById('empSearch').value   = '';
    document.getElementById('empArchived').value = '';
    _filtres = {};
    _pageCourante = 1;
    _load();
  }

  /**
   * Charge et affiche la liste des salariés.
   * Appelée à l'initialisation et après chaque changement de filtre ou de page.
   */
  async function _load() {
    const conteneur = document.getElementById('empTableWrap');
    conteneur.innerHTML = '<div style="padding:24px;text-align:center;"><span class="spinner"></span></div>';

    try {
      // Appel IPC : récupère la page courante des salariés
      const lignes = await window.KelioAPI.employeesList({
        ..._filtres,
        limit:  PAGE_SIZE,
        offset: (_pageCourante - 1) * PAGE_SIZE, // Ex: page 3 → offset 100
      });

      if (!lignes || lignes.length === 0) {
        conteneur.innerHTML = Utils.emptyState('◉', 'Aucun salarié trouvé');
        document.getElementById('empPagination').innerHTML = '';
        return;
      }

      conteneur.innerHTML = `
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Clé</th><th>Matricule</th><th>Badge</th>
                <th>Nom</th><th>Prénom</th><th>Email</th>
                <th>Section</th><th>Début</th><th>Fin</th><th>Statut</th>
              </tr>
            </thead>
            <tbody>
              ${lignes.map(r => `
                <tr>
                  <td class="td-mono">${Utils.fmt(r.employee_key)}</td>
                  <td>${Utils.fmt(r.identification_number)}</td>
                  <td class="td-mono">${Utils.fmt(r.badge_code)}</td>
                  <td><strong>${Utils.fmt(r.surname)}</strong></td>
                  <td>${Utils.fmt(r.first_name)}</td>
                  <td class="td-muted">${Utils.fmt(r.email)}</td>
                  <td>${Utils.fmt(r.section_description)}</td>
                  <td class="td-muted">${Utils.fmtDate(r.start_date)}</td>
                  <td class="td-muted">${Utils.fmtDate(r.end_date)}</td>
                  <td>${Utils.archivedBadge(r.archived_employee)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;

      // Pagination : si on a exactement PAGE_SIZE lignes, il y a probablement une page suivante
      const elementPagination = document.getElementById('empPagination');
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
   * Exporte les salariés (avec les filtres actifs) en CSV.
   * Ouvre la boîte de dialogue de sauvegarde de fichier native (via main.js).
   */
  async function _export() {
    try {
      const reponse = await window.KelioAPI.exportCsv({ type: 'employees', filters: _filtres });
      if (reponse.ok)                     Toast.success('Export CSV enregistré.');
      else if (reponse.reason !== 'annulé') Toast.error(`Export échoué: ${reponse.reason}`);
    } catch (erreur) {
      Toast.error(`Erreur export: ${erreur.message}`);
    }
  }

  return { render, _onSearch, _onFilter, _reset, _export };
})();
