const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function checkDb() {
  const dbPath = path.join(process.env.APPDATA, 'kelio-desktop', 'kelio.sqlite');
  console.log('Chemin de la base:', dbPath);

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    const SQL = await initSqlJs();
    const db = new SQL.Database(buffer);
    
    // Tester la méthode get() avec COUNT après correction
    console.log('\n=== Test méthode get() avec COUNT (après step()) ===');
    try {
      const stmt = db.prepare('SELECT COUNT(*) as n FROM kelio_salarie');
      stmt.step();
      const result = stmt.getAsObject();
      stmt.free();
      console.log('Résultat get():', result);
      console.log('Propriété n:', result?.n);
    } catch (e) {
      console.error('Erreur get():', e.message);
    }
  } else {
    console.log('La base de données n\'existe pas');
  }
}

checkDb();
