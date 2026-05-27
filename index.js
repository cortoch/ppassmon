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
  let moisNum = MOIS_FR[m[2]];
  if (moisNum === undefined) {
    const m2 = str.trim().toLowerCase().match(/(\d{1,2})\s+([a-zéûôàèùâêîïü]+)(?:\s+(\d{4}))?/);
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

// ─── PARSE DU WIDGET "SÉJOUR SÉLECTIONNÉ" ────────────────────────────────────
// Format : "Dates 28 Mars - 31 Mars Nuitées 3 Revenu 216.32 € Voyageur Francisco M..."
function parseSejour(rawText, currentYear) {
  const m = rawText.match(
    /Dates\s*(\d{1,2}\s+[A-Za-z\u00C0-\u00FF]+\s*[-\u2013]\s*\d{1,2}\s+[A-Za-z\u00C0-\u00FF]+)\s*Nuit[e\u00e9]es?\s*(\d+)\s*Revenu\s*([\d\s.,]+\s*\u20ac)\s*Voyageur\s*([^\n\r]+)/
  );
  if (!m) return null;

  const rangeParts = m[1].match(/(\d{1,2}\s+[A-Za-zÀ-ÿ]+)\s*[-–]\s*(\d{1,2}\s+[A-Za-zÀ-ÿ]+)/);
  if (!rangeParts) return null;

  const debutStr = rangeParts[1].trim();
  const finStr   = rangeParts[2].trim();
  const dateDebut = parseFrDate(debutStr, currentYear);
  let dateFin = parseFrDate(finStr, currentYear);
  if (dateDebut && dateFin && dateFin < dateDebut) dateFin = parseFrDate(finStr, currentYear + 1);

  return {
    debut: debutStr,
    fin: finStr,
    dateDebut: toISO(dateDebut),
    dateFin: toISO(dateFin),
    nuits: m[2].trim(),
    revenu: m[3].replace(/\s/g, "").trim(),
    voyageur: m[4].trim().split(/R[eé]servations\s+du\s+mois/i)[0].split(/[\n\r]/)[0].trim(),
    plateforme: null,
    etat: "À venir",
  };
}

// ─── SCRAPING D'UN MOIS : clic sur chaque jour via page.mouse.click() ─────────
// Le widget "Séjour sélectionné" se met à jour uniquement avec de vrais clics souris.
// On clique chaque jour du mois et on détecte les changements du widget.
// On filtre les séjours qui ne chevauchent pas le mois cible (résidu du mois précédent).
async function scrapeMonth(page, calendarYear, calendarMonth) {
  const currentYear = new Date().getFullYear();
  const found = new Map();
  const moisDebut = new Date(calendarYear, calendarMonth - 1, 1);
  const moisFin   = new Date(calendarYear, calendarMonth, 0);

  const days = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".fc-daygrid-day[data-date]"))
      .map(c => c.getAttribute("data-date")).filter(Boolean)
  );

  if (days.length === 0) { console.log(`  ⚠️  Aucune cellule FullCalendar trouvée`); return []; }
  console.log(`  📅 ${days.length} jours`);

  async function readSejour() {
    const raw = await page.evaluate(() => {
      const b = document.body.cloneNode(true);
      b.querySelectorAll("script,style").forEach(e => e.remove());
      return b.innerText;
    });
    return parseSejour(raw, currentYear);
  }

  let lastKey = "";

  for (const dayDate of days) {
    const [dy, dm] = dayDate.split("-").map(Number);
    if (dm !== calendarMonth || dy !== calendarYear) continue;

    const rect = await page.evaluate((date) => {
      const cell = document.querySelector(`.fc-daygrid-day[data-date="${date}"]`);
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, dayDate);
    if (!rect) continue;

    await page.mouse.click(rect.x, rect.y);
    await new Promise(r => setTimeout(r, 600));

    const sejour = await readSejour();
    if (!sejour?.dateDebut) continue;

    const key = `${sejour.dateDebut}-${sejour.dateFin}`;
    if (key === lastKey) continue;
    lastKey = key;

    // Filtre : ignorer les séjours hors du mois cible (widget résidu du mois précédent)
    if (new Date(sejour.dateDebut) > moisFin || new Date(sejour.dateFin) < moisDebut) continue;

    if (!found.has(key)) {
      found.set(key, sejour);
      console.log(`  🆕 ${sejour.debut} → ${sejour.fin} | ${sejour.nuits}n | ${sejour.revenu} | ${sejour.voyageur || "?"}`);
    }
  }

  return Array.from(found.values());
}

// ─── NAVIGATION VERS UN MOIS ─────────────────────────────────────────────────
// Utilise le bouton fc-next-button de FullCalendar (aria="next")
async function navigateToMonth(page, year, month) {
  const monthFr = MOIS_NUM_TO_FR[month - 1];
  const target = `${monthFr} ${year}`.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  for (let i = 0; i < 8; i++) {
    const current = await page.evaluate(() => {
      const b = document.body.cloneNode(true);
      b.querySelectorAll("script,style").forEach(e => e.remove());
      const m = b.innerText.match(/(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+(\d{4})/i);
      return m ? m[0].toLowerCase() : null;
    });

    const norm = (current || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (norm.includes(target)) { console.log(`  ✅ ${current}`); return; }

    await page.evaluate(() => {
      const btn = document.querySelector(".fc-next-button");
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`  ⚠️  Mois cible non atteint`);
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(page) {
  await page.goto("https://client.passpass.io/login", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#email", { timeout: 10000 });
  await page.evaluate((email, password) => {
    function fill(id, val) {
      const el = document.getElementById(id);
      if (!el) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    fill("email", email);
    fill("password", password);
  }, PASSPASS_EMAIL, PASSPASS_PASSWORD);
  await new Promise(r => setTimeout(r, 500));
  await page.evaluate(() => (document.querySelector('button[type="submit"]') || document.querySelector("button"))?.click());
  await new Promise(r => setTimeout(r, 8000));
  if (page.url().includes("login")) throw new Error("Connexion échouée");
}

// ─── NAVIGATION VERS "MES LOCATIONS" ─────────────────────────────────────────
// Clic sur "Mes locations" dans le menu → atterrit sur /dashboard avec le calendrier
async function navigateToProperty(page) {
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (/mes\s+locations/i.test(node.textContent.trim())) {
        let el = node.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          if (el.tagName === "A" || el.tagName === "BUTTON" || window.getComputedStyle(el).cursor === "pointer") {
            el.click(); return;
          }
          el = el.parentElement;
        }
        node.parentElement?.click(); return;
      }
    }
  });
  await new Promise(r => setTimeout(r, 4000));
  console.log(`📍 ${page.url()}`);
}

// ─── SCRAPING PRINCIPAL ───────────────────────────────────────────────────────
async function scrapePasspass() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome-stable",
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,800"],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) console.log(`🌐 ${frame.url()}`); });

    await login(page);
    console.log("✅ Connecté");
    await navigateToProperty(page);

    const allReservations = [];
    const seen = new Set();
    const now = new Date();

    for (let i = 0; i <= 5; i++) {
      const target = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const y = target.getFullYear();
      const m = target.getMonth() + 1;
      console.log(`\n📆 ${MOIS_NUM_TO_FR[m-1]} ${y}`);

      if (i > 0) await navigateToMonth(page, y, m);

      const monthRes = await scrapeMonth(page, y, m);
      console.log(`  📊 ${monthRes.length} réservation(s)`);

      for (const r of monthRes) {
        const key = `${r.dateDebut}-${r.dateFin}`;
        if (r.dateDebut && !seen.has(key)) { seen.add(key); allReservations.push(r); }
      }
    }

    allReservations.sort((a, b) => (a.dateDebut || "").localeCompare(b.dateDebut || ""));
    console.log(`\n📊 Total: ${allReservations.length} réservation(s)`);
    allReservations.forEach(r => console.log(`   ${r.debut} → ${r.fin} | ${r.nuits}n | ${r.revenu} | ${r.voyageur || "?"}`));
    return allReservations;

  } finally {
    await browser.close();
  }
}

// ─── ENVOI EMAIL ──────────────────────────────────────────────────────────────
async function sendEmail(previousAllRes, allReservations) {
  const previousKeys = new Set(previousAllRes.map(r => `${r.dateDebut}-${r.dateFin}`));
  const newRes     = allReservations.filter(r => !previousKeys.has(`${r.dateDebut}-${r.dateFin}`));
  const currentKeys = new Set(allReservations.map(r => `${r.dateDebut}-${r.dateFin}`));
  const removedRes = previousAllRes.filter(r => !currentKeys.has(`${r.dateDebut}-${r.dateFin}`));

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD } });
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  let html = `<h2>🔔 Modification détectée sur Passpass</h2><p><strong>Date :</strong> ${now}</p>`;

  if (newRes.length > 0) {
    html += `<h3>🆕 Nouvelles réservations :</h3><ul>`;
    for (const r of newRes) {
      const g = buildGCalLink(r);
      html += `<li>🏠 <b>${r.debut}</b> → <b>${r.fin}</b> (${r.nuits || "?"}n) — <b>${r.revenu || "?"}</b> — ${r.voyageur || "?"} — ${r.etat}`;
      if (g) html += ` &nbsp;<a href="${g}" style="background:#4285F4;color:white;padding:3px 10px;border-radius:4px;text-decoration:none;font-size:12px;">📅 Agenda</a>`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  if (removedRes.length > 0) {
    html += `<h3>❌ Réservations annulées :</h3><ul>`;
    for (const r of removedRes) html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b>${r.voyageur ? ` — ${r.voyageur}` : ""}</li>`;
    html += `</ul>`;
  }

  // Réservations modifiées (même clé date, mais un champ a changé)
  const modifiedRes = [];
  for (const r of allReservations) {
    const key = `${r.dateDebut}-${r.dateFin}`;
    if (!previousKeys.has(key)) continue;
    const prev = previousAllRes.find(p => `${p.dateDebut}-${p.dateFin}` === key);
    if (!prev) continue;
    const diffs = [];
    if (prev.voyageur !== r.voyageur) diffs.push(`Voyageur : <s>${prev.voyageur||"?"}</s> → <b>${r.voyageur||"?"}</b>`);
    if (prev.revenu   !== r.revenu)   diffs.push(`Revenu : <s>${prev.revenu||"?"}</s> → <b>${r.revenu||"?"}</b>`);
    if (prev.nuits    !== r.nuits)    diffs.push(`Nuits : <s>${prev.nuits||"?"}</s> → <b>${r.nuits||"?"}</b>`);
    if (prev.etat     !== r.etat)     diffs.push(`État : <s>${prev.etat||"?"}</s> → <b>${r.etat||"?"}</b>`);
    if (diffs.length > 0) modifiedRes.push({ r, diffs });
  }
  if (modifiedRes.length > 0) {
    html += `<h3>🔄 Réservations modifiées :</h3><ul>`;
    for (const { r, diffs } of modifiedRes) {
      html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b> — ${diffs.join(" / ")}</li>`;
    }
    html += `</ul>`;
  }

  const totalRevenu = allReservations
    .map(r => parseFloat((r.revenu || "").replace(/[^\d.,]/g, "").replace(",", ".")))
    .filter(n => !isNaN(n) && n > 0).reduce((a, b) => a + b, 0);

  html += `<h3>📋 Toutes les réservations (${allReservations.length}) :</h3>`;
  html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">`;
  html += `<tr style="background:#f0f0f0"><th>Dates</th><th>Nuits</th><th>Revenu</th><th>Voyageur</th><th>État</th><th>Agenda</th></tr>`;
  for (const r of allReservations) {
    const key = `${r.dateDebut}-${r.dateFin}`;
    const isNew = newRes.some(n => `${n.dateDebut}-${n.dateFin}` === key);
    const isMod = modifiedRes.some(m => `${m.r.dateDebut}-${m.r.dateFin}` === key);
    const rowStyle = isNew ? ' style="background:#e8f5e9"' : isMod ? ' style="background:#fff3e0"' : '';
    const g = buildGCalLink(r);
    const eL = r.etat.toLowerCase();
    const em = eL.includes("cours") ? "🟠" : eL.includes("attente") ? "🟡" : eL.includes("venir") ? "🔵" : eL.includes("termin") ? "✅" : eL.includes("annul") ? "❌" : "🔵";
    html += `<tr${rowStyle}><td><b>${r.debut}</b> → ${r.fin}</td><td>${r.nuits||"?"}</td><td>${r.revenu||"?"}</td><td>${r.voyageur||"?"}</td><td>${em} ${r.etat}</td>`;
    html += `<td>${g ? `<a href="${g}" style="background:#4285F4;color:white;padding:2px 8px;border-radius:4px;text-decoration:none;font-size:11px;">📅</a>` : ""}</td></tr>`;
  }
  html += `</table>`;
  if (totalRevenu > 0) html += `<p><strong>💰 Revenu total : ${totalRevenu.toFixed(2)} €</strong></p>`;
  html += `<p><a href="https://client.passpass.io/dashboard">👉 Dashboard Passpass</a></p>`;

  const subject = newRes.length > 0
    ? `🆕 Nouvelle réservation${newRes.length > 1 ? "s" : ""} : ${newRes[0].debut} → ${newRes[0].fin}`
    : removedRes.length > 0 ? `❌ Réservation annulée : ${removedRes[0].debut} → ${removedRes[0].fin}`
    : `🔔 Passpass - Modification détectée`;

  await transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html });
  console.log(`✅ Email : "${subject}"`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Passpass Monitor — ${new Date().toLocaleString("fr-FR")}`);
  try {
    const allReservations = await scrapePasspass();
    const state = loadState();
    const currentHash = hash(JSON.stringify(allReservations));

    if ("dashboard" in state) {
      if (state.dashboard.hash !== currentHash) {
        console.log("🔄 Changement détecté");
        await sendEmail(state.dashboard.reservations || [], allReservations);
      } else {
        console.log("✅ Aucun changement");
      }
    } else {
      console.log("🆕 Première observation");
      await sendEmail([], allReservations);
    }

    saveState({ dashboard: { hash: currentHash, reservations: allReservations } });
    console.log("💾 État sauvegardé");
    process.exit(0);
  } catch (e) {
    console.error("❌", e.message, e.stack);
    process.exit(1);
  }
}

main();
