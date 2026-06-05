'use strict';

/**
 * @file extraction.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — PAGE "EXTRACTION"
 * ============================================================
 *
 * Cette page permet à l'utilisateur de configurer et lancer une extraction.
 * C'est l'interface principale de l'application.
 *
 * FLUX D'UNE EXTRACTION :
 *   1. L'utilisateur choisit un module (ex: 'clockings') et une période
 *   2. Il clique "Lancer l'extraction"
 *   3. _start() envoie les params à main.js via KelioAPI.extractionStart()
 *   4. main.js crée un ExtractionOrchestrator et appelle .run()
 *   5. L'orchestrateur envoie des événements de progression en retour
 *   6. onExtractionProgress() les reçoit et met à jour la barre + les logs
 *
 * ADAPTATION DU FORMULAIRE :
 * Le formulaire s'adapte dynamiquement selon le module sélectionné :
 *   - 'employees'  : affiche les filtres de population
 *   - 'totals'     : affiche la sélection des types de compteurs
 *   - Autres       : affiche les champs de dates
 *
 * APPELÉ PAR : app.js (navigate('extraction'))
 */

const ExtractionPage = (() => {
  const ACCOUNT_TYPES = [
    { key: 'ACCOUNT',                  label: 'Comptes (Account)' },
    { key: 'LATENESS_EARLY_DEPARTURE', label: 'Retards / départs anticipés' },
    { key: 'BALANCE',                  label: 'Soldes (Balance)' },
    { key: 'ABSENCE',                  label: 'Absences' },
    { key: 'ABSENCE_BALANCE',          label: 'Soldes absences' },
    { key: 'OVERTIME_HOUR',            label: 'Heures supp.' },
    { key: 'SPECIAL_HOUR',             label: 'Heures spéciales' },
    { key: 'BONUS',                    label: 'Primes (Bonus)' },
    { key: 'ON_CALL_DUTY',             label: 'Astreintes' },
    { key: 'JOB',                      label: 'Activités (Job)' },
  ];

  // Garde-fou : empêche de lancer deux extractions simultanément
  let _enCours = false;

  /**
   * Génère et injecte le HTML de la page dans le conteneur principal.
   * Configure tous les événements (changement de module, clic lancer...).
   * Appelée par App.navigate('extraction').
   *
   * @param {HTMLElement} container - Le div #mainContent de index.html
   */
  async function render(container) {
    const today = '2024-12-31';
    const firstDay = '2024-01-01';

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Extraction</div>
          <div class="page-subtitle">Lancer une extraction de données depuis l'API Kelio</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Module à extraire</div>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr));">
          <div class="form-group">
            <label class="form-label">Module</label>
            <select class="form-control" id="exModule">
              <option value="employees">Salariés (LightEmployeeService)</option>
              <option value="organization">Organigramme</option>
              <option value="clockings">Badgeages</option>
              <option value="absence-files">Fiches d'absence</option>
              <option value="absence-requests">Demandes d'absence</option>
              <option value="schedules">Horaires (DailyScheduleAssignment)</option>
              <option value="job-assignments">Affectations activité</option>
              <option value="job-assignments-forecast">Affectation fiches d'activité (Prévisionnel)</option>
              <option value="section-assignments">Services jour/jour (SectionAssignment)</option>
              <option value="section-assignments-forecast">Affectation service jour/jour (Prévisionnel)</option>
              <option value="totals">Résultats / Compteurs</option>
            </select>
          </div>
          <div class="form-group" id="modePeriodeGroup" style="display:none;">
            <label class="form-label">Mode période</label>
            <select class="form-control" id="exModePeriode">
              <option value="JOUR">Journalier (JOUR)</option>
              <option value="MOIS">Mensuel (MOIS)</option>
            </select>
          </div>
          <div class="form-group" id="dateFromGroup">
            <label class="form-label">Date début</label>
            <input type="date" class="form-control" id="exDateFrom" value="${firstDay}" />
          </div>
          <div class="form-group" id="dateToGroup">
            <label class="form-label">Date fin</label>
            <input type="date" class="form-control" id="exDateTo" value="${today}" />
          </div>
        </div>
        
        <div style="margin-top: 10px; margin-bottom: 20px;">
          <button class="btn btn-ghost btn-sm" id="btnPrevWeek">📅 Semaine précédente</button>
        </div>

        <!-- Filtres population (employees) -->
        <div id="employeeFilters" style="display:none;">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Filtre population (optionnel)</label>
              <input type="text" class="form-control" id="exPopFilter" placeholder="ex: département" />
            </div>
            <div class="form-group">
              <label class="form-label">Filtre groupe (optionnel)</label>
              <input type="text" class="form-control" id="exGroupFilter" placeholder="ex: service" />
            </div>
          </div>
        </div>

        <!-- Sélection account types (totals) -->
        <div id="accountTypesGroup" style="display:none;">
          <div class="form-label" style="margin-bottom:8px;">Types de compteurs à extraire</div>
          <div class="checkbox-group" id="accountTypeChecks">
            ${ACCOUNT_TYPES.map(at => `
              <label class="checkbox-item">
                <input type="checkbox" name="accountType" value="${Utils.esc(at.key)}" checked />
                ${Utils.esc(at.label)}
              </label>
            `).join('')}
          </div>
          <div style="margin-top:8px;display:flex;gap:8px;">
            <button class="btn btn-ghost btn-sm" id="btnCheckAll">Tout sélectionner</button>
            <button class="btn btn-ghost btn-sm" id="btnUncheckAll">Tout désélectionner</button>
          </div>
        </div>

        <div style="margin-top:20px;display:flex;gap:10px;align-items:center;">
          <button class="btn btn-primary" id="btnExtract">
            ⟳ Lancer l'extraction
          </button>
          <span class="form-hint" id="exHint"></span>
        </div>
      </div>

      <!-- Progress -->
      <div class="card" id="progressCard" style="display:none;">
        <div class="card-title">Progression</div>
        <div class="progress-wrap">
          <div class="progress-bar" id="progressBar" style="width:0%"></div>
        </div>
        <div style="font-size:12px;color:var(--color-muted);margin-top:6px;" id="progressMsg">Démarrage…</div>
        <div class="extraction-log" id="extractionLog"></div>
      </div>
    `;

    // Branchement des événements
    document.getElementById('exModule').addEventListener('change', _updateModuleUI);
    document.getElementById('btnExtract').addEventListener('click', _start);
    document.getElementById('btnCheckAll')?.addEventListener('click', () => _checkAll(true));
    document.getElementById('btnUncheckAll')?.addEventListener('click', () => _checkAll(false));
    document.getElementById('btnPrevWeek').addEventListener('click', _setPrevWeek);

    // Mise à jour initiale pour montrer/cacher les bons champs
    _updateModuleUI();
  }

  /**
   * Calcule et définit les dates de la semaine précédente (Lundi à Dimanche).
   */
  function _setPrevWeek() {
    const today = new Date();
    // Jour actuel (0=dimanche, 1=lundi, ...)
    const day = today.getDay();
    // Différence pour arriver au lundi de cette semaine
    const diffToMonday = day === 0 ? -6 : 1 - day;
    
    const mondayPrev = new Date(today);
    mondayPrev.setDate(today.getDate() + diffToMonday - 7);
    
    const sundayPrev = new Date(mondayPrev);
    sundayPrev.setDate(mondayPrev.getDate() + 6);
    
    document.getElementById('exDateFrom').value = mondayPrev.toISOString().split('T')[0];
    document.getElementById('exDateTo').value = sundayPrev.toISOString().split('T')[0];
    
    Toast.info('Dates définies sur la semaine précédente.');
  }

  /**
   * Adapte le formulaire selon le module sélectionné.
   * Certains champs sont montrés/cachés dynamiquement.
   * Appelée à chaque changement du select #exModule.
   */
  function _updateModuleUI() {
    const moduleChoisi = document.getElementById('exModule').value;
    const estTotal     = moduleChoisi === 'totals';
    const estEmployes  = moduleChoisi === 'employees';
    const necesiteDates = moduleChoisi !== 'employees' && moduleChoisi !== 'organization';

    // Mode période et types de compteurs : uniquement pour les totaux
    document.getElementById('modePeriodeGroup').style.display  = estTotal ? '' : 'none';
    document.getElementById('accountTypesGroup').style.display = estTotal ? '' : 'none';
    // Filtres population : uniquement pour les salariés
    document.getElementById('employeeFilters').style.display   = estEmployes ? '' : 'none';
    // Dates : pour tout sauf salariés et organigramme (pas de période)
    document.getElementById('dateFromGroup').style.display     = necesiteDates ? '' : 'none';
    document.getElementById('dateToGroup').style.display       = necesiteDates ? '' : 'none';
  }

  /**
   * Coche ou décoche tous les types de compteurs.
   * Appelé par les boutons "Tout sélectionner" / "Tout désélectionner".
   *
   * @param {boolean} coche - true = tout cocher, false = tout décocher
   */
  function _checkAll(coche) {
    document.querySelectorAll('input[name="accountType"]').forEach(cb => {
      cb.checked = coche;
    });
  }

  /**
   * Lance l'extraction après validation du formulaire.
   * Envoie les paramètres à main.js et gère la progression en temps réel.
   *
   * FLUX D'EXÉCUTION :
   *   1. Valide les champs requis
   *   2. Construit l'objet `params` avec tous les critères
   *   3. Branche l'écouteur de progression (onExtractionProgress)
   *   4. Appelle KelioAPI.extractionStart(params) et attend le résultat
   *   5. Affiche un toast succès/échec
   */
  async function _start() {
    if (_enCours) return; // Pas deux extractions simultanées

    const moduleChoisi = document.getElementById('exModule').value;
    const dateDebut    = document.getElementById('exDateFrom')?.value;
    const dateFin      = document.getElementById('exDateTo')?.value;

    // Validation des dates pour les modules qui en ont besoin
    const modulesAvecDates = [
      'clockings','absence-files','absence-requests','schedules',
      'job-assignments','job-assignments-forecast',
      'section-assignments','section-assignments-forecast',
      'totals'
    ];
    if (modulesAvecDates.includes(moduleChoisi)) {
      if (!dateDebut || !dateFin) { Toast.error('Veuillez saisir les dates début et fin.'); return; }
      if (dateFin < dateDebut)    { Toast.error('La date fin doit être >= date début.'); return; }
    }

    // Construction de l'objet paramètres envoyé à l'orchestrateur
    const params = { module: moduleChoisi };
    if (dateDebut) params.dateFrom = dateDebut;
    if (dateFin)   params.dateTo   = dateFin;

    if (moduleChoisi === 'totals') {
      params.modePeriode  = document.getElementById('exModePeriode').value;
      params.accountTypes = [...document.querySelectorAll('input[name="accountType"]:checked')]
        .map(cb => cb.value);
      if (params.accountTypes.length === 0) {
        Toast.error('Sélectionnez au moins un type de compteur.');
        return;
      }
    }
    if (moduleChoisi === 'employees') {
      params.populationFilter = document.getElementById('exPopFilter').value;
      params.groupFilter      = document.getElementById('exGroupFilter').value;
    }

    // Désactivation du bouton + affichage de la progression
    _enCours = true;
    const btnLancer = document.getElementById('btnExtract');
    btnLancer.disabled = true;
    btnLancer.innerHTML = '<span class="spinner"></span> En cours…';

    document.getElementById('progressCard').style.display = '';
    _setProgress(0, 'Initialisation…');
    document.getElementById('extractionLog').innerHTML = '';

    // Branche l'écouteur de progression (re-branche pour éviter les doublons)
    window.KelioAPI.offExtractionProgress();
    window.KelioAPI.onExtractionProgress((donnees) => {
      _setProgress(donnees.percent ?? 0, donnees.message ?? '');
      _appendLog(donnees);
    });

    try {
      // Appel IPC : bloque jusqu'à la fin de l'extraction
      const resultat = await window.KelioAPI.extractionStart(params);
      _setProgress(100, resultat.success ? 'Terminé !' : `Erreur: ${resultat.error}`);
      if (resultat.success) {
        Toast.success(`Extraction terminée — ${resultat.ok} OK / ${resultat.errors} erreur(s)`);
      } else {
        Toast.error(`Extraction échouée: ${resultat.error}`);
      }
    } catch (erreur) {
      Toast.error(`Erreur inattendue: ${erreur.message}`);
    } finally {
      // Réactivation du bouton dans tous les cas (succès ou échec)
      _enCours = false;
      btnLancer.disabled = false;
      btnLancer.innerHTML = '↳ Lancer l\'extraction';
      window.KelioAPI.offExtractionProgress();
    }
  }

  /**
   * Met à jour la barre de progression et le message affiché.
   *
   * @param {number} pct - Pourcentage (0 à 100)
   * @param {string} msg - Message à afficher sous la barre
   */
  function _setProgress(pct, msg) {
    const barreProgression = document.getElementById('progressBar');
    const elementMessage   = document.getElementById('progressMsg');
    if (barreProgression) barreProgression.style.width = `${pct}%`;
    if (elementMessage)   elementMessage.textContent   = msg;
  }

  /**
   * Ajoute une ligne dans le journal d'extraction (log).
   * Fait défiler automatiquement vers le bas (scroll to bottom).
   *
   * @param {Object} evenement
   * @param {string} evenement.type    - 'start' | 'step' | 'done' | 'error'
   * @param {string} evenement.message - Texte de la ligne
   * @param {string} evenement.ts      - Horodatage ISO
   */
  function _appendLog({ type, message, ts }) {
    const journal = document.getElementById('extractionLog');
    if (!journal) return;
    // Classe CSS selon le type d'événement
    const classeLigne = type === 'error' ? 'log-line-error'
                      : type === 'done'  ? 'log-line-ok'
                      : 'log-line-info';
    const heure = ts ? new Date(ts).toLocaleTimeString('fr-FR') : '';
    journal.innerHTML += `<div class="${classeLigne}">[${heure}] ${Utils.esc(message)}</div>`;
    journal.scrollTop = journal.scrollHeight; // Auto-scroll vers le bas
  }

  return { render, _start, _checkAll, _updateModuleUI };
})();
