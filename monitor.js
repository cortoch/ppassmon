const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, collection, getDocs } = require("firebase/firestore");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const firebaseConfig = {
  apiKey: "AIzaSyCffkmTqLa241aKYMg6l_neYrU8vT3RG38",
  authDomain: "passpass-web-public.firebaseapp.com",
  projectId: "passpass-web-public",
};

const PASSPASS_EMAIL = process.env.PASSPASS_EMAIL;
const PASSPASS_PASSWORD = process.env.PASSPASS_PASSWORD;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;

const SUBCOLLECTIONS = ["clients", "bookings", "waitingBookings", "disabledBookings", "billings", "propreties"];

function hash(data) {
  return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
}

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
    html: `
      <h2>🔔 Modifications détectées sur Passpass</h2>
      <p><strong>Date :</strong> ${now}</p>
      <ul>${changes.map((c) => `<li>${c}</li>`).join("")}</ul>
      <p><a href="https://client.passpass.io/dashboard">👉 Voir le dashboard</a></p>
    `,
  });
  console.log(`✅ Email envoyé à ${EMAIL_TO}`);
}

async function main() {
  console.log(`🔍 Démarrage - ${new Date().toLocaleString("fr-FR")}`);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const userCredential = await signInWithEmailAndPassword(auth, PASSPASS_EMAIL, PASSPASS_PASSWORD);
  const uid = userCredential.user.uid;
  console.log(`✅ Connecté - UID: ${uid}`);

  // Charger l'état précédent
  const fs = require("fs");
  const CACHE_FILE = "firestore_state.json";
  const previousState = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
  const currentState = {};
  const changes = [];

  for (const sub of SUBCOLLECTIONS) {
    try {
      // Chemin correct : user/{uid}/{subcollection}
      const ref = collection(db, "user", uid, sub);
      const snapshot = await getDocs(ref);
      const docs = {};
      snapshot.forEach((doc) => { docs[doc.id] = doc.data(); });

      const docCount = Object.keys(docs).length;
      const currentHash = hash(docs);
      currentState[sub] = { hash: currentHash, count: docCount };
      console.log(`📁 ${sub}: ${docCount} documents`);

      if (sub in previousState) {
        if (previousState[sub].hash !== currentHash) {
          changes.push(`<b>${sub}</b> modifiée (${previousState[sub].count} → ${docCount} documents)`);
          console.log(`🔄 CHANGEMENT dans '${sub}'!`);
        }
      } else {
        console.log(`🆕 Première observation: ${sub}`);
      }
    } catch (e) {
      console.log(`⛔ ${sub}: ${e.message}`);
    }
  }

  if (changes.length > 0) {
    await sendEmail(changes);
  } else {
    console.log("✅ Aucun changement");
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(currentState, null, 2));
  console.log("💾 État sauvegardé");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Erreur:", e.message);
  process.exit(1);
});
