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

// ─── UTILITAIRES DATE ─────────────────────────────────────────────────────────
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

const MOIS_NUM_TO_FR = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];

function parseFrDate(str, refYear) {
  const clean = str.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const m = clean.match(/(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/);
  if (!m) return null;
  const jour = parseInt(m[1]);
  const moisKey = m[2];
  // Try direct match, then normalize accents
  let moisNum = MOIS_FR[moisKey];
  if (moisNum === undefined) {
    // Try with original accents mapping
    const orig = str.trim().toLowerCase();
    const m2 = orig.match(/(\d{1,2})\s+([a-zéûôàèùâêîïü]+)(?:\s+(\d{4}))?/);
    if (m2) moisNum = MOIS_FR[m2[2]];
  }
  const annee = m[3] ? parseInt(m[3]) : refYear;
  if (isNaN(jour) || moisNum === undefined) return null;
  return new Date(annee, moisNum, jour);
}

function toISO(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function buildGCalLink(r) {
  if (!r.dateDebut || !r.dateFin) return null;
  const debut = new Date(r.dateDebut);
  const fin = new Date(r.dateFin);
  const finExclusive = new Date(fin);
  finExclusive.setDate(finExclusive.getDate() + 1);
  const fmt = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  const nuits = r.nuits || "?";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `🏠 Réservation Le jardin d'Henri (${nuits} nuit${nuits > 1 ? "s" : ""})`,
    dates: `${fmt(debut)}/${fmt(finExclusive)}`,
    details: `Du ${r.debut} au ${r.fin}\n${nuits} nuits\nVoyageur: ${r.voyageur || "?"}\nRevenu: ${r.revenu || "?"}\nÉtat: ${r.etat || "?"}`,
    location: "Le jardin d'Henri",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ─── SCREENSHOT ───────────────────────────────────────────────────────────────
async function screenshot(page, label) {
  try {
    await page.screenshot({ path: `/tmp/debug_${label}_${Date.now()}.png`, fullPage: false });
    console.log(`📸 Screenshot: ${label}`);
  } catch (e) {}
}

// ─── LECTURE DU "SÉJOUR SÉLECTIONNÉ" ────────────────────────────────────────
// Lit les données affichées dans le panneau "Séjour sélectionné" après clic sur un jour
function parseSejour(rawText, currentYear) {
  // Format observé : "Séjour sélectionné Dates Nuitées Revenu Voyageur
  //   28 Mars - 31 Mars 3 216.32 € Francisco M. - 3 voyageurs / 2 lits"
  // Aussi disponible en version détaillée :
  //   "Dates 28 Mars - 31 Mars Nuitées 3 Revenu 216.32 € Voyageur Francisco M..."
  const sejourMatch = rawText.match(
    /Dates\s*(\d{1,2}\s+[A-Za-z\u00C0-\u00FF]+\s*[-\u2013]\s*\d{1,2}\s+[A-Za-z\u00C0-\u00FF]+)\s*Nuit[e\u00e9]es?\s*(\d+)\s*Revenu\s*([\d\s.,]+\s*\u20ac)\s*Voyageur\s*([^\n\r]+)/
  );
  if (!sejourMatch) return null;

  const dateRange = sejourMatch[1].trim();
  const nuits = sejourMatch[2].trim();
  const revenu = sejourMatch[3].replace(/\s/g, "").trim();
  const voyageur = sejourMatch[4].trim().split(/[\n\r]/)[0].trim();

  const rangeParts = dateRange.match(/(\d{1,2}\s+[A-Za-zÀ-ÿ]+)\s*[-–]\s*(\d{1,2}\s+[A-Za-zÀ-ÿ]+)/);
  if (!rangeParts) return null;

  const debutStr = rangeParts[1].trim();
  const finStr = rangeParts[2].trim();
  const dateDebut = parseFrDate(debutStr, currentYear);
  let dateFin = parseFrDate(finStr, currentYear);
  if (dateDebut && dateFin && dateFin < dateDebut) {
    dateFin = parseFrDate(finStr, currentYear + 1);
  }

  return {
    debut: debutStr,
    fin: finStr,
    dateDebut: toISO(dateDebut),
    dateFin: toISO(dateFin),
    nuits,
    revenu,
    voyageur,
    plateforme: null,
    etat: "À venir",
  };
}

// ─── SCRAPING D'UN MOIS PAR CLIC SUR CHAQUE JOUR ────────────────────────────
// Pour chaque jour du calendrier, on clique dessus et on lit "Séjour sélectionné"
// C'est la seule méthode fiable pour les mois futurs
async function scrapeMonthByClickingDays(page, monthLabel, calendarYear, calendarMonth) {
  const currentYear = new Date().getFullYear();
  const found = new Map();

  const days = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll(".fc-daygrid-day[data-date]"));
    return cells.map(c => c.getAttribute("data-date")).filter(Boolean);
  });

  if (days.length === 0) {
    console.log(`  ⚠️  Aucune cellule data-date trouvée`);
    return [];
  }
  console.log(`  📅 ${days.length} jours à cliquer (${calendarYear}-${String(calendarMonth).padStart(2,"0")})`);

  await page.screenshot({ path: `/tmp/cal_${calendarYear}_${calendarMonth}_avant.png` });

  const moisDebut = new Date(calendarYear, calendarMonth - 1, 1);
  const moisFin   = new Date(calendarYear, calendarMonth, 0);

  async function readSejour() {
    const raw = await page.evaluate(() => {
      const body = document.body.cloneNode(true);
      body.querySelectorAll("script, style").forEach(el => el.remove());
      return body.innerText;
    });
    return parseSejour(raw, currentYear);
  }

  for (const dayDate of days) {
    // Filtre : jours du mois cible uniquement
    const [dy, dm] = dayDate.split("-").map(Number);
    if (dm !== calendarMonth || dy !== calendarYear) continue;

    // Obtenir les coordonnées de la cellule pour un vrai clic souris Puppeteer
    const rect = await page.evaluate((date) => {
      const cell = document.querySelector(`.fc-daygrid-day[data-date="${date}"]`);
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, dayDate);

    if (!rect || rect.w === 0) {
      console.log(`   ❌ ${dayDate}: cellule invisible ou introuvable`);
      continue;
    }

    const sejourBefore = await readSejour();
    const keyBefore = sejourBefore ? `${sejourBefore.dateDebut}-${sejourBefore.dateFin}` : "";

    // Vrai clic souris via Puppeteer (déclenche les events natifs du navigateur)
    await page.mouse.click(rect.x, rect.y);
    await new Promise(r => setTimeout(r, 700));

    const sejourAfter = await readSejour();
    const keyAfter = sejourAfter ? `${sejourAfter.dateDebut}-${sejourAfter.dateFin}` : "";

    const changed = keyAfter !== keyBefore;
    console.log(`   ${changed ? "🔄" : "·"} ${dayDate} (${Math.round(rect.x)},${Math.round(rect.y)}): "${keyBefore}" → "${keyAfter}"`);

    if (!sejourAfter || !sejourAfter.dateDebut) continue;
    const sejourDebut = new Date(sejourAfter.dateDebut);
    const sejourFin   = new Date(sejourAfter.dateFin);
    if (sejourDebut > moisFin || sejourFin < moisDebut) continue;

    if (!found.has(keyAfter)) {
      found.set(keyAfter, sejourAfter);
      console.log(`   🆕 RÉSERVATION: ${sejourAfter.debut} - ${sejourAfter.fin} | ${sejourAfter.nuits}n | ${sejourAfter.revenu} | ${sejourAfter.voyageur || "?"}`);
    }
  }

  await page.screenshot({ path: `/tmp/cal_${calendarYear}_${calendarMonth}_apres.png` });
  const results = Array.from(found.values());
  console.log(`  📊 ${results.length} réservation(s) pour ${monthLabel}`);
  return results;
}

// Fallback si pas de data-date : clic sur les numéros de jours
async function scrapeMonthByClickingNumbers(page, monthLabel, calendarYear, calendarMonth) {
  const currentYear = new Date().getFullYear();
  const found = new Map();
  const daysInMonth = new Date(calendarYear, calendarMonth, 0).getDate();

  console.log(`  📅 Clic sur ${daysInMonth} numéros de jours...`);

  for (let day = 1; day <= daysInMonth; day++) {
    const clicked = await page.evaluate((dayNum) => {
      // Cherche les éléments qui contiennent le numéro du jour dans le calendrier
      // Exclure les éléments en dehors du calendrier (stats, textes)
      const cal = document.querySelector(".fc, [class*='calendar'], [class*='cal-']");
      if (!cal) return false;
      const links = Array.from(cal.querySelectorAll("a, [class*='day-number'], td"));
      for (const el of links) {
        if (el.innerText?.trim() === String(dayNum)) {
          el.click();
          return true;
        }
      }
      return false;
    }, day);

    if (!clicked) continue;
    await new Promise(r => setTimeout(r, 600));

    const rawText = await page.evaluate(() => {
      const body = document.body.cloneNode(true);
      body.querySelectorAll("script, style").forEach(el => el.remove());
      return body.innerText;
    });

    const sejour = parseSejour(rawText, currentYear);
    if (sejour && sejour.dateDebut) {
      const key = `${sejour.dateDebut}-${sejour.dateFin}`;
      if (!found.has(key)) {
        found.set(key, sejour);
        console.log(`   ✅ Jour ${day} → ${sejour.debut} → ${sejour.fin} | ${sejour.nuits}n | ${sejour.revenu} | ${sejour.voyageur}`);
      }
    }
  }

  const results = Array.from(found.values());
  console.log(`  📊 ${results.length} réservation(s) pour ${monthLabel}`);
  return results;
}

// ─── NAVIGATION VERS UN MOIS VIA LE CALENDRIER ───────────────────────────────
// Retourne le mois/année actuellement affiché dans le calendrier
async function getCurrentCalendarMonth(page) {
  return await page.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll("script, style").forEach(el => el.remove());
    const text = body.innerText;
    const m = text.match(/(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+(\d{4})/i);
    return m ? m[0].toLowerCase() : null;
  });
}

async function navigateToMonth(page, year, month) {
  const monthFr = MOIS_NUM_TO_FR[month - 1];
  const targetLabel = `${monthFr} ${year}`.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  console.log(`  🗓️  Navigation vers ${monthFr} ${year}...`);

  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await getCurrentCalendarMonth(page);
    const currentNorm = (current || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    console.log(`  📅 Mois affiché: "${current}" (cible: "${targetLabel}")`);

    if (currentNorm.includes(targetLabel)) {
      console.log(`  ✅ Mois cible atteint !`);
      return;
    }

    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
        .filter(b => !b.closest("nav, header, aside"));
      for (const btn of candidates) {
        const cls = (btn.className || "").toLowerCase();
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (/next|forward|suivant/.test(cls + aria)) {
          btn.click();
          return `cls="${cls.substring(0,40)}" aria="${aria}"`;
        }
      }
      return null;
    });

    if (!clicked) { console.log(`  ⚠️  Bouton suivant non trouvé`); break; }
    console.log(`  🖱️  Clic attempt ${attempt + 1}: ${clicked}`);
    await new Promise(r => setTimeout(r, 2500));
  }
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(page) {
  await page.goto("https://client.passpass.io/login", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#email", { timeout: 10000 });
  await page.evaluate((email, password) => {
    function fill(id, value) {
      const el = document.getElementById(id);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    fill("email", email);
    fill("password", password);
  }, PASSPASS_EMAIL, PASSPASS_PASSWORD);
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') || document.querySelector("button");
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 8000));
  if (page.url().includes("login")) throw new Error("Connexion échouée");
}

// ─── NAVIGATION VERS "MES LOCATIONS" ─────────────────────────────────────────
async function navigateToProperty(page) {
  await new Promise(r => setTimeout(r, 3000));
  console.log("📂 Clic sur 'Mes locations'...");

  const clicked = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (/mes\s+locations/i.test(node.textContent.trim())) {
        let el = node.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          if (el.tagName === "A" || el.tagName === "BUTTON" || window.getComputedStyle(el).cursor === "pointer") {
            el.click();
            return el.href || el.tagName + ": " + el.innerText?.trim().substring(0, 40);
          }
          el = el.parentElement;
        }
        node.parentElement?.click();
        return "fallback: " + node.textContent.trim();
      }
    }
    return null;
  });

  console.log(clicked ? `✅ ${clicked}` : "⚠️  Non trouvé");
  await new Promise(r => setTimeout(r, 4000));
  console.log(`📍 URL: ${page.url()}`);
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
      if (frame === page.mainFrame()) console.log(`🌐 ${frame.url()}`);
    });

    await login(page);
    console.log("✅ Connecté !");
    await navigateToProperty(page);
    await screenshot(page, "base");

    const allReservations = [];
    const seen = new Set();
    const now = new Date();

    for (let i = 0; i <= 5; i++) {
      const target = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const y = target.getFullYear();
      const m = target.getMonth() + 1;
      const label = `${MOIS_NUM_TO_FR[m-1]} ${y}`;
      console.log(`\n📆 ${i === 0 ? "Mois en cours" : "Mois +" + i} (${label})`);

      if (i > 0) {
        await navigateToMonth(page, y, m);
      }

      const monthRes = await scrapeMonthByClickingDays(page, label, y, m);

      for (const r of monthRes) {
        const key = `${r.dateDebut}-${r.dateFin}`;
        if (r.dateDebut && !seen.has(key)) {
          seen.add(key);
          allReservations.push(r);
        }
      }
    }

    allReservations.sort((a, b) => (a.dateDebut || "").localeCompare(b.dateDebut || ""));
    console.log(`\n📊 Total: ${allReservations.length} réservation(s)`);
    allReservations.forEach(r =>
      console.log(`   ${r.debut} → ${r.fin} | ${r.nuits || "?"}n | ${r.revenu || "?"} | ${r.voyageur || "?"} | ${r.etat}`)
    );

    return allReservations;

  } finally {
    await browser.close();
  }
}

// ─── ENVOI EMAIL ──────────────────────────────────────────────────────────────
async function sendEmail(previousAllRes, allReservations) {
  const previousKeys = new Set(previousAllRes.map(r => `${r.dateDebut}-${r.dateFin}`));
  const newRes = allReservations.filter(r => !previousKeys.has(`${r.dateDebut}-${r.dateFin}`));
  const currentKeys = new Set(allReservations.map(r => `${r.dateDebut}-${r.dateFin}`));
  const removedRes = previousAllRes.filter(r => !currentKeys.has(`${r.dateDebut}-${r.dateFin}`));

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD } });
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  let html = `<h2>🔔 Modification détectée sur Passpass</h2><p><strong>Date :</strong> ${now}</p>`;

  if (newRes.length > 0) {
    html += `<h3>🆕 Nouvelles réservations :</h3><ul>`;
    for (const r of newRes) {
      const gcalLink = buildGCalLink(r);
      html += `<li>🏠 <b>${r.debut}</b> → <b>${r.fin}</b>`;
      if (r.nuits) html += ` (${r.nuits} nuit${r.nuits > 1 ? "s" : ""})`;
      if (r.revenu) html += ` — <b>${r.revenu}</b>`;
      if (r.voyageur) html += ` — ${r.voyageur}`;
      html += ` — ${r.etat}`;
      if (gcalLink) html += ` &nbsp;<a href="${gcalLink}" style="background:#4285F4;color:white;padding:3px 10px;border-radius:4px;text-decoration:none;font-size:12px;">📅 Agenda</a>`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  if (removedRes.length > 0) {
    html += `<h3>❌ Réservations annulées :</h3><ul>`;
    for (const r of removedRes) {
      html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b>`;
      if (r.voyageur) html += ` — ${r.voyageur}`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  const totalRevenu = allReservations
    .map(r => parseFloat((r.revenu || "").replace(/[^\d.,]/g, "").replace(",", ".")))
    .filter(n => !isNaN(n) && n > 0)
    .reduce((a, b) => a + b, 0);

  html += `<h3>📋 Toutes les réservations (${allReservations.length}) :</h3>`;
  html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">`;
  html += `<tr style="background:#f0f0f0"><th>Dates</th><th>Nuits</th><th>Revenu</th><th>Voyageur</th><th>État</th><th>Agenda</th></tr>`;
  for (const r of allReservations) {
    const gcalLink = buildGCalLink(r);
    const etatL = r.etat.toLowerCase();
    const emoji = etatL.includes("cours") ? "🟠" : etatL.includes("attente") ? "🟡" : etatL.includes("venir") ? "🔵" : etatL.includes("termin") ? "✅" : etatL.includes("annul") ? "❌" : "🔵";
    html += `<tr><td><b>${r.debut}</b> → ${r.fin}</td><td style="text-align:center">${r.nuits || "?"}</td><td>${r.revenu || "?"}</td><td>${r.voyageur || "?"}</td><td>${emoji} ${r.etat}</td>`;
    html += `<td>${gcalLink ? `<a href="${gcalLink}" style="background:#4285F4;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:11px;">📅</a>` : ""}</td></tr>`;
  }
  html += `</table>`;
  if (totalRevenu > 0) html += `<p><strong>💰 Revenu total : ${totalRevenu.toFixed(2)} €</strong></p>`;
  html += `<p><a href="https://client.passpass.io/dashboard">👉 Dashboard Passpass</a></p>`;

  const subject = newRes.length > 0
    ? `🆕 Nouvelle réservation${newRes.length > 1 ? "s" : ""} : ${newRes[0].debut} → ${newRes[0].fin}`
    : removedRes.length > 0
      ? `❌ Réservation annulée : ${removedRes[0].debut} → ${removedRes[0].fin}`
      : `🔔 Passpass - Modification détectée`;

  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html });
  console.log(`✅ Email envoyé : "${subject}"`);
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
