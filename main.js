/**
 * @file main.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — LE "PROCESS PRINCIPAL" DE L'APPLICATION
 * ============================================================
 *
 * main.js est le point d'entrée de toute application Electron.
 * C'est lui qui est lancé en premier quand on exécute `npm start`.
 *
 * Il a deux grandes responsabilités :
 *
 *  1. CRÉER LA FENÊTRE DE L'APPLICATION
 *     Il instancie la fenêtre Chromium (BrowserWindow) qui affiche
 *     les pages HTML du dossier renderer/.
 *
 *  2. RÉPONDRE AUX MESSAGES IPC
 *     Il écoute les messages envoyés par le renderer via preload.js
 *     (ex: "donne-moi la liste des badgeages") et répond avec les données.
 *     Ces messages sont définis via ipcMain.handle('nom-du-canal', handler).
 *
 * Accès aux données :
 *   main.js utilise des "Repositories" (classes spécialisées dans src/repositories/)
 *   pour lire/écrire dans la base SQLite. Il ne fait jamais de SQL directement.
 *
 * Architecture simplifiée :
 *   npm start
 *     └── main.js démarre
 *           ├── initDatabase()   → crée / met à jour la base SQLite
 *           ├── createWindow()   → ouvre la fenêtre HTML
 *           └── ipcMain.handle() → répond aux requêtes des pages HTML
 */

'use strict';

// ---------------------------------------------------------------------------
// Imports Electron
// app      : cycle de vie de l'application (démarrage, fermeture...)
// BrowserWindow : la fenêtre graphique de l'app
// ipcMain  : reçoit les messages IPC envoyés depuis le renderer via preload.js
// dialog   : boîtes de dialogue natives ("Enregistrer sous", alertes...)
// shell    : ouvre un fichier/dossier dans l'explorateur de fichiers de l'OS
// ---------------------------------------------------------------------------
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');   // Manipulation des chemins de fichiers (cross-platform)
const fs   = require('fs');     // Lecture/écriture de fichiers sur le disque

// ---------------------------------------------------------------------------
// Imports internes — Base de données
// initDatabase : crée le fichier SQLite et applique les migrations au démarrage
// getDb        : retourne la connexion SQLite active (singleton)
// getDbPath    : retourne le chemin absolu du fichier kelio.sqlite
// ---------------------------------------------------------------------------
const { initDatabase, getDb, getDbRaw, getDbPath, saveDatabase } = require('./db/database');

// ---------------------------------------------------------------------------
// Imports internes — Repositories
// Chaque Repository est une classe qui encapsule les requêtes SQL pour une table.
// On ne fait jamais de SQL brut ici dans main.js — on délègue aux repositories.
// ---------------------------------------------------------------------------
const ConfigRepository       = require('./src/repositories/ConfigRepository');    // Table kelio_config
const RunRepository          = require('./src/repositories/RunRepository');        // Table kelio_sync_run
const EmployeeRepository     = require('./src/repositories/EmployeeRepository');   // Table kelio_salarie
const ResultRepository       = require('./src/repositories/ResultRepository');     // Table kelio_resultat_total
const HistoryRepository      = require('./src/repositories/HistoryRepository');    // Vue historique des runs

// ---------------------------------------------------------------------------
// Imports internes — Services
// KelioSoapService     : effectue les appels HTTP/SOAP vers l'API Kelio
// ExtractionOrchestrator : coordonne une extraction complète (multi-employés)
// ---------------------------------------------------------------------------
const KelioSoapService       = require('./src/services/KelioSoapService');
const ExtractionOrchestrator = require('./src/services/ExtractionOrchestrator');

// La référence à la fenêtre principale. On la garde pour pouvoir lui envoyer
// des messages (ex: progression d'extraction) depuis les handlers IPC.
let mainWindow = null;

// ---------------------------------------------------------------------------
// CRÉATION DE LA FENÊTRE PRINCIPALE
// ---------------------------------------------------------------------------

/**
 * Crée et affiche la fenêtre principale de l'application.
 * Appelée au démarrage via app.whenReady().
 *
 * Options importantes :
 * - preload    : chemin vers preload.js (le pont sécurisé renderer ↔ main)
 * - contextIsolation: true  → le renderer ne peut pas accéder à Node.js directement
 * - nodeIntegration: false  → sécurité renforcée (pas d'accès Node dans le HTML)
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Kelio en Electron - Poc Ludovic',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // Le pont sécurisé
      contextIsolation: true,   // Sépare le monde Node du monde navigateur
      nodeIntegration: false,   // Interdit l'accès Node.js depuis le HTML
      sandbox: false,           // Nécessaire pour que preload.js fonctionne
    },
  });

  // Charge la page HTML principale (index.html gère le routing entre les pages)
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // En mode développement (npm start -- --dev), ouvre les DevTools automatiquement
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Quand la fenêtre est fermée, on libère la référence en mémoire
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// DÉMARRAGE DE L'APPLICATION (Bootstrap)
// ---------------------------------------------------------------------------

// app.whenReady() est une Promise qui se résout quand Electron est prêt à
// créer des fenêtres. C'est le point d'entrée réel de l'application.
app.whenReady().then(async () => {
  await initDatabase();   // Étape 1 : initialise/migre la base SQLite
  createWindow();   // Étape 2 : ouvre la fenêtre

  // Sur macOS, quand on clique sur l'icône du Dock alors que l'app est ouverte
  // sans fenêtre, on en recrée une (comportement macOS standard)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Sur Windows/Linux, fermer toutes les fenêtres = quitter l'app
// Sur macOS, l'app reste active en arrière-plan (comportement macOS standard)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ===========================================================================
// HANDLERS IPC — CONFIGURATION
// ===========================================================================
// Un handler IPC est une fonction qui répond à un message envoyé depuis
// le renderer via window.KelioAPI.xxx().
// Syntaxe : ipcMain.handle('canal', (event, ...args) => { return données; })
// Le premier argument (_e) est l'event Electron — on l'ignore en général.
// ===========================================================================

ipcMain.handle('config:get', () => {
  const repo = new ConfigRepository(getDb());
  return repo.getAll();
});

ipcMain.handle('config:save', (_e, config) => {
  const repo = new ConfigRepository(getDb());
  repo.saveAll(config);
  saveDatabase();
  return { ok: true };
});

ipcMain.handle('config:test-connection', async (_e, config) => {
  const svc = new KelioSoapService(config);
  return svc.testConnection();
});

// ===========================================================================
// HANDLER IPC — LANCEMENT D'UNE EXTRACTION
// ===========================================================================

ipcMain.handle('extraction:start', async (_e, params) => {
  const db = getDb();

  // On crée l'orchestrateur en lui passant une fonction "onProgress".
  // Cette fonction est appelée par l'orchestrateur à chaque étape du traitement.
  // Elle transmet la progression en temps réel au renderer via webContents.send().
  // Le renderer écoute ce canal avec window.KelioAPI.onExtractionProgress().
  const orchestrateur = new ExtractionOrchestrator(db, (donneesProgression) => {
    if (mainWindow) {
      mainWindow.webContents.send('extraction:progress', donneesProgression);
    }
  });

  // Lance l'extraction et retourne le résumé final (ok, errors, total)
  return orchestrateur.run(params);
});

// ===========================================================================
// HANDLER IPC — SALARIÉS
// ===========================================================================

ipcMain.handle('employees:list', (_e, filters) => {
  const repo = new EmployeeRepository(getDb());
  return repo.list(filters);
});

// ===========================================================================
// HANDLERS IPC — RÉSULTATS / COMPTEURS
// ===========================================================================

ipcMain.handle('results:list', (_e, filters) => {
  const repo = new ResultRepository(getDb());
  return repo.list(filters);
});

ipcMain.handle('results:stats', () => {
  const repo = new ResultRepository(getDb());
  return repo.stats();
});

// ===========================================================================
// HANDLERS IPC — HISTORIQUE DES EXTRACTIONS
// ===========================================================================

ipcMain.handle('history:list', (_e, filters) => {
  const repo = new HistoryRepository(getDb());
  return repo.list(filters);
});

ipcMain.handle('history:detail', (_e, runId) => {
  const repo = new RunRepository(getDb());
  return repo.getDetail(runId);
});

// ===========================================================================
// HANDLER IPC — EXPORT CSV
// ===========================================================================
// Ce handler ouvre une boîte de dialogue "Enregistrer sous" native (dialog),
// construit le contenu CSV ligne par ligne, et l'écrit sur le disque.
// Le BOM (\uFEFF) en début de fichier garantit que Excel ouvre correctement
// les caractères accentués (UTF-8 avec BOM).
// ===========================================================================

ipcMain.handle('export:csv', async (_e, { type, filters }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le fichier CSV',
    defaultPath: `kelio-${type}-${new Date().toISOString().slice(0,10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });

  if (canceled || !filePath) return { ok: false, reason: 'annulé' };

  let rows = [];
  let headers = [];

  if (type === 'results') {
    const repo = new ResultRepository(getDb());
    rows = repo.list(filters);
    headers = ['Date', 'Cle salarie', 'Matricule', 'Nom', 'Prenom', 'typeKey', 'Abreviation', 'Libelle', 'Section', 'Valeur', 'Importe le'];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.result_date ?? '', r.employee_key ?? '', r.employee_identification_number ?? '',
        r.employee_surname ?? '', r.employee_first_name ?? '', r.type_key ?? '',
        r.type_abbreviation ?? '', r.type_description ?? '', r.section_description ?? '',
        r.value_canonical ?? '', r.imported_at ?? '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'employees') {
    const repo = new EmployeeRepository(getDb());
    rows = repo.list(filters);
    headers = [
      'archivedEmployee', 'currentAccessAuthorizationEndDate', 'currentAccessAuthorizationEndTime',
      'currentAccessAuthorizationStartDate', 'currentAccessAuthorizationStartTime',
      'defaultEmployeeBadge', 'defaultEmployeeFirstName', 'defaultEmployeeIdentificationCode', 'defaultEmployeeIdentificationNumber', 'defaultEmployeeSurname',
      'employeeBadgeCode', 'employeeFirstName', 'employeeIdentificationCode', 'employeeIdentificationNumber', 'employeeKey', 'employeeSurname',
      'errorMessage',
      'generateBadge', 'isAccessModuleEmployee', 'isTandAModuleEmployee', 'searchUsingBadge', 'searchUsingFirstname', 'searchUsingIdentificationNumber', 'searchUsingSurname',
      'takenIntoAccountEndDate', 'takenIntoAccountPeriodEndDate', 'takenIntoAccountPeriodStartDate', 'takenIntoAccountStartDate',
      'populationEndDate', 'populationFilter', 'populationMode', 'populationStartDate',
      'technicalString', 'useDefaultModelEmployee', 'userProfileAssignmentWizardDescription', 'userProfileAssignmentWizardKey', 'imported_at'
    ];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.archived_employee ? 'Oui' : 'Non',
        r.current_access_authorization_end_date ?? '',
        r.current_access_authorization_end_time ?? '',
        r.current_access_authorization_start_date ?? '',
        r.current_access_authorization_start_time ?? '',
        r.default_employee_badge ?? '',
        r.default_employee_first_name ?? '',
        r.default_employee_identification_code ?? '',
        r.default_employee_identification_number ?? '',
        r.default_employee_surname ?? '',
        r.employee_badge_code ?? '',
        r.employee_first_name ?? '',
        r.employee_identification_code ?? '',
        r.employee_identification_number ?? '',
        r.employee_key ?? '',
        r.employee_surname ?? '',
        r.error_message ?? '',
        r.generate_badge ? 'Oui' : 'Non',
        r.is_access_module_employee ? 'Oui' : 'Non',
        r.is_tanda_module_employee ? 'Oui' : 'Non',
        r.search_using_badge ? 'Oui' : 'Non',
        r.search_using_firstname ? 'Oui' : 'Non',
        r.search_using_identification_number ? 'Oui' : 'Non',
        r.search_using_surname ? 'Oui' : 'Non',
        r.taken_into_account_end_date ?? '',
        r.taken_into_account_period_end_date ?? '',
        r.taken_into_account_period_start_date ?? '',
        r.taken_into_account_start_date ?? '',
        r.population_end_date ?? '',
        r.population_filter ?? '',
        r.population_mode ?? '',
        r.population_start_date ?? '',
        r.technical_string ?? '',
        r.use_default_model_employee ? 'Oui' : 'Non',
        r.user_profile_assignment_wizard_description ?? '',
        r.user_profile_assignment_wizard_key ?? '',
        r.imported_at ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'history') {
    const repo = new HistoryRepository(getDb());
    rows = repo.list(filters);
    headers = ['ID', 'Module', 'Mode', 'Date debut', 'Date fin', 'Statut', 'Requetes', 'OK', 'Erreurs', 'Cree le'];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.id ?? '', r.module_code ?? '', r.mode_periode ?? '',
        r.date_from ?? '', r.date_to ?? '', r.status ?? '',
        r.total_requests ?? 0, r.ok_requests ?? 0, r.error_requests ?? 0,
        r.created_at ?? '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'clockings') {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filters?.employee) { conditions.push("c.employee_key = ?"); params.push(filters.employee); }
    if (filters?.date_from) { conditions.push("c.clocking_date >= ?"); params.push(filters.date_from); }
    if (filters?.date_to) { conditions.push("c.clocking_date <= ?"); params.push(filters.date_to); }
    if (filters?.direction) { conditions.push("c.direction_code = ?"); params.push(filters.direction); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT c.*
      FROM kelio_badgeage c
      ${whereClause}
    `).all(...params);
    headers = [
      'absenceTypeAbbreviation', 'absenceTypeDescription', 'absenceTypeKey',
      'archivedEmployee', 'automatic', 'clockingKey', 'clockingTypeIndicator',
      'date', 'employeeBadgeCode', 'employeeFirstName', 'employeeIdentificationCode', 'employeeIdentificationNumber', 'employeeKey', 'employeeSurname',
      'errorMessage', 'geolocationPrecision', 'geolocationStatus', 'inOutIndicator',
      'latitude', 'longitude', 'obtainingMode',
      'overtimeTypeAbbreviation', 'overtimeTypeDescription', 'overtimeTypeKey',
      'readerDescription', 'readerKey', 'technicalString',
      'terminalDescription', 'terminalKey', 'time', 'timePosition', 'imported_at'
    ];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.absence_type_abbreviation ?? '', r.absence_type_description ?? '', r.absence_type_key ?? '',
        r.archived_employee ? 'Oui' : 'Non', r.automatic ? 'Oui' : 'Non', r.badge_code ?? '', r.clocking_type_indicator ?? '',
        r.clocking_date ?? '', r.employee_badge_code ?? '', r.employee_first_name ?? '', r.employee_identification_code ?? '', r.employee_identification_number ?? '', r.employee_key ?? '', r.employee_surname ?? '',
        r.error_message ?? '', r.geolocation_precision ?? '', r.geolocation_status ?? '', r.direction_code ?? '',
        r.latitude ?? '', r.longitude ?? '', r.obtaining_mode ?? '',
        r.overtime_type_abbreviation ?? '', r.overtime_type_description ?? '', r.overtime_type_key ?? '',
        r.reader_description ?? '', r.reader_code ?? '', r.technical_string ?? '',
        r.terminal_description ?? '', r.terminal_code ?? '', r.clocking_datetime ? r.clocking_datetime.slice(11,16) : '', r.time_position ?? '', r.imported_at ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'absence-files' || type === 'absence_files') {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filters?.employee) { conditions.push("a.employee_key = ?"); params.push(filters.employee); }
    if (filters?.date_from) { conditions.push("a.end_date >= ?"); params.push(filters.date_from); }
    if (filters?.date_to) { conditions.push("a.start_date <= ?"); params.push(filters.date_to); }
    if (filters?.type) { conditions.push("a.type_key LIKE ?"); params.push(`%${filters.type}%`); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT a.*
      FROM kelio_absence_fiche a
      ${whereClause}
    `).all(...params);
    headers = [
      'absenceFileKey', 'absenceTypeAbbreviation', 'absenceTypeDescription', 'absenceTypeKey',
      'archivedEmployee', 'comment', 'creationDate', 'durationInDays', 'durationInHours',
      'employeeBadgeCode', 'employeeFirstName', 'employeeIdentificationCode', 'employeeIdentificationNumber', 'employeeKey', 'employeeSurname',
      'endingTheAfternoon', 'errorMessage', 'eventObservingDate', 'existRelatedDocument',
      'firstEndTime', 'firstEndTimePosition', 'firstStartTime', 'firstStartTimePosition',
      'initialNoticeCessationWorkDate', 'lastModificationDate', 'lastWorkingDayDate',
      'limitedToAPeriod', 'noticeCessationWorkExtension', 'numberOfAbsenceDays', 'prescribedEndDate',
      'repetitiveAbsencePeriod', 'resumptionWorkDate', 'resumptionWorkEarlyDate',
      'secondEndTime', 'secondEndTimePosition', 'secondStartTime', 'secondStartTimePosition',
      'splitHolidaysWaiver', 'startDate', 'startInTheMorning', 'statusCode',
      'technicalString', 'totalInDays', 'totalInHours', 'endDate', 'imported_at'
    ];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.file_key ?? '', r.type_abbreviation ?? '', r.type_description ?? '', r.type_key ?? '',
        r.archived_employee ? 'Oui' : 'Non', r.comment ?? '', r.creation_date ?? '', r.duration_days ?? '', r.duration_in_hours ?? '',
        r.employee_badge_code ?? '', r.employee_first_name ?? '', r.employee_identification_code ?? '', r.employee_identification_number ?? '', r.employee_key ?? '', r.employee_surname ?? '',
        r.ending_the_afternoon ? 'Oui' : 'Non', r.error_message ?? '', r.event_observing_date ?? '', r.exist_related_document ? 'Oui' : 'Non',
        r.first_end_time ?? '', r.first_end_time_position ?? '', r.first_start_time ?? '', r.first_start_time_position ?? '',
        r.initial_notice_cessation_work_date ?? '', r.last_modification_date ?? '', r.last_working_day_date ?? '',
        r.limited_to_a_period ? 'Oui' : 'Non', r.notice_cessation_work_extension ? 'Oui' : 'Non', r.number_of_absence_days ?? '', r.prescribed_end_date ?? '',
        r.repetitive_absence_period ?? '', r.resumption_work_date ?? '', r.resumption_work_early_date ?? '',
        r.second_end_time ?? '', r.second_end_time_position ?? '', r.second_start_time ?? '', r.second_start_time_position ?? '',
        r.split_holidays_waiver ?? '', r.start_date ?? '', r.start_in_the_morning ? 'Oui' : 'Non', r.status_code ?? '',
        r.technical_string ?? '', r.total_in_days ?? '', r.total_in_hours ?? '', r.end_date ?? '', r.imported_at ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'absence-requests' || type === 'absence_requests') {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filters?.employee) { conditions.push("a.employee_key = ?"); params.push(filters.employee); }
    if (filters?.date_from) { conditions.push("a.end_date >= ?"); params.push(filters.date_from); }
    if (filters?.date_to) { conditions.push("a.start_date <= ?"); params.push(filters.date_to); }
    if (filters?.type) { conditions.push("a.type_key LIKE ?"); params.push(`%${filters.type}%`); }
    if (filters?.status) { conditions.push("a.status_code = ?"); params.push(filters.status); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT a.*
      FROM kelio_absence_demande a
      ${whereClause}
    `).all(...params);
    headers = [
      'absenceFileKey', 'absenceRequestKey', 'absenceTypeAbbreviation', 'absenceTypeDescription', 'absenceTypeKey',
      'archivedEmployee', 'comment', 'creationDate', 'durationInDays', 'durationInHours',
      'employeeBadgeCode', 'employeeFirstName', 'employeeIdentificationCode', 'employeeIdentificationNumber', 'employeeKey', 'employeeSurname',
      'endingTheAfternoon', 'errorMessage',
      'firstEndTime', 'firstEndTimePosition', 'firstStartTime', 'firstStartTimePosition',
      'lastModificationDate', 'requestState', 'requestType',
      'secondEndTime', 'secondEndTimePosition', 'secondStartTime', 'secondStartTimePosition',
      'splitHolidaysWaiver', 'startDate', 'startInTheMorning',
      'technicalString', 'totalInDays', 'totalInHours', 'endDate', 'imported_at',
      'validatorsBadgeCodes', 'validatorsFirstNames', 'validatorsIdentificationCode', 'validatorsIdentificationNumbers', 'validatorsKeys', 'validatorsLogins', 'validatorsSurnames'
    ];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.absence_file_key ?? '', r.request_key ?? '', r.absence_type_abbreviation ?? '', r.type_description ?? '', r.type_key ?? '',
        r.archived_employee ? 'Oui' : 'Non', r.comment ?? '', r.creation_date ?? '', r.duration_days ?? '', r.duration_in_hours ?? '',
        r.employee_badge_code ?? '', r.employee_first_name ?? '', r.employee_identification_code ?? '', r.employee_identification_number ?? '', r.employee_key ?? '', r.employee_surname ?? '',
        r.ending_the_afternoon ? 'Oui' : 'Non', r.error_message ?? '',
        r.first_end_time ?? '', r.first_end_time_position ?? '', r.first_start_time ?? '', r.first_start_time_position ?? '',
        r.last_modification_date ?? '', r.status_code ?? '', r.request_type ?? '',
        r.second_end_time ?? '', r.second_end_time_position ?? '', r.second_start_time ?? '', r.second_start_time_position ?? '',
        r.split_holidays_waiver ?? '', r.start_date ?? '', r.start_in_the_morning ? 'Oui' : 'Non',
        r.technical_string ?? '', r.total_in_days ?? '', r.total_in_hours ?? '', r.end_date ?? '', r.imported_at ?? '',
        r.validators_badge_codes ?? '', r.validators_first_names ?? '', r.validators_identification_code ?? '', r.validators_identification_numbers ?? '', r.validators_keys ?? '', r.validators_logins ?? '', r.validators_surnames ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'schedules') {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filters?.employee) { conditions.push("s.employee_key = ?"); params.push(filters.employee); }
    if (filters?.date_from) { conditions.push("s.start_date >= ?"); params.push(filters.date_from); }
    if (filters?.date_to) { conditions.push("s.start_date <= ?"); params.push(filters.date_to); }
    if (filters?.schedule_code) { conditions.push("s.schedule_code LIKE ?"); params.push(`%${filters.schedule_code}%`); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT s.*
      FROM kelio_horaire_affectation s
      ${whereClause}
    `).all(...params);
    headers = [
      'assignmentDate', 'dailyScheduleAbbreviation', 'dailyScheduleDescription', 'dailyScheduleKey',
      'scheduleAbbreviation', 'scheduleDescription', 'afternoonContractedTime', 'archivedEmployee', 'assignementByException',
      'calculationModeContractedSchedule', 'comment', 'contractedTime',
      'employeeBadgeCode', 'employeeFirstName', 'employeeIdentificationCode', 'employeeIdentificationNumber', 'employeeKey', 'employeeSurname',
      'errorMessage',
      'fifthWorkingPeriodEndTime', 'fifthWorkingPeriodEndTimePosition', 'fifthWorkingPeriodStartTime', 'fifthWorkingPeriodStartTimePosition',
      'firstWorkingPeriodEndTime', 'firstWorkingPeriodEndTimePosition', 'firstWorkingPeriodStartTime', 'firstWorkingPeriodStartTimePosition',
      'fourthWorkingPeriodEndTime', 'fourthWorkingPeriodEndTimePosition', 'fourthWorkingPeriodStartTime', 'fourthWorkingPeriodStartTimePosition',
      'halfDayTime', 'morningContractedTime', 'nightStartTime', 'nightStartTimePosition',
      'secondWorkingPeriodEndTime', 'secondWorkingPeriodEndTimePosition', 'secondWorkingPeriodStartTime', 'secondWorkingPeriodStartTimePosition',
      'technicalString',
      'thirdWorkingPeriodEndTime', 'thirdWorkingPeriodEndTimePosition', 'thirdWorkingPeriodStartTime', 'thirdWorkingPeriodStartTimePosition',
      'imported_at'
    ];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.start_date ?? '', r.schedule_code ?? '', r.schedule_description ?? '', r.schedule_key ?? '',
        r.schedule_abbreviation ?? '', r.schedule_description ?? '', r.afternoon_contracted_time ?? '', r.archived_employee ? 'Oui' : 'Non', r.assignement_by_exception ? 'Oui' : 'Non',
        r.calculation_mode_contracted_schedule ?? '', r.comment ?? '', r.contracted_time ?? '',
        r.employee_badge_code ?? '', r.employee_first_name ?? '', r.employee_identification_code ?? '', r.employee_identification_number ?? '', r.employee_key ?? '', r.employee_surname ?? '',
        r.error_message ?? '',
        r.fifth_working_period_end_time ?? '', r.fifth_working_period_end_time_position ?? '', r.fifth_working_period_start_time ?? '', r.fifth_working_period_start_time_position ?? '',
        r.first_working_period_end_time ?? '', r.first_working_period_end_time_position ?? '', r.first_working_period_start_time ?? '', r.first_working_period_start_time_position ?? '',
        r.fourth_working_period_end_time ?? '', r.fourth_working_period_end_time_position ?? '', r.fourth_working_period_start_time ?? '', r.fourth_working_period_start_time_position ?? '',
        r.half_day_time ?? '', r.morning_contracted_time ?? '', r.night_start_time ?? '', r.night_start_time_position ?? '',
        r.second_working_period_end_time ?? '', r.second_working_period_end_time_position ?? '', r.second_working_period_start_time ?? '', r.second_working_period_start_time_position ?? '',
        r.technical_string ?? '',
        r.third_working_period_end_time ?? '', r.third_working_period_end_time_position ?? '', r.third_working_period_start_time ?? '', r.third_working_period_start_time_position ?? '',
        r.imported_at ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'job-assignments' || type === 'job_assignments') {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filters?.employee) { conditions.push("j.employee_key = ?"); params.push(filters.employee); }
    if (filters?.date_from) { conditions.push("j.assignment_date >= ?"); params.push(filters.date_from); }
    if (filters?.date_to) { conditions.push("j.assignment_date <= ?"); params.push(filters.date_to); }
    if (filters?.job_code) { conditions.push("j.job_code = ?"); params.push(filters.job_code); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT j.*, e.surname, e.first_name
      FROM kelio_affectation_activite j
      LEFT JOIN kelio_salarie e ON j.employee_key = e.employee_key
      ${whereClause}
    `).all(...params);
    headers = ['Date', 'Activite', 'Cle salarie', 'Matricule', 'Nom', 'Prenom', 'Importe le'];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.assignment_date ?? '', r.job_description ?? r.job_code ?? '',
        r.employee_key ?? '', r.identification_number ?? '',
        r.surname ?? '', r.first_name ?? '', r.imported_at ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'section-assignments' || type === 'section_assignments') {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filters?.employee) { conditions.push("s.employee_key = ?"); params.push(filters.employee); }
    if (filters?.date_from) { conditions.push("s.assignment_date >= ?"); params.push(filters.date_from); }
    if (filters?.date_to) { conditions.push("s.assignment_date <= ?"); params.push(filters.date_to); }
    if (filters?.section_code) { conditions.push("s.section_code = ?"); params.push(filters.section_code); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT s.*, e.surname, e.first_name
      FROM kelio_affectation_service_jour s
      LEFT JOIN kelio_salarie e ON s.employee_key = e.employee_key
      ${whereClause}
    `).all(...params);
    headers = ['Date', 'Service', 'Cle salarie', 'Matricule', 'Nom', 'Prenom', 'Importe le'];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.assignment_date ?? '', r.section_description ?? r.section_code ?? '',
        r.employee_key ?? '', r.identification_number ?? '',
        r.surname ?? '', r.first_name ?? '', r.imported_at ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else if (type === 'organization') {
    const db = getDb();
    rows = db.prepare('SELECT * FROM kelio_organigramme WHERE 1=1').all();
    headers = [
      'companyDescription', 'companyFaxNumber', 'companyFileNumber', 'companyKey',
      'companyMailAddress', 'companyPhoneNumber', 'companyWebAddress',
      'departmentAbbreviation', 'departmentDescription', 'departmentKey', 'departmentManager',
      'errorMessage',
      'firmAbbreviation', 'firmDescription', 'firmKey', 'firmManager',
      'fullAbbreviation', 'fullDescription',
      'level4Abbreviation', 'level4Description', 'level4Key', 'level4Manager',
      'level5Abbreviation', 'level5Description', 'level5Key', 'level5Manager',
      'level6Abbreviation', 'level6Description', 'level6Key', 'level6Manager',
      'level7Abbreviation', 'level7Description', 'level7Key', 'level7Manager',
      'level8Abbreviation', 'level8Description', 'level8Key', 'level8Manager',
      'levels', 'levelType', 'manager',
      'organizationChartLevelAbbreviation', 'organizationChartLevelDescription', 'organizationChartLevelDescriptionType', 'organizationChartLevelKey',
      'sectionAbbreviation', 'sectionDescription', 'sectionKey', 'sectionManager',
      'subDepartmentAbbreviation', 'subDepartmentDescription', 'subDepartmentKey', 'subDepartmentManager',
      'technicalString', 'imported_at'
    ];
    const lines = [headers.join(';')];
    for (const r of rows) {
      lines.push([
        r.company_description ?? '',
        r.company_fax_number ?? '',
        r.company_file_number ?? '',
        r.company_key ?? '',
        r.company_mail_address ?? '',
        r.company_phone_number ?? '',
        r.company_web_address ?? '',
        r.department_abbreviation ?? '',
        r.department_description ?? '',
        r.department_key ?? '',
        r.department_manager ?? '',
        r.error_message ?? '',
        r.firm_abbreviation ?? '',
        r.firm_description ?? '',
        r.firm_key ?? '',
        r.firm_manager ?? '',
        r.full_abbreviation ?? '',
        r.full_description ?? '',
        r.level4_abbreviation ?? '',
        r.level4_description ?? '',
        r.level4_key ?? '',
        r.level4_manager ?? '',
        r.level5_abbreviation ?? '',
        r.level5_description ?? '',
        r.level5_key ?? '',
        r.level5_manager ?? '',
        r.level6_abbreviation ?? '',
        r.level6_description ?? '',
        r.level6_key ?? '',
        r.level6_manager ?? '',
        r.level7_abbreviation ?? '',
        r.level7_description ?? '',
        r.level7_key ?? '',
        r.level7_manager ?? '',
        r.level8_abbreviation ?? '',
        r.level8_description ?? '',
        r.level8_key ?? '',
        r.level8_manager ?? '',
        r.levels ?? '',
        r.level_type ?? '',
        r.manager ?? '',
        r.organization_chart_level_abbreviation ?? '',
        r.organization_chart_level_description ?? '',
        r.organization_chart_level_description_type ?? '',
        r.organization_chart_level_key ?? '',
        r.section_abbreviation ?? '',
        r.section_description ?? '',
        r.section_key ?? '',
        r.section_manager ?? '',
        r.sub_department_abbreviation ?? '',
        r.sub_department_description ?? '',
        r.sub_department_key ?? '',
        r.sub_department_manager ?? '',
        r.technical_string ?? '',
        r.imported_at ?? ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
    }
    fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
  } else {
    return { ok: false, reason: 'Type non supporté' };
  }

  shell.showItemInFolder(filePath);
  return { ok: true, filePath };
});

// ===========================================================================
// HANDLERS IPC — DONNÉES IMPORTÉES
// ===========================================================================
// Chaque handler ci-dessous suit le même schéma :
//   1. Récupère la connexion db
//   2. Construit dynamiquement une clause WHERE selon les filtres reçus
//   3. Fait un LEFT JOIN avec kelio_salarie pour obtenir "NOM Prénom"
//      (COALESCE retourne le nom s'il existe, sinon la clé numérique brute)
//   4. Retourne les lignes paginées (LIMIT + OFFSET)
// ===========================================================================

ipcMain.handle('clockings:list', (_e, f = {}) => {
  const db = getDb();
  const conditions = [];  // Liste des conditions SQL (ex: "b.clocking_date >= :df")
  const params = {};       // Valeurs correspondantes (évite les injections SQL)

  // Filtre texte libre : on cherche dans la clé salarié, le code badge, ou le nom
  if (f.employee)  { conditions.push("(b.employee_key LIKE :q OR b.badge_code LIKE :q OR UPPER(s.employee_surname||' '||s.employee_first_name) LIKE UPPER(:q))"); params.q = `%${f.employee}%`; }
  if (f.date_from) { conditions.push("b.clocking_date >= :df"); params.df = f.date_from; }
  if (f.date_to)   { conditions.push("b.clocking_date <= :dt"); params.dt = f.date_to; }
  if (f.direction) { conditions.push("b.direction_code = :dir"); params.dir = f.direction; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = f.limit  ?? 200;
  const offset = f.offset ?? 0;
  return db.prepare(`
    SELECT b.*, COALESCE(s.employee_surname||' '||s.employee_first_name, b.employee_key) AS employee_label
    FROM kelio_badgeage b
    LEFT JOIN kelio_salarie s ON s.employee_key = b.employee_key
    ${where} ORDER BY b.clocking_date DESC, b.clocking_datetime DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset });
});

// --- Fiches d'absence ---
ipcMain.handle('absence-files:list', (_e, f = {}) => {
  const db = getDb();
  const conditions = [];
  const params = {};
  if (f.employee)  { conditions.push("(t.employee_key LIKE :q OR UPPER(s.employee_surname||' '||s.employee_first_name) LIKE UPPER(:q))"); params.q = `%${f.employee}%`; }
  if (f.date_from) { conditions.push("t.end_date >= :df"); params.df = f.date_from; }
  if (f.date_to)   { conditions.push("t.start_date <= :dt"); params.dt = f.date_to; }
  if (f.type_key)  { conditions.push("t.type_key LIKE :tk"); params.tk = `%${f.type_key}%`; }
  if (f.status)    { conditions.push("t.status_code = :st"); params.st = f.status; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = f.limit  ?? 200;
  const offset = f.offset ?? 0;
  return db.prepare(`
    SELECT t.*, COALESCE(s.employee_surname||' '||s.employee_first_name, t.employee_key) AS employee_label
    FROM kelio_absence_fiche t
    LEFT JOIN kelio_salarie s ON s.employee_key = t.employee_key
    ${where} ORDER BY t.start_date DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset });
});

// --- Demandes d'absence ---
ipcMain.handle('absence-requests:list', (_e, f = {}) => {
  const db = getDb();
  const conditions = [];
  const params = {};
  if (f.employee)  { conditions.push("(t.employee_key LIKE :q OR UPPER(s.employee_surname||' '||s.employee_first_name) LIKE UPPER(:q))"); params.q = `%${f.employee}%`; }
  if (f.date_from) { conditions.push("t.end_date >= :df"); params.df = f.date_from; }
  if (f.date_to)   { conditions.push("t.start_date <= :dt"); params.dt = f.date_to; }
  if (f.type_key)  { conditions.push("t.type_key LIKE :tk"); params.tk = `%${f.type_key}%`; }
  if (f.status)    { conditions.push("t.status_code = :st"); params.st = f.status; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = f.limit  ?? 200;
  const offset = f.offset ?? 0;
  return db.prepare(`
    SELECT t.*, COALESCE(s.employee_surname||' '||s.employee_first_name, t.employee_key) AS employee_label
    FROM kelio_absence_demande t
    LEFT JOIN kelio_salarie s ON s.employee_key = t.employee_key
    ${where} ORDER BY t.start_date DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset });
});

// --- Horaires ---
ipcMain.handle('schedules:list', (_e, f = {}) => {
  const db = getDb();
  const conditions = [];
  const params = {};
  if (f.employee)  { conditions.push("(t.employee_key LIKE :q OR UPPER(s.employee_surname||' '||s.employee_first_name) LIKE UPPER(:q))"); params.q = `%${f.employee}%`; }
  if (f.date_from) { conditions.push("(t.end_date >= :df OR t.end_date IS NULL)"); params.df = f.date_from; }
  if (f.date_to)   { conditions.push("t.start_date <= :dt"); params.dt = f.date_to; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = f.limit  ?? 200;
  const offset = f.offset ?? 0;
  return db.prepare(`
    SELECT t.*, COALESCE(s.employee_surname||' '||s.employee_first_name, t.employee_key) AS employee_label
    FROM kelio_horaire_affectation t
    LEFT JOIN kelio_salarie s ON s.employee_key = t.employee_key
    ${where} ORDER BY t.start_date DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset });
});

// --- Affectations activité ---
ipcMain.handle('job-assignments:list', (_e, f = {}) => {
  const db = getDb();
  const conditions = [];
  const params = {};
  if (f.employee)  { conditions.push("(t.employee_key LIKE :q OR UPPER(s.employee_surname||' '||s.employee_first_name) LIKE UPPER(:q))"); params.q = `%${f.employee}%`; }
  if (f.date_from) { conditions.push("t.assignment_date >= :df"); params.df = f.date_from; }
  if (f.date_to)   { conditions.push("t.assignment_date <= :dt"); params.dt = f.date_to; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = f.limit  ?? 200;
  const offset = f.offset ?? 0;
  return db.prepare(`
    SELECT
      t.run_id,
      t.employee_key,
      t.job_key AS jobKey,
      t.job_code AS jobCode,
      t.job_description AS jobDescription,
      t.assignment_date AS assignmentDate,
      t.employee_badge_code AS employeeBadgeCode,
      t.employee_first_name AS employeeFirstName,
      t.employee_identification_code AS employeeIdentificationCode,
      t.employee_identification_number AS employeeIdentificationNumber,
      t.employee_surname AS employeeSurname,
      t.archived_employee AS archivedEmployee,
      t.error_message AS errorMessage,
      t.technical_string AS technicalString,
      t.imported_at AS importedAt,
      COALESCE(s.employee_surname||' '||s.employee_first_name, t.employee_key) AS employee_label
    FROM kelio_affectation_activite t
    LEFT JOIN kelio_salarie s ON s.employee_key = t.employee_key
    ${where} ORDER BY t.assignment_date DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset });
});

// --- Affectations service jour/jour ---
ipcMain.handle('section-assignments:list', (_e, f = {}) => {
  const db = getDb();
  const conditions = [];
  const params = {};
  if (f.employee)  { conditions.push("(t.employee_key LIKE :q OR UPPER(s.employee_surname||' '||s.employee_first_name) LIKE UPPER(:q))"); params.q = `%${f.employee}%`; }
  if (f.date_from) { conditions.push("t.assignment_date >= :df"); params.df = f.date_from; }
  if (f.date_to)   { conditions.push("t.assignment_date <= :dt"); params.dt = f.date_to; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = f.limit  ?? 200;
  const offset = f.offset ?? 0;
  return db.prepare(`
    SELECT t.*, COALESCE(s.employee_surname||' '||s.employee_first_name, t.employee_key) AS employee_label
    FROM kelio_affectation_service_jour t
    LEFT JOIN kelio_salarie s ON s.employee_key = t.employee_key
    ${where} ORDER BY t.assignment_date DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset });
});

// ===========================================================================
// HANDLER IPC — DASHBOARD TOP SALARIÉS
// ===========================================================================
// Requête SQL avec sous-requêtes corrélées : pour chaque salarié, on compte
// le nombre de lignes dans chaque table d'extraction.
// Trié par nombre de badgeages décroissant pour voir les plus actifs en premier.
// ===========================================================================

ipcMain.handle('dashboard:top-employees', () => {
  const db = getDb();
  return db.prepare(`
    SELECT
      s.employee_key,
      s.employee_surname || ' ' || s.employee_first_name AS employee_label,
      (SELECT COUNT(*) FROM kelio_badgeage               WHERE employee_key = s.employee_key) AS nb_clockings,
      (SELECT COUNT(*) FROM kelio_absence_fiche          WHERE employee_key = s.employee_key) AS nb_abs_files,
      (SELECT COUNT(*) FROM kelio_absence_demande        WHERE employee_key = s.employee_key) AS nb_abs_requests,
      (SELECT COUNT(*) FROM kelio_horaire_affectation    WHERE employee_key = s.employee_key) AS nb_schedules,
      (SELECT COUNT(*) FROM kelio_affectation_activite   WHERE employee_key = s.employee_key) AS nb_job_assign,
      (SELECT COUNT(*) FROM kelio_affectation_service_jour WHERE employee_key = s.employee_key) AS nb_section_assign
    FROM kelio_salarie s
    ORDER BY nb_clockings DESC
    LIMIT 20
  `).all();
});

// ===========================================================================
// HANDLER IPC — ORGANIGRAMME
// ===========================================================================
ipcMain.handle('organization:list', (_e, f = {}) => {
  const db = getDb();
  const conditions = [];
  const params = {};
  if (f.q) { conditions.push("(organization_chart_level_abbreviation LIKE :q OR organization_chart_level_description LIKE :q)"); params.q = `%${f.q}%`; }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit  = f.limit  ?? 200;
  const offset = f.offset ?? 0;
  return db.prepare(`SELECT * FROM kelio_organigramme ${where} ORDER BY organization_chart_level_description ASC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset });
});

// ===========================================================================
// HANDLERS IPC — MAINTENANCE BASE DE DONNÉES
// ===========================================================================

/**
 * Purge (vide) une table SQLite.
 * On désactive temporairement les contraintes de clés étrangères (foreign_keys)
 * pour éviter les erreurs de dépendances lors de la suppression.
 * La liste "allowed" est une liste blanche : seules ces tables peuvent être
 * vidées, pour éviter qu'un bug supprime accidentellement une table critique.
 */
ipcMain.handle('db:purge', (_e, nomTable) => {
  const tablesAutorisees = [
    'kelio_salarie', 'kelio_resultat_total', 'kelio_sync_run', 'kelio_sync_log',
    'kelio_badgeage', 'kelio_absence_fiche', 'kelio_absence_demande',
    'kelio_horaire_affectation', 'kelio_affectation_activite',
    'kelio_affectation_service_jour', 'kelio_organigramme',
  ];
  if (!tablesAutorisees.includes(nomTable)) {
    return { ok: false, reason: 'Table non autorisée' };
  }
  const db = getDb();
  db.pragma('foreign_keys = OFF');                       // Désactive les FK temporairement
  db.prepare(`DELETE FROM ${nomTable}`).run();           // Supprime toutes les lignes
  db.pragma('foreign_keys = ON');                        // Réactive les FK
  return { ok: true };
});

/** Retourne la version de l'app définie dans package.json. */
ipcMain.handle('app:version', () => app.getVersion());

/**
 * Retourne les informations sur la base de données SQLite :
 * - sizeBytes     : taille actuelle du fichier .sqlite en octets
 * - sqliteMaxBytes: limite théorique SQLite (17,5 To avec page size 4Ko)
 * - freeBytes     : espace libre sur le volume disque (via commande `df`)
 * - totalBytes    : taille totale du volume disque
 * - path          : chemin absolu du fichier kelio.sqlite
 *
 * La commande `df -k "chemin"` lit les infos du système de fichiers.
 * Elle renvoie une ligne de la forme :
 *   Filesystem  1K-blocks  Used  Available  Capacity  Mounted on
 * On lit la colonne [1] (total) et [3] (disponible), en blocs de 1Ko.
 * On multiplie par 1024 pour obtenir des octets.
 */
ipcMain.handle('db:info', () => {
  const cheminDb = getDbPath();
  // Limite théorique SQLite : 4 294 967 294 pages × 4096 octets ≈ 17,5 To
  const SQLITE_LIMITE_MAX_OCTETS = 17.5 * 1024 * 1024 * 1024 * 1024;
  try {
    const tailleOctets = fs.statSync(cheminDb).size;  // Taille réelle du fichier
    const dossier = path.dirname(cheminDb);             // Dossier contenant la DB
    let octetsLibres = null, octetsTotal = null;
    try {
      const { execSync } = require('child_process');
      // `df -k` affiche les infos du volume en blocs de 1024 octets
      const lignes = execSync(`df -k "${dossier}"`).toString().trim().split('\n');
      const colonnes = lignes[1].trim().split(/\s+/);
      octetsTotal  = parseInt(colonnes[1], 10) * 1024;  // Taille totale du volume
      octetsLibres = parseInt(colonnes[3], 10) * 1024;  // Espace libre disponible
    } catch {
      // Si `df` échoue (Windows, permission...), on laisse null
      octetsLibres = null;
      octetsTotal  = null;
    }
    return {
      sizeBytes:      tailleOctets,
      sqliteMaxBytes: SQLITE_LIMITE_MAX_OCTETS,
      freeBytes:      octetsLibres,
      totalBytes:     octetsTotal,
      path:           cheminDb,
    };
  } catch {
    return { sizeBytes: 0, sqliteMaxBytes: SQLITE_LIMITE_MAX_OCTETS, freeBytes: null, path: cheminDb };
  }
});

/**
 * Exécute une requête SQL personnalisée sur la base de données.
 * Utilisé par la page SQL pour permettre à l'utilisateur d'exécuter des requêtes SQL.
 * @param {string} query - La requête SQL à exécuter
 * @returns {Promise<{columns: string[], values: any[][], rowCount: number}>}
 */
ipcMain.handle('sql:execute', async (_e, query) => {
  try {
    const db = getDbRaw();
    const results = db.exec(query);
    
    if (results.length === 0) {
      return { columns: [], values: [], rowCount: 0 };
    }
    
    const result = results[0];
    return {
      columns: result.columns,
      values: result.values,
      rowCount: result.values.length
    };
  } catch (error) {
    throw new Error(error.message);
  }
});

/**
 * Récupère la liste des tables de la base de données.
 * Utilisé par la page SQL pour afficher les tables disponibles.
 * @returns {Promise<string[]>}
 */
ipcMain.handle('sql:tables', () => {
  try {
    const db = getDbRaw();
    const results = db.exec(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `);
    if (!results || results.length === 0) {
      return [];
    }
    return results[0].values.map(row => row[0]);
  } catch (error) {
    throw new Error(error.message);
  }
});

/**
 * Récupère le chemin personnalisé de la base de données.
 * @returns {Promise<string|null>}
 */
ipcMain.handle('db:path:get', () => {
  const cheminUtilisateur = app.getPath('userData');
  const dbPathFile = path.join(cheminUtilisateur, 'db-path.json');
  
  if (fs.existsSync(dbPathFile)) {
    try {
      const customPath = JSON.parse(fs.readFileSync(dbPathFile, 'utf8')).dbPath;
      return customPath || null;
    } catch (e) {
      return null;
    }
  }
  return null;
});

/**
 * Sauvegarde le chemin personnalisé de la base de données.
 * @param {string} dbPath - Le nouveau chemin de la base de données
 * @returns {Promise<{ok: boolean, message: string}>}
 */
ipcMain.handle('db:path:set', async (_e, dbPath) => {
  try {
    const cheminUtilisateur = app.getPath('userData');
    const dbPathFile = path.join(cheminUtilisateur, 'db-path.json');
    
    if (!dbPath || typeof dbPath !== 'string') {
      // Supprimer le fichier si le chemin est vide
      if (fs.existsSync(dbPathFile)) {
        fs.unlinkSync(dbPathFile);
      }
      return { ok: true, message: 'Chemin réinitialisé (utilisation du chemin par défaut)' };
    }
    
    // Vérifier que le chemin est accessible
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      return { ok: false, message: 'Le dossier du chemin spécifié n\'existe pas' };
    }
    
    // Sauvegarder le chemin
    fs.writeFileSync(dbPathFile, JSON.stringify({ dbPath }), 'utf8');
    return { ok: true, message: 'Chemin sauvegardé. Redémarrez l\'application pour appliquer le changement.' };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

