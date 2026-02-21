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

// Extrait les réservations du texte du dashboard
function parseReservations(text) {
  const reservations = [];
  // Pattern : "30 Janvier - 1 Février" ou "3 Février - 15 Février"
  const pattern = /(\d{1,2}\s+\w+(?:\s+\d{4})?)\s*[-–]\s*(\d{1,2}\s+\w+(?:\s+\d{4})?)\s*\n?\s*(\d+)\s*nuit/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    reservations.push({
      debut: match[1].trim(),
      fin: match[2].trim(),
      nuits: match[3].trim(),
    });
  }
  return reservations;
}

async function sendEmail(previousText, currentText) {
  const previousRes = parseReservations(previousText || "");
  const currentRes = parseReservations(currentText);

  // Trouve les nouvelles réservations
  const previousKeys = new Set(previousRes.map(r => `${r.debut}-${r.fin}`));
  const newRes = currentRes.filter(r => !previousKeys.has(`${r.debut}-${r.fin}`));

  // Trouve les réservations supprimées
  const currentKeys = new Set(currentRes.map(r => `${r.debut}-${r.fin}`));
  const removedRes = previousRes.filter(r => !currentKeys.has(`${r.debut}-${r.fin}`));

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD },
  });

  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  let html = `<h2>🔔 Modification détectée sur Passpass</h2>
              <p><strong>Date :</strong> ${now}</p>`;

  if (newRes.length > 0) {
    html += `<h3>🆕 Nouvelles réservations :</h3><ul>`;
    for (const r of newRes) {
      html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b> &nbsp;(${r.nuits} nuit${r.nuits > 1 ? 's' : ''})</li>`;
    }
    html += `</ul>`;
  }

  if (removedRes.length > 0) {
    html += `<h3>❌ Réservations annulées :</h3><ul>`;
    for (const r of removedRes) {
      html += `<li>📅 <b>${r.debut}</b> → <b>${r.fin}</b> &nbsp;(${r.nuits} nuit${r.nuits > 1 ? 's' : ''})</li>`;
    }
    html += `</ul>`;
  }

  html += `<h3>📋 Toutes les réservations actuelles :</h3><ul>`;
  for (const r of currentRes) {
    html += `<li>📅 ${r.debut} → ${r.fin} &nbsp;(${r.nuits} nuit${r.nuits > 1 ? 's' : ''})</li>`;
  }
  html += `</ul>`;
  html += `<p><a href="https://client.passpass.io/dashboard">👉 Voir le dashboard</a></p>`;

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: newRes.length > 0
      ? `🆕 Nouvelle réservation Passpass : ${newRes[0].debut} → ${newRes[0].fin}`
      : `🔔 Passpass - Modification détectée`,
    html,
  });
  console.log(`✅ Email envoyé à ${EMAIL_TO}`);
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
    await login(page);
    console.log("✅ Connecté !");

    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("*"));
      const el = els.find(e => e.innerText?.trim().includes("Le jardin d'Henri") && e.children.length === 0);
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 4000));

    const content = await page.evaluate(() => {
      const body = document.body.cloneNode(true);
      body.querySelectorAll("script, style").forEach(el => el.remove());
      return body.innerText;
    });

    console.log(`📁 dashboard: ${content.length} caractères`);

    // Affiche les réservations trouvées
    const reservations = parseReservations(content);
    console.log(`📅 Réservations trouvées: ${reservations.length}`);
    reservations.forEach(r => console.log(`   ${r.debut} → ${r.fin} (${r.nuits} nuits)`));

    return content;

  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("🚀 Passpass Monitor - GitHub Actions");
  try {
    const currentContent = await scrapePasspass();
    const previousState = loadState();
    const currentHash = hash(currentContent);

    if ("dashboard" in previousState) {
      if (previousState.dashboard.hash !== currentHash) {
        console.log("🔄 CHANGEMENT détecté !");
        await sendEmail(previousState.dashboard.content || "", currentContent);
      } else {
        console.log("✅ Aucun changement détecté");
      }
    } else {
      console.log("🆕 Première observation");
      // Envoie un email récapitulatif au démarrage
      await sendEmail("", currentContent);
    }

    saveState({ dashboard: { hash: currentHash, content: currentContent } });
    console.log("💾 État sauvegardé");
    process.exit(0);
  } catch (e) {
    console.error("❌ Erreur:", e.message);
    process.exit(1);
  }
}

main();
