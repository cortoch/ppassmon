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

function parseReservations(text) {
  const reservations = [];
  const lines = text.split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l.length > 0);

  for (let i = 0; i < lines.length - 1; i++) {
    const dateMatch = lines[i].match(/^(\d{1,2}\s+[^\d\s\-–]+(?:\s+\d{4})?)\s*[-–]\s*(\d{1,2}\s+[^\d\s\-–]+(?:\s+\d{4})?)$/);
    if (dateMatch) {
      const nuits = lines[i + 1]?.match(/^\d+$/) ? lines[i + 1].trim() : "?";
      const etat = lines[i + 2]?.match(/^\d+$/) ? lines[i + 3] || "" : lines[i + 2] || "";
      reservations.push({ debut: dateMatch[1].trim(), fin: dateMatch[2].trim(), nuits, etat: etat.trim() });
    }
  }
  return reservations;
}

function parseDate(str) {
  const mois = {
    "janvier": 0, "février": 1, "fevrier": 1, "mars": 2, "avril": 3,
    "mai": 4, "juin": 5, "juillet": 6, "août": 7, "aout": 7,
    "septembre": 8, "octobre": 9, "novembre": 10, "décembre": 11, "decembre": 11
  };
  const parts = str.trim().toLowerCase().split(/\s+/);
  const jour = parseInt(parts[0]);
  const moisNum = mois[parts[1]];
  const annee = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
  if (!isNaN(jour) && moisNum !== undefined) return new Date(annee, moisNum, jour);
  return null;
}

function toICalDate(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function createICS(reservation) {
  const debut = parseDate(reservation.debut);
  const fin = parseDate(reservation.fin);
  if (!debut || !fin) return null;
  const finExclusive = new Date(fin);
  finExclusive.setDate(finExclusive.getDate() + 1);
  const uid = `passpass-${toICalDate(debut)}-${toICalDate(fin)}@passpass-monitor`;
  const now = new Date().toISOString().replace(/[-:.]/g, "").substring(0, 15) + "Z";
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Passpass Monitor//FR\nCALSCALE:GREGORIAN\nMETHOD:PUBLISH\nBEGIN:VEVENT\nUID:${uid}\nDTSTAMP:${now}\nDTSTART;VALUE=DATE:${toICalDate(debut)}\nDTEND;VALUE=DATE:${toICalDate(finExclusive)}\nSUMMARY:🏠 Réservation Le jardin d'Henri (${reservation.nuits} nuit${reservation.nuits > 1 ? 's' : ''})\nDESCRIPTION:Réservation du ${reservation.debut} au ${reservation.fin}\\n${reservation.nuits} nuit${reservation.nuits > 1 ? 's' : ''}\\nÉtat: ${reservation.etat}\nLOCATION:Le jardin d'Henri\nBEGIN:VALARM\nTRIGGER:-PT24H\nACTION:DISPLAY\nDESCRIPTION:Rappel : arrivée demain - Le jardin d'Henri\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR`;
}

// Clique sur la flèche › du calendrier ET sur celle du dropdown "Réservations du mois"
async function goToNextMonth(page) {
  const result = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
    const results = [];

    // Trouve TOUS les boutons "suivant" (flèches ›) sur la page
    const nextBtns = buttons.filter(b => {
      const html = b.innerHTML;
      const text = b.innerText?.trim();
      return text === ">" || text === "›" || text === "→" ||
             html.includes("chevron-right") || html.includes("angle-right") ||
             html.includes("fa-chevron-right") || html.includes("fa-angle-right") ||
             (html.includes("svg") && b.querySelector("path, polyline, polygon"));
    });

    // Clique sur tous les boutons "suivant" trouvés (calendrier + dropdown)
    for (const btn of nextBtns) {
      btn.click();
      results.push(btn.closest("[class]")?.className?.substring(0, 60) || btn.tagName);
    }
    return results;
  });

  console.log(`  ➡️  Boutons cliqués (${result.length}): ${result.join(" | ")}`);
  await new Promise(r => setTimeout(r, 2000));
}

async function getMonthReservations(page, label, screenshotIndex) {
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: `screenshot_${screenshotIndex}.png`, fullPage: true });

  const content = await page.evaluate(() => {
    const body = document.body.cloneNode(true);
    body.querySelectorAll("script, style").forEach(el => el.remove());
    return body.innerText;
  });

  const sectionMatch = content.match(/Réservation[\s\S]*?(?=Bilan du mois|$)/);
  const section = sectionMatch ? sectionMatch[0] : content;

  const res = parseReservations(section);
  console.log(`📅 ${label}: ${res.length} réservation(s)`);
  res.forEach(r => console.log(`   ${r.debut} → ${r.fin} (${r.nuits} nuits) — ${r.etat}`));
  return res;
}

async function sendEmail(previousAllRes, allReservations) {
  const previousKeys = new Set(previousAllRes.map(r => `${r.debut}-${r.fin}`));
  const newRes = allReservations.filter(r => !previousKeys.has(`${r.debut}-${r.fin}`));
  const currentKeys = new Set(allReservations.map(r => `${r.debut}-${r.fin}`));
  const removedRes = previousAllRes.filter(r => !currentKeys.has(`${r.debut}-${r.fin}`));

  const attachments = [];
  for (const r of newRes) {
    const ics = createICS(r);
    if (ics) attachments.push({
      filename: `reservation-${r.debut.replace(/\s+/g, "-")}.ics`,
      content: ics,
      contentType: "text/calendar",
    });
  }

  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD } });
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  let html = `<h2>🔔 Modification détectée sur Passpass</h2><p><strong>Date :</strong> ${now}</p>`;
  if (newRes.length > 0) {
    html += `<h3>🆕 Nouvelles réservations :</h3><ul>`;
    for (const r of newRes) html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b> (${r.nuits} nuit${r.nuits > 1 ? 's' : ''}) — ${r.etat}</li>`;
    html += `</ul>`;
    if (attachments.length > 0) html += `<p>📎 <i>Fichier(s) .ics joint(s) — cliquez pour ajouter à Google Calendar</i></p>`;
  }
  if (removedRes.length > 0) {
    html += `<h3>❌ Réservations annulées :</h3><ul>`;
    for (const r of removedRes) html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b></li>`;
    html += `</ul>`;
  }
  html += `<h3>📋 Toutes les réservations (4 mois) :</h3><ul>`;
  for (const r of allReservations) {
    const emoji = r.etat.includes("cours") ? "🟠" : r.etat.includes("attente") ? "🟡" : "✅";
    html += `<li>${emoji} ${r.debut} → ${r.fin} (${r.nuits} nuit${r.nuits > 1 ? 's' : ''}) — ${r.etat}</li>`;
  }
  html += `</ul><p><a href="https://client.passpass.io/dashboard">👉 Voir le dashboard</a></p>`;

  await transporter.sendMail({
    from: EMAIL_FROM, to: EMAIL_TO,
    subject: newRes.length > 0 ? `🆕 Nouvelle réservation : ${newRes[0].debut} → ${newRes[0].fin}` : `🔔 Passpass - Modification détectée`,
    html, attachments,
  });
  console.log(`✅ Email envoyé avec ${attachments.length} fichier(s) .ics`);
}

async function login(page) {
  await page.goto("https://client.passpass.io/login", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#email", { timeout: 10000 });
  await page.evaluate((email, password) => {
    function fill(id, value) {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = "";
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

async function navigateToProperty(page) {
  await page.waitForFunction(() => {
    return document.body.innerText.includes("Le jardin d'Henri");
  }, { timeout: 10000 });

  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes("Le jardin d'Henri")) {
        let el = node.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!el) break;
          const style = window.getComputedStyle(el);
          if (style.cursor === "pointer" || el.tagName === "A" || el.tagName === "BUTTON") {
            el.click(); return;
          }
          el = el.parentElement;
        }
        node.parentElement?.click();
        return;
      }
    }
  });

  await new Promise(r => setTimeout(r, 5000));
  console.log(`📍 URL dashboard: ${page.url()}`);
}

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

    // Mois en cours
    const currentRes = await getMonthReservations(page, "Mois en cours", 0);
    let allReservations = [...currentRes];

    // 3 mois suivants : avance les DEUX contrôles en même temps
    for (let i = 1; i <= 3; i++) {
      console.log(`\n📆 Passage au mois +${i}...`);
      await goToNextMonth(page);
      const monthRes = await getMonthReservations(page, `Mois +${i}`, i);
      allReservations = [...allReservations, ...monthRes];
    }

    // Déduplique
    const seen = new Set();
    allReservations = allReservations.filter(r => {
      const key = `${r.debut}-${r.fin}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`\n📊 Total: ${allReservations.length} réservation(s) sur 4 mois`);
    return allReservations;

  } finally {
    await browser.close();
  }
}

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
    process.exit(1);
  }
}

main();
