#!/usr/bin/env bash
set -euo pipefail

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
    case "$ARCH" in
        x86_64|amd64)  export ARCH_ALT="amd64" ;;
        aarch64|arm64) export ARCH_ALT="arm64" ;;
        armv7l|armhf)  export ARCH_ALT="arm"   ;;
        *)             export ARCH_ALT="$ARCH"  ;;
    esac
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
export N8N_CONTAINER="tns-n8n"
export CF_TUNNEL_N8N_PID="$USER_HOME/.cloudflared/n8n-tunnel.pid"
export CF_TUNNEL_HERMES_PID="$USER_HOME/.cloudflared/hermes-tunnel.pid"

export ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c16)}"
export OWNER_JID="${OWNER_JID:-}"

# Couleurs
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*"; }

ask() {
    local msg="$1" default="${2:-y}" answer
    local prompt="[Y/n]"
    [ "$default" = "n" ] && prompt="[y/N]"
    echo -ne "${CYAN}?${NC} $msg $prompt "
    read -r answer
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[YyOo1] ]]
}

if [ "$(id -u)" -ne 0 ]; then
    err "Ce script doit être exécuté en tant que root (sudo)."
    exit 1
fi

if [ "$ARCH_ALT" != "amd64" ] && [ "$ARCH_ALT" != "arm64" ] && [ "$ARCH_ALT" != "arm" ]; then
    warn "Architecture non reconnue: $ARCH. L'installation peut échouer."
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
# ÉTAPE 3 : Docker + n8n
# =============================================================================
step3_docker_n8n() {
    info "=== 3/12 : Docker + n8n ==="
    if command -v docker &>/dev/null; then
        ok "Docker déjà installé : $(docker --version)"
    else
        curl -fsSL https://get.docker.com | bash
        usermod -aG docker "$RUN_USER" 2>/dev/null || true
        systemctl enable docker
        systemctl start docker
        ok "Docker installé"
    fi

    if docker ps -a --format '{{.Names}}' | grep -q "^${N8N_CONTAINER}$"; then
        ok "Conteneur n8n déjà présent"
    else
        info "Téléchargement et démarrage de n8n..."
        docker pull docker.n8n.io/n8nio/n8n:latest
        docker volume create n8n_data 2>/dev/null || true
        docker run -d \
            --name "$N8N_CONTAINER" \
            --restart unless-stopped \
            -p 5678:5678 \
            -v n8n_data:/home/node/.n8n \
            docker.n8n.io/n8nio/n8n:latest
        ok "n8n démarré sur le port 5678"
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
        if [ "$ARCH_ALT" = "amd64" ] || [ "$ARCH_ALT" = "arm64" ] || [ "$ARCH_ALT" = "arm" ]; then
            info "Téléchargement de zivpn (${ARCH_ALT})..."
            ZIVPN_URL="https://github.com/zahidbd2/udp-zivpn/releases/download/udp-zivpn_1.4.9/udp-zivpn-linux-${ARCH_ALT}"
            curl -fsSL "$ZIVPN_URL" -o "$ZIVPN_BIN" && chmod +x "$ZIVPN_BIN" && ok "zivpn téléchargé" || {
                warn "Échec du téléchargement direct, tentative installeur..."
                bash <(curl -fsSL https://raw.githubusercontent.com/arivpnstores/udp-zivpn/main/install.sh) 2>&1 | tail -3 || true
            }
        else
            warn "Pas de binaire zivpn pour $ARCH"
        fi
    fi

    # --- udp-custom ---
    if [ -f "$UDP_BIN" ]; then
        ok "udp-custom déjà présent"
    else
        if [ "$ARCH_ALT" = "amd64" ]; then
            mkdir -p /root/udp
            info "Téléchargement de udp-custom..."
            curl -fsSL "https://github.com/Haris131/UDP-Custom/raw/main/udp-custom-linux-amd64" -o "$UDP_BIN" && chmod +x "$UDP_BIN" && ok "udp-custom téléchargé" || {
                warn "Échec, tentative via installeur..."
                curl -fsSL "https://raw.githubusercontent.com/Haris131/UDP-Custom/main/udp-custom.sh" | bash 2>&1 | tail -3 || true
            }
        else
            warn "udp-custom disponible seulement sur amd64"
        fi
    fi

    # --- cloudflared ---
    if [ -f "$CLOUDFLARED_BIN" ]; then
        ok "cloudflared déjà présent"
    else
        info "Téléchargement de cloudflared..."
        case "$ARCH_ALT" in
            amd64) CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
            arm64) CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
            arm)   CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" ;;
            *)     warn "Pas de cloudflared pour $ARCH" ;;
        esac
        if [ -n "${CF_URL:-}" ]; then
            curl -fsSL "$CF_URL" -o "$CLOUDFLARED_BIN" && chmod +x "$CLOUDFLARED_BIN" && ok "cloudflared téléchargé"
        fi
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
    groupadd -f vpnusers
    ok "Groupe vpnusers prêt"

    if ! id "$RUN_USER" &>/dev/null; then
        useradd -m -s /bin/bash "$RUN_USER"
    fi
    usermod -aG sudo,docker "$RUN_USER"

    if [ ! -f "/etc/sudoers.d/$RUN_USER" ]; then
        echo "$RUN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$RUN_USER"
        chmod 440 "/etc/sudoers.d/$RUN_USER"
        ok "Sudo NOPASSWD configuré pour $RUN_USER"
    fi
}

# =============================================================================
# ÉTAPE 6 : Structure des répertoires
# =============================================================================
step6_directories() {
    info "=== 6/12 : Répertoires ==="
    mkdir -p "$FRONTEND_DIR" "$BACKEND_DIR" /etc/zivpn /root/udp "$USER_HOME/.pm2/logs" "$USER_HOME/.cloudflared"

    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "$SCRIPT_DIR/frontend/index.html" ]; then
        cp "$SCRIPT_DIR/frontend/index.html" "$FRONTEND_DIR/"
        cp "$SCRIPT_DIR/frontend/index.js" "$FRONTEND_DIR/"
        cp "$SCRIPT_DIR/frontend/style.css" "$FRONTEND_DIR/"
        cp "$SCRIPT_DIR/backend/server.js" "$BACKEND_DIR/"
        cp "$SCRIPT_DIR/backend/package.json" "$BACKEND_DIR/" 2>/dev/null || true
        ok "Fichiers du panel copiés depuis le repo"
    else
        warn "frontend/backend non trouvés dans le repo"
    fi

    chown -R "$RUN_USER":"$RUN_USER" "$FRONTEND_DIR" "$BACKEND_DIR" "$USER_HOME/.pm2" "$USER_HOME/.cloudflared" 2>/dev/null || true
    ok "Répertoires créés"
}

# =============================================================================
# ÉTAPE 7 : Fichiers de configuration
# =============================================================================
step7_configs() {
    info "=== 7/12 : Fichiers de configuration ==="

    # .env backend
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
NETWORK_INTERFACE=${NET_IFACE}
EOF
        ok ".env backend créé"
    fi

    # Certificat SSL ZiVPN
    if [ ! -f /etc/zivpn/zivpn.crt ] || [ ! -f /etc/zivpn/zivpn.key ]; then
        openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
            -keyout /etc/zivpn/zivpn.key \
            -out /etc/zivpn/zivpn.crt \
            -subj "/C=US/ST=California/L=Los Angeles/O=TNS Panel/OU=IT/CN=${PUBLIC_IP}"
        chmod 644 /etc/zivpn/zivpn.crt
        chmod 600 /etc/zivpn/zivpn.key
        ok "Certificat ZiVPN généré (CN=${PUBLIC_IP})"
    fi

    # ZiVPN config
    if [ ! -f "$ZIVPN_CONFIG" ]; then
        cat > "$ZIVPN_CONFIG" << EOF
{
  "listen": ":443",
  "cert": "/etc/zivpn/zivpn.crt",
  "key": "/etc/zivpn/zivpn.key",
  "obfs": "zivpn",
  "auth": {
    "mode": "passwords",
    "config": [
      "${ADMIN_PASSWORD}"
    ]
  }
}
EOF
        ok "ZiVPN config créée"
    fi

    # UDP-Custom config
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
    fi

    # Service systemd zivpn
    cat > /etc/systemd/system/zivpn.service << 'EOF'
[Unit]
Description=ZiVPN Server
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

    # Service systemd udp-custom
    cat > /etc/systemd/system/udp-custom.service << 'EOF'
[Unit]
Description=UDP Custom
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

    systemctl daemon-reload
    ok "Services systemd créés"

    # Nginx
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
    ok "Nginx configuré (port 2053 → panel, /api/ → 3000)"
}

# =============================================================================
# ÉTAPE 8 : Dépendances npm backend
# =============================================================================
step8_npm() {
    info "=== 8/12 : Dépendances npm ==="
    if [ ! -f "$BACKEND_DIR/package.json" ]; then
        cat > "$BACKEND_DIR/package.json" << 'EOF'
{
  "name": "server-dashboard",
  "version": "1.0.0",
  "description": "TNS Panel backend",
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
    if [ ! -d "$BACKEND_DIR/node_modules" ]; then
        su - "$RUN_USER" -c "cd $BACKEND_DIR && npm install --omit=dev --quiet"
        ok "Dépendances backend installées"
    else
        ok "Node_modules backend déjà présents"
    fi
}

# =============================================================================
# ÉTAPE 9 : WhatsApp Bot
# =============================================================================
step9_whatsapp_bot() {
    info "=== 9/12 : WhatsApp Bot ==="
    if [ -d "$BOT_DIR" ] && [ -f "$BOT_DIR/package.json" ]; then
        ok "WhatsApp Bot déjà présent"
    else
        info "Clonage du WhatsApp Bot..."
        rm -rf "$BOT_DIR"
        git clone "https://github.com/TheShellMaster/BOT_WHATSAPP.git" "$BOT_DIR" 2>/dev/null && {
            ok "WhatsApp Bot cloné avec succès"
        } || {
            warn "Échec du clonage. Vérifiez que le repo est public."
            mkdir -p "$BOT_DIR"
        }
    fi

    if [ ! -f "$BOT_DIR/.env" ]; then
        cat > "$BOT_DIR/.env" << EOF
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash-exp
ADMIN_PASSWORD=${ADMIN_PASSWORD}
OWNER_JID=${OWNER_JID}
SERVER_PUBLIC_IP=${PUBLIC_IP}
SERVER_PRIVATE_IP=${PRIVATE_IP}
EOF
        ok ".env WhatsApp Bot créé"
    fi

    if [ -f "$BOT_DIR/package.json" ] && [ ! -d "$BOT_DIR/node_modules" ]; then
        su - "$RUN_USER" -c "cd $BOT_DIR && npm install --omit=dev --quiet" && ok "npm WhatsApp Bot installé" || warn "npm install WhatsApp Bot échoué"
    fi
}

# =============================================================================
# ÉTAPE 10 : Hermes Agent
# =============================================================================
step10_hermes() {
    info "=== 10/12 : Hermes Agent ==="
    if [ -d "$HERMES_DIR" ]; then
        ok "Hermes déjà cloné"
    else
        su - "$RUN_USER" -c "mkdir -p '$USER_HOME/.hermes'"
        su - "$RUN_USER" -c "git clone https://github.com/NousResearch/hermes-agent.git '$HERMES_DIR'" && ok "Hermes cloné" || {
            warn "Clone Hermes échoué"
            return
        }
    fi
    if [ -d "$HERMES_DIR/venv" ]; then
        ok "Virtualenv Hermes déjà présent"
    else
        if [ -f "$HERMES_DIR/setup-hermes.sh" ]; then
            su - "$RUN_USER" -c "cd '$HERMES_DIR' && bash setup-hermes.sh" 2>&1 | tail -3 || true
        fi
        if [ ! -d "$HERMES_DIR/venv" ]; then
            su - "$RUN_USER" -c "cd '$HERMES_DIR' && python3 -m venv venv && venv/bin/pip install --quiet -e . 2>/dev/null" || true
        fi
        if [ -d "$HERMES_DIR/venv" ]; then
            ok "Virtualenv Hermes installé"
        else
            warn "Hermes venv non créé"
        fi
    fi
    mkdir -p "$USER_HOME/.hermes/logs"
    chown -R "$RUN_USER":"$RUN_USER" "$USER_HOME/.hermes" 2>/dev/null || true
}

# =============================================================================
# ÉTAPE 11 : iptables NAT
# =============================================================================
step11_iptables() {
    info "=== 11/12 : Règles iptables ==="
    iptables -t nat -D PREROUTING -i "$NET_IFACE" -p udp --dport 443 -j ACCEPT 2>/dev/null || true
    iptables -t nat -D PREROUTING -i "$NET_IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :443 2>/dev/null || true
    iptables -t nat -D POSTROUTING -o "$NET_IFACE" -j MASQUERADE 2>/dev/null || true
    iptables -t nat -I PREROUTING 1 -i "$NET_IFACE" -p udp --dport 443 -j ACCEPT
    iptables -t nat -I PREROUTING 1 -i "$NET_IFACE" -p udp --dport 6000:19999 -j DNAT --to-destination :443
    iptables -t nat -A POSTROUTING -o "$NET_IFACE" -j MASQUERADE
    iptables -t nat -A PREROUTING -i "$NET_IFACE" -p udp --dport 1:65535 -j DNAT --to-destination :36712 2>/dev/null || true
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

    systemctl enable nginx
    systemctl start nginx
    ok "Nginx démarré"

    if [ -f "$ZIVPN_BIN" ]; then
        systemctl enable zivpn
        systemctl start zivpn && ok "ZiVPN démarré" || warn "ZiVPN non démarré"
    fi

    if [ -f "$UDP_BIN" ]; then
        systemctl enable udp-custom
        systemctl start udp-custom && ok "UDP-Custom démarré" || warn "UDP-Custom non démarré"
    fi

    if $DO_N8N; then
        docker start "$N8N_CONTAINER" 2>/dev/null || true
        ok "n8n démarré (port 5678)"
    fi

    if [ -f "$BACKEND_DIR/server.js" ]; then
        su - "$RUN_USER" -c "cd $BACKEND_DIR && pm2 start server.js --name server-dashboard 2>/dev/null || pm2 restart server-dashboard 2>/dev/null || true"
        ok "server-dashboard démarré (PM2, port 3000)"
    fi

    # WhatsApp Bot (PM2, mais pas start — attend le QR code)
    if $DO_BOT; then
        if [ -f "$BOT_DIR/index.js" ]; then
            BOT_MAIN="index.js"
        elif [ -f "$BOT_DIR/main.js" ]; then
            BOT_MAIN="main.js"
        elif [ -f "$BOT_DIR/app.js" ]; then
            BOT_MAIN="app.js"
        else
            BOT_MAIN=""
        fi
        if [ -n "$BOT_MAIN" ]; then
            su - "$RUN_USER" -c "cd $BOT_DIR && pm2 start $BOT_MAIN --name whatsapp-bot 2>/dev/null || pm2 restart whatsapp-bot 2>/dev/null || true"
            ok "WhatsApp Bot enregistré (PM2, scan QR requis)"
        else
            warn "WhatsApp Bot: point d'entrée non trouvé (index.js/main.js/app.js)"
        fi
    fi

    su - "$RUN_USER" -c "pm2 save"
    su - "$RUN_USER" -c "pm2 startup systemd -u $RUN_USER --hp $USER_HOME 2>/dev/null || true"

    # cloudflared tunnels
    if [ -f "$CLOUDFLARED_BIN" ]; then
        if $DO_N8N && docker ps --format '{{.Names}}' | grep -q "^${N8N_CONTAINER}$"; then
            nohup "$CLOUDFLARED_BIN" tunnel --url http://localhost:5678 --loglevel error > /dev/null 2>&1 &
            echo "$!" > "$CF_TUNNEL_N8N_PID"
            ok "Tunnel cloudflared n8n démarré"
        fi
        if $DO_HERMES && [ -f "$HERMES_DIR/venv/bin/hermes" ]; then
            nohup "$CLOUDFLARED_BIN" tunnel --url http://127.0.0.1:9119 --loglevel error > /dev/null 2>&1 &
            echo "$!" > "$CF_TUNNEL_HERMES_PID"
            ok "Tunnel cloudflared Hermes démarré"
        fi
    fi
}

# =============================================================================
# MAIN
# =============================================================================
main() {
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║       TNS-Panel — Auto-Installateur Complet     ║${NC}"
    echo -e "${CYAN}║   Panel VPN • ZiVPN • UDP-Custom • n8n • Bot   ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${GREEN}Détection :${NC}"
    echo -e "  OS: ${DISTRO} | Arch: ${ARCH} | User: ${RUN_USER}"
    echo -e "  IP: ${PUBLIC_IP} (${PRIVATE_IP}) | IF: ${NET_IFACE}"
    echo -e "  Admin pass: ${ADMIN_PASSWORD}"
    echo ""

    DO_VPN=false; DO_N8N=false; DO_BOT=false; DO_HERMES=false

    if ask "Installation complète (tout) ?" "y"; then
        DO_VPN=true; DO_N8N=true; DO_BOT=true
    else
        ask "Installer les services VPN (ZiVPN, UDP-Custom, iptables) ?" "y" && DO_VPN=true
        ask "Installer Docker + n8n ?" "y" && DO_N8N=true
        ask "Installer le WhatsApp Bot ?" "y" && DO_BOT=true
        ask "Installer Hermes Agent ?" "n" && DO_HERMES=true
    fi

    # Steps 1-2 : toujours exécutés
    step1_system
    step2_nodejs

    # Step 3 : Docker + n8n
    $DO_N8N && step3_docker_n8n

    # Step 4 : Binaires (selon services choisis)
    if $DO_VPN || $DO_N8N; then
        step4_binaries
    fi

    # Step 5-8 : toujours
    step5_users
    step6_directories
    step7_configs
    step8_npm

    # Step 9 : WhatsApp Bot
    $DO_BOT && step9_whatsapp_bot

    # Step 10 : Hermes
    $DO_HERMES && step10_hermes

    # Step 11 : iptables
    $DO_VPN && step11_iptables

    # Step 12 : Démarrage
    step12_start

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║        INSTALLATION TERMINÉE AVEC SUCCÈS       ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${CYAN}Panel  : http://${PUBLIC_IP}:2053${NC}"
    echo -e "  ${CYAN}API    : http://${PUBLIC_IP}:3000/api/stats${NC}"
    echo -e "  ${CYAN}SSH    : ${RUN_USER}@${PUBLIC_IP}${NC}"
    echo -e "  ${CYAN}Admin  : ${ADMIN_PASSWORD}${NC}"
    if $DO_BOT && [ -f "$BOT_DIR/package.json" ]; then
        echo -e "  ${CYAN}Bot    : pm2 start whatsapp-bot${NC}"
    fi
    if $DO_N8N; then
        echo -e "  ${CYAN}n8n    : http://${PUBLIC_IP}:5678${NC}"
    fi
    echo ""
    echo -e "  ${YELLOW}Config :${NC}"
    if $DO_BOT; then
        echo -e "    - Éditer ${CYAN}$BOT_DIR/.env${NC} → GEMINI_API_KEY"
    fi
    echo -e "    - Changer le mot de passe admin dans le panel"
    echo ""
}

main "$@"
