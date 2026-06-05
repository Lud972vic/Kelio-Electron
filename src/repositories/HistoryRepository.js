'use strict';

/**
 * @file HistoryRepository.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — LECTURE DE L'HISTORIQUE DES RUNS
 * ============================================================
 *
 * Ce repository est dédié à la LECTURE de l'historique des extractions.
 * Il lit la même table `kelio_sync_run` que RunRepository,
 * mais avec une perspective différente : filtrage et pagination pour l'interface.
 *
 * POURQUOI DEUX REPOSITORIES POUR LA MÊME TABLE ?
 * - RunRepository : écriture (création, mise à jour du statut pendant extraction)
 * - HistoryRepository : lecture (affichage dans la page Historique)
 * Cette séparation suit le principe de responsabilité unique (SRP).
 *
 * TABLE GÉRÉE : `kelio_sync_run` (en lecture seule)
 *
 * APPELANTS :
 * - main.js (handler 'history:list') : page Historique
 */

class HistoryRepository {
  /**
   * @param {Database} db - Instance better-sqlite3
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Retourne la liste des runs avec filtres optionnels.
   * Les résultats sont toujours triés du plus récent au plus ancien (ORDER BY id DESC).
   * Par défaut, limité à 200 résultats si aucune limite n'est spécifiée.
   *
   * Appelé par main.js (handler 'history:list') → page Historique.
   *
   * @param {Object} filters
   * @param {string} filters.module_code - Filtre par module ('clockings', 'totals'...)
   * @param {string} filters.status      - Filtre par statut ('TERMINE', 'ERREUR'...)
   * @param {string} filters.date_from   - Filtre : runs créés après cette date
   * @param {number} filters.limit       - Nombre max de résultats (défaut: 200)
   * @param {number} filters.offset      - Décalage pour pagination
   * @returns {Array}
   */
  list(filters = {}) {
    let sql = 'SELECT * FROM kelio_sync_run WHERE 1=1';
    const params = [];

    // Filtre par module (ex: afficher seulement les extractions de badgeages)
    if (filters.module_code) {
      sql += ' AND module_code = ?';
      params.push(filters.module_code);
    }
    // Filtre par statut (ex: afficher seulement les runs en erreur)
    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    // Filtre par date de création (ex: aujourd'hui seulement)
    if (filters.date_from) {
      sql += ' AND created_at >= ?';
      params.push(filters.date_from);
    }

    // Tri du plus récent au plus ancien
    sql += ' ORDER BY id DESC';

    if (filters.limit) {
      sql += ` LIMIT ${parseInt(filters.limit, 10)}`;
      if (filters.offset) sql += ` OFFSET ${parseInt(filters.offset, 10)}`;
    } else {
      sql += ' LIMIT 200'; // Limite de sécurité si aucune limite n'est spécifiée
    }

    return this.db.prepare(sql).all(...params);
  }
}

module.exports = HistoryRepository;
