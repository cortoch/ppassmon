# Passpass Monitor — CLAUDE.md

## Vue d'ensemble

Bot de surveillance des réservations de la location **"Le jardin d'Henri"** sur [client.passpass.io](https://client.passpass.io). Tourne toutes les 30 minutes via GitHub Actions. Envoie un email (Gmail) en cas de changement détecté.

---

## Architecture

```
index.js      — Script principal Node.js (Puppeteer + Nodemailer)
monitor.yml   — Workflow GitHub Actions (cron toutes les 30 min)
package.json  — Dépendances : puppeteer-core, nodemailer
state.json    — État persisté entre les runs (via cache GitHub Actions)
```

---

## Flux d'exécution

```
login()
navigateToProperty()         → clic "Mes locations" → /dashboard
  └─ boucle 6 mois :
      navigateToMonth()      → fc-next-button de FullCalendar
      scrapeMonth()          → clic chaque jour via page.mouse.click()
                                → lit widget "Séjour sélectionné"
main()
  └─ compare hash avec state.json → sendEmail() si changement
```

---

## Interface Passpass — Ce qu'on sait

### Page `/dashboard` après clic "Mes locations"

```
Le jardin d'Henri

[Calendrier FullCalendar — mars 2026]
  < Mars 2026 >           ← bouton fc-prev-button / fc-next-button (aria="prev"/"next")
  LU MA ME JE VE SA DI
  ...jours numérotés...   ← cellules .fc-daygrid-day[data-date="YYYY-MM-DD"]

Séjour sélectionné        ← SE MET À JOUR après clic souris sur un jour occupé
  Dates      Nuitées  Revenu     Voyageur
  28 Mars - 31 Mars  3  216.32€  Francisco M. - 3 voyageurs / 2 lits

Réservations du mois      ← NE SE MET PAS À JOUR quand on change de mois
  [select: Mars 2026 / Février 2026 / Janvier 2026]   ← seulement mois passés
  28 Mars - 31 Mars  3  216.32€  A venir

Bilan du mois             ← idem, figé
```

### ⚠️ Pièges importants

1. **`element.click()` en JS ne fonctionne pas** — Passpass/Vue ignore les clics JS synthétiques. Il faut **`page.mouse.click(x, y)`** (vrai clic souris Puppeteer avec événements natifs).

2. **Le widget "Séjour sélectionné" garde l'ancien séjour** quand on change de mois — il affiche encore la réservation de mars quand on passe sur avril, jusqu'à ce qu'on clique un jour occupé d'avril. Solution : comparer la clé `dateDebut-dateFin` avant/après chaque clic, et **filtrer les séjours hors du mois cible** (chevauchement).

3. **"Réservations du mois" ne change pas** avec la navigation du calendrier — cette section est inutile pour les mois futurs. La seule source fiable = clic jour par jour sur le widget "Séjour sélectionné".

4. **NE PAS cliquer sur "Henri Borreill"** dans le header — c'est le nom d'utilisateur, pas la propriété.

5. **Le sélecteur du mois** (`Mars 2026`, `Février 2026`...) ne contient que les mois passés — inutilisable pour naviguer vers les mois futurs.

### Navigation entre les mois

```js
// FullCalendar expose un bouton avec classe fc-next-button et aria="next"
document.querySelector(".fc-next-button").click()  // via page.evaluate()
// Puis vérifier le mois affiché dans le texte de la page
```

### Détection des réservations

Pour chaque mois, on clique **tous les jours** du mois via `page.mouse.click(x, y)` avec les coordonnées réelles de la cellule (`.getBoundingClientRect()`). On détecte un changement de réservation quand la clé `dateDebut-dateFin` du widget change. On filtre avec :

```js
const chevauche = sejourDebut <= moisFin && sejourFin >= moisDebut;
```

### Format du widget "Séjour sélectionné" (texte brut)

```
Dates 28 Mars - 31 Mars Nuitées 3 Revenu 216.32 € Voyageur Francisco M. - 3 voyageurs / 2 lits
```

Regex :
```js
/Dates\s*(\d{1,2}\s+[A-Za-z\u00C0-\u00FF]+\s*[-\u2013]\s*\d{1,2}\s+[A-Za-z\u00C0-\u00FF]+)\s*Nuit[e\u00e9]es?\s*(\d+)\s*Revenu\s*([\d\s.,]+\s*\u20ac)\s*Voyageur\s*([^\n\r]+)/
```

---

## GitHub Actions

```yaml
runs-on: ubuntu-latest
env:
  DISPLAY: ':99'    # Xvfb requis — Chrome lancé en headless: false
```

Secrets à configurer :
| Secret | Description |
|--------|-------------|
| `PASSPASS_EMAIL` | Email de connexion |
| `PASSPASS_PASSWORD` | Mot de passe |
| `EMAIL_FROM` | Expéditeur Gmail |
| `EMAIL_TO` | Destinataire |
| `EMAIL_PASSWORD` | Mot de passe app Gmail (pas le mdp principal) |

### Persistance de l'état

`state.json` sauvegardé/restauré via `actions/cache` :
```yaml
key: passpass-state-${{ github.run_id }}
restore-keys: passpass-state-
```

---

## Dépendances

```json
"puppeteer-core": "^21.0.0"   // pas puppeteer complet, Chrome installé séparément
"nodemailer": "^6.9.0"
```

Chrome : `google-chrome-stable` via `apt-get`, path `/usr/bin/google-chrome-stable`.

---

## Points d'attention pour les modifications futures

- **Login React** : remplir les champs via `HTMLInputElement.prototype.value` setter + events `input`/`change` — pas `el.value = x` directement.
- **Xvfb warnings** (`XF86CameraAccessEnable`, etc.) : normaux, non bloquants.
- **Clics Puppeteer** : toujours utiliser `page.mouse.click(x, y)` avec coordonnées issues de `getBoundingClientRect()`, jamais `element.click()` en JS.
- **Déduplication** : basée sur `dateDebut-dateFin` en ISO, pas sur le texte affiché.
- **Voyageur "Non enregistré"** : valeur normale pour Booking.com, pas une erreur.
