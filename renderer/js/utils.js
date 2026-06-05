'use strict';

/**
 * @file utils.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — UTILITAIRES PARTAGÉS DU RENDERER
 * ============================================================
 *
 * Ce fichier regroupe toutes les fonctions utilitaires utilisées
 * par les différentes pages du renderer.
 * Il est chargé avant les fichiers de pages dans index.html.
 *
 * FONCTIONS DISPONIBLES :
 *   - esc()             : sécurisation HTML (XSS)
 *   - fmt()             : formatage d'une valeur (ou tiret si vide)
 *   - fmtDate()         : affiche les 10 premiers caractères d'une date
 *   - fmtNum()          : formatage nombre en français (1 234,56)
 *   - statusBadge()     : badge coloré pour le statut d'un run
 *   - archivedBadge()   : badge "Archivé" si salarié archivé
 *   - el()              : création d'éléments DOM programmatiquement
 *   - buildPagination() : génère les boutons de pagination
 *   - emptyState()      : HTML pour l'état vide ("aucun résultat")
 */

const Utils = (() => {

  /**
   * Échappe les caractères HTML spéciaux pour prévenir les injections XSS.
   * À utiliser TOUJOURS avant d'insérer des données utilisateur dans innerHTML.
   *
   * Ex: esc('<script>') → '&lt;script&gt;'
   *
   * @param {*} s - La valeur à échapper (sera converti en string)
   * @returns {string}
   */
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')   // & en premier (sinon on double-échapperait)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Formate une valeur pour affichage dans un tableau.
   * Si la valeur est vide/null/undefined, affiche un tiret en gris.
   *
   * @param {*} v
   * @returns {string} - HTML sécurisé
   */
  function fmt(v) {
    if (v === null || v === undefined || v === '') {
      return '<span class="td-muted">—</span>';
    }
    return esc(v);
  }

  /**
   * Formate une date pour l'affichage : ne garde que les 10 premiers caractères.
   * Permet de tronquer '2024-03-15T00:00:00' en '2024-03-15'.
   *
   * @param {string} d
   * @returns {string} - HTML sécurisé
   */
  function fmtDate(d) {
    if (!d) return '<span class="td-muted">—</span>';
    return esc(String(d).slice(0, 10)); // Ne garde que 'YYYY-MM-DD'
  }

  /**
   * Formate un nombre en notation française (virgule décimale, espace milliers).
   * Ex: 1234.5 → '1 234,5' (selon la locale fr-FR)
   * Retourne un tiret si la valeur n'est pas un nombre valide.
   *
   * @param {*} n
   * @returns {string}
   */
  function fmtNum(n) {
    if (n === null || n === undefined || n === '') {
      return '<span class="td-muted">—</span>';
    }
    const nombreFloat = parseFloat(n);
    if (isNaN(nombreFloat)) return '<span class="td-muted">—</span>';
    return nombreFloat.toLocaleString('fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    });
  }

  /**
   * Génère un badge HTML coloré selon le statut d'un run.
   * Ex: 'TERMINE' → badge vert, 'ERREUR' → badge rouge.
   *
   * @param {string} status - 'TERMINE' | 'TERMINE_ERREURS' | 'EN_COURS' | 'ERREUR'
   * @returns {string} - HTML du badge
   */
  function statusBadge(status) {
    // Table de correspondance statut → [classe CSS, libellé affiché]
    const correspondance = {
      'TERMINE':         ['badge-success', 'Terminé'],
      'TERMINE_ERREURS': ['badge-warning', 'Terminé (erreurs)'],
      'EN_COURS':        ['badge-accent',  'En cours'],
      'ERREUR':          ['badge-danger',  'Erreur'],
    };
    const [classeCss, libelle] = correspondance[status] ?? ['badge-muted', status ?? '—'];
    return `<span class="badge ${classeCss}">${esc(libelle)}</span>`;
  }

  /**
   * Génère un badge "Archivé" si le salarié est archivé, rien sinon.
   *
   * @param {boolean|number} v - true/1 = archivé, false/0 = actif
   * @returns {string}
   */
  function archivedBadge(v) {
    return v ? '<span class="badge badge-muted">Archivé</span>' : '';
  }

  /**
   * Crée un élément DOM de manière programmatique.
   * Alternative à innerHTML pour créer des éléments dynamiquement.
   *
   * GESTION DES ATTRIBUTS :
   *   - 'class'      → e.className (plus sûr)
   *   - 'on[event]'  → addEventListener (ex: 'onclick' → click)
   *   - Tout autre   → setAttribute()
   *
   * @param {string} tag      - Nom de la balise HTML (ex: 'button', 'div')
   * @param {Object} attrs    - Attributs/événements (ex: { class: 'btn', onclick: fn })
   * @param {...*}   children - Enfants : autres éléments DOM ou texte
   * @returns {HTMLElement}
   */
  function el(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    for (const [cle, valeur] of Object.entries(attrs)) {
      if (cle === 'class')          element.className = valeur;
      else if (cle.startsWith('on')) element.addEventListener(cle.slice(2), valeur); // 'onclick' → 'click'
      else                           element.setAttribute(cle, valeur);
    }
    for (const enfant of children) {
      if (enfant instanceof Node)               element.appendChild(enfant);
      else if (enfant !== null && enfant !== undefined) {
        element.appendChild(document.createTextNode(String(enfant)));
      }
    }
    return element;
  }

  /**
   * Génère les boutons de pagination dans un conteneur.
   * Affiche : Préc | 1 ... 3 [4] 5 ... 10 | Suiv
   * Ne fait rien si totalPages <= 1 (pas de pagination nécessaire).
   *
   * @param {HTMLElement} container     - L'élément qui contiendra les boutons
   * @param {Object}      options
   * @param {number}      options.page       - Page courante (base 1)
   * @param {number}      options.totalPages - Nombre total de pages
   * @param {Function}    options.onChange   - Callback appelé avec le nouveau numéro de page
   */
  function buildPagination(container, { page, totalPages, onChange }) {
    container.innerHTML = '';
    if (totalPages <= 1) return; // Pas besoin de pagination

    // Bouton "Précédent"
    const btnPrev = el('button', {
      class: 'page-btn',
      disabled: page <= 1 ? '' : null,
      onclick: () => onChange(page - 1),
    }, '‹');
    if (page <= 1) btnPrev.disabled = true;
    container.appendChild(btnPrev);

    // Plage de boutons à afficher (page courante ± 2)
    const debut = Math.max(1, page - 2);
    const fin   = Math.min(totalPages, page + 2);

    // "1 ..." si on ne commence pas à la page 1
    if (debut > 1) {
      container.appendChild(el('button', { class: 'page-btn', onclick: () => onChange(1) }, '1'));
      if (debut > 2) container.appendChild(el('span', { class: 'page-info' }, '…'));
    }

    // Pages numérotées de debut à fin
    for (let i = debut; i <= fin; i++) {
      const classeBouton = `page-btn${i === page ? ' active' : ''}`;
      const btn = el('button', { class: classeBouton, onclick: () => onChange(i) }, String(i));
      container.appendChild(btn);
    }

    // "... N" si on ne termine pas à la dernière page
    if (fin < totalPages) {
      if (fin < totalPages - 1) container.appendChild(el('span', { class: 'page-info' }, '…'));
      container.appendChild(el('button', { class: 'page-btn', onclick: () => onChange(totalPages) }, String(totalPages)));
    }

    // Bouton "Suivant"
    const btnNext = el('button', { class: 'page-btn', onclick: () => onChange(page + 1) }, '›');
    if (page >= totalPages) btnNext.disabled = true;
    container.appendChild(btnNext);
  }

  /**
   * Génère le HTML de l'état vide ("aucun résultat", "aucun employé", etc.).
   * Affiche une icône centrée + un message.
   *
   * @param {string} icon - Caractère ou émoji représentant l'état
   * @param {string} msg  - Message à afficher
   * @returns {string} - HTML
   */
  function emptyState(icon, msg) {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${msg}</p></div>`;
  }

  // Exposition publique de toutes les fonctions utilitaires
  return { esc, fmt, fmtDate, fmtNum, statusBadge, archivedBadge, el, buildPagination, emptyState };
})();
