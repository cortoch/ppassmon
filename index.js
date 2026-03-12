const puppeteer = require("puppeteer-core");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");

const PASSPASS_EMAIL = process.env.PASSPASS_EMAIL || "henri.borreill@gmail.com";
const PASSPASS_PASSWORD = process.env.PASSPASS_PASSWORD || "REMPLACE";
const EMAIL_FROM = process.env.EMAIL_FROM || "henri.borreill@gmail.com";
const EMAIL_TO = process.env.EMAIL_TO || "henri.borreill@gmail.com";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "REMPLACE";
const CACHE_FILE = "state.json";

function hash(str) { return crypto.createHash("md5").update(str).digest("hex"); }
function loadState() {
  if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  return {};
}
function saveState(state) { fs.writeFileSync(CACHE_FILE, JSON.stringify(state, null, 2)); }

function buildGCalLink(reservation) {
  // Parse ISO dates directly (much more reliable)
  if (!reservation.dateDebut || !reservation.dateFin) return null;
  const debut = new Date(reservation.dateDebut);
  const fin = new Date(reservation.dateFin);
  const finExclusive = new Date(fin);
  finExclusive.setDate(finExclusive.getDate() + 1);
  const fmt = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  const nuits = reservation.nuits || "?";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `🏠 Réservation Le jardin d'Henri (${nuits} nuit${nuits > 1 ? "s" : ""})`,
    dates: `${fmt(debut)}/${fmt(finExclusive)}`,
    details: `Réservation du ${reservation.debut} au ${reservation.fin}\n${nuits} nuits\nVoyageur: ${reservation.voyageur || "?"}\nRevenu: ${reservation.revenu || "?"}\nÉtat: ${reservation.etat || "?"}`,
    location: "Le jardin d'Henri",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ─── SCRAPING PRINCIPAL : tableau structuré ───────────────────────────────────
async function scrapeReservationsFromTable(page) {
  console.log("🔎 Tentative scraping tableau structuré...");
  const reservations = await page.evaluate(() => {
    const results = [];

    // Cherche toutes les lignes de tableau qui ressemblent à des réservations
    // L'interface Passpass utilise des tableaux ou des listes de séjours
    const rows = Array.from(document.querySelectorAll("tr, [class*='row'], [class*='booking'], [class*='reservation'], [class*='sejour'], [class*='stay']"));

    for (const row of rows) {
      const text = row.innerText || "";
      // Détecte les lignes avec des dates (pattern "DD Mois - DD Mois" ou "DD/MM - DD/MM")
      if (!text.match(/\d{1,2}\s+\w+\s*[-–]\s*\d{1,2}\s+\w+|\d{1,2}\/\d{2}\s*[-–]\s*\d{1,2}\/\d{2}/)) continue;

      // Extrait les cellules
      const cells = Array.from(row.querySelectorAll("td, [class*='cell'], [class*='col']"))
        .map(c => c.innerText.replace(/\s+/g, " ").trim())
        .filter(t => t.length > 0);

      if (cells.length < 2) continue;
      results.push({ cells, rawText: text.replace(/\s+/g, " ").trim() });
    }

    // Si aucune ligne trouvée via tableau, cherche les éléments de liste de séjours
    if (results.length === 0) {
      const items = Array.from(document.querySelectorAll("[class*='item'], [class*='card'], [class*='entry']"));
      for (const item of items) {
        const text = item.innerText || "";
        if (!text.match(/\d{1,2}\s+\w+/)) continue;
        results.push({ cells: [], rawText: text.replace(/\s+/g, " ").trim() });
      }
    }

    return results;
  });

  console.log(`  📋 ${reservations.length} ligne(s) de tableau détectée(s)`);
  return reservations;
}

// ─── PARSING ROBUSTE DES DONNÉES DE TABLEAU ──────────────────────────────────
function parseTableRows(rows) {
  const MOIS_FR = {
    "jan": 0, "janv": 0, "janvier": 0,
    "fév": 1, "fev": 1, "févr": 1, "fevr": 1, "février": 1, "fevrier": 1,
    "mar": 2, "mars": 2,
    "avr": 3, "avril": 3,
    "mai": 4,
    "jun": 5, "juin": 5,
    "jul": 6, "juil": 6, "juillet": 6,
    "aoû": 7, "aou": 7, "août": 7, "aout": 7,
    "sep": 8, "sept": 8, "septembre": 8,
    "oct": 9, "octobre": 9,
    "nov": 10, "novembre": 10,
    "déc": 11, "dec": 11, "décembre": 11, "decembre": 11,
  };

  function parseFrDate(str, refYear) {
    const clean = str.trim().toLowerCase();
    const m = clean.match(/(\d{1,2})\s+([a-zéûôàèùâêîïü]+)(?:\s+(\d{4}))?/);
    if (!m) return null;
    const jour = parseInt(m[1]);
    const moisKey = m[2].replace(/\./g, "");
    const moisNum = MOIS_FR[moisKey];
    const annee = m[3] ? parseInt(m[3]) : refYear;
    if (isNaN(jour) || moisNum === undefined) return null;
    return new Date(annee, moisNum, jour);
  }

  function toISO(d) {
    if (!d) return null;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  const reservations = [];
  const currentYear = new Date().getFullYear();

  for (const row of rows) {
    const text = row.rawText;
    const cells = row.cells;

    // Tente d'extraire date début et fin
    const dateRangeMatch = text.match(/(\d{1,2}\s+[a-zA-ZÀ-ÿ]+(?:\s+\d{4})?)\s*[-–]\s*(\d{1,2}\s+[a-zA-ZÀ-ÿ]+(?:\s+\d{4})?)/);
    if (!dateRangeMatch) continue;

    const dateDebut = parseFrDate(dateRangeMatch[1], currentYear);
    let dateFin = parseFrDate(dateRangeMatch[2], currentYear);

    // Si la fin est avant le début, c'est l'année suivante
    if (dateDebut && dateFin && dateFin < dateDebut) {
      dateFin = parseFrDate(dateRangeMatch[2], currentYear + 1);
    }

    // Extrait nuitées (nombre isolé)
    const nuitsMatch = text.match(/\b(\d+)\s*nuit/i) || cells.find(c => /^\d+$/.test(c));
    const nuits = nuitsMatch ? (Array.isArray(nuitsMatch) ? nuitsMatch[0] : nuitsMatch[1]) : null;

    // Extrait revenu (montant en €)
    const revenuMatch = text.match(/([\d\s.,]+\s*€)/);
    const revenu = revenuMatch ? revenuMatch[1].trim() : null;

    // Extrait voyageur (nom + infos voyageurs)
    const voyageurMatch = text.match(/([A-Z][a-zA-ZÀ-ÿ]+\s+[A-Z]\.(?:\s*[-–]\s*\d+\s*voyageurs?.*)?)/);
    const voyageur = voyageurMatch ? voyageurMatch[1].trim() : null;

    // Détecte la plateforme (Airbnb, Booking, etc.)
    const plateformeMatch = text.match(/airbnb|booking|abritel|vrbo|direct/i);
    const plateforme = plateformeMatch ? plateformeMatch[0].toLowerCase() : null;

    // Détecte l'état
    let etat = "À venir";
    if (text.match(/en cours|en\s+cours/i)) etat = "En cours";
    else if (text.match(/termin|passé|fini/i)) etat = "Terminé";
    else if (text.match(/annul/i)) etat = "Annulé";
    else if (text.match(/attente|pending/i)) etat = "En attente";

    const res = {
      debut: dateRangeMatch[1].trim(),
      fin: dateRangeMatch[2].trim(),
      dateDebut: toISO(dateDebut),
      dateFin: toISO(dateFin),
      nuits: nuits ? String(nuits) : null,
      revenu,
      voyageur,
      plateforme,
      etat,
    };

    console.log(`   ✅ Parsé: ${res.debut} → ${res.fin} | ${res.nuits} nuits | ${res.revenu || "?"} | ${res.voyageur || "?"} | ${res.plateforme || "?"}`);
    reservations.push(res);
  }

  return reservations;
}

// ─── FALLBACK : scraping DOM complet si tableau non trouvé ────────────────────
async function scrapeFullPageText(page) {
  console.log("⚠️  Fallback scraping texte brut...");
  return await page.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll("script, style, nav, header, footer").forEach(el => el.remove());
    return body.innerText;
  });
}

// ─── SCREENSHOT DE DEBUG ──────────────────────────────────────────────────────
async function takeDebugScreenshot(page, label) {
  try {
    const path = `/tmp/debug_${label}_${Date.now()}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log(`📸 Screenshot: ${path}`);
  } catch (e) { /* non bloquant */ }
}

// ─── ENVOI EMAIL ──────────────────────────────────────────────────────────────
async function sendEmail(previousAllRes, allReservations) {
  const previousKeys = new Set(previousAllRes.map(r => `${r.dateDebut}-${r.dateFin}`));
  const newRes = allReservations.filter(r => !previousKeys.has(`${r.dateDebut}-${r.dateFin}`));
  const currentKeys = new Set(allReservations.map(r => `${r.dateDebut}-${r.dateFin}`));
  const removedRes = previousAllRes.filter(r => !currentKeys.has(`${r.dateDebut}-${r.dateFin}`));

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD } });
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  const plateformeIcon = p => {
    if (!p) return "🏠";
    if (p.includes("airbnb")) return "🔴";
    if (p.includes("booking")) return "🔵";
    if (p.includes("abritel") || p.includes("vrbo")) return "🟢";
    return "🏠";
  };

  let html = `<h2>🔔 Modification détectée sur Passpass</h2><p><strong>Date :</strong> ${now}</p>`;

  if (newRes.length > 0) {
    html += `<h3>🆕 Nouvelles réservations :</h3><ul>`;
    for (const r of newRes) {
      const gcalLink = buildGCalLink(r);
      html += `<li>${plateformeIcon(r.plateforme)} <b>${r.debut}</b> → <b>${r.fin}</b>`;
      if (r.nuits) html += ` (${r.nuits} nuit${r.nuits > 1 ? 's' : ''})`;
      if (r.revenu) html += ` — <b>${r.revenu}</b>`;
      if (r.voyageur) html += ` — ${r.voyageur}`;
      html += ` — ${r.etat}`;
      if (gcalLink) html += ` &nbsp;<a href="${gcalLink}" style="background:#4285F4;color:white;padding:3px 10px;border-radius:4px;text-decoration:none;font-size:12px;">📅 Agenda</a>`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  if (removedRes.length > 0) {
    html += `<h3>❌ Réservations annulées / supprimées :</h3><ul>`;
    for (const r of removedRes) {
      html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b>`;
      if (r.voyageur) html += ` — ${r.voyageur}`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  // Calcul du revenu total
  const totalRevenu = allReservations
    .map(r => parseFloat((r.revenu || "").replace(/[^\d.,]/g, "").replace(",", ".")))
    .filter(n => !isNaN(n))
    .reduce((a, b) => a + b, 0);

  html += `<h3>📋 Toutes les réservations (${allReservations.length}) :</h3>`;
  html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">`;
  html += `<tr style="background:#f0f0f0"><th>Dates</th><th>Nuits</th><th>Revenu</th><th>Voyageur</th><th>Plateforme</th><th>État</th><th>Agenda</th></tr>`;
  for (const r of allReservations) {
    const gcalLink = buildGCalLink(r);
    const emoji = r.etat.includes("cours") ? "🟠" : r.etat.includes("attente") ? "🟡" : r.etat.includes("venir") ? "🔵" : r.etat.includes("Terminé") ? "✅" : "❌";
    html += `<tr>`;
    html += `<td><b>${r.debut}</b> → ${r.fin}</td>`;
    html += `<td style="text-align:center">${r.nuits || "?"}</td>`;
    html += `<td>${r.revenu || "?"}</td>`;
    html += `<td>${r.voyageur || "?"}</td>`;
    html += `<td>${plateformeIcon(r.plateforme)} ${r.plateforme || "?"}</td>`;
    html += `<td>${emoji} ${r.etat}</td>`;
    html += `<td>${gcalLink ? `<a href="${gcalLink}" style="background:#4285F4;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:11px;">📅</a>` : ""}</td>`;
    html += `</tr>`;
  }
  html += `</table>`;

  if (totalRevenu > 0) {
    html += `<p><strong>💰 Revenu total (réservations affichées) : ${totalRevenu.toFixed(2)} €</strong></p>`;
  }

  html += `<p><a href="https://client.passpass.io/dashboard">👉 Voir le dashboard Passpass</a></p>`;

  const subject = newRes.length > 0
    ? `🆕 Nouvelle réservation${newRes.length > 1 ? "s" : ""} : ${newRes[0].debut} → ${newRes[0].fin}`
    : removedRes.length > 0
      ? `❌ Réservation annulée : ${removedRes[0].debut} → ${removedRes[0].fin}`
      : `🔔 Passpass - Modification détectée`;

  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html });
  console.log(`✅ Email envoyé : "${subject}"`);
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(page) {
  await page.goto("https://client.passpass.io/login", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#email", { timeout: 10000 });
  await page.evaluate((email, password) => {
    function fill(id, value) {
      const el = document.getElementById(id);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    fill("email", email);
    fill("password", password);
  }, PASSPASS_EMAIL, PASSPASS_PASSWORD);
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') || document.querySelector('button');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 8000));
  if (page.url().includes("login")) throw new Error("Connexion échouée");
}

// ─── NAVIGATION VERS LA PROPRIÉTÉ ────────────────────────────────────────────
async function navigateToProperty(page) {
  // Attendre que la page soit chargée (au moins un titre ou contenu visible)
  await new Promise(r => setTimeout(r, 3000));
  await takeDebugScreenshot(page, "accueil");

  // Dump du texte visible pour debug
  const pageText = await page.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll("script, style").forEach(el => el.remove());
    return body.innerText.replace(/\s+/g, " ").trim().substring(0, 1000);
  });
  console.log(`📄 Contenu page accueil (1000c): ${pageText}`);

  // Cherche "jardin" (insensible à la casse + accents) ou n'importe quelle propriété cliquable
  const found = await page.evaluate(() => {
    const pattern = /jardin|henri|passpass|property|logement/i;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (pattern.test(node.textContent)) {
        let el = node.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!el) break;
          const style = window.getComputedStyle(el);
          if (style.cursor === "pointer" || el.tagName === "A" || el.tagName === "BUTTON") {
            el.click();
            return el.tagName + ": " + el.innerText?.substring(0, 50);
          }
          el = el.parentElement;
        }
        // Clique quand même sur le parent direct
        node.parentElement?.click();
        return "fallback: " + node.textContent.trim().substring(0, 50);
      }
    }
    return null;
  });

  if (found) {
    console.log(`✅ Propriété cliquée: ${found}`);
  } else {
    console.log(`⚠️  Propriété non trouvée dans la page — on continue quand même`);
  }

  await new Promise(r => setTimeout(r, 5000));
  await takeDebugScreenshot(page, "apres_clic_propriete");
  console.log(`📍 URL dashboard: ${page.url()}`);
}

// ─── NAVIGATION ENTRE LES MOIS ────────────────────────────────────────────────
async function navigateToNextMonth(page) {
  const clicked = await page.evaluate(() => {
    // Cherche le bouton "suivant" du calendrier ou d'une pagination
    const selectors = [".fc-next-button", "[aria-label*='next']", "[aria-label*='suivant']", "button.next", ".next-month", "[class*='next']"];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return true; }
    }
    return false;
  });
  if (!clicked) console.log("⚠️  Bouton 'suivant' non trouvé");
  await new Promise(r => setTimeout(r, 2500));
}

// ─── SCRAPING PRINCIPAL ───────────────────────────────────────────────────────
async function scrapePasspass() {
  console.log(`🔍 Vérification - ${new Date().toLocaleString("fr-FR")}`);
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome-stable",
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) console.log(`🌐 Navigation: ${frame.url()}`);
    });

    await login(page);
    console.log("✅ Connecté !");
    await navigateToProperty(page);
    await takeDebugScreenshot(page, "dashboard");

    let allReservations = [];
    const seen = new Set();

    // Scrape le mois en cours + 5 mois suivants
    for (let i = 0; i <= 5; i++) {
      const label = i === 0 ? "Mois en cours" : `Mois +${i}`;
      console.log(`\n📆 ${label}...`);

      // Tente d'abord le scraping tableau
      const rows = await scrapeReservationsFromTable(page);
      let monthRes = parseTableRows(rows);

      // Si rien trouvé, fallback texte brut
      if (monthRes.length === 0) {
        const text = await scrapeFullPageText(page);
        // Log un extrait pour debug
        const excerpt = text.substring(0, 500).replace(/\n/g, " | ");
        console.log(`  📝 Texte brut (500c): ${excerpt}`);
        // On pourrait ré-implémenter le parser texte ici si nécessaire
      }

      console.log(`  ✅ ${monthRes.length} réservation(s) pour ${label}`);

      for (const r of monthRes) {
        const key = `${r.dateDebut}-${r.dateFin}`;
        if (!seen.has(key)) {
          seen.add(key);
          allReservations.push(r);
        }
      }

      if (i < 5) await navigateToNextMonth(page);
    }

    // Tri par date
    allReservations.sort((a, b) => (a.dateDebut || "").localeCompare(b.dateDebut || ""));

    console.log(`\n📊 Total: ${allReservations.length} réservation(s) sur 6 mois`);
    allReservations.forEach(r => {
      console.log(`   ${r.debut} → ${r.fin} | ${r.nuits || "?"}n | ${r.revenu || "?"} | ${r.voyageur || "?"} | ${r.etat}`);
    });

    return allReservations;

  } finally {
    await browser.close();
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🚀 Passpass Monitor - GitHub Actions");
  try {
    const allReservations = await scrapePasspass();
    const previousState = loadState();
    const currentHash = hash(JSON.stringify(allReservations));

    if ("dashboard" in previousState) {
      if (previousState.dashboard.hash !== currentHash) {
        console.log("🔄 CHANGEMENT détecté !");
        await sendEmail(previousState.dashboard.reservations || [], allReservations);
      } else {
        console.log("✅ Aucun changement détecté");
      }
    } else {
      console.log("🆕 Première observation — email récapitulatif envoyé");
      await sendEmail([], allReservations);
    }

    saveState({ dashboard: { hash: currentHash, reservations: allReservations } });
    console.log("💾 État sauvegardé");
    process.exit(0);
  } catch (e) {
    console.error("❌ Erreur:", e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
