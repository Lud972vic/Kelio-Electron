'use strict';

/**
 * @file ConfigRepository.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — GESTION DE LA CONFIGURATION
 * ============================================================
 *
 * Ce repository gère la lecture et la sauvegarde de la configuration
 * de connexion à l'API Kelio (URL, login, mot de passe, timeout...).
 *
 * Les paramètres sont stockés dans la table SQLite `kelio_param`,
 * sous forme de paires clé/valeur (comme un dictionnaire).
 *
 * PATTERN REPOSITORY :
 * Un repository est une classe qui centralise tout l'accès à UNE table
 * (ou un groupe de tables liées). Il cache le SQL brut aux appelants.
 * main.js appelle `configRepo.getAll()` sans avoir à écrire du SQL.
 *
 * APPELANTS :
 * - main.js : via les handlers IPC 'config:get' et 'config:save'
 * - ExtractionOrchestrator.js : pour récupérer l'URL et le login avant extraction
 */

// Liste exhaustive des clés de configuration reconnues.
// Toute clé absente de cette liste est ignorée lors de la sauvegarde.
const CLES_PARAM = [
  'base_url',      // URL de l'API Kelio (ex: https://sandbox-ws.kelio.io/open)
  'wsdl_base_url', // URL des WSDL (ex: https://sandbox-ws.kelio.io/open/services)
  'login',         // Identifiant API (ex: api-ws)
  'password',      // Mot de passe API
  'timeout',       // Timeout HTTP en secondes (défaut: 60)
  'batch_size',    // Taille des lots (non utilisé directement, réservé)
  'verify_ssl',    // '0' = ignore les erreurs SSL, '1' = vérifie le certificat
  'concurrency',   // Nombre d'appels SOAP parallèles (défaut: 12)
];

// Valeurs par défaut : utilisées si un paramètre n'est pas encore en base.
// Cela évite des erreurs si l'utilisateur n'a pas encore configuré l'app.
const VALEURS_PAR_DEFAUT = {
  base_url:     'https://sandbox-ws.kelio.io/open',
  wsdl_base_url:'https://sandbox-ws.kelio.io/open/services',
  login:        '',
  password:     '',
  timeout:      '60',
  batch_size:   '50',
  verify_ssl:   '0',
  concurrency:  '20',  // 20 = rapide avec HTTP Keep-Alive, baissez si le serveur est lent
};

class ConfigRepository {

  /**
   * Constructeur — reçoit la connexion SQLite active.
   * @param {Database} db - Instance better-sqlite3
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Récupère toute la configuration depuis la base SQLite.
   * Pour chaque clé connue, retourne la valeur stockée ou la valeur par défaut.
   *
   * La requête SQL utilise la syntaxe `IN (?, ?, ...)` pour récupérer
   * toutes les lignes en un seul appel (plus efficace que N requêtes).
   *
   * Appelée par :
   * - main.js (handler 'config:get') → page Paramètres
   * - ExtractionOrchestrator.run() → avant chaque extraction
   *
   * @returns {{base_url, wsdl_base_url, login, password, timeout, batch_size, verify_ssl, concurrency}}
   */
  getAll() {
    // On construit dynamiquement les placeholders : (?, ?, ?, ?, ?, ?, ?)
    const placeholders = CLES_PARAM.map(() => '?').join(',');
    const lignes = this.db
      .prepare(`SELECT param_key, param_value FROM kelio_param WHERE param_key IN (${placeholders})`)
      .all(...CLES_PARAM);

    // Transforme le tableau [{param_key, param_value}] en dictionnaire {key: value}
    const valeursStockees = {};
    for (const ligne of lignes) {
      valeursStockees[ligne.param_key] = ligne.param_value;
    }

    // Construction du résultat : valeur stockée OU valeur par défaut
    const config = {};
    for (const cle of CLES_PARAM) {
      config[cle] = valeursStockees[cle] !== undefined
        ? valeursStockees[cle]
        : (VALEURS_PAR_DEFAUT[cle] ?? '');
    }
    return config;
  }

  /**
   * Sauvegarde la configuration dans la table `kelio_param`.
   * Utilise un "upsert" : INSERT si la clé n'existe pas, UPDATE sinon.
   * Seules les clés présentes dans CLES_PARAM et dans l'objet `config` sont traitées.
   *
   * Appelée par main.js (handler 'config:save') quand l'utilisateur clique "Enregistrer".
   *
   * @param {Object} config - Objet avec les nouvelles valeurs à sauvegarder
   */
  saveAll(config) {
    const maintenant = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // ON CONFLICT(param_key) : si la clé existe déjà, on met à jour la valeur
    const upsert = this.db.prepare(`
      INSERT INTO kelio_param (param_key, param_value, updated_at, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(param_key) DO UPDATE SET
        param_value = excluded.param_value,
        updated_at  = excluded.updated_at
    `);

    // Transaction : toutes les clés sont sauvegardées d'un coup, ou aucune
    const transaction = this.db.transaction((cfg) => {
      for (const cle of CLES_PARAM) {
        // On n'enregistre que les clés présentes dans l'objet reçu
        if (cle in cfg) {
          upsert.run(cle, String(cfg[cle] ?? ''), maintenant, maintenant);
        }
      }
    });
    transaction(config);
  }
}

module.exports = ConfigRepository;
