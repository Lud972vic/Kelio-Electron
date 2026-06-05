'use strict';

/**
 * @file database.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — INITIALISATION ET SCHÉMA SQLITE
 * ============================================================
 *
 * Ce fichier est le coeur de la couche de persistance de l'application.
 * Il gère :
 *   1. L'ouverture du fichier SQLite `kelio.sqlite`
 *   2. La configuration des performances SQLite (WAL, foreign keys)
 *   3. Le système de migrations (création automatique des tables)
 *   4. Le "seed" initial des services Kelio dans le catalogue
 *
 * OÙ EST STOCKÉ LE FICHIER SQLite ?
 * Par défaut (chemin personnalisable dans les Paramètres) :
 *   - Windows : %APPDATA%\kelio-desktop\kelio.sqlite
 *   - macOS   : ~/Library/Application Support/kelio-desktop/kelio.sqlite
 *   - Linux   : ~/.config/kelio-desktop/kelio.sqlite
 * Ce chemin est déterminé par Electron via `app.getPath('userData')`.
 *
 * QU'EST-CE QU'UNE MIGRATION ?
 * Une migration est un ensemble de changements de schéma (CREATE TABLE...)
 * identifié par un numéro de version. Le système vérifie quelle version
 * est appliquée et n'exécute que les migrations manquantes.
 * Ça permet d'évoluer le schéma sans recréer la base de zéro.
 *
 * PRAGMA WAL (Write-Ahead Logging) :
 * Mode d'écriture qui permet des lectures simultanées sans verrouillage.
 * Beaucoup plus performant que le mode journal par défaut pour cette app.
 *
 * APPELANTS :
 * - main.js : appelle initDatabase() au démarrage et getDb() partout
 */

const path     = require('path');
const fs       = require('fs');
const { app }  = require('electron');
const initSqlJs = require('sql.js');

// Variable module-level : une seule connexion SQLite pour toute l'appli
// (pattern Singleton : on ne crée jamais deux connexions en même temps)
let _instanceDb = null; // Instance SQLite brute (sql.js)
let _isSaving = false; // Verrou pour éviter les sauvegardes simultanées
let _saveTimeout = null; // Timer pour le debounce
let _pendingSave = false; // Indicateur de sauvegarde en attente

/**
 * Retourne le chemin absolu du fichier `kelio.sqlite`.
 * Utilise le dossier userData d'Electron (spécifique à chaque utilisateur système).
 * En dehors d'Electron (tests), utilise un dossier local `data/`.
 * Si un chemin personnalisé est défini dans db-path.json, l'utilise à la place.
 *
 * @returns {string} - Chemin absolu vers kelio.sqlite
 */
function getDbPath() {
  // Vérifier si un chemin personnalisé est défini
  const cheminUtilisateur = app
    ? app.getPath('userData')
    : path.join(__dirname, '..', 'data');
  
  const dbPathFile = path.join(cheminUtilisateur, 'db-path.json');
  
  if (fs.existsSync(dbPathFile)) {
    try {
      const customPath = JSON.parse(fs.readFileSync(dbPathFile, 'utf8')).dbPath;
      if (customPath && typeof customPath === 'string') {
        return customPath;
      }
    } catch (e) {
      // Erreur de lecture, utiliser le chemin par défaut
    }
  }
  
  return path.join(cheminUtilisateur, 'kelio.sqlite');
}

/**
 * Initialise la connexion SQLite et applique les migrations.
 * À appeler UNE SEULE FOIS au démarrage de l'application (dans main.js).
 *
 * @returns {Database} - L'instance SQLite active
 */
async function initDatabase() {
  const cheminFichier = getDbPath();
  const SQL = await initSqlJs();
  
  // Crée le dossier si nécessaire
  const dossier = path.dirname(cheminFichier);
  if (!fs.existsSync(dossier)) {
    fs.mkdirSync(dossier, { recursive: true });
  }
  
  // Charge la base de données existante ou en crée une nouvelle
  let dbBuffer;
  if (fs.existsSync(cheminFichier)) {
    dbBuffer = fs.readFileSync(cheminFichier);
  }
  
  _instanceDb = new SQL.Database(dbBuffer);
  
  // Configure PRAGMAS
  _instanceDb.run('PRAGMA foreign_keys = ON');
  _instanceDb.run('PRAGMA synchronous = NORMAL');
  
  // Passe le wrapper à runMigrations
  const dbWrapper = createBetterSqlite3Wrapper(_instanceDb);
  runMigrations(dbWrapper);
  
  // Sauvegarde la base après les migrations
  saveDatabase();
  
  return _instanceDb;
}

/**
 * Retourne l'instance SQLite existante.
 * Lance une erreur si initDatabase() n'a pas encore été appelée.
 *
 * Utilisé partout dans main.js pour accéder à la base :
 *   const db = getDb();
 *
 * @returns {Database}
 * @throws {Error} si la base n'est pas initialisée
 */
function getDb() {
  if (!_instanceDb) {
    throw new Error('Base de données non initialisée. Appelez initDatabase() d\'abord.');
  }
  // Wrapper qui imite l'API de better-sqlite3
  return createBetterSqlite3Wrapper(_instanceDb);
}

/**
 * Retourne l'instance SQLite brute (sql.js) sans wrapper.
 * Utilisé pour les requêtes SQL personnalisées qui ont besoin de l'API sql.js native.
 * @returns {Database} - L'instance SQLite brute (sql.js)
 */
function getDbRaw() {
  if (!_instanceDb) {
    throw new Error('Base de données non initialisée. Appelez initDatabase() d\'abord.');
  }
  return _instanceDb;
}

function saveDatabase() {
  if (!_instanceDb) return;
  
  // Si une sauvegarde est en cours, marquer comme sauvegarde en attente
  if (_isSaving) {
    _pendingSave = true;
    return;
  }
  
  _isSaving = true;
  
  try {
    const data = _instanceDb.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(getDbPath(), buffer);
  } catch (error) {
    console.error('Erreur de sauvegarde de la base:', error);
  } finally {
    _isSaving = false;
    
    // Si une sauvegarde était en attente, la lancer après un court délai
    if (_pendingSave) {
      _pendingSave = false;
      setTimeout(() => saveDatabase(), 100);
    }
  }
}

// Fonction utilitaire pour convertir les paramètres nommés en paramètres positionnels
function convertNamedParams(sql, params) {
  if (!params || typeof params !== 'object') {
    return { sql, params: [params].filter(p => p !== undefined).map(p => p === undefined ? null : p) };
  }

  // Trouver tous les paramètres nommés dans l'ordre
  const paramNames = [];
  const regex = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    if (!paramNames.includes(match[1])) {
      paramNames.push(match[1]);
    }
  }

  // Remplacer les paramètres nommés par des ?
  let newSql = sql;
  paramNames.forEach(name => {
    newSql = newSql.replace(new RegExp(`:${name}`, 'g'), '?');
  });

  // Créer le tableau de valeurs dans l'ordre
  const newParams = paramNames.map(name => {
    const value = params[name];
    return value === undefined ? null : value;
  });

  return { sql: newSql, params: newParams };
}

// Wrapper pour imiter l'API de better-sqlite3
function createBetterSqlite3Wrapper(db) {
  // Fonction de debounce pour la sauvegarde
  const debouncedSave = () => {
    if (_saveTimeout) {
      clearTimeout(_saveTimeout);
    }
    _saveTimeout = setTimeout(() => {
      saveDatabase();
    }, 500); // Sauvegarder après 500ms sans nouvelles écritures
  };
  
  return {
    exec: (sql) => {
      db.run(sql);
      debouncedSave();
    },
    prepare: (sql) => {
      return {
        run: (...params) => {
          // Si le premier paramètre est un objet, convertir les paramètres nommés
          let finalSql = sql;
          let finalParams = params;
          if (params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])) {
            const converted = convertNamedParams(sql, params[0]);
            finalSql = converted.sql;
            finalParams = converted.params;
          } else {
            finalParams = params.map(p => p === undefined ? null : p);
          }
          
          const stmt = db.prepare(finalSql);
          stmt.bind(finalParams);
          stmt.step();
          stmt.free();
          debouncedSave();
          // sql.js ne fournit pas lastInsertRowid de manière fiable
          // Les appelants doivent utiliser SELECT last_insert_rowid() explicitement si nécessaire
          return { changes: db.getRowsModified() };
        },
        get: (...params) => {
          // Si le premier paramètre est un objet, convertir les paramètres nommés
          let finalSql = sql;
          let finalParams = params;
          if (params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])) {
            const converted = convertNamedParams(sql, params[0]);
            finalSql = converted.sql;
            finalParams = converted.params;
          } else {
            finalParams = params.map(p => p === undefined ? null : p);
          }
          
          const stmt = db.prepare(finalSql);
          stmt.bind(finalParams);
          stmt.step();
          const result = stmt.getAsObject();
          stmt.free();
          
          // Si le résultat est vide ou undefined, retourner undefined
          if (!result || Object.keys(result).length === 0) {
            return undefined;
          }
          
          return result;
        },
        all: (...params) => {
          // Si le premier paramètre est un objet, convertir les paramètres nommés
          let finalSql = sql;
          let finalParams = params;
          if (params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])) {
            const converted = convertNamedParams(sql, params[0]);
            finalSql = converted.sql;
            finalParams = converted.params;
          } else {
            finalParams = params.map(p => p === undefined ? null : p);
          }
          
          const stmt = db.prepare(finalSql);
          stmt.bind(finalParams);
          const results = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        }
      };
    },
    pragma: (pragma) => {
      db.run(`PRAGMA ${pragma}`);
    },
    transaction: (fn) => {
      // sql.js ne gère pas bien les transactions, on retourne une fonction qui exécute fn directement
      // better-sqlite3: db.transaction(fn) retourne une fonction qui peut être appelée avec des arguments
      const wrappedFn = (...args) => {
        try {
          fn(...args);
        } catch (error) {
          console.error('Erreur dans transaction:', error);
          throw error;
        }
        debouncedSave();
      };
      // Simuler le comportement de better-sqlite3 : transaction(fn) retourne une fonction
      return wrappedFn;
    }
  };
}

// ===========================================================================
// SYSTÈME DE MIGRATIONS
// ===========================================================================

/**
 * Exécute les migrations manquantes pour mettre le schéma à jour.
 *
 * PRINCIPE DE FONCTIONNEMENT :
 *   1. On s'assure que la table `kelio_schema_version` existe
 *   2. On lit la version actuelle (la plus haute appliquée)
 *   3. Pour chaque version manquante, on applique la migration correspondante
 *   4. On enregistre la nouvelle version dans `kelio_schema_version`
 *
 * Pour ajouter une migration future :
 *   if (versionActuelle < 2) {
 *     applyMigration2(db);
 *     db.prepare('INSERT INTO kelio_schema_version (version) VALUES (2)').run();
 *   }
 *
 * @param {Database} db
 */
function runMigrations(db) {
  // Cette table garde trace des migrations appliquées
  db.exec(`
    CREATE TABLE IF NOT EXISTS kelio_schema_version (
      version    INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // MAX(version) retourne NULL si la table est vide → on utilise ?? 0
  const versionActuelle = db.prepare(
    'SELECT MAX(version) as v FROM kelio_schema_version'
  ).get()?.v ?? 0;

  // Application des migrations dans l'ordre
  if (versionActuelle < 1) {
    applyMigration1(db); // Crée toutes les tables de base
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (1)').run();
  }
  if (versionActuelle < 2) {
    applyMigration2(db); // Ajoute les colonnes manquantes (file_key, type_abbreviation, comment)
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (2)').run();
  }
  if (versionActuelle < 3) {
    applyMigration3(db); // Ajoute toutes les colonnes de l'organigramme Kelio
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (3)').run();
  }
  if (versionActuelle < 4) {
    applyMigration4(db); // Ajoute toutes les colonnes des salariés Kelio
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (4)').run();
  }
  if (versionActuelle < 5) {
    applyMigration5(db); // Ajoute la contrainte UNIQUE sur employee_key
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (5)').run();
  }
  if (versionActuelle < 6) {
    applyMigration6(db); // Ajoute les colonnes manquantes pour les badgeages
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (6)').run();
  }
  if (versionActuelle < 7) {
    applyMigration7(db); // Ajoute les colonnes manquantes pour les fiches d'absence
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (7)').run();
  }
  if (versionActuelle < 8) {
    applyMigration8(db); // Migration vide (fusionnée avec 7)
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (8)').run();
  }
  if (versionActuelle < 9) {
    applyMigration9(db); // Ajoute les colonnes manquantes pour les demandes d'absence
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (9)').run();
  }
  if (versionActuelle < 10) {
    applyMigration10(db); // Ajoute les colonnes manquantes pour les horaires/périodes de travail
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (10)').run();
  }
  if (versionActuelle < 11) {
    applyMigration11(db); // Ajoute les colonnes manquantes pour les affectations activité
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (11)').run();
  }
  if (versionActuelle < 12) {
    applyMigration12(db); // Ajoute section_key à kelio_salarie
    db.prepare('INSERT INTO kelio_schema_version (version) VALUES (12)').run();
  }
  // Si de nouvelles migrations sont ajoutées dans le futur :
  // if (versionActuelle < 13) { applyMigration13(db); ... }
}

/**
 * Migration 1 — création du schéma initial.
 * Crée toutes les tables nécessaires à l'application.
 * Exécutée UNE SEULE FOIS au premier lancement.
 *
 * TABLES CRÉÉES :
 *   - kelio_param                    : configuration de connexion
 *   - kelio_ws_catalogue             : catalogue des services SOAP disponibles
 *   - kelio_sync_run                 : historique des extractions (runs)
 *   - kelio_sync_log                 : logs détaillés par run
 *   - kelio_salarie                  : salariés importés
 *   - kelio_organigramme             : niveaux d'organigramme
 *   - kelio_badgeage                 : badgeages (pointages)
 *   - kelio_absence_fiche            : fiches d'absence validées
 *   - kelio_absence_demande          : demandes d'absence
 *   - kelio_horaire_affectation      : affectations d'horaires par jour
 *   - kelio_affectation_activite     : activités (job assignments)
 *   - kelio_affectation_service_jour : services jour/jour
 *   - kelio_resultat_compteur_type   : catalogue des types de compteurs
 *   - kelio_resultat_total           : valeurs des compteurs (table principale)
 *
 * @param {Database} db
 */
function applyMigration1(db) {
  db.exec(`

    -- Paramètres de connexion (clé/valeur)
    CREATE TABLE IF NOT EXISTS kelio_param (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      param_key   TEXT    NOT NULL UNIQUE,
      param_value TEXT,
      is_sensitive INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Catalogue des webservices SOAP disponibles et actifs
    -- Sert de référence pour savoir quels services appeler
    CREATE TABLE IF NOT EXISTS kelio_ws_catalogue (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name        TEXT NOT NULL,
      method_name         TEXT NOT NULL,
      account_type        TEXT,
      mode_resultat       TEXT,
      is_active           INTEGER NOT NULL DEFAULT 1,
      supports_day_mode   INTEGER NOT NULL DEFAULT 1,
      supports_month_mode INTEGER NOT NULL DEFAULT 1,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (service_name, method_name)
    );

    -- Historique des extractions ("runs")
    -- Un run = une exécution complète d'extraction
    CREATE TABLE IF NOT EXISTS kelio_sync_run (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      module_code     TEXT NOT NULL,
      mode_periode    TEXT,
      date_from       TEXT,
      date_to         TEXT,
      status          TEXT NOT NULL DEFAULT 'EN_COURS',
      total_requests  INTEGER NOT NULL DEFAULT 0,
      ok_requests     INTEGER NOT NULL DEFAULT 0,
      error_requests  INTEGER NOT NULL DEFAULT 0,
      context_json    TEXT,
      started_at      TEXT,
      ended_at        TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_run_module  ON kelio_sync_run(module_code);
    CREATE INDEX IF NOT EXISTS idx_run_status  ON kelio_sync_run(status);

    -- Logs détaillés par appel SOAP dans un run
    -- Un run peut avoir N logs (un par salarié par service)
    CREATE TABLE IF NOT EXISTS kelio_sync_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        INTEGER,
      log_level     TEXT NOT NULL DEFAULT 'INFO',
      service_name  TEXT,
      method_name   TEXT,
      employee_key  TEXT,
      duration_ms   INTEGER,
      is_success    INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
    CREATE INDEX IF NOT EXISTS idx_log_run     ON kelio_sync_log(run_id);
    CREATE INDEX IF NOT EXISTS idx_log_created ON kelio_sync_log(created_at);

    -- Salariés importés depuis LightEmployeeService
    -- employee_key est UNIQUE : pas de doublons même après plusieurs extractions
    CREATE TABLE IF NOT EXISTS kelio_salarie (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                    INTEGER,
      employee_key              TEXT NOT NULL UNIQUE,
      identification_number     TEXT,
      identification_code       TEXT,
      badge_code                TEXT,
      surname                   TEXT,
      first_name                TEXT,
      email                     TEXT,
      archived_employee         INTEGER NOT NULL DEFAULT 0,
      section_key               TEXT,
      section_description       TEXT,
      start_date                TEXT,
      end_date                  TEXT,
      imported_at               TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sal_run     ON kelio_salarie(run_id);
    CREATE INDEX IF NOT EXISTS idx_sal_section ON kelio_salarie(section_key);

    -- Organigramme
    CREATE TABLE IF NOT EXISTS kelio_organigramme (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER,
      level_key         TEXT NOT NULL UNIQUE,
      parent_level_key  TEXT,
      code              TEXT,
      description       TEXT,
      population_code   TEXT,
      start_date        TEXT,
      end_date          TEXT,
      is_active         INTEGER NOT NULL DEFAULT 1,
      imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );

    -- Badgeages
    CREATE TABLE IF NOT EXISTS kelio_badgeage (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER,
      employee_key      TEXT NOT NULL,
      clocking_date     TEXT NOT NULL,
      clocking_datetime TEXT,
      direction_code    TEXT,
      terminal_code     TEXT,
      reader_code       TEXT,
      badge_code        TEXT,
      imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
    CREATE INDEX IF NOT EXISTS idx_badge_emp_date ON kelio_badgeage(employee_key, clocking_date);

    -- Fiches d'absence
    CREATE TABLE IF NOT EXISTS kelio_absence_fiche (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER,
      employee_key      TEXT NOT NULL,
      file_key          TEXT,
      type_key          TEXT,
      type_abbreviation TEXT,
      type_description  TEXT,
      start_date        TEXT NOT NULL,
      end_date          TEXT NOT NULL,
      duration_days     REAL,
      status_code       TEXT,
      imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
    CREATE INDEX IF NOT EXISTS idx_abs_fiche_emp ON kelio_absence_fiche(employee_key, start_date);

    -- Demandes d'absence
    CREATE TABLE IF NOT EXISTS kelio_absence_demande (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER,
      employee_key      TEXT NOT NULL,
      request_key       TEXT,
      type_key          TEXT,
      type_description  TEXT,
      start_date        TEXT NOT NULL,
      end_date          TEXT NOT NULL,
      duration_days     REAL,
      status_code       TEXT,
      imported_at       TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );

    -- Horaires / affectations
    CREATE TABLE IF NOT EXISTS kelio_horaire_affectation (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id               INTEGER,
      employee_key         TEXT NOT NULL,
      schedule_key         TEXT,
      schedule_code        TEXT,
      schedule_description TEXT,
      start_date           TEXT NOT NULL,
      end_date             TEXT,
      imported_at          TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );

    -- Affectations activité
    CREATE TABLE IF NOT EXISTS kelio_affectation_activite (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                      INTEGER,
      employee_key                TEXT NOT NULL,
      job_key                     TEXT,
      job_code                    TEXT,
      job_description             TEXT,
      assignment_date             TEXT NOT NULL,
      employee_badge_code          TEXT,
      employee_first_name          TEXT,
      employee_identification_code TEXT,
      employee_identification_number TEXT,
      employee_surname            TEXT,
      archived_employee            INTEGER,
      error_message               TEXT,
      technical_string            TEXT,
      imported_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );

    -- Affectations service jour
    CREATE TABLE IF NOT EXISTS kelio_affectation_service_jour (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id              INTEGER,
      employee_key        TEXT NOT NULL,
      section_key         TEXT,
      section_code        TEXT,
      section_description TEXT,
      assignment_date     TEXT NOT NULL,
      comment             TEXT,
      imported_at         TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );

    -- Types de compteurs
    CREATE TABLE IF NOT EXISTS kelio_resultat_compteur_type (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      account_type          TEXT NOT NULL,
      service_name          TEXT NOT NULL,
      type_key              TEXT NOT NULL,
      type_abbreviation     TEXT,
      type_description      TEXT,
      unit_code             INTEGER,
      imported_at           TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (account_type, type_key)
    );

    -- Résultats totaux (compteurs)
    CREATE TABLE IF NOT EXISTS kelio_resultat_total (
      id                           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                       INTEGER NOT NULL,
      mode_periode                 TEXT NOT NULL,
      employee_key                 TEXT,
      employee_identification_number TEXT,
      employee_surname             TEXT,
      employee_first_name          TEXT,
      archived_employee            INTEGER NOT NULL DEFAULT 0,
      section_key                  TEXT,
      section_description          TEXT,
      account_type                 TEXT,
      service_name                 TEXT,
      type_key                     TEXT,
      type_abbreviation            TEXT,
      type_description             TEXT,
      start_date                   TEXT,
      end_date                     TEXT,
      result_date                  TEXT,
      hours                        REAL,
      physical_hours               REAL,
      days                         REAL,
      number_value                 REAL,
      value_canonical              REAL,
      imported_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
    CREATE INDEX IF NOT EXISTS idx_total_run       ON kelio_resultat_total(run_id);
    CREATE INDEX IF NOT EXISTS idx_total_emp_date  ON kelio_resultat_total(employee_key, result_date);
    CREATE INDEX IF NOT EXISTS idx_total_type      ON kelio_resultat_total(type_key);

  `);

  // Seed du catalogue webservices : on pré-remplit la table avec tous les services connus.
  // INSERT OR IGNORE : si la ligne existe déjà (déjà seedé), on ne l'insère pas de nouveau.
  const insertWs = db.prepare(`
    INSERT OR IGNORE INTO kelio_ws_catalogue
      (service_name, method_name, account_type, mode_resultat, supports_day_mode, supports_month_mode)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Chaque ligne : [nomService, nomMethode, typeCompteur, typeRésultat, supportJour, supportMois]
  const services = [
    ['OrganizationChartLevelService', 'exportOrganizationChartLevels', null, null, 1, 0],
    ['LightEmployeeService',          'exportEmployees',               null, null, 1, 1],
    ['ClockingService',               'exportClockings',               null, null, 1, 1],
    ['AbsenceFileService',            'exportAbsenceFiles',            null, null, 1, 1],
    ['AbsenceRequestService',         'exportAbsenceRequests',         null, null, 1, 1],
    ['DailyScheduleAssignmentService','exportDailyScheduleAssignments',null, null, 1, 1],
    ['JobAssignmentService',          'exportComputedJobAssignmentsList',null,null,1, 1],
    ['SectionAssignmentDayPerDayService','exportSectionAssignmentsDayPerDayList',null,null,1,1],
    ['TypeService',                   'exportGenericTypes',            null, 'TYPE',  1, 1],
    ['AccountTotalService',           'exportTotals', 'ACCOUNT',              'TOTAL', 1, 1],
    ['LatenessEarlyDepartureTotalService','exportTotals','LATENESS_EARLY_DEPARTURE','TOTAL',1,1],
    ['BalanceTotalService',           'exportTotals', 'BALANCE',              'TOTAL', 1, 1],
    ['AbsenceTotalService',           'exportTotals', 'ABSENCE',              'TOTAL', 1, 1],
    ['AbsenceBalanceTotalService',    'exportTotals', 'ABSENCE_BALANCE',      'TOTAL', 1, 1],
    ['OvertimeHourTotalService',      'exportTotals', 'OVERTIME_HOUR',        'TOTAL', 1, 1],
    ['SpecialHourTotalService',       'exportTotals', 'SPECIAL_HOUR',         'TOTAL', 1, 1],
    ['BonusTotalService',             'exportTotals', 'BONUS',                'TOTAL', 1, 1],
    ['OnCallDutyTotalService',        'exportTotals', 'ON_CALL_DUTY',         'TOTAL', 1, 1],
    ['JobTotalService',               'exportTotals', 'JOB',                  'TOTAL', 1, 1],
  ];
  // Transaction unique pour insérer tous les services en une opération atomique
  const seedWs = db.transaction(() => {
    for (const s of services) insertWs.run(...s);
  });
  seedWs();
}

/**
 * Migration 2 — ajout des colonnes manquantes extraites du SOAP.
 * Exécutée automatiquement si la base est en version 1.
 *
 * COLONNES AJOUTÉES :
 *   - kelio_absence_fiche.file_key          : clé de la fiche d'absence
 *   - kelio_absence_fiche.type_abbreviation : code abrégé du type d'absence
 *   - kelio_affectation_service_jour.comment: commentaire sur l'affectation
 *
 * @param {Database} db
 */
function applyMigration2(db) {
  // Ajout des colonnes manquantes dans kelio_absence_fiche
  try {
    db.exec(`ALTER TABLE kelio_absence_fiche ADD COLUMN file_key TEXT`);
  } catch (e) { /* colonne existe déjà */ }
  try {
    db.exec(`ALTER TABLE kelio_absence_fiche ADD COLUMN type_abbreviation TEXT`);
  } catch (e) { /* colonne existe déjà */ }

  // Ajout de la colonne comment dans kelio_affectation_service_jour
  try {
    db.exec(`ALTER TABLE kelio_affectation_service_jour ADD COLUMN comment TEXT`);
  } catch (e) { /* colonne existe déjà */ }
}

/**
 * Migration 3 — ajout de toutes les colonnes de l'organigramme Kelio.
 * La table kelio_organigramme est entièrement refondue pour correspondre
 * à la documentation Kelio (https://kelio.help.kelio.io/V5.2E19/fr-FR/webservices/organigramme.html)
 *
 * On recrée la table avec le nouveau schéma complet.
 */
function applyMigration3(db) {
  // Sauvegarde des données existantes
  const existingData = db.prepare('SELECT * FROM kelio_organigramme').all();

  // Suppression de l'ancienne table
  db.exec('DROP TABLE IF EXISTS kelio_organigramme');

  // Création de la nouvelle table avec toutes les colonnes Kelio
  db.exec(`
    CREATE TABLE kelio_organigramme (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,

      -- Niveau d'organigramme
      organization_chart_level_key TEXT,
      organization_chart_level_abbreviation TEXT,
      organization_chart_level_description TEXT,
      organization_chart_level_description_type TEXT,
      level_type TEXT,
      manager TEXT,
      full_abbreviation TEXT,
      full_description TEXT,
      levels TEXT,
      technical_string TEXT,

      -- Service
      section_key TEXT,
      section_abbreviation TEXT,
      section_description TEXT,
      section_manager TEXT,

      -- Département
      department_key TEXT,
      department_abbreviation TEXT,
      department_description TEXT,
      department_manager TEXT,

      -- Sous-département
      sub_department_key TEXT,
      sub_department_abbreviation TEXT,
      sub_department_description TEXT,
      sub_department_manager TEXT,

      -- Société
      firm_key TEXT,
      firm_abbreviation TEXT,
      firm_description TEXT,
      firm_manager TEXT,

      -- Niveaux 4 à 8
      level4_key TEXT,
      level4_abbreviation TEXT,
      level4_description TEXT,
      level4_manager TEXT,

      level5_key TEXT,
      level5_abbreviation TEXT,
      level5_description TEXT,
      level5_manager TEXT,

      level6_key TEXT,
      level6_abbreviation TEXT,
      level6_description TEXT,
      level6_manager TEXT,

      level7_key TEXT,
      level7_abbreviation TEXT,
      level7_description TEXT,
      level7_manager TEXT,

      level8_key TEXT,
      level8_abbreviation TEXT,
      level8_description TEXT,
      level8_manager TEXT,

      -- Entreprise
      company_key TEXT,
      company_description TEXT,
      company_phone_number TEXT,
      company_fax_number TEXT,
      company_mail_address TEXT,
      company_web_address TEXT,
      company_file_number TEXT,

      -- Erreur
      error_message TEXT,

      -- Métadonnées
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
  `);

  // Création d'index pour les recherches courantes
  db.exec('CREATE INDEX IF NOT EXISTS idx_orga_level_key ON kelio_organigramme(organization_chart_level_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orga_section_key ON kelio_organigramme(section_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orga_firm_key ON kelio_organigramme(firm_key)');
}

/**
 * Migration 4 — ajout de toutes les colonnes des salariés Kelio.
 * La table kelio_salarie est entièrement refondue pour correspondre
 * à la documentation Kelio (https://kelio.help.kelio.io/V5.2E19/fr-FR/webservices/salaries.html)
 */
function applyMigration4(db) {
  // Sauvegarde des données existantes
  const existingData = db.prepare('SELECT * FROM kelio_salarie').all();

  // Suppression de l'ancienne table
  db.exec('DROP TABLE IF EXISTS kelio_salarie');

  // Création de la nouvelle table avec toutes les colonnes Kelio
  db.exec(`
    CREATE TABLE kelio_salarie (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,

      -- Identifiants salarié
      employee_key TEXT UNIQUE,
      employee_identification_number TEXT,
      employee_identification_code TEXT,
      employee_badge_code TEXT,
      employee_surname TEXT,
      employee_first_name TEXT,
      archived_employee INTEGER NOT NULL DEFAULT 0,

      -- Dates de prise en compte
      taken_into_account_start_date TEXT,
      taken_into_account_end_date TEXT,
      taken_into_account_period_start_date TEXT,
      taken_into_account_period_end_date TEXT,

      -- Données par défaut
      default_employee_badge TEXT,
      default_employee_first_name TEXT,
      default_employee_identification_code TEXT,
      default_employee_identification_number TEXT,
      default_employee_surname TEXT,

      -- Autorisations d'accès pour l'affectation en cours
      current_access_authorization_start_date TEXT,
      current_access_authorization_start_time TEXT,
      current_access_authorization_end_date TEXT,
      current_access_authorization_end_time TEXT,

      -- Flags et options
      generate_badge INTEGER NOT NULL DEFAULT 0,
      is_access_module_employee INTEGER NOT NULL DEFAULT 0,
      is_tanda_module_employee INTEGER NOT NULL DEFAULT 0,
      search_using_badge INTEGER NOT NULL DEFAULT 0,
      search_using_firstname INTEGER NOT NULL DEFAULT 0,
      search_using_identification_number INTEGER NOT NULL DEFAULT 0,
      search_using_surname INTEGER NOT NULL DEFAULT 0,

      -- Filtres population
      population_filter TEXT,
      group_filter TEXT,
      population_mode TEXT,
      population_start_date TEXT,
      population_end_date TEXT,

      -- Erreur et clé technique
      error_message TEXT,
      technical_string TEXT,

      -- Profil exploitant
      use_default_model_employee INTEGER NOT NULL DEFAULT 0,
      user_profile_assignment_wizard_description TEXT,
      user_profile_assignment_wizard_key TEXT,

      -- Métadonnées
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
  `);

  // Création d'index pour les recherches courantes
  db.exec('CREATE INDEX IF NOT EXISTS idx_sal_employee_key ON kelio_salarie(employee_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sal_identification_number ON kelio_salarie(employee_identification_number)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sal_badge_code ON kelio_salarie(employee_badge_code)');
}

/**
 * Migration 5 — ajout de la contrainte UNIQUE sur employee_key.
 * Corrige l'erreur "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
 * qui survenait lors de l'upsert des salariés.
 */
function applyMigration5(db) {
  // SQLite ne permet pas d'ajouter une contrainte UNIQUE directement sur une colonne existante.
  // On doit recréer la table avec la contrainte.
  const existingData = db.prepare('SELECT * FROM kelio_salarie').all();
  db.exec('DROP TABLE IF EXISTS kelio_salarie');
  
  db.exec(`
    CREATE TABLE kelio_salarie (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,

      -- Identifiants salarié
      employee_key TEXT UNIQUE,
      employee_identification_number TEXT,
      employee_identification_code TEXT,
      employee_badge_code TEXT,
      employee_surname TEXT,
      employee_first_name TEXT,
      archived_employee INTEGER NOT NULL DEFAULT 0,

      -- Dates de prise en compte
      taken_into_account_start_date TEXT,
      taken_into_account_end_date TEXT,
      taken_into_account_period_start_date TEXT,
      taken_into_account_period_end_date TEXT,

      -- Données par défaut
      default_employee_badge TEXT,
      default_employee_first_name TEXT,
      default_employee_identification_code TEXT,
      default_employee_identification_number TEXT,
      default_employee_surname TEXT,

      -- Autorisations d'accès pour l'affectation en cours
      current_access_authorization_start_date TEXT,
      current_access_authorization_start_time TEXT,
      current_access_authorization_end_date TEXT,
      current_access_authorization_end_time TEXT,

      -- Flags et options
      generate_badge INTEGER NOT NULL DEFAULT 0,
      is_access_module_employee INTEGER NOT NULL DEFAULT 0,
      is_tanda_module_employee INTEGER NOT NULL DEFAULT 0,
      search_using_badge INTEGER NOT NULL DEFAULT 0,
      search_using_firstname INTEGER NOT NULL DEFAULT 0,
      search_using_identification_number INTEGER NOT NULL DEFAULT 0,
      search_using_surname INTEGER NOT NULL DEFAULT 0,

      -- Filtres population
      population_filter TEXT,
      group_filter TEXT,
      population_mode TEXT,
      population_start_date TEXT,
      population_end_date TEXT,

      -- Erreur et clé technique
      error_message TEXT,
      technical_string TEXT,

      -- Profil exploitant
      use_default_model_employee INTEGER NOT NULL DEFAULT 0,
      user_profile_assignment_wizard_description TEXT,
      user_profile_assignment_wizard_key TEXT,

      -- Métadonnées
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),

      FOREIGN KEY (run_id) REFERENCES kelio_sync_run(id)
    );
  `);

  // Création d'index pour les recherches courantes
  db.exec('CREATE INDEX IF NOT EXISTS idx_sal_employee_key ON kelio_salarie(employee_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sal_identification_number ON kelio_salarie(employee_identification_number)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sal_badge_code ON kelio_salarie(employee_badge_code)');
}

/**
 * Migration 9 — ajout des colonnes manquantes pour les demandes d'absence.
 * Ajoute les colonnes de la documentation Kelio qui manquaient :
 * - absenceFileKey, absenceTypeAbbreviation, archivedEmployee, comment, creationDate, durationInHours
 * - employeeBadgeCode, employeeFirstName, employeeIdentificationCode, employeeIdentificationNumber, employeeKey, employeeSurname
 * - endingTheAfternoon, errorMessage, firstEndTime, firstEndTimePosition, firstStartTime, firstStartTimePosition
 * - lastModificationDate, requestType, secondEndTime, secondEndTimePosition, secondStartTime, secondStartTimePosition
 * - splitHolidaysWaiver, startInTheMorning, technicalString, totalInDays, totalInHours
 * - validatorsBadgeCodes, validatorsFirstNames, validatorsIdentificationCode, validatorsIdentificationNumbers, validatorsKeys, validatorsLogins, validatorsSurnames
 */
function applyMigration9(db) {
  // Vérifier si les colonnes existent déjà pour éviter les erreurs
  const columns = db.prepare("PRAGMA table_info(kelio_absence_demande)").all();
  const columnNames = columns.map(c => c.name);

  const newColumns = [
    { name: 'absence_file_key', type: 'TEXT' },
    { name: 'absence_type_abbreviation', type: 'TEXT' },
    { name: 'archived_employee', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'comment', type: 'TEXT' },
    { name: 'creation_date', type: 'TEXT' },
    { name: 'duration_in_hours', type: 'TEXT' },
    { name: 'employee_badge_code', type: 'TEXT' },
    { name: 'employee_first_name', type: 'TEXT' },
    { name: 'employee_identification_code', type: 'TEXT' },
    { name: 'employee_identification_number', type: 'TEXT' },
    { name: 'employee_surname', type: 'TEXT' },
    { name: 'ending_the_afternoon', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'first_end_time', type: 'TEXT' },
    { name: 'first_end_time_position', type: 'TEXT' },
    { name: 'first_start_time', type: 'TEXT' },
    { name: 'first_start_time_position', type: 'TEXT' },
    { name: 'last_modification_date', type: 'TEXT' },
    { name: 'request_type', type: 'TEXT' },
    { name: 'second_end_time', type: 'TEXT' },
    { name: 'second_end_time_position', type: 'TEXT' },
    { name: 'second_start_time', type: 'TEXT' },
    { name: 'second_start_time_position', type: 'TEXT' },
    { name: 'split_holidays_waiver', type: 'TEXT' },
    { name: 'start_in_the_morning', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'technical_string', type: 'TEXT' },
    { name: 'total_in_days', type: 'TEXT' },
    { name: 'total_in_hours', type: 'TEXT' },
    { name: 'validators_badge_codes', type: 'TEXT' },
    { name: 'validators_first_names', type: 'TEXT' },
    { name: 'validators_identification_code', type: 'TEXT' },
    { name: 'validators_identification_numbers', type: 'TEXT' },
    { name: 'validators_keys', type: 'TEXT' },
    { name: 'validators_logins', type: 'TEXT' },
    { name: 'validators_surnames', type: 'TEXT' },
  ];

  for (const col of newColumns) {
    if (!columnNames.includes(col.name)) {
      db.exec(`ALTER TABLE kelio_absence_demande ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

/**
 * Migration 10 — ajout des colonnes manquantes pour les horaires/périodes de travail.
 * Ajoute les colonnes de la documentation Kelio qui manquaient :
 * - afternoonContractedTime, archivedEmployee, assignementByException, calculationModeContractedSchedule, comment, contractedTime
 * - employeeBadgeCode, employeeFirstName, employeeIdentificationCode, employeeIdentificationNumber, employeeKey, employeeSurname
 * - errorMessage, fifthWorkingPeriodEndTime, fifthWorkingPeriodEndTimePosition, fifthWorkingPeriodStartTime, fifthWorkingPeriodStartTimePosition
 * - firstWorkingPeriodEndTime, firstWorkingPeriodEndTimePosition, firstWorkingPeriodStartTime, firstWorkingPeriodStartTimePosition
 * - fourthWorkingPeriodEndTime, fourthWorkingPeriodEndTimePosition, fourthWorkingPeriodStartTime, fourthWorkingPeriodStartTimePosition
 * - halfDayTime, morningContractedTime, nightStartTime, nightStartTimePosition
 * - secondWorkingPeriodEndTime, secondWorkingPeriodEndTimePosition, secondWorkingPeriodStartTime, secondWorkingPeriodStartTimePosition
 * - technicalString, thirdWorkingPeriodEndTime, thirdWorkingPeriodEndTimePosition, thirdWorkingPeriodStartTime, thirdWorkingPeriodStartTimePosition
 */
function applyMigration10(db) {
  // Vérifier si les colonnes existent déjà pour éviter les erreurs
  const columns = db.prepare("PRAGMA table_info(kelio_horaire_affectation)").all();
  const columnNames = columns.map(c => c.name);

  const newColumns = [
    { name: 'schedule_abbreviation', type: 'TEXT' },
    { name: 'afternoon_contracted_time', type: 'TEXT' },
    { name: 'archived_employee', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'assignement_by_exception', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'calculation_mode_contracted_schedule', type: 'TEXT' },
    { name: 'comment', type: 'TEXT' },
    { name: 'contracted_time', type: 'TEXT' },
    { name: 'employee_badge_code', type: 'TEXT' },
    { name: 'employee_first_name', type: 'TEXT' },
    { name: 'employee_identification_code', type: 'TEXT' },
    { name: 'employee_identification_number', type: 'TEXT' },
    { name: 'employee_key', type: 'TEXT' },
    { name: 'employee_surname', type: 'TEXT' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'fifth_working_period_end_time', type: 'TEXT' },
    { name: 'fifth_working_period_end_time_position', type: 'TEXT' },
    { name: 'fifth_working_period_start_time', type: 'TEXT' },
    { name: 'fifth_working_period_start_time_position', type: 'TEXT' },
    { name: 'first_working_period_end_time', type: 'TEXT' },
    { name: 'first_working_period_end_time_position', type: 'TEXT' },
    { name: 'first_working_period_start_time', type: 'TEXT' },
    { name: 'first_working_period_start_time_position', type: 'TEXT' },
    { name: 'fourth_working_period_end_time', type: 'TEXT' },
    { name: 'fourth_working_period_end_time_position', type: 'TEXT' },
    { name: 'fourth_working_period_start_time', type: 'TEXT' },
    { name: 'fourth_working_period_start_time_position', type: 'TEXT' },
    { name: 'half_day_time', type: 'TEXT' },
    { name: 'morning_contracted_time', type: 'TEXT' },
    { name: 'night_start_time', type: 'TEXT' },
    { name: 'night_start_time_position', type: 'TEXT' },
    { name: 'second_working_period_end_time', type: 'TEXT' },
    { name: 'second_working_period_end_time_position', type: 'TEXT' },
    { name: 'second_working_period_start_time', type: 'TEXT' },
    { name: 'second_working_period_start_time_position', type: 'TEXT' },
    { name: 'technical_string', type: 'TEXT' },
    { name: 'third_working_period_end_time', type: 'TEXT' },
    { name: 'third_working_period_end_time_position', type: 'TEXT' },
    { name: 'third_working_period_start_time', type: 'TEXT' },
    { name: 'third_working_period_start_time_position', type: 'TEXT' },
  ];

  for (const col of newColumns) {
    if (!columnNames.includes(col.name)) {
      db.exec(`ALTER TABLE kelio_horaire_affectation ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

/**
 * Migration 6 — ajout des colonnes manquantes pour les badgeages.
 * Ajoute les colonnes de la documentation Kelio qui manquaient.
 */
function applyMigration6(db) {
  const columns = db.prepare("PRAGMA table_info(kelio_badgeage)").all();
  const columnNames = columns.map(c => c.name);

  const newColumns = [
    { name: 'absence_type_abbreviation', type: 'TEXT' },
    { name: 'absence_type_description', type: 'TEXT' },
    { name: 'absence_type_key', type: 'TEXT' },
    { name: 'archived_employee', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'automatic', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'clocking_type_indicator', type: 'TEXT' },
    { name: 'employee_badge_code', type: 'TEXT' },
    { name: 'employee_first_name', type: 'TEXT' },
    { name: 'employee_identification_code', type: 'TEXT' },
    { name: 'employee_identification_number', type: 'TEXT' },
    { name: 'employee_key', type: 'TEXT' },
    { name: 'employee_surname', type: 'TEXT' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'geolocation_precision', type: 'TEXT' },
    { name: 'geolocation_status', type: 'TEXT' },
    { name: 'latitude', type: 'TEXT' },
    { name: 'longitude', type: 'TEXT' },
    { name: 'obtaining_mode', type: 'TEXT' },
    { name: 'overtime_type_abbreviation', type: 'TEXT' },
    { name: 'overtime_type_description', type: 'TEXT' },
    { name: 'overtime_type_key', type: 'TEXT' },
    { name: 'reader_description', type: 'TEXT' },
    { name: 'terminal_code', type: 'TEXT' },
    { name: 'terminal_description', type: 'TEXT' },
    { name: 'technical_string', type: 'TEXT' },
    { name: 'time_position', type: 'TEXT' },
    { name: 'validation_status', type: 'TEXT' },
  ];

  for (const col of newColumns) {
    if (!columnNames.includes(col.name)) {
      db.exec(`ALTER TABLE kelio_badgeage ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

/**
 * Migration 7 — ajout des colonnes manquantes pour les fiches d'absence.
 * Ajoute les colonnes de la documentation Kelio qui manquaient.
 */
function applyMigration7(db) {
  const columns = db.prepare("PRAGMA table_info(kelio_absence_fiche)").all();
  const columnNames = columns.map(c => c.name);

  const newColumns = [
    { name: 'absence_file_key', type: 'TEXT' },
    { name: 'absence_type_abbreviation', type: 'TEXT' },
    { name: 'archived_employee', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'comment', type: 'TEXT' },
    { name: 'creation_date', type: 'TEXT' },
    { name: 'duration_in_hours', type: 'TEXT' },
    { name: 'employee_badge_code', type: 'TEXT' },
    { name: 'employee_first_name', type: 'TEXT' },
    { name: 'employee_identification_code', type: 'TEXT' },
    { name: 'employee_identification_number', type: 'TEXT' },
    { name: 'employee_surname', type: 'TEXT' },
    { name: 'ending_the_afternoon', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'event_observing_date', type: 'TEXT' },
    { name: 'exist_related_document', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'first_end_time', type: 'TEXT' },
    { name: 'first_end_time_position', type: 'TEXT' },
    { name: 'first_start_time', type: 'TEXT' },
    { name: 'first_start_time_position', type: 'TEXT' },
    { name: 'initial_notice_cessation_work_date', type: 'TEXT' },
    { name: 'last_modification_date', type: 'TEXT' },
    { name: 'last_working_day_date', type: 'TEXT' },
    { name: 'limited_to_a_period', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'notice_cessation_work_extension', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'number_of_absence_days', type: 'TEXT' },
    { name: 'prescribed_end_date', type: 'TEXT' },
    { name: 'repetitive_absence_period', type: 'TEXT' },
    { name: 'resumption_work_date', type: 'TEXT' },
    { name: 'resumption_work_early_date', type: 'TEXT' },
    { name: 'second_end_time', type: 'TEXT' },
    { name: 'second_end_time_position', type: 'TEXT' },
    { name: 'second_start_time', type: 'TEXT' },
    { name: 'second_start_time_position', type: 'TEXT' },
    { name: 'split_holidays_waiver', type: 'TEXT' },
    { name: 'start_in_the_morning', type: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'technical_string', type: 'TEXT' },
    { name: 'total_in_days', type: 'TEXT' },
    { name: 'total_in_hours', type: 'TEXT' },
  ];

  for (const col of newColumns) {
    if (!columnNames.includes(col.name)) {
      db.exec(`ALTER TABLE kelio_absence_fiche ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

/**
 * Migration 8 — ajout des colonnes manquantes pour les fiches d'absence (suite).
 * Cette migration a été fusionnée avec la migration 7.
 */
function applyMigration8(db) {
  // Migration vide - les colonnes ont été ajoutées dans la migration 7
}

/**
 * Migration 11 — ajout des colonnes manquantes pour les affectations activité.
 * Ajoute toutes les colonnes du webservice Kelio JobAssignmentService.
 */
function applyMigration11(db) {
  const columns = db.prepare("PRAGMA table_info(kelio_affectation_activite)").all();
  const columnNames = columns.map(c => c.name);

  const newColumns = [
    { name: 'employee_badge_code', type: 'TEXT' },
    { name: 'employee_first_name', type: 'TEXT' },
    { name: 'employee_identification_code', type: 'TEXT' },
    { name: 'employee_identification_number', type: 'TEXT' },
    { name: 'employee_surname', type: 'TEXT' },
    { name: 'archived_employee', type: 'INTEGER' },
    { name: 'error_message', type: 'TEXT' },
    { name: 'technical_string', type: 'TEXT' },
  ];

  for (const col of newColumns) {
    if (!columnNames.includes(col.name)) {
      db.exec(`ALTER TABLE kelio_affectation_activite ADD COLUMN ${col.name} ${col.type}`);
    }
  }
}

/**
 * Migration 12 — ajout de section_key à kelio_salarie.
 */
function applyMigration12(db) {
  const columns = db.prepare("PRAGMA table_info(kelio_salarie)").all();
  const columnNames = columns.map(c => c.name);

  if (!columnNames.includes('section_key')) {
    db.exec(`ALTER TABLE kelio_salarie ADD COLUMN section_key TEXT`);
  }
}

// Exports : les fonctions utilisées depuis main.js
module.exports = { initDatabase, getDb, getDbRaw, getDbPath, saveDatabase };
