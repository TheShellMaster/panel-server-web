# TNS-Panel

Panel de monitoring VPN tout-en-un avec tableau de bord web, bot WhatsApp, ZiVPN, UDP-Custom, n8n, et Hermes Agent.

## Architecture

```
Port 2053  ─── nginx ──→ /var/www/vpn_panel/ (SPA)
                   │
                   └── /api/ ──→ localhost:3000 (Express backend)
                                      │
                                      ├── SQLite (vpn_users, udpcustom_accounts)
                                      ├── PM2 (whatsapp-bot)
                                      ├── Docker (n8n :5678)
                                      └── Direct (Hermes :9119)

ZiVPN      ── systemd ──→ /usr/local/bin/zivpn :443/UDP
UDP-Custom ── systemd ──→ /root/udp/udp-custom :36712/UDP
```

## Installation

### Prérequis

- Ubuntu 24.04 LTS (Noble) — x86_64
- Utilisateur `ubuntu` avec sudo NOPASSWD (ou exécuter en root)
- Ports ouverts : 2053/TCP, 443/UDP, 36712/UDP, 5678/TCP, 9119/TCP

### Auto-install (serveur vierge)

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/TheShellMaster/panel-server-web.git /opt/tns-panel
cd /opt/tns-panel
sudo bash install.sh
```

### Après installation

```
1. Éditer /home/ubuntu/server_dashboard/.env
   → ADMIN_PASSWORD=<mot_de_passe_admin>
   → OWNER_JID=<numéro_whatsapp@s.whatsapp.net>

2. Éditer /home/ubuntu/bot_whatsapp/.env
   → GEMINI_API_KEY=<clé_API_Google_Gemini>
   → OWNER_JID=<numéro_whatsapp@s.whatsapp.net>

3. Cloner le bot WhatsApp (repo privé) :
   git clone https://<TOKEN>@github.com/TheShellMaster/BOT_WHATSAPP.git /home/ubuntu/bot_whatsapp
   cd /home/ubuntu/bot_whatsapp && npm install

4. Scanner le QR code WhatsApp :
   pm2 start /home/ubuntu/bot_whatsapp/index.js --name whatsapp-bot
   pm2 logs whatsapp-bot

5. Accéder au panel : http://<IP_SERVEUR>:2053
```

## Fichiers de configuration

| Fichier | Rôle |
|---|---|
| `/var/www/vpn_panel/index.html` | Frontend SPA |
| `/var/www/vpn_panel/index.js` | Logique JS frontend |
| `/var/www/vpn_panel/style.css` | Styles CSS |
| `/home/ubuntu/server_dashboard/server.js` | Backend Express (API REST, CRUD VPN, synchronisation) |
| `/home/ubuntu/server_dashboard/.env` | Variables d'environnement backend |
| `/home/ubuntu/server_dashboard/database.db` | Base SQLite (vpn_users, udpcustom_accounts) |
| `/etc/zivpn/config.json` | Configuration ZiVPN |
| `/root/udp/config.json` | Configuration UDP-Custom |
| `/etc/nginx/sites-available/vpn_panel` | Configuration nginx |

## Ports

| Port | Service | Type |
|---|---|---|
| 22 | SSH | TCP |
| 80 | Nginx HTTP (redirigé) | TCP |
| 2053 | Panel web (nginx) | TCP |
| 3000 | Backend API (Express) | TCP |
| 443 | ZiVPN | UDP |
| 36712 | UDP-Custom | UDP |
| 5678 | n8n (Docker) | TCP |
| 9119 | Hermes Agent | TCP |

## Services

| Service | Type | Gestion |
|---|---|---|
| nginx | systemd | `systemctl restart nginx` |
| zivpn | systemd | `systemctl restart zivpn` |
| udp-custom | systemd | `systemctl restart udp-custom` |
| server-dashboard | PM2 | `pm2 restart server-dashboard` |
| whatsapp-bot | PM2 | `pm2 start whatsapp-bot` |
| n8n | Docker | `docker start n8n` |

## Structure du dépôt

```
panel-server-web/
├── install.sh          ← Auto-installateur (lancer en root)
├── frontend/
│   ├── index.html      ← Page principale SPA
│   ├── index.js        ← Logique JS
│   └── style.css       ← Styles
├── backend/
│   ├── server.js       ← API Express
│   └── package.json    ← Dépendances npm
├── AGENTS.md           ← Instructions pour l'IA
└── README.md           ← Ce fichier
```

## Développement

Pour modifier le frontend : éditer les fichiers dans `frontend/` et relancer l'install (étape 6) ou les copier manuellement dans `/var/www/vpn_panel/`.

Pour modifier le backend : éditer `backend/server.js` et redémarrer :
```bash
pm2 restart server-dashboard
```

## Dépannage

- **503 Service Unavailable** : nginx tourne mais le backend Express n'est pas démarré. Vérifier avec `pm2 status`.
- **ZiVPN ne répond pas** : `systemctl status zivpn` et vérifier `/etc/zivpn/config.json`.
- **UDP-Custom ne répond pas** : `systemctl status udp-custom` et vérifier `/root/udp/config.json`.
- **WhatsApp Bot ne se connecte pas** : `pm2 logs whatsapp-bot` pour voir le QR code.
- **n8n inaccessible** : `docker ps -a` pour vérifier le conteneur.
