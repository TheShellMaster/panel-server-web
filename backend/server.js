require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec, execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Database & Config paths ---
const DB_PATH = process.env.DATABASE_PATH || '/home/ubuntu/server_dashboard/database.db';
const ZIVPN_CONFIG_PATH = process.env.ZIVPN_CONFIG_PATH || '/etc/zivpn/config.json';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const BOT_PM2_NAME = process.env.BOT_PM2_NAME || 'whatsapp-bot';
const BOT_LOGS_OUT_PATH = process.env.BOT_LOGS_OUT_PATH || '/home/ubuntu/.pm2/logs/whatsapp-bot-out.log';
const BOT_LOGS_ERR_PATH = process.env.BOT_LOGS_ERR_PATH || '/home/ubuntu/.pm2/logs/whatsapp-bot-error.log';
const HERMES_LOG_PATH = process.env.HERMES_LOG_PATH || '/root/.pm2/logs/hermes-agent-out.log';
const EGRESS_LIMIT_GB = parseInt(process.env.EGRESS_LIMIT_GB || '100', 10);
const NETWORK_INTERFACE = process.env.NETWORK_INTERFACE || ''; // Empty means auto-detect

// Initialize Database
const sqlite3 = require('sqlite3').verbose();
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir) && dbDir !== '.') {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Database connected successfully at:', DB_PATH);
        // Create table if it doesn't exist
        db.run(`    CREATE TABLE IF NOT EXISTS vpn_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            protocol TEXT,
            expires_at TEXT,
            max_connections INTEGER DEFAULT 1,
            data_limit_gb REAL DEFAULT 0,
            data_used REAL DEFAULT 0,
            last_iptables_bytes INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active'
        )`, () => {
            checkUserExpirations();
            initIptablesRules();
            setupNatRules();
        });
        db.run(`CREATE TABLE IF NOT EXISTS udpcustom_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            host TEXT NOT NULL DEFAULT '',
            port INTEGER DEFAULT 36712,
            expires_at TEXT,
            device_limit INTEGER DEFAULT 1,
            data_limit_mb REAL DEFAULT 0,
            data_used_mb REAL DEFAULT 0,
            last_bytes INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )`);
    }
});

// Synchronize ZiVPN config with database
function syncZivpnUsers(database) {
    return new Promise((resolve, reject) => {
        database.all("SELECT password FROM vpn_users WHERE protocol = 'zivpn' AND status = 'active'", (err, rows) => {
            if (err) return reject(err);
            
            try {
                const passwords = rows.map(r => r.password);
                
                // Keep default Admin Password in the config
                if (!passwords.includes(ADMIN_PASSWORD)) {
                    passwords.push(ADMIN_PASSWORD);
                }
                
                let config = {};
                const configDir = path.dirname(ZIVPN_CONFIG_PATH);
                if (!fs.existsSync(configDir)) {
                    fs.mkdirSync(configDir, { recursive: true });
                }

                if (fs.existsSync(ZIVPN_CONFIG_PATH)) {
                    try {
                        const content = fs.readFileSync(ZIVPN_CONFIG_PATH, 'utf8').trim();
                        if (content) {
                            config = JSON.parse(content);
                        }
                    } catch (jsonErr) {
                        console.error('Error parsing ZiVPN config, resetting:', jsonErr);
                    }
                }
                
                if (!config.auth) config.auth = {};
                config.auth.mode = "passwords";
                config.auth.config = passwords;
                
                fs.writeFileSync(ZIVPN_CONFIG_PATH, JSON.stringify(config, null, 2));
                
                exec('sudo systemctl restart zivpn', (errRestart, stdout, stderr) => {
                    if (errRestart) {
                        console.error('Error restarting zivpn:', errRestart);
                        return reject(errRestart);
                    }
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Create, delete, suspend or unsuspend system users
function manageSystemUser(username, password, action) {
    return new Promise((resolve, reject) => {
        const validUser = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/.test(username);
        if (!validUser) {
            return reject(new Error('Nom d\'utilisateur invalide. Doit être alphanumérique et de 3 à 20 caractères.'));
        }

        if (action === 'create') {
            exec(`getent passwd ${username}`, (err, stdout, stderr) => {
                const userExists = !err && stdout;
                
                const systemCmd = userExists 
                    ? `sudo usermod -s /bin/false -g vpnusers ${username}`
                    : `sudo useradd -M -s /bin/false -g vpnusers ${username}`;
                
                exec(systemCmd, (errCmd, stdoutCmd, stderrCmd) => {
                    if (errCmd) return reject(new Error(`Échec de configuration de l'utilisateur : ${stderrCmd || errCmd.message}`));
                    
                    // Securely set password via chpasswd stdin
                    const chpasswd = spawn('sudo', ['chpasswd']);
                    let errOutput = '';
                    chpasswd.stderr.on('data', (data) => { errOutput += data; });
                    chpasswd.on('close', (code) => {
                        if (code !== 0) {
                            return reject(new Error(`Échec de définition du mot de passe : ${errOutput}`));
                        }
                        
                        // Add iptables accounting rule
                        exec(`sudo iptables -D OUTPUT -m owner --uid-owner ${username} -m comment --comment "vpn_${username}"`, () => {
                            exec(`sudo iptables -A OUTPUT -m owner --uid-owner ${username} -m comment --comment "vpn_${username}"`, () => {
                                resolve();
                            });
                        });
                    });
                    chpasswd.stdin.write(`${username}:${password}\n`);
                    chpasswd.stdin.end();
                });
            });
        } else if (action === 'delete') {
            // Remove iptables accounting rule
            exec(`sudo iptables -D OUTPUT -m owner --uid-owner ${username} -m comment --comment "vpn_${username}"`, () => {
                exec(`sudo userdel -f ${username}`, (errDel, stdoutDel, stderrDel) => {
                    resolve();
                });
            });
        } else if (action === 'suspend') {
            exec(`sudo usermod -L -s /usr/sbin/nologin ${username}`, (errSusp, stdoutSusp, stderrSusp) => {
                if (errSusp) return reject(new Error(`Échec de suspension : ${stderrSusp || errSusp.message}`));
                resolve();
            });
        } else if (action === 'unsuspend') {
            exec(`sudo usermod -U -s /bin/false ${username}`, (errUnsp, stdoutUnsp, stderrUnsp) => {
                if (errUnsp) return reject(new Error(`Échec de réactivation : ${stderrUnsp || errUnsp.message}`));
                resolve();
            });
        } else if (action === 'update_password') {
            // Securely set password via chpasswd stdin
            const chpasswd = spawn('sudo', ['chpasswd']);
            let errOutput = '';
            chpasswd.stderr.on('data', (data) => { errOutput += data; });
            chpasswd.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Échec de mise à jour du mot de passe : ${errOutput}`));
                }
                resolve();
            });
            chpasswd.stdin.write(`${username}:${password}\n`);
            chpasswd.stdin.end();
        } else {
            reject(new Error('Action inconnue pour l\'utilisateur système'));
        }
    });
}

function initIptablesRules() {
    db.all("SELECT username, protocol FROM vpn_users WHERE status = 'active' AND protocol IN ('udpcustom')", (err, rows) => {
        if (err || !rows) return;
        
        rows.forEach(user => {
            exec(`sudo iptables -D OUTPUT -m owner --uid-owner ${user.username} -m comment --comment "vpn_${user.username}"`, () => {
                exec(`sudo iptables -A OUTPUT -m owner --uid-owner ${user.username} -m comment --comment "vpn_${user.username}"`);
            });
        });
    });
    db.all("SELECT username FROM udpcustom_accounts WHERE status = 'active'", (err, accounts) => {
        if (err || !accounts) return;
        accounts.forEach(acc => {
            exec(`sudo iptables -D OUTPUT -m owner --uid-owner ${acc.username} -m comment --comment "vpn_${acc.username}"`, () => {
                exec(`sudo iptables -A OUTPUT -m owner --uid-owner ${acc.username} -m comment --comment "vpn_${acc.username}"`);
            });
        });
    });
}

function getNetworkInterface() {
    if (NETWORK_INTERFACE) return NETWORK_INTERFACE;
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            if (name !== 'lo' && !name.includes('docker') && !name.includes('veth')) {
                const iface = interfaces[name].find(i => !i.internal);
                if (iface) return name;
            }
        }
    } catch (e) {
        console.error('Error detecting network interface:', e);
    }
    return 'enX0'; // Default fallback
}

function getZivpnPort() {
    try {
        if (fs.existsSync(ZIVPN_CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(ZIVPN_CONFIG_PATH, 'utf8'));
            if (config && config.listen) {
                const parts = config.listen.split(':');
                const port = parseInt(parts[parts.length - 1], 10);
                if (port > 0) return port;
            }
        }
    } catch (e) {
        console.error('Error reading ZiVPN port from config, using default 5667:', e);
    }
    return 5667;
}

function getZivpnStatus() {
    try {
        const out = execSync("systemctl is-active zivpn 2>/dev/null || echo 'inactive'").toString().trim();
        if (out !== 'active') {
            return { status: 'offline', pid: 0, uptime: 0, cpu: 0, memory: 0, port: getZivpnPort() };
        }
        const pid = execSync("pgrep -f '[z]ivpn' 2>/dev/null || echo 0").toString().trim();
        const uptimeStr = execSync("systemctl show zivpn -p ActiveEnterTimestamp 2>/dev/null | sed 's/ActiveEnterTimestamp=//' || echo ''").toString().trim();
        let uptime = 0;
        if (uptimeStr) {
            const start = new Date(uptimeStr);
            if (!isNaN(start.getTime())) uptime = Math.floor((Date.now() - start.getTime()) / 1000);
        }
        const memStr = execSync("ps -o rss= -p $(pgrep -f '[z]ivpn' 2>/dev/null | head -1) 2>/dev/null || echo 0").toString().trim();
        const memoryBytes = (parseInt(memStr) || 0) * 1024;

        return {
            status: 'online',
            pid: parseInt(pid) || 0,
            uptime: uptime,
            cpu: 0,
            memory: memoryBytes,
            port: getZivpnPort()
        };
    } catch (e) {
        return { status: 'offline', pid: 0, uptime: 0, cpu: 0, memory: 0, port: getZivpnPort() };
    }
}

function setupNatRules() {
    const iface = getNetworkInterface();
    const zivpnPort = getZivpnPort();
    
    // Commands to safely remove old rules to avoid duplicates
    const cleanRules = [
        `sudo iptables -t nat -D PREROUTING -i ${iface} -p udp --dport 5667 -j ACCEPT 2>/dev/null || true`,
        `sudo iptables -t nat -D PREROUTING -i ${iface} -p udp --dport 6000:19999 -j DNAT --to-destination :5667 2>/dev/null || true`,
        `sudo iptables -t nat -D PREROUTING -i ${iface} -p udp --dport ${zivpnPort} -j ACCEPT 2>/dev/null || true`,
        `sudo iptables -t nat -D PREROUTING -i ${iface} -p udp --dport 6000:19999 -j DNAT --to-destination :${zivpnPort} 2>/dev/null || true`,
        `sudo iptables -t nat -D POSTROUTING -o ${iface} -j MASQUERADE 2>/dev/null || true`
    ];
    
    let cleanedCount = 0;
    const applyRules = () => {
        // Insert ZiVPN ACCEPT rule at position 1
        exec(`sudo iptables -t nat -I PREROUTING 1 -i ${iface} -p udp --dport ${zivpnPort} -j ACCEPT`, () => {
            // Insert ZiVPN port range redirect at position 1 (pushing port to position 2)
            exec(`sudo iptables -t nat -I PREROUTING 1 -i ${iface} -p udp --dport 6000:19999 -j DNAT --to-destination :${zivpnPort}`, () => {
                // Append MASQUERADE in POSTROUTING
                exec(`sudo iptables -t nat -A POSTROUTING -o ${iface} -j MASQUERADE`, () => {
                    console.log(`NAT rules and masquerading configured successfully on interface ${iface} for ZiVPN port ${zivpnPort}`);
                });
            });
        });
    };

    cleanRules.forEach(cmd => {
        exec(cmd, () => {
            cleanedCount++;
            if (cleanedCount === cleanRules.length) {
                applyRules();
            }
        });
    });
}

function trackVpnTraffic() {
    exec("sudo iptables -L OUTPUT -v -n -x", (err, stdout, stderr) => {
        if (err || !stdout) return;
        
        const lines = stdout.split('\n');
        const iptablesData = {};
        
        lines.forEach(line => {
            if (line.includes('vpn_')) {
                const parts = line.trim().split(/\s+/);
                const bytes = parseInt(parts[1]);
                
                const match = line.match(/\/\*\s*vpn_(\S+)\s*\*\//);
                if (match && match[1]) {
                    const username = match[1];
                    iptablesData[username] = bytes;
                }
            }
        });
        
        db.all("SELECT * FROM vpn_users WHERE status = 'active'", (errUsers, users) => {
            if (errUsers || !users) return;
            
            users.forEach(user => {
                const username = user.username;
                const currentBytes = iptablesData[username] || 0;
                const lastBytes = user.last_iptables_bytes || 0;
                
                let delta = 0;
                if (currentBytes >= lastBytes) {
                    delta = currentBytes - lastBytes;
                } else {
                    delta = currentBytes; // iptables reset/reboot
                }
                
                if (delta > 0 || currentBytes !== lastBytes) {
                    const newUsed = user.data_used + delta;
                    
                    let newStatus = user.status;
                    const limitBytes = (user.data_limit_gb || 0) * 1024 * 1024 * 1024;
                    if (user.data_limit_gb > 0 && newUsed >= limitBytes) {
                        newStatus = 'expired';
                        console.log(`User ${username} exceeded data limit. Suspending...`);
                        
                        if (user.protocol === 'zivpn') {
                            syncZivpnUsers(db).catch(console.error);
                        } else {
                            manageSystemUser(username, user.password, 'suspend').catch(console.error);
                        }
                    }
                    
                    db.run("UPDATE vpn_users SET data_used = ?, last_iptables_bytes = ?, status = ? WHERE id = ?", 
                        [newUsed, currentBytes, newStatus, user.id]);
                }
            });
        });
    });
}

function trackUdpCustomTraffic() {
    exec("sudo iptables -L OUTPUT -v -n -x", (err, stdout, stderr) => {
        if (err || !stdout) return;

        const lines = stdout.split('\n');
        const iptablesData = {};

        lines.forEach(line => {
            if (line.includes('vpn_')) {
                const parts = line.trim().split(/\s+/);
                const bytes = parseInt(parts[1]);

                const match = line.match(/\/\*\s*vpn_(\S+)\s*\*\//);
                if (match && match[1]) {
                    iptablesData[match[1]] = bytes;
                }
            }
        });

        db.all("SELECT * FROM udpcustom_accounts WHERE status = 'active'", (errUsers, accounts) => {
            if (errUsers || !accounts) return;

            accounts.forEach(account => {
                const username = account.username;
                const currentBytes = iptablesData[username] || 0;
                const lastBytes = account.last_bytes || 0;

                let delta = 0;
                if (currentBytes >= lastBytes) {
                    delta = currentBytes - lastBytes;
                } else {
                    delta = currentBytes;
                }

                if (delta > 0 || currentBytes !== lastBytes) {
                    const newUsed = account.data_used_mb + (delta / (1024 * 1024));

                    let newStatus = account.status;
                    if (account.data_limit_mb > 0 && newUsed >= account.data_limit_mb) {
                        newStatus = 'expired';
                        console.log(`UDP-Custom user ${username} exceeded data limit. Suspending...`);
                        manageSystemUser(username, account.password, 'suspend').catch(console.error);
                    }

                    db.run("UPDATE udpcustom_accounts SET data_used_mb = ?, last_bytes = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
                        [newUsed, currentBytes, newStatus, account.id]);
                }
            });
        });
    });
}

// Run traffic tracking every 30 seconds
setInterval(trackVpnTraffic, 30 * 1000);
setInterval(trackUdpCustomTraffic, 30 * 1000);

function checkUserExpirations() {
    const today = new Date().toISOString().split('T')[0];
    db.all("SELECT * FROM vpn_users WHERE status = 'active' AND expires_at < ?", [today], async (err, rows) => {
        if (err || !rows) return;
        
        for (const user of rows) {
            console.log(`User ${user.username} expired. Suspending...`);
            db.run("UPDATE vpn_users SET status = 'expired' WHERE id = ?", [user.id], async (errUpdate) => {
                if (errUpdate) return;
                try {
                    if (user.protocol === 'zivpn') {
                        await syncZivpnUsers(db);
                    } else {
                        await manageSystemUser(user.username, user.password, 'suspend');
                    }
                } catch (e) {
                    console.error(`Failed to automatically suspend expired user ${user.username}:`, e);
                }
            });
        }
    });
}

function checkUdpCustomExpirations() {
    const today = new Date().toISOString().split('T')[0];
    db.all("SELECT * FROM udpcustom_accounts WHERE status = 'active' AND expires_at < ?", [today], async (err, rows) => {
        if (err || !rows) return;

        for (const account of rows) {
            console.log(`UDP-Custom user ${account.username} expired. Suspending...`);
            db.run("UPDATE udpcustom_accounts SET status = 'expired', updated_at = datetime('now') WHERE id = ?", [account.id], async (errUpdate) => {
                if (errUpdate) return;
                try {
                    await manageSystemUser(account.username, account.password, 'suspend');
                } catch (e) {
                    console.error(`Failed to auto-suspend expired UDP-Custom user ${account.username}:`, e);
                }
            });
        }
    });
}

// Run expiration check every 10 minutes
setInterval(checkUserExpirations, 10 * 60 * 1000);
setInterval(checkUdpCustomExpirations, 10 * 60 * 1000);

// API Routes for VPN Users
app.get('/api/vpn/users', (req, res) => {
    db.all("SELECT * FROM vpn_users ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

app.post('/api/vpn/users', async (req, res) => {
    const { username, password, protocol, expires_at, max_connections, data_limit_gb } = req.body;
    
    if (!username || !password || !protocol || !expires_at) {
        return res.status(400).json({ error: 'Champs requis manquants.' });
    }
    
    if (protocol !== 'zivpn') {
        return res.status(400).json({ error: 'Protocole invalide. Seul zivpn est accepté ici.' });
    }

    const validUser = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/.test(username);
    if (!validUser) {
        return res.status(400).json({ error: 'Nom d\'utilisateur invalide. Doit commencer par une lettre, contenir uniquement des caractères alphanumériques et faire entre 3 et 20 caractères.' });
    }

    // Insert to DB
    const sql = `INSERT INTO vpn_users (username, password, protocol, expires_at, max_connections, data_limit_gb, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')`;
    const params = [username, password, 'zivpn', expires_at, max_connections || 1, data_limit_gb || 0];

    db.run(sql, params, async function(err) {
        if (err) {
            return res.status(400).json({ error: 'Ce nom d\'utilisateur existe déjà.' });
        }
        
        try {
            await syncZivpnUsers(db);
            res.json({ success: true, id: this.lastID });
        } catch (e) {
            // Rollback insertion if system action fails
            db.run("DELETE FROM vpn_users WHERE id = ?", [this.lastID]);
            res.status(500).json({ error: e.message });
        }
    });
});

app.put('/api/vpn/users/:id', (req, res) => {
    const { id } = req.params;
    const { password, expires_at, max_connections, data_limit_gb, status } = req.body;
    
    db.get("SELECT * FROM vpn_users WHERE id = ?", [id], async (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé.' });
        }
        
        const newPassword = password || user.password;
        const newExpiresAt = expires_at || user.expires_at;
        const newMaxConn = max_connections !== undefined ? max_connections : user.max_connections;
        const newDataLimit = data_limit_gb !== undefined ? data_limit_gb : user.data_limit_gb;
        const newStatus = status || user.status;
        
        const sql = `UPDATE vpn_users 
                     SET password = ?, expires_at = ?, max_connections = ?, data_limit_gb = ?, status = ?
                     WHERE id = ?`;
        
        db.run(sql, [newPassword, newExpiresAt, newMaxConn, newDataLimit, newStatus, id], async (errUpdate) => {
            if (errUpdate) {
                return res.status(500).json({ error: errUpdate.message });
            }
            
            try {
                // Apply password updates or lock/unlock
                if (user.protocol === 'zivpn') {
                    await syncZivpnUsers(db);
                } else {
                    if (newPassword !== user.password) {
                        await manageSystemUser(user.username, newPassword, 'update_password');
                    }
                    if (newStatus !== user.status) {
                        const systemAction = newStatus === 'active' ? 'unsuspend' : 'suspend';
                        await manageSystemUser(user.username, newPassword, systemAction);
                    }
                }
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    });
});

app.delete('/api/vpn/users/:id', (req, res) => {
    const { id } = req.params;
    
    db.get("SELECT * FROM vpn_users WHERE id = ?", [id], async (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé.' });
        }
        
        db.run("DELETE FROM vpn_users WHERE id = ?", [id], async (errDel) => {
            if (errDel) {
                return res.status(500).json({ error: errDel.message });
            }
            
            try {
                if (user.protocol === 'zivpn') {
                    await syncZivpnUsers(db);
                } else {
                    await manageSystemUser(user.username, null, 'delete');
                }
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    });
});

// --- UDP-Custom Account CRUD ---

app.get('/api/udpcustom/accounts', (req, res) => {
    db.all("SELECT * FROM udpcustom_accounts ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/udpcustom/accounts', async (req, res) => {
    const { username, password, host, port, expires_at, device_limit, data_limit_mb } = req.body;

    if (!username || !password || !expires_at) {
        return res.status(400).json({ error: 'Champs requis manquants.' });
    }

    const validUser = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/.test(username);
    if (!validUser) {
        return res.status(400).json({ error: 'Nom d\'utilisateur invalide. Doit commencer par une lettre, contenir uniquement des caractères alphanumériques et faire entre 3 et 20 caractères.' });
    }

    const serverHost = host || '';
    const serverPort = port || 36712;

    db.run(`INSERT INTO udpcustom_accounts (username, password, host, port, expires_at, device_limit, data_limit_mb, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
        [username, password, serverHost, serverPort, expires_at, device_limit || 1, data_limit_mb || 0],
        async function(err) {
            if (err) {
                return res.status(400).json({ error: 'Ce nom d\'utilisateur existe déjà.' });
            }

            try {
                await manageSystemUser(username, password, 'create');
                res.json({ success: true, id: this.lastID });
            } catch (e) {
                db.run("DELETE FROM udpcustom_accounts WHERE id = ?", [this.lastID]);
                res.status(500).json({ error: e.message });
            }
        }
    );
});

app.put('/api/udpcustom/accounts/:id', (req, res) => {
    const { id } = req.params;
    const { password, host, port, expires_at, device_limit, data_limit_mb, status } = req.body;

    db.get("SELECT * FROM udpcustom_accounts WHERE id = ?", [id], async (err, account) => {
        if (err || !account) {
            return res.status(404).json({ error: 'Compte non trouvé.' });
        }

        const newPassword = password || account.password;
        const newHost = host !== undefined ? host : account.host;
        const newPort = port || account.port;
        const newExpiresAt = expires_at || account.expires_at;
        const newDeviceLimit = device_limit !== undefined ? device_limit : account.device_limit;
        const newDataLimit = data_limit_mb !== undefined ? data_limit_mb : account.data_limit_mb;
        const newStatus = status || account.status;

        db.run(`UPDATE udpcustom_accounts SET password = ?, host = ?, port = ?, expires_at = ?, device_limit = ?, data_limit_mb = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
            [newPassword, newHost, newPort, newExpiresAt, newDeviceLimit, newDataLimit, newStatus, id],
            async (errUpdate) => {
                if (errUpdate) {
                    return res.status(500).json({ error: errUpdate.message });
                }

                try {
                    if (newPassword !== account.password) {
                        await manageSystemUser(account.username, newPassword, 'update_password');
                    }
                    if (newStatus !== account.status) {
                        const systemAction = newStatus === 'active' ? 'unsuspend' : 'suspend';
                        await manageSystemUser(account.username, newPassword, systemAction);
                    }
                    res.json({ success: true });
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            }
        );
    });
});

app.delete('/api/udpcustom/accounts/:id', (req, res) => {
    const { id } = req.params;

    db.get("SELECT * FROM udpcustom_accounts WHERE id = ?", [id], async (err, account) => {
        if (err || !account) {
            return res.status(404).json({ error: 'Compte non trouvé.' });
        }

        db.run("DELETE FROM udpcustom_accounts WHERE id = ?", [id], async (errDel) => {
            if (errDel) {
                return res.status(500).json({ error: errDel.message });
            }

            try {
                await manageSystemUser(account.username, null, 'delete');
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    });
});

// State variables for real-time calculation
let lastNetBytes = { rxBytes: 0, txBytes: 0 };
let lastNetTime = Date.now();
let networkSpeed = { incoming: 0, outgoing: 0 };

let lastCpuTimes = { idle: 0, total: 0 };
let cpuUsagePercent = 0;

// Initialize CPU Times
function getCpuTimes() {
    let totalIdle = 0, totalTick = 0;
    const cpus = os.cpus();
    for (let i = 0; i < cpus.length; i++) {
        const cpu = cpus[i];
        for (let type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    }
    return { idle: totalIdle, total: totalTick };
}
lastCpuTimes = getCpuTimes();

// Network bytes reader
function getNetworkBytes() {
    try {
        const data = fs.readFileSync('/proc/net/dev', 'utf8');
        const lines = data.split('\n');
        
        let rxBytes = 0;
        let txBytes = 0;
        let found = false;

        const targetInterface = NETWORK_INTERFACE;
        if (targetInterface) {
            for (let line of lines) {
                if (line.includes(`${targetInterface}:`)) {
                    const parts = line.split(':')[1].trim().split(/\s+/);
                    rxBytes = parseInt(parts[0]) || 0;
                    txBytes = parseInt(parts[8]) || 0;
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            for (let line of lines) {
                if (line.includes('enX0:') || line.includes('eth0:') || line.includes('wlan0:')) {
                    const parts = line.split(':')[1].trim().split(/\s+/);
                    rxBytes = parseInt(parts[0]) || 0;
                    txBytes = parseInt(parts[8]) || 0;
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            for (let line of lines) {
                if (line.includes(':') && !line.includes('lo:')) {
                    const parts = line.split(':')[1].trim().split(/\s+/);
                    const rx = parseInt(parts[0]) || 0;
                    const tx = parseInt(parts[8]) || 0;
                    if (rx > 0 || tx > 0) {
                        rxBytes = rx;
                        txBytes = tx;
                        break;
                    }
                }
            }
        }
        return { rxBytes, txBytes };
    } catch (e) {
        return { rxBytes: 0, txBytes: 0 };
    }
}
lastNetBytes = getNetworkBytes();

// Background monitoring loop (runs every 1 second)
setInterval(() => {
    const now = Date.now();
    const currentNet = getNetworkBytes();
    const timeDelta = (now - lastNetTime) / 1000;
    if (timeDelta > 0) {
        networkSpeed.incoming = Math.max(0, (currentNet.rxBytes - lastNetBytes.rxBytes) / timeDelta);
        networkSpeed.outgoing = Math.max(0, (currentNet.txBytes - lastNetBytes.txBytes) / timeDelta);
    }
    lastNetBytes = currentNet;
    lastNetTime = now;

    const currentCpu = getCpuTimes();
    const idleDifference = currentCpu.idle - lastCpuTimes.idle;
    const totalDifference = currentCpu.total - lastCpuTimes.total;
    if (totalDifference > 0) {
        cpuUsagePercent = Math.min(100, Math.max(0, 100 - Math.floor((100 * idleDifference) / totalDifference)));
    }
    lastCpuTimes = currentCpu;
}, 1000);

// Helper: OS Pretty Name Parser
function getOSPrettyName() {
    try {
        if (fs.existsSync('/etc/os-release')) {
            const data = fs.readFileSync('/etc/os-release', 'utf8');
            const lines = data.split('\n');
            const prettyLine = lines.find(line => line.startsWith('PRETTY_NAME='));
            if (prettyLine) {
                return prettyLine.split('=')[1].replace(/"/g, '').trim();
            }
        }
    } catch (e) {
        // parse error
    }
    return os.type() + ' ' + os.release();
}

// Helper: RAM & Swap
function getMemoryStats() {
    try {
        const out = execSync('free -b').toString();
        const lines = out.split('\n').filter(line => line.trim() !== '');
        const memRow = lines[1].split(/\s+/).filter(Boolean);
        const swapRow = lines[2] ? lines[2].split(/\s+/).filter(Boolean) : [0, 0, 0, 0];
        
        return {
            ram: {
                total: parseInt(memRow[1]) || 0,
                used: parseInt(memRow[2]) || 0,
                free: parseInt(memRow[3]) || 0,
                shared: parseInt(memRow[4]) || 0,
                buffCache: parseInt(memRow[5]) || 0,
                available: parseInt(memRow[6]) || 0
            },
            swap: {
                total: parseInt(swapRow[1]) || 0,
                used: parseInt(swapRow[2]) || 0,
                free: parseInt(swapRow[3]) || 0
            }
        };
    } catch (e) {
        return {
            ram: {
                total: os.totalmem(),
                used: os.totalmem() - os.freemem(),
                free: os.freemem(),
                shared: 0,
                buffCache: 0,
                available: os.freemem()
            },
            swap: { total: 0, used: 0, free: 0 }
        };
    }
}

// Helper: Disk Info
function getDiskStats() {
    try {
        const out = execSync('df -B1 /').toString();
        const lines = out.split('\n').filter(Boolean);
        
        let rootLine = lines.find(line => line.endsWith(' /'));
        if (!rootLine && lines.length > 1) {
            rootLine = lines[1];
        }
        
        if (rootLine) {
            const parts = rootLine.split(/\s+/).filter(Boolean);
            const total = parseInt(parts[1]) || 0;
            const used = parseInt(parts[2]) || 0;
            const free = parseInt(parts[3]) || 0;
            const percent = total > 0 ? Math.round((used / total) * 100) : 0;
            return { total, used, free, percent, available: true };
        }
    } catch (e) {
        // disk error
    }
    return { total: 0, used: 0, free: 0, percent: 0, available: false };
}

// Helper: GPU Info
function getGpuStats() {
    try {
        const out = execSync('nvidia-smi --query-gpu=name,utilization.gpu,memory.total,memory.used --format=csv,noheader,nounits 2>/dev/null').toString();
        const parts = out.split(',');
        if (parts.length >= 4) {
            return {
                available: true,
                model: parts[0].trim(),
                usage: parseInt(parts[1].trim()) || 0,
                vram: {
                    total: (parseInt(parts[2].trim()) || 0) * 1024 * 1024,
                    used: (parseInt(parts[3].trim()) || 0) * 1024 * 1024
                }
            };
        }
    } catch (e) {
        // GPU check error
    }
    return {
        available: false,
        model: 'N/A',
        usage: 0,
        vram: { total: 0, used: 0 }
    };
}

// Helper: vnStat network traffic reader
function getVnstatStats() {
    try {
        const out = execSync('vnstat --json').toString();
        const data = JSON.parse(out);
        
        let iface = data.interfaces.find(i => i.name === NETWORK_INTERFACE);
        if (!iface) {
            iface = data.interfaces.find(i => i.name === 'enX0') || data.interfaces[0];
        }

        if (iface && iface.traffic) {
            const total = iface.traffic.total || { rx: 0, tx: 0 };
            const days = iface.traffic.day || [];
            const today = days[days.length - 1] || { rx: 0, tx: 0 };
            const months = iface.traffic.month || [];
            const month = months[months.length - 1] || { rx: 0, tx: 0 };

            return {
                available: true,
                total: { rxBytes: total.rx || 0, txBytes: total.tx || 0 },
                today: { rxBytes: today.rx || 0, txBytes: today.tx || 0 },
                month: { rxBytes: month.rx || 0, txBytes: month.tx || 0 },
                egressLimitGb: EGRESS_LIMIT_GB
            };
        }
    } catch (e) {
        // vnstat error
    }
    return {
        available: false,
        total: { rxBytes: 0, txBytes: 0 },
        today: { rxBytes: 0, txBytes: 0 },
        month: { rxBytes: 0, txBytes: 0 },
        egressLimitGb: EGRESS_LIMIT_GB
    };
}

const N8N_PM2_NAME = process.env.N8N_PM2_NAME || 'n8n';
const N8N_PORT = process.env.N8N_PORT || 5678;
const UDP_CUSTOM_PORT = process.env.UDP_CUSTOM_PORT || 36712;

// Helper: PM2 bot status
function getBotStats() {
    try {
        const out = execSync('pm2 jlist').toString();
        const processes = JSON.parse(out);
        const bot = processes.find(p => p.name === BOT_PM2_NAME);
        if (bot) {
            return {
                status: bot.pm2_env.status,
                pid: bot.pid,
                uptime: bot.pm2_env.pm_uptime ? Math.floor((Date.now() - bot.pm2_env.pm_uptime) / 1000) : 0,
                restarts: bot.pm2_env.restart_time || 0,
                cpu: bot.monit.cpu || 0,
                memory: bot.monit.memory || 0,
                version: bot.pm2_env.version || 'unknown'
            };
        }
    } catch (e) {
        // PM2 check error
    }
    return { status: 'offline', pid: 0, uptime: 0, restarts: 0, cpu: 0, memory: 0, version: 'N/A' };
}

// Helper: Hermes status
function getHermesStatus() {
    try {
        const out = execSync("pgrep -f '[h]ermes dashboard' 2>/dev/null || true").toString().trim();
        if (!out) return { status: 'offline', pid: 0, uptime: 0, restarts: 0, cpu: 0, memory: 0, tunnelUrl: 'Non disponible', version: 'N/A' };

        const pid = out.split('\n')[0];
        const uptimeStr = execSync(`ps -o etimes= -p ${pid} 2>/dev/null || echo 0`).toString().trim();
        const uptime = parseInt(uptimeStr) || 0;

        const psInfo = execSync(`ps -p ${pid} -o %cpu=,rss= 2>/dev/null || echo "0 0"`).toString().trim().split(/\s+/);
        const cpu = parseFloat(psInfo[0]) || 0;
        const memoryBytes = (parseInt(psInfo[1]) || 0) * 1024;

        let tunnelUrl = 'Non disponible';
        try {
            if (fs.existsSync('/home/ubuntu/.hermes/logs/hermes-tunnel.log')) {
                const log = fs.readFileSync('/home/ubuntu/.hermes/logs/hermes-tunnel.log', 'utf-8');
                const matches = [...log.matchAll(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g)];
                if (matches.length > 0) tunnelUrl = matches[matches.length - 1][0];
            }
        } catch (e) {}

        return {
            status: 'online',
            pid: parseInt(pid),
            uptime: uptime,
            restarts: 0,
            cpu: cpu,
            memory: memoryBytes,
            tunnelUrl: tunnelUrl,
            version: '1.0.0'
        };
    } catch (e) {
        return { status: 'offline', pid: 0, uptime: 0, restarts: 0, cpu: 0, memory: 0, tunnelUrl: 'Non disponible', version: 'N/A' };
    }
}

// Helper: n8n status
function getN8nStatus() {
    let tunnelUrl = '';
    try {
        if (fs.existsSync('/tmp/cf.log')) {
            const log = fs.readFileSync('/tmp/cf.log', 'utf-8');
            const matches = [...log.matchAll(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g)];
            if (matches.length > 0) tunnelUrl = matches[matches.length - 1][0];
        }
    } catch (e) {}

    try {
        const out = execSync('pm2 jlist').toString();
        const processes = JSON.parse(out);
        const n8n = processes.find(p => p.name === N8N_PM2_NAME);
        if (n8n) {
            return {
                status: n8n.pm2_env.status,
                pid: n8n.pid,
                uptime: n8n.pm2_env.pm_uptime ? Math.floor((Date.now() - n8n.pm2_env.pm_uptime) / 1000) : 0,
                restarts: n8n.pm2_env.restart_time || 0,
                cpu: n8n.monit.cpu || 0,
                memory: n8n.monit.memory || 0,
                port: N8N_PORT,
                tunnelUrl: tunnelUrl,
                version: n8n.pm2_env.version || 'unknown'
            };
        }
    } catch (e) {}

    // Fallback: check via Docker
    try {
        execSync("docker ps --filter name=^/n8n$ --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q .").toString();
        return {
            status: 'online',
            pid: 0,
            uptime: 0,
            restarts: 0,
            cpu: 0,
            memory: 0,
            port: N8N_PORT,
            tunnelUrl: tunnelUrl,
            version: 'N/A'
        };
    } catch (e) {}

    try {
        execSync(`ss -tlnp | grep -q ':${N8N_PORT} '`).toString();
        return {
            status: 'online',
            pid: 0,
            uptime: 0,
            restarts: 0,
            cpu: 0,
            memory: 0,
            port: N8N_PORT,
            tunnelUrl: tunnelUrl,
            version: 'N/A'
        };
    } catch (e) {}

    return { status: 'offline', pid: 0, uptime: 0, restarts: 0, cpu: 0, memory: 0, port: N8N_PORT, tunnelUrl: '', version: 'N/A' };
}

// Helper: UDP-Custom status
function getUdpCustomStatus() {
    try {
        const out = execSync("systemctl is-active udp-custom 2>/dev/null || echo 'inactive'").toString().trim();
        if (out !== 'active') {
            return { status: 'offline', pid: 0, uptime: 0, cpu: 0, memory: 0, port: UDP_CUSTOM_PORT };
        }
        const pid = execSync("pgrep -f '[u]dp-custom' 2>/dev/null || echo 0").toString().trim();
        const uptimeStr = execSync("systemctl show udp-custom -p ActiveEnterTimestamp 2>/dev/null | sed 's/ActiveEnterTimestamp=//' || echo ''").toString().trim();
        let uptime = 0;
        if (uptimeStr) {
            const start = new Date(uptimeStr);
            if (!isNaN(start.getTime())) uptime = Math.floor((Date.now() - start.getTime()) / 1000);
        }
        const memStr = execSync("ps -o rss= -p $(pgrep -f '[u]dp-custom' 2>/dev/null | head -1) 2>/dev/null || echo 0").toString().trim();
        const memoryBytes = (parseInt(memStr) || 0) * 1024;

        return {
            status: 'online',
            pid: parseInt(pid) || 0,
            uptime: uptime,
            cpu: 0,
            memory: memoryBytes,
            port: UDP_CUSTOM_PORT
        };
    } catch (e) {
        return { status: 'offline', pid: 0, uptime: 0, cpu: 0, memory: 0, port: UDP_CUSTOM_PORT };
    }
}

const homeDir = os.homedir();
const N8N_LOG_PATH = process.env.N8N_LOG_PATH || `${homeDir}/.pm2/logs/n8n-out.log`;
const N8N_ERR_PATH = process.env.N8N_ERR_PATH || `${homeDir}/.pm2/logs/n8n-error.log`;

// Helper: n8n logs
function getN8nLogs() {
    try {
        const out = fs.existsSync(N8N_LOG_PATH) ? execSync(`tail -n 100 ${N8N_LOG_PATH}`).toString() : 'Logs n8n introuvables.';
        const err = fs.existsSync(N8N_ERR_PATH) ? execSync(`tail -n 100 ${N8N_ERR_PATH}`).toString() : 'Logs d\'erreur n8n introuvables.';
        return { out, err };
    } catch (e) {
        return { out: 'Impossible de charger les logs n8n.', err: 'Impossible de charger les logs d\'erreur n8n.' };
    }
}

// Helper: get logs
function getBotLogs() {
    try {
        let out = '';
        let err = '';
        
        if (fs.existsSync(BOT_LOGS_OUT_PATH)) {
            out = execSync(`tail -n 100 ${BOT_LOGS_OUT_PATH}`).toString();
        } else {
            out = `Logs standard introuvables au chemin: ${BOT_LOGS_OUT_PATH}`;
        }
        
        if (fs.existsSync(BOT_LOGS_ERR_PATH)) {
            err = execSync(`tail -n 100 ${BOT_LOGS_ERR_PATH}`).toString();
        } else {
            err = `Logs d'erreur introuvables au chemin: ${BOT_LOGS_ERR_PATH}`;
        }
        
        return { out, err };
    } catch (e) {
        return { out: 'Impossible de charger les journaux standard.', err: 'Impossible de charger les journaux d\'erreur.' };
    }
}

// Endpoints
let cachedPublicIp = null;

function getLocalIp() {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
    } catch (e) {}
    return '127.0.0.1';
}

function getServerIp() {
    return cachedPublicIp || getLocalIp();
}

// Fetch public IP at startup and cache it
(function fetchPublicIp() {
    exec('curl -s --max-time 5 https://api.ipify.org', (err, stdout) => {
        if (!err && stdout && /^\d+\.\d+\.\d+\.\d+$/.test(stdout.trim())) {
            cachedPublicIp = stdout.trim();
            console.log(`Public IP detected: ${cachedPublicIp}`);
        } else {
            console.log(`Public IP not available, using local IP: ${getLocalIp()}`);
        }
    });
})();

app.get('/api/stats', (req, res) => {
    const mem = getMemoryStats();
    const disk = getDiskStats();
    const gpu = getGpuStats();
    const vnstat = getVnstatStats();
    const bot = getBotStats();
    const n8nStatus = getN8nStatus();

    res.json({
        host: getServerIp(),
        hostname: os.hostname(),
        platform: os.platform(),
        osName: getOSPrettyName(),
        kernel: os.release(),
        arch: os.arch(),
        uptime: Math.floor(os.uptime()),
        cpu: {
            usage: cpuUsagePercent,
            cores: os.cpus().length,
            model: os.cpus()[0]?.model || 'Unknown'
        },
        memory: mem,
        disk: disk,
        gpu: gpu,
        network: {
            speed: networkSpeed,
            vnstat: vnstat
        },
        bot: bot,
        hermes: getHermesStatus(),
        n8n: n8nStatus,
        udpcustom: getUdpCustomStatus(),
        zivpn: getZivpnStatus()
    });
});

app.get('/api/bot/logs', (req, res) => {
    res.json(getBotLogs());
});

app.post('/api/bot/control', (req, res) => {
    const { action } = req.body;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Action invalide. Doit être start, stop, ou restart.' });
    }
    
    exec(`pm2 ${action} ${BOT_PM2_NAME}`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: error.message, details: stderr });
        }
        res.json({ success: true, output: stdout });
    });
});

app.get('/api/n8n/logs', (req, res) => {
    res.json(getN8nLogs());
});

function controlN8n(action) {
    return new Promise((resolve, reject) => {
        if (action === 'stop') {
            exec('/usr/bin/pkill -f "[c]loudflared.*localhost:5678" 2>/dev/null; /usr/bin/docker rm -f n8n 2>/dev/null; true', (err, stdout, stderr) => {
                resolve({ success: true, output: 'n8n arrêté' });
            });
        } else if (action === 'start') {
            exec('/usr/bin/docker run -d --name n8n --restart always -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n', (err1, out1, err1s) => {
                if (err1) return reject(new Error(err1s || err1.message));
                const homeDir = os.homedir();
                const tunnelCmd = `cd ${homeDir} && nohup ./cloudflared tunnel --url http://localhost:5678 > /tmp/cf.log 2>&1 &`;
                exec(tunnelCmd, (err2, out2, err2s) => {
                    if (err2) return reject(new Error(err2s || err2.message));
                    resolve({ success: true, output: 'n8n démarré' });
                });
            });
        } else if (action === 'restart') {
            controlN8n('stop').then(() => controlN8n('start')).then(resolve).catch(reject);
        }
    });
}

app.post('/api/n8n/control', (req, res) => {
    const { action } = req.body;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Action invalide. Doit être start, stop, ou restart.' });
    }
    controlN8n(action).then(result => res.json(result)).catch(err => res.status(500).json({ error: err.message }));
});

// Helper: Hermes control
function controlHermes(action) {
    return new Promise((resolve, reject) => {
        if (action === 'stop') {
            exec('pkill -f "[c]loudflared.*127.0.0.1:9119" 2>/dev/null; pkill -f "[h]ermes dashboard" 2>/dev/null; true', (err, stdout, stderr) => {
                resolve({ success: true, output: 'Hermes arrêté' });
            });
        } else         if (action === 'start') {
            const hermesDir = '/home/ubuntu/.hermes/hermes-agent';
            exec(`cd ${hermesDir} && nohup venv/bin/hermes dashboard --no-open --host 0.0.0.0 --port 9119 > /dev/null 2>&1 &`, (err1, out1, err1s) => {
                if (err1) return reject(new Error(err1s || err1.message));
                setTimeout(() => {
                    const tunnelCmd = 'nohup /home/ubuntu/cloudflared tunnel --url http://127.0.0.1:9119 --logfile /home/ubuntu/.hermes/logs/hermes-tunnel.log --loglevel info > /dev/null 2>&1 &';
                    exec(tunnelCmd, (err2, out2, err2s) => {
                        if (err2) return reject(new Error(err2s || err2.message));
                        resolve({ success: true, output: 'Hermes démarré' });
                    });
                }, 3000);
            });
        } else if (action === 'restart') {
            controlHermes('stop').then(() => controlHermes('start')).then(resolve).catch(reject);
        }
    });
}

app.post('/api/hermes/control', (req, res) => {
    const { action } = req.body;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Action invalide. Doit être start, stop, ou restart.' });
    }
    controlHermes(action).then(result => res.json(result)).catch(err => res.status(500).json({ error: err.message }));
});

// UDP-Custom control
function controlUdpCustom(action) {
    return new Promise((resolve, reject) => {
        const cmd = action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart';
        exec(`sudo systemctl ${cmd} udp-custom`, (error, stdout, stderr) => {
            if (error) return reject(new Error(stderr || error.message));
            resolve({ success: true, output: `UDP-Custom ${action === 'start' ? 'démarré' : action === 'stop' ? 'arrêté' : 'relancé'}` });
        });
    });
}

app.post('/api/udp/control', (req, res) => {
    const { action } = req.body;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Action invalide. Doit être start, stop, ou restart.' });
    }
    controlUdpCustom(action).then(result => res.json(result)).catch(err => res.status(500).json({ error: err.message }));
});

// ZiVPN control
function controlZivpn(action) {
    return new Promise((resolve, reject) => {
        const cmd = action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart';
        exec(`sudo systemctl ${cmd} zivpn`, (error, stdout, stderr) => {
            if (error) return reject(new Error(stderr || error.message));
            resolve({ success: true, output: `ZiVPN ${action === 'start' ? 'démarré' : action === 'stop' ? 'arrêté' : 'relancé'}` });
        });
    });
}

app.post('/api/zivpn/control', (req, res) => {
    const { action } = req.body;
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Action invalide. Doit être start, stop, ou restart.' });
    }
    controlZivpn(action).then(result => res.json(result)).catch(err => res.status(500).json({ error: err.message }));
});

app.listen(PORT, () => {
    console.log(`Dashboard backend listening on port ${PORT}`);
});
