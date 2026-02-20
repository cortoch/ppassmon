const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");

// ⚙️ CONFIGURATION — sur GitHub Actions ces valeurs viennent des Secrets
const PASSPASS_EMAIL = "henri.borreill@gmail.com";
const PASSPASS_PASSWORD = "Charles66!!!";
const EMAIL_FROM = "henri.borreill@gmail.com";
const EMAIL_TO = "henri.borreill@gmail.com";
const EMAIL_PASSWORD = "nhgd sqan wkhh xhcr";
const CACHE_FILE = "state.json";

function hash(str) { return crypto.createHash("md5").update(str).digest("hex"); }
function loadState() {
  if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  return {};
}
function saveState(state) { fs.writeFileSync(CACHE_FILE, JSON.stringify(state, null, 2)); }

async function sendEmail(changes) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD },
  });
  const now = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: "🔔 Passpass - Modification détectée",
    html: `<h2>🔔 Modifications détectées sur Passpass</h2>
           <p><strong>Date :</strong> ${now}</p>
           <ul>${changes.map((c) => `<li>${c}</li>`).join("")}</ul>
           <p><a href="https://client.passpass.io/dashboard">👉 Voir le dashboard</a></p>`,
  });
  console.log(`✅ Email envoyé à ${EMAIL_TO}`);
}

async function typeInField(page, selector, text) {
  await page.click(selector, { clickCount: 3 });
  await page.evaluate((sel) => { document.querySelector(sel).value = ""; }, selector);
  for (let i = 0; i < text.length; i++) {
    await page.evaluate((sel, char) => {
      const el = document.querySelector(sel);
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(el, el.value + char);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, selector, text[i]);
  }
  await page.evaluate((sel) => {
    document.querySelector(sel).dispatchEvent(new Event('change', { bubbles: true }));
  }, selector);
}

async function login(page) {
  await page.goto("https://client.passpass.io/login", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#email", { timeout: 10000 });
  await typeInField(page, "#email", PASSPASS_EMAIL);
  await new Promise(r => setTimeout(r, 300));
  await typeInField(page, "#password", PASSPASS_PASSWORD);
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"]') || document.querySelector('button');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 6000));
  if (page.url().includes("login")) throw new Error("Connexion échouée");
}

async function scrapePasspass() {
  console.log(`🔍 Vérification - ${new Date().toLocaleString("fr-FR")}`);

  const browser = await puppeteer.launch({
    headless: false,  // Nécessite Xvfb sur Linux
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--window-size=1280,800",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();

    console.log("🔐 Connexion...");
    await login(page);
    console.log("✅ Connecté !");

    // Clique sur la propriété depuis global-view
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
    return { dashboard: content };

  } finally {
    await browser.close();
  }
}

async function main() {
  console.log("🚀 Passpass Monitor - GitHub Actions");
  try {
    const scraped = await scrapePasspass();
    const previousState = loadState();
    const currentState = {};
    const changes = [];

    for (const [key, content] of Object.entries(scraped)) {
      const currentHash = hash(content);
      currentState[key] = { hash: currentHash, length: content.length };
      if (key in previousState) {
        if (previousState[key].hash !== currentHash) {
          changes.push(`<b>${key}</b> a été modifié`);
          console.log(`🔄 CHANGEMENT dans '${key}'!`);
        }
      } else {
        console.log(`🆕 Première observation: ${key} (${content.length} caractères)`);
      }
    }

    if (changes.length > 0) await sendEmail(changes);
    else console.log("✅ Aucun changement détecté");

    saveState(currentState);
    console.log("💾 État sauvegardé");
    process.exit(0);
  } catch (e) {
    console.error("❌ Erreur:", e.message);
    process.exit(1);
  }
}

main();
