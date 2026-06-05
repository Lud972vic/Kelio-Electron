'use strict';

/**
 * @file ResultRepository.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — GESTION DES COMPTEURS (TOTAUX)
 * ============================================================
 *
 * Ce repository gère la table `kelio_resultat_total`.
 * Cette table est la plus volumineuse : elle contient tous les compteurs
 * Kelio (soldes, heures, absences...) pour chaque salarié et chaque jour/mois.
 *
 * STRUCTURE D'UN RÉSULTAT TOTAL :
 * Un résultat = une ligne = la valeur d'UN compteur pour UN salarié à UNE date.
 * Exemples :
 *   - Salarié Martin, compte SOLDE, jour 2024-03-15 = 2.5 heures
 *   - Salarié Dupont, compte ABSENCE, mois 2024-04 = 1 jour
 *
 * VOLUME ESTIMÉ :
 * 40 salariés × 10 types × 365 jours = ~146 000 lignes/an
 * SQLite gère ça très bien (limite à 17 To).
 *
 * TABLE GÉRÉE : `kelio_resultat_total`
 *
 * APPELANTS :
 * - ExtractionOrchestrator._runTotals() : insertBatch()
 * - main.js (handlers 'results:list', 'results:stats') : list(), stats()
 */

class ResultRepository {
  /**
   * @param {Database} db - Instance better-sqlite3
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Insère un lot de compteurs (totaux) dans la base.
   * Appelé après chaque appel SOAP exportTotals() réussi.
   *
   * VALEUR CANONIQUE (value_canonical) :
   * Les compteurs Kelio peuvent avoir différents types de valeur selon le service :
   *   - `hours`        : valeur en heures (ex: 7.5)
   *   - `physicalHours`: heures physiques
   *   - `days`         : valeur en jours (ex: 0.5)
   *   - `number`       : valeur générique
   * `value_canonical` prend la première valeur non-nulle pour simplifier les requêtes.
   *
   * @param {number}   runId        - ID du run
   * @param {string}   modePeriode  - 'JOUR' ou 'MOIS'
   * @param {string}   serviceName  - Nom du service Kelio (ex: 'AccountTotalService')
   * @param {string}   accountType  - Code du type de compteur (ex: 'ACCOUNT')
   * @param {Array}    rows         - Tableau de résultats (format SOAP _totalFromNode)
   */
  insertBatch(runId, modePeriode, serviceName, accountType, rows) {
    const maintenant = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const insert = this.db.prepare(`
      INSERT INTO kelio_resultat_total
        (run_id, mode_periode, employee_key, employee_identification_number,
         employee_surname, employee_first_name, archived_employee,
         section_key, section_description, account_type, service_name,
         type_key, type_abbreviation, type_description,
         start_date, end_date, result_date,
         hours, physical_hours, days, number_value, value_canonical, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((items) => {
      for (const r of items) {
        // La date de résultat : on essaie 'date' puis 'periodStartDate'
        const dateResultat = r.date ?? r.periodStartDate ?? null;

        // Valeur canonique : on prend la première valeur non-nulle disponible
        const valeurCanonique = r.hours ?? r.physicalHours ?? r.days ?? r.number ?? null;

        insert.run(
          runId, modePeriode,
          r.employeeKey                  ?? null,
          r.employeeIdentificationNumber ?? null,
          r.employeeSurname              ?? null,
          r.employeeFirstName            ?? null,
          r.archivedEmployee ? 1 : 0,
          r.sectionKey                   ?? null,
          r.sectionDescription           ?? null,
          accountType                    ?? null,  // Ex: 'ACCOUNT', 'ABSENCE'...
          serviceName                    ?? null,  // Ex: 'AccountTotalService'
          r.typeKey                      ?? null,  // Clé du type de compteur
          r.typeAbbreviation             ?? null,  // Code court (ex: 'SOLDE')
          r.typeDescription              ?? null,  // Libellé long
          r.periodStartDate ?? dateResultat ?? null,
          r.periodEndDate   ?? dateResultat ?? null,
          dateResultat,
          r.hours         ?? null,
          r.physicalHours ?? null,
          r.days          ?? null,
          r.number        ?? null,
          valeurCanonique,
          maintenant
        );
      }
    });
    transaction(rows);
  }

  /**
   * Retourne la liste des compteurs avec filtres et pagination.
   * Construit dynamiquement la requête SQL selon les filtres actifs.
   *
   * Appelé par main.js (handler 'results:list') → page Résultats.
   *
   * @param {Object} filters
   * @param {string} filters.employee     - Recherche par salarié (clé, nom, matricule)
   * @param {string} filters.type_key     - Filtre par clé de type compteur exact
   * @param {string} filters.date_from    - Date de résultat minimum
   * @param {string} filters.date_to      - Date de résultat maximum
   * @param {number} filters.run_id       - Filtre par run spécifique
   * @param {string} filters.account_type - Filtre par type (ex: 'ACCOUNT', 'ABSENCE')
   * @param {number} filters.limit        - Pagination
   * @param {number} filters.offset       - Pagination
   * @returns {Array}
   */
  list(filters = {}) {
    let sql = `
      SELECT rt.*
      FROM kelio_resultat_total rt
      WHERE 1=1
    `;
    const params = [];

    // Recherche libre sur le salarié (clé métier, nom, ou matricule)
    if (filters.employee) {
      sql += ' AND (rt.employee_key LIKE ? OR rt.employee_surname LIKE ? OR rt.employee_identification_number LIKE ?)';
      const motif = `%${filters.employee}%`;
      params.push(motif, motif, motif);
    }
    // Filtre sur la clé exacte du type de compteur (ex: 'HEURE_SUPP')
    if (filters.type_key) {
      sql += ' AND rt.type_key = ?';
      params.push(filters.type_key);
    }
    // Plage de dates sur result_date (la date du compteur, pas l'import)
    if (filters.date_from) {
      sql += ' AND rt.result_date >= ?';
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      sql += ' AND rt.result_date <= ?';
      params.push(filters.date_to);
    }
    // Filtre par run : voir uniquement les résultats d'une extraction précise
    if (filters.run_id) {
      sql += ' AND rt.run_id = ?';
      params.push(filters.run_id);
    }
    // Filtre par groupe de compteurs (ex: afficher seulement les absences)
    if (filters.account_type) {
      sql += ' AND rt.account_type = ?';
      params.push(filters.account_type);
    }

    sql += ' ORDER BY rt.result_date DESC, rt.employee_surname, rt.type_key';

    if (filters.limit) {
      sql += ` LIMIT ${parseInt(filters.limit, 10)}`;
      if (filters.offset) sql += ` OFFSET ${parseInt(filters.offset, 10)}`;
    }

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Retourne les statistiques globales : nombre de lignes dans chaque table.
   * Utilisé pour afficher les cartes de statistiques sur le dashboard.
   *
   * ASTUCE : la fonction locale `compter(sql)` évite la répétition du même
   * pattern `db.prepare(...).get()?.n ?? 0` pour chaque table.
   *
   * Appelé par main.js (handler 'results:stats') → page Dashboard.
   *
   * @returns {{employees, clockings, absenceFiles, absenceRequests, schedules,
   *            jobAssignments, sectionAssignments, organization, totals, runs}}
   */
  stats() {
    // Raccourci local : exécute un COUNT(*) et retourne le nombre (ou 0)
    const compter = (sql) => this.db.prepare(sql).get()?.n ?? 0;
    return {
      employees:          compter('SELECT COUNT(*) as n FROM kelio_salarie'),
      clockings:          compter('SELECT COUNT(*) as n FROM kelio_badgeage'),
      absenceFiles:       compter('SELECT COUNT(*) as n FROM kelio_absence_fiche'),
      absenceRequests:    compter('SELECT COUNT(*) as n FROM kelio_absence_demande'),
      schedules:          compter('SELECT COUNT(*) as n FROM kelio_horaire_affectation'),
      jobAssignments:     compter('SELECT COUNT(*) as n FROM kelio_affectation_activite'),
      sectionAssignments: compter('SELECT COUNT(*) as n FROM kelio_affectation_service_jour'),
      organization:       compter('SELECT COUNT(*) as n FROM kelio_organigramme'),
      totals:             compter('SELECT COUNT(*) as n FROM kelio_resultat_total'),
      runs:               compter('SELECT COUNT(*) as n FROM kelio_sync_run'),
    };
  }
}

module.exports = ResultRepository;
