'use strict';

/**
 * @file settings.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — PAGE "PARAMÈTRES"
 * ============================================================
 *
 * Gère deux sections :
 *   1. Configuration de connexion Kelio (URL, login, mot de passe, SSL...)
 *   2. Maintenance de la base de données (purge des tables)
 *
 * CONFIGURATION KELIO :
 * Les paramètres sont chargés depuis la base SQLite (ConfigRepository)
 * via l'IPC 'config:get'. Au clic "Enregistrer", ils sont sauvegardés via 'config:save'.
 * On peut aussi tester la connexion WSDL (ping) sans sauvegarder.
 *
 * PURGE DES TABLES :
 * Chaque bouton de purge appelle l'IPC 'db:purge' avec le nom de la table.
 * Un confirm() natif demande confirmation avant toute suppression.
 * "TOUT PURGER" enchaîne plusieurs purges dans l'ordre (logs en premier).
 *
 * APPELÉ PAR : app.js (navigate('settings'))
 */

const SettingsPage = (() => {

  /**
   * Génère et injecte le HTML de la page Paramètres.
   * Le formulaire de configuration est d'abord un spinner,
   * puis remplacé par le vrai formulaire via _loadForm().
   *
   * @param {HTMLElement} container
   */
  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Paramètres</div>
          <div class="page-subtitle">Configuration de la connexion à l'API Kelio</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Connexion Kelio SOAP</div>
        <div id="settingsForm">
          <div style="padding:24px;text-align:center;"><span class="spinner"></span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Chemin de la base de données</div>
        <div id="dbPathForm">
          <div style="padding:24px;text-align:center;"><span class="spinner"></span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Maintenance base de données</div>
        <div style="margin-bottom:14px;">
          <button class="btn btn-danger" id="btnPurgeAll">🗑 TOUT PURGER — Remettre à zéro toutes les données</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          ${purgeBtn('kelio_salarie',            '🗑 Purger salariés')}
          ${purgeBtn('kelio_resultat_total',      '🗑 Purger résultats')}
          ${purgeBtn('kelio_badgeage',            '🗑 Purger badgeages')}
          ${purgeBtn('kelio_absence_fiche',       '🗑 Purger fiches absence')}
          ${purgeBtn('kelio_absence_demande',     '🗑 Purger demandes absence')}
          ${purgeBtn('kelio_horaire_affectation', '🗑 Purger horaires')}
          ${purgeBtn('kelio_affectation_activite',     '🗑 Purger affectations activité')}
          ${purgeBtn('kelio_affectation_service_jour','🗑 Purger services jour/jour')}
          ${purgeBtn('kelio_organigramme',             '🗑 Purger organigramme')}
          ${purgeBtn('kelio_sync_run',            '🗑 Purger historique runs')}
        </div>
        <div class="form-hint" style="margin-top:12px;">
          Ces actions suppriment définitivement les données de la table correspondante dans le fichier SQLite local.
        </div>
      </div>
    `;

    // Délégation d'événement : un seul listener pour tous les boutons de purge
    container.querySelector('.card:last-child').addEventListener('click', (e) => {
      if (e.target.closest('#btnPurgeAll')) { _purgeAll(); return; }
      const btn = e.target.closest('[data-purge-table]');
      if (btn) _purge(btn.dataset.purgeTable);
    });

    await _loadForm();
    await _loadDbPathForm();
  }

  /**
   * Retourne un conseil SSL adapté à l'OS détecté.
   * Sous Windows, le store de certificats système est utilisé automatiquement.
   * Sous Linux/macOS, Node.js utilise son propre bundle CA ; si le certificat
   * du serveur Kelio n'y figure pas, il faut désactiver la vérification SSL.
   *
   * @returns {string} - HTML du hint
   */
  function _sslHint() {
    const platform = window.KelioAPI.platform;
    const osLabel = platform === 'win32' ? 'Windows'
                  : platform === 'darwin' ? 'macOS'
                  : 'Linux';

    const osIcon = platform === 'win32' ? '🪟'
                 : platform === 'darwin' ? '🍎'
                 : '🐧';

    let conseil = `${osIcon} <strong>OS détecté : ${osLabel}</strong><br>`;

    if (platform === 'win32') {
      conseil += 'Windows utilise le store de certificats système. Si le certificat Kelio est reconnu par Windows, vous pouvez activer la vérification SSL.';
    } else if (platform === 'darwin') {
      conseil += 'macOS utilise son Trousseau d\'accès. Si le certificat Kelio est dans le trousseau, activez SSL. Sinon, désactivez pour éviter les échecs silencieux.';
    } else {
      conseil += 'Linux n\'utilise pas de store système pour Node.js. <strong>Recommandation : désactivez la vérification SSL</strong> sauf si vous avez installé le certificat Kelio dans <code>/etc/ssl/certs/</code>.';
    }
    return conseil;
  }

  /**
   * Génère le HTML d'un bouton de purge pour une table spécifique.
   * L'attribut `data-purge-table` est lu par la délégation d'événement.
   *
   * @param {string} table - Nom de la table SQLite (ex: 'kelio_salarie')
   * @param {string} label - Texte du bouton
   * @returns {string} - HTML
   */
  function purgeBtn(table, label) {
    return `<button class="btn btn-danger btn-sm" data-purge-table="${Utils.esc(table)}">${Utils.esc(label)}</button>`;
  }

  /**
   * Charge le formulaire de chemin de base de données personnalisé.
   */
  async function _loadDbPathForm() {
    const formulaire = document.getElementById('dbPathForm');
    try {
      const customPath = await window.KelioAPI.dbPathGet();
      const dbInfo = await window.KelioAPI.dbInfo();
      const currentPath = customPath || dbInfo.path;
      const isCustom = !!customPath;
      
      formulaire.innerHTML = `
        <div class="form-group">
          <label class="form-label">Chemin personnalisé de la base de données</label>
          <input type="text" class="form-control" id="cfgDbPath"
            value="${Utils.esc(customPath || '')}"
            placeholder="Laisser vide pour utiliser le chemin par défaut" />
          <span class="form-hint">
            <strong>Chemin actuel :</strong> ${Utils.esc(currentPath)} ${isCustom ? '(personnalisé)' : '(par défaut)'}<br>
            Chemin absolu vers le fichier kelio.sqlite (ex: /chemin/vers/kelio.sqlite ou \\\\serveur\\partage\\kelio.sqlite).<br>
            ⚠️ <strong>Attention :</strong> SQLite n'est pas optimisé pour le multi-utilisateur simultané sur réseau.<br>
            Utilisez un chemin réseau uniquement si l'accès est séquentiel (un utilisateur à la fois).
          </span>
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button class="btn btn-primary" id="btnSaveDbPath">💾 Enregistrer le chemin</button>
          <button class="btn btn-ghost" id="btnResetDbPath">↺ Réinitialiser (chemin par défaut)</button>
        </div>
        <div id="dbPathResult" style="margin-top:8px;font-size:13px;"></div>
      `;
      document.getElementById('btnSaveDbPath').addEventListener('click', _saveDbPath);
      document.getElementById('btnResetDbPath').addEventListener('click', _resetDbPath);
    } catch (erreur) {
      formulaire.innerHTML = `<div class="empty-state"><div class="empty-icon">✕</div><p>Erreur: ${Utils.esc(erreur.message)}</p></div>`;
    }
  }

  /**
   * Sauvegarde le chemin personnalisé de la base de données.
   */
  async function _saveDbPath() {
    const dbPath = document.getElementById('cfgDbPath')?.value?.trim() || '';
    const btn = document.getElementById('btnSaveDbPath');
    const resultDiv = document.getElementById('dbPathResult');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sauvegarde…';
    resultDiv.textContent = '';

    try {
      const result = await window.KelioAPI.dbPathSet(dbPath);
      if (result.ok) {
        resultDiv.innerHTML = `<span style="color:var(--color-success);">✓ ${Utils.esc(result.message)}</span>`;
        Toast.success(result.message);
      } else {
        resultDiv.innerHTML = `<span style="color:var(--color-danger);">✕ ${Utils.esc(result.message)}</span>`;
        Toast.error(result.message);
      }
    } catch (erreur) {
      resultDiv.innerHTML = `<span style="color:var(--color-danger);">✕ ${Utils.esc(erreur.message)}</span>`;
      Toast.error(`Erreur: ${erreur.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '💾 Enregistrer le chemin';
    }
  }

  /**
   * Réinitialise le chemin de la base de données au chemin par défaut.
   */
  async function _resetDbPath() {
    const btn = document.getElementById('btnResetDbPath');
    const resultDiv = document.getElementById('dbPathResult');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Réinitialisation…';
    resultDiv.textContent = '';

    try {
      const result = await window.KelioAPI.dbPathSet('');
      if (result.ok) {
        document.getElementById('cfgDbPath').value = '';
        resultDiv.innerHTML = `<span style="color:var(--color-success);">✓ ${Utils.esc(result.message)}</span>`;
        Toast.success(result.message);
      } else {
        resultDiv.innerHTML = `<span style="color:var(--color-danger);">✕ ${Utils.esc(result.message)}</span>`;
        Toast.error(result.message);
      }
    } catch (erreur) {
      resultDiv.innerHTML = `<span style="color:var(--color-danger);">✕ ${Utils.esc(erreur.message)}</span>`;
      Toast.error(`Erreur: ${erreur.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '↺ Réinitialiser (chemin par défaut)';
    }
  }

  /**
   * Charge les paramètres depuis la base et construit le formulaire HTML.
   * Remplace le spinner initial par les champs réels.
   * Appelée une seule fois par render().
   */
  async function _loadForm() {
    const formulaire = document.getElementById('settingsForm');
    try {
      const cfg = await window.KelioAPI.configGet(); // Charge la config actuelle
      formulaire.innerHTML = `
        <div class="form-grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));">
          <div class="form-group">
            <label class="form-label">URL de base API</label>
            <input type="text" class="form-control" id="cfgBaseUrl"
              value="${Utils.esc(cfg.base_url || 'https://sandbox-ws.kelio.io/open')}"
              placeholder="https://sandbox-ws.kelio.io/open" />
            <span class="form-hint">Ex: https://sandbox-ws.kelio.io/open</span>
          </div>
          <div class="form-group">
            <label class="form-label">URL de base WSDL</label>
            <input type="text" class="form-control" id="cfgWsdlUrl"
              value="${Utils.esc(cfg.wsdl_base_url || 'https://sandbox-ws.kelio.io/open/services')}"
              placeholder="https://sandbox-ws.kelio.io/open/services" />
            <span class="form-hint">Ex: https://sandbox-ws.kelio.io/open/services</span>
          </div>
          <div class="form-group">
            <label class="form-label">Login</label>
            <input type="text" class="form-control" id="cfgLogin"
              value="${Utils.esc(cfg.login || 'api-ws')}"
              placeholder="api-ws" autocomplete="username" />
          </div>
          <div class="form-group">
            <label class="form-label">Mot de passe</label>
            <input type="password" class="form-control" id="cfgPassword"
              value="${Utils.esc(cfg.password || 'api-sandbox')}"
              placeholder="••••••••" autocomplete="current-password" />
          </div>
          <div class="form-group">
            <label class="form-label">Timeout (secondes)</label>
            <input type="number" class="form-control" id="cfgTimeout"
              value="${Utils.esc(cfg.timeout ?? '60')}" min="10" max="300" />
          </div>
          <div class="form-group">
            <label class="form-label">Certificats SSL</label>
            <select class="form-control" id="cfgVerifySsl">
              <option value="0" ${cfg.verify_ssl === '0' ? 'selected' : ''}>Non (désactivé — ignorer les erreurs SSL)</option>
              <option value="1" ${cfg.verify_ssl === '1' ? 'selected' : ''}>Oui (activé — vérifier le certificat)</option>
            </select>
            <span class="form-hint">${_sslHint()}</span>
          </div>
          <div class="form-group">
            <label class="form-label">Parallélisme (concurrence)</label>
            <input type="number" class="form-control" id="cfgConcurrency"
              value="${Utils.esc(cfg.concurrency ?? '20')}" min="1" max="50" />
            <span class="form-hint">
              Nombre d'appels API simultanés. 20 = rapide mais charge le serveur. 
              <br>⚠️ Baissez à 5-8 si le serveur Kelio est lent ou distant.
            </span>
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-primary" id="btnSave">💾 Enregistrer</button>
          <button class="btn btn-ghost" id="btnTestConnect">
            ⚡ Tester la connexion
          </button>
          <span id="testResult" style="font-size:13px;"></span>
        </div>
      `;
      document.getElementById('btnSave').addEventListener('click', _save);
      document.getElementById('btnTestConnect').addEventListener('click', _testConnection);
    } catch (erreur) {
      formulaire.innerHTML = `<div class="empty-state"><div class="empty-icon">✕</div><p>Erreur: ${Utils.esc(erreur.message)}</p></div>`;
    }
  }

  /**
   * Valide et sauvegarde le formulaire de configuration.
   * Appelée au clic "Enregistrer".
   */
  async function _save() {
    const config = _readForm();
    if (!config.base_url) { Toast.error('URL de base obligatoire.'); return; }
    if (!config.login)    { Toast.error('Login obligatoire.'); return; }

    try {
      await window.KelioAPI.configSave(config);
      Toast.success('Paramètres enregistrés.');
    } catch (erreur) {
      Toast.error(`Erreur: ${erreur.message}`);
    }
  }

  /**
   * Teste la connexion Kelio sans sauvegarder.
   * Utilise les valeurs actuellement saisies dans le formulaire (pas celles en base).
   * Affiche le résultat inline + un toast.
   */
  async function _testConnection() {
    const config            = _readForm();
    const btnTest           = document.getElementById('btnTestConnect');
    const elementResultat   = document.getElementById('testResult');

    btnTest.disabled  = true;
    btnTest.innerHTML = '<span class="spinner"></span> Test…';
    elementResultat.textContent = '';

    try {
      const resultat = await window.KelioAPI.configTestConnect(config);
      if (resultat.success) {
        elementResultat.innerHTML = `<span style="color:var(--color-success);">✓ ${Utils.esc(resultat.message)}</span>`;
        Toast.success('Connexion WSDL OK !');
      } else {
        elementResultat.innerHTML = `<span style="color:var(--color-danger);">✕ ${Utils.esc(resultat.message)}</span>`;
        Toast.error(`Connexion échouée: ${resultat.message}`);
      }
    } catch (erreur) {
      elementResultat.innerHTML = `<span style="color:var(--color-danger);">✕ ${Utils.esc(erreur.message)}</span>`;
    } finally {
      btnTest.disabled  = false;
      btnTest.innerHTML = '⚡ Tester la connexion';
    }
  }

  /**
   * Lit les valeurs actuelles du formulaire et retourne un objet config.
   * Utilisé par _save() et _testConnection().
   * L'opérateur ?. (optional chaining) protège si le formulaire n'est pas encore monté.
   *
   * @returns {{base_url, wsdl_base_url, login, password, timeout, verify_ssl, concurrency}}
   */
  function _readForm() {
    return {
      base_url:      document.getElementById('cfgBaseUrl')?.value?.trim()   ?? '',
      wsdl_base_url: document.getElementById('cfgWsdlUrl')?.value?.trim()   ?? '',
      login:         document.getElementById('cfgLogin')?.value?.trim()     ?? '',
      password:      document.getElementById('cfgPassword')?.value          ?? '',
      timeout:       document.getElementById('cfgTimeout')?.value           ?? '60',
      verify_ssl:    document.getElementById('cfgVerifySsl')?.value         ?? '0',
      concurrency:   document.getElementById('cfgConcurrency')?.value      ?? '20',
    };
  }

  /**
   * Supprime toutes les données d'une table après confirmation.
   * L'IPC 'db:purge' vérifie que la table est dans la liste blanche avant de purger.
   *
   * @param {string} table - Nom exact de la table SQLite
   */
  async function _purge(table) {
    const confirme = confirm(`Supprimer TOUTES les données de "${table}" ?\nCette action est irréversible.`);
    if (!confirme) return;
    try {
      const reponse = await window.KelioAPI.dbPurge(table);
      if (reponse.ok) Toast.success(`Table ${table} purgée.`);
      else            Toast.error(`Purge refusée: ${reponse.reason}`);
    } catch (erreur) {
      Toast.error(`Erreur purge: ${erreur.message}`);
    }
  }

  /**
   * Purge toutes les tables de données en séquence, après confirmation.
   * L'ordre est important : les logs sont supprimés en premier
   * (ils référencent les runs via clé étrangère).
   */
  async function _purgeAll() {
    const confirme = confirm(
      'Supprimer TOUTES les données importées (salariés, résultats, badgeages, absences, horaires, activités, organigramme, historique) ?\n\nCette action est irréversible.'
    );
    if (!confirme) return;

    // Ordre de purge : d'abord les tables dépendantes (logs), puis les parents (runs)
    const tablesOrdonnees = [
      'kelio_sync_log',                    // D'abord les logs (FK vers sync_run)
      'kelio_salarie', 'kelio_resultat_total', 'kelio_badgeage',
      'kelio_absence_fiche', 'kelio_absence_demande', 'kelio_horaire_affectation',
      'kelio_affectation_activite', 'kelio_affectation_service_jour', 'kelio_organigramme',
      'kelio_sync_run',                    // En dernier (référencé par les logs)
    ];
    try {
      for (const table of tablesOrdonnees) {
        await window.KelioAPI.dbPurge(table);
      }
      Toast.success('Toutes les données ont été supprimées.');
    } catch (erreur) {
      Toast.error(`Erreur purge globale: ${erreur.message}`);
    }
  }

  return { render, _save, _testConnection, _purge };
})();
