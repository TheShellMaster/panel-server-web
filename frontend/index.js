document.addEventListener('DOMContentLoaded', () => {
    const API_URL = ''; 

    // Theme Toggle Logic
    const btnThemeToggle = document.getElementById('theme-toggle');
    const currentTheme = localStorage.getItem('theme');

    if (currentTheme === 'light') {
        document.body.classList.add('light-mode');
    }

    btnThemeToggle.addEventListener('click', () => {
        document.body.classList.toggle('light-mode');
        
        let theme = 'dark';
        if (document.body.classList.contains('light-mode')) {
            theme = 'light';
        }
        localStorage.setItem('theme', theme);
    });

    // Spawn Animated Floating Bubbles in the Background
    createFloatingObjects();

    // Sidebar Navigation Switching
    const menuItems = document.querySelectorAll('.menu-item');
    const appSections = document.querySelectorAll('.app-section');
    const sidebar = document.getElementById('sidebar');
    const menuTrigger = document.getElementById('menu-trigger');
    const sidebarOverlay = document.getElementById('sidebar-overlay');

    menuItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Remove active from all items
            menuItems.forEach(i => i.classList.remove('active'));
            // Add active to current
            item.classList.add('active');
            
            // Hide all sections
            appSections.forEach(sec => {
                sec.style.display = 'none';
                sec.classList.remove('active');
            });
            
            // Show target section
            const targetId = item.getAttribute('data-target');
            const targetSec = document.getElementById(targetId);
            if (targetSec) {
                targetSec.style.display = 'block';
                setTimeout(() => targetSec.classList.add('active'), 10);
            }
            
            // Close sidebar on mobile
            if (window.innerWidth <= 768 && sidebar) {
                sidebar.classList.remove('open');
                if (sidebarOverlay) sidebarOverlay.classList.remove('show');
            }
        });
    });

    // Mobile Hamburger Menu Trigger
    if (menuTrigger) {
        menuTrigger.addEventListener('click', () => {
            if (sidebar) {
                sidebar.classList.toggle('open');
                if (sidebarOverlay) {
                    if (sidebar.classList.contains('open')) {
                        sidebarOverlay.classList.add('show');
                    } else {
                        sidebarOverlay.classList.remove('show');
                    }
                }
            }
        });
    }

    // Close sidebar when clicking on overlay
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
            if (sidebar) sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('show');
        });
    }

    // Close sidebar when clicking on sidebar close button
    const sidebarClose = document.getElementById('sidebar-close');
    if (sidebarClose) {
        sidebarClose.addEventListener('click', () => {
            if (sidebar) sidebar.classList.remove('open');
            if (sidebarOverlay) sidebarOverlay.classList.remove('show');
        });
    }

    // Close sidebar when clicking outside on mobile
    document.addEventListener('click', (e) => {
        if (window.innerWidth <= 768 && sidebar && menuTrigger) {
            if (!sidebar.contains(e.target) && !menuTrigger.contains(e.target) && sidebar.classList.contains('open')) {
                sidebar.classList.remove('open');
                if (sidebarOverlay) sidebarOverlay.classList.remove('show');
            }
        }
    });

    // Cache DOM Elements
    const elUptime = document.getElementById('uptime');
    const elPlatform = document.getElementById('platform');
    const elHostname = document.getElementById('hostname');
    
    // System Info Card
    const elSysOsName = document.getElementById('sys-os-name');
    const elSysKernel = document.getElementById('sys-kernel');
    const elSysArch = document.getElementById('sys-arch');
    const elSysHostname = document.getElementById('sys-hostname');
    const elSysUptime = document.getElementById('sys-uptime');
    
    // CPU
    const elCpuPercent = document.getElementById('cpu-percent');
    const elCpuModel = document.getElementById('cpu-model');
    const elCpuCores = document.getElementById('cpu-cores');
    const elCpuCircle = document.getElementById('cpu-circle');
    
    // RAM
    const elRamPercent = document.getElementById('ram-percent');
    const elRamUsed = document.getElementById('ram-used');
    const elRamTotal = document.getElementById('ram-total');
    const elRamBuff = document.getElementById('ram-buff');
    const elRamCircle = document.getElementById('ram-circle');
    
    // Swap (Dedicated)
    const elSwapPercent = document.getElementById('swap-percent');
    const elSwapCircle = document.getElementById('swap-circle');
    const elSwapUsed = document.getElementById('swap-used');
    const elSwapTotal = document.getElementById('swap-total');
    const elSwapStatus = document.getElementById('swap-status');

    // Storage (Disk)
    const elDiskPercent = document.getElementById('disk-percent');
    const elDiskCircle = document.getElementById('disk-circle');
    const elDiskUsed = document.getElementById('disk-used');
    const elDiskTotal = document.getElementById('disk-total');
    const elDiskFree = document.getElementById('disk-free');

    // GPU
    const elGpuPercent = document.getElementById('gpu-percent');
    const elGpuCircle = document.getElementById('gpu-circle');
    const elGpuModel = document.getElementById('gpu-model');
    const elGpuVram = document.getElementById('gpu-vram');
    const elGpuStatus = document.getElementById('gpu-status');
    
    // Network Speeds
    const elNetSpeedIn = document.getElementById('net-speed-in');
    const elNetSpeedOut = document.getElementById('net-speed-out');
    
    // Network vnStat
    const elNetTodayIn = document.getElementById('net-today-in');
    const elNetMonthIn = document.getElementById('net-month-in');
    const elNetTotalIn = document.getElementById('net-total-in');
    
    const elNetTodayOut = document.getElementById('net-today-out');
    const elNetMonthOut = document.getElementById('net-month-out');
    const elNetTotalOut = document.getElementById('net-total-out');

    // AWS Quota Progress
    const elQuotaPercent = document.getElementById('quota-percent');
    const elQuotaBar = document.getElementById('quota-bar');
    const elQuotaUsed = document.getElementById('quota-used');
    
    // Bot
    const elBotStatus = document.getElementById('bot-status');
    const elBotPid = document.getElementById('bot-pid');
    const elBotUptime = document.getElementById('bot-uptime');
    const elBotRestarts = document.getElementById('bot-restarts');
    const elBotMemory = document.getElementById('bot-memory');
    const elBotCpu = document.getElementById('bot-cpu');
    const elBotVersion = document.getElementById('bot-version');
    
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    const btnRestart = document.getElementById('btn-restart');
    
    const terminal = document.getElementById('terminal');
    const tabStdout = document.getElementById('tab-stdout');
    const tabStderr = document.getElementById('tab-stderr');
    
    let activeLogTab = 'stdout';
    let logsCache = { stdout: '', stderr: '' };
    let isFetchingLogs = false;

    // Helper functions
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0 || !bytes) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function formatSpeed(bytesPerSec) {
        if (bytesPerSec === 0 || !bytesPerSec) return '0 KB/s';
        const k = 1024;
        const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
        const dec = i >= 2 ? 1 : 0;
        return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(dec)) + ' ' + sizes[i];
    }

    function formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '0s';
        const d = Math.floor(seconds / (3600*24));
        const h = Math.floor((seconds % (3600*24)) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        
        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        if (s > 0 || parts.length === 0) parts.push(`${s}s`);
        return parts.join(' ');
    }

    function setCircleProgress(circle, percentage) {
        if (!circle) return;
        const radius = circle.r.baseVal.value;
        const circumference = radius * 2 * Math.PI;
        circle.style.strokeDasharray = `${circumference} ${circumference}`;
        
        const offset = circumference - (percentage / 100) * circumference;
        circle.style.strokeDashoffset = offset;
    }

    // Floating Background Generator (SVG Icons representing Server Monitoring, VPN & WhatsApp Bot)
    function createFloatingObjects() {
        const container = document.createElement('div');
        container.className = 'bg-bubble-container';
        document.body.appendChild(container);

        const iconSvgs = [
            // Server rack
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
            // Shield (VPN security)
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`,
            // Key (Authentication)
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path><circle cx="7.5" cy="16.5" r="1.5" fill="currentColor"></circle></svg>`,
            // Chat bubble (WhatsApp Bot)
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
            // CPU (Monitoring)
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="15" x2="23" y2="15"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="15" x2="4" y2="15"></line></svg>`,
            // Globe (Network bandwidth)
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.05" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
            // Activity (Pulse chart)
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
            // Terminal (Live Logs)
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.08" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
            // Robot (Automated Bot assistant)
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><line x1="12" y1="7" x2="12" y2="11"></line><line x1="9" y1="16" x2="15" y2="16"></line><line x1="8" y1="12" x2="8" y2="12.01"></line><line x1="16" y1="12" x2="16" y2="12.01"></line></svg>`,
            // Cloud (Infrastructure/AWS)
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>`,
            // Database
            `<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:100%; height:100%;"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"></path></svg>`
        ];

        const colors = [
            '#ff3b30',   // cpu red
            '#00f0ff',   // ram cyan
            '#cc00ff',   // swap magenta
            '#3b82f6',   // disk blue
            '#39ff14',   // gpu nvidia-green
            '#6366f1'    // accent indigo
        ];

        for (let i = 0; i < 38; i++) { // Increased count to 38 for a richer environment
            const shape = document.createElement('div');
            const color = colors[Math.floor(Math.random() * colors.length)];
            
            // Much larger size range: 25px to 105px
            const size = Math.random() * 80 + 25; 
            
            shape.className = `floating-object`;
            shape.style.width = `${size}px`;
            shape.style.height = `${size}px`;
            shape.style.left = `${Math.random() * 100}%`;
            shape.style.bottom = `-120px`; // push lower for larger icons
            shape.style.color = color;
            
            // Adjust glowing blur radius based on size: larger icons glow wider
            const glowRadius = Math.max(6, Math.round(size * 0.16));
            shape.style.filter = `drop-shadow(0 0 ${glowRadius}px ${color}55)`;
            
            // Apply scale-dependent opacity for parallax depth (smaller = further & more translucent)
            const scaleOpacity = (size / 105) * 0.55 + 0.45;
            shape.style.opacity = scaleOpacity;

            // Inject a random themed SVG icon
            const randomSvg = iconSvgs[Math.floor(Math.random() * iconSvgs.length)];
            shape.innerHTML = randomSvg;

            // Calculate duration based on size: smaller icons move slower, larger move faster
            const duration = ((105 - size) * 0.4) + Math.random() * 10 + 10; // 10s to 42s range
            const delay = Math.random() * 30; // up to 30s delay to spread them out
            
            shape.style.animationDuration = `${duration}s`;
            shape.style.animationDelay = `${delay}s`;
            
            container.appendChild(shape);
        }
    }

    // Update Dashboard UI
    function updateDashboard(data) {
        // System Meta
        elUptime.textContent = formatDuration(data.uptime);
        elPlatform.textContent = `${data.platform || 'Linux'}`;
        elHostname.textContent = data.hostname || 'unknown';

        // System Info Card
        if (elSysOsName) elSysOsName.textContent = data.osName || '--';
        if (elSysKernel) elSysKernel.textContent = data.kernel || '--';
        if (elSysArch) elSysArch.textContent = data.arch || '--';
        if (elSysHostname) elSysHostname.textContent = data.hostname || '--';
        if (elSysUptime) elSysUptime.textContent = formatDuration(data.uptime) || '--';

        // CPU
        const cpuVal = data.cpu.usage;
        elCpuPercent.textContent = `${cpuVal}%`;
        elCpuModel.textContent = data.cpu.model;
        elCpuModel.title = data.cpu.model;
        elCpuCores.textContent = `${data.cpu.cores} Cores`;
        setCircleProgress(elCpuCircle, cpuVal);

        // RAM Memory
        const ram = data.memory.ram;
        const ramTotal = ram.total;
        const ramUsed = ram.used;
        const ramPercent = ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0;
        
        elRamPercent.textContent = `${ramPercent}%`;
        elRamUsed.textContent = formatBytes(ramUsed, 1);
        elRamTotal.textContent = formatBytes(ramTotal, 1);
        elRamBuff.textContent = formatBytes(ram.buffCache, 1);
        setCircleProgress(elRamCircle, ramPercent);

        // Swap Memory (Dedicated Card)
        const swap = data.memory.swap;
        const swapTotal = swap.total;
        const swapUsed = swap.used;
        const swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;
        
        if (swapTotal > 0) {
            elSwapPercent.textContent = `${swapPercent}%`;
            setCircleProgress(elSwapCircle, swapPercent);
            elSwapUsed.textContent = formatBytes(swapUsed, 1);
            elSwapTotal.textContent = formatBytes(swapTotal, 1);
            elSwapStatus.textContent = 'Détecté';
            elSwapStatus.style.color = 'var(--color-success)';
        } else {
            elSwapPercent.textContent = '0%';
            setCircleProgress(elSwapCircle, 0);
            elSwapUsed.textContent = '0 Bytes';
            elSwapTotal.textContent = '0 Bytes';
            elSwapStatus.textContent = 'Non détecté';
            elSwapStatus.style.color = 'var(--color-danger)';
        }

        // Storage (Disk)
        if (data.disk && data.disk.available) {
            const diskPercent = data.disk.percent;
            elDiskPercent.textContent = `${diskPercent}%`;
            setCircleProgress(elDiskCircle, diskPercent);
            elDiskUsed.textContent = formatBytes(data.disk.used, 1);
            elDiskTotal.textContent = formatBytes(data.disk.total, 1);
            elDiskFree.textContent = formatBytes(data.disk.free, 1);
        } else {
            elDiskPercent.textContent = 'N/A';
            setCircleProgress(elDiskCircle, 0);
            elDiskUsed.textContent = 'N/A';
            elDiskTotal.textContent = 'N/A';
            elDiskFree.textContent = 'N/A';
        }

        // GPU
        const gpu = data.gpu;
        if (gpu && gpu.available) {
            elGpuPercent.textContent = `${gpu.usage}%`;
            setCircleProgress(elGpuCircle, gpu.usage);
            elGpuModel.textContent = gpu.model;
            elGpuModel.title = gpu.model;
            elGpuVram.textContent = `${formatBytes(gpu.vram.used, 0)} / ${formatBytes(gpu.vram.total, 0)}`;
            elGpuStatus.textContent = 'Disponible';
            elGpuStatus.style.color = 'var(--color-success)';
        } else {
            elGpuPercent.textContent = '0%';
            setCircleProgress(elGpuCircle, 0);
            elGpuModel.textContent = 'N/A';
            elGpuModel.title = 'N/A';
            elGpuVram.textContent = '0 B / 0 B';
            elGpuStatus.textContent = 'Non détecté';
            elGpuStatus.style.color = 'var(--color-danger)';
        }

        // Network Speed
        elNetSpeedIn.textContent = formatSpeed(data.network.speed.incoming);
        elNetSpeedOut.textContent = formatSpeed(data.network.speed.outgoing);

        // Network vnStat Persistent Totals
        const vns = data.network.vnstat;
        if (vns && vns.available) {
            elNetTodayIn.textContent = formatBytes(vns.today.rxBytes, 1);
            elNetMonthIn.textContent = formatBytes(vns.month.rxBytes, 1);
            elNetTotalIn.textContent = formatBytes(vns.total.rxBytes, 1);
            
            elNetTodayOut.textContent = formatBytes(vns.today.txBytes, 1);
            elNetMonthOut.textContent = formatBytes(vns.month.txBytes, 1);
            elNetTotalOut.textContent = formatBytes(vns.total.txBytes, 1);

            // AWS Monthly Egress Quota (100 GB Limit tracking on transmit/outgoing)
            const outBytes = vns.month.txBytes || 0;
            const quotaLimitBytes = 100 * 1024 * 1024 * 1024; // 100 GB in bytes
            const quotaPercent = Math.min(100, parseFloat(((outBytes / quotaLimitBytes) * 100).toFixed(2)));
            
            elQuotaPercent.textContent = `${quotaPercent}%`;
            elQuotaBar.style.width = `${quotaPercent}%`;
            elQuotaUsed.textContent = formatBytes(outBytes, 2);
        } else {
            elNetTodayIn.textContent = 'N/A';
            elNetMonthIn.textContent = 'N/A';
            elNetTotalIn.textContent = 'N/A';
            
            elNetTodayOut.textContent = 'N/A';
            elNetMonthOut.textContent = 'N/A';
            elNetTotalOut.textContent = 'N/A';

            elQuotaPercent.textContent = 'N/A';
            elQuotaBar.style.width = '0%';
            elQuotaUsed.textContent = 'N/A';
        }

        // Bot Status
        const bot = data.bot;
        elBotStatus.textContent = bot.status;
        elBotStatus.className = 'badge';
        
        if (bot.status === 'online') {
            elBotStatus.classList.add('online');
            btnStart.disabled = true;
            btnStop.disabled = false;
            btnRestart.disabled = false;
        } else if (bot.status === 'stopped' || bot.status === 'offline') {
            elBotStatus.classList.add('offline');
            btnStart.disabled = false;
            btnStop.disabled = true;
            btnRestart.disabled = true;
        } else {
            elBotStatus.classList.add('warning');
            btnStart.disabled = false;
            btnStop.disabled = false;
            btnRestart.disabled = false;
        }

        elBotPid.textContent = bot.pid || 'N/A';
        elBotUptime.textContent = bot.uptime ? formatDuration(bot.uptime) : 'N/A';
        elBotRestarts.textContent = bot.restarts ?? 0;
        elBotMemory.textContent = bot.memory ? formatBytes(bot.memory, 1) : '0 B';
        elBotCpu.textContent = bot.cpu ? `${bot.cpu}%` : '0%';
        elBotVersion.textContent = bot.version || 'N/A';
    }

    // Fetch Stats
    async function fetchStats() {
        try {
            const res = await fetch(`${API_URL}/api/stats`);
            if (!res.ok) throw new Error('Network response not ok');
            const data = await res.json();
            updateDashboard(data);
        } catch (e) {
            console.error('Error fetching system stats:', e);
            elBotStatus.textContent = 'unreachable';
            elBotStatus.className = 'badge offline';
            btnStart.disabled = true;
            btnStop.disabled = true;
            btnRestart.disabled = true;
        }
    }

    // Fetch Logs
    async function fetchLogs() {
        if (isFetchingLogs) return;
        isFetchingLogs = true;
        try {
            const res = await fetch(`${API_URL}/api/bot/logs`);
            if (!res.ok) throw new Error('Network response not ok');
            const data = await res.json();
            logsCache.stdout = data.out || 'Aucune sortie console disponible.';
            logsCache.stderr = data.err || 'Aucune erreur enregistrée.';
            renderLogs();
        } catch (e) {
            console.error('Error fetching logs:', e);
            terminal.textContent = 'Erreur lors du chargement des logs.';
        } finally {
            isFetchingLogs = false;
        }
    }

    // Render Logs
    function renderLogs() {
        const text = activeLogTab === 'stdout' ? logsCache.stdout : logsCache.stderr;
        const isScrolledToBottom = terminal.scrollHeight - terminal.clientHeight <= terminal.scrollTop + 50;
        
        if (activeLogTab === 'stderr') {
            terminal.innerHTML = text.split('\n').map(line => {
                return `<div class="log-line error">${escapeHTML(line)}</div>`;
            }).join('');
        } else {
            terminal.innerHTML = text.split('\n').map(line => {
                const isErrLine = line.toLowerCase().includes('error') || line.includes('❌');
                const isSuccessLine = line.toLowerCase().includes('success') || line.includes('✅');
                let className = '';
                if (isErrLine) className = 'error';
                else if (isSuccessLine) className = 'success';
                return `<div class="log-line ${className}">${escapeHTML(line)}</div>`;
            }).join('');
        }
        
        if (isScrolledToBottom) {
            terminal.scrollTop = terminal.scrollHeight;
        }
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }

    // Bot Control
    async function controlBot(action) {
        btnStart.disabled = true;
        btnStop.disabled = true;
        btnRestart.disabled = true;
        
        try {
            const res = await fetch(`${API_URL}/api/bot/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Action failed');
            
            setTimeout(fetchStats, 1000);
            setTimeout(fetchLogs, 1500);
        } catch (e) {
            alert(`Échec de l'action : ${e.message}`);
            fetchStats();
        }
    }

    // Tabs
    tabStdout.addEventListener('click', () => {
        tabStdout.classList.add('active');
        tabStderr.classList.remove('active');
        activeLogTab = 'stdout';
        renderLogs();
    });

    tabStderr.addEventListener('click', () => {
        tabStderr.classList.add('active');
        tabStdout.classList.remove('active');
        activeLogTab = 'stderr';
        renderLogs();
    });

    // Control Buttons
    btnStart.addEventListener('click', () => controlBot('start'));
    btnStop.addEventListener('click', () => controlBot('stop'));
    btnRestart.addEventListener('click', () => controlBot('restart'));

    // --- VPN Protocol Manager Logic ---
    const vpnUsersList = document.getElementById('vpn-users-list');
    const btnAddVpnUser = document.getElementById('btn-add-vpn-user');
    const vpnUserModal = document.getElementById('vpn-user-modal');
    const modalClose = document.getElementById('modal-close');
    const btnCancelVpnUser = document.getElementById('btn-cancel-vpn-user');
    const vpnUserForm = document.getElementById('vpn-user-form');
    const modalTitle = document.getElementById('modal-title');
    
    const inputVpnId = document.getElementById('vpn-user-id');
    const inputVpnUsername = document.getElementById('vpn-username');
    const inputVpnPassword = document.getElementById('vpn-password');
    const selectVpnProtocol = document.getElementById('vpn-protocol');
    const inputVpnExpires = document.getElementById('vpn-expires');
    const inputVpnMaxConn = document.getElementById('vpn-max-conn');
    const inputVpnDataLimit = document.getElementById('vpn-data-limit');
    const selectVpnStatus = document.getElementById('vpn-status');
    const groupStatus = document.getElementById('form-group-status');

    // Config Modal Elements
    const vpnConfigModal = document.getElementById('vpn-config-modal');
    const configModalClose = document.getElementById('config-modal-close');
    const btnCloseVpnConfig = document.getElementById('btn-close-vpn-config');
    const btnCopyVpnConfig = document.getElementById('btn-copy-vpn-config');
    const vpnConfigContent = document.getElementById('vpn-config-content');

    let allVpnUsers = [];

    // Fetch and render VPN users
    async function fetchVpnUsers() {
        try {
            const res = await fetch(`${API_URL}/api/vpn/users`);
            if (!res.ok) throw new Error('Failed to fetch VPN users');
            allVpnUsers = await res.json();
            renderVpnUsers();
        } catch (e) {
            console.error('Error fetching VPN users:', e);
            vpnUsersList.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--color-danger); padding: 2rem;">Erreur de chargement : ${e.message}</td></tr>`;
        }
    }

    function renderVpnUsers() {
        if (allVpnUsers.length === 0) {
            vpnUsersList.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">Aucun compte configuré.</td></tr>`;
            return;
        }

        const today = new Date().toISOString().split('T')[0];

        vpnUsersList.innerHTML = allVpnUsers.map(user => {
            // Calculate remaining days
            const expDate = new Date(user.expires_at);
            const timeDiff = expDate.getTime() - new Date(today).getTime();
            const daysLeft = Math.ceil(timeDiff / (1000 * 3600 * 24));
            
            let daysText = '';
            if (daysLeft > 0) {
                daysText = `<span style="font-size: 0.8rem; color: var(--text-muted);">(${daysLeft}j restants)</span>`;
            } else if (daysLeft === 0) {
                daysText = `<span style="font-size: 0.8rem; color: var(--color-warning); font-weight: 600;">(Expire aujourd'hui)</span>`;
            } else {
                daysText = `<span style="font-size: 0.8rem; color: var(--color-danger); font-weight: 600;">(Expiré)</span>`;
            }

            // Status badge class
            let statusClass = 'offline';
            let statusLabel = 'Inactif';
            if (user.status === 'active') {
                statusClass = 'online';
                statusLabel = 'Actif';
            } else if (user.status === 'suspended') {
                statusClass = 'warning';
                statusLabel = 'Suspendu';
            } else if (user.status === 'expired') {
                statusClass = 'offline';
                statusLabel = 'Expiré';
            }

            // Action buttons based on status
            const suspendBtn = user.status === 'active'
                ? `<button class="btn btn-sm btn-suspend" onclick="toggleUserStatus(${user.id}, 'suspended')">Suspendre</button>`
                : `<button class="btn btn-sm btn-unsuspend" onclick="toggleUserStatus(${user.id}, 'active')">Activer</button>`;

            // Format Consumed Data
            const formattedUsed = formatBytes(user.data_used || 0, 1);
            const formattedLimit = user.data_limit_gb > 0 ? `${user.data_limit_gb} GB` : 'unlimited';

            return `
                <tr>
                    <td data-label="Utilisateur"><strong>${escapeHTML(user.username)}</strong></td>
                    <td data-label="Protocole"><span class="badge-proto ${user.protocol}">${user.protocol}</span></td>
                    <td data-label="Mot de passe"><code style="font-family: var(--font-mono); font-size: 0.85rem;">${escapeHTML(user.password)}</code></td>
                    <td data-label="Expiration">
                        <div style="display: flex; flex-direction: column;">
                            <span>${user.expires_at}</span>
                            ${daysText}
                        </div>
                    </td>
                    <td data-label="Connexions Max">${user.max_connections}</td>
                    <td data-label="Consommation"><span style="font-size: 0.85rem; font-weight: 600;">${formattedUsed} / ${formattedLimit}</span></td>
                    <td data-label="Statut"><span class="badge ${statusClass}">${statusLabel}</span></td>
                    <td data-label="Actions">
                        <div class="table-actions">
                            <button class="btn btn-sm" style="background: rgba(99, 102, 241, 0.15); color: var(--color-accent); border: 1px solid rgba(99, 102, 241, 0.2);" onclick="showVpnConfig(${user.id})">📋 Config</button>
                            <button class="btn btn-sm btn-edit" onclick="openEditModal(${user.id})">Éditer</button>
                            ${suspendBtn}
                            <button class="btn btn-sm btn-delete" onclick="deleteVpnUser(${user.id}, '${escapeHTML(user.username)}')">Supprimer</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Modal Control
    function showModal() {
        vpnUserModal.style.display = 'flex';
        setTimeout(() => vpnUserModal.classList.add('show'), 10);
    }

    function closeModal() {
        vpnUserModal.classList.remove('show');
        setTimeout(() => {
            vpnUserModal.style.display = 'none';
            vpnUserForm.reset();
            inputVpnId.value = '';
            inputVpnUsername.disabled = false;
            groupStatus.style.display = 'none';
            inputVpnDataLimit.value = 0;
        }, 300);
    }

    btnAddVpnUser.addEventListener('click', () => {
        modalTitle.textContent = "Créer un Compte VPN";
        inputVpnId.value = '';
        inputVpnUsername.disabled = false;
        groupStatus.style.display = 'none';
        inputVpnMaxConn.value = 1;
        inputVpnDataLimit.value = 0;
        
        // Pre-fill tomorrow's date as default expiration
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 30);
        inputVpnExpires.value = tomorrow.toISOString().split('T')[0];
        
        showModal();
    });

    modalClose.addEventListener('click', closeModal);
    btnCancelVpnUser.addEventListener('click', closeModal);
    
    window.addEventListener('click', (e) => {
        if (e.target === vpnUserModal) closeModal();
        if (e.target === vpnConfigModal) closeConfigModal();
    });

    // Form Submission (Create / Update)
    vpnUserForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const userId = inputVpnId.value;
        const payload = {
            username: inputVpnUsername.value.trim(),
            password: inputVpnPassword.value.trim(),
            protocol: selectVpnProtocol.value,
            expires_at: inputVpnExpires.value,
            max_connections: parseInt(inputVpnMaxConn.value) || 1,
            data_limit_gb: parseInt(inputVpnDataLimit.value) || 0,
            status: selectVpnStatus.value
        };

        const isEdit = !!userId;
        const url = isEdit ? `${API_URL}/api/vpn/users/${userId}` : `${API_URL}/api/vpn/users`;
        const method = isEdit ? 'PUT' : 'POST';

        try {
            const saveBtn = document.getElementById('btn-save-vpn-user');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Enregistrement...';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Operation failed');
            
            closeModal();
            fetchVpnUsers();
            
            // If it was creation, show config immediately!
            if (!isEdit && data.id) {
                setTimeout(() => {
                    showVpnConfig(data.id);
                }, 500);
            }
        } catch (err) {
            alert(`Erreur : ${err.message}`);
        } finally {
            const saveBtn = document.getElementById('btn-save-vpn-user');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Enregistrer';
        }
    });

    // Open Edit Modal
    window.openEditModal = function(id) {
        const user = allVpnUsers.find(u => u.id === id);
        if (!user) return;

        modalTitle.textContent = "Modifier le Compte";
        inputVpnId.value = user.id;
        inputVpnUsername.value = user.username;
        inputVpnUsername.disabled = true; // Cannot edit username
        inputVpnPassword.value = user.password;
        selectVpnProtocol.value = user.protocol;
        inputVpnExpires.value = user.expires_at;
        inputVpnMaxConn.value = user.max_connections;
        inputVpnDataLimit.value = user.data_limit_gb || 0;
        selectVpnStatus.value = user.status;
        groupStatus.style.display = 'flex';

        showModal();
    };

    // Toggle Status (Suspend / Reactivate)
    window.toggleUserStatus = async function(id, newStatus) {
        try {
            const res = await fetch(`${API_URL}/api/vpn/users/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update status');
            fetchVpnUsers();
        } catch (e) {
            alert(`Erreur : ${e.message}`);
        }
    };

    // Delete User
    window.deleteVpnUser = async function(id, username) {
        if (!confirm(`Es-tu sûr de vouloir supprimer définitivement le compte vpn "${username}" ?`)) return;
        
        try {
            const res = await fetch(`${API_URL}/api/vpn/users/${id}`, {
                method: 'DELETE'
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to delete user');
            fetchVpnUsers();
        } catch (e) {
            alert(`Erreur : ${e.message}`);
        }
    };

    // Connection Config Modal Logic
    window.showVpnConfig = function(id) {
        // Try to locate in list first, otherwise fall back to reloading list
        const user = allVpnUsers.find(u => u.id === id);
        if (!user) return;
        
        let configText = '';
        const host = window.location.hostname || '184.73.52.96';
        
        if (user.protocol === 'zivpn') {
            configText = `=== CONFIGURATION UDP ZIVPN ===\n` +
                         `Hôte (Host) : ${host}\n` +
                         `Mot de passe (Pass) : ${user.password}\n` +
                         `Port : 5667\n` +
                         `Obfuscation : zivpn`;
        } else if (user.protocol === 'udpcustom') {
            configText = `=== CONFIGURATION UDP CUSTOM ===\n` +
                         `Hôte (Host) : ${host}\n` +
                         `Port : 36712\n` +
                         `Utilisateur (User) : ${user.username}\n` +
                         `Mot de passe (Pass) : ${user.password}`;
        } else if (user.protocol === 'fastdns') {
            configText = `=== CONFIGURATION FASTDNS ===\n` +
                         `Hôte (Host) : ${host}\n` +
                         `Utilisateur (User) : ${user.username}\n` +
                         `Mot de passe (Pass) : ${user.password}\n` +
                         `Nameserver (NS) : t.innovationservicescm.cm\n` +
                         `Clé Publique (Pubkey) : 50de83ec08cc05fbd24630e48c5ee4f2b2ed104bd340f299e1db88d612df0225\n` +
                         `DNS de contournement (Bypass) : 8.8.8.8`;
        }
        
        vpnConfigContent.textContent = configText;
        vpnConfigModal.style.display = 'flex';
        setTimeout(() => vpnConfigModal.classList.add('show'), 10);
    };

    function closeConfigModal() {
        vpnConfigModal.classList.remove('show');
        setTimeout(() => {
            vpnConfigModal.style.display = 'none';
        }, 300);
    }

    configModalClose.addEventListener('click', closeConfigModal);
    btnCloseVpnConfig.addEventListener('click', closeConfigModal);
    
    btnCopyVpnConfig.addEventListener('click', () => {
        const textToCopy = vpnConfigContent.textContent;
        
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(textToCopy)
                .then(() => alert('Configuration copiée dans le presse-papiers !'))
                .catch(err => useFallbackCopy(textToCopy));
        } else {
            useFallbackCopy(textToCopy);
        }
    });

    function useFallbackCopy(text) {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.top = "0";
        textArea.style.left = "0";
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
            const successful = document.execCommand('copy');
            if (successful) {
                alert('Configuration copiée dans le presse-papiers !');
            } else {
                alert('Échec de la copie.');
            }
        } catch (err) {
            alert('Échec de la copie : ' + err);
        }
        document.body.removeChild(textArea);
    }

    // Init
    fetchStats();
    fetchLogs();
    fetchVpnUsers();
    
    setTimeout(() => {
        terminal.scrollTop = terminal.scrollHeight;
    }, 500);

    setInterval(fetchStats, 1500);
    setInterval(fetchLogs, 3000);
    setInterval(fetchVpnUsers, 15000);
});
