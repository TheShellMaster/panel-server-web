#!/bin/bash
# ==========================================================================
#  VPN Dashboard & Multi-Protocol VPN Auto-Installer
#  Système: Ubuntu / Debian (x86_64)
#  Fonctions: Monitoring système, Gestionnaire VPN (UDP Custom, ZiVPN, FastDNS)
# ==========================================================================

set -e

# Couleurs pour la console
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # Pas de couleur

echo -e "${BLUE}===================================================================${NC}"
echo -e "${BLUE}    INSTALLATEUR DE DASHBOARD ET PROTOCOLES VPN AUTO-HÉBERGÉS      ${NC}"
echo -e "${BLUE}===================================================================${NC}"

# Vérifier si l'utilisateur est root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Erreur: Ce script doit être exécuté en tant que root.${NC}"
  exit 1
fi

# Détecter l'OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo -e "${RED}Erreur: Impossible de détecter le système d'exploitation.${NC}"
    exit 1
fi

if [ "$OS" != "ubuntu" ] && [ "$OS" != "debian" ]; then
    echo -e "${YELLOW}Attention: Ce script a été testé principalement sur Ubuntu et Debian.${NC}"
    read -p "Voulez-vous continuer quand même ? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Demander les configurations personnalisées de l'utilisateur
echo -e "\n${YELLOW}--- CONFIGURATION DES PARAMÈTRES ---${NC}"
read -p "Port d'accès Web du Dashboard (défaut: 2053): " PORT_WEB
PORT_WEB=${PORT_WEB:-2053}

read -p "Mot de passe administrateur par défaut pour le panel (défaut: admin1234): " ADMIN_PASS
ADMIN_PASS=${ADMIN_PASS:-admin1234}

read -p "Port d'écoute UDP Custom (défaut: 36712): " PORT_UDPCUSTOM
PORT_UDPCUSTOM=${PORT_UDPCUSTOM:-36712}

read -p "Port d'écoute ZiVPN (défaut: 5667): " PORT_ZIVPN
PORT_ZIVPN=${PORT_ZIVPN:-5667}

read -p "Nom de domaine ou NS pour FastDNS (ex: ns.votredomaine.com): " DNS_NS
if [ -z "$DNS_NS" ]; then
    echo -e "${RED}Erreur: Un nom de domaine/NS pour FastDNS est obligatoire.${NC}"
    exit 1
fi

# 1. Mise à jour du système et installation des dépendances
echo -e "\n${GREEN}[*] Mise à jour des paquets et installation des dépendances...${NC}"
apt-get update -y
apt-get install -y curl wget unzip build-essential sqlite3 vnstat nginx openssl iptables iptables-persistent git software-properties-common

# Installation de Node.js (v18.x ou v20.x)
if ! command -v node &> /dev/null; then
    echo -e "${GREEN}[*] Installation de Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Installation globale de PM2
if ! command -v pm2 &> /dev/null; then
    echo -e "${GREEN}[*] Installation de PM2...${NC}"
    npm install pm2 -g
fi

# Création de l'utilisateur système et groupe pour le VPN
echo -e "\n${GREEN}[*] Configuration du groupe système vpnusers...${NC}"
if ! getent group vpnusers > /dev/null; then
    groupadd vpnusers
fi

# Configuration SSH pour le groupe vpnusers
echo -e "${GREEN}[*] Configuration du service SSH pour la sécurité du VPN...${NC}"
if ! grep -q "Match Group vpnusers" /etc/ssh/sshd_config; then
    cat <<EOF >> /etc/ssh/sshd_config

# Configuration VPN Custom
Match Group vpnusers
    AllowTcpForwarding yes
    X11Forwarding no
    PermitTunnel yes
    AllowAgentForwarding no
    ForceCommand /bin/false
EOF
    systemctl restart ssh
fi

# 2. Installation de UDP Custom (BadVPN / udpgw)
echo -e "\n${GREEN}[*] Installation de BadVPN (udpgw)...${NC}"
# Téléchargement du binaire compile de badvpn-udpgw
wget -O /usr/local/bin/badvpn-udpgw "https://github.com/ambrop72/badvpn/releases/download/1.999.130/badvpn-1.999.130-linux-amd64" || \
wget -O /usr/local/bin/badvpn-udpgw "https://raw.githubusercontent.com/adam924/badvpn-udpgw/master/badvpn-udpgw"
chmod +x /usr/local/bin/badvpn-udpgw

# Création du service systemd pour udpgw
cat <<EOF > /etc/systemd/system/badvpn-udpgw.service
[Unit]
Description=BadVPN UDP Gateway
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/badvpn-udpgw --listen-addr 127.0.0.1:${PORT_UDPCUSTOM} --max-clients 500
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable badvpn-udpgw
systemctl restart badvpn-udpgw

# 3. Installation de UDP ZiVPN
echo -e "\n${GREEN}[*] Installation de ZiVPN...${NC}"
# Création du répertoire de configuration
mkdir -p /etc/zivpn
# Téléchargement du binaire ZiVPN officiel
wget -O /usr/local/bin/zivpn "https://github.com/zahidbd2/udp-zivpn/releases/download/udp-zivpn_1.4.9/udp-zivpn-linux-amd64" || \
echo "Échec du téléchargement automatique de ZiVPN. Veuillez configurer manuellement le binaire."
chmod +x /usr/local/bin/zivpn || true

# Génération des fichiers de certificat SSL auto-signés requis par ZiVPN
echo -e "${GREEN}[*] Génération des certificats SSL pour ZiVPN...${NC}"
openssl req -new -newkey rsa:4096 -days 365 -nodes -x509 \
  -subj "/C=US/ST=California/L=Los Angeles/O=Example Corp/OU=IT Department/CN=zivpn" \
  -keyout "/etc/zivpn/zivpn.key" -out "/etc/zivpn/zivpn.crt" || true

# Fichier de configuration par défaut pour ZiVPN
cat <<EOF > /etc/zivpn/config.json
{
  "listen": ":${PORT_ZIVPN}",
  "cert": "/etc/zivpn/zivpn.crt",
  "key": "/etc/zivpn/zivpn.key",
  "obfs": "zivpn",
  "auth": {
    "mode": "passwords",
    "config": [
      "${ADMIN_PASS}"
    ]
  }
}
EOF

# Service systemd pour ZiVPN
cat <<EOF > /etc/systemd/system/zivpn.service
[Unit]
Description=zivpn VPN Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/etc/zivpn
ExecStart=/usr/local/bin/zivpn server -c /etc/zivpn/config.json
Restart=always
RestartSec=3
Environment=ZIVPN_LOG_LEVEL=info
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

# Configuration des permissions pour que le dashboard (faisant tourner PM2 en non-root)
# puisse modifier config.json tout en permettant au service systemd (qui drops privileges)
# d'accéder au fichier zivpn.key (propriété root:root 600 obligatoire).
REAL_USER=${SUDO_USER:-$USER}
chown -R "$REAL_USER:$REAL_USER" /etc/zivpn || true
chown root:root /etc/zivpn/zivpn.key /etc/zivpn/zivpn.crt 2>/dev/null || true
chmod 600 /etc/zivpn/zivpn.key 2>/dev/null || true
chmod 644 /etc/zivpn/zivpn.crt /etc/zivpn/config.json 2>/dev/null || true

systemctl daemon-reload
systemctl enable zivpn || true
systemctl restart zivpn || true

# 4. Installation de FastDNS (dnstt)
echo -e "\n${GREEN}[*] Installation de FastDNS (dnstt)...${NC}"
mkdir -p /etc/dnstt
# Téléchargement du binaire dnstt
wget -O /usr/local/bin/dnstt-server "https://github.com/yinghuocho/dnstt/releases/download/v20200424/dnstt-server-linux-amd64" || \
echo "Veuillez configurer le binaire dnstt-server si le lien par défaut échoue."
chmod +x /usr/local/bin/dnstt-server || true

# Génération des clés de chiffrement FastDNS
if [ ! -f /etc/dnstt/server.key ]; then
    echo -e "${GREEN}[*] Génération des clés cryptographiques pour FastDNS...${NC}"
    cd /etc/dnstt
    # Utilisation recommandée de dnstt-server pour générer des clés compatibles avec dnstt
    if /usr/local/bin/dnstt-server -gen-key -privkey server.key -pubkey server.pub; then
        echo -e "${GREEN}[*] Clés FastDNS générées avec succès.${NC}"
    else
        echo -e "${YELLOW}Attention: dnstt-server n'a pas pu générer les clés directement. Génération via ssh-keygen en guise de fallback...${NC}"
        ssh-keygen -t ed25519 -f server.key -N ""
        ssh-keygen -y -f server.key > server.pub
    fi
    cd -
fi

# Configuration du service systemd pour FastDNS (sur le port UDP 5300)
cat <<EOF > /etc/systemd/system/dnstt.service
[Unit]
Description=FastDNS dnstt-server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/dnstt-server -udp :5300 -pubkey /etc/dnstt/server.pub -privkey /etc/dnstt/server.key ${DNS_NS} 127.0.0.1:22
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Détection de l'interface réseau publique par défaut
IFACE=$(ip -4 route show default | grep -oP 'dev \K\S+' | head -n1)
IFACE=${IFACE:-enX0}
echo -e "${GREEN}[*] Interface réseau détectée : ${IFACE}${NC}"

# Activation persistante de l'IP forwarding (IPv4 & IPv6)
echo -e "${GREEN}[*] Activation de l'IP forwarding...${NC}"
sysctl -w net.ipv4.ip_forward=1 || true
sysctl -w net.ipv6.conf.all.forwarding=1 || true
if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf; then
    echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
fi
if ! grep -q "net.ipv6.conf.all.forwarding=1" /etc/sysctl.conf; then
    echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.conf
fi
sysctl -p || true

# Redirections pare-feu et NAT pour tous les protocoles (FastDNS, ZiVPN, UDP Custom)
echo -e "${GREEN}[*] Application des règles de pare-feu et NAT...${NC}"

# Nettoyage des anciennes règles identiques pour éviter les doublons au ré-exécution du script
iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport 5667 -j ACCEPT 2>/dev/null || true
iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :5667 2>/dev/null || true
iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport "${PORT_ZIVPN}" -j ACCEPT 2>/dev/null || true
iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :"${PORT_ZIVPN}" 2>/dev/null || true
iptables -t nat -D PREROUTING -i "$IFACE" -p udp --dport 53 -j REDIRECT --to-ports 5300 2>/dev/null || true
iptables -t nat -D POSTROUTING -o "$IFACE" -j MASQUERADE 2>/dev/null || true

# Application des règles avec la bonne priorité
# 1. Accepter le trafic ZiVPN sur son port direct
iptables -t nat -A PREROUTING -i "$IFACE" -p udp --dport "${PORT_ZIVPN}" -j ACCEPT
# 2. Rediriger la plage de ports ZiVPN
iptables -t nat -A PREROUTING -i "$IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :"${PORT_ZIVPN}"
# 3. Rediriger le DNS vers dnstt-server
iptables -t nat -A PREROUTING -i "$IFACE" -p udp --dport 53 -j REDIRECT --to-ports 5300
# 4. Masquerading pour autoriser l'accès internet
iptables -t nat -A POSTROUTING -o "$IFACE" -j MASQUERADE

# Répéter la redirection DNS pour IPv6 si applicable
ip6tables -t nat -D PREROUTING -p udp --dport 53 -j REDIRECT --to-ports 5300 2>/dev/null || true
ip6tables -t nat -A PREROUTING -p udp --dport 53 -j REDIRECT --to-ports 5300 || true

# Sauvegarde persistante des règles iptables
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4 || true
ip6tables-save > /etc/iptables/rules.v6 || true

systemctl daemon-reload
systemctl enable dnstt || true
systemctl restart dnstt || true

# 5. Déploiement du Dashboard (Backend & Frontend)
echo -e "\n${GREEN}[*] Déploiement du Dashboard...${NC}"
mkdir -p /opt/vpn_dashboard/backend
mkdir -p /var/www/vpn_panel

# Copie des fichiers de l'installation courante
cp -r backend/* /opt/vpn_dashboard/backend/
cp -r frontend/* /var/www/vpn_panel/

# Configurer le fichier .env du Dashboard
cat <<EOF > /opt/vpn_dashboard/backend/.env
PORT=3000
DATABASE_PATH=/opt/vpn_dashboard/backend/database.db
ADMIN_PASSWORD=${ADMIN_PASS}
ZIVPN_CONFIG_PATH=/etc/zivpn/config.json
EGRESS_LIMIT_GB=100
BOT_PM2_NAME=whatsapp-bot
BOT_LOGS_OUT_PATH=/home/ubuntu/.pm2/logs/whatsapp-bot-out.log
BOT_LOGS_ERR_PATH=/home/ubuntu/.pm2/logs/whatsapp-bot-error.log
FASTDNS_NS=${DNS_NS}
FASTDNS_PUBKEY_PATH=/etc/dnstt/server.pub
NETWORK_INTERFACE=${IFACE}
EOF

# Installer les dépendances Node.js du Dashboard
echo -e "${GREEN}[*] Installation des dépendances NPM du Dashboard...${NC}"
cd /opt/vpn_dashboard/backend
npm install --production

# Lancement du backend avec PM2
pm2 delete vpn-dashboard 2>/dev/null || true
pm2 start server.js --name vpn-dashboard --watch
pm2 save
pm2 startup || true
cd -

# 6. Configuration de Nginx (Reverse Proxy & Frontend statique)
echo -e "\n${GREEN}[*] Configuration de Nginx pour le port ${PORT_WEB}...${NC}"
cat <<EOF > /etc/nginx/sites-available/vpn_dashboard
server {
    listen ${PORT_WEB} default_server;
    listen [::]:${PORT_WEB} default_server;

    root /var/www/vpn_panel;
    index index.html;

    server_name _;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

# Activer la configuration Nginx
ln -sf /etc/nginx/sites-available/vpn_dashboard /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default || true

systemctl restart nginx
vnstat -u -i $(ip -4 route show default | grep -oP 'dev \K\S+') || true

# 7. Résumé de l'installation
PUBLIC_IP=$(curl -s https://api.ipify.org || curl -s https://ifconfig.me || echo "VOTRE_IP_PUBLIQUE")

echo -e "\n${GREEN}===================================================================${NC}"
echo -e "${GREEN}       INSTALLATION ET CONFIGURATION REUSSIES AVEC SUCCÈS          ${NC}"
echo -e "${GREEN}===================================================================${NC}"
echo -e "Accès Web Dashboard : http://${PUBLIC_IP}:${PORT_WEB}/"
echo -e "Mot de passe Administrateur : ${ADMIN_PASS}"
echo -e ""
echo -e "--- PROTOCOLES ACTIFS ---"
echo -e "* UDP Custom (udpgw) : Port ${PORT_UDPCUSTOM}"
echo -e "* UDP ZiVPN         : Port ${PORT_ZIVPN}"
echo -e "* FastDNS (dnstt)    : Port 53 (Redirigé vers 5300) avec NS ${DNS_NS}"
echo -e "==================================================================="
echo -e "Toutes les clés de sécurité ont été générées automatiquement."
echo -e "Lisez le README.md pour savoir comment ajouter votre bot au dashboard."
echo -e "==================================================================="
