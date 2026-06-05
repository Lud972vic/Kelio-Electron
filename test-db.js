const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

console.log('Test better-sqlite3 sur Windows...\n');

try {
  // Test 1: Créer une base de données simple
  const testDbPath = path.join(__dirname, 'test.sqlite');
  console.log('Chemin de test:', testDbPath);
  
  const db = new Database(testDbPath);
  console.log('✓ Base de données créée avec succès');
  
  // Test 2: Créer une table
  db.exec('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)');
  console.log('✓ Table créée avec succès');
  
  // Test 3: Insérer des données
  const insert = db.prepare('INSERT INTO test (name) VALUES (?)');
  insert.run('Test Windows');
  console.log('✓ Données insérées avec succès');
  
  // Test 4: Lire des données
  const row = db.prepare('SELECT * FROM test').get();
  console.log('✓ Données lues:', row);
  
  db.close();
  
  // Nettoyer
  fs.unlinkSync(testDbPath);
  console.log('✓ Fichier de test supprimé');
  
  console.log('\n✓ Tous les tests sont passés - better-sqlite3 fonctionne correctement');
} catch (error) {
  console.error('\n✗ Erreur:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
