# 🖥️ Kelio Desktop

> *"Parce que monter un serveur PHP pour lire des données webservices, c'est comme prendre l'autoroute pour aller chercher sa baguette."*

Application desktop **100% locale** pour extraire, stocker et consulter les données Kelio via ses Web Services SOAP — sans serveur, sans PHP, sans larmes (ou presque).

[![Made with Electron](https://img.shields.io/badge/Made%20with-Electron-47848F?logo=electron)](https://www.electronjs.org/)
[![SQLite inside](https://img.shields.io/badge/DB-SQLite%20(sql.js)-003B57?logo=sqlite)](https://sql.js.org/)
[![Vanilla JS](https://img.shields.io/badge/UI-Vanilla%20JS-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/fr/docs/Web/JavaScript)
[![SOAP powered](https://img.shields.io/badge/API-SOAP-FF6B6B)](https://fr.wikipedia.org/wiki/SOAP)

---

## 📖 Sommaire
1. [🤔 C'est quoi ce truc ?](#-cest-quoi-ce-truc-)
2. [🚀 Installation & Démarrage](#-installation--démarrage)
3. [⚙️ Configuration & Utilisation](#-configuration--utilisation)
4. [🛠️ La Stack Technique](#-la-stack-technique)
5. [📁 Architecture du Projet](#-architecture-du-projet)
6. [🗃️ Schéma de la Base de Données](#-schéma-de-la-base-de-données)
7. [🏛️ Migration depuis Symfony](#-migration-depuis-symfony)
8. [🔒 Sécurité & Maintenance](#-sécurité--maintenance)
9. [👤 Auteur & Licence](#-auteur--licence)

---

## 🤔 C'est quoi ce truc ?

Kelio Desktop est un **POC** (Proof of Concept) développé pour ALDI pour simplifier l'extraction et la consultation de données RH/Vente via les APIs Kelio. 

Il remplace une ancienne architecture lourde (Symfony + PHP + MySQL + Nginx) par une application Electron unique. On gagne en simplicité, en vitesse de déploiement et en autonomie.

### Ce que ça fait :
- 📡 **Interroge l'API SOAP de Kelio** (XML natif Node.js).
- 💾 **Stocke tout en local** dans un fichier SQLite via `sql.js` (WebAssembly).
- 📊 **Consultation offline** des salariés, badgeages, absences... et compteurs RH.
- 📤 **Export CSV** universel pour Excel.
- 🔌 **Zéro infrastructure** : Pas de serveur, pas de Docker, juste un `.exe`.

---

## 🚀 Installation & Démarrage

### Prérequis
- **Node.js ≥ 20** (recommandé)
- **npm ≥ 10**

### 1. Installation
```bash
git clone https://github.com/Lud972vic/Kelio-Electron.git
cd KelioDesktop
npm install
```

### 2. Lancer l'application
```bash
npm start
```
*Pour ouvrir avec les DevTools (mode debug) :*
```bash
npm run dev
```

### 3. Compiler pour Windows (.exe)
```bash
npm run build:win
```
L'installateur sera généré dans le dossier `dist/`.

---

## ⚙️ Configuration & Utilisation

### Premier lancement
1. Aller dans les **Paramètres** (icône roue crantée).
2. Renseigner vos accès Kelio (URL API, Login, Password).
3. **Tester la connexion** pour valider les accès.
4. **Enregistrer**.

### Workflow classique
1. **Extraction** → Importer les salariés.
2. **Extraction** → Sélectionner les compteurs et la période souhaitée.
3. **Résultats** → Consulter et filtrer les données.
4. **Export** → Générer le CSV pour exploitation.

### Chemin de la base de données
Par défaut, la base est stockée dans `%APPDATA%\kelio-desktop\kelio.sqlite`.
Vous pouvez modifier ce chemin dans les **Paramètres** pour utiliser un dossier partagé ou une clé USB.

> ⚠️ **Important : Limitations réseau**
> SQLite n'est pas optimisé pour le multi-utilisateur simultané sur réseau. Si vous utilisez un partage réseau, assurez-vous qu'un seul utilisateur accède à la base à la fois.

---

## 🛠️ La Stack Technique

### ⚡ Electron (v39)
L'interface est une **SPA Vanilla JS** (sans framework) pour une performance maximale et une dette technique minimale. 
- **Process Principal** : Gère SQLite, le système de fichiers et les appels SOAP.
- **Renderer** : HTML5/CSS3/JS pur.

### 🗄️ SQLite (`sql.js`)
Nous utilisons **sql.js** (SQLite compilé en WebAssembly) pour la persistance des données.
- **Avantage** : Zéro compilation C++ à l'installation, fonctionne partout instantanément (pas besoin de Visual Studio Build Tools).
- **Persistance** : La base est chargée en RAM pour la rapidité et écrite sur le disque de manière atomique.

### 🧼 SOAP Kelio
Communication via le protocole SOAP (XML). Les requêtes sont construites et parsées manuellement avec les modules natifs de Node.js pour garder une application légère sans dépendances lourdes.

---

## 📁 Architecture du Projet

```text
KelioDesktop/
├── main.js                 # Process principal (IPC, Orchestration)
├── preload.js              # Pont sécurisé renderer ↔ main
├── db/
│   └── database.js         # Moteur sql.js + Migrations + Persistance
├── src/
│   ├── repositories/       # Couche d'accès aux données (Config, Salariés...)
│   └── services/           # Logique métier (Appels SOAP, Orchestrateur)
├── renderer/               # Interface Utilisateur (HTML/CSS/JS)
│   ├── app.js              # Router SPA Vanilla
│   └── pages/              # Logique métier par écran
└── query-db.js             # Outil CLI : Requêtes SQL interactives
```

---

## 🗃️ Schéma de la Base de Données

| Table | Description |
|-------|-------------|
| `kelio_param` | Configuration de connexion et préférences |
| `kelio_sync_run` | Journal des cycles d'extraction |
| `kelio_salarie` | Référentiel des salariés importés |
| `kelio_badgeage` | Données de pointage |
| `kelio_absence_fiche` | Détails des absences et congés |
| `kelio_resultat_total` | Valeurs des compteurs RH |

---

## 🏛️ Migration depuis Symfony

*Comparaison entre l'ancienne architecture et ce POC :*

| Concept | Ancien (Symfony/PHP) | Nouveau (Electron/JS) |
|---------|----------------------|-----------------------|
| **Base de données** | MySQL (Serveur distant) | SQLite (Fichier local) |
| **API SOAP** | PHP SOAP Extension | Node Native (HTTP/XML) |
| **Serveur Web** | Nginx / Apache | Process Electron |
| **Vues UI** | Templates Twig | HTML5 / CSS3 / JS Vanilla |
| **Déploiement** | Docker / VM / Serveur | Exécutable Standalone (.exe) |

---

## 🔒 Sécurité & Maintenance

### Sécurité
- **Isolement** : `contextIsolation` est activé. Le renderer n'a pas accès direct aux APIs Node.js.
- **Stockage** : Les identifiants sont locaux au poste. Pour une sécurité accrue, l'utilisation de `safeStorage` est envisagée pour les versions futures.

### Outils CLI (Maintenance)
- **Nettoyage complet** : `node truncate-db.js` (supprime les données mais conserve la structure et le catalogue).
- **Exploration SQL** : `node query-db.js` (permet de requêter la base en ligne de commande).

---

## 👤 Auteur

**Ludovic** — ALDI Kelio POC

> *"J'ai remplacé un serveur par un fichier. Ça tourne. Je rentre chez moi."*

---

## 📄 Licence

**UNLICENSED** — Usage interne ALDI uniquement. Ne pas distribuer sans autorisation. C'est cadeau, c'est la sandbox...