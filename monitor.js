const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, collection, getDocs } = require("firebase/firestore");
const crypto = require("crypto");
const fs = require("fs");
const nodemailer = require("nodemailer");

const firebaseConfig = {
  apiKey: "AIzaSyCffkmTqLa241aKYMg6l_neYrU8vT3RG38",
  authDomain: "passpass-web-public.firebaseapp.com",
  projectId: "passpass-web-public",
};

const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const PASSPASS_EMAIL = process.env.PASSPASS_EMAIL;
const PASSPASS_PASSWORD = process.env.PASSPASS_PASSWORD;

const COLLECTIONS = ["clients", "bookings", "waitingBookings", "disabledBookings", "billings"];
const CACHE_FILE = "firestore_state.json";

function hash(data) {
  return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
}

function loadState() {
  if (fs.existsSync(CACHE_FILE)) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(state, null, 2));
}

async function sendEmail(changes) {
  if (!EMAIL_PASSWORD) {
    console.log("⚠️ EMAIL_PASSWORD non configuré");
    return;
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_FROM, pass: EMAIL_PASSWORD },
  });
  const now = new Date().toLocaleString("fr-FR");
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: "🔔 Passpass - Modification détectée",
    html: `<h2>Modifications détectées sur Passpass</h2>
           <p><strong>Date :</strong> ${now}</p>
           <ul>${changes.map((c) => `<li>${c}</li>`).join("")}</ul>
           <p><a href="https://client.passpass.io/dashboard">👉 Voir le dashboard</a></p>`,
  });
  console.log(`✅ Email envoyé à ${EMAIL_TO}`);
}

async function main() {
  console.log(`🔍 Démarrage - ${new Date().toLocaleString("fr-FR")}`);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  // Connexion avec email/password
  console.log(`🔐 Connexion Firebase avec ${PASSPASS_EMAIL}...`);
  await signInWithEmailAndPassword(auth, PASSPASS_EMAIL, PASSPASS_PASSWORD);
  console.log("✅ Connecté !");

  const previousState = loadState();
  const currentState = {};
  const changes = [];

  for (const col of COLLECTIONS) {
    try {
      const snapshot = await getDocs(collection(db, col));
      const docs = {};
      snapshot.forEach((doc) => {
        docs[doc.id] = doc.data();
      });

      const docCount = Object.keys(docs).length;
      const currentHash = hash(docs);
      currentState[col] = { hash: currentHash, count: docCount };

      console.log(`📁 Collection '${col}': ${docCount} documents`);

      if (col in previousState) {
        if (previousState[col].hash !== currentHash) {
          changes.push(`<b>${col}</b> modifiée (${previousState[col].count} → ${docCount} documents)`);
          console.log(`🔄 CHANGEMENT dans '${col}'!`);
        }
      } else {
        console.log(`🆕 Première observation de '${col}'`);
      }
    } catch (e) {
      console.log(`⛔ Erreur sur '${col}': ${e.message}`);
    }
  }

  if (changes.length > 0) {
    await sendEmail(changes);
  } else {
    console.log("✅ Aucun changement détecté");
  }

  saveState(currentState);
  console.log("💾 État sauvegardé");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Erreur:", e.message);
  process.exit(1);
});
