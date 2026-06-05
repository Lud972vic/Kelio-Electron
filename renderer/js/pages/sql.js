'use strict';

const SqlPage = (() => {
  let savedQueries = [];

  async function render(container) {
    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Requêtes SQL</div>
          <div class="page-subtitle">Exécutez des requêtes SQL personnalisées sur la base de données</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">📊 Tables disponibles</div>
        <div id="tablesList" class="tables-list"><span class="spinner"></span></div>
      </div>

      <div class="card">
        <div class="card-title">💬 Éditeur SQL</div>
        <div class="sql-editor-container">
          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">Requêtes enregistrées</label>
            <select id="sqlQuerySelect" class="form-control">
              <option value="">-- Sélectionner une requête --</option>
            </select>
          </div>
          <textarea
            id="sqlQuery"
            class="sql-editor"
            placeholder="Entrez votre requête SQL ici..."
            rows="12"
          ></textarea>
          <div class="sql-actions">
            <button id="btnExecute" class="btn btn-primary">▶ Exécuter</button>
            <button id="btnExport" class="btn btn-secondary">↓ Export CSV</button>
            <button id="btnClear" class="btn btn-secondary">✕ Effacer</button>
          </div>
        </div>
      </div>

      <div class="card" id="resultsCard" style="display:none;">
        <div class="card-title">📋 Résultats <span id="rowCount" class="badge"></span></div>
        <div id="resultsContainer" class="results-container"></div>
      </div>
    `;

    // Charger les tables et les requêtes
    loadTables();
    loadSavedQueries();

    // Event listeners
    document.getElementById('btnExecute').addEventListener('click', executeQuery);
    document.getElementById('btnExport').addEventListener('click', exportToCsv);
    document.getElementById('btnClear').addEventListener('click', () => {
      document.getElementById('sqlQuery').value = '';
      document.getElementById('resultsCard').style.display = 'none';
    });
    document.getElementById('sqlQuerySelect').addEventListener('change', (e) => {
      const queryData = savedQueries.find(q => q.name === e.target.value);
      if (queryData) {
        document.getElementById('sqlQuery').value = queryData.query;
      }
    });

    // Exécuter avec Ctrl+Enter
    document.getElementById('sqlQuery').addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') {
        executeQuery();
      }
    });
  }

  async function loadTables() {
    try {
      const tables = await window.KelioAPI.sqlTables();
      const container = document.getElementById('tablesList');
      container.innerHTML = tables.map(table =>
        `<span class="table-tag" data-table="${table}">${table}</span>`
      ).join('');

      // Cliquer sur une table l'insère dans l'éditeur
      container.querySelectorAll('.table-tag').forEach(tag => {
        tag.addEventListener('click', () => {
          const editor = document.getElementById('sqlQuery');
          const tableName = tag.dataset.table;
          editor.value = `SELECT * FROM ${tableName} LIMIT 100;`;
          editor.focus();
        });
      });
    } catch (error) {
      document.getElementById('tablesList').innerHTML =
        `<div class="error">Erreur: ${error.message}</div>`;
    }
  }

  async function loadSavedQueries() {
    try {
      const response = await fetch('./js/pages/sql-queries.json');
      savedQueries = await response.json();
      const select = document.getElementById('sqlQuerySelect');
      savedQueries.forEach(q => {
        const option = document.createElement('option');
        option.value = q.name;
        option.textContent = q.name;
        select.appendChild(option);
      });
    } catch (error) {
      console.error('Erreur lors du chargement des requêtes:', error);
    }
  }

  async function executeQuery() {
    const query = document.getElementById('sqlQuery').value.trim();
    if (!query) {
      Toast.show('Veuillez entrer une requête SQL', 'error');
      return;
    }

    const btn = document.getElementById('btnExecute');
    btn.disabled = true;
    btn.textContent = '⏳ Exécution...';

    try {
      const result = await window.KelioAPI.sqlExecute(query);
      displayResults(result);
      Toast.show('Requête exécutée avec succès', 'success');
    } catch (error) {
      Toast.show(`Erreur SQL: ${error.message}`, 'error');
      document.getElementById('resultsCard').style.display = 'none';
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Exécuter';
    }
  }

  function displayResults(result) {
    const resultsCard = document.getElementById('resultsCard');
    const resultsContainer = document.getElementById('resultsContainer');
    const rowCount = document.getElementById('rowCount');

    if (result.rowCount === 0) {
      resultsCard.style.display = 'block';
      resultsContainer.innerHTML = '<div class="empty-state"><p>Aucun résultat</p></div>';
      rowCount.textContent = '';
      return;
    }

    rowCount.textContent = `${result.rowCount} ligne(s)`;
    resultsCard.style.display = 'block';

    let html = '<div class="sql-table-wrapper"><table class="sql-table"><thead><tr>';

    // En-têtes
    html += result.columns.map(col => `<th>${escapeHtml(col)}</th>`).join('');
    html += '</tr></thead><tbody>';

    // Données
    result.values.forEach(row => {
      html += '<tr>';
      html += row.map(val => `<td>${escapeHtml(String(val ?? 'NULL'))}</td>`).join('');
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    resultsContainer.innerHTML = html;

    // Stocker le résultat pour l'export CSV
    window.lastSqlResult = result;
  }

  function exportToCsv() {
    const result = window.lastSqlResult;
    if (!result || result.rowCount === 0) {
      Toast.show('Aucun résultat à exporter', 'error');
      return;
    }

    // Créer le contenu CSV
    const headers = result.columns.join(';');
    const rows = result.values.map(row => row.map(val => {
      const str = String(val ?? '');
      // Échapper les guillemets et entourer si contient un séparateur
      if (str.includes(';') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(';')).join('\n');

    const csvContent = headers + '\n' + rows;

    // Créer et télécharger le fichier
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `sql_export_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    Toast.show('Export CSV réussi', 'success');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  return { render };
})();
