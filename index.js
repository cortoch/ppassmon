const puppeteer = require("puppeteer-core");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GUESTY_EMAIL    = process.env.GUESTY_EMAIL    || "henri.borreill@gmail.com";
const GUESTY_PASSWORD = process.env.GUESTY_PASSWORD || "REMPLACE";
const EMAIL_FROM      = process.env.EMAIL_FROM      || "henri.borreill@gmail.com";
const EMAIL_TO        = process.env.EMAIL_TO        || "henri.borreill@gmail.com";
const EMAIL_PASSWORD  = process.env.EMAIL_PASSWORD  || "REMPLACE";

const LISTING_ID  = "69e5e471e72c790015c810de";
const OWNER_ID    = "69ef0aceb851941a87f7042d";
const PORTAL_URL  = "https://mercijulie.guestyowners.com";
const API_BASE    = "https://app.guesty.com/api";
const G_AID_CS    = "G-89C7E-9FB65-B6F69";
const CACHE_FILE  = "state.json";
const MONTHS_AHEAD = 6;

// ─── UTILITAIRES ──────────────────────────────────────────────────────────────
function hash(str) { return crypto.createHash("md5").update(str).digest("hex"); }
function loadState() {
  if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  return {};
}
function saveState(state) { fs.writeFileSync(CACHE_FILE, JSON.stringify(state, null, 2)); }

function fmtDate(isoStr) {
  if (!isoStr) return "?";
  const d = new Date(isoStr + "T00:00:00");
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function buildGCalLink(r) {
  if (!r.checkIn || !r.checkOut) return null;
  const fmt = d => d.replace(/-/g, "");
  const nuits = r.nights || "?";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `🏠 Réservation Le jardin d'Henri (${nuits} nuit${nuits > 1 ? "s" : ""})`,
    dates: `${fmt(r.checkIn)}/${fmt(r.checkOut)}`,
    details: `Du ${fmtDate(r.checkIn)} au ${fmtDate(r.checkOut)}\n${nuits} nuits\nVoyageur: ${r.guestName || "?"}\nRevenu propriétaire: ${r.ownerRevenue != null ? r.ownerRevenue + " €" : "?"}\nPlateforme: ${r.source || "?"}\nÉtat: ${r.status || "?"}`,
    location: "Le jardin d'Henri, 2 Rue des Aloès, Perpignan",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ─── REQUÊTE HTTP SIMPLE (pas de dépendance externe) ─────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── LOGIN PUPPETEER → récupération du JWT ────────────────────────────────────
async function getJwtToken() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome-stable",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();

    console.log("🌐 Navigation vers le portail...");
    await page.goto(`${PORTAL_URL}/login`, { waitUntil: "networkidle2", timeout: 30000 });

    // Remplir email + password
    await page.waitForSelector("input[type='email'], input[name='email'], #email", { timeout: 10000 });
    await page.evaluate((email, password) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      const fill = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        setter.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      fill("input[type='email'], input[name='email'], #email", email);
      fill("input[type='password'], input[name='password'], #password", password);
    }, GUESTY_EMAIL, GUESTY_PASSWORD);

    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      (document.querySelector('button[type="submit"]') || document.querySelector("button"))?.click();
    });

    // Attendre la navigation post-login
    await new Promise(r => setTimeout(r, 8000));

    if (page.url().includes("login")) throw new Error("Login échoué — vérifier les identifiants");
    console.log(`✅ Connecté : ${page.url()}`);

    // 1. Récupérer le token depuis localStorage (source la plus fiable)
    let capturedToken = await page.evaluate(() => localStorage.getItem("token"));

    // 2. Si absent, naviguer vers le calendrier pour forcer le chargement
    if (!capturedToken || capturedToken.length < 20) {
      await page.goto(`${PORTAL_URL}/my-properties/${LISTING_ID}/calendar`, { waitUntil: "networkidle2", timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));
      capturedToken = await page.evaluate(() => localStorage.getItem("token"));
    }

    if (!capturedToken || capturedToken.length < 20) throw new Error("Impossible de récupérer le JWT token");
    console.log(`🔑 Token OK (${capturedToken.length} chars)`);
    return capturedToken;

  } finally {
    await browser.close();
  }
}

// ─── APPEL API GUESTY ─────────────────────────────────────────────────────────
function guestyGet(path, token) {
  const url = `${API_BASE}${path}`;
  return httpGet(url, {
    "Authorization": `Bearer ${token}`,
    "g-aid-cs": G_AID_CS,
    "Accept": "application/json",
  });
}

// ─── RÉCUPÉRATION DU CALENDRIER (dates réservées + IDs réservation) ───────────
async function fetchCalendar(token, from, to) {
  const path = `/v2/listings/${LISTING_ID}/calendar?from=${from}&to=${to}`;
  console.log(`  📅 Calendar ${from} → ${to}`);
  const res = await guestyGet(path, token);
  if (res.status !== 200) {
    console.warn(`  ⚠️  Calendar HTTP ${res.status}`);
    return [];
  }
  // La réponse est un tableau de jours : [{ date, status, reservationId, ... }, ...]
  const days = Array.isArray(res.body) ? res.body : (res.body?.days || res.body?.data || []);
  return days;
}

// ─── RÉCUPÉRATION DES DÉTAILS D'UNE RÉSERVATION ───────────────────────────────
async function fetchReservation(token, reservationId) {
  // Endpoint owners portal pour les détails de réservation
  const endpoints = [
    `/owners/reservations/${reservationId}`,
    `/v2/reservations/${reservationId}`,
    `/reservations/${reservationId}`,
  ];
  for (const ep of endpoints) {
    const res = await guestyGet(ep, token);
    if (res.status === 200 && res.body && typeof res.body === "object" && res.body._id) {
      return res.body;
    }
  }
  return null;
}

// ─── RÉCUPÉRATION DU REVENU PROPRIÉTAIRE ─────────────────────────────────────
async function fetchOwnerRevenue(token, reservationIds) {
  if (!reservationIds.length) return {};
  const ids = reservationIds.join(",");
  const path = `/revenue-analytics/analytics/owner/${OWNER_ID}?reservationIds=${ids}`;
  const res = await guestyGet(path, token);
  if (res.status !== 200 || !res.body) return {};

  // Parser la réponse revenue — format attendu : { data: [{ reservationId, ownerRevenue, ... }] }
  const items = res.body.data || res.body.results || res.body.analytics || (Array.isArray(res.body) ? res.body : []);
  const map = {};
  for (const item of items) {
    const id = item.reservationId || item._id || item.id;
    if (id) map[id] = item.ownerRevenue ?? item.owner_revenue ?? item.revenue ?? null;
  }
  return map;
}

// ─── RÉCUPÉRATION LISTE RÉSERVATIONS (endpoint direct) ───────────────────────
async function fetchReservationsList(token, from, to) {
  // Essayer l'endpoint de liste des réservations pour la propriété
  const endpoints = [
    `/owners/me/reservations?listingId=${LISTING_ID}&checkIn[gte]=${from}&checkOut[lte]=${to}&limit=50`,
    `/v2/reservations?listingId=${LISTING_ID}&checkIn[gte]=${from}&checkOut[lte]=${to}&limit=50`,
    `/reservations?listingId=${LISTING_ID}&checkIn[gte]=${from}&checkOut[lte]=${to}&limit=50`,
  ];
  for (const ep of endpoints) {
    const res = await guestyGet(ep, token);
    if (res.status === 200 && res.body) {
      const list = res.body.results || res.body.data || res.body.reservations || (Array.isArray(res.body) ? res.body : null);
      if (list && list.length >= 0) {
        console.log(`  ✅ Liste réservations via ${ep.split("?")[0]} (${list.length})`);
        return list;
      }
    }
  }
  return null;
}

// ─── SCRAPING PRINCIPAL ───────────────────────────────────────────────────────
async function scrapeGuesty() {
  const token = await getJwtToken();

  const now = new Date();
  const allReservations = [];
  const seenIds = new Set();

  // Fenêtre totale : aujourd'hui + MONTHS_AHEAD mois
  const fromDate = now.toISOString().slice(0, 10);
  const toDate   = new Date(now.getFullYear(), now.getMonth() + MONTHS_AHEAD + 1, 0).toISOString().slice(0, 10);

  console.log(`\n🔍 Recherche réservations ${fromDate} → ${toDate}`);

  // 1. Essayer d'abord la liste directe (plus efficace)
  const directList = await fetchReservationsList(token, fromDate, toDate);

  if (directList !== null) {
    // On a la liste directement
    const reservationIds = directList.map(r => r._id || r.id).filter(Boolean);

    // Récupérer les revenus propriétaire en batch
    const revenueMap = await fetchOwnerRevenue(token, reservationIds);

    for (const r of directList) {
      const id = r._id || r.id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const checkIn  = r.checkInDateLocalized || r.checkIn  || r.checkInDate;
      const checkOut = r.checkOutDateLocalized || r.checkOut || r.checkOutDate;

      const reservation = {
        id,
        checkIn:  checkIn?.slice(0, 10),
        checkOut: checkOut?.slice(0, 10),
        nights:   r.nightsCount || r.nights || null,
        guestName: r.guestName || r.guest?.fullName || r.guest?.firstName
                    ? `${r.guest?.firstName || ""} ${r.guest?.lastName || ""}`.trim()
                    : null,
        source:   r.source || r.channel || null,
        status:   r.status || null,
        ownerRevenue: revenueMap[id] ?? r.ownerRevenue ?? r.money?.ownerRevenue ?? null,
      };
      allReservations.push(reservation);
      console.log(`  🏨 ${reservation.checkIn} → ${reservation.checkOut} | ${reservation.nights}n | ${reservation.ownerRevenue != null ? reservation.ownerRevenue + "€" : "?€"} | ${reservation.guestName || "?"} | ${reservation.source || "?"}`);
    }
  } else {
    // 2. Fallback : passer par le calendrier pour trouver les IDs
    console.log("  ⚠️  Liste directe indisponible — fallback via calendrier");

    const days = await fetchCalendar(token, fromDate, toDate);
    const reservationIds = [...new Set(
      days.filter(d => d.reservationId || d.reservation?._id)
          .map(d => d.reservationId || d.reservation?._id)
    )];

    console.log(`  📊 ${reservationIds.length} réservation(s) trouvée(s) via calendrier`);

    // Récupérer revenus en batch
    const revenueMap = await fetchOwnerRevenue(token, reservationIds);

    for (const resId of reservationIds) {
      if (seenIds.has(resId)) continue;
      seenIds.add(resId);

      const detail = await fetchReservation(token, resId);
      if (!detail) {
        console.warn(`  ⚠️  Détails indisponibles pour ${resId}`);
        // Construire une réservation minimale depuis les jours du calendrier
        const resDays = days.filter(d => (d.reservationId || d.reservation?._id) === resId);
        const dates = resDays.map(d => d.date).sort();
        allReservations.push({
          id: resId,
          checkIn:  dates[0] || null,
          checkOut: dates[dates.length - 1] || null,
          nights:   dates.length,
          guestName: null,
          source:   resDays[0]?.source || null,
          status:   resDays[0]?.status || "confirmed",
          ownerRevenue: revenueMap[resId] ?? null,
        });
        continue;
      }

      const checkIn  = detail.checkInDateLocalized  || detail.checkIn  || detail.checkInDate;
      const checkOut = detail.checkOutDateLocalized || detail.checkOut || detail.checkOutDate;

      const reservation = {
        id: resId,
        checkIn:  checkIn?.slice(0, 10),
        checkOut: checkOut?.slice(0, 10),
        nights:   detail.nightsCount || detail.nights || null,
        guestName: detail.guestName || (detail.guest ? `${detail.guest.firstName || ""} ${detail.guest.lastName || ""}`.trim() : null),
        source:   detail.source || detail.channel || null,
        status:   detail.status || null,
        ownerRevenue: revenueMap[resId] ?? detail.ownerRevenue ?? detail.money?.ownerRevenue ?? null,
      };
      allReservations.push(reservation);
      console.log(`  🏨 ${reservation.checkIn} → ${reservation.checkOut} | ${reservation.nights}n | ${reservation.ownerRevenue != null ? reservation.ownerRevenue + "€" : "?€"} | ${reservation.guestName || "?"} | ${reservation.source || "?"}`);
    }
  }

  allReservations.sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""));
  console.log(`\n📊 Total : ${allReservations.length} réservation(s)`);
  return allReservations;
}

// ─── ENVOI EMAIL ──────────────────────────────────────────────────────────────
async function sendEmail(prevReservations, allReservations) {
  const prevKeys    = new Set(prevReservations.map(r => r.id));
  const currentKeys = new Set(allReservations.map(r => r.id));
  const newRes      = allReservations.filter(r => !prevKeys.has(r.id));
  const removedRes  = prevReservations.filter(r => !currentKeys.has(r.id));

  const modifiedRes = [];
  for (const r of allReservations) {
    if (!prevKeys.has(r.id)) continue;
    const prev = prevReservations.find(p => p.id === r.id);
    if (!prev) continue;
    const diffs = [];
    if (prev.checkIn      !== r.checkIn)      diffs.push(`Arrivée : <s>${fmtDate(prev.checkIn)}</s> → <b>${fmtDate(r.checkIn)}</b>`);
    if (prev.checkOut     !== r.checkOut)     diffs.push(`Départ : <s>${fmtDate(prev.checkOut)}</s> → <b>${fmtDate(r.checkOut)}</b>`);
    if (prev.guestName    !== r.guestName)    diffs.push(`Voyageur : <s>${prev.guestName||"?"}</s> → <b>${r.guestName||"?"}</b>`);
    if (prev.ownerRevenue !== r.ownerRevenue) diffs.push(`Revenu : <s>${prev.ownerRevenue??'?'}€</s> → <b>${r.ownerRevenue??'?'}€</b>`);
    if (prev.status       !== r.status)       diffs.push(`État : <s>${prev.status||"?"}</s> → <b>${r.status||"?"}</b>`);
    if (diffs.length > 0) modifiedRes.push({ r, diffs });
  }

  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  let html = `<h2>🔔 Modification détectée sur Guesty</h2><p><strong>Date :</strong> ${now}</p>`;

  if (newRes.length > 0) {
    html += `<h3>🆕 Nouvelles réservations :</h3><ul>`;
    for (const r of newRes) {
      const g = buildGCalLink(r);
      html += `<li>🏠 <b>${fmtDate(r.checkIn)}</b> → <b>${fmtDate(r.checkOut)}</b> (${r.nights||"?"}n)`;
      html += ` — <b>${r.ownerRevenue != null ? r.ownerRevenue + " €" : "?"}</b>`;
      html += ` — ${r.guestName||"?"} — ${r.source||"?"} — ${r.status||"?"}`;
      if (g) html += ` &nbsp;<a href="${g}" style="background:#4285F4;color:white;padding:3px 10px;border-radius:4px;text-decoration:none;font-size:12px;">📅 Agenda</a>`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  if (removedRes.length > 0) {
    html += `<h3>❌ Réservations annulées :</h3><ul>`;
    for (const r of removedRes) {
      html += `<li>📅 <b>${fmtDate(r.checkIn)}</b> → <b>${fmtDate(r.checkOut)}</b>${r.guestName ? ` — ${r.guestName}` : ""}</li>`;
    }
    html += `</ul>`;
  }

  if (modifiedRes.length > 0) {
    html += `<h3>🔄 Réservations modifiées :</h3><ul>`;
    for (const { r, diffs } of modifiedRes) {
      html += `<li>📅 <b>${fmtDate(r.checkIn)}</b> → <b>${fmtDate(r.checkOut)}</b> — ${diffs.join(" / ")}</li>`;
    }
    html += `</ul>`;
  }

  // Tableau récap
  html += `<h3>📋 Toutes les réservations (${allReservations.length}) :</h3>`;
  html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">`;
  html += `<tr style="background:#f0f0f0"><th>Arrivée</th><th>Départ</th><th>Nuits</th><th>Revenu propriétaire</th><th>Voyageur</th><th>Plateforme</th><th>État</th><th>Agenda</th></tr>`;
  for (const r of allReservations) {
    const isNew = newRes.some(n => n.id === r.id);
    const isMod = modifiedRes.some(m => m.r.id === r.id);
    const rowStyle = isNew ? ' style="background:#e8f5e9"' : isMod ? ' style="background:#fff3e0"' : '';
    const g = buildGCalLink(r);
    const statusIco = (r.status||"").toLowerCase().includes("cancel") ? "❌" : (r.status||"").toLowerCase().includes("inquir") ? "🟡" : "✅";
    html += `<tr${rowStyle}>`;
    html += `<td><b>${fmtDate(r.checkIn)}</b></td><td>${fmtDate(r.checkOut)}</td>`;
    html += `<td>${r.nights||"?"}</td>`;
    html += `<td><b>${r.ownerRevenue != null ? r.ownerRevenue + " €" : "?"}</b></td>`;
    html += `<td>${r.guestName||"?"}</td><td>${r.source||"?"}</td>`;
    html += `<td>${statusIco} ${r.status||"?"}</td>`;
    html += `<td>${g ? `<a href="${g}" style="background:#4285F4;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:11px;">📅</a>` : ""}</td>`;
    html += `</tr>`;
  }
  html += `</table>`;

  const totalRevenu = allReservations
    .map(r => parseFloat(r.ownerRevenue) || 0)
    .reduce((a, b) => a + b, 0);
  if (totalRevenu > 0) html += `<p><strong>💰 Revenu propriétaire total : ${totalRevenu.toFixed(2)} €</strong></p>`;
  html += `<p><a href="${PORTAL_URL}/my-properties/${LISTING_ID}/calendar">👉 Calendrier Guesty</a></p>`;

  const subject = newRes.length > 0
    ? `🆕 Nouvelle réservation${newRes.length > 1 ? "s" : ""} : ${fmtDate(newRes[0].checkIn)} → ${fmtDate(newRes[0].checkOut)}`
    : removedRes.length > 0
      ? `❌ Réservation annulée : ${fmtDate(removedRes[0].checkIn)} → ${fmtDate(removedRes[0].checkOut)}`
      : `🔔 Guesty - Modification détectée`;

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD } });
  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html });
  console.log(`✅ Email envoyé : "${subject}"`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Guesty Monitor — ${new Date().toLocaleString("fr-FR")}`);
  try {
    const allReservations = await scrapeGuesty();
    const state = loadState();
    const currentHash = hash(JSON.stringify(allReservations));

    if ("guesty" in state) {
      if (state.guesty.hash !== currentHash) {
        console.log("🔄 Changement détecté");
        await sendEmail(state.guesty.reservations || [], allReservations);
      } else {
        console.log("✅ Aucun changement");
      }
    } else {
      console.log("🆕 Première observation");
      await sendEmail([], allReservations);
    }

    saveState({ guesty: { hash: currentHash, reservations: allReservations } });
    console.log("💾 État sauvegardé");
    process.exit(0);
  } catch (e) {
    console.error("❌", e.message, e.stack);
    process.exit(1);
  }
}

main();
