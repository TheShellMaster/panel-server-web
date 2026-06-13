require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Database & Config paths ---
const DB_PATH = process.env.DATABASE_PATH || './database.db';
const ZIVPN_CONFIG_PATH = process.env.ZIVPN_CONFIG_PATH || '/etc/zivpn/config.json';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const BOT_PM2_NAME = process.env.BOT_PM2_NAME || 'whatsapp-bot';
const BOT_LOGS_OUT_PATH = process.env.BOT_LOGS_OUT_PATH || '/home/ubuntu/.pm2/logs/whatsapp-bot-out.log';
const BOT_LOGS_ERR_PATH = process.env.BOT_LOGS_ERR_PATH || '/home/ubuntu/.pm2/logs/whatsapp-bot-error.log';
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
        db.run(`CREATE TABLE IF NOT EXISTS vpn_users (
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
        });
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
                if (fs.existsSync(ZIVPN_CONFIG_PATH)) {
                    config = JSON.parse(fs.readFileSync(ZIVPN_CONFIG_PATH, 'utf8'));
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
                
                const createCmd = userExists 
                    ? `sudo usermod -s /bin/false -g vpnusers ${username} && echo "${username}:${password}" | sudo chpasswd`
                    : `sudo useradd -M -s /bin/false -g vpnusers ${username} && echo "${username}:${password}" | sudo chpasswd`;
                
                exec(createCmd, (errCreate, stdoutCreate, stderrCreate) => {
                    if (errCreate) return reject(new Error(`Échec de création de l'utilisateur : ${stderrCreate || errCreate.message}`));
                    
                    // Add iptables accounting rule
                    exec(`sudo iptables -D OUTPUT -m owner --uid-owner ${username} -m comment --comment "vpn_${username}"`, () => {
                        exec(`sudo iptables -A OUTPUT -m owner --uid-owner ${username} -m comment --comment "vpn_${username}"`, () => {
                            resolve();
                        });
                    });
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
            exec(`echo "${username}:${password}" | sudo chpasswd`, (errPass, stdoutPass, stderrPass) => {
                if (errPass) return reject(new Error(`Échec de mise à jour du mot de passe : ${stderrPass || errPass.message}`));
                resolve();
            });
        } else {
            reject(new Error('Action inconnue pour l\'utilisateur système'));
        }
    });
}

function initIptablesRules() {
    db.all("SELECT username, protocol FROM vpn_users WHERE status = 'active' AND protocol IN ('udpcustom', 'fastdns')", (err, rows) => {
        if (err || !rows) return;
        
        rows.forEach(user => {
            // Clean and add rules on startup
            exec(`sudo iptables -D OUTPUT -m owner --uid-owner ${user.username} -m comment --comment "vpn_${user.username}"`, () => {
                exec(`sudo iptables -A OUTPUT -m owner --uid-owner ${user.username} -m comment --comment "vpn_${user.username}"`);
            });
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

// Run traffic tracking every 30 seconds
setInterval(trackVpnTraffic, 30 * 1000);

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

// Run expiration check every 10 minutes
setInterval(checkUserExpirations, 10 * 60 * 1000);

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
    
    if (!['zivpn', 'udpcustom', 'fastdns'].includes(protocol)) {
        return res.status(400).json({ error: 'Protocole invalide.' });
    }

    const validUser = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/.test(username);
    if (!validUser) {
        return res.status(400).json({ error: 'Nom d\'utilisateur invalide. Doit commencer par une lettre, contenir uniquement des caractères alphanumériques et faire entre 3 et 20 caractères.' });
    }

    // Insert to DB
    const sql = `INSERT INTO vpn_users (username, password, protocol, expires_at, max_connections, data_limit_gb, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')`;
    const params = [username, password, protocol, expires_at, max_connections || 1, data_limit_gb || 0];

    db.run(sql, params, async function(err) {
        if (err) {
            return res.status(400).json({ error: 'Ce nom d\'utilisateur existe déjà.' });
        }
        
        try {
            if (protocol === 'zivpn') {
                await syncZivpnUsers(db);
            } else {
                await manageSystemUser(username, password, 'create');
            }
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
app.get('/api/stats', (req, res) => {
    const mem = getMemoryStats();
    const disk = getDiskStats();
    const gpu = getGpuStats();
    const vnstat = getVnstatStats();
    const bot = getBotStats();
    
    res.json({
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
        bot: bot
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

app.listen(PORT, () => {
    console.log(`Dashboard backend listening on port ${PORT}`);
});
