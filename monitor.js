const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, collection, getDocs, query, where } = require("firebase/firestore");
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

const COLLECTIONS = [
  { name: "clients",          filter: null },
  { name: "bookings",         filter: "client" },
  { name: "waitingBookings",  filter: "client" },
  { name: "disabledBookings", filter: "client" },
  { name: "billings",         filter: "client" },
  { name: "propreties",       filter: "user" },
];

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

  console.log(`🔐 Connexion Firebase avec ${PASSPASS_EMAIL}...`);
  const userCredential = await signInWithEmailAndPassword(auth, PASSPASS_EMAIL, PASSPASS_PASSWORD);
  const uid = userCredential.user.uid;
  console.log(`✅ Connecté ! UID: ${uid}`);

  const previousState = loadState();
  const currentState = {};
  const changes = [];

  for (const col of COLLECTIONS) {
    try {
      let q;
      if (col.filter) {
        q = query(collection(db, col.name), where(col.filter, "==", uid));
      } else {
        q = query(collection(db, col.name));
      }

      const snapshot = await getDocs(q);
      const docs = {};
      snapshot.forEach((doc) => {
        docs[doc.id] = doc.data();
      });

      const docCount = Object.keys(docs).length;
      const currentHash = hash(docs);
      currentState[col.name] = { hash: currentHash, count: docCount };

      console.log(`📁 Collection '${col.name}': ${docCount} documents`);

      if (col.name in previousState) {
        if (previousState[col.name].hash !== currentHash) {
          changes.push(`<b>${col.name}</b> modifiée (${previousState[col.name].count} → ${docCount} documents)`);
          console.log(`🔄 CHANGEMENT dans '${col.name}'!`);
        }
      } else {
        console.log(`🆕 Première observation de '${col.name}'`);
      }
    } catch (e) {
      console.log(`⛔ Erreur sur '${col.name}': ${e.message}`);
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
