'use strict';

/**
 * @file RunRepository.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — HISTORIQUE DES EXTRACTIONS ("RUNS")
 * ============================================================
 *
 * Un "run" représente une exécution d'extraction.
 * Chaque fois qu'on clique "Lancer l'extraction", un run est créé.
 * Il contient : quel module, quelle période, combien de résultats, statut...
 *
 * TABLE GÉRÉE : `kelio_sync_run` (enregistrements de run)
 * TABLE GÉRÉE : `kelio_sync_log` (lignes de log SOAP de chaque run)
 *
 * CYCLE DE VIE D'UN RUN :
 *   1. create()  → statut = 'EN_COURS'
 *   2. finish()  → statut = 'TERMINE' ou 'TERMINE_ERREURS'
 *   3. fail()    → statut = 'ERREUR' (si exception critique)
 *
 * APPELANTS :
 * - ExtractionOrchestrator.js : utilise tous les méthodes
 * - main.js (handler 'history:detail') : utilise getDetail()
 */

class RunRepository {
  /**
   * @param {Database} db - Instance better-sqlite3
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Crée un nouveau run dans l'historique avec le statut 'EN_COURS'.
   * Appelé au début de chaque extraction par ExtractionOrchestrator.run().
   *
   * Le `contextJson` stocke les paramètres complets de l'extraction
   * (module, dates, types de compteurs...) pour consultation ultérieure.
   *
   * @param {string} moduleCode    - Identifiant du module ('clockings', 'totals'...)
   * @param {string} modePeriode   - 'JOUR' | 'MOIS' | null
   * @param {string} dateFrom      - Date de début ou null
   * @param {string} dateTo        - Date de fin ou null
   * @param {Object} contextJson   - Params complets (sera sérialisé en JSON)
   * @returns {number} - L'ID du run créé (lastInsertRowid)
   */
  create(moduleCode, modePeriode, dateFrom, dateTo, contextJson) {
    const maintenant = new Date().toISOString().replace('T', ' ').slice(0, 19);
    this.db.prepare(`
      INSERT INTO kelio_sync_run
        (module_code, mode_periode, date_from, date_to, status, context_json, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'EN_COURS', ?, ?, ?, ?)
    `).run(
      moduleCode,
      modePeriode ?? null,
      dateFrom    ?? null,
      dateTo      ?? null,
      contextJson ? JSON.stringify(contextJson) : null,
      maintenant, maintenant, maintenant
    );
    // Récupérer l'ID inséré via une requête SELECT explicite
    const result = this.db.prepare('SELECT last_insert_rowid() as id').get();
    return result.id;
  }

  /**
   * Marque le run comme terminé et enregistre les statistiques finales.
   * Si des erreurs sont présentes, le statut devient 'TERMINE_ERREURS',
   * sinon 'TERMINE' (succès complet).
   *
   * Appelé par ExtractionOrchestrator après le traitement de tous les employés.
   *
   * @param {number} runId
   * @param {{ok: number, errors: number, total: number}} stats
   */
  finish(runId, { ok, errors, total }) {
    const maintenant = new Date().toISOString().replace('T', ' ').slice(0, 19);
    // Si au moins une erreur : statut 'TERMINE_ERREURS', sinon 'TERMINE'
    const statutFinal = errors > 0 ? 'TERMINE_ERREURS' : 'TERMINE';
    this.db.prepare(`
      UPDATE kelio_sync_run
      SET status = ?, ok_requests = ?, error_requests = ?, total_requests = ?,
          ended_at = ?, updated_at = ?
      WHERE id = ?
    `).run(statutFinal, ok, errors, total, maintenant, maintenant, runId);
  }

  /**
   * Marque le run comme ERREUR suite à une exception critique.
   * Différent de 'TERMINE_ERREURS' : ici l'extraction n'a pas pu se terminer du tout.
   * Le message d'erreur est stocké dans context_json.
   *
   * Appelé par le bloc catch de ExtractionOrchestrator.run().
   *
   * @param {number} runId
   * @param {string} message - Message de l'exception
   */
  fail(runId, message) {
    const maintenant = new Date().toISOString().replace('T', ' ').slice(0, 19);
    this.db.prepare(`
      UPDATE kelio_sync_run
      SET status = 'ERREUR', ended_at = ?, updated_at = ?, context_json = ?
      WHERE id = ?
    `).run(maintenant, maintenant, JSON.stringify({ error: message }), runId);
  }

  /**
   * Retourne les détails complets d'un run : infos + ses logs SOAP.
   * Les logs sont limités à 200 pour ne pas surcharger l'affichage.
   *
   * Appelé par main.js (handler 'history:detail') quand on clique "Détail" dans l'historique.
   *
   * @param {number} runId
   * @returns {{run: Object, logs: Array} | null}
   */
  getDetail(runId) {
    const run = this.db.prepare('SELECT * FROM kelio_sync_run WHERE id = ?').get(runId);
    if (!run) return null; // Run introuvable
    // On récupère les 200 derniers logs de ce run (tri inverse pour avoir les plus récents d'abord)
    const logs = this.db.prepare(
      'SELECT * FROM kelio_sync_log WHERE run_id = ? ORDER BY id DESC LIMIT 200'
    ).all(runId);
    return { run, logs };
  }

  /**
   * Enregistre une ligne de log pour un appel SOAP spécifique.
   * Chaque appel SOAP (par salarié / par service) est loggé ici.
   * Ces logs sont visibles dans la page Historique > Détail du run.
   *
   * Appelé par ExtractionOrchestrator après chaque appel SOAP individuel.
   *
   * @param {number}  runId        - ID du run concerné
   * @param {string}  level        - 'INFO' ou 'ERROR'
   * @param {string}  serviceName  - Nom du service SOAP appelé (ex: 'ClockingService')
   * @param {string}  methodName   - Nom de la méthode SOAP (ex: 'exportClockingsByDate...')
   * @param {string}  employeeKey  - Clé du salarié concerné (null si appel global)
   * @param {boolean} isSuccess    - true si l'appel a réussi
   * @param {string}  errorMessage - Message d'erreur (null si succès)
   * @param {number}  durationMs   - Durée de l'appel en millisecondes
   */
  log(runId, level, serviceName, methodName, employeeKey, isSuccess, errorMessage, durationMs) {
    this.db.prepare(`
      INSERT INTO kelio_sync_log
        (run_id, log_level, service_name, method_name, employee_key, is_success, error_message, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      level,
      serviceName  ?? null,
      methodName   ?? null,
      employeeKey  ?? null,
      isSuccess ? 1 : 0,  // SQLite stocke les booléens sous forme 0/1
      errorMessage ?? null,
      durationMs   ?? null
    );
  }
}

module.exports = RunRepository;
