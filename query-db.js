const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function queryDatabase() {
  // Déterminer le chemin de la base de données
  let dbPath;
  if (process.env.APPDATA) {
    // Windows
    dbPath = path.join(process.env.APPDATA, 'kelio-desktop', 'kelio.sqlite');
  } else if (process.platform === 'darwin') {
    // macOS
    dbPath = path.join(process.env.HOME, 'Library', 'Application Support', 'kelio-desktop', 'kelio.sqlite');
  } else {
    // Linux
    dbPath = path.join(process.env.HOME, '.config', 'kelio-desktop', 'kelio.sqlite');
  }
  
  console.log('Chemin de la base:', dbPath);

  if (!fs.existsSync(dbPath)) {
    console.log('❌ La base de données n\'existe pas');
    return;
  }

  // Lire la base de données
  const buffer = fs.readFileSync(dbPath);
  const SQL = await initSqlJs();
  const db = new SQL.Database(buffer);

  // Lister toutes les tables
  const result = db.exec(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `);
  const tables = result[0].values.map(row => row[0]);

  console.log('\n📊 Tables disponibles:');
  tables.forEach(table => console.log(`  - ${table}`));

  // Interface readline pour les requêtes interactives
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const askQuery = () => {
    rl.question('\n💬 Entrez votre requête SQL (ou "exit" pour quitter, "tables" pour voir les tables): ', (query) => {
      if (query.toLowerCase() === 'exit') {
        rl.close();
        return;
      }

      if (query.toLowerCase() === 'tables') {
        console.log('\n📊 Tables disponibles:');
        tables.forEach(table => console.log(`  - ${table}`));
        askQuery();
        return;
      }

      if (!query.trim()) {
        askQuery();
        return;
      }

      try {
        const results = db.exec(query);
        
        if (results.length === 0) {
          console.log('✓ Requête exécutée (pas de résultats)');
        } else {
          const result = results[0];
          const columns = result.columns;
          const values = result.values;

          console.log('\n📋 Résultats:');
          console.log('─'.repeat(80));
          
          // Afficher les en-têtes
          console.log(columns.map(col => col.padEnd(15)).join(' | '));
          console.log('─'.repeat(80));
          
          // Afficher les lignes
          values.forEach(row => {
            console.log(row.map(val => {
              const strVal = String(val ?? 'NULL');
              return strVal.length > 13 ? strVal.substring(0, 13) + '...' : strVal.padEnd(15);
            }).join(' | '));
          });
          
          console.log('─'.repeat(80));
          console.log(`\n📈 ${values.length} ligne(s) retournée(s)`);
        }
      } catch (error) {
        console.log('❌ Erreur:', error.message);
      }

      askQuery();
    });
  };

  console.log('\n💡 Exemples de requêtes:');
  console.log('  SELECT * FROM kelio_salarie LIMIT 10');
  console.log('  SELECT COUNT(*) FROM kelio_badgeage');
  console.log('  SELECT * FROM kelio_sync_run ORDER BY id DESC LIMIT 5');
  console.log('  SELECT employee_key, employee_surname, employee_first_name FROM kelio_salarie');
  
  askQuery();
}

queryDatabase().catch(console.error);
