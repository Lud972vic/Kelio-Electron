'use strict';

/**
 * @file app.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — ROUTEUR ET POINT D'ENTRÉE DU RENDERER
 * ============================================================
 *
 * C'est le premier fichier JavaScript chargé par `index.html`.
 * Il joue le rôle de routeur : il gère la navigation entre les pages
 * et l'initialisation générale de l'interface.
 *
 * PATTERN IIFE (Immediately Invoked Function Expression) :
 * La syntaxe `const App = (() => { ... })()` crée un module auto-exécuté.
 * Tout ce qui est déclaré à l'intérieur reste privé (non accessible depuis d'autres scripts),
 * sauf ce qui est retourné par `return { navigate }`.
 * Cela évite de polluer le scope global avec des variables internes.
 *
 * PAGES DISPONIBLES :
 * Chaque page est un objet JavaScript défini dans son propre fichier
 * (chargé avant ce fichier dans index.html) avec une méthode `render(container)`.
 *
 * APPELÉ PAR : index.html (via les balises <script>)
 */

const App = (() => {

  // Registre de toutes les pages disponibles.
  // La clé correspond à l'attribut `data-page` des éléments de navigation dans index.html.
  const PAGES = {
    dashboard:  DashboardPage,  // Tableau de bord avec statistiques
    extraction: ExtractionPage, // Formulaire de lancement d'extraction
    results:    ResultsPage,    // Résultats/compteurs
    data:       DataPage,       // Consultation des données brutes (inclut salariés)
    history:    HistoryPage,    // Historique des extractions
    settings:   SettingsPage,  // Configuration de connexion
    sql:        SqlPage,        // Requêtes SQL personnalisées
  };

  let _pageCourante = null; // Clé de la page actuellement affichée

  /**
   * Navigue vers une page.
   * Met à jour la sidebar (classe 'active') et demande à la page de se rendre.
   * La méthode `render(container)` de chaque page remplace le contenu du conteneur.
   *
   * @param {string} pageKey - Clé de la page (ex: 'dashboard', 'employees')
   * @param {Object} options - Options de navigation (ex: { tab: 'employees' })
   */
  function navigate(pageKey, options = {}) {
    // Redirection legacy : 'employees' → 'data' avec onglet employees
    if (pageKey === 'employees') {
      pageKey = 'data';
      options.tab = 'employees';
    }

    if (!PAGES[pageKey]) return; // Page inconnue, on ignore

    // Met à jour l'indicateur visuel actif dans la sidebar
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === pageKey);
    });

    _pageCourante = pageKey;
    const conteneurPrincipal = document.getElementById('mainContent');

    // Si options.tab est fourni, on force l'onglet actif dans DataPage avant le render
    if (pageKey === 'data' && options.tab && DataPage.setActiveTab) {
      DataPage.setActiveTab(options.tab);
    }

    PAGES[pageKey].render(conteneurPrincipal); // La page génère son propre HTML
  }

  /**
   * Initialise l'application au chargement du DOM.
   * - Affiche la version de l'application dans le coin bas-gauche
   * - Branche les clics de navigation sur la sidebar
   * - Navigue vers la page d'accueil (dashboard)
   *
   * Appelé automatiquement par l'événement DOMContentLoaded.
   */
  async function init() {
    // Récupère la version depuis le package.json via l'IPC Electron
    try {
      const version = await window.KelioAPI.appVersion();
      const elementVersion = document.getElementById('appVersion');
      if (elementVersion) elementVersion.textContent = `v${version}`;
    } catch (_) {} // On ignore si indisponible (ne bloque pas le démarrage)

    // Branche chaque lien de navigation sur la fonction navigate()
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault(); // Empêche le lien de recharger la page
        navigate(el.dataset.page); // Ex: data-page="employees"
      });
    });

    // Page affichée au démarrage
    navigate('dashboard');
  }

  // Déclenche init() quand le HTML est entièrement parsé
  document.addEventListener('DOMContentLoaded', init);

  // Seule navigate() est exposée publiquement (utilisée par certaines pages pour se rediriger)
  return { navigate };
})();
