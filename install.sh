#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
#  TNS-Panel — Auto-Installateur Universel
#  Déploie TOUT le panel VPN Dashboard + ses services sur un serveur vierge
#  Ubuntu 24.04 LTS (Noble) — x86_64
# =============================================================================

export DEBIAN_FRONTEND=noninteractive

# =============================================================================
# Détection automatique des paramètres système
# =============================================================================
detect_system() {
    export HOSTNAME=$(hostname)
    export ARCH=$(uname -m)
    export RUN_USER="${SUDO_USER:-$(who am i | awk '{print $1}')}"
    export RUN_USER="${RUN_USER:-root}"
    export USER_HOME=$(eval echo "~$RUN_USER")
    export PRIVATE_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    export PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "$PRIVATE_IP")
    export NET_IFACE=$(ip route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' || echo "eth0")
    export DISTRO=$(grep -oP '^PRETTY_NAME="\K[^"]+' /etc/os-release 2>/dev/null || echo "Ubuntu 24.04")
}

detect_system

export BACKEND_DIR="$USER_HOME/server_dashboard"
export FRONTEND_DIR="/var/www/vpn_panel"
export BOT_DIR="$USER_HOME/bot_whatsapp"
export HERMES_DIR="$USER_HOME/.hermes/hermes-agent"
export ZIVPN_BIN="/usr/local/bin/zivpn"
export UDP_BIN="/root/udp/udp-custom"
export CLOUDFLARED_BIN="$USER_HOME/cloudflared"
export ZIVPN_CONFIG="/etc/zivpn/config.json"
export UDP_CONFIG="/root/udp/config.json"
export DB_PATH="$BACKEND_DIR/database.db"

# Générer un mot de passe admin aléatoire si ADMIN_PASSWORD n'est pas déjà défini
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c16)}"
export OWNER_JID="${OWNER_JID:-}"

# Couleurs
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*"; }

# Vérification root
if [ "$(id -u)" -ne 0 ]; then
    err "Ce script doit être exécuté en tant que root (sudo)."
    exit 1
fi

# =============================================================================
# ÉTAPE 1 : Paquets système + swap + ip_forward
# =============================================================================
step1_system() {
    info "=== 1/12 : Paquets système ==="

    apt-get update -qq
    apt-get install -y -qq \
        nginx git curl wget openssl sqlite3 \
        iptables iptables-persistent ufw \
        vnstat python3 python3-dev python3-venv \
        python3-pip python3-requests python3-yaml \
        ca-certificates gnupg lsb-release \
        htop net-tools jq

    ok "Paquets système installés"

    # Swap 2GB si absent
    if ! swapon --show 2>/dev/null | grep -q .; then
        info "Création du swap 2GB..."
        fallocate -l 2G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
        ok "Swap 2GB créé"
    else
        ok "Swap déjà présent"
    fi

    # ip_forward
    sysctl -w net.ipv4.ip_forward=1
    if ! grep -q 'net.ipv4.ip_forward=1' /etc/sysctl.conf; then
        echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
    fi
    ok "ip_forward activé"
}

# =============================================================================
# ÉTAPE 2 : Node.js 20.x + npm global
# =============================================================================
step2_nodejs() {
    info "=== 2/12 : Node.js 20.x ==="

    if command -v node &>/dev/null && node --version | grep -q 'v20'; then
        ok "Node.js déjà installé : $(node --version)"
    else
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y -qq nodejs
        ok "Node.js $(node --version) installé"
    fi

    npm install -g pm2@7.0.1 localtunnel@2.0.2 --quiet
    ok "PM2 + localtunnel installés globalement"
}

# =============================================================================
# ÉTAPE 3 : Docker + n8n image
# =============================================================================
step3_docker() {
    info "=== 3/12 : Docker ==="

    if command -v docker &>/dev/null; then
        ok "Docker déjà installé : $(docker --version)"
    else
        curl -fsSL https://get.docker.com | bash
        usermod -aG docker "$RUN_USER" 2>/dev/null || true
        systemctl enable docker
        systemctl start docker
        ok "Docker installé"
    fi

    # Pull n8n
    if docker images --format '{{.Repository}}' | grep -q 'n8n'; then
        ok "Image n8n déjà présente"
    else
        docker pull docker.n8n.io/n8nio/n8n:latest
        docker volume create n8n_data 2>/dev/null || true
        ok "Image n8n téléchargée"
    fi
}

# =============================================================================
# ÉTAPE 4 : Binaires (zivpn, udp-custom, cloudflared, yt-dlp)
# =============================================================================
step4_binaries() {
    info "=== 4/12 : Binaires ==="

    # --- zivpn ---
    if [ -f "$ZIVPN_BIN" ]; then
        ok "zivpn déjà présent"
    else
        info "Installation de zivpn via l'installeur officiel..."
        # Le binaire n'est pas disponible en téléchargement direct.
        # On utilise l'installeur du projet arivpnstores/zahidbd2
        bash <(curl -fsSL https://raw.githubusercontent.com/arivpnstores/udp-zivpn/main/install.sh) 2>&1 | tail -3 || {
            warn "1er installeur échoué, tentative avec zi.sh..."
            bash <(curl -fsSL https://raw.githubusercontent.com/zahidbd2/udp-zivpn/main/zi.sh) 2>&1 | tail -3 || true
        }
        if [ -f "$ZIVPN_BIN" ]; then
            ok "zivpn installé"
        else
            warn "zivpn non trouvé. Installez manuellement :"
            warn "  bash <(curl -fsSL https://raw.githubusercontent.com/arivpnstores/udp-zivpn/main/install.sh)"
        fi
    fi

    # --- udp-custom ---
    if [ -f "$UDP_BIN" ]; then
        ok "udp-custom déjà présent"
    else
        mkdir -p /root/udp
        info "Téléchargement de udp-custom..."
        curl -fsSL "https://github.com/Haris131/UDP-Custom/raw/main/udp-custom-linux-amd64" -o "$UDP_BIN" && chmod +x "$UDP_BIN" && ok "udp-custom téléchargé" || {
            warn "Échec direct, tentative via installeur..."
            curl -fsSL "https://raw.githubusercontent.com/Haris131/UDP-Custom/main/udp-custom.sh" | bash 2>&1 | tail -3 || true
        }
    fi

    # --- cloudflared ---
    if [ -f "$CLOUDFLARED_BIN" ]; then
        ok "cloudflared déjà présent : $($CLOUDFLARED_BIN version 2>/dev/null | head -1)"
    else
        info "Téléchargement de cloudflared..."
        curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$CLOUDFLARED_BIN"
        chmod +x "$CLOUDFLARED_BIN"
        ok "cloudflared téléchargé : $($CLOUDFLARED_BIN version 2>/dev/null | head -1)"
    fi

    # --- yt-dlp ---
    if [ -f /usr/local/bin/yt-dlp ]; then
        ok "yt-dlp déjà présent"
    else
        curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
        chmod +x /usr/local/bin/yt-dlp
        ok "yt-dlp téléchargé"
    fi
}

# =============================================================================
# ÉTAPE 5 : Utilisateur + groupes
# =============================================================================
step5_users() {
    info "=== 5/12 : Utilisateurs et groupes ==="

    # Groupe vpnusers
    groupadd -f vpnusers
    ok "Groupe vpnusers prêt"

    # S'assurer que l'utilisateur principal existe
    RUN_USER_HOME=$(eval echo "~$RUN_USER" 2>/dev/null || echo "/home/$RUN_USER")
    if ! id "$RUN_USER" &>/dev/null; then
        useradd -m -s /bin/bash "$RUN_USER"
    fi
    usermod -aG sudo,docker "$RUN_USER"

    # Sudo NOPASSWD
    if [ ! -f "/etc/sudoers.d/$RUN_USER" ]; then
        echo "$RUN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$RUN_USER"
        chmod 440 "/etc/sudoers.d/$RUN_USER"
        ok "Sudo NOPASSWD configuré pour $RUN_USER"
    else
        ok "Sudo déjà configuré"
    fi
}

# =============================================================================
# ÉTAPE 6 : Structure des répertoires
# =============================================================================
step6_directories() {
    info "=== 6/12 : Répertoires ==="

    mkdir -p "$FRONTEND_DIR"
    mkdir -p "$BACKEND_DIR"
    mkdir -p /etc/zivpn
    mkdir -p /root/udp
    mkdir -p "$USER_HOME/.pm2/logs"

    # Si ce script est dans le repo cloné, copier les fichiers frontend/backend
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "$SCRIPT_DIR/frontend/index.html" ]; then
        cp "$SCRIPT_DIR/frontend/index.html" "$FRONTEND_DIR/"
        cp "$SCRIPT_DIR/frontend/index.js" "$FRONTEND_DIR/"
        cp "$SCRIPT_DIR/frontend/style.css" "$FRONTEND_DIR/"
        cp "$SCRIPT_DIR/backend/server.js" "$BACKEND_DIR/"
        cp "$SCRIPT_DIR/backend/package.json" "$BACKEND_DIR/" 2>/dev/null || true
        ok "Fichiers du panel copiés depuis le repo local"
    else
        warn "Fichiers frontend/backend non trouvés dans le repo."
        warn "Placez-les dans: frontend/ et backend/ puis relancez"
    fi

    chown -R "$RUN_USER":"$RUN_USER" "$FRONTEND_DIR" "$BACKEND_DIR" "$USER_HOME/.pm2" 2>/dev/null || true
    ok "Répertoires créés"
}

# =============================================================================
# ÉTAPE 7 : Fichiers de configuration (.env, nginx, services systemd)
# =============================================================================
step7_configs() {
    info "=== 7/12 : Fichiers de configuration ==="

    # --- .env backend ---
    if [ ! -f "$BACKEND_DIR/.env" ]; then
        cat > "$BACKEND_DIR/.env" << EOF
PORT=3000
DATABASE_PATH=./database.db
ADMIN_PASSWORD=${ADMIN_PASSWORD}
PUBLIC_IP=${PUBLIC_IP}
PRIVATE_IP=${PRIVATE_IP}
HOSTNAME=${HOSTNAME}
ZIVPN_CONFIG_PATH=${ZIVPN_CONFIG}
BOT_PM2_NAME=whatsapp-bot
BOT_LOGS_OUT_PATH=${USER_HOME}/.pm2/logs/whatsapp-bot-out.log
BOT_LOGS_ERR_PATH=${USER_HOME}/.pm2/logs/whatsapp-bot-error.log
EGRESS_LIMIT_GB=100
N8N_PORT=5678
N8N_LOG_PATH=${USER_HOME}/.pm2/logs/n8n-out.log
N8N_ERR_PATH=${USER_HOME}/.pm2/logs/n8n-error.log
HERMES_LOG_PATH=${USER_HOME}/.hermes/logs/hermes-tunnel.log
EOF
        ok ".env backend créé"
    else
        ok ".env backend déjà présent"
    fi

    # --- ZiVPN config ---
    if [ ! -f "$ZIVPN_CONFIG" ]; then
        if [ ! -f /etc/zivpn/zivpn.crt ] || [ ! -f /etc/zivpn/zivpn.key ]; then
            info "Génération du certificat SSL auto-signé pour ZiVPN..."
            openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
                -keyout /etc/zivpn/zivpn.key \
                -out /etc/zivpn/zivpn.crt \
                -subj "/C=US/ST=California/L=Los Angeles/O=Example Corp/OU=IT Department/CN=zivpn"
            chmod 644 /etc/zivpn/zivpn.crt
            chmod 600 /etc/zivpn/zivpn.key
            ok "Certificat ZiVPN généré"
        fi

        cat > "$ZIVPN_CONFIG" << 'EOF'
{
  "listen": ":443",
  "cert": "/etc/zivpn/zivpn.crt",
  "key": "/etc/zivpn/zivpn.key",
  "obfs": "zivpn",
  "auth": {
    "mode": "passwords",
    "config": [
      "admin1234"
    ]
  }
}
EOF
        ok "ZiVPN config créée"
    else
        ok "ZiVPN config déjà présente"
    fi

    # --- UDP-Custom config ---
    if [ ! -f "$UDP_CONFIG" ]; then
        cat > "$UDP_CONFIG" << 'EOF'
{
  "listen": ":36712",
  "stream_buffer": 33554432,
  "receive_buffer": 83886080,
  "auth": {
    "mode": "passwords"
  }
}
EOF
        ok "UDP-Custom config créée"
    else
        ok "UDP-Custom config déjà présente"
    fi

    # --- Systemd: zivpn ---
    cat > /etc/systemd/system/zivpn.service << 'EOF'
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
    ok "Service systemd zivpn créé"

    # --- Systemd: udp-custom ---
    cat > /etc/systemd/system/udp-custom.service << 'EOF'
[Unit]
Description=UDP Custom by ePro Dev. Team
After=network.target

[Service]
User=root
Type=simple
ExecStart=/root/udp/udp-custom server --config /root/udp/config.json
WorkingDirectory=/root/udp/
Restart=always
RestartSec=2s

[Install]
WantedBy=multi-user.target
EOF
    ok "Service systemd udp-custom créé"

    systemctl daemon-reload

    # --- Nginx: vpn_panel ---
    cat > /etc/nginx/sites-available/vpn_panel << EOF
server {
    listen 2053 default_server;
    listen [::]:2053 default_server;

    root /var/www/vpn_panel;
    index index.html;

    server_name ${PUBLIC_IP} ${PRIVATE_IP} ${HOSTNAME} _;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF

    if [ ! -L /etc/nginx/sites-enabled/vpn_panel ]; then
        rm -f /etc/nginx/sites-enabled/default
        ln -s /etc/nginx/sites-available/vpn_panel /etc/nginx/sites-enabled/
    fi
    nginx -t && systemctl reload nginx || true
    ok "Nginx configuré (port 2053, proxy /api/ -> :3000)"
}

# =============================================================================
# ÉTAPE 8 : Installation npm backend
# =============================================================================
step8_npm() {
    info "=== 8/12 : Dépendances npm ==="

    # Backend package.json
    if [ ! -f "$BACKEND_DIR/package.json" ]; then
        cat > "$BACKEND_DIR/package.json" << 'EOF'
{
  "name": "server-dashboard",
  "version": "1.0.0",
  "description": "Real-time server monitoring dashboard",
  "main": "server.js",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "sqlite3": "^6.0.1"
  }
}
EOF
    fi

    cd "$BACKEND_DIR"
    if [ ! -d node_modules ]; then
        su - "$RUN_USER" -c "cd $BACKEND_DIR && npm install --omit=dev --quiet"
        ok "Dépendances backend installées"
    else
        ok "Node_modules backend déjà présents"
    fi
}

# =============================================================================
# ÉTAPE 9 : Clone WhatsApp Bot + installation npm
# =============================================================================
step9_whatsapp_bot() {
    info "=== 9/12 : WhatsApp Bot ==="

    if [ -d "$BOT_DIR" ]; then
        ok "WhatsApp Bot déjà présent"
    else
        info "Tentative de clonage du WhatsApp Bot..."
        BOT_REPO_URL="https://github.com/TheShellMaster/BOT_WHATSAPP.git"
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            git clone "https://${GITHUB_TOKEN}@github.com/TheShellMaster/BOT_WHATSAPP.git" "$BOT_DIR" 2>/dev/null && ok "WhatsApp Bot cloné avec token" || {
                warn "Clone avec token échoué, clone anonyme..."
                git clone "$BOT_REPO_URL" "$BOT_DIR" 2>/dev/null && ok "WhatsApp Bot cloné" || {
                    warn "Clone échoué (repo privé). Dossier créé vide."
                    mkdir -p "$BOT_DIR"/{commands,utils,baileys_auth,data}
                }
            }
        else
            git clone "$BOT_REPO_URL" "$BOT_DIR" 2>/dev/null || {
                warn "Clone échoué (repo privé). Dossier créé vide."
                mkdir -p "$BOT_DIR"/{commands,utils,baileys_auth,data}
            }
        fi
    fi

    # .env WhatsApp Bot
    if [ ! -f "$BOT_DIR/.env" ]; then
        cat > "$BOT_DIR/.env" << EOF
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash-exp
ADMIN_PASSWORD=${ADMIN_PASSWORD}
OWNER_JID=${OWNER_JID}
SERVER_PUBLIC_IP=${PUBLIC_IP}
SERVER_PRIVATE_IP=${PRIVATE_IP}
EOF
        ok ".env WhatsApp Bot créé (éditez GEMINI_API_KEY et OWNER_JID)"
    fi

    if [ -f "$BOT_DIR/package.json" ] && [ ! -d "$BOT_DIR/node_modules" ]; then
        su - "$RUN_USER" -c "cd $BOT_DIR && npm install --omit=dev --quiet"
        ok "Dépendances WhatsApp Bot installées"
    else
        ok "WhatsApp Bot déjà configuré"
    fi
}

# =============================================================================
# ÉTAPE 10 : Hermes Agent (clone + venv)
# =============================================================================
step10_hermes() {
    info "=== 10/12 : Hermes Agent ==="

    if [ -d "$HERMES_DIR" ]; then
        ok "Hermes déjà cloné"
    else
        su - "$RUN_USER" -c "mkdir -p '$USER_HOME/.hermes'"
        su - "$RUN_USER" -c "git clone https://github.com/NousResearch/hermes-agent.git '$HERMES_DIR'" || {
            warn "Clone Hermes échoué (skip)"
            return
        }
    fi

    if [ -d "$HERMES_DIR/venv" ]; then
        ok "Virtualenv Hermes déjà présent"
    else
        if [ -f "$HERMES_DIR/setup-hermes.sh" ]; then
            su - "$RUN_USER" -c "cd '$HERMES_DIR' && bash setup-hermes.sh" || {
                info "Fallback: création venv manuelle..."
                su - "$RUN_USER" -c "cd '$HERMES_DIR' && python3 -m venv venv && venv/bin/pip install --quiet -e ." || true
            }
        else
            su - "$RUN_USER" -c "cd '$HERMES_DIR' && python3 -m venv venv && venv/bin/pip install --quiet -e ." || true
        fi
        ok "Virtualenv Hermes installé"
    fi

    # Répertoire logs Hermes
    mkdir -p "$USER_HOME/.hermes/logs"
    chown -R "$RUN_USER":"$RUN_USER" "$USER_HOME/.hermes" 2>/dev/null || true
}

# =============================================================================
# ÉTAPE 11 : iptables NAT + règles
# =============================================================================
step11_iptables() {
    info "=== 11/12 : Règles iptables ==="

    # Nettoyage des anciennes règles
    iptables -t nat -D PREROUTING -i "$NET_IFACE" -p udp --dport 443 -j ACCEPT 2>/dev/null || true
    iptables -t nat -D PREROUTING -i "$NET_IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :443 2>/dev/null || true
    iptables -t nat -D POSTROUTING -o "$NET_IFACE" -j MASQUERADE 2>/dev/null || true

    # ZiVPN : port range 6000-19999 -> 443
    iptables -t nat -I PREROUTING 1 -i "$NET_IFACE" -p udp --dport 443 -j ACCEPT
    iptables -t nat -I PREROUTING 1 -i "$NET_IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :443
    iptables -t nat -A POSTROUTING -o "$NET_IFACE" -j MASQUERADE

    # UDP-Custom catch-all
    iptables -t nat -A PREROUTING -i "$NET_IFACE" -p udp --dport 1:65535 -j DNAT --to-destination :36712 2>/dev/null || true

    # Sauvegarde iptables
    mkdir -p /etc/iptables
    iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    netfilter-persistent save 2>/dev/null || true

    ok "Règles iptables configurées (interface: $NET_IFACE)"
}

# =============================================================================
# ÉTAPE 12 : Démarrage des services
# =============================================================================
step12_start() {
    info "=== 12/12 : Démarrage des services ==="

    # Nginx
    systemctl enable nginx
    systemctl start nginx
    ok "Nginx démarré"

    # ZiVPN
    systemctl enable zivpn
    systemctl start zivpn || warn "ZiVPN non démarré (binaire manquant ?)"
    ok "ZiVPN configuré"

    # UDP-Custom
    systemctl enable udp-custom
    systemctl start udp-custom || warn "UDP-Custom non démarré (binaire manquant ?)"
    ok "UDP-Custom configuré"

    # PM2 server-dashboard
    if [ -f "$BACKEND_DIR/server.js" ]; then
        su - "$RUN_USER" -c "cd $BACKEND_DIR && pm2 start server.js --name server-dashboard 2>/dev/null || pm2 restart server-dashboard 2>/dev/null || true"
        su - "$RUN_USER" -c "pm2 save"
        ok "server-dashboard démarré (PM2)"
    else
        warn "server.js manquant, démarrage PM2 ignoré"
    fi

    # PM2 startup
    su - "$RUN_USER" -c "pm2 startup systemd -u $RUN_USER --hp $USER_HOME 2>/dev/null || true"

    ok "Installation terminée !"
    info "======================================"
    info "  Panel : http://${PUBLIC_IP}:2053"
    info "  API   : http://localhost:3000/api/stats"
    info "  SSH   : ${RUN_USER}@${PUBLIC_IP}"
    info "  Admin : ${ADMIN_PASSWORD}"
    info "======================================"
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║         TNS-Panel — Auto-Installateur        ║${NC}"
    echo -e "${CYAN}║     Déploie le panel VPN + tous les services ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}Détection système :${NC}"
    echo -e "  Distribution : ${DISTRO}"
    echo -e "  Architecture : ${ARCH}"
    echo -e "  Hostname     : ${HOSTNAME}"
    echo -e "  Utilisateur  : ${RUN_USER} (${USER_HOME})"
    echo -e "  IP Publique  : ${PUBLIC_IP}"
    echo -e "  IP Privée    : ${PRIVATE_IP}"
    echo -e "  Interface    : ${NET_IFACE}"
    echo -e "  Admin Pass   : ${ADMIN_PASSWORD}"
    echo ""

    step1_system
    step2_nodejs
    step3_docker
    step4_binaries
    step5_users
    step6_directories
    step7_configs
    step8_npm
    step9_whatsapp_bot
    step10_hermes
    step11_iptables
    step12_start

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║        INSTALLATION TERMINÉE AVEC SUCCÈS     ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${YELLOW}APRÈS INSTALL :${NC}"
    echo -e "  ${CYAN}1. Panel : http://${PUBLIC_IP}:2053 (admin: ${ADMIN_PASSWORD})${NC}"
    echo -e "  ${CYAN}2. SSH   : ${RUN_USER}@${PUBLIC_IP}${NC}"
    if [ ! -d "$BOT_DIR" ] || [ ! -f "$BOT_DIR/package.json" ]; then
    echo -e "  ${YELLOW}3. WhatsApp Bot : clone manuel requis (repo privé)${NC}"
    echo -e "     git clone https://<TOKEN>@github.com/TheShellMaster/BOT_WHATSAPP.git $BOT_DIR"
    else
    echo -e "  ${CYAN}3. WhatsApp Bot : pm2 start whatsapp-bot${NC}"
    fi
    echo -e "  ${CYAN}4. Définir GEMINI_API_KEY dans $BOT_DIR/.env${NC}"
    echo ""
}

main "$@"
