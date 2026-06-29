# Guesty Monitor — CLAUDE.md

## Vue d'ensemble

Bot de surveillance des réservations de la location **"Le jardin d'Henri"** sur le portail Guesty owner (`mercijulie.guestyowners.com`). Tourne toutes les heures via GitHub Actions. Envoie un email (Gmail) en cas de changement détecté, et ajoute les nouvelles réservations dans le calendrier Google dédié.

---

## Architecture

```
index.js      — Script principal Node.js (Puppeteer + interception réseau)
monitor.yml   — Workflow GitHub Actions (cron toutes les heures)
package.json  — Dépendances : puppeteer-core, nodemailer
state.json    — État persisté entre les runs (via cache GitHub Actions)
```

---

## Flux d'exécution

```
login()                    → Puppeteer sur mercijulie.guestyowners.com
                             → JWT récupéré depuis localStorage.getItem('token')
page.on("response")        → Interception des réponses XHR de l'app :
  - /api/v2/listings/{id}/calendar → jours avec blockRefs (réservations)
  - /api/revenue-analytics/...     → revenus par reservationId
clickBookedCells()         → Clics sur chaque mois pour charger les données
parseBlockRefs()           → Extraction réservations depuis calendar.blockRefs
sendEmail()                → Email Gmail si changement détecté
```

---

## Identifiants & Endpoints

| Élément | Valeur |
|---------|--------|
| Portail owner | `https://mercijulie.guestyowners.com` |
| API base | `https://app.guesty.com/api` |
| Listing ID | `69e5e471e72c790015c810de` |
| Owner ID | `69ef0aceb851941a87f7042d` |
| Header spécial | `g-aid-cs: G-89C7E-9FB65-B6F69` |

### Endpoints interceptés (via page.on("response"))

```
GET /api/v2/listings/{id}/calendar?from=...&to=...
  → Tableau de jours avec blockRefs contenant les réservations complètes

GET /api/revenue-analytics/analytics/owner/{ownerId}?reservationIds=...
  → [{reservationId, accountBased: {revenue}}]
```

---

## Structure des données

### Jour du calendrier (blockRefs)

```js
{
  date: "2026-07-01",
  status: "booked",
  blocks: { b: true, ... },
  blockRefs: [{
    _id: "...",
    type: "b",                    // "b" = booking
    reservationId: "6a2b04f4...",
    reservation: {
      _id: "6a2b04f4...",
      checkInDateLocalized: "2026-07-01",
      checkOutDateLocalized: "2026-07-10",
      status: "confirmed",
      confirmationCode: "HMZE9RK5DE",
      source: "airbnb2",          // airbnb2, booking.com, direct
      guestId: "6a2b04f4...",
      guests: 3,
      money: {
        hostPayout: 611.10,       // montant versé par la plateforme
        balanceDue: 0,
        currency: "EUR"
      }
    }
  }]
}
```

### Réservation parsée (objet interne)

```js
{
  id: "6a2b04f4...",            // reservationId Guesty
  checkIn: "2026-07-01",        // ISO date
  checkOut: "2026-07-10",
  nights: 9,
  guestName: null,              // non disponible sans API officielle
  source: "Airbnb",             // airbnb2→"Airbnb", booking.com→"Booking.com"
  status: "confirmed",
  ownerRevenue: 420.88,         // depuis revenue-analytics (net après frais Julie)
                                // fallback: money.hostPayout (brut avant frais Julie)
  guests: 3,
}
```

---

## Revenus

- **`ownerRevenue`** (priorité) : revenu net après commission de Julie → depuis `revenue-analytics`
- **`hostPayout`** (fallback) : montant brut versé par Airbnb/Booking avant frais de gestion → depuis `money.hostPayout`
- Les `?€` persistent quand les deux sont indisponibles (réservations trop anciennes hors fenêtre revenue-analytics)

---

## Email de notification

Structure :
1. **🆕 Nouvelles réservations** — avec revenu, €/nuit, voyageurs, plateforme, lien 📅 Agenda
2. **❌ Réservations annulées**
3. **🔄 Réservations modifiées** — diffs avec ancien/nouveau
4. **📋 Tableau récapitulatif** — groupé par mois avec sous-totaux
5. **💰 Revenu total**

### Lien 📅 Agenda

Les liens Google Calendar pointent vers le calendrier dédié "Jardin d'Henri" :
```
calendarId: 41714fc51aa2972ba9ec716727401874ec3f5cb62939e868a4432680fd108b27@group.calendar.google.com
```
Paramètre `src` dans l'URL pour cibler ce calendrier.

---

## GitHub Actions (secrets configurés)

| Secret | Description |
|--------|-------------|
| `GUESTY_EMAIL` | `henri.borreill@gmail.com` |
| `GUESTY_PASSWORD` | Mot de passe Guesty |
| `EMAIL_FROM` | Expéditeur Gmail |
| `EMAIL_TO` | Destinataire |
| `EMAIL_PASSWORD` | Mot de passe app Gmail (16 caractères) |

Cron : `0 * * * *` — toutes les heures pile (UTC, soit heure française -1h hiver, -2h été).

---

## Points techniques importants

### Interception réseau (clé du fonctionnement)

L'app Guesty fait ses propres XHR vers `app.guesty.com` avec les bons cookies de session. On intercepte ces réponses via `page.on("response")` — c'est plus fiable que faire des appels directs (CORS bloque les appels Node.js directs).

### blockRefs — source de vérité

Les données de réservation (dates, source, voyageurs, revenus bruts) sont dans `blockRefs` de chaque jour du calendrier. Pas besoin d'appels supplémentaires par réservation.

### CORS

- Depuis Node.js → `app.guesty.com` : **bloqué** (CORS)
- Depuis `page.evaluate()` → `app.guesty.com` : **bloqué** (CORS headless)
- Via interception `page.on("response")` : **fonctionne** (l'app fait elle-même les appels)

### Nom du voyageur

Toujours `null` — nécessite l'API officielle Guesty (Open API avec client_id/secret de Julie). Le `guestId` est disponible mais l'endpoint `/guests/{id}` n'est pas accessible sans credentials OAuth.

### Données manquantes pour avril

Les 3 réservations d'avril ont `ownerRevenue: null` car revenue-analytics ne couvre que la fenêtre récente. À vérifier avec Julie.

---

## Calendrier Google "Jardin d'Henri"

ID : `41714fc51aa2972ba9ec716727401874ec3f5cb62939e868a4432680fd108b27@group.calendar.google.com`

Les 22 réservations existantes ont été créées manuellement le 29/06/2026.
Les nouvelles réservations s'ajoutent via les liens 📅 dans les emails.

**Convention d'affichage :**
- Airbnb → couleur Basil (vert, colorId=10)
- Booking.com → couleur Peacock (bleu, colorId=7)
- Check-in : 16h00, Check-out : 10h00

---

## Option A (API officielle) — en attente

Julie doit créer une OAuth application dans `app.guesty.com` → Integrations → OAuth applications pour fournir un `client_id` + `client_secret`. Cela permettrait d'obtenir les noms de voyageurs et une intégration plus propre.
