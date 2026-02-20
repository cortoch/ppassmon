const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, collection, getDocs, query, where } = require("firebase/firestore");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const fs = require("fs");

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
const CACHE_FILE = "firestore_state.json";

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

async function fetchAndTrack(db, path, label, previousState, currentState, changes) {
  try {
    const ref = collection(db, ...path);
    const snapshot = await getDocs(ref);
    const docs = {};
    snapshot.forEach((doc) => { docs[doc.id] = doc.data(); });

    const docCount = Object.keys(docs).length;
    const currentHash = hash(docs);
    currentState[label] = { hash: currentHash, count: docCount };
    console.log(`📁 ${label}: ${docCount} documents`);

    if (label in previousState) {
      if (previousState[label].hash !== currentHash) {
        changes.push(`<b>${label}</b> modifiée (${previousState[label].count} → ${docCount} documents)`);
        console.log(`🔄 CHANGEMENT dans '${label}'!`);
      }
    } else {
      console.log(`🆕 Première observation: ${label}`);
    }
    return docs;
  } catch (e) {
    console.log(`⛔ ${label}: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log(`🔍 Démarrage - ${new Date().toLocaleString("fr-FR")}`);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  const userCredential = await signInWithEmailAndPassword(auth, PASSPASS_EMAIL, PASSPASS_PASSWORD);
  const uid = userCredential.user.uid;
  console.log(`✅ Connecté - UID: ${uid}`);

  const previousState = fs.existsSync(CACHE_FILE)
    ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
    : {};
  const currentState = {};
  const changes = [];

  // 1. Propriétés dont tu es propriétaire : user/{uid}/propreties
  console.log("\n👤 Propriétés (propriétaire) :");
  const ownedProps = await fetchAndTrack(db, ["user", uid, "propreties"], "owned/propreties", previousState, currentState, changes);

  // 2. Propriétés dont tu es client : clients/{uid}/propreties
  console.log("\n🏠 Propriétés (client) :");
  const clientProps = await fetchAndTrack(db, ["clients", uid, "propreties"], "client/propreties", previousState, currentState, changes);

  // 3. Sous-collections des propriétés dont tu es propriétaire
  if (ownedProps && Object.keys(ownedProps).length > 0) {
    console.log("\n📋 Sous-collections propriétaire :");
    for (const propId of Object.keys(ownedProps)) {
      for (const sub of ["bookings", "disabledBookings", "waitingBookings", "billings"]) {
        await fetchAndTrack(db, ["user", uid, "propreties", propId, sub], `owned/${propId}/${sub}`, previousState, currentState, changes);
      }
    }
  }

  // 4. Sous-collections des propriétés dont tu es client
  if (clientProps && Object.keys(clientProps).length > 0) {
    console.log("\n📋 Sous-collections client :");
    for (const propId of Object.keys(clientProps)) {
      for (const sub of ["bookings", "disabledBookings", "waitingBookings", "billings"]) {
        await fetchAndTrack(db, ["clients", uid, "propreties", propId, sub], `client/${propId}/${sub}`, previousState, currentState, changes);
      }
    }
  }

  if (changes.length > 0) {
    await sendEmail(changes);
  } else {
    console.log("\n✅ Aucun changement");
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(currentState, null, 2));
  console.log("💾 État sauvegardé");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Erreur:", e.message);
  process.exit(1);
});
