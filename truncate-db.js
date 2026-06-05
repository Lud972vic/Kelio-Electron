const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function truncateDatabase() {
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
    console.log('La base de données n\'existe pas');
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

  console.log('\nTables trouvées:', tables);

  // Vider toutes les tables (sauf kelio_schema_version et kelio_ws_catalogue)
  const tablesToSkip = ['kelio_schema_version', 'kelio_ws_catalogue'];
  const tablesToTruncate = tables.filter(t => !tablesToSkip.includes(t));

  console.log('\nVidage des tables...');
  for (const table of tablesToTruncate) {
    db.run(`DELETE FROM ${table}`);
    console.log(`✓ Table ${table} vidée`);
  }

  // Réinitialiser les séquences AUTOINCREMENT
  console.log('\nRéinitialisation des séquences...');
  for (const table of tablesToTruncate) {
    try {
      db.run(`DELETE FROM sqlite_sequence WHERE name='${table}'`);
    } catch (e) {
      // La table n'a peut-être pas de séquence
    }
  }

  // Compresser la base avec VACUUM
  console.log('\nCompression de la base (VACUUM)...');
  db.run('VACUUM');
  console.log('✓ Base compressée');

  // Sauvegarder la base
  const data = db.export();
  const newBuffer = Buffer.from(data);
  fs.writeFileSync(dbPath, newBuffer);

  // Afficher la taille avant/après
  const oldSize = buffer.length;
  const newSize = newBuffer.length;
  const savedBytes = oldSize - newSize;
  const savedPercent = ((savedBytes / oldSize) * 100).toFixed(2);

  console.log('\n=== Résultat ===');
  console.log(`Taille avant: ${(oldSize / 1024).toFixed(2)} KB`);
  console.log(`Taille après: ${(newSize / 1024).toFixed(2)} KB`);
  console.log(`Espace gagné: ${(savedBytes / 1024).toFixed(2)} KB (${savedPercent}%)`);
  console.log('\n✓ Base de données vidée et compressée avec succès');
}

truncateDatabase().catch(console.error);
