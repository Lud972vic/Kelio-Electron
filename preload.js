/**
 * @file preload.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — LE "PONT SÉCURISÉ"
 * ============================================================
 *
 * Electron sépare l'application en deux "mondes" distincts :
 *
 *  1. Le PROCESS PRINCIPAL (main.js) :
 *     - Tourne côté Node.js (accès disque, SQLite, réseau, OS...)
 *     - C'est le "serveur" de l'application, invisible pour l'utilisateur.
 *
 *  2. Le PROCESS DE RENDU (renderer/ → HTML/CSS/JS dans le navigateur) :
 *     - C'est ce que l'utilisateur voit (les pages HTML).
 *     - Par sécurité, il N'A PAS accès à Node.js ni aux fichiers système.
 *
 * Ce fichier preload.js est le SEUL intermédiaire autorisé entre les deux.
 * Il s'exécute dans un contexte privilégié AVANT que la page HTML se charge.
 *
 * Il expose une API nommée "KelioAPI" sur l'objet global `window`,
 * accessible depuis toutes les pages HTML via : window.KelioAPI.maFonction()
 *
 * Chaque fonction de KelioAPI envoie un message IPC ("Inter-Process Communication")
 * au process principal, qui répond avec les données.
 *
 * Schéma de communication :
 *   [Page HTML] → window.KelioAPI.xxx() → [preload.js] → ipcRenderer.invoke()
 *              → [main.js reçoit le message] → [main.js répond]
 *              → [preload.js reçoit la réponse] → [Page HTML reçoit les données]
 */

'use strict';

// On importe deux outils fournis par Electron :
// - contextBridge : permet d'exposer des fonctions de façon sécurisée au renderer
// - ipcRenderer   : permet d'envoyer/recevoir des messages vers/depuis main.js
const { contextBridge, ipcRenderer } = require('electron');

/**
 * contextBridge.exposeInMainWorld('KelioAPI', { ... })
 *
 * Cette fonction crée un objet "KelioAPI" accessible depuis window.KelioAPI
 * dans toutes les pages HTML du renderer.
 *
 * Chaque propriété de l'objet est une fonction qui :
 *   1. Appelle ipcRenderer.invoke('nom-du-canal', données)
 *   2. Attend la réponse de main.js (c'est asynchrone, retourne une Promise)
 *   3. Retourne le résultat à la page HTML qui a appelé la fonction
 */
contextBridge.exposeInMainWorld('KelioAPI', {

  // ===========================================================================
  // CONFIGURATION DE CONNEXION (URL, login, mot de passe Kelio)
  // ===========================================================================

  /**
   * Récupère toute la configuration sauvegardée dans la base SQLite.
   * Appelée au chargement de la page Paramètres.
   * @returns {Promise<Object>} - Objet avec toutes les clés de config (base_url, login, etc.)
   */
  configGet: () => ipcRenderer.invoke('config:get'),

  /**
   * Sauvegarde la configuration dans la base SQLite.
   * Appelée quand l'utilisateur clique "Enregistrer" dans les Paramètres.
   * @param {Object} cfg - Objet contenant les nouvelles valeurs de config
   * @returns {Promise<{ok: boolean}>}
   */
  configSave: (cfg) => ipcRenderer.invoke('config:save', cfg),

  /**
   * Teste la connexion SOAP Kelio avec une config donnée (sans la sauvegarder).
   * Appelée quand l'utilisateur clique "Tester la connexion".
   * @param {Object} cfg - Config à tester (base_url, login, password...)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  configTestConnect: (cfg) => ipcRenderer.invoke('config:test-connection', cfg),

  // ===========================================================================
  // EXTRACTION DE DONNÉES (appels SOAP vers les serveurs Kelio)
  // ===========================================================================

  /**
   * Lance une extraction complète pour un module donné.
   * Appelée quand l'utilisateur clique "Lancer l'extraction".
   * L'extraction peut prendre plusieurs secondes/minutes selon le nombre de salariés.
   * @param {Object} params - Paramètres : { module, dateFrom, dateTo, modePeriode, accountTypes... }
   * @returns {Promise<{success: boolean, runId: number, ok: number, errors: number}>}
   */
  extractionStart: (params) => ipcRenderer.invoke('extraction:start', params),

  /**
   * S'abonne aux événements de progression en temps réel pendant une extraction.
   * main.js envoie des messages réguliers via 'extraction:progress' pendant le traitement.
   * À chaque message reçu, la fonction callback "cb" est appelée avec les données.
   * @param {Function} cb - Fonction appelée à chaque mise à jour : cb({ message, percent, type })
   *
   * Exemple d'utilisation dans une page HTML :
   *   window.KelioAPI.onExtractionProgress((data) => {
   *     console.log(data.message, data.percent + '%');
   *   });
   */
  onExtractionProgress: (cb) => ipcRenderer.on('extraction:progress', (_e, data) => cb(data)),

  /**
   * Se désabonne des événements de progression.
   * Appelée quand l'extraction est terminée ou quand on quitte la page.
   * Important pour éviter les "fuites mémoire" (accumulation de listeners).
   */
  offExtractionProgress: () => ipcRenderer.removeAllListeners('extraction:progress'),

  // ===========================================================================
  // SALARIÉS
  // ===========================================================================

  /**
   * Récupère la liste des salariés depuis la table kelio_salarie.
   * @param {Object} filters - Filtres optionnels : { q, archived, limit, offset }
   * @returns {Promise<Array>} - Tableau d'objets salarié
   */
  employeesList: (filters) => ipcRenderer.invoke('employees:list', filters),

  // ===========================================================================
  // RÉSULTATS / COMPTEURS (totaux extraits)
  // ===========================================================================

  /**
   * Récupère la liste paginée des résultats de compteurs (heures, absences...).
   * @param {Object} filters - Filtres : { employee, date_from, date_to, type_key, limit, offset }
   * @returns {Promise<Array>}
   */
  resultsList: (filters) => ipcRenderer.invoke('results:list', filters),

  /**
   * Récupère les statistiques globales : nombre de lignes dans chaque table.
   * Utilisée par le tableau de bord pour afficher les compteurs (ex: "117 956 badgeages").
   * @returns {Promise<{employees, clockings, absenceFiles, absenceRequests, schedules, ...}>}
   */
  resultsStats: () => ipcRenderer.invoke('results:stats'),

  // ===========================================================================
  // HISTORIQUE DES EXTRACTIONS
  // ===========================================================================

  /**
   * Récupère la liste des runs d'extraction passés.
   * @param {Object} filters - Filtres : { module, status, limit, offset }
   * @returns {Promise<Array>} - Tableau avec id, module_code, status, ok, errors, date...
   */
  historyList: (filters) => ipcRenderer.invoke('history:list', filters),

  /**
   * Récupère le détail d'un run spécifique (logs ligne par ligne).
   * @param {number} runId - L'identifiant du run à inspecter
   * @returns {Promise<Object>} - { run, logs: Array }
   */
  historyDetail: (runId) => ipcRenderer.invoke('history:detail', runId),

  // ===========================================================================
  // DONNÉES IMPORTÉES — BADGEAGES (pointages)
  // ===========================================================================

  /**
   * Récupère les badgeages (pointages entrée/sortie) depuis kelio_badgeage.
   * Joints avec kelio_salarie pour afficher "NOM Prénom" au lieu du numéro.
   * @param {Object} filters - { employee, date_from, date_to, direction, limit, offset }
   * @returns {Promise<Array>}
   */
  clockingsList: (filters) => ipcRenderer.invoke('clockings:list', filters),

  // ===========================================================================
  // DONNÉES IMPORTÉES — ABSENCES
  // ===========================================================================

  /**
   * Récupère les fiches d'absence (absences validées) depuis kelio_absence_fiche.
   * @param {Object} filters - { employee, date_from, date_to, type_key, status, limit, offset }
   * @returns {Promise<Array>}
   */
  absenceFilesList: (filters) => ipcRenderer.invoke('absence-files:list', filters),

  /**
   * Récupère les demandes d'absence (en attente ou traitées) depuis kelio_absence_demande.
   * @param {Object} filters - { employee, date_from, date_to, type_key, status, limit, offset }
   * @returns {Promise<Array>}
   */
  absenceRequestsList: (filters) => ipcRenderer.invoke('absence-requests:list', filters),

  // ===========================================================================
  // DONNÉES IMPORTÉES — HORAIRES
  // ===========================================================================

  /**
   * Récupère les affectations d'horaires depuis kelio_horaire_affectation.
   * Indique quel planning/horaire était appliqué à quel salarié à quelle date.
   * @param {Object} filters - { employee, date_from, date_to, limit, offset }
   * @returns {Promise<Array>}
   */
  schedulesList: (filters) => ipcRenderer.invoke('schedules:list', filters),

  // ===========================================================================
  // DONNÉES IMPORTÉES — ACTIVITÉS (affectations activité/poste)
  // ===========================================================================

  /**
   * Récupère les affectations d'activité depuis kelio_affectation_activite.
   * Indique sur quelle activité/poste de travail était le salarié chaque jour.
   * @param {Object} filters - { employee, date_from, date_to, limit, offset }
   * @returns {Promise<Array>}
   */
  jobAssignmentsList: (filters) => ipcRenderer.invoke('job-assignments:list', filters),

  // ===========================================================================
  // DONNÉES IMPORTÉES — SERVICES JOUR PAR JOUR
  // ===========================================================================

  /**
   * Récupère les affectations de section (service/département) jour par jour
   * depuis kelio_affectation_service_jour.
   * @param {Object} filters - { employee, date_from, date_to, limit, offset }
   * @returns {Promise<Array>}
   */
  sectionAssignmentsList: (filters) => ipcRenderer.invoke('section-assignments:list', filters),

  // ===========================================================================
  // ORGANIGRAMME (structure de l'entreprise)
  // ===========================================================================

  /**
   * Récupère les niveaux de l'organigramme depuis kelio_organigramme.
   * @param {Object} filters - { q, active, limit, offset }
   * @returns {Promise<Array>}
   */
  organizationList: (filters) => ipcRenderer.invoke('organization:list', filters),

  // ===========================================================================
  // DASHBOARD
  // ===========================================================================

  /**
   * Récupère le top 20 des salariés classés par nombre de badgeages.
   * Utilisé pour afficher un tableau récapitulatif sur le dashboard.
   * @returns {Promise<Array>} - [{ employee_label, nb_clockings, nb_abs_files, ... }]
   */
  dashboardTopEmployees: () => ipcRenderer.invoke('dashboard:top-employees'),

  // ===========================================================================
  // EXPORT CSV
  // ===========================================================================

  /**
   * Ouvre une boîte de dialogue "Enregistrer sous" puis exporte les données en CSV.
   * @param {Object} opts - { type: 'results'|'employees'|'history', filters: Object }
   * @returns {Promise<{ok: boolean, filePath?: string, reason?: string}>}
   */
  exportCsv: (opts) => ipcRenderer.invoke('export:csv', opts),

  // ===========================================================================
  // MAINTENANCE DE LA BASE DE DONNÉES
  // ===========================================================================

  /**
   * Supprime toutes les lignes d'une table SQLite (purge complète).
   * Utilisé dans les paramètres pour réinitialiser les données.
   * Seules les tables autorisées peuvent être purgées (protection contre les erreurs).
   * @param {string} table - Nom de la table à vider (ex: 'kelio_badgeage')
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  dbPurge: (table) => ipcRenderer.invoke('db:purge', table),

  /**
   * Récupère les informations sur la base de données SQLite :
   * taille actuelle, espace disque libre, taille totale du volume, limite SQLite.
   * Affichée sur le tableau de bord dans la card "Base de données SQLite".
   * @returns {Promise<{sizeBytes, sqliteMaxBytes, freeBytes, totalBytes, path}>}
   */
  dbInfo: () => ipcRenderer.invoke('db:info'),

  // ===========================================================================
  // APPLICATION
  // ===========================================================================

  /**
   * Récupère le numéro de version de l'application (depuis package.json).
   * @returns {Promise<string>} - Ex: "1.0.0"
   */
  appVersion: () => ipcRenderer.invoke('app:version'),

  /**
   * Retourne la plateforme OS courante ('win32', 'darwin', 'linux').
   * Utilisé pour afficher des conseils SSL adaptés dans les paramètres.
   * @returns {string}
   */
  platform: process.platform,

  // ===========================================================================
  // REQUÊTES SQL PERSONNALISÉES
  // ===========================================================================

  /**
   * Exécute une requête SQL personnalisée sur la base de données.
   * @param {string} query - La requête SQL à exécuter
   * @returns {Promise<{columns: string[], values: any[][], rowCount: number}>}
   */
  sqlExecute: (query) => ipcRenderer.invoke('sql:execute', query),

  /**
   * Récupère la liste des tables de la base de données.
   * @returns {Promise<string[]>}
   */
  sqlTables: () => ipcRenderer.invoke('sql:tables'),

  // ===========================================================================
  // CHEMIN PERSONNALISÉ DE LA BASE DE DONNÉES
  // ===========================================================================

  /**
   * Récupère le chemin personnalisé de la base de données.
   * @returns {Promise<string|null>}
   */
  dbPathGet: () => ipcRenderer.invoke('db:path:get'),

  /**
   * Sauvegarde le chemin personnalisé de la base de données.
   * @param {string} dbPath - Le nouveau chemin de la base de données
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  dbPathSet: (dbPath) => ipcRenderer.invoke('db:path:set', dbPath),
});
