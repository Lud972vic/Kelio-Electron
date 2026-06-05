'use strict';

/**
 * @file toast.js
 *
 * ============================================================
 * RÔLE DE CE FICHIER — NOTIFICATIONS TEMPORAIRES ("TOASTS")
 * ============================================================
 *
 * Un "toast" est une petite notification qui apparaît brièvement
 * dans un coin de l'écran, puis disparaît automatiquement.
 * C'est le moyen standard d'informer l'utilisateur d'un succès ou d'une erreur
 * sans interrompre son flux de travail (contrairement à un `alert()`).
 *
 * UTILISATION DANS LES PAGES :
 *   Toast.success('Extraction terminée !');      // Fond vert
 *   Toast.error('Connexion échouée');            // Fond rouge
 *   Toast.info('Chargement en cours...', 2000);  // Fond bleu, 2 secondes
 *
 * CONTENEUR HTML :
 * Les toasts sont ajoutés dans `<div id="toastContainer">` (défini dans index.html).
 * Plusieurs toasts peuvent s'empiler si déclenchés rapidement.
 *
 * APPELÉ PAR : toutes les pages du renderer
 */

const Toast = (() => {

  // Icônes associées à chaque type de notification
  const ICONES = {
    success: '✓',  // Coche verte
    error:   '✕',  // Croix rouge
    info:    'ℹ',  // Icône info bleue
  };

  /**
   * Affiche un toast et le fait disparaître après `duration` ms.
   * Crée un élément div, l'ajoute au conteneur, puis le supprime après un fade-out.
   *
   * @param {string} message  - Texte à afficher (sera échappé pour la sécurité)
   * @param {string} type     - 'success' | 'error' | 'info'
   * @param {number} duration - Durée d'affichage en ms (défaut: 4000ms = 4 secondes)
   */
  function show(message, type = 'info', duration = 4000) {
    const conteneur = document.getElementById('toastContainer');
    const elementToast = document.createElement('div');
    elementToast.className = `toast toast-${type}`;
    elementToast.innerHTML = `
      <span class="toast-icon">${ICONES[type] ?? 'ℹ'}</span>
      <span>${Utils.esc(message)}</span>
    `;
    conteneur.appendChild(elementToast);

    // Fade-out puis suppression après la durée
    setTimeout(() => {
      elementToast.style.opacity    = '0';
      elementToast.style.transition = 'opacity 0.3s';
      // On attend la fin de la transition CSS (300ms) avant de supprimer l'élément
      setTimeout(() => elementToast.remove(), 320);
    }, duration);
  }

  // API publique simplifiée : on ne expose pas show() directement
  return {
    /** Affiche un message de succès (fond vert) */
    success: (msg, duree) => show(msg, 'success', duree),
    /** Affiche un message d'erreur (fond rouge) */
    error:   (msg, duree) => show(msg, 'error',   duree),
    /** Affiche un message informatif (fond bleu) */
    info:    (msg, duree) => show(msg, 'info',    duree),
  };
})();
