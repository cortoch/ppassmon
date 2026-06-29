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
const API_BASE     = "https://app.guesty.com/api";
const G_AID_CS     = "G-89C7E-9FB65-B6F69";
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

// ─── APPEL API DEPUIS LA PAGE (utilise les cookies de session) ────────────────
async function pageGet(page, url) {
  return page.evaluate(async ({ url, gaid }) => {
    const token = localStorage.getItem("token");
    try {
      const r = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "g-aid-cs": gaid,
          "Accept": "application/json",
        },
        credentials: "include",
      });
      const text = await r.text();
      try { return { status: r.status, body: JSON.parse(text) }; }
      catch(e) { return { status: r.status, body: text.substring(0, 300) }; }
    } catch(e) {
      return { status: 0, error: e.message };
    }
  }, { url, gaid: G_AID_CS });
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(page) {
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
  await new Promise(r => setTimeout(r, 8000));
  if (page.url().includes("login")) throw new Error("Login échoué");
  console.log(`✅ Connecté : ${page.url()}`);

  // Naviguer sur le calendrier pour initialiser le contexte complet
  await page.goto(`${PORTAL_URL}/my-properties/${LISTING_ID}/calendar`, { waitUntil: "networkidle2", timeout: 20000 });
  await new Promise(r => setTimeout(r, 3000));

  const token = await page.evaluate(() => localStorage.getItem("token"));
  if (!token || token.length < 20) throw new Error("JWT introuvable");
  console.log(`🔑 Token OK (${token.length} chars)`);
}

// ─── RÉCUPÉRATION DES RÉSERVATIONS ───────────────────────────────────────────
async function fetchReservations(page) {
  const now = new Date();
  const fromDate = now.toISOString().slice(0, 10);
  const toDate = new Date(now.getFullYear(), now.getMonth() + MONTHS_AHEAD + 1, 0).toISOString().slice(0, 10);
  console.log(`\n🔍 Recherche réservations ${fromDate} → ${toDate}`);

  // 1. Essayer la liste directe
  const listEndpoints = [
    `${API_BASE}/owners/me/reservations?listingId=${LISTING_ID}&checkIn[gte]=${fromDate}&checkOut[lte]=${toDate}&limit=50`,
    `${API_BASE}/v2/reservations?listingId=${LISTING_ID}&checkIn[gte]=${fromDate}&checkOut[lte]=${toDate}&limit=50`,
  ];
  for (const url of listEndpoints) {
    const res = await pageGet(page, url);
    const shortUrl = url.split("?")[0].replace(API_BASE, "");
    console.log(`  📦 ${shortUrl} → HTTP ${res.status}`);
    if (res.status === 200 && res.body && typeof res.body === "object") {
      const list = res.body.results || res.body.data || res.body.reservations || (Array.isArray(res.body) ? res.body : null);
      if (list !== null) {
        console.log(`  ✅ Liste directe OK : ${list.length} réservation(s)`);
        return { list, fromDate, toDate };
      }
      console.log(`  ⚠️  Réponse inattendue : ${JSON.stringify(res.body).substring(0, 150)}`);
    }
  }

  // 2. Fallback calendrier
  console.log("  ⚠️  Liste directe indisponible — fallback via calendrier");
  const calUrl = `${API_BASE}/v2/listings/${LISTING_ID}/calendar?from=${fromDate}&to=${toDate}`;
  const calRes = await pageGet(page, calUrl);
  console.log(`  📦 Calendar → HTTP ${calRes.status} : ${JSON.stringify(calRes.body).substring(0, 200)}`);
  if (calRes.status !== 200 || !calRes.body) return { list: null, days: [], fromDate, toDate };
  const days = Array.isArray(calRes.body) ? calRes.body : (calRes.body?.days || calRes.body?.data || []);
  return { list: null, days, fromDate, toDate };
}

// ─── RÉCUPÉRATION DU REVENU PROPRIÉTAIRE ─────────────────────────────────────
async function fetchOwnerRevenue(page, reservationIds) {
  if (!reservationIds.length) return {};
  const ids = reservationIds.join(",");
  const url = `${API_BASE}/revenue-analytics/analytics/owner/${OWNER_ID}?reservationIds=${ids}`;
  const res = await pageGet(page, url);
  if (res.status !== 200 || !res.body || typeof res.body !== "object") return {};
  const items = res.body.data || res.body.results || res.body.analytics || (Array.isArray(res.body) ? res.body : []);
  const map = {};
  for (const item of items) {
    const id = item.reservationId || item._id || item.id;
    if (id) map[id] = item.ownerRevenue ?? item.owner_revenue ?? item.revenue ?? null;
  }
  return map;
}

// ─── SCRAPING PRINCIPAL ───────────────────────────────────────────────────────
async function scrapeGuesty() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome-stable",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();
    await login(page);

    const { list, days, fromDate, toDate } = await fetchReservations(page);
    const allReservations = [];
    const seenIds = new Set();

    if (list !== null) {
      const ids = list.map(r => r._id || r.id).filter(Boolean);
      const revenueMap = await fetchOwnerRevenue(page, ids);
      for (const r of list) {
        const id = r._id || r.id;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        const checkIn  = (r.checkInDateLocalized  || r.checkIn  || r.checkInDate  || "").slice(0, 10);
        const checkOut = (r.checkOutDateLocalized || r.checkOut || r.checkOutDate || "").slice(0, 10);
        const res = {
          id, checkIn, checkOut,
          nights: r.nightsCount || r.nights || null,
          guestName: r.guestName || (r.guest ? `${r.guest.firstName||""} ${r.guest.lastName||""}`.trim() : null),
          source: r.source || r.channel || null,
          status: r.status || null,
          ownerRevenue: revenueMap[id] ?? r.ownerRevenue ?? r.money?.ownerRevenue ?? null,
        };
        allReservations.push(res);
        console.log(`  🏨 ${res.checkIn} → ${res.checkOut} | ${res.nights}n | ${res.ownerRevenue != null ? res.ownerRevenue + "€" : "?€"} | ${res.guestName || "?"} | ${res.source || "?"}`);
      }
    } else if (days && days.length > 0) {
      const reservationIds = [...new Set(days.filter(d => d.reservationId || d.reservation?._id).map(d => d.reservationId || d.reservation?._id))];
      console.log(`  📊 ${reservationIds.length} réservation(s) via calendrier`);
      const revenueMap = await fetchOwnerRevenue(page, reservationIds);
      for (const resId of reservationIds) {
        if (seenIds.has(resId)) continue;
        seenIds.add(resId);
        const resDays = days.filter(d => (d.reservationId || d.reservation?._id) === resId);
        const dates = resDays.map(d => d.date).sort();
        const res = {
          id: resId,
          checkIn: dates[0] || null,
          checkOut: dates[dates.length - 1] || null,
          nights: dates.length,
          guestName: null,
          source: resDays[0]?.source || null,
          status: resDays[0]?.status || "confirmed",
          ownerRevenue: revenueMap[resId] ?? null,
        };
        allReservations.push(res);
        console.log(`  🏨 ${res.checkIn} → ${res.checkOut} | ${res.nights}n | ${res.ownerRevenue != null ? res.ownerRevenue + "€" : "?€"}`);
      }
    }

    allReservations.sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""));
    console.log(`\n📊 Total : ${allReservations.length} réservation(s)`);
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
