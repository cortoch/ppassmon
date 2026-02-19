#!/usr/bin/env python3
"""
Firestore Monitor - Passpass Dashboard
Surveille les modifications de la base de données et envoie un email si changement détecté.
"""

import json
import os
import hashlib
import requests
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime

# ============================================================
# CONFIGURATION - À remplir avec vos valeurs
# ============================================================
FIREBASE_API_KEY = "AIzaSyCffkmTqLa241aKYMg6l_neYrU8vT3RG38"
FIREBASE_PROJECT = "passpass-web-public"
REFRESH_TOKEN = os.environ.get("FIREBASE_REFRESH_TOKEN", "VOTRE_REFRESH_TOKEN")

# Email
EMAIL_FROM = os.environ.get("EMAIL_FROM", "votre@gmail.com")
EMAIL_TO = os.environ.get("EMAIL_TO", "henri.borreill@gmail.com")
EMAIL_PASSWORD = os.environ.get("EMAIL_PASSWORD", "")  # App password Gmail

# Collections à surveiller
COLLECTIONS = ["clients", "reservations", "menages", "menage", "reservation", "client"]

# Fichier de cache pour stocker l'état précédent
CACHE_FILE = "firestore_state.json"
# ============================================================


def get_fresh_token(refresh_token: str) -> str:
    """Renouvelle le token Firebase via le refresh token."""
    url = f"https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}"
    resp = requests.post(url, data={
        "grant_type": "refresh_token",
        "refresh_token": refresh_token
    })
    resp.raise_for_status()
    data = resp.json()
    print(f"✅ Token renouvelé, expire dans {data.get('expires_in')}s")
    return data["id_token"]


def fetch_collection(token: str, collection: str) -> dict | None:
    """Récupère tous les documents d'une collection Firestore."""
    url = (
        f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}"
        f"/databases/(default)/documents/{collection}"
    )
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(url, headers=headers)

    if resp.status_code == 200:
        return resp.json()
    elif resp.status_code == 403:
        print(f"⛔ Accès refusé à la collection '{collection}' (règles Firestore)")
        return None
    elif resp.status_code == 404:
        print(f"❓ Collection '{collection}' introuvable")
        return None
    else:
        print(f"⚠️ Erreur {resp.status_code} pour '{collection}': {resp.text[:200]}")
        return None


def compute_hash(data: dict) -> str:
    """Calcule un hash MD5 des données pour détecter les changements."""
    serialized = json.dumps(data, sort_keys=True)
    return hashlib.md5(serialized.encode()).hexdigest()


def load_previous_state() -> dict:
    """Charge l'état précédent depuis le fichier de cache."""
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    return {}


def save_state(state: dict):
    """Sauvegarde l'état actuel dans le fichier de cache."""
    with open(CACHE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def send_email(changes: list[str]):
    """Envoie un email de notification si des changements sont détectés."""
    if not EMAIL_PASSWORD:
        print("⚠️ EMAIL_PASSWORD non configuré, email non envoyé")
        print("Changements détectés:", "\n".join(changes))
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"🔔 Passpass - Modification de la base de données"
    msg["From"] = EMAIL_FROM
    msg["To"] = EMAIL_TO

    now = datetime.now().strftime("%d/%m/%Y à %H:%M")
    body = f"""
    <h2>🔔 Modifications détectées sur Passpass</h2>
    <p><strong>Date :</strong> {now}</p>
    <hr>
    <h3>Collections modifiées :</h3>
    <ul>
        {"".join(f"<li>{c}</li>" for c in changes)}
    </ul>
    <p><a href="https://client.passpass.io/dashboard">👉 Voir le dashboard</a></p>
    """

    msg.attach(MIMEText(body, "html"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(EMAIL_FROM, EMAIL_PASSWORD)
            server.sendmail(EMAIL_FROM, EMAIL_TO, msg.as_string())
        print(f"✅ Email envoyé à {EMAIL_TO}")
    except Exception as e:
        print(f"❌ Erreur envoi email: {e}")


def main():
    print(f"🔍 Démarrage du monitoring Firestore - {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")

    # 1. Renouveler le token
    try:
        token = get_fresh_token(REFRESH_TOKEN)
    except Exception as e:
        print(f"❌ Impossible de renouveler le token: {e}")
        return

    # 2. Charger l'état précédent
    previous_state = load_previous_state()
    current_state = {}
    changes = []

    # 3. Récupérer chaque collection
    for collection in COLLECTIONS:
        data = fetch_collection(token, collection)
        if data is None:
            continue

        current_hash = compute_hash(data)
        current_state[collection] = {
            "hash": current_hash,
            "last_checked": datetime.now().isoformat(),
            "doc_count": len(data.get("documents", []))
        }

        print(f"📁 Collection '{collection}': {current_state[collection]['doc_count']} documents")

        # Comparer avec l'état précédent
        if collection in previous_state:
            if previous_state[collection]["hash"] != current_hash:
                changes.append(f"<b>{collection}</b> a été modifiée")
                print(f"🔄 CHANGEMENT détecté dans '{collection}'!")
        else:
            print(f"🆕 Première observation de '{collection}'")

    # 4. Envoyer un email si des changements sont détectés
    if changes:
        send_email(changes)
    else:
        print("✅ Aucun changement détecté")

    # 5. Sauvegarder l'état actuel
    save_state(current_state)
    print("💾 État sauvegardé")


if __name__ == "__main__":
    main()
