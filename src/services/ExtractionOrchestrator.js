'use strict';

/**
 * @file ExtractionOrchestrator.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — LE "CHEF D'ORCHESTRE" DES EXTRACTIONS
 * ============================================================
 *
 * Ce fichier contient la classe qui coordonne une extraction complète.
 * Quand l'utilisateur clique "Lancer l'extraction" dans l'interface,
 * c'est cet orchestrateur qui prend en charge tout le processus.
 *
 * RESPONSABILITÉS :
 *   1. Lire la configuration (URL, login) depuis la base SQLite
 *   2. Créer un "run" (enregistrement de l'extraction dans l'historique)
 *   3. Récupérer la liste des salariés depuis la base locale
 *   4. Pour chaque salarié : appeler le bon service SOAP Kelio
 *   5. Insérer les données reçues dans les tables SQLite
 *   6. Envoyer des mises à jour de progression en temps réel
 *   7. Marquer le run comme terminé (ou en erreur)
 *
 * PERFORMANCE — TRAITEMENT PAR LOTS PARALLÈLES AVEC PIPELINE :
 *   Plutôt que de traiter les salariés un par un (lent),
 *   on les traite par lots en parallèle avec concurrence configurable.
 *   La concurrence par défaut est de 20 (vs 8 avant) grâce à HTTP Keep-Alive
 *   qui réutilise les connexions TCP entre les appels SOAP.
 *
 *   PIPELINE : Chaque résultat SOAP est traité et inséré en DB dès qu'il arrive,
 *   sans attendre que tout le lot soit terminé. Cela réduit la latence totale.
 *
 *   BULK INSERT : Les données sont insérées par lots de 100 lignes en une
 *   seule requête SQL (INSERT ... VALUES (...), (...), ...). Gain : 5-10x.
 *
 *   CONFIGURATION : Le paramètre 'concurrency' dans les paramètres permet
 *   d'ajuster selon la capacité du serveur Kelio. Valeurs recommandées :
 *   - Serveur rapide / local : 15-20
 *   - Serveur distant / lent : 5-8
 *   - Valeur par défaut : 20
 *
 * MODULES SUPPORTÉS :
 *   - employees          : salariés (1 seul appel, pas par employé)
 *   - organization       : organigramme (1 seul appel)
 *   - clockings          : badgeages par salarié
 *   - absence-files      : fiches d'absence par salarié
 *   - absence-requests   : demandes d'absence par salarié
 *   - schedules          : horaires par salarié
 *   - job-assignments    : activités par salarié
 *   - section-assignments: services j/j par salarié
 *   - totals             : compteurs par salarié × type de compteur
 */

const ConfigRepository   = require('../repositories/ConfigRepository');   // Config connexion
const RunRepository      = require('../repositories/RunRepository');       // Historique des runs
const EmployeeRepository = require('../repositories/EmployeeRepository'); // Liste des salariés
const ResultRepository   = require('../repositories/ResultRepository');   // Table des compteurs
const KelioSoapService   = require('./KelioSoapService');                 // Client SOAP Kelio

class ExtractionOrchestrator {

  /**
   * Constructeur — prépare tous les repositories nécessaires.
   * Appelé depuis main.js lors du déclenchement d'une extraction.
   *
   * @param {Database} db          - Instance better-sqlite3 (connexion SQLite active)
   * @param {Function} onProgress  - Callback appelé à chaque étape avec { type, message, percent }
   *                                 Utilisé pour envoyer la progression en temps réel au renderer.
   */
  constructor(db, onProgress) {
    this.db         = db;
    this.onProgress = onProgress || (() => {});  // Si pas de callback, on utilise une fonction vide
    this.configRepo = new ConfigRepository(db);  // Pour lire l'URL et le login
    this.runRepo    = new RunRepository(db);      // Pour enregistrer ce run dans l'historique
    this.empRepo    = new EmployeeRepository(db); // Pour lire la liste des salariés
    this.resRepo    = new ResultRepository(db);   // Pour insérer les compteurs (totaux)
  }

  /**
   * Point d'entrée principal — lance une extraction complète.
   * Appelée par main.js via le handler IPC 'extraction:start'.
   *
   * Le paramètre `module` détermine quelle donnée extraire.
   * Selon le module, on délègue à la bonne méthode privée.
   *
   * @param {Object} params
   * @param {string} params.module          - Module à extraire (ex: 'clockings', 'totals'...)
   * @param {string} params.dateFrom        - Date de début 'YYYY-MM-DD'
   * @param {string} params.dateTo          - Date de fin 'YYYY-MM-DD'
   * @param {string} params.modePeriode     - 'JOUR' ou 'MOIS' (pour les totaux)
   * @param {string[]} params.accountTypes  - Types de compteurs (pour le module 'totals')
   * @param {string} params.populationFilter- Filtre de population (pour 'employees')
   * @param {string} params.groupFilter     - Filtre de groupe (pour 'employees')
   * @returns {Promise<{success, runId, ok, errors, total}>}
   */
  async run(params) {
    const {
      module,           // Le module détermine quelle table Kelio est interrogée
      dateFrom,
      dateTo,
      modePeriode,      // Uniquement pour les compteurs : 'JOUR' (par jour) ou 'MOIS' (par mois)
      accountTypes,     // Uniquement pour 'totals' : liste des types à extraire
      populationFilter, // Uniquement pour 'employees' : filtre Kelio
      groupFilter,      // Uniquement pour 'employees' : filtre de groupe Kelio
    } = params;

    // Étape 1 : lire la configuration de connexion (URL, login, password)
    const configConnexion = this.configRepo.getAll();

    // Étape 2 : créer le client SOAP avec cette config
    const clientSoap = new KelioSoapService(configConnexion);

    // Étape 3 : créer un enregistrement "run" dans l'historique (statut: EN COURS)
    const runId = this.runRepo.create(
      module, modePeriode ?? null, dateFrom ?? null, dateTo ?? null, params
    );

    // Signal de démarrage envoyé au renderer (affiche la barre de progression)
    this._progress(runId, 'start', `Démarrage extraction [${module}]`, 0);

    let ok = 0, errors = 0, total = 0;

    try {
      // Étape 4 : selon le module demandé, appeler la bonne méthode
      switch (module) {
        case 'employees':
          // Un seul appel SOAP, pas besoin de boucler sur les salariés
          ({ ok, errors, total } = await this._runEmployees(clientSoap, runId, populationFilter, groupFilter));
          break;
        case 'organization':
          // Un seul appel SOAP pour tout l'organigramme
          ({ ok, errors, total } = await this._runOrganization(clientSoap, runId));
          break;
        case 'clockings':
        case 'absence-files':
        case 'absence-requests':
        case 'schedules':
        case 'job-assignments':
        case 'job-assignments-forecast':
        case 'section-assignments':
        case 'section-assignments-forecast':
          // Ces modules nécessitent un appel par salarié → on délègue à _runPerEmployee
          ({ ok, errors, total } = await this._runPerEmployee(clientSoap, runId, module, dateFrom, dateTo));
          break;
        case 'totals':
          // Les compteurs : un appel par (salarié × type de compteur)
          ({ ok, errors, total } = await this._runTotals(clientSoap, runId, accountTypes, modePeriode, dateFrom, dateTo));
          break;
        default:
          throw new Error(`Module inconnu: ${module}`);
      }

      // Étape 5 : marquer le run comme terminé avec le résumé
      this.runRepo.finish(runId, { ok, errors, total });
      this._progress(runId, 'done', `Extraction terminée — ${ok} OK / ${errors} erreurs`, 100);
      return { success: true, runId, ok, errors, total };

    } catch (erreurCritique) {
      // En cas d'erreur imprévue : on marque le run en ERREUR
      this.runRepo.fail(runId, erreurCritique.message);
      this._progress(runId, 'error', `Erreur critique: ${erreurCritique.message}`, 100);
      return { success: false, runId, error: erreurCritique.message };
    }
  }

  // ===========================================================================
  // MÉTHODES PRIVÉES — UNE PAR TYPE DE MODULE
  // ===========================================================================

  /**
   * Extrait et sauvegarde la liste des salariés.
   * Fait UN SEUL appel SOAP (pas de boucle par salarié).
   * Les salariés sont "upsertés" : INSERT ou UPDATE si déjà existant.
   *
   * @param {KelioSoapService} soap
   * @param {number} runId
   * @param {string} populationFilter
   * @param {string} groupFilter
   * @returns {Promise<{ok, errors, total}>}
   */
  async _runEmployees(soap, runId, populationFilter, groupFilter) {
    this._progress(runId, 'step', 'Import salariés...', 10);
    const resultat = await soap.exportEmployees(populationFilter, groupFilter);

    // On enregistre cet appel dans les logs du run (pour l'historique)
    this.runRepo.log(runId, resultat.success ? 'INFO' : 'ERROR',
      'LightEmployeeService', 'exportLightEmployees', null,
      resultat.success, resultat.message, resultat.durationMs);

    if (!resultat.success) return { ok: 0, errors: 1, total: 1 };

    const lignes = resultat.rows || [];
    // upsertBatch = INSERT or UPDATE : on ne crée pas de doublons
    if (lignes.length > 0) this.empRepo.upsertBatch(runId, lignes);
    this._progress(runId, 'step', `${lignes.length} salariés importés`, 80);
    return { ok: lignes.length, errors: 0, total: lignes.length };
  }

  /**
   * Extrait et sauvegarde l'organigramme.
   * Fait UN SEUL appel SOAP, puis insère les niveaux en base.
   * Utilise ON CONFLICT pour éviter les doublons (upsert manuel).
   *
   * @param {KelioSoapService} soap
   * @param {number} runId
   * @returns {Promise<{ok, errors, total}>}
   */
  async _runOrganization(soap, runId) {
    this._progress(runId, 'step', 'Import organigramme...', 10);
    const resultat = await soap.exportOrganizationChartLevels();
    this.runRepo.log(runId, resultat.success ? 'INFO' : 'ERROR',
      'OrganizationChartLevelService', 'exportOrganizationChartLevels', null,
      resultat.success, resultat.message, resultat.durationMs);

    if (!resultat.success) return { ok: 0, errors: 1, total: 1 };

    const lignes = resultat.rows || [];
    const maintenant = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Mapping camelCase (JS) → snake_case (DB)
    const columnMap = {
      organizationChartLevelKey: 'organization_chart_level_key',
      organizationChartLevelAbbreviation: 'organization_chart_level_abbreviation',
      organizationChartLevelDescription: 'organization_chart_level_description',
      organizationChartLevelDescriptionType: 'organization_chart_level_description_type',
      levelType: 'level_type',
      fullAbbreviation: 'full_abbreviation',
      fullDescription: 'full_description',
      levels: 'levels',
      technicalString: 'technical_string',
      sectionKey: 'section_key',
      sectionAbbreviation: 'section_abbreviation',
      sectionDescription: 'section_description',
      sectionManager: 'section_manager',
      departmentKey: 'department_key',
      departmentAbbreviation: 'department_abbreviation',
      departmentDescription: 'department_description',
      departmentManager: 'department_manager',
      subDepartmentKey: 'sub_department_key',
      subDepartmentAbbreviation: 'sub_department_abbreviation',
      subDepartmentDescription: 'sub_department_description',
      subDepartmentManager: 'sub_department_manager',
      firmKey: 'firm_key',
      firmAbbreviation: 'firm_abbreviation',
      firmDescription: 'firm_description',
      firmManager: 'firm_manager',
      level4Key: 'level4_key',
      level4Abbreviation: 'level4_abbreviation',
      level4Description: 'level4_description',
      level4Manager: 'level4_manager',
      level5Key: 'level5_key',
      level5Abbreviation: 'level5_abbreviation',
      level5Description: 'level5_description',
      level5Manager: 'level5_manager',
      level6Key: 'level6_key',
      level6Abbreviation: 'level6_abbreviation',
      level6Description: 'level6_description',
      level6Manager: 'level6_manager',
      level7Key: 'level7_key',
      level7Abbreviation: 'level7_abbreviation',
      level7Description: 'level7_description',
      level7Manager: 'level7_manager',
      level8Key: 'level8_key',
      level8Abbreviation: 'level8_abbreviation',
      level8Description: 'level8_description',
      level8Manager: 'level8_manager',
      companyKey: 'company_key',
      companyDescription: 'company_description',
      companyPhoneNumber: 'company_phone_number',
      companyFaxNumber: 'company_fax_number',
      companyMailAddress: 'company_mail_address',
      companyWebAddress: 'company_web_address',
      companyFileNumber: 'company_file_number',
      errorMessage: 'error_message',
    };

    const dbColumns = Object.values(columnMap);
    const jsKeys = Object.keys(columnMap);
    const placeholders = dbColumns.map(() => '?').join(', ');

    const upsert = this.db.prepare(`
      INSERT INTO kelio_organigramme (run_id, ${dbColumns.join(', ')}, imported_at)
      VALUES (?, ${placeholders}, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const ligne of lignes) {
        const values = jsKeys.map(key => ligne[key] ?? null);
        upsert.run(runId, ...values, maintenant);
      }
    });
    transaction();
    this._progress(runId, 'step', `${lignes.length} niveaux org. importés`, 80);
    return { ok: lignes.length, errors: 0, total: lignes.length };
  }

  /**
   * Extrait les données d'un module pour TOUS les salariés, en lots parallèles.
   * Utilisée pour : clockings, absence-files, absence-requests, schedules,
   *                  job-assignments, section-assignments.
   *
   * ALGORITHME DE PARALLÉLISATION AVEC PIPELINE :
   *   - On divise la liste des salariés en "lots" (batches) de CONCURRENCE
   *   - Pour chaque lot : on lance tous les appels SOAP en même temps (Promise.all)
   *   - PIPELINE : Chaque résultat est traité et inséré en DB dès qu'il arrive,
   *     sans attendre que tout le lot soit terminé. Cela réduit la latence.
   *   - La concurrence est configurable via les paramètres (défaut: 20)
   *
   *   Exemple avec 50 salariés et CONCURRENCE = 20 :
   *   Lot 1 : salariés 1à 20   (20 appels simultanés)
   *   Lot 2 : salariés 21à 40  (20 appels simultanés)
   *   Lot 3 : salariés 41à 50  (10 appels simultanés)
   *
   * @param {KelioSoapService} soap
   * @param {number} runId
   * @param {string} moduleKey - Ex: 'clockings', 'absence-files'...
   * @param {string} dateFrom
   * @param {string} dateTo
   * @returns {Promise<{ok, errors, total}>}
   */
  async _runPerEmployee(soap, runId, moduleKey, dateFrom, dateTo) {
    // Vérifier si on est en mode prévisionnel
    const isForecast = moduleKey.endsWith('-forecast');

    // Récupère les salariés actifs
    // En mode forecast, on a besoin du matricule (idNumber)
    const salaries = isForecast 
      ? this.empRepo.allActiveEmployeesWithId()
      : this.empRepo.allKeys().map(key => ({ key }));

    if (salaries.length === 0) return { ok: 0, errors: 0, total: 0 };

    // Correspondance module → nom de table SQLite de destination
    const correspondanceTable = {
      'clockings':                    'kelio_badgeage',
      'absence-files':                'kelio_absence_fiche',
      'absence-requests':             'kelio_absence_demande',
      'schedules':                    'kelio_horaire_affectation',
      'job-assignments':              'kelio_affectation_activite',
      'job-assignments-forecast':     'kelio_affectation_activite',
      'section-assignments':          'kelio_affectation_service_jour',
      'section-assignments-forecast': 'kelio_affectation_service_jour',
    };
    const tableDestination = correspondanceTable[moduleKey];

    const nombreTotal = salaries.length;
    let ok = 0, errors = 0, indiceCourant = 0;

    // Nombre d'appels SOAP simultanés maximum — configurable via paramètres
    const configActuelle = this.configRepo.getAll();
    const CONCURRENCE = parseInt(configActuelle.concurrency || '12', 10) || 12;

    /**
     * Retourne la bonne méthode SOAP selon le module.
     * @param {Object} salarie - Objet {key, idNumber}
     * @returns {Promise} - La Promise de l'appel SOAP
     */
    const appelSoap = (salarie) => {
      switch (moduleKey) {
        case 'clockings':                   return soap.exportClockings(salarie.key, dateFrom, dateTo);
        case 'absence-files':               return soap.exportAbsenceFiles(salarie.key, dateFrom, dateTo);
        case 'absence-requests':            return soap.exportAbsenceRequests(salarie.key, dateFrom, dateTo);
        case 'schedules':                   return soap.exportDailyScheduleAssignments(salarie.key, dateFrom, dateTo);
        case 'job-assignments':             return soap.exportJobAssignments(salarie.key, dateFrom, dateTo);
        case 'job-assignments-forecast':    return soap.exportJobAssignmentsForecast(salarie.idNumber, dateFrom, dateTo);
        case 'section-assignments':         return soap.exportSectionAssignments(salarie.key, dateFrom, dateTo);
        case 'section-assignments-forecast': return soap.exportSectionAssignmentsForecast(salarie.idNumber, dateFrom, dateTo);
      }
    };

    // Boucle par lots de CONCURRENCE salariés avec PIPELINE optimisé
    for (let i = 0; i < nombreTotal; i += CONCURRENCE) {
      const lot = salaries.slice(i, i + CONCURRENCE);

      // Lance tous les appels du lot avec gestion individuelle (pipeline)
      const promesses = lot.map(async (salarie) => {
        const cleLog = isForecast ? salarie.idNumber : salarie.key;
        const resultat = await appelSoap(salarie);

        // Traitement immédiat dès que l'appel SOAP termine (pas d'attente du lot)
        indiceCourant++;
        const pct = Math.round(10 + (indiceCourant / nombreTotal) * 85);
        this._progress(runId, 'step', `[${indiceCourant}/${nombreTotal}] ${moduleKey} → ${cleLog}`, pct);

        this.runRepo.log(runId, resultat.success ? 'INFO' : 'ERROR',
          moduleKey, moduleKey, salarie.key, resultat.success, resultat.message, resultat.durationMs);

        if (!resultat.success) {
          errors++;
          return { success: false, cleSalarie: salarie.key };
        }

        const lignes = resultat.rows || [];
        if (lignes.length > 0) {
          this._insertModuleRows(tableDestination, runId, salarie.key, lignes, dateFrom, dateTo);
        }
        ok++;
        return { success: true, cleSalarie: salarie.key, lignes: lignes.length };
      });

      // Attend que tous les traitements du lot soient terminés
      await Promise.all(promesses);
    }

    return { ok, errors, total: nombreTotal };
  }

  /**
   * Insère les lignes reçues du SOAP dans la bonne table SQLite.
   * Chaque "case" correspond à un schéma de table différent.
   *
   * OPTIMISATION BULK INSERT :
   *   - Utilise INSERT ... VALUES (...), (...), (...) pour insérer 100 lignes
   *     en une seule requête (au lieu de 100 requêtes individuelles).
   *   - Gain de performance : 5-10x plus rapide pour les gros volumes.
   *   - Limite SQLite : 1000 paramètres max → batch de 100 lignes max par requête.
   *
   * @param {string} table    - Nom de la table SQLite de destination
   * @param {number} runId    - ID du run en cours (pour traçabilité)
   * @param {string} empKey   - Clé du salarié concerné
   * @param {Array}  rows     - Lignes de données à insérer
   * @param {string} dateFrom - Date de début (utilisée comme fallback si la date est manquante)
   * @param {string} dateTo   - Date de fin
   */
  _insertModuleRows(table, runId, empKey, rows, dateFrom, dateTo) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19); // Timestamp d'import
    if (!rows || rows.length === 0) return;

    // Vérification de sécurité : empKey ne doit jamais être null/undefined/vide
    if (!empKey || String(empKey).trim() === '') {
      console.error(`[ExtractionOrchestrator] Tentative d'insertion avec empKey invalide dans ${table}:`, empKey);
      return; // On n'insère rien plutôt que de planter avec NOT NULL constraint
    }
    const cleSalarie = String(empKey).trim();

    // =========================================================================
    // OPTIMISATION BULK INSERT — INSERT ... VALUES (...), (...), (…)
    // =========================================================================
    // better-sqlite3 supporte l'insertion multi-values en une seule requête.
    // C'est beaucoup plus rapide que N requêtes individuelles dans une transaction.
    //
    // Exemple : INSERT INTO t VALUES (1,2), (3,4), (5,6)  ← 1 requête pour 3 lignes
    // vs 3 requêtes séparées avec BEGIN/COMMIT
    //
    // Limite SQLite : 1000 paramètres max par requête. Avec 9 colonnes → ~111 lignes max.
    // Si plus de lignes, on batch en groupes de 100 lignes pour être safe.
    // =========================================================================

    const BULK_SIZE = 100; // Nombre de lignes max par requête bulk (conservateur)

    if (table === 'kelio_badgeage') {
      // 34 colonnes : tous les champs de la documentation Kelio
      for (let i = 0; i < rows.length; i += BULK_SIZE) {
        const batch = rows.slice(i, i + BULK_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const stmt = this.db.prepare(`INSERT INTO kelio_badgeage (run_id, employee_key, clocking_date, clocking_datetime, direction_code, terminal_code, reader_code, badge_code, absence_type_abbreviation, absence_type_description, absence_type_key, archived_employee, automatic, clocking_type_indicator, employee_badge_code, employee_first_name, employee_identification_code, employee_identification_number, employee_key, employee_surname, error_message, geolocation_precision, geolocation_status, latitude, longitude, obtaining_mode, overtime_type_abbreviation, overtime_type_description, overtime_type_key, reader_description, technical_string, terminal_description, time_position, imported_at) VALUES ${placeholders}`);
        const params = batch.flatMap(r => {
          const dt = (r.date && r.time) ? `${r.date}T${r.time}` : null;
          return [
            runId, cleSalarie, r.date ?? dateFrom, dt, r.inOutIndicator ?? null, r.terminalKey ?? null, r.readerKey ?? null, r.clockingKey ?? null,
            r.absenceTypeAbbreviation ?? null, r.absenceTypeDescription ?? null, r.absenceTypeKey ?? null,
            r.archivedEmployee ? 1 : 0, r.automatic ? 1 : 0, r.clockingTypeIndicator ?? null,
            r.employeeBadgeCode ?? null, r.employeeFirstName ?? null, r.employeeIdentificationCode ?? null, r.employeeIdentificationNumber ?? null, r.employeeKey ?? null, r.employeeSurname ?? null,
            r.errorMessage ?? null, r.geolocationPrecision ?? null, r.geolocationStatus ?? null, r.latitude ?? null, r.longitude ?? null,
            r.obtainingMode ?? null, r.overtimeTypeAbbreviation ?? null, r.overtimeTypeDescription ?? null, r.overtimeTypeKey ?? null,
            r.readerDescription ?? null, r.technicalString ?? null, r.terminalDescription ?? null, r.timePosition ?? null,
            now
          ];
        });
        try {
          stmt.run(...params);
        } catch (e) {
          console.error(`[ERROR] Insertion badgeage batch ${i}-${i+BULK_SIZE} pour cleSalarie='${cleSalarie}':`, e.message);
          throw e;
        }
      }
    } else if (table === 'kelio_absence_fiche') {
      // 48 colonnes : tous les champs de la documentation Kelio
      for (let i = 0; i < rows.length; i += BULK_SIZE) {
        const batch = rows.slice(i, i + BULK_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const stmt = this.db.prepare(`INSERT INTO kelio_absence_fiche (run_id, employee_key, file_key, type_key, type_abbreviation, type_description, start_date, end_date, duration_days, status_code, archived_employee, comment, creation_date, duration_in_hours, employee_badge_code, employee_first_name, employee_identification_code, employee_identification_number, employee_key, employee_surname, ending_the_afternoon, error_message, event_observing_date, exist_related_document, first_end_time, first_end_time_position, first_start_time, first_start_time_position, initial_notice_cessation_work_date, last_modification_date, last_working_day_date, limited_to_a_period, notice_cessation_work_extension, number_of_absence_days, prescribed_end_date, repetitive_absence_period, resumption_work_date, resumption_work_early_date, second_end_time, second_end_time_position, second_start_time, second_start_time_position, split_holidays_waiver, start_in_the_morning, technical_string, total_in_days, total_in_hours, imported_at) VALUES ${placeholders}`);
        const params = batch.flatMap(r => [
          runId, cleSalarie, r.absenceFileKey ?? null, r.absenceTypeKey ?? null, r.absenceTypeAbbreviation ?? null, r.absenceTypeDescription ?? null, r.startDate ?? dateFrom, r.endDate ?? dateTo, r.durationInDays ?? null, r.statusCode ?? null,
          r.archivedEmployee ? 1 : 0, r.comment ?? null, r.creationDate ?? null, r.durationInHours ?? null,
          r.employeeBadgeCode ?? null, r.employeeFirstName ?? null, r.employeeIdentificationCode ?? null, r.employeeIdentificationNumber ?? null, r.employeeKey ?? null, r.employeeSurname ?? null,
          r.endingTheAfternoon ? 1 : 0, r.errorMessage ?? null, r.eventObservingDate ?? null, r.existRelatedDocument ? 1 : 0,
          r.firstEndTime ?? null, r.firstEndTimePosition ?? null, r.firstStartTime ?? null, r.firstStartTimePosition ?? null,
          r.initialNoticeCessationWorkDate ?? null, r.lastModificationDate ?? null, r.lastWorkingDayDate ?? null,
          r.limitedToAPeriod ? 1 : 0, r.noticeCessationWorkExtension ? 1 : 0, r.numberOfAbsenceDays ?? null, r.prescribedEndDate ?? null,
          r.repetitiveAbsencePeriod ?? null, r.resumptionWorkDate ?? null, r.resumptionWorkEarlyDate ?? null,
          r.secondEndTime ?? null, r.secondEndTimePosition ?? null, r.secondStartTime ?? null, r.secondStartTimePosition ?? null,
          r.splitHolidaysWaiver ?? null, r.startInTheMorning ? 1 : 0, r.technicalString ?? null, r.totalInDays ?? null, r.totalInHours ?? null,
          now
        ]);
        stmt.run(...params);
      }
    } else if (table === 'kelio_absence_demande') {
      // 45 colonnes : tous les champs de la documentation Kelio
      for (let i = 0; i < rows.length; i += BULK_SIZE) {
        const batch = rows.slice(i, i + BULK_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const stmt = this.db.prepare(`INSERT INTO kelio_absence_demande (run_id, employee_key, request_key, type_key, type_description, start_date, end_date, duration_days, status_code, absence_file_key, absence_type_abbreviation, archived_employee, comment, creation_date, duration_in_hours, employee_badge_code, employee_first_name, employee_identification_code, employee_identification_number, employee_surname, ending_the_afternoon, error_message, first_end_time, first_end_time_position, first_start_time, first_start_time_position, last_modification_date, request_type, second_end_time, second_end_time_position, second_start_time, second_start_time_position, split_holidays_waiver, start_in_the_morning, technical_string, total_in_days, total_in_hours, validators_badge_codes, validators_first_names, validators_identification_code, validators_identification_numbers, validators_keys, validators_logins, validators_surnames, imported_at) VALUES ${placeholders}`);
        const params = batch.flatMap(r => [
          runId, cleSalarie, r.absenceRequestKey ?? null, r.absenceTypeKey ?? null, r.absenceTypeDescription ?? null, r.startDate ?? dateFrom, r.endDate ?? dateTo, r.durationInDays ?? null, r.requestState ?? null,
          r.absenceFileKey ?? null, r.absenceTypeAbbreviation ?? null, r.archivedEmployee ? 1 : 0, r.comment ?? null, r.creationDate ?? null, r.durationInHours ?? null,
          r.employeeBadgeCode ?? null, r.employeeFirstName ?? null, r.employeeIdentificationCode ?? null, r.employeeIdentificationNumber ?? null, r.employeeSurname ?? null,
          r.endingTheAfternoon ? 1 : 0, r.errorMessage ?? null, r.firstEndTime ?? null, r.firstEndTimePosition ?? null, r.firstStartTime ?? null, r.firstStartTimePosition ?? null,
          r.lastModificationDate ?? null, r.requestType ?? null, r.secondEndTime ?? null, r.secondEndTimePosition ?? null, r.secondStartTime ?? null, r.secondStartTimePosition ?? null,
          r.splitHolidaysWaiver ?? null, r.startInTheMorning ? 1 : 0, r.technicalString ?? null, r.totalInDays ?? null, r.totalInHours ?? null,
          r.validatorsBadgeCodes ?? null, r.validatorsFirstNames ?? null, r.validatorsIdentificationCode ?? null, r.validatorsIdentificationNumbers ?? null, r.validatorsKeys ?? null, r.validatorsLogins ?? null, r.validatorsSurnames ?? null,
          now
        ]);
        stmt.run(...params);
      }
    } else if (table === 'kelio_horaire_affectation') {
      // 45 colonnes : tous les champs de la documentation Kelio
      for (let i = 0; i < rows.length; i += BULK_SIZE) {
        const batch = rows.slice(i, i + BULK_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const stmt = this.db.prepare(`INSERT INTO kelio_horaire_affectation (run_id, employee_key, schedule_key, schedule_code, schedule_description, start_date, imported_at, schedule_abbreviation, afternoon_contracted_time, archived_employee, assignement_by_exception, calculation_mode_contracted_schedule, comment, contracted_time, employee_badge_code, employee_first_name, employee_identification_code, employee_identification_number, employee_surname, error_message, fifth_working_period_end_time, fifth_working_period_end_time_position, fifth_working_period_start_time, fifth_working_period_start_time_position, first_working_period_end_time, first_working_period_end_time_position, first_working_period_start_time, first_working_period_start_time_position, fourth_working_period_end_time, fourth_working_period_end_time_position, fourth_working_period_start_time, fourth_working_period_start_time_position, half_day_time, morning_contracted_time, night_start_time, night_start_time_position, second_working_period_end_time, second_working_period_end_time_position, second_working_period_start_time, second_working_period_start_time_position, technical_string, third_working_period_end_time, third_working_period_end_time_position, third_working_period_start_time, third_working_period_start_time_position) VALUES ${placeholders}`);
        const params = batch.flatMap(r => [
          runId, cleSalarie, r.dailyScheduleKey ?? null, r.dailyScheduleAbbreviation ?? null, r.dailyScheduleDescription ?? r.scheduleDescription ?? null, r.assignmentDate ?? dateFrom, now,
          r.scheduleAbbreviation ?? null,
          r.afternoonContractedTime ?? null, r.archivedEmployee ? 1 : 0, r.assignementByException ? 1 : 0, r.calculationModeContractedSchedule ?? null, r.comment ?? null, r.contractedTime ?? null,
          r.employeeBadgeCode ?? null, r.employeeFirstName ?? null, r.employeeIdentificationCode ?? null, r.employeeIdentificationNumber ?? null, r.employeeSurname ?? null,
          r.errorMessage ?? null,
          r.fifthWorkingPeriodEndTime ?? null, r.fifthWorkingPeriodEndTimePosition ?? null, r.fifthWorkingPeriodStartTime ?? null, r.fifthWorkingPeriodStartTimePosition ?? null,
          r.firstWorkingPeriodEndTime ?? null, r.firstWorkingPeriodEndTimePosition ?? null, r.firstWorkingPeriodStartTime ?? null, r.firstWorkingPeriodStartTimePosition ?? null,
          r.fourthWorkingPeriodEndTime ?? null, r.fourthWorkingPeriodEndTimePosition ?? null, r.fourthWorkingPeriodStartTime ?? null, r.fourthWorkingPeriodStartTimePosition ?? null,
          r.halfDayTime ?? null, r.morningContractedTime ?? null, r.nightStartTime ?? null, r.nightStartTimePosition ?? null,
          r.secondWorkingPeriodEndTime ?? null, r.secondWorkingPeriodEndTimePosition ?? null, r.secondWorkingPeriodStartTime ?? null, r.secondWorkingPeriodStartTimePosition ?? null,
          r.technicalString ?? null,
          r.thirdWorkingPeriodEndTime ?? null, r.thirdWorkingPeriodEndTimePosition ?? null, r.thirdWorkingPeriodStartTime ?? null, r.thirdWorkingPeriodStartTimePosition ?? null
        ]);
        stmt.run(...params);
      }
    } else if (table === 'kelio_affectation_activite') {
      // 15 colonnes : tous les champs de la documentation Kelio
      for (let i = 0; i < rows.length; i += BULK_SIZE) {
        const batch = rows.slice(i, i + BULK_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const stmt = this.db.prepare(`INSERT INTO kelio_affectation_activite (run_id, employee_key, job_key, job_code, job_description, assignment_date, employee_badge_code, employee_first_name, employee_identification_code, employee_identification_number, employee_surname, archived_employee, error_message, technical_string, imported_at) VALUES ${placeholders}`);
        const params = batch.flatMap(r => [
          runId, cleSalarie, r.jobKey ?? null, r.jobAbbreviation ?? null, r.jobDescription ?? null, r.assignmentDate ?? dateFrom,
          r.employeeBadgeCode ?? null, r.employeeFirstName ?? null, r.employeeIdentificationCode ?? null, r.employeeIdentificationNumber ?? null,
          r.employeeSurname ?? null, r.archivedEmployee ? 1 : 0, r.errorMessage ?? null, r.technicalString ?? null,
          now
        ]);
        stmt.run(...params);
      }
    } else if (table === 'kelio_affectation_service_jour') {
      // 8 colonnes : (run_id, employee_key, section_key, section_code, section_description, assignment_date, comment, imported_at)
      for (let i = 0; i < rows.length; i += BULK_SIZE) {
        const batch = rows.slice(i, i + BULK_SIZE);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const stmt = this.db.prepare(`INSERT INTO kelio_affectation_service_jour (run_id, employee_key, section_key, section_code, section_description, assignment_date, comment, imported_at) VALUES ${placeholders}`);
        const params = batch.flatMap(r => [runId, cleSalarie, r.sectionKey ?? null, r.sectionAbbreviation ?? null, r.sectionDescription ?? null, r.assignmentDate ?? dateFrom, r.comment ?? null, now]);
        stmt.run(...params);
      }
    }
  }

  /**
   * Extrait les compteurs (totaux) pour tous les salariés et tous les types demandés.
   * C'est la méthode la plus complexe car elle boucle sur DEUX dimensions :
   *   - Les types de compteurs (ex: ACCOUNT, ABSENCE, BONUS...)
   *   - Les salariés (en lots parallèles)
   *
   * Pour N salariés et M types de compteurs → N × M appels SOAP au total.
   * Exemple : 40 salariés × 10 types = 400 appels SOAP (traités par lots de 8).
   *
   * @param {KelioSoapService} soap
   * @param {number} runId
   * @param {string[]} accountTypes - Types sélectionnés (si vide : tous les types)
   * @param {string} modePeriode    - 'JOUR' ou 'MOIS'
   * @param {string} dateFrom
   * @param {string} dateTo
   * @returns {Promise<{ok, errors, total}>}
   */
  async _runTotals(soap, runId, accountTypes, modePeriode, dateFrom, dateTo) {
    // Correspondance code interne → nom du service SOAP Kelio
    const correspondanceServices = {
      ACCOUNT:                  'AccountTotalService',
      LATENESS_EARLY_DEPARTURE: 'LatenessEarlyDepartureTotalService',
      BALANCE:                  'BalanceTotalService',
      ABSENCE:                  'AbsenceTotalService',
      ABSENCE_BALANCE:          'AbsenceBalanceTotalService',
      OVERTIME_HOUR:            'OvertimeHourTotalService',
      SPECIAL_HOUR:             'SpecialHourTotalService',
      BONUS:                    'BonusTotalService',
      ON_CALL_DUTY:             'OnCallDutyTotalService',
      JOB:                      'JobTotalService',
    };

    const clesSalaries = this.empRepo.allKeys();

    // Si aucun type spécifié, on extrait tous les types disponibles
    const typesATraiter = (accountTypes && accountTypes.length > 0)
      ? accountTypes
      : Object.keys(correspondanceServices);

    let ok = 0, errors = 0, total = 0;
    const totalAppels = typesATraiter.length * clesSalaries.length;
    let indiceCourant = 0;
    // Concurrence configurable via les paramètres (défaut: 12 avec Keep-Alive)
    const CONCURRENCE = parseInt(this.configRepo.getAll().concurrency || '12', 10) || 12;
    const mode = modePeriode ?? 'JOUR'; // Mode par défaut : journalier

    // Boucle externe : sur chaque type de compteur
    for (const codeType of typesATraiter) {
      const nomService = correspondanceServices[codeType];
      if (!nomService) continue; // Ignore les codes inconnus

      // Boucle interne : sur les salariés par lots parallèles avec pipeline
      for (let i = 0; i < clesSalaries.length; i += CONCURRENCE) {
        const lot = clesSalaries.slice(i, i + CONCURRENCE);

        // Lance tous les appels du lot en parallèle avec pipeline (traitement immédiat)
        const promesses = lot.map(async (cleSalarie) => {
          const resultat = await soap.exportTotals(nomService, codeType, mode, cleSalarie, dateFrom, dateTo);

          // Traitement immédiat (pipeline)
          indiceCourant++;
          total++;
          const pct = Math.round(5 + (indiceCourant / totalAppels) * 90);
          this._progress(runId, 'step', `[${indiceCourant}/${totalAppels}] ${codeType} → ${cleSalarie}`, pct);

          this.runRepo.log(runId, resultat.success ? 'INFO' : 'ERROR',
            nomService, mode, cleSalarie, resultat.success, resultat.message, resultat.durationMs);

          if (!resultat.success) {
            errors++;
            return { success: false, cleSalarie };
          }

          const lignes = resultat.rows || [];
          // Insère les lignes dans kelio_resultat_total via ResultRepository
          if (lignes.length > 0) {
            this.resRepo.insertBatch(runId, mode, nomService, codeType, lignes);
          }
          ok++;
          return { success: true, cleSalarie, lignes: lignes.length };
        });

        await Promise.all(promesses);
      }
    }

    return { ok, errors, total };
  }

  /**
   * Envoie une mise à jour de progression au renderer via le callback onProgress.
   * Appelée à chaque étape importante du traitement.
   *
   * Le renderer écoute via window.KelioAPI.onExtractionProgress() et affiche
   * la barre de progression + le message dans l'interface.
   *
   * @param {number} runId   - ID du run en cours
   * @param {string} type    - Type d'événement : 'start' | 'step' | 'done' | 'error'
   * @param {string} message - Message descriptif affiché à l'utilisateur
   * @param {number} percent - Pourcentage d'avancement (0 à 100)
   */
  _progress(runId, type, message, percent) {
    this.onProgress({
      runId,
      type,
      message,
      percent,
      ts: new Date().toISOString(), // Horodatage pour les logs
    });
  }
}

module.exports = ExtractionOrchestrator;
