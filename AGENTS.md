# Règles critiques pour l'agent opencode

## Services
- Hermes n'est PAS PM2 — c'est un processus Python direct
- n8n n'est PAS PM2 — c'est un conteneur Docker
- WhatsApp Bot est PM2 (name: whatsapp-bot)
- server-dashboard est PM2 (name: server-dashboard)
- ZiVPN est systemd (zivpn.service)
- UDP-Custom est systemd (udp-custom.service)

## Processus
- pkill -f "[p]attern" (bracket trick) pour ne pas tuer le shell
- Hermes: pgrep -f "[h]ermes dashboard"
- cloudflared: pgrep -f "[c]loudflared"

## Ports
- 2053: Frontend (nginx)
- 3000: Backend (Express)
- 443/UDP: ZiVPN
- 36712/UDP: UDP-Custom
- 5678: n8n (Docker)
- 9119: Hermes

## Binaires
- /usr/local/bin/zivpn — ZiVPN server
- /root/udp/udp-custom — UDP-Custom
- /home/ubuntu/cloudflared — Cloudflare tunnel
- /home/ubuntu/.hermes/hermes-agent/venv/bin/hermes — Hermes

## Tunnels
- n8n: cloudflared tunnel --url http://localhost:5678 (log: /tmp/cf.log)
- Hermes: cloudflared tunnel --url http://127.0.0.1:9119 (log: ~/.hermes/logs/hermes-tunnel.log)

## Synchronisation
- ZiVPN: CRUD DB → réécrit /etc/zivpn/config.json → systemctl restart zivpn
- UDP-Custom: CRUD DB → useradd/userdel + chpasswd + iptables
- Traffic: iptables toutes les 30s → auto-suspend si limite
- Expiration: toutes les 10 min → auto-suspend
- IP publique: curl api.ipify.org au démarrage

## Cache versions
- CSS: ?v=N dans index.html
- JS: ?v=N dans index.html
