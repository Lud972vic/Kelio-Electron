'use strict';

/**
 * @file EmployeeRepository.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — GESTION DES SALARIÉS EN BASE
 * ============================================================
 *
 * Ce repository centralise toutes les opérations sur la table `kelio_salarie`.
 * Les salariés sont importés depuis Kelio via le service SOAP `LightEmployeeService`,
 * puis stockés localement pour :
 *   1. Affichage dans la page Salariés
 *   2. Boucle d'extraction : on itère sur leurs clés pour appeler les autres services
 *
 * TABLE GÉRÉE : `kelio_salarie`
 *
 * PATTERN UPSERT :
 * Les salariés ne sont pas dupliqués à chaque extraction.
 * La colonne `employee_key` est UNIQUE : si un salarié existe déjà,
 * on met à jour ses informations (ON CONFLICT DO UPDATE).
 *
 * APPELANTS :
 * - ExtractionOrchestrator._runEmployees() : upsertBatch()
 * - ExtractionOrchestrator._runPerEmployee() : allKeys()
 * - main.js (handlers 'employees:list', 'employees:count') : list(), count()
 */

class EmployeeRepository {
  /**
   * @param {Database} db - Instance better-sqlite3
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Insère ou met à jour un lot de salariés reçus du SOAP.
   * Utilisé après l'appel à exportEmployees().
   *
   * DOUBLE NOMMAGE DES CHAMPS :
   * Les objets viennent de KelioSoapService (_employeeFromNode) avec des noms
   * camelCase SOAP (ex: `employeeSurname`), mais on accepte aussi les noms SQL
   * (ex: `surname`) pour la flexibilité. L'opérateur ?? permet d'éssayer l'un puis l'autre.
   *
   * @param {number} runId - ID du run d'extraction en cours
   * @param {Array}  rows  - Tableau d'objets salariés (format SOAP)
   */
  upsertBatch(runId, rows) {
    const maintenant = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Mapping camelCase (JS/SOAP) → snake_case (DB)
    const columnMap = {
      employeeKey: 'employee_key',
      employeeIdentificationNumber: 'employee_identification_number',
      employeeIdentificationCode: 'employee_identification_code',
      employeeBadgeCode: 'employee_badge_code',
      employeeSurname: 'employee_surname',
      employeeFirstName: 'employee_first_name',
      archivedEmployee: 'archived_employee',
      takenIntoAccountStartDate: 'taken_into_account_start_date',
      takenIntoAccountEndDate: 'taken_into_account_end_date',
      takenIntoAccountPeriodStartDate: 'taken_into_account_period_start_date',
      takenIntoAccountPeriodEndDate: 'taken_into_account_period_end_date',
      defaultEmployeeBadge: 'default_employee_badge',
      defaultEmployeeFirstName: 'default_employee_first_name',
      defaultEmployeeIdentificationCode: 'default_employee_identification_code',
      defaultEmployeeIdentificationNumber: 'default_employee_identification_number',
      defaultEmployeeSurname: 'default_employee_surname',
      currentAccessAuthorizationStartDate: 'current_access_authorization_start_date',
      currentAccessAuthorizationStartTime: 'current_access_authorization_start_time',
      currentAccessAuthorizationEndDate: 'current_access_authorization_end_date',
      currentAccessAuthorizationEndTime: 'current_access_authorization_end_time',
      generateBadge: 'generate_badge',
      isAccessModuleEmployee: 'is_access_module_employee',
      isTandAModuleEmployee: 'is_tanda_module_employee',
      searchUsingBadge: 'search_using_badge',
      searchUsingFirstname: 'search_using_firstname',
      searchUsingIdentificationNumber: 'search_using_identification_number',
      searchUsingSurname: 'search_using_surname',
      populationFilter: 'population_filter',
      groupFilter: 'group_filter',
      populationMode: 'population_mode',
      populationStartDate: 'population_start_date',
      populationEndDate: 'population_end_date',
      errorMessage: 'error_message',
      technicalString: 'technical_string',
      useDefaultModelEmployee: 'use_default_model_employee',
      userProfileAssignmentWizardDescription: 'user_profile_assignment_wizard_description',
      userProfileAssignmentWizardKey: 'user_profile_assignment_wizard_key',
      sectionKey: 'section_key',
    };

    const dbColumns = Object.values(columnMap);
    const jsKeys = Object.keys(columnMap);
    const placeholders = dbColumns.map(() => '?').join(', ');

    const upsert = this.db.prepare(`
      INSERT INTO kelio_salarie (run_id, ${dbColumns.join(', ')}, imported_at)
      VALUES (?, ${placeholders}, ?)
      ON CONFLICT(employee_key) DO UPDATE SET
        run_id = excluded.run_id,
        ${dbColumns.map(col => `${col} = excluded.${col}`).join(', ')},
        imported_at = excluded.imported_at
    `);

    const transaction = this.db.transaction((items) => {
      for (const r of items) {
        const values = jsKeys.map(key => {
          const val = r[key];
          if (typeof val === 'boolean') return val ? 1 : 0;
          return val ?? null;
        });
        upsert.run(runId, ...values, maintenant);
      }
    });
    transaction(rows);
  }

  /**
   * Retourne la liste des salariés avec filtres et pagination optionnels.
   * Construit la requête SQL dynamiquement selon les filtres reçus.
   *
   * WHY `WHERE 1=1` ?
   * Cette astuce permet d'ajouter des conditions avec `AND ...` sans se soucier
   * de si c'est la première condition ou non. Sans ça, on devrait gérer le cas
   * "premier AND vs WHERE".
   *
   * Appelé par main.js (handler 'employees:list').
   *
   * @param {Object} filters
   * @param {string}  filters.q        - Recherche texte libre (nom, prénom, matricule, clé)
   * @param {string}  filters.section  - Filtre par clé de service
   * @param {boolean} filters.archived - true = archivés, false = actifs
   * @param {number}  filters.limit    - Nombre de résultats max (pagination)
   * @param {number}  filters.offset   - Point de départ (pagination)
   * @returns {Array}
   */
  list(filters = {}) {
    let sql = 'SELECT * FROM kelio_salarie WHERE 1=1';
    const params = [];

    // Recherche texte : on cherche dans plusieurs colonnes à la fois
    if (filters.q) {
      sql += ' AND (employee_surname LIKE ? OR employee_first_name LIKE ? OR employee_identification_number LIKE ? OR employee_key LIKE ?)';
      const motif = `%${filters.q}%`; // Les % sont les jokers SQL (comme * en shell)
      params.push(motif, motif, motif, motif);
    }
    // Filtre actifs/archivés (si non spécifié, on retourne tous)
    if (filters.archived !== undefined && filters.archived !== '') {
      sql += ' AND archived_employee = ?';
      params.push(filters.archived ? 1 : 0);
    }

    sql += ' ORDER BY employee_surname, employee_first_name'; // Tri alphabétique

    // Pagination : LIMIT = nb de résultats, OFFSET = à partir de quelle ligne
    if (filters.limit) {
      sql += ` LIMIT ${parseInt(filters.limit, 10)}`;
      if (filters.offset) sql += ` OFFSET ${parseInt(filters.offset, 10)}`;
    }

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Compte le nombre de salariés correspondant aux filtres.
   * Utilisé pour calculer le nombre total de pages de pagination.
   *
   * @param {Object} filters - Mêmes filtres que list() (sans limit/offset)
   * @returns {number}
   */
  count(filters = {}) {
    let sql = 'SELECT COUNT(*) as n FROM kelio_salarie WHERE 1=1';
    const params = [];
    if (filters.q) {
      sql += ' AND (employee_surname LIKE ? OR employee_first_name LIKE ? OR employee_identification_number LIKE ?)';
      const motif = `%${filters.q}%`;
      params.push(motif, motif, motif);
    }
    // ?.n ?? 0 : si la requête retourne null (table vide), on retourne 0
    return this.db.prepare(sql).get(...params)?.n ?? 0;
  }

  /**
   * Retourne la liste de TOUTES les clés et matricules des salariés actifs.
   * Utilisé pour les extractions qui demandent le matricule (IdentificationNumber).
   *
   * @returns {Array<{key: string, idNumber: string}>}
   */
  allActiveEmployeesWithId() {
    return this.db
      .prepare("SELECT employee_key, employee_identification_number FROM kelio_salarie WHERE archived_employee = 0 AND employee_key IS NOT NULL AND employee_key != ''")
      .all()
      .map(ligne => ({
        key: ligne.employee_key,
        idNumber: ligne.employee_identification_number
      }));
  }

  /**
   * Retourne la liste de TOUTES les clés des salariés actifs (non archivés).
   * Utilisée par ExtractionOrchestrator pour boucler sur les salariés.
   * On exclut les archivés car ils n'ont plus d'activité courante.
   *
   * FILTRE : On exclut aussi les clés NULL ou vides pour éviter les erreurs
   * NOT NULL constraint lors de l'insertion dans les tables d'extraction.
   *
   * @returns {string[]} - Tableau de clés (ex: ['EMP001', 'EMP002', ...])
   */
  allKeys() {
    return this.db
      .prepare("SELECT employee_key FROM kelio_salarie WHERE archived_employee = 0 AND employee_key IS NOT NULL AND employee_key != ''")
      .all()
      .map(ligne => ligne.employee_key) // On ne garde que la valeur, pas l'objet
      .filter(key => key && key.trim() !== ''); // Double sécurité côté JS
  }
}

module.exports = EmployeeRepository;
