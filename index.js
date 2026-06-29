const puppeteer = require("puppeteer-core");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GUESTY_EMAIL    = process.env.GUESTY_EMAIL    || "henri.borreill@gmail.com";
const GUESTY_PASSWORD = process.env.GUESTY_PASSWORD || "REMPLACE";
const EMAIL_FROM      = process.env.EMAIL_FROM      || "henri.borreill@gmail.com";
const EMAIL_TO        = process.env.EMAIL_TO        || "henri.borreill@gmail.com";
const EMAIL_PASSWORD  = process.env.EMAIL_PASSWORD  || "REMPLACE";

const LISTING_ID   = "69e5e471e72c790015c810de";
const OWNER_ID     = "69ef0aceb851941a87f7042d";
const PORTAL_URL   = "https://mercijulie.guestyowners.com";
const CACHE_FILE   = "state.json";
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

// ─── SCRAPING PRINCIPAL ───────────────────────────────────────────────────────
// Stratégie : intercepter les réponses réseau pendant la navigation normale
// app.guesty.com accepte les requêtes depuis le browser Puppeteer car il envoie
// les headers Authorization automatiquement via les XHR de l'app.
async function scrapeGuesty() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome-stable",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();

    // Intercepter toutes les réponses réseau
    const captured = {};
    page.on("response", async response => {
      const url = response.url();
      if (!url.includes("app.guesty.com/api")) return;
      try {
        const body = await response.json();
        if (url.includes("/calendar")) {
          // Fusionner tous les mois capturés
          const days = Array.isArray(body) ? body : (body.days || body.data || []);
          if (!captured.calendarDays) captured.calendarDays = [];
          captured.calendarDays.push(...days);
          captured.calendar = body;
        } else if (url.includes("/owners/me/reservations") || url.includes("/v2/reservations")) {
          captured.reservations = body;
        } else if (url.includes("revenue-analytics") && Array.isArray(body) && body[0]?.reservationId) {
          // Capturer les données revenue avec reservationId
          if (!captured.revenueItems) captured.revenueItems = [];
          captured.revenueItems.push(...body);
        }
      } catch(e) { /* pas JSON */ }
    });

    // Login
    console.log("🌐 Navigation vers le portail...");
    await page.goto(`${PORTAL_URL}/login`, { waitUntil: "networkidle2", timeout: 30000 });
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
    await new Promise(r => setTimeout(r, 6000));
    if (page.url().includes("login")) throw new Error("Login échoué");
    console.log(`✅ Connecté : ${page.url()}`);

    // Naviguer vers le calendrier — déclenche les appels API
    const now = new Date();
    const fromDate = now.toISOString().slice(0, 10);
    const toDate = new Date(now.getFullYear(), now.getMonth() + MONTHS_AHEAD + 1, 0).toISOString().slice(0, 10);

    console.log(`\n🔍 Chargement calendrier ${fromDate} → ${toDate}`);
    await page.goto(`${PORTAL_URL}/my-properties/${LISTING_ID}/calendar`, { waitUntil: "networkidle2", timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));

    // Naviguer plusieurs mois pour capturer toutes les réservations
    for (let i = 0; i < MONTHS_AHEAD; i++) {
      // Cliquer le bouton "mois suivant"
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        // Le bouton suivant est le dernier bouton de navigation (chevron >)
        const nextBtn = btns.find(b => b.querySelector('svg') && !b.textContent.includes("juin") && !b.textContent.includes("2026"));
        // Chercher par position : bouton à droite du sélecteur de mois
        const navBtns = btns.filter(b => b.className.includes("gst-inline-flex"));
        if (navBtns.length >= 2) navBtns[navBtns.length - 1].click();
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`\n📦 Données capturées : ${Object.keys(captured).join(", ") || "aucune"}`);

    // Parser les réservations
    const allReservations = [];
    const seenIds = new Set();

    // Construire la map revenue : reservationId -> ownerRevenue
    const revenueMap = {};
    for (const item of (captured.revenueItems || [])) {
      const id = item.reservationId;
      if (id) revenueMap[id] = item.accountBased?.revenue ?? item.reservationBased?.revenue ?? null;
    }
    console.log(`  💰 ${Object.keys(revenueMap).length} revenu(s) capturé(s)`);

    // Construire les réservations depuis les jours du calendrier (status=booked, blocks.b=true)
    const allDays = captured.calendarDays || [];
    console.log(`  📅 ${allDays.length} jours de calendrier capturés`);

    // Regrouper les jours consécutifs "booked" en séjours
    const bookedDays = allDays.filter(d => d.status === "booked" || d.blocks?.b === true).map(d => d.date).sort();
    console.log(`  🟢 ${bookedDays.length} jours réservés`);

    // Trouver les séjours : séquences de jours consécutifs
    const stays = [];
    let stayStart = null, prevDate = null;
    for (const date of bookedDays) {
      if (!prevDate) { stayStart = date; prevDate = date; continue; }
      const prev = new Date(prevDate + "T00:00:00");
      const curr = new Date(date + "T00:00:00");
      const diff = (curr - prev) / 86400000;
      if (diff > 1) {
        // Fin du séjour précédent
        stays.push({ checkIn: stayStart, checkOut: prevDate });
        stayStart = date;
      }
      prevDate = date;
    }
    if (stayStart) stays.push({ checkIn: stayStart, checkOut: prevDate });

    console.log(`  🏨 ${stays.length} séjour(s) détecté(s)`);

    // Associer les revenus aux séjours par ordre chronologique
    const revenueIds = Object.keys(revenueMap).sort();
    for (let i = 0; i < stays.length; i++) {
      const stay = stays[i];
      const id = revenueIds[i] || `stay-${stay.checkIn}`;
      const nights = Math.round((new Date(stay.checkOut+"T00:00:00") - new Date(stay.checkIn+"T00:00:00")) / 86400000) + 1;
      if (!seenIds.has(stay.checkIn)) {
        seenIds.add(stay.checkIn);
        allReservations.push({
          id,
          checkIn: stay.checkIn,
          checkOut: stay.checkOut,
          nights,
          guestName: null,
          source: null,
          status: "confirmed",
          ownerRevenue: revenueMap[id] ?? null,
        });
      }
    }

    allReservations.sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""));
    console.log(`\n📊 Total : ${allReservations.length} réservation(s)`);
    allReservations.forEach(r => console.log(`  🏨 ${r.checkIn} → ${r.checkOut} | ${r.nights}n | ${r.ownerRevenue != null ? r.ownerRevenue + "€" : "?€"} | ${r.guestName || "?"} | ${r.source || "?"}`));
    return allReservations;

  } finally {
    await browser.close();
  }
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
      html += `<li>🏠 <b>${fmtDate(r.checkIn)}</b> → <b>${fmtDate(r.checkOut)}</b> (${r.nights||"?"}n) — <b>${r.ownerRevenue != null ? r.ownerRevenue + " €" : "?"}</b> — ${r.guestName||"?"} — ${r.source||"?"} — ${r.status||"?"}`;
      if (g) html += ` &nbsp;<a href="${g}" style="background:#4285F4;color:white;padding:3px 10px;border-radius:4px;text-decoration:none;font-size:12px;">📅 Agenda</a>`;
      html += `</li>`;
    }
    html += `</ul>`;
  }
  if (removedRes.length > 0) {
    html += `<h3>❌ Réservations annulées :</h3><ul>`;
    for (const r of removedRes) html += `<li>📅 <b>${fmtDate(r.checkIn)}</b> → <b>${fmtDate(r.checkOut)}</b>${r.guestName ? ` — ${r.guestName}` : ""}</li>`;
    html += `</ul>`;
  }
  if (modifiedRes.length > 0) {
    html += `<h3>🔄 Réservations modifiées :</h3><ul>`;
    for (const { r, diffs } of modifiedRes) html += `<li>📅 <b>${fmtDate(r.checkIn)}</b> → <b>${fmtDate(r.checkOut)}</b> — ${diffs.join(" / ")}</li>`;
    html += `</ul>`;
  }

  html += `<h3>📋 Toutes les réservations (${allReservations.length}) :</h3>`;
  html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">`;
  html += `<tr style="background:#f0f0f0"><th>Arrivée</th><th>Départ</th><th>Nuits</th><th>Revenu propriétaire</th><th>Voyageur</th><th>Plateforme</th><th>État</th><th>Agenda</th></tr>`;
  for (const r of allReservations) {
    const isNew = newRes.some(n => n.id === r.id);
    const isMod = modifiedRes.some(m => m.r.id === r.id);
    const rowStyle = isNew ? ' style="background:#e8f5e9"' : isMod ? ' style="background:#fff3e0"' : '';
    const g = buildGCalLink(r);
    const ico = (r.status||"").toLowerCase().includes("cancel") ? "❌" : "✅";
    html += `<tr${rowStyle}><td><b>${fmtDate(r.checkIn)}</b></td><td>${fmtDate(r.checkOut)}</td><td>${r.nights||"?"}</td><td><b>${r.ownerRevenue != null ? r.ownerRevenue + " €" : "?"}</b></td><td>${r.guestName||"?"}</td><td>${r.source||"?"}</td><td>${ico} ${r.status||"?"}</td><td>${g ? `<a href="${g}" style="background:#4285F4;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:11px;">📅</a>` : ""}</td></tr>`;
  }
  html += `</table>`;
  const totalRevenu = allReservations.map(r => parseFloat(r.ownerRevenue)||0).reduce((a,b)=>a+b,0);
  if (totalRevenu > 0) html += `<p><strong>💰 Revenu propriétaire total : ${totalRevenu.toFixed(2)} €</strong></p>`;
  html += `<p><a href="${PORTAL_URL}/my-properties/${LISTING_ID}/calendar">👉 Calendrier Guesty</a></p>`;

  const subject = newRes.length > 0
    ? `🆕 Nouvelle réservation${newRes.length > 1 ? "s" : ""} : ${fmtDate(newRes[0].checkIn)} → ${fmtDate(newRes[0].checkOut)}`
    : removedRes.length > 0 ? `❌ Réservation annulée : ${fmtDate(removedRes[0].checkIn)} → ${fmtDate(removedRes[0].checkOut)}`
    : `🔔 Guesty - Modification détectée`;

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD } });
  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html });
  console.log(`✅ Email : "${subject}"`);
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
