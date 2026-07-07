# TNS-Panel

Panel de monitoring VPN tout-en-un. Installation 100% automatique sur Ubuntu 24.04.

## Branches

- **`main`** → serveurs x86_64 / amd64
- **`arm`** → serveurs ARM64 / ARM (Raspberry Pi, AWS Graviton, Oracle ARM)

```bash
# x86_64
git clone -b main https://github.com/TheShellMaster/panel-server-web.git

# ARM
git clone -b arm https://github.com/TheShellMaster/panel-server-web.git
```

## Installation

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/TheShellMaster/panel-server-web.git /opt/tns-panel
cd /opt/tns-panel
sudo bash install.sh
```

L'installateur vous pose des questions. Répondre `Y` (oui) à chaque service désiré.

> **ATTENTION** : si vous installez sur ARM, utilisez la branche `arm`. Les binaires ZiVPN et cloudflared sont disponibles pour ARM, mais UDP-Custom est x86_64 uniquement.

---

## GUIDE POST-INSTALL — Tout ce que vous devez remplir

Après installation, 8 éléments sont à configurer manuellement. Suivez dans l'ordre.

---

### 1. Mot de passe admin du panel

L'installateur a généré un mot de passe aléatoire. Il est affiché en fin d'installation.

Si vous voulez le changer :

**Fichier :** `/home/ubuntu/server_dashboard/.env`

```bash
sudo nano /home/ubuntu/server_dashboard/.env
```

**Ligne à modifier :**
```
ADMIN_PASSWORD=aB3xK9mP2vR7wQ1n   ← remplacez par votre mot de passe
```

**Redémarrage du backend :**
```bash
pm2 restart server-dashboard
```

---

### 2. Clé API Google Gemini (obligatoire pour le WhatsApp Bot)

**Où créer la clé :** https://aistudio.google.com/app/apikey

1. Connectez-vous avec un compte Google
2. Cliquez sur **"Create API Key"**
3. Copiez la clé (ex: `AIzaSyB...`)

**Fichier :** `/home/ubuntu/bot_whatsapp/.env`

```bash
sudo nano /home/ubuntu/bot_whatsapp/.env
```

**Ligne à modifier :**
```
GEMINI_API_KEY=    ← collez votre clé ici
```

---

### 3. Votre numéro WhatsApp (OWNER_JID)

C'est votre numéro personnel. Le bot n'écoutera que vos messages.

**Format :** `VOTRE_NUMERO@s.whatsapp.net`

Exemple : si votre numéro est `+237 659 554 712` → `237659554712@s.whatsapp.net`

**Fichier :** `/home/ubuntu/bot_whatsapp/.env`

```bash
sudo nano /home/ubuntu/bot_whatsapp/.env
```

**Ligne à modifier :**
```
OWNER_JID=    ← mettez votre JID ici (ex: 237659554712@s.whatsapp.net)
```

**Même chose dans le backend :**

**Fichier :** `/home/ubuntu/server_dashboard/.env`

```bash
sudo nano /home/ubuntu/server_dashboard/.env
```

Ajoutez la ligne :
```
OWNER_JID=237659554712@s.whatsapp.net
```

---

### 4. Définition des mots de passe ZiVPN

L'installateur crée `/etc/zivpn/config.json` avec un mot de passe par défaut (le même que l'admin password).

Les utilisateurs VPN se créent depuis le panel web (section ZiVPN). Le mot de passe par défaut dans le fichier de config est celui de l'admin.

**Fichier :** `/etc/zivpn/config.json`

```bash
sudo nano /etc/zivpn/config.json
```

```json
{
  "listen": ":443",
  "auth": {
    "mode": "passwords",
    "config": ["admin1234"]     ← mot de passe admin ZiVPN
  }
}
```

**Redémarrage :**
```bash
sudo systemctl restart zivpn
```

---

### 5. Scanner le QR code WhatsApp

Le bot est enregistré dans PM2 mais n'est pas encore connecté à WhatsApp.

```bash
# Voir le QR code à scanner
pm2 logs whatsapp-bot
```

1. Ouvrez WhatsApp sur votre téléphone
2. Menu → Appareils liés → Lier un appareil
3. Scannez le QR qui apparaît dans le terminal
4. Le bot est connecté !

Pour vérifier :
```bash
pm2 status
```

---

### 6. Ports à ouvrir dans le firewall

Si votre serveur a un pare-feu (AWS Security Group, OVH, etc.), ouvrez ces ports :

| Port | Protocole | Service |
|---|---|---|
| 2053 | TCP | Panel web |
| 443 | UDP | ZiVPN |
| 36712 | UDP | UDP-Custom |
| 5678 | TCP | n8n |
| 9119 | TCP | Hermes (si installé) |

Sur le serveur (UFW) :
```bash
sudo ufw allow 2053/tcp
sudo ufw allow 443/udp
sudo ufw allow 36712/udp
sudo ufw allow 5678/tcp
```

---

### 7. Créer des utilisateurs VPN

Connectez-vous au panel : `http://VOTRE_IP:2053`

**Onglet ZiVPN :**
- Cliquez "Ajouter utilisateur"
- Remplissez le nom d'utilisateur et mot de passe
- Validez → l'utilisateur est ajouté dans la config ZiVPN et le service redémarré

**Onglet UDP-Custom :**
- Cliquez "Ajouter compte"
- Remplissez les identifiants
- Validez → l'utilisateur est créé dans le système + iptables configuré

---

### 8. n8n (automatisation)

n8n est pré-installé et tourne sur le port 5678.

Accès : `http://VOTRE_IP:5678`

Première connexion :
- Créez un compte admin (local)
- Vous pouvez connecter n8n à WhatsApp, email, base de données, etc.

---

## Résumé des fichiers à connaître

| Fichier | Ce qu'il contient | Commande pour l'éditer |
|---|---|---|
| `/home/ubuntu/server_dashboard/.env` | Mot de passe admin, IPs, OWNER_JID | `sudo nano` |
| `/home/ubuntu/bot_whatsapp/.env` | Clé Gemini, OWNER_JID, IPs | `sudo nano` |
| `/etc/zivpn/config.json` | Config ZiVPN (port, cert, passwords) | `sudo nano` |
| `/root/udp/config.json` | Config UDP-Custom | `sudo nano` |
| `/var/www/vpn_panel/index.html` | Page d'accueil du panel | `sudo nano` |
| `/home/ubuntu/server_dashboard/server.js` | API backend (1341 lignes) | `sudo nano` |
| `/etc/nginx/sites-available/vpn_panel` | Config nginx (port 2053) | `sudo nano` |

## Résumé des commandes de gestion

```
pm2 status                    → voir tous les processus PM2
pm2 logs whatsapp-bot         → voir les logs du bot WhatsApp
pm2 restart whatsapp-bot      → redémarrer le bot
pm2 restart server-dashboard  → redémarrer le backend

systemctl status zivpn        → état de ZiVPN
systemctl restart zivpn       → redémarrer ZiVPN
systemctl status udp-custom   → état de UDP-Custom
systemctl restart udp-custom  → redémarrer UDP-Custom

docker ps                     → voir les conteneurs
docker logs tns-n8n           → logs de n8n
docker restart tns-n8n        → redémarrer n8n

sudo nginx -t                 → tester la config nginx
sudo systemctl reload nginx   → recharger nginx
```

## Dépannage

- **Le panel affiche 503** → `pm2 restart server-dashboard`
- **Le bot ne répond pas** → `pm2 logs whatsapp-bot` (vérifier le QR et GEMINI_API_KEY)
- **ZiVPN ne démarre pas** → `systemctl status zivpn` et vérifier le binaire
- **UDP-Custom ne démarre pas** → `systemctl status udp-custom` (x86_64 uniquement)
- **n8n inaccessible** → `docker restart tns-n8n`
- **Port déjà utilisé** → `sudo lsof -i :PORT`
