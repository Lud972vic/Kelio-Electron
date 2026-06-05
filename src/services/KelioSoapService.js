'use strict';

/**
 * @file KelioSoapService.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — LE "CLIENT WEB SERVICE" KELIO
 * ============================================================
 *
 * Ce fichier contient une classe qui sait "parler" aux serveurs Kelio.
 * Les serveurs Kelio exposent leurs données via un protocole appelé SOAP.
 *
 * QU'EST-CE QUE SOAP ?
 * SOAP (Simple Object Access Protocol) est un protocole de communication
 * qui utilise le format XML pour échanger des messages via HTTP/HTTPS.
 * C'est plus ancien que REST/JSON, mais encore très utilisé dans les grands
 * logiciels RH et de gestion (SAP, Sage, Kelio...).
 *
 * FONCTIONNEMENT D'UN APPEL SOAP :
 *   1. On construit un message XML appelé "enveloppe SOAP"
 *      (comme une lettre dans une enveloppe, avec l'expéditeur et le contenu)
 *   2. On envoie ce message via HTTP POST à l'URL du service
 *   3. Le serveur répond avec un autre XML contenant les données demandées
 *   4. On parse (décode) ce XML pour extraire les valeurs
 *
 * POURQUOI PAS DE LIBRAIRIE SOAP ?
 * La librairie officielle "node-soap" est trop lourde pour Electron.
 * On fait donc tout à la main :
 *   - Construction de l'enveloppe XML : _buildEnvelope()
 *   - Envoi HTTP : _httpPost()
 *   - Parsing de la réponse XML : _extractList(), _tag()
 *
 * AUTHENTIFICATION :
 * Kelio utilise "Basic Auth" : on envoie login:password encodé en Base64
 * dans l'en-tête HTTP Authorization de chaque requête.
 *
 * SERVICES KELIO SUPPORTÉS :
 *   - LightEmployeeService              : liste des salariés
 *   - OrganizationChartLevelService     : organigramme
 *   - ClockingService                   : badgeages (pointages)
 *   - AbsenceFileService                : fiches d'absence
 *   - AbsenceRequestService             : demandes d'absence
 *   - DailyScheduleAssignmentService    : affectations horaires
 *   - JobAssignmentService              : affectations activité
 *   - SectionAssignmentDayPerDayService : affectations service j/j
 *   - TypeService                       : types de compteurs
 *   - *TotalService (x10)               : compteurs (heures, absences...)
 */

const https = require('https');  // Module Node.js pour les requêtes HTTPS
const http  = require('http');   // Module Node.js pour les requêtes HTTP
const { URL } = require('url'); // Pour analyser une URL (hostname, port, path...)

// =========================================================================
// AGENTS HTTP KEEP-ALIVE — OPTIMISATION PERFORMANCE
// =========================================================================
// Les agents Keep-Alive maintiennent les connexions TCP ouvertes entre les
// requêtes. Sans cela, chaque appel SOAP fait : DNS → TCP handshake → TLS → requête
// Avec Keep-Alive : seule la requête HTTP est envoyée sur la connexion existante.
// Gain typique : 30-50ms par appel sur des latences réseau élevées.
//
// maxSockets : nombre max de connexions simultanées par hôte
// maxFreeSockets : connexions gardées ouvertes en attente
// timeout : temps max d'inactivité avant fermeture
// =========================================================================
const keepAliveOptions = {
  keepAlive: true,
  keepAliveMsecs: 30000,    // Garder les connexions ouvertes 30s
  maxSockets: 20,           // Jusqu'à 20 connexions simultanées
  maxFreeSockets: 10,       // 10 connexions en attente réutilisables
  timeout: 60000,           // Timeout de la socket
  scheduling: 'fifo',     // First-in-first-out pour équité
};


class KelioSoapService {

  /**
   * Constructeur — configure le service avec les paramètres de connexion.
   * Appelé par ExtractionOrchestrator et main.js avec la config lue depuis SQLite.
   *
   * @param {Object} config - Configuration de connexion
   * @param {string} config.base_url      - URL de base du WS Kelio (ex: https://sandbox-ws.kelio.io/open)
   * @param {string} config.wsdl_base_url - URL pour accéder aux WSDL (peut être la même)
   * @param {string} config.login         - Login API Kelio (ex: api-ws)
   * @param {string} config.password      - Mot de passe API Kelio
   * @param {string} config.timeout       - Timeout en secondes (défaut: 60)
   * @param {string|boolean} config.verify_ssl - Vérifier le certificat SSL (défaut: false)
   */
  constructor(config) {
    this.config = config;
    // On enlève le slash final de l'URL pour éviter les doubles slashs
    this.baseUrl     = (config.base_url    || '').replace(/\/$/, '');
    this.wsdlBaseUrl = (config.wsdl_base_url || '').replace(/\/$/, '');
    this.login       = config.login    || '';
    this.password    = config.password || '';
    // Le timeout est stocké en secondes en config, on le convertit en millisecondes
    this.timeout     = parseInt(config.timeout || '60', 10) * 1000;
    // verify_ssl peut être '1' (string) ou true (booléen) selon la source
    this.verifySsl   = config.verify_ssl === '1' || config.verify_ssl === true;

    // Agents Keep-Alive par instance avec le bon réglage SSL.
    // IMPORTANT : quand un agent est fourni à http.request(), l'option
    // rejectUnauthorized de la requête est IGNORÉE par Node.js.
    // C'est l'agent qui doit porter le réglage. Sous Windows le store
    // de certificats système est utilisé, donc ça passait. Sous Linux
    // les agents globaux (sans rejectUnauthorized:false) bloquent les
    // certificats non reconnus → échec silencieux des extractions.
    this.httpsAgent = new https.Agent({
      ...keepAliveOptions,
      rejectUnauthorized: this.verifySsl,
    });
    this.httpAgent = new http.Agent(keepAliveOptions);
  }

  // =========================================================================
  // MÉTHODES PUBLIQUES D'EXPORTATION
  // Chaque méthode correspond à un service Kelio.
  // Elles suivent toutes le même schéma :
  //   1. Définir le nom du service et de la méthode SOAP
  //   2. Construire l'enveloppe XML avec _buildEnvelope()
  //   3. Envoyer la requête avec _soapCall()
  //   4. Extraire les résultats du XML de réponse
  //   5. Transformer chaque noeud XML en objet JavaScript
  // =========================================================================

  /**
   * Teste si la connexion au serveur Kelio fonctionne avec authentification.
   * On essaie de faire un vrai appel SOAP exportLightEmployees avec filtres vides.
   * Cela vérifie que l'URL, le login ET le mot de passe sont corrects.
   * Appelée par main.js lors du clic sur "Tester la connexion" dans Paramètres.
   *
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    try {
      // Test avec un vrai appel SOAP authentifié (pas juste le WSDL public)
      const result = await this.exportEmployees('', '');
      if (result.success) {
        return { success: true, message: 'Connexion SOAP OK (authentification validée)' };
      } else {
        return { success: false, message: `Échec d'authentification: ${result.message}` };
      }
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  /**
   * Exporte la liste de tous les salariés actifs depuis Kelio.
   * Appelée lors de l'extraction du module 'employees'.
   *
   * @param {string} populationFilter - Filtre de population optionnel (laisser vide = tous)
   * @param {string} groupFilter      - Filtre de groupe optionnel
   * @returns {Promise<{success, rows: Array<{employeeKey, employeeSurname, ...}>}>}
   */
  async exportEmployees(populationFilter, groupFilter) {
    const serviceName = 'LightEmployeeService';
    const methodName  = 'exportLightEmployees';
    const enveloppe = this._buildEnvelope(methodName, `
      <populationFilter>${this._esc(populationFilter || '')}</populationFilter>
      <groupFilter>${this._esc(groupFilter || '')}</groupFilter>
    `);
    const result = await this._soapCall(serviceName, methodName, enveloppe);
    if (!result.success) return result;

    // _extractList() trouve tous les noeuds XML <LightEmployee>...</LightEmployee>
    // et retourne leur contenu interne comme un tableau de strings XML.
    // _employeeFromNode() transforme chaque string XML en objet JavaScript.
    const noeudsXml = this._extractList(result.responseXml, 'LightEmployee');
    return { ...result, rows: noeudsXml.map(n => this._employeeFromNode(n)) };
  }

  /**
   * Exporte l'organigramme de l'entreprise (niveaux + sections).
   * Ce service ne nécessite aucun paramètre — l'enveloppe est vide.
   * Appelée lors de l'extraction du module 'organization'.
   *
   * @returns {Promise<{success, rows: Array}>}
   */
  async exportOrganizationChartLevels() {
    const serviceName = 'OrganizationChartLevelService';
    const methodName  = 'exportOrganizationChartLevels';
    const enveloppe = this._buildEnvelope(methodName, ''); // Pas de paramètres
    const result = await this._soapCall(serviceName, methodName, enveloppe);
    if (!result.success) return result;

    const noeudsXml = this._extractList(result.responseXml, 'OrganizationChartLevel');
    return { ...result, rows: noeudsXml.map(n => this._orgaFromNode(n)) };
  }

  async exportClockings(employeeKey, dateFrom, dateTo) {
    const serviceName = 'ClockingService';
    const methodName  = 'exportClockingsByDateForEmployeeList';
    const envelope = this._buildEnvelope(methodName, `
      <employeeList>
        <askedEmployee>
          <employeeKey>${this._esc(String(employeeKey))}</employeeKey>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
          <dateMode>0</dateMode>
        </askedEmployee>
      </employeeList>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const noeudsXml = this._extractList(result.responseXml, 'Clocking');
    return { ...result, rows: noeudsXml.map(n => this._clockingFromNode(n)) };
  }

  /**
   * Exporte les fiches d'absence validées d'un salarié.
   * Une "fiche" est une absence déjà traitée (pas une demande en attente).
   *
   * @param {string|number} employeeKey
   * @param {string} dateFrom
   * @param {string} dateTo
   * @returns {Promise<{success, rows: Array}>}
   */
  async exportAbsenceFiles(employeeKey, dateFrom, dateTo) {
    const serviceName = 'AbsenceFileService';
    const methodName  = 'exportAbsenceFilesFromEmployeeList';
    const envelope = this._buildEnvelope(methodName, `
      <employeeList>
        <askedEmployee>
          <employeeKey>${this._esc(String(employeeKey))}</employeeKey>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
          <dateMode>0</dateMode>
        </askedEmployee>
      </employeeList>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const noeudsXml = this._extractList(result.responseXml, 'AbsenceFile');
    return { ...result, rows: noeudsXml.map(n => this._absenceFileFromNode(n)) };
  }

  /**
   * Exporte les demandes d'absence d'un salarié (en attente ou traitées).
   * Différence avec les fiches : une demande peut encore être en attente de validation.
   *
   * @param {string|number} employeeKey
   * @param {string} dateFrom
   * @param {string} dateTo
   * @returns {Promise<{success, rows: Array}>}
   */
  async exportAbsenceRequests(employeeKey, dateFrom, dateTo) {
    const serviceName = 'AbsenceRequestService';
    const methodName  = 'exportAbsenceRequestsFromEmployeeList';
    const envelope = this._buildEnvelope(methodName, `
      <employeeList>
        <askedEmployee>
          <employeeKey>${this._esc(String(employeeKey))}</employeeKey>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
          <dateMode>0</dateMode>
        </askedEmployee>
      </employeeList>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const noeudsXml = this._extractList(result.responseXml, 'AbsenceRequest');
    return { ...result, rows: noeudsXml.map(n => this._absenceRequestFromNode(n)) };
  }

  /**
   * Exporte les affectations d'horaire jour par jour d'un salarié.
   * Indique quel planning (horaire théorique) était appliqué chaque jour.
   *
   * @param {string|number} employeeKey
   * @param {string} dateFrom
   * @param {string} dateTo
   * @returns {Promise<{success, rows: Array}>}
   */
  async exportDailyScheduleAssignments(employeeKey, dateFrom, dateTo) {
    const serviceName = 'DailyScheduleAssignmentService';
    const methodName  = 'exportDailyScheduleAssignmentsFromEmployeeList';
    const envelope = this._buildEnvelope(methodName, `
      <employeeList>
        <askedEmployee>
          <employeeKey>${this._esc(String(employeeKey))}</employeeKey>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
          <dateMode>0</dateMode>
        </askedEmployee>
      </employeeList>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const noeudsXml = this._extractList(result.responseXml, 'DailyScheduleAssignment');
    return { ...result, rows: noeudsXml.map(n => this._scheduleFromNode(n)) };
  }

  /**
   * Exporte les affectations d'activité (poste/tâche) d'un salarié.
   * Indique sur quelle activité le salarié était affecté chaque jour.
   *
   * NOTE : Ce service utilise une structure XML différente des autres :
   * le paramètre s'appelle <exportFilter> + <AskedJobAssignments>
   * et non <employeeList> + <askedEmployee> comme les autres services.
   * Cela a été découvert en analysant le WSDL du service.
   *
   * @param {string|number} employeeKey
   * @param {string} dateFrom
   * @param {string} dateTo
   * @returns {Promise<{success, rows: Array}>}
   */
  async exportJobAssignments(employeeKey, dateFrom, dateTo) {
    const serviceName = 'JobAssignmentService';
    const methodName  = 'exportComputedJobAssignmentsList';
    const envelope = this._buildEnvelope(methodName, `
      <exportFilter>
        <AskedJobAssignments>
          <employeeKey>${this._esc(String(employeeKey))}</employeeKey>
          <dateMode>0</dateMode>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
        </AskedJobAssignments>
      </exportFilter>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const noeudsXml = this._extractList(result.responseXml, 'ComputedJobAssignment');
    return { ...result, rows: noeudsXml.map(n => this._jobAssignFromNode(n)) };
  }

  /**
   * Exporte les affectations d'activité en mode PRÉVISIONNEL (forecast).
   * Utilise le matricule (IdentificationNumber) au lieu de la clé.
   */
  async exportJobAssignmentsForecast(employeeId, dateFrom, dateTo) {
    const serviceName = 'JobAssignmentService';
    const methodName  = 'exportComputedJobAssignmentsList';
    const envelope = this._buildEnvelope(methodName, `
      <exportFilter>
        <AskedJobAssignments>
          <employeeIdentificationNumber>${this._esc(String(employeeId))}</employeeIdentificationNumber>
          <populationMode>1</populationMode>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
          <dateMode>0</dateMode>
          <calculationMode>2</calculationMode>
        </AskedJobAssignments>
      </exportFilter>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const noeudsXml = this._extractList(result.responseXml, 'ComputedJobAssignment');
    return { ...result, rows: noeudsXml.map(n => this._jobAssignFromNode(n)) };
  }

  /**
   * Exporte les compteurs (totaux) d'un salarié pour un type de compteur donné.
   * Les compteurs représentent des valeurs calculées par Kelio :
   * heures travaillées, heures d'absence, heures supplémentaires, primes...
   *
   * Il existe 10 types de services de compteurs :
   *   Account, Balance, Absence, AbsenceBalance, LatenessEarlyDeparture,
   *   OvertimeHour, SpecialHour, Bonus, OnCallDuty, Job
   *
   * Le nom de la méthode SOAP est construit dynamiquement selon le mode :
   *   - JOUR : exportActualDaily{Stem}TotalsFromDateToDateForEmployeeList
   *   - MOIS : exportActualPeriodical{Stem}TotalsListFromDateToDateForEmployeeList
   *
   * @param {string} serviceName   - Ex: 'AccountTotalService'
   * @param {string} accountType   - Ex: 'ACCOUNT', 'ABSENCE'...
   * @param {string} modePeriode   - 'JOUR' ou 'MOIS'
   * @param {string|number} employeeKey
   * @param {string} dateFrom
   * @param {string} dateTo
   * @returns {Promise<{success, rows: Array}>}
   */
  async exportTotals(serviceName, accountType, modePeriode, employeeKey, dateFrom, dateTo) {
    // _totalStem() convertit le nom du service en "radical" pour composer le nom de méthode
    // Ex: 'AccountTotalService' → 'Account' → 'exportActualDailyAccountTotalsFrom...'
    const stem = this._totalStem(serviceName);
    const methodName = modePeriode === 'JOUR'
      ? `exportActualDaily${stem}TotalsFromDateToDateForEmployeeList`
      : `exportActualPeriodical${stem}TotalsListFromDateToDateForEmployeeList`;

    const envelope = this._buildEnvelope(methodName, `
      <employeeList>
        <askedEmployee>
          <employeeKey>${this._esc(String(employeeKey))}</employeeKey>
          <dateMode>0</dateMode>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
          <calculationMode>0</calculationMode>
        </askedEmployee>
      </employeeList>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    // _extractTotals() essaie plusieurs noms de tags XML possibles selon le type de réponse
    const lignesResultat = this._extractTotals(result.responseXml);
    return { ...result, rows: lignesResultat };
  }

  /**
   * Exporte les types de compteurs disponibles dans Kelio.
   * Utilisé pour afficher les libellés des compteurs (ex: "Théorique", "Réel"...).
   *
   * @param {string} accountTypeCode - Code du type de compteur (ex: 'ACCOUNT')
   * @returns {Promise<{success, rows: Array}>}
   */
  async exportGenericTypes(accountTypeCode) {
    const serviceName = 'TypeService';
    const methodName  = 'exportGenericTypes';
    const envelope = this._buildEnvelope(methodName, `
      <exportFilter>
        <TypeFilter>
          <accountType>${this._esc(String(accountTypeCode))}</accountType>
        </TypeFilter>
      </exportFilter>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const rows = this._extractList(result.responseXml, 'GenericType');
    return { ...result, rows: rows.map(n => this._genericTypeFromNode(n)) };
  }

  // =========================================================================
  // MÉTHODES PRIVÉES — HELPERS INTERNES
  // Ces méthodes commencent par _ (convention : elles sont "privées",
  // réservées à l'usage interne de la classe).
  // =========================================================================

  /**
   * Convertit un nom de service en "radical" pour construire le nom de méthode SOAP.
   * Ex: 'AccountTotalService' → 'Account'
   *     'AbsenceTotalService' → 'Absence'
   * Ce radical s'insère ensuite dans : 'exportActualDaily{Radical}Totals...'
   *
   * @param {string} serviceName - Nom complet du service (ex: 'BonusTotalService')
   * @returns {string} Le radical correspondant
   */
  _totalStem(serviceName) {
    const correspondances = {
      AccountTotalService:                'Account',
      LatenessEarlyDepartureTotalService: 'LatenessEarlyDeparture',
      BalanceTotalService:                'Balance',
      AbsenceTotalService:                'Absence',
      AbsenceBalanceTotalService:         'AbsenceBalance',
      OvertimeHourTotalService:           'OvertimeHour',
      SpecialHourTotalService:            'SpecialHour',
      BonusTotalService:                  'Bonus',
      OnCallDutyTotalService:             'OnCallDuty',
      JobTotalService:                    'Job',
    };
    return correspondances[serviceName] ?? 'Account'; // 'Account' par défaut si inconnu
  }

  /**
   * Construit une enveloppe SOAP complète au format XML.
   *
   * Structure d'une enveloppe SOAP :
   *   <soapenv:Envelope>        ← La "lettre"
   *     <soapenv:Header/>       ← En-tête (vide ici)
   *     <soapenv:Body>          ← Le contenu de la lettre
   *       <tns:nomDeLaMethode>  ← L'appel de fonction
   *         ... paramètres ... ← Les arguments
   *       </tns:nomDeLaMethode>
   *     </soapenv:Body>
   *   </soapenv:Envelope>
   *
   * xmlns:soapenv et xmlns:tns sont des "espaces de noms XML" (namespaces)
   * qui indiquent au serveur comment interpréter les balises.
   *
   * @param {string} nomMethode   - Nom de la méthode SOAP (ex: 'exportLightEmployees')
   * @param {string} contenuBody  - XML des paramètres à insérer dans le body
   * @returns {string} L'enveloppe XML complète sous forme de chaîne
   */
  _buildEnvelope(nomMethode, contenuBody) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:tns="http://www.kelio.fr/ws">
  <soapenv:Header/>
  <soapenv:Body>
    <tns:${nomMethode}>
      ${contenuBody}
    </tns:${nomMethode}>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * Envoie une requête SOAP et retourne la réponse.
   * C'est la méthode centrale : toutes les méthodes d'export l'appellent.
   *
   * Avant d'envoyer, elle vérifie que login et baseUrl sont configurés.
   * Elle mesure aussi la durée de l'appel (pour les logs de performance).
   *
   * @param {string} nomService - Nom du service Kelio (ex: 'ClockingService')
   * @param {string} nomMethode - Nom de la méthode SOAP (ex: 'exportClockingsByDate...')
   * @param {string} enveloppe  - L'enveloppe XML complète (produite par _buildEnvelope)
   * @returns {Promise<{success: boolean, message: string, responseXml?: string, durationMs: number}>}
   */
  async _soapCall(nomService, nomMethode, enveloppe) {
    // Sécurité : si la config est incomplète, on retourne une erreur immédiatement
    if (!this.login) {
      return { success: false, message: 'Login non configuré — allez dans Paramètres.', durationMs: 0 };
    }
    if (!this.baseUrl) {
      return { success: false, message: 'URL de base non configurée — allez dans Paramètres.', durationMs: 0 };
    }
    // Construction de l'URL finale : baseUrl + /services/ + nomDuService
    // Ex: https://sandbox-ws.kelio.io/open/services/ClockingService
    const urlEndpoint = `${this.baseUrl}/services/${nomService}`;
    const debutMs = Date.now(); // On note le moment de départ pour mesurer la durée
    try {
      const xmlReponse = await this._httpPost(urlEndpoint, enveloppe, nomMethode);
      const dureeMs = Date.now() - debutMs;
      return { success: true, message: 'OK', responseXml: xmlReponse, durationMs: dureeMs };
    } catch (e) {
      const dureeMs = Date.now() - debutMs;
      const messageErreur = `[${this.login}@${urlEndpoint}] ${e.message}`;
      return { success: false, message: messageErreur, durationMs: dureeMs };
    }
  }

  /**
   * Envoie une requête HTTP POST avec le corps XML fourni.
   * Retourne une Promise qui se résout avec le XML de réponse.
   *
   * En-têtes HTTP envoyées :
   *   - Content-Type: text/xml  → indique que le corps est du XML
   *   - SOAPAction            → indique au serveur quelle méthode est appelée
   *   - Authorization: Basic  → authentification login:password en Base64
   *   - Content-Length        → taille du corps en octets (obligatoire)
   *
   * @param {string} url        - URL complète du endpoint (ex: https://...kelio.io/.../ClockingService)
   * @param {string} corpsXml   - L'enveloppe SOAP à envoyer
   * @param {string} soapAction - Nom de la méthode (inséré dans l'en-tête SOAPAction)
   * @returns {Promise<string>} - Le XML de la réponse du serveur
   */
  _httpPost(url, corpsXml, soapAction) {
    return new Promise((resolve, reject) => {
      const urlAnalysee = new URL(url);
      // Encodage Base64 du login:password pour l'authentification HTTP Basic
      const credentialsBase64 = Buffer.from(`${this.login}:${this.password}`).toString('base64');
      const optionsRequete = {
        hostname: urlAnalysee.hostname,
        port:     urlAnalysee.port || (urlAnalysee.protocol === 'https:' ? 443 : 80),
        path:     urlAnalysee.pathname + urlAnalysee.search,
        method:   'POST',
        headers: {
          'Content-Type':   'text/xml; charset=utf-8',
          'SOAPAction':     `"${soapAction}"`,           // Required by SOAP protocol
          'Authorization':  `Basic ${credentialsBase64}`,
          'Content-Length': Buffer.byteLength(corpsXml), // Taille en octets
          'Connection':     'keep-alive',                 // Explicitement demander le keep-alive
        },
        timeout: this.timeout,
        agent: urlAnalysee.protocol === 'https:' ? this.httpsAgent : this.httpAgent, // Agent avec réglage SSL correct
      };

      // On choisit le bon module selon le protocole (http:// ou https://)
      const moduleHttp = urlAnalysee.protocol === 'https:' ? https : http;
      const requete = moduleHttp.request(optionsRequete, (reponse) => {
        let donneesRecues = '';
        reponse.setEncoding('utf8');
        // Les données arrivent par "chunks" (morceaux), on les accumule
        reponse.on('data', morceau => { donneesRecues += morceau; });
        reponse.on('end', () => {
          // Un code HTTP 400+ indique une erreur (ex: 500 = erreur serveur)
          if (reponse.statusCode >= 400) {
            reject(new Error(`HTTP ${reponse.statusCode}: ${donneesRecues.slice(0, 300)}`));
          } else {
            resolve(donneesRecues); // Succès : on retourne le XML complet
          }
        });
      });

      requete.on('error', reject);
      requete.on('timeout', () => { requete.destroy(); reject(new Error('Timeout SOAP')); });
      requete.write(corpsXml); // Envoie l'enveloppe XML
      requete.end();           // Termine la requête
    });
  }

  /**
   * Envoie une requête HTTP GET (utilisée uniquement pour télécharger les WSDL).
   *
   * @param {string} url - URL du WSDL à télécharger
   * @returns {Promise<string>} - Le contenu XML du WSDL
   */
  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const urlAnalysee = new URL(url);
      const credentialsBase64 = Buffer.from(`${this.login}:${this.password}`).toString('base64');
      const optionsRequete = {
        hostname: urlAnalysee.hostname,
        port:     urlAnalysee.port || (urlAnalysee.protocol === 'https:' ? 443 : 80),
        path:     urlAnalysee.pathname + urlAnalysee.search,
        method:   'GET',
        headers: { 'Authorization': `Basic ${credentialsBase64}` },
        timeout: this.timeout,
        agent: urlAnalysee.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
      };
      const moduleHttp = urlAnalysee.protocol === 'https:' ? https : http;
      const requete = moduleHttp.request(optionsRequete, (reponse) => {
        let donneesRecues = '';
        reponse.setEncoding('utf8');
        reponse.on('data', morceau => { donneesRecues += morceau; });
        reponse.on('end', () => resolve(donneesRecues));
      });
      requete.on('error', reject);
      requete.on('timeout', () => { requete.destroy(); reject(new Error('Timeout')); });
      requete.end();
    });
  }

  /**
   * Extrait tous les noeuds XML d'un nom de tag donné depuis une chaîne XML.
   * Supporte les tags avec préfixe de namespace (ex: <ns1:Clocking> ou <Clocking>).
   *
   * Exemple :
   *   xml = '<ns1:Clocking><date>2024-01-01</date></ns1:Clocking>'
   *   _extractList(xml, 'Clocking') → ['<date>2024-01-01</date>']
   *
   * La regex <[^:>]*:?Clocking[^>]*> capture :
   *   - <Clocking>      (sans préfixe)
   *   - <ns1:Clocking>  (avec préfixe de namespace)
   *
   * @param {string} xml      - Le XML complet de la réponse SOAP
   * @param {string} nomTag   - Nom du tag à rechercher (sensible à la casse)
   * @returns {string[]} Tableau du contenu interne de chaque tag trouvé
   */
  _extractList(xml, nomTag) {
    if (!xml) return [];
    // La regex gère les préfixes de namespace XML (ex: ns1:, tns:, soap:...)
    const regex = new RegExp(`<[^:>]*:?${nomTag}[^>]*>([\\s\\S]*?)<\/[^:>]*:?${nomTag}>`, 'g');
    const resultats = [];
    let correspondance;
    while ((correspondance = regex.exec(xml)) !== null) {
      resultats.push(correspondance[1]); // [1] = le contenu entre les balises
    }
    return resultats;
  }

  /**
   * Extrait les lignes de totaux depuis une réponse XML de service de compteurs.
   * Kelio utilise différents noms de tags selon le type de total :
   *   - DailyTotal           : totaux journaliers
   *   - PeriodicTotal        : totaux périodiques
   *   - FromDateToDateTotal  : totaux sur une période libre
   *   - PerpetualTotal       : compteurs perpetuels (cumulatifs)
   *   - WeeklyTotal          : totaux hebdomadaires
   * On essaie chaque tag dans l'ordre jusqu'à en trouver un qui existe.
   *
   * @param {string} xml - XML de réponse SOAP
   * @returns {Array} Tableau d'objets total
   */
  _extractTotals(xml) {
    if (!xml) return [];
    for (const nomTagTotal of ['DailyTotal', 'PeriodicTotal', 'FromDateToDateTotal', 'PerpetualTotal', 'WeeklyTotal', 'item', 'return']) {
      const noeuds = this._extractList(xml, nomTagTotal);
      if (noeuds.length) return noeuds.map(n => this._totalFromNode(n));
    }
    return [];
  }

  /**
   * Extrait la valeur d'un tag XML dans un noeud XML (chaîne).
   * Supporte les préfixes de namespace (ex: <ns1:date> ou <date>).
   * Décode automatiquement les entités XML en caractères lisibles :
   *   &amp;  → &
   *   &lt;   → <
   *   &gt;   → >
   *   &#xe9; → é  (entité hexadécimale)
   *   &#233; → é  (entité décimale)
   * Sans ce décodage, les prénoms comme "Salomé" s'afficheraient "Salom&#xe9;".
   *
   * @param {string} noeudXml - Fragment XML contenant le tag à lire
   * @param {string} nomTag   - Nom du tag à extraire
   * @returns {string|null}  La valeur décodée, ou null si le tag est absent
   */
  _tag(noeudXml, nomTag) {
    const correspondance = noeudXml.match(
      new RegExp(`<[^:>]*:?${nomTag}[^>]*>([\\s\\S]*?)<\/[^:>]*:?${nomTag}>`)
    );
    if (!correspondance) return null;
    // Décodage des entités XML et HTML, pas à pas :
    return correspondance[1].trim()
      .replace(/&amp;/g,  '&')                                                // & encodé
      .replace(/&lt;/g,   '<')                                                // < encodé
      .replace(/&gt;/g,   '>')                                                // > encodé
      .replace(/&quot;/g, '"')                                               // " encodé
      .replace(/&apos;/g, "'")                                               // ' encodé
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))  // &#xe9; → é
      .replace(/&#([0-9]+);/g,        (_, dec) => String.fromCharCode(parseInt(dec, 10))); // &#233; → é
  }

  /**
   * Encode une valeur pour l'insérer sûrement dans du XML.
   * Sans cet encodage, un salarié dont le nom contient & ou < casserait le XML.
   * Ex: "Dupont & Durand" → "Dupont &amp; Durand"
   *
   * @param {*} valeur - La valeur à encoder (sera convertie en string)
   * @returns {string} La valeur encodée, safe pour insertion XML
   */
  _esc(valeur) {
    return String(valeur ?? '')
      .replace(/&/g,  '&amp;')   // IMPORTANT : toujours remplacer & en premier !
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g, '&quot;');
  }

  // =========================================================================
  // FONCTIONS DE MAPPING XML → OBJET JAVASCRIPT
  // Ces fonctions reçoivent le contenu interne d'un noeud XML (string)
  // et retournent un objet JavaScript avec les champs nommés.
  // =========================================================================

  /**
   * Transforme un noeud XML <LightEmployee> en objet JavaScript.
   * @param {string} n - Contenu XML interne du noeud
   * @returns {{employeeKey, employeeSurname, employeeFirstName, ...}}
   */
  _employeeFromNode(n) {
    return {
      // Identifiants salarié
      employeeKey:                   this._tag(n, 'employeeKey'),
      employeeIdentificationNumber:  this._tag(n, 'employeeIdentificationNumber'),
      employeeIdentificationCode:    this._tag(n, 'employeeIdentificationCode'),
      employeeBadgeCode:             this._tag(n, 'employeeBadgeCode'),
      employeeSurname:               this._tag(n, 'employeeSurname'),
      employeeFirstName:             this._tag(n, 'employeeFirstName'),
      archivedEmployee:              this._tag(n, 'archivedEmployee') === 'true',

      // Dates de prise en compte
      takenIntoAccountStartDate:       this._tag(n, 'takenIntoAccountStartDate'),
      takenIntoAccountEndDate:         this._tag(n, 'takenIntoAccountEndDate'),
      takenIntoAccountPeriodStartDate: this._tag(n, 'takenIntoAccountPeriodStartDate'),
      takenIntoAccountPeriodEndDate:   this._tag(n, 'takenIntoAccountPeriodEndDate'),

      // Données par défaut
      defaultEmployeeBadge:           this._tag(n, 'defaultEmployeeBadge'),
      defaultEmployeeFirstName:       this._tag(n, 'defaultEmployeeFirstName'),
      defaultEmployeeIdentificationCode: this._tag(n, 'defaultEmployeeIdentificationCode'),
      defaultEmployeeIdentificationNumber: this._tag(n, 'defaultEmployeeIdentificationNumber'),
      defaultEmployeeSurname:         this._tag(n, 'defaultEmployeeSurname'),

      // Autorisations d'accès pour l'affectation en cours
      currentAccessAuthorizationStartDate: this._tag(n, 'currentAccessAuthorizationStartDate'),
      currentAccessAuthorizationStartTime: this._tag(n, 'currentAccessAuthorizationStartTime'),
      currentAccessAuthorizationEndDate:   this._tag(n, 'currentAccessAuthorizationEndDate'),
      currentAccessAuthorizationEndTime:   this._tag(n, 'currentAccessAuthorizationEndTime'),

      // Flags et options
      generateBadge:                 this._tag(n, 'generateBadge') === 'true',
      isAccessModuleEmployee:        this._tag(n, 'isAccessModuleEmployee') === 'true',
      isTandAModuleEmployee:         this._tag(n, 'isTandAModuleEmployee') === 'true',
      searchUsingBadge:              this._tag(n, 'searchUsingBadge') === 'true',
      searchUsingFirstname:          this._tag(n, 'searchUsingFirstname') === 'true',
      searchUsingIdentificationNumber: this._tag(n, 'searchUsingIdentificationNumber') === 'true',
      searchUsingSurname:            this._tag(n, 'searchUsingSurname') === 'true',

      // Filtres population
      populationFilter:              this._tag(n, 'populationFilter'),
      groupFilter:                   this._tag(n, 'groupFilter'),
      populationMode:                this._tag(n, 'populationMode'),
      populationStartDate:           this._tag(n, 'populationStartDate'),
      populationEndDate:             this._tag(n, 'populationEndDate'),

      // Erreur et clé technique
      errorMessage:                  this._tag(n, 'errorMessage'),
      technicalString:               this._tag(n, 'technicalString'),

      // Profil exploitant
      useDefaultModelEmployee:       this._tag(n, 'useDefaultModelEmployee') === 'true',
      userProfileAssignmentWizardDescription: this._tag(n, 'userProfileAssignmentWizardDescription'),
      userProfileAssignmentWizardKey: this._tag(n, 'userProfileAssignmentWizardKey'),
    };
  }

  _orgaFromNode(n) {
    return {
      // Niveau d'organigramme
      organizationChartLevelKey:          this._tag(n, 'organizationChartLevelKey'),
      organizationChartLevelAbbreviation: this._tag(n, 'organizationChartLevelAbbreviation'),
      organizationChartLevelDescription:  this._tag(n, 'organizationChartLevelDescription'),
      organizationChartLevelDescriptionType: this._tag(n, 'organizationChartLevelDescriptionType'),
      levelType:                          this._tag(n, 'levelType'),
      manager:                             this._tag(n, 'manager'),
      fullAbbreviation:                   this._tag(n, 'fullAbbreviation'),
      fullDescription:                    this._tag(n, 'fullDescription'),
      levels:                             this._tag(n, 'levels'),
      technicalString:                    this._tag(n, 'technicalString'),

      // Service
      sectionKey:                         this._tag(n, 'sectionKey'),
      sectionAbbreviation:                this._tag(n, 'sectionAbbreviation'),
      sectionDescription:                  this._tag(n, 'sectionDescription'),
      sectionManager:                     this._tag(n, 'sectionManager'),

      // Département
      departmentKey:                       this._tag(n, 'departmentKey'),
      departmentAbbreviation:             this._tag(n, 'departmentAbbreviation'),
      departmentDescription:             this._tag(n, 'departmentDescription'),
      departmentManager:                  this._tag(n, 'departmentManager'),

      // Sous-département
      subDepartmentKey:                   this._tag(n, 'subDepartmentKey'),
      subDepartmentAbbreviation:          this._tag(n, 'subDepartmentAbbreviation'),
      subDepartmentDescription:           this._tag(n, 'subDepartmentDescription'),
      subDepartmentManager:               this._tag(n, 'subDepartmentManager'),

      // Société
      firmKey:                             this._tag(n, 'firmKey'),
      firmAbbreviation:                    this._tag(n, 'firmAbbreviation'),
      firmDescription:                     this._tag(n, 'firmDescription'),
      firmManager:                         this._tag(n, 'firmManager'),

      // Niveaux 4 à 8
      level4Key:                           this._tag(n, 'level4Key'),
      level4Abbreviation:                  this._tag(n, 'level4Abbreviation'),
      level4Description:                   this._tag(n, 'level4Description'),
      level4Manager:                       this._tag(n, 'level4Manager'),

      level5Key:                           this._tag(n, 'level5Key'),
      level5Abbreviation:                  this._tag(n, 'level5Abbreviation'),
      level5Description:                   this._tag(n, 'level5Description'),
      level5Manager:                       this._tag(n, 'level5Manager'),

      level6Key:                           this._tag(n, 'level6Key'),
      level6Abbreviation:                  this._tag(n, 'level6Abbreviation'),
      level6Description:                   this._tag(n, 'level6Description'),
      level6Manager:                       this._tag(n, 'level6Manager'),

      level7Key:                           this._tag(n, 'level7Key'),
      level7Abbreviation:                  this._tag(n, 'level7Abbreviation'),
      level7Description:                   this._tag(n, 'level7Description'),
      level7Manager:                       this._tag(n, 'level7Manager'),

      level8Key:                           this._tag(n, 'level8Key'),
      level8Abbreviation:                  this._tag(n, 'level8Abbreviation'),
      level8Description:                   this._tag(n, 'level8Description'),
      level8Manager:                       this._tag(n, 'level8Manager'),

      // Entreprise
      companyKey:                          this._tag(n, 'companyKey'),
      companyDescription:                  this._tag(n, 'companyDescription'),
      companyPhoneNumber:                  this._tag(n, 'companyPhoneNumber'),
      companyFaxNumber:                    this._tag(n, 'companyFaxNumber'),
      companyMailAddress:                  this._tag(n, 'companyMailAddress'),
      companyWebAddress:                   this._tag(n, 'companyWebAddress'),
      companyFileNumber:                   this._tag(n, 'companyFileNumber'),

      // Erreur
      errorMessage:                        this._tag(n, 'errorMessage'),
    };
  }

  _clockingFromNode(n) {
    return {
      clockingKey:                     this._tag(n, 'clockingKey'),
      date:                            this._tag(n, 'date'),
      time:                            this._tag(n, 'time'),
      inOutIndicator:                  this._tag(n, 'inOutIndicator'),
      terminalKey:                     this._tag(n, 'terminalKey'),
      readerKey:                       this._tag(n, 'readerKey'),
      
      // Champs additionnels de la documentation Kelio
      absenceTypeAbbreviation:         this._tag(n, 'absenceTypeAbbreviation'),
      absenceTypeDescription:          this._tag(n, 'absenceTypeDescription'),
      absenceTypeKey:                  this._tag(n, 'absenceTypeKey'),
      archivedEmployee:                this._tag(n, 'archivedEmployee') === 'true',
      automatic:                       this._tag(n, 'automatic') === 'true',
      clockingTypeIndicator:           this._tag(n, 'clockingTypeIndicator'),
      employeeBadgeCode:               this._tag(n, 'employeeBadgeCode'),
      employeeFirstName:               this._tag(n, 'employeeFirstName'),
      employeeIdentificationCode:     this._tag(n, 'employeeIdentificationCode'),
      employeeIdentificationNumber:    this._tag(n, 'employeeIdentificationNumber'),
      employeeKey:                     this._tag(n, 'employeeKey'),
      employeeSurname:                 this._tag(n, 'employeeSurname'),
      errorMessage:                    this._tag(n, 'errorMessage'),
      geolocationPrecision:            this._tag(n, 'geolocationPrecision'),
      geolocationStatus:               this._tag(n, 'geolocationStatus'),
      latitude:                        this._tag(n, 'latitude'),
      longitude:                       this._tag(n, 'longitude'),
      obtainingMode:                   this._tag(n, 'obtainingMode'),
      overtimeTypeAbbreviation:        this._tag(n, 'overtimeTypeAbbreviation'),
      overtimeTypeDescription:         this._tag(n, 'overtimeTypeDescription'),
      overtimeTypeKey:                 this._tag(n, 'overtimeTypeKey'),
      readerDescription:               this._tag(n, 'readerDescription'),
      technicalString:                 this._tag(n, 'technicalString'),
      terminalDescription:             this._tag(n, 'terminalDescription'),
      timePosition:                    this._tag(n, 'timePosition'),
    };
  }

  _absenceFileFromNode(n) {
    return {
      absenceFileKey:        this._tag(n, 'absenceFileKey'),
      absenceTypeKey:        this._tag(n, 'absenceTypeKey'),
      absenceTypeAbbreviation:this._tag(n, 'absenceTypeAbbreviation'),
      absenceTypeDescription:this._tag(n, 'absenceTypeDescription'),
      startDate:             this._tag(n, 'startDate'),
      endDate:               this._tag(n, 'endDate'),
      durationInDays:        this._tag(n, 'durationInDays'),
      statusCode:            this._tag(n, 'statusCode'),
      
      // Champs additionnels de la documentation Kelio
      archivedEmployee:      this._tag(n, 'archivedEmployee') === 'true',
      comment:               this._tag(n, 'comment'),
      creationDate:          this._tag(n, 'creationDate'),
      durationInHours:       this._tag(n, 'durationInHours'),
      employeeBadgeCode:     this._tag(n, 'employeeBadgeCode'),
      employeeFirstName:     this._tag(n, 'employeeFirstName'),
      employeeIdentificationCode: this._tag(n, 'employeeIdentificationCode'),
      employeeIdentificationNumber: this._tag(n, 'employeeIdentificationNumber'),
      employeeKey:           this._tag(n, 'employeeKey'),
      employeeSurname:       this._tag(n, 'employeeSurname'),
      endingTheAfternoon:    this._tag(n, 'endingTheAfternoon') === 'true',
      errorMessage:          this._tag(n, 'errorMessage'),
      eventObservingDate:    this._tag(n, 'eventObservingDate'),
      existRelatedDocument:  this._tag(n, 'existRelatedDocument') === 'true',
      firstEndTime:          this._tag(n, 'firstEndTime'),
      firstEndTimePosition:  this._tag(n, 'firstEndTimePosition'),
      firstStartTime:        this._tag(n, 'firstStartTime'),
      firstStartTimePosition:this._tag(n, 'firstStartTimePosition'),
      initialNoticeCessationWorkDate: this._tag(n, 'initialNoticeCessationWorkDate'),
      lastModificationDate:  this._tag(n, 'lastModificationDate'),
      lastWorkingDayDate:    this._tag(n, 'lastWorkingDayDate'),
      limitedToAPeriod:      this._tag(n, 'limitedToAPeriod') === 'true',
      noticeCessationWorkExtension: this._tag(n, 'noticeCessationWorkExtension') === 'true',
      numberOfAbsenceDays:   this._tag(n, 'numberOfAbsenceDays'),
      prescribedEndDate:     this._tag(n, 'prescribedEndDate'),
      repetitiveAbsencePeriod: this._tag(n, 'repetitiveAbsencePeriod'),
      resumptionWorkDate:    this._tag(n, 'resumptionWorkDate'),
      resumptionWorkEarlyDate: this._tag(n, 'resumptionWorkEarlyDate'),
      secondEndTime:         this._tag(n, 'secondEndTime'),
      secondEndTimePosition: this._tag(n, 'secondEndTimePosition'),
      secondStartTime:       this._tag(n, 'secondStartTime'),
      secondStartTimePosition: this._tag(n, 'secondStartTimePosition'),
      splitHolidaysWaiver:   this._tag(n, 'splitHolidaysWaiver'),
      startInTheMorning:     this._tag(n, 'startInTheMorning') === 'true',
      technicalString:       this._tag(n, 'technicalString'),
      totalInDays:           this._tag(n, 'totalInDays'),
      totalInHours:          this._tag(n, 'totalInHours'),
    };
  }

  _absenceRequestFromNode(n) {
    return {
      absenceRequestKey:     this._tag(n, 'absenceRequestKey'),
      absenceTypeKey:        this._tag(n, 'absenceTypeKey'),
      absenceTypeDescription:this._tag(n, 'absenceTypeDescription'),
      startDate:             this._tag(n, 'startDate'),
      endDate:               this._tag(n, 'endDate'),
      durationInDays:        this._tag(n, 'durationInDays'),
      requestState:          this._tag(n, 'requestState'),
      
      // Champs additionnels de la documentation Kelio
      absenceFileKey:         this._tag(n, 'absenceFileKey'),
      absenceTypeAbbreviation:this._tag(n, 'absenceTypeAbbreviation'),
      archivedEmployee:       this._tag(n, 'archivedEmployee') === 'true',
      comment:                this._tag(n, 'comment'),
      creationDate:           this._tag(n, 'creationDate'),
      durationInHours:        this._tag(n, 'durationInHours'),
      employeeBadgeCode:      this._tag(n, 'employeeBadgeCode'),
      employeeFirstName:      this._tag(n, 'employeeFirstName'),
      employeeIdentificationCode: this._tag(n, 'employeeIdentificationCode'),
      employeeIdentificationNumber: this._tag(n, 'employeeIdentificationNumber'),
      employeeKey:            this._tag(n, 'employeeKey'),
      employeeSurname:        this._tag(n, 'employeeSurname'),
      endingTheAfternoon:     this._tag(n, 'endingTheAfternoon') === 'true',
      errorMessage:           this._tag(n, 'errorMessage'),
      firstEndTime:           this._tag(n, 'firstEndTime'),
      firstEndTimePosition:  this._tag(n, 'firstEndTimePosition'),
      firstStartTime:         this._tag(n, 'firstStartTime'),
      firstStartTimePosition:this._tag(n, 'firstStartTimePosition'),
      lastModificationDate:   this._tag(n, 'lastModificationDate'),
      requestType:            this._tag(n, 'requestType'),
      secondEndTime:          this._tag(n, 'secondEndTime'),
      secondEndTimePosition: this._tag(n, 'secondEndTimePosition'),
      secondStartTime:        this._tag(n, 'secondStartTime'),
      secondStartTimePosition: this._tag(n, 'secondStartTimePosition'),
      splitHolidaysWaiver:    this._tag(n, 'splitHolidaysWaiver'),
      startInTheMorning:      this._tag(n, 'startInTheMorning') === 'true',
      technicalString:        this._tag(n, 'technicalString'),
      totalInDays:            this._tag(n, 'totalInDays'),
      totalInHours:           this._tag(n, 'totalInHours'),
      validatorsBadgeCodes:   this._tag(n, 'validatorsBadgeCodes'),
      validatorsFirstNames:   this._tag(n, 'validatorsFirstNames'),
      validatorsIdentificationCode: this._tag(n, 'validatorsIdentificationCode'),
      validatorsIdentificationNumbers: this._tag(n, 'validatorsIdentificationNumbers'),
      validatorsKeys:         this._tag(n, 'validatorsKeys'),
      validatorsLogins:       this._tag(n, 'validatorsLogins'),
      validatorsSurnames:     this._tag(n, 'validatorsSurnames'),
    };
  }

  _scheduleFromNode(n) {
    return {
      assignmentDate:           this._tag(n, 'assignmentDate'),
      dailyScheduleKey:         this._tag(n, 'dailyScheduleKey'),
      dailyScheduleAbbreviation:this._tag(n, 'dailyScheduleAbbreviation'),
      dailyScheduleDescription: this._tag(n, 'dailyScheduleDescription'),
      scheduleAbbreviation:     this._tag(n, 'scheduleAbbreviation'),
      scheduleDescription:      this._tag(n, 'scheduleDescription'),
      
      // Champs additionnels de la documentation Kelio
      afternoonContractedTime:  this._tag(n, 'afternoonContractedTime'),
      archivedEmployee:         this._tag(n, 'archivedEmployee') === 'true',
      assignementByException:   this._tag(n, 'assignementByException') === 'true',
      calculationModeContractedSchedule: this._tag(n, 'calculationModeContractedSchedule'),
      comment:                  this._tag(n, 'comment'),
      contractedTime:           this._tag(n, 'contractedTime'),
      employeeBadgeCode:        this._tag(n, 'employeeBadgeCode'),
      employeeFirstName:        this._tag(n, 'employeeFirstName'),
      employeeIdentificationCode: this._tag(n, 'employeeIdentificationCode'),
      employeeIdentificationNumber: this._tag(n, 'employeeIdentificationNumber'),
      employeeKey:              this._tag(n, 'employeeKey'),
      employeeSurname:          this._tag(n, 'employeeSurname'),
      errorMessage:             this._tag(n, 'errorMessage'),
      fifthWorkingPeriodEndTime: this._tag(n, 'fifthWorkingPeriodEndTime'),
      fifthWorkingPeriodEndTimePosition: this._tag(n, 'fifthWorkingPeriodEndTimePosition'),
      fifthWorkingPeriodStartTime: this._tag(n, 'fifthWorkingPeriodStartTime'),
      fifthWorkingPeriodStartTimePosition: this._tag(n, 'fifthWorkingPeriodStartTimePosition'),
      firstWorkingPeriodEndTime: this._tag(n, 'firstWorkingPeriodEndTime'),
      firstWorkingPeriodEndTimePosition: this._tag(n, 'firstWorkingPeriodEndTimePosition'),
      firstWorkingPeriodStartTime: this._tag(n, 'firstWorkingPeriodStartTime'),
      firstWorkingPeriodStartTimePosition: this._tag(n, 'firstWorkingPeriodStartTimePosition'),
      fourthWorkingPeriodEndTime: this._tag(n, 'fourthWorkingPeriodEndTime'),
      fourthWorkingPeriodEndTimePosition: this._tag(n, 'fourthWorkingPeriodEndTimePosition'),
      fourthWorkingPeriodStartTime: this._tag(n, 'fourthWorkingPeriodStartTime'),
      fourthWorkingPeriodStartTimePosition: this._tag(n, 'fourthWorkingPeriodStartTimePosition'),
      halfDayTime:              this._tag(n, 'halfDayTime'),
      morningContractedTime:    this._tag(n, 'morningContractedTime'),
      nightStartTime:           this._tag(n, 'nightStartTime'),
      nightStartTimePosition:   this._tag(n, 'nightStartTimePosition'),
      secondWorkingPeriodEndTime: this._tag(n, 'secondWorkingPeriodEndTime'),
      secondWorkingPeriodEndTimePosition: this._tag(n, 'secondWorkingPeriodEndTimePosition'),
      secondWorkingPeriodStartTime: this._tag(n, 'secondWorkingPeriodStartTime'),
      secondWorkingPeriodStartTimePosition: this._tag(n, 'secondWorkingPeriodStartTimePosition'),
      technicalString:          this._tag(n, 'technicalString'),
      thirdWorkingPeriodEndTime: this._tag(n, 'thirdWorkingPeriodEndTime'),
      thirdWorkingPeriodEndTimePosition: this._tag(n, 'thirdWorkingPeriodEndTimePosition'),
      thirdWorkingPeriodStartTime: this._tag(n, 'thirdWorkingPeriodStartTime'),
      thirdWorkingPeriodStartTimePosition: this._tag(n, 'thirdWorkingPeriodStartTimePosition'),
    };
  }

  async exportSectionAssignments(employeeKey, dateFrom, dateTo) {
    const serviceName = 'SectionAssignmentDayPerDayService';
    const methodName  = 'exportSectionAssignmentsDayPerDayList';
    const envelope = this._buildEnvelope(methodName, `
      <employeeList>
        <askedEmployee>
          <employeeKey>${this._esc(String(employeeKey))}</employeeKey>
          <dateMode>0</dateMode>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
        </askedEmployee>
      </employeeList>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const rows = this._extractList(result.responseXml, 'SectionAssignmentDayPerDay');
    return { ...result, rows: rows.map(n => this._sectionAssignFromNode(n)) };
  }

  /**
   * Exporte les affectations de service j/j en mode PRÉVISIONNEL (forecast).
   * Utilise le matricule (IdentificationNumber) et AskedPopulationWithPeriod.
   */
  async exportSectionAssignmentsForecast(employeeId, dateFrom, dateTo) {
    const serviceName = 'SectionAssignmentDayPerDayService';
    const methodName  = 'exportSectionAssignmentsDayPerDayList';
    const envelope = this._buildEnvelope(methodName, `
      <exportFilter>
        <AskedPopulationWithPeriod>
          <employeeIdentificationNumber>${this._esc(String(employeeId))}</employeeIdentificationNumber>
          <populationMode>1</populationMode>
          <startDate>${this._esc(dateFrom)}</startDate>
          <endDate>${this._esc(dateTo)}</endDate>
          <dateMode>0</dateMode>
          <calculationMode>2</calculationMode>
        </AskedPopulationWithPeriod>
      </exportFilter>
    `);
    const result = await this._soapCall(serviceName, methodName, envelope);
    if (!result.success) return result;
    const rows = this._extractList(result.responseXml, 'SectionAssignmentDayPerDay');
    return { ...result, rows: rows.map(n => this._sectionAssignFromNode(n)) };
  }

  _jobAssignFromNode(n) {
    return {
      assignmentDate:     this._tag(n, 'assignmentDate') ?? this._tag(n, 'date'),
      jobKey:             this._tag(n, 'jobKey'),
      jobAbbreviation:    this._tag(n, 'jobAbbreviation'),
      jobDescription:     this._tag(n, 'jobDescription'),
      employeeBadgeCode:  this._tag(n, 'employeeBadgeCode'),
      employeeFirstName:  this._tag(n, 'employeeFirstName'),
      employeeIdentificationCode: this._tag(n, 'employeeIdentificationCode'),
      employeeIdentificationNumber: this._tag(n, 'employeeIdentificationNumber'),
      employeeKey:        this._tag(n, 'employeeKey'),
      employeeSurname:    this._tag(n, 'employeeSurname'),
      archivedEmployee:   this._tag(n, 'archivedEmployee') === 'true',
      errorMessage:       this._tag(n, 'errorMessage'),
      technicalString:    this._tag(n, 'technicalString'),
    };
  }

  /** Transforme un noeud XML <SectionAssignmentDayPerDay> en objet JavaScript. */
  _sectionAssignFromNode(n) {
    return {
      // ?? : si assignmentDate est null, on essaie le tag <date> à la place
      assignmentDate:      this._tag(n, 'assignmentDate') ?? this._tag(n, 'date'),
      sectionKey:          this._tag(n, 'sectionKey'),
      sectionAbbreviation: this._tag(n, 'sectionAbbreviation'),
      sectionDescription:  this._tag(n, 'sectionDescription'),
      comment:             this._tag(n, 'comment'),
    };
  }

  /** Transforme un noeud XML <GenericType> en objet JavaScript (types de compteurs). */
  _genericTypeFromNode(n) {
    return {
      typeKey:          this._tag(n, 'typeKey'),
      typeAbbreviation: this._tag(n, 'typeAbbreviation'),
      typeDescription:  this._tag(n, 'typeDescription'),
      accountType:      this._tag(n, 'accountType'),
      unitCode:         this._tag(n, 'unit'),
    };
  }

  /**
   * Transforme un noeud XML de total (DailyTotal, PeriodicTotal...) en objet JavaScript.
   * Les valeurs numériques (hours, days...) sont converties en float ou null.
   * parseFloat('NaN') retourne NaN, et NaN || null retourne null — pratique !
   */
  _totalFromNode(n) {
    return {
      employeeKey:                  this._tag(n, 'employeeKey'),
      employeeIdentificationNumber: this._tag(n, 'employeeIdentificationNumber'),
      employeeSurname:              this._tag(n, 'employeeSurname'),
      employeeFirstName:            this._tag(n, 'employeeFirstName'),
      archivedEmployee:             this._tag(n, 'archivedEmployee') === 'true',
      sectionKey:                   this._tag(n, 'sectionKey'),
      sectionDescription:           this._tag(n, 'sectionDescription'),
      typeKey:                      this._tag(n, 'typeKey'),
      typeAbbreviation:             this._tag(n, 'typeAbbreviation'),
      typeDescription:              this._tag(n, 'typeDescription'),
      date:                         this._tag(n, 'date'),          // Date du jour (mode JOUR)
      periodStartDate:              this._tag(n, 'periodStartDate'), // Début de période (mode MOIS)
      periodEndDate:                this._tag(n, 'periodEndDate'),   // Fin de période (mode MOIS)
      // parseFloat + || null : si la valeur est absente ou invalide, on met null
      hours:         parseFloat(this._tag(n, 'hours')         ?? 'NaN') || null,
      physicalHours: parseFloat(this._tag(n, 'physicalHours') ?? 'NaN') || null,
      days:          parseFloat(this._tag(n, 'days')          ?? 'NaN') || null,
      number:        parseFloat(this._tag(n, 'number')        ?? 'NaN') || null,
    };
  }
}

module.exports = KelioSoapService;
