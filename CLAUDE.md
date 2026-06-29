# Guesty Monitor — CLAUDE.md

## Vue d'ensemble

Bot de surveillance des réservations de la location **"Le jardin d'Henri"** sur le portail Guesty owner (`mercijulie.guestyowners.com`). Tourne toutes les 30 minutes via GitHub Actions. Envoie un email (Gmail) en cas de changement détecté.

---

## Architecture

```
index.js      — Script principal Node.js (Puppeteer pour le JWT + appels API Guesty directs)
monitor.yml   — Workflow GitHub Actions (cron toutes les 30 min)
package.json  — Dépendances : puppeteer-core, nodemailer
state.json    — État persisté entre les runs (via cache GitHub Actions)
```

---

## Flux d'exécution

```
getJwtToken()              → Puppeteer login sur mercijulie.guestyowners.com
                              → JWT récupéré via localStorage.getItem('token')
scrapeGuesty()
  ├─ fetchReservationsList() → GET /api/owners/me/reservations?listingId=...
  │    (si 200 et liste)     → liste directe des réservations
  │                          → fetchOwnerRevenue() en batch
  └─ fallback calendrier :
       fetchCalendar()       → GET /api/v2/listings/{id}/calendar?from=...&to=...
       fetchReservation()    → GET /api/owners/reservations/{id} (détail par ID)
       fetchOwnerRevenue()   → GET /api/revenue-analytics/analytics/owner/{ownerId}?reservationIds=...
main()
  └─ compare hash avec state.json → sendEmail() si changement
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

### Endpoints principaux

```
GET /api/owners/me/reservations?listingId={id}&checkIn[gte]={from}&checkOut[lte]={to}&limit=50
GET /api/v2/listings/{id}/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/owners/reservations/{reservationId}
GET /api/revenue-analytics/analytics/owner/{ownerId}?reservationIds=id1,id2,...
```

### Auth

Toutes les requêtes :
```
Authorization: Bearer {JWT token depuis localStorage}
g-aid-cs: G-89C7E-9FB65-B6F69
Accept: application/json
```

---

## Stratégie JWT

Le JWT est dans `localStorage.getItem('token')` sur `mercijulie.guestyowners.com`.
- Durée de vie inconnue — Puppeteer re-logine à chaque run.
- Puppeteer intercepte aussi les requêtes XHR pour capturer le token au vol (plus rapide).
- Pas de CORS côté Node.js → on peut appeler `app.guesty.com` directement avec le token.

**Pourquoi pas depuis le browser ?** `app.guesty.com` refuse les appels cross-origin depuis `mercijulie.guestyowners.com` (CORS). Mais depuis Node.js (Puppeteer ou `https.get`), pas de restriction.

---

## Structure d'une réservation

```js
{
  id: "6a3d402f...",        // ID Guesty
  checkIn: "2026-07-01",    // ISO date
  checkOut: "2026-07-08",
  nights: 7,
  guestName: "Jean D.",
  source: "Airbnb",         // ou "Booking.com", "Direct", etc.
  status: "confirmed",
  ownerRevenue: 420.50,     // en € — depuis revenue-analytics endpoint
}
```

---

## Revenus propriétaire

- Endpoint batch : `GET /revenue-analytics/analytics/owner/{ownerId}?reservationIds=id1,id2`
- Réponse attendue : `{ data: [{ reservationId, ownerRevenue, ... }] }`
- Format peut varier — le code cherche `ownerRevenue`, `owner_revenue`, `revenue` en fallback.
- Si endpoint indisponible → `ownerRevenue: null` affiché comme "?"

---

## GitHub Actions (secrets à configurer)

| Secret | Description |
|--------|-------------|
| `GUESTY_EMAIL` | Email de connexion (`henri.borreill@gmail.com`) |
| `GUESTY_PASSWORD` | Mot de passe Guesty |
| `EMAIL_FROM` | Expéditeur Gmail |
| `EMAIL_TO` | Destinataire |
| `EMAIL_PASSWORD` | Mot de passe app Gmail (16 caractères, pas le mdp principal) |

⚠️ **Mettre à jour les secrets dans GitHub** — l'ancien `PASSPASS_EMAIL` / `PASSPASS_PASSWORD` ne servent plus.

---

## Points d'attention

- **Login Guesty** : même technique React que Passpass — `HTMLInputElement.prototype.value` setter + events `input`/`change`.
- **Pas de scraping DOM** : toute la logique est dans les appels API JSON — beaucoup plus stable.
- **Détection des changements** : basée sur le hash MD5 du JSON complet des réservations.
- **Déduplication** : basée sur l'ID Guesty de la réservation (`r.id`).
- **Fallback** : si la liste directe échoue, on passe par le calendrier jour par jour + détail par ID.
