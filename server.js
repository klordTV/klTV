const fs = require("fs");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

const RENDER_DEPLOY_URL = "https://api.render.com/deploy/srv-d6o4ric50q8c73ddcucg?key=GZ3X3EIsQTY";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PUT");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

const DB_FILE = path.join(__dirname, "database.json");
const M3U_SOURCES_FILE = path.join(__dirname, "m3u_sources.json");

let db = {
    users: [],
    settings: {
        serverName: "Meu Servidor IPTV",
        maxConcurrentConnections: 1000,
        defaultExpiryDays: 30,
        defaultMaxConnections: 1,
        baseUrl: process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`
    }
};

let activeTokens = new Set();
let m3uSources = [];
let live = [];
let vod = [];
let series = {};
let categories = { live: [], vod: [], series: [] };
let groupToId = {};
let catIdCounters = { live: 1, vod: 1, series: 1 };

function generateId() { return crypto.randomBytes(8).toString("hex"); }
function generatePassword(length = 8) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let password = "";
    for (let i = 0; i < length; i++) password += chars.charAt(Math.floor(Math.random() * chars.length));
    return password;
}
function calculateExpiryDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + parseInt(days));
    return date.toISOString().split("T")[0];
}
function calculateTrialExpiry() {
    const date = new Date();
    date.setHours(date.getHours() + 1);
    return date.toISOString();
}
function isExpired(user) {
    if (user.expiresAt === "never") return false;
    return new Date(user.expiresAt) < new Date();
}
function triggerRenderDeploy() {
    return new Promise((resolve) => {
        console.log("🚀 Acionando deploy no Render...");
        https.get(RENDER_DEPLOY_URL, (res) => {
            console.log(`✅ Deploy status: ${res.statusCode}`);
            resolve({ success: res.statusCode === 200 });
        }).on('error', (err) => {
            console.error("❌ Erro deploy:", err.message);
            resolve({ success: false, error: err.message });
        });
    });
}

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
            if (!db.users.find(u => u.isAdmin)) createDefaultAdmin();
        } else {
            createDefaultAdmin();
        }
    } catch (e) { createDefaultAdmin(); }
}

function createDefaultAdmin() {
    db.users = db.users.filter(u => !u.isAdmin);
    db.users.push({
        id: "admin",
        username: "klord",
        password: "Kl0rd777",
        isAdmin: true,
        createdAt: new Date().toISOString(),
        expiresAt: "never",
        maxConnections: 999,
        activeConnections: 0,
        status: "Active",
        notes: "Administrador"
    });
    saveDatabase();
    console.log("✅ Admin criado: klord");
}

function saveDatabase() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function loadM3USources() {
    try {
        if (fs.existsSync(M3U_SOURCES_FILE)) {
            m3uSources = JSON.parse(fs.readFileSync(M3U_SOURCES_FILE, "utf8"));
            console.log(`📋 ${m3uSources.length} fontes M3U carregadas`);
        } else {
            m3uSources = [];
            saveM3USources();
        }
    } catch (e) { m3uSources = []; }
}

function saveM3USources() { fs.writeFileSync(M3U_SOURCES_FILE, JSON.stringify(m3uSources, null, 2)); }

function downloadM3U(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        console.log(`⬇️  Baixando M3U: ${url.substring(0, 60)}...`);
        const req = client.get(url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) return downloadM3U(res.headers.location).then(resolve).catch(reject);
            if (res.statusCode !== 200) return reject(new Error(`Status: ${res.statusCode}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`✅ Download: ${(data.length / 1024).toFixed(2)} KB`);
                resolve(data);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function parseM3UToItems(content, sourceName) {
    const lines = content.split(/\r?\n/);
    const items = [];
    let current = null;
    let id = Date.now() + Math.random() * 1000;

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        if (line.startsWith("#EXTINF")) {
            const tvgNameMatch = line.match(/tvg-name="([^"]*)"/);
            let name = tvgNameMatch ? tvgNameMatch[1] : "";
            if (!name) {
                const commaIndex = line.lastIndexOf(",");
                name = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : "Sem Nome";
            }
            const groupMatch = line.match(/group-title="([^"]*)"/i);
            const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
            current = {
                id: (id++).toString(),
                name: name,
                originalGroup: groupMatch ? groupMatch[1] : "OUTROS",
                icon: logoMatch ? logoMatch[1] : "",
                rawLine: line,
                source: sourceName
            };
        } else if (line.startsWith("http") && current) {
            current.url = line;
            const groupUpper = current.originalGroup.toUpperCase();
            if (groupUpper.includes('FILME') || groupUpper.includes('MOVIE') || groupUpper.includes('VOD')) {
                current.type = 'vod';
            } else if (groupUpper.includes('SERIE') || groupUpper.includes('SÉRIE') || current.name.match(/S\d+E\d+/i)) {
                current.type = 'series';
            } else {
                current.type = 'live';
            }
            items.push(current);
            current = null;
        }
    }
    return items;
}

async function reloadAllSources() {
    console.log("\n🔄 Recarregando fontes...");
    live = [];
    vod = [];
    series = {};
    categories = { live: [], vod: [], series: [] };
    groupToId = {};
    catIdCounters = { live: 1, vod: 1, series: 1 };

    if (fs.existsSync(path.join(__dirname, "playlist.m3u"))) {
        const content = fs.readFileSync(path.join(__dirname, "playlist.m3u"), "utf8");
        const items = parseM3UToItems(content, "Local");
        items.forEach(item => {
            if (item.type === 'live') parseLive(item);
            else if (item.type === 'vod') parseMovie(item);
            else if (item.type === 'series') parseSeries(item);
        });
    }

    for (const source of m3uSources.filter(s => s.enabled !== false)) {
        try {
            const content = await downloadM3U(source.url);
            const items = parseM3UToItems(content, source.name);
            const filteredItems = items.filter(item => !source.contentTypes || source.contentTypes.includes(item.type));
            
            filteredItems.forEach(item => {
                if (item.type === 'vod') parseMovie(item);
                else if (item.type === 'series') parseSeries(item);
                else parseLive(item);
            });
            
            source.lastUpdate = new Date().toISOString();
            source.status = 'active';
        } catch (error) {
            source.status = 'error';
            source.lastError = error.message;
        }
    }
    saveM3USources();
    console.log(`✅ ${live.length} Canais | ${vod.length} Filmes | ${Object.keys(series).length} Séries`);
    return { live: live.length, vod: vod.length, series: Object.keys(series).length };
}

function getOrCreateCategory(groupName, type) {
    const catKey = `${type}_${groupName}`;
    if (!groupToId[catKey]) {
        const catId = catIdCounters[type].toString();
        groupToId[catKey] = catId;
        catIdCounters[type]++;
        const catObj = { category_id: catId, category_name: groupName, parent_id: 0 };
        if (type === "live") categories.live.push(catObj);
        else if (type === "vod") categories.vod.push(catObj);
        else if (type === "series") categories.series.push(catObj);
    }
    return groupToId[catKey];
}

function parseLive(item) {
    const categoryId = getOrCreateCategory(`[${item.source}] ${item.originalGroup}`, "live");
    live.push({
        num: live.length + 1,
        name: item.name,
        stream_type: "live",
        stream_id: item.id,
        stream_icon: item.icon,
        added: Math.floor(Date.now() / 1000).toString(),
        category_id: categoryId,
        direct_source: item.url
    });
}

function parseMovie(item) {
    const categoryId = getOrCreateCategory(`[${item.source}] ${item.originalGroup}`, "vod");
    const yearMatch = item.name.match(/\((\d{4})\)$/);
    const year = yearMatch ? yearMatch[1] : "";
    const cleanName = item.name.replace(/\s*\(\d{4}\)$/, "").trim();
    vod.push({
        num: vod.length + 1,
        name: cleanName,
        stream_type: "movie",
        stream_id: item.id,
        stream_icon: item.icon,
        added: Math.floor(Date.now() / 1000).toString(),
        category_id: categoryId,
        container_extension: "mp4",
        direct_source: item.url,
        releaseDate: year
    });
}

function parseSeries(item) {
    const categoryId = getOrCreateCategory(`[${item.source}] ${item.originalGroup}`, "series");
    const match = item.name.match(/S(\d+)E(\d+)/i);
    if (!match) return;
    const season = parseInt(match[1]);
    const episode = parseInt(match[2]);
    let serieName = item.name.substring(0, match.index).trim();
    serieName = serieName.replace(/[\s\-|]+$/, "").trim();
    if (!series[serieName]) {
        series[serieName] = {
            series_id: (Object.keys(series).length + 1).toString(),
            name: serieName,
            cover: item.icon || "",
            category_id: categoryId,
            seasons: {}
        };
    }
    if (!series[serieName].seasons[season]) series[serieName].seasons[season] = [];
    const exists = series[serieName].seasons[season].some(e => e.episode_num === episode);
    if (exists) return;
    series[serieName].seasons[season].push({
        id: item.id,
        episode_num: episode,
        title: `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`,
        container_extension: "mp4",
        info: { movie_image: item.icon },
        url: item.url
    });
}

// ==================== API IPTV ====================

app.get("/player_api.php", (req, res) => {
    const { username, password, action } = req.query;
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user) return res.json({ user_info: { auth: 0, status: "Invalid" } });
    if (isExpired(user)) return res.json({ user_info: { auth: 0, status: "Expired", message: user.isTrial ? "Teste expirado" : "Assinatura expirada" } });

    if (!action) {
        user.activeConnections++;
        saveDatabase();
        return res.json({
            user_info: {
                username: user.username,
                password: user.password,
                message: user.isTrial ? "⚡ Conta de teste" : "",
                auth: 1,
                status: user.status,
                exp_date: user.expiresAt === "never" ? "1758143248" : Math.floor(new Date(user.expiresAt).getTime() / 1000).toString(),
                is_trial: user.isTrial ? "1" : "0",
                active_cons: user.activeConnections.toString(),
                created_at: Math.floor(new Date(user.createdAt).getTime() / 1000).toString(),
                max_connections: user.maxConnections.toString(),
                allowed_output_formats: ["m3u8", "ts", "mp4"]
            },
            server_info: {
                url: req.hostname,
                port: PORT.toString(),
                server_protocol: "http",
                timezone: "America/Sao_Paulo",
                timestamp_now: Math.floor(Date.now() / 1000),
                time_now: new Date().toISOString().replace('T', ' ').substring(0, 19)
            }
        });
    }

    if (action === "get_live_categories") return res.json(categories.live);
    if (action === "get_vod_categories") return res.json(categories.vod);
    if (action === "get_series_categories") return res.json(categories.series);
    if (action === "get_live_streams") return res.json(req.query.category_id ? live.filter(s => s.category_id === req.query.category_id) : live);
    if (action === "get_vod_streams") return res.json(req.query.category_id ? vod.filter(s => s.category_id === req.query.category_id) : vod);
    if (action === "get_series") {
        let list = Object.values(series).map(s => ({ series_id: s.series_id, name: s.name, cover: s.cover, category_id: s.category_id }));
        if (req.query.category_id) list = list.filter(s => s.category_id === req.query.category_id);
        return res.json(list);
    }
    if (action === "get_series_info") {
        const serie = Object.values(series).find(s => s.series_id === req.query.series_id);
        if (!serie) return res.json({ seasons: [] });
        const seasons = Object.keys(serie.seasons).map(seasonNum => ({
            season_number: parseInt(seasonNum),
            episodes: serie.seasons[seasonNum]
        }));
        return res.json({ seasons });
    }
    res.json({ error: "Ação não suportada" });
});

app.get("/live/:username/:password/:stream_id.ts", (req, res) => {
    const user = db.users.find(u => u.username === req.params.username && u.password === req.params.password);
    if (!user || isExpired(user)) return res.status(403).send("Acesso negado");
    const channel = live.find(c => c.stream_id === req.params.stream_id);
    if (channel) return res.redirect(channel.direct_source);
    res.status(404).send("Stream não encontrado");
});

app.get("/movie/:username/:password/:stream_id.mp4", (req, res) => {
    const user = db.users.find(u => u.username === req.params.username && u.password === req.params.password);
    if (!user || isExpired(user)) return res.status(403).send("Acesso negado");
    const movie = vod.find(v => v.stream_id === req.params.stream_id);
    if (movie) return res.redirect(movie.direct_source);
    res.status(404).send("Filme não encontrado");
});

app.get("/series/:username/:password/:stream_id.mp4", (req, res) => {
    const user = db.users.find(u => u.username === req.params.username && u.password === req.params.password);
    if (!user || isExpired(user)) return res.status(403).send("Acesso negado");
    for (let serieName in series) {
        for (let seasonNum in series[serieName].seasons) {
            const ep = series[serieName].seasons[seasonNum].find(e => e.id === req.params.stream_id);
            if (ep) return res.redirect(ep.url);
        }
    }
    res.status(404).send("Episódio não encontrado");
});

// ==================== PAINEL ADMIN RGB ====================

function verifyToken(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !activeTokens.has(token)) return res.status(401).json({ error: "Não autorizado" });
    next();
}

app.get("/admin", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ IPTV ADMIN</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;500;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root { --neon-blue: #00f3ff; --neon-purple: #bc13fe; --neon-pink: #ff006e; --dark-bg: #0a0a0f; }
        body {
            font-family: 'Rajdhani', sans-serif;
            background: var(--dark-bg);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: hidden;
            position: relative;
        }
        body::before {
            content: '';
            position: absolute;
            width: 200%; height: 200%;
            background: radial-gradient(circle at 20% 50%, rgba(0,243,255,0.15) 0%, transparent 50%),
                        radial-gradient(circle at 80% 80%, rgba(188,19,254,0.1) 0%, transparent 50%);
            animation: bgPulse 10s ease-in-out infinite;
        }
        @keyframes bgPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.1); } }
        .login-container { position: relative; z-index: 10; width: 100%; max-width: 450px; padding: 20px; }
        .login-box {
            background: rgba(15,15,25,0.9);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(0,243,255,0.2);
            border-radius: 20px;
            padding: 50px 40px;
            box-shadow: 0 0 40px rgba(0,243,255,0.1), inset 0 0 20px rgba(0,243,255,0.05);
            position: relative;
            overflow: hidden;
        }
        .login-box::before {
            content: '';
            position: absolute;
            top: -2px; left: -2px; right: -2px; bottom: -2px;
            background: linear-gradient(45deg, var(--neon-blue), var(--neon-purple), var(--neon-pink), var(--neon-blue));
            border-radius: 20px;
            opacity: 0;
            z-index: -1;
            transition: opacity 0.3s;
            animation: rgbRotate 3s linear infinite;
            background-size: 400% 400%;
        }
        .login-box:hover::before { opacity: 0.5; }
        @keyframes rgbRotate { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .logo { text-align: center; margin-bottom: 40px; }
        .logo h1 {
            font-family: 'Orbitron', sans-serif;
            font-size: 42px;
            font-weight: 900;
            background: linear-gradient(135deg, var(--neon-blue), var(--neon-purple), var(--neon-pink));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 0 0 30px rgba(0,243,255,0.5);
            letter-spacing: 4px;
            animation: textGlow 2s ease-in-out infinite alternate;
        }
        @keyframes textGlow { from { filter: drop-shadow(0 0 10px rgba(0,243,255,0.5)); } to { filter: drop-shadow(0 0 20px rgba(188,19,254,0.8)); } }
        .logo p { color: rgba(255,255,255,0.5); font-size: 14px; letter-spacing: 8px; text-transform: uppercase; margin-top: 10px; }
        .input-group { margin-bottom: 25px; position: relative; }
        .input-group label { display: block; color: var(--neon-blue); font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; font-weight: 700; }
        .input-group input {
            width: 100%; padding: 15px 20px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(0,243,255,0.3);
            border-radius: 10px;
            color: #fff; font-size: 16px;
            font-family: 'Rajdhani', sans-serif;
            transition: all 0.3s; outline: none;
        }
        .input-group input:focus {
            border-color: var(--neon-blue);
            box-shadow: 0 0 20px rgba(0,243,255,0.3), inset 0 0 10px rgba(0,243,255,0.1);
        }
        .input-group input::placeholder { color: rgba(255,255,255,0.3); }
        .btn-login {
            width: 100%; padding: 18px;
            background: linear-gradient(135deg, rgba(0,243,255,0.2), rgba(188,19,254,0.2));
            border: 1px solid var(--neon-blue);
            border-radius: 10px;
            color: var(--neon-blue);
            font-family: 'Orbitron', sans-serif;
            font-size: 16px; font-weight: 700;
            letter-spacing: 3px;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s;
            position: relative; overflow: hidden;
        }
        .btn-login::before {
            content: '';
            position: absolute;
            top: 0; left: -100%;
            width: 100%; height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s;
        }
        .btn-login:hover::before { left: 100%; }
        .btn-login:hover {
            background: linear-gradient(135deg, rgba(0,243,255,0.4), rgba(188,19,254,0.4));
            box-shadow: 0 0 30px rgba(0,243,255,0.4);
            transform: translateY(-2px);
        }
        .error { color: var(--neon-pink); text-align: center; margin-top: 20px; font-size: 14px; display: none; text-shadow: 0 0 10px rgba(255,0,110,0.5); }
        .grid-bg {
            position: absolute; width: 100%; height: 100%;
            background-image: linear-gradient(rgba(0,243,255,0.03) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(0,243,255,0.03) 1px, transparent 1px);
            background-size: 50px 50px;
            pointer-events: none;
        }
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="login-container">
        <div class="login-box">
            <div class="logo">
                <h1>⚡ IPTV</h1>
                <p>Painel Administrativo</p>
            </div>
            <form id="loginForm">
                <div class="input-group">
                    <label>👤 Usuário</label>
                    <input type="text" id="username" required placeholder="Digite seu usuário...">
                </div>
                <div class="input-group">
                    <label>🔐 Senha</label>
                    <input type="password" id="password" required placeholder="Digite sua senha...">
                </div>
                <button type="submit" class="btn-login">Entrar</button>
                <div id="error" class="error">Acesso Negado</div>
            </form>
        </div>
    </div>
    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            try {
                const res = await fetch('/admin/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (data.success) {
                    localStorage.setItem('adminToken', data.token);
                    window.location.href = '/admin/dashboard';
                } else {
                    document.getElementById('error').style.display = 'block';
                    setTimeout(() => document.getElementById('error').style.display = 'none', 3000);
                }
            } catch (err) {
                document.getElementById('error').textContent = 'Erro de conexão';
                document.getElementById('error').style.display = 'block';
            }
        });
    </script>
</body>
</html>`);
});

app.post("/admin/api/login", (req, res) => {
    const { username, password } = req.body;
    const user = db.users.find(u => u.username === username && u.password === password);
    if (user && user.isAdmin) {
        const token = generateId();
        activeTokens.add(token);
        return res.json({ success: true, token });
    }
    res.json({ success: false });
});

// ==================== DASHBOARD RGB ====================

app.get("/admin/dashboard", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ Dashboard IPTV</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;500;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --neon-blue: #00f3ff; --neon-purple: #bc13fe; --neon-pink: #ff006e;
            --neon-green: #39ff14; --neon-orange: #ff9500;
            --dark-bg: #0a0a0f; --card-bg: rgba(15,15,25,0.95);
        }
        body {
            font-family: 'Rajdhani', sans-serif;
            background: var(--dark-bg);
            color: #fff;
            min-height: 100vh;
            overflow-x: hidden;
        }
        .bg-animation {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1;
            background: radial-gradient(circle at 0% 0%, rgba(0,243,255,0.1) 0%, transparent 40%),
                        radial-gradient(circle at 100% 0%, rgba(188,19,254,0.1) 0%, transparent 40%),
                        radial-gradient(circle at 100% 100%, rgba(255,0,110,0.1) 0%, transparent 40%);
            animation: bgMove 20s ease-in-out infinite;
        }
        @keyframes bgMove { 0%, 100% { transform: scale(1) rotate(0deg); } 50% { transform: scale(1.1) rotate(2deg); } }
        .grid-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-image: linear-gradient(rgba(0,243,255,0.02) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(0,243,255,0.02) 1px, transparent 1px);
            background-size: 40px 40px;
            pointer-events: none; z-index: -1;
        }
        .sidebar {
            position: fixed; left: 0; top: 0;
            width: 280px; height: 100vh;
            background: var(--card-bg);
            border-right: 1px solid rgba(0,243,255,0.1);
            backdrop-filter: blur(20px);
            z-index: 1000;
            padding: 30px 20px;
            overflow-y: auto;
        }
        .logo-dash { text-align: center; padding-bottom: 30px; border-bottom: 1px solid rgba(0,243,255,0.2); margin-bottom: 30px; }
        .logo-dash h2 {
            font-family: 'Orbitron', sans-serif; font-size: 28px;
            background: linear-gradient(135deg, var(--neon-blue), var(--neon-purple));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            text-shadow: 0 0 20px rgba(0,243,255,0.5);
        }
        .nav-item {
            padding: 15px 20px; margin: 8px 0;
            border-radius: 12px; cursor: pointer;
            transition: all 0.3s;
            display: flex; align-items: center; gap: 15px;
            border: 1px solid transparent;
            position: relative; overflow: hidden;
        }
        .nav-item::before {
            content: ''; position: absolute; left: 0; top: 0; height: 100%; width: 3px;
            background: var(--neon-blue); opacity: 0; transition: opacity 0.3s;
        }
        .nav-item:hover, .nav-item.active {
            background: rgba(0,243,255,0.1);
            border-color: rgba(0,243,255,0.3);
            box-shadow: 0 0 20px rgba(0,243,255,0.1);
        }
        .nav-item:hover::before, .nav-item.active::before { opacity: 1; box-shadow: 0 0 10px var(--neon-blue); }
        .nav-item span:first-child { font-size: 20px; filter: drop-shadow(0 0 5px rgba(0,243,255,0.5)); }
        .nav-item span:last-child { font-weight: 600; letter-spacing: 1px; }
        .main-content { margin-left: 280px; padding: 30px; min-height: 100vh; }
        .header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 25px 30px; background: var(--card-bg);
            border: 1px solid rgba(0,243,255,0.2);
            border-radius: 16px; margin-bottom: 30px;
            backdrop-filter: blur(10px);
            box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        }
        .header h1 { font-family: 'Orbitron', sans-serif; font-size: 24px; color: var(--neon-blue); text-shadow: 0 0 10px rgba(0,243,255,0.5); }
        .user-info { display: flex; align-items: center; gap: 15px; color: rgba(255,255,255,0.7); }
        .user-avatar {
            width: 40px; height: 40px; border-radius: 50%;
            background: linear-gradient(135deg, var(--neon-blue), var(--neon-purple));
            display: flex; align-items: center; justify-content: center;
            font-weight: bold; box-shadow: 0 0 15px rgba(0,243,255,0.4);
        }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card {
            background: var(--card-bg); border: 1px solid rgba(0,243,255,0.15);
            border-radius: 16px; padding: 25px;
            position: relative; overflow: hidden;
            transition: all 0.3s; backdrop-filter: blur(10px);
        }
        .stat-card::before {
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
            background: linear-gradient(90deg, var(--neon-blue), var(--neon-purple), var(--neon-pink));
            opacity: 0.5;
        }
        .stat-card:hover { transform: translateY(-5px); border-color: rgba(0,243,255,0.4); box-shadow: 0 10px 30px rgba(0,243,255,0.1); }
        .stat-card h3 { color: rgba(255,255,255,0.6); font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; }
        .stat-card .number {
            font-family: 'Orbitron', sans-serif; font-size: 36px; font-weight: 700;
            background: linear-gradient(135deg, #fff, var(--neon-blue));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        }
        .section {
            background: var(--card-bg); border: 1px solid rgba(0,243,255,0.15);
            border-radius: 16px; padding: 30px; margin-bottom: 25px;
            backdrop-filter: blur(10px);
        }
        .section h2 {
            font-family: 'Orbitron', sans-serif; font-size: 18px; color: var(--neon-blue);
            margin-bottom: 25px; display: flex; justify-content: space-between; align-items: center;
            text-shadow: 0 0 10px rgba(0,243,255,0.3);
        }
        .btn {
            padding: 12px 24px; border: none; border-radius: 10px;
            font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 14px;
            cursor: pointer; transition: all 0.3s;
            text-transform: uppercase; letter-spacing: 1px;
            position: relative; overflow: hidden;
        }
        .btn-primary {
            background: linear-gradient(135deg, rgba(0,243,255,0.2), rgba(188,19,254,0.2));
            border: 1px solid var(--neon-blue); color: var(--neon-blue);
        }
        .btn-primary:hover {
            background: linear-gradient(135deg, rgba(0,243,255,0.4), rgba(188,19,254,0.4));
            box-shadow: 0 0 20px rgba(0,243,255,0.4); transform: translateY(-2px);
        }
        .btn-success {
            background: linear-gradient(135deg, rgba(57,255,20,0.2), rgba(0,243,255,0.2));
            border: 1px solid var(--neon-green); color: var(--neon-green);
        }
        .btn-success:hover { box-shadow: 0 0 20px rgba(57,255,20,0.4); }
        .btn-warning {
            background: linear-gradient(135deg, rgba(255,149,0,0.2), rgba(255,0,110,0.2));
            border: 1px solid var(--neon-orange); color: var(--neon-orange);
        }
        .btn-danger {
            background: linear-gradient(135deg, rgba(255,0,110,0.2), rgba(188,19,254,0.2));
            border: 1px solid var(--neon-pink); color: var(--neon-pink);
        }
        .btn-danger:hover { box-shadow: 0 0 20px rgba(255,0,110,0.4); }
        .data-table { width: 100%; border-collapse: collapse; }
        .data-table th {
            background: rgba(0,243,255,0.1); color: var(--neon-blue);
            font-weight: 700; text-transform: uppercase; font-size: 12px;
            letter-spacing: 1px; padding: 15px; text-align: left;
            border-bottom: 2px solid rgba(0,243,255,0.3);
        }
        .data-table td { padding: 15px; border-bottom: 1px solid rgba(255,255,255,0.05); color: rgba(255,255,255,0.8); }
        .data-table tr:hover { background: rgba(0,243,255,0.05); }
        .badge {
            padding: 5px 12px; border-radius: 20px; font-size: 11px;
            font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
        }
        .badge-admin { background: rgba(188,19,254,0.2); border: 1px solid var(--neon-purple); color: var(--neon-purple); box-shadow: 0 0 10px rgba(188,19,254,0.3); }
        .badge-user { background: rgba(0,243,255,0.2); border: 1px solid var(--neon-blue); color: var(--neon-blue); box-shadow: 0 0 10px rgba(0,243,255,0.3); }
        .badge-trial { background: rgba(255,149,0,0.2); border: 1px solid var(--neon-orange); color: var(--neon-orange); box-shadow: 0 0 10px rgba(255,149,0,0.3); animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        .status-active { color: var(--neon-green); text-shadow: 0 0 10px rgba(57,255,20,0.5); }
        .status-expired { color: var(--neon-pink); text-shadow: 0 0 10px rgba(255,0,110,0.5); }
        .modal {
            display: none; position: fixed; top: 0; left: 0;
            width: 100%; height: 100%; background: rgba(0,0,0,0.8);
            backdrop-filter: blur(10px); justify-content: center; align-items: center;
            z-index: 2000; padding: 20px;
        }
        .modal-content {
            background: var(--card-bg); border: 1px solid rgba(0,243,255,0.3);
            border-radius: 20px; width: 90%; max-width: 800px; max-height: 90vh;
            overflow-y: auto; box-shadow: 0 0 50px rgba(0,243,255,0.2);
            animation: modalIn 0.3s ease;
        }
        @keyframes modalIn { from { opacity: 0; transform: scale(0.9) translateY(-20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
        .modal-header { padding: 25px 30px; border-bottom: 1px solid rgba(0,243,255,0.2); display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { font-family: 'Orbitron', sans-serif; color: var(--neon-blue); font-size: 20px; }
        .modal-body { padding: 30px; }
        .modal-footer { padding: 20px 30px; border-top: 1px solid rgba(0,243,255,0.2); display: flex; justify-content: flex-end; gap: 15px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; color: var(--neon-blue); font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; font-weight: 700; }
        .form-group input, .form-group select {
            width: 100%; padding: 15px; background: rgba(255,255,255,0.03);
            border: 1px solid rgba(0,243,255,0.3); border-radius: 10px;
            color: #fff; font-size: 16px; font-family: 'Rajdhani', sans-serif;
            transition: all 0.3s; outline: none;
        }
        .form-group input:focus, .form-group select:focus { border-color: var(--neon-blue); box-shadow: 0 0 20px rgba(0,243,255,0.2); }
        .checkbox-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin: 20px 0; }
        .checkbox-item {
            display: flex; align-items: center; gap: 10px; padding: 15px;
            background: rgba(255,255,255,0.03); border: 1px solid rgba(0,243,255,0.2);
            border-radius: 10px; cursor: pointer; transition: all 0.3s;
        }
        .checkbox-item:hover { border-color: var(--neon-blue); background: rgba(0,243,255,0.1); }
        .checkbox-item input[type="checkbox"] { width: 20px; height: 20px; accent-color: var(--neon-blue); }
        .category-list { max-height: 400px; overflow-y: auto; border: 1px solid rgba(0,243,255,0.2); border-radius: 12px; padding: 15px; background: rgba(0,0,0,0.3); }
        .category-item {
            display: flex; align-items: center; gap: 15px; padding: 15px;
            background: rgba(0,243,255,0.05); border: 1px solid rgba(0,243,255,0.1);
            border-radius: 10px; margin-bottom: 10px; cursor: pointer; transition: all 0.3s;
        }
        .category-item:hover { border-color: var(--neon-blue); background: rgba(0,243,255,0.1); }
        .category-item.selected { border-color: var(--neon-blue); background: rgba(0,243,255,0.2); box-shadow: 0 0 20px rgba(0,243,255,0.3); }
        .category-info { flex: 1; }
        .category-info h4 { color: #fff; margin-bottom: 5px; }
        .category-info p { color: rgba(255,255,255,0.5); font-size: 12px; }
        .source-card {
            background: rgba(255,255,255,0.03); border: 1px solid rgba(0,243,255,0.2);
            border-radius: 12px; padding: 20px; margin-bottom: 15px;
            position: relative; overflow: hidden;
        }
        .source-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--neon-blue); }
        .source-card.error::before { background: var(--neon-pink); }
        .source-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .source-name { font-weight: 700; font-size: 16px; color: #fff; }
        .source-status { padding: 5px 12px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
        .source-status.active { background: rgba(57,255,20,0.2); color: var(--neon-green); border: 1px solid var(--neon-green); }
        .source-status.error { background: rgba(255,0,110,0.2); color: var(--neon-pink); border: 1px solid var(--neon-pink); }
        .source-url { font-size: 12px; color: rgba(255,255,255,0.5); margin-bottom: 10px; font-family: monospace; }
        .source-meta { display: flex; gap: 20px; font-size: 12px; color: rgba(255,255,255,0.6); }
        .hidden { display: none !important; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #050508; }
        ::-webkit-scrollbar-thumb { background: rgba(0,243,255,0.3); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(0,243,255,0.5); }
        .loading { display: inline-block; width: 20px; height: 20px; border: 2px solid rgba(0,243,255,0.3); border-radius: 50%; border-top-color: var(--neon-blue); animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .preview-section { margin-top: 20px; padding: 20px; background: rgba(0,0,0,0.3); border-radius: 12px; border: 1px solid rgba(0,243,255,0.2); }
        .preview-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .preview-title { color: var(--neon-orange); font-size: 14px; font-weight: 700; }
        .category-count { color: var(--neon-blue); font-size: 12px; }
    </style>
</head>
<body>
    <div class="bg-animation"></div>
    <div class="grid-overlay"></div>
    
    <div class="sidebar">
        <div class="logo-dash"><h2>⚡ IPTV</h2></div>
        <div class="nav-item active" onclick="showSection('dashboard')"><span>📊</span><span>Dashboard</span></div>
        <div class="nav-item" onclick="showSection('users')"><span>👥</span><span>Usuários</span></div>
        <div class="nav-item" onclick="showSection('sources')"><span>🔗</span><span>Fontes M3U</span></div>
        <div class="nav-item" onclick="showSection('content')"><span>🎬</span><span>Conteúdo</span></div>
        <div class="nav-item" onclick="showSection('settings')"><span>⚙️</span><span>Configurações</span></div>
        <div class="nav-item" onclick="logout()" style="margin-top: auto;"><span>🚪</span><span>Sair</span></div>
    </div>

    <div class="main-content">
        <div id="dashboard-section">
            <div class="header">
                <h1>📊 Dashboard</h1>
                <div class="user-info"><span id="currentDate"></span><div class="user-avatar">A</div></div>
            </div>
            <div class="stats-grid">
                <div class="stat-card"><h3>Total de Usuários</h3><div class="number" id="totalUsers">0</div></div>
                <div class="stat-card"><h3>Usuários Ativos</h3><div class="number" id="activeUsers">0</div></div>
                <div class="stat-card"><h3>Testes Ativos</h3><div class="number" id="trialUsers">0</div></div>
                <div class="stat-card"><h3>Expirados</h3><div class="number" id="expiredUsers">0</div></div>
                <div class="stat-card"><h3>Canais / Filmes / Séries</h3><div class="number" id="totalContent">0/0/0</div></div>
                <div class="stat-card"><h3>Fontes M3U</h3><div class="number" id="totalSources">0</div></div>
            </div>
            <div class="section">
                <h2>📈 Usuários Recentes</h2>
                <table class="data-table" id="recentUsersTable"><thead><tr><th>Usuário</th><th>Tipo</th><th>Criado em</th><th>Expira em</th><th>Status</th></tr></thead><tbody></tbody></table>
            </div>
        </div>

        <div id="users-section" class="hidden">
            <div class="header">
                <h1>👥 Gerenciar Usuários</h1>
                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-warning" onclick="openModal('createTrial')">⚡ Criar Teste</button>
                    <button class="btn btn-primary" onclick="openModal('createUser')">+ Novo Usuário</button>
                </div>
            </div>
            <div class="section">
                <input type="text" class="form-group input" style="max-width: 400px; margin-bottom: 20px;" id="searchUsers" placeholder="🔍 Buscar usuários..." onkeyup="searchUsers()">
                <table class="data-table" id="usersTable"><thead><tr><th>Usuário</th><th>Senha</th><th>Tipo</th><th>Criado</th><th>Expira</th><th>Conexões</th><th>Status</th><th>Ações</th></tr></thead><tbody></tbody></table>
            </div>
        </div>

        <div id="sources-section" class="hidden">
            <div class="header"><h1>🔗 Fontes M3U</h1><button class="btn btn-primary" onclick="openModal('addSource')">+ Adicionar Fonte</button></div>
            <div class="section"><h2>Fontes Configuradas</h2><div id="sourcesList"></div></div>
            <div class="section"><h2>🔄 Ações em Massa</h2><button class="btn btn-success" onclick="reloadAllSources()">🔄 Recarregar Todas</button></div>
        </div>

        <div id="content-section" class="hidden">
            <div class="header"><h1>🎬 Conteúdo</h1><button class="btn btn-primary" onclick="reloadAllSources()">🔄 Recarregar</button></div>
            <div class="stats-grid">
                <div class="stat-card"><h3>📺 Canais Ao Vivo</h3><div class="number" id="liveCount">0</div></div>
                <div class="stat-card"><h3>🎬 Filmes</h3><div class="number" id="vodCount">0</div></div>
                <div class="stat-card"><h3>📺 Séries</h3><div class="number" id="seriesCount">0</div></div>
            </div>
            <div class="section"><h2>Categorias de Canais</h2><div id="liveCategories"></div></div>
        </div>

        <div id="settings-section" class="hidden">
            <div class="header"><h1>⚙️ Configurações</h1></div>
            <div class="section">
                <h2>Configurações do Servidor</h2>
                <div class="form-group"><label>Nome do Servidor</label><input type="text" id="serverName" value="${db.settings.serverName}"></div>
                <div class="form-group"><label>Dias padrão de expiração</label><input type="number" id="defaultExpiry" value="${db.settings.defaultExpiryDays}"></div>
                <div class="form-group"><label>Conexões simultâneas padrão</label><input type="number" id="defaultConnections" value="${db.settings.defaultMaxConnections}"></div>
                <button class="btn btn-success" onclick="saveSettings()">Salvar</button>
            </div>
            <div class="section"><h2>🚀 Deploy</h2><button class="btn btn-primary" onclick="triggerDeploy()">Acionar Deploy no Render</button></div>
        </div>
    </div>

    <!-- Modal: Add Source Step 1 -->
    <div id="addSourceModal" class="modal">
        <div class="modal-content">
            <div class="modal-header"><h2>🔗 Adicionar Fonte M3U - Etapa 1/2</h2><button class="btn btn-danger" onclick="closeModal('addSource')" style="padding: 5px 15px;">✕</button></div>
            <div class="modal-body">
                <form id="addSourceForm">
                    <div class="form-group"><label>Nome da Fonte</label><input type="text" id="sourceName" placeholder="Ex: Lista Premium" required></div>
                    <div class="form-group"><label>URL da Lista M3U</label><input type="url" id="sourceUrl" placeholder="http://exemplo.com/lista.m3u" required></div>
                    <label style="color: var(--neon-blue); font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin: 20px 0 15px; display: block; font-weight: 700;">📋 Conteúdos a Importar</label>
                    <div class="checkbox-grid">
                        <label class="checkbox-item"><input type="checkbox" id="importLive" checked><span>📺 Canais Ao Vivo</span></label>
                        <label class="checkbox-item"><input type="checkbox" id="importVod" checked><span>🎬 Filmes (VOD)</span></label>
                        <label class="checkbox-item"><input type="checkbox" id="importSeries" checked><span>📺 Séries</span></label>
                    </div>
                </form>
                <div id="categoryPreview" class="preview-section" style="display: none;">
                    <div class="preview-header"><span class="preview-title">👁️ Categorias Encontradas</span><span class="category-count" id="categoryCount"></span></div>
                    <div class="category-list" id="previewContent"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-primary" onclick="previewCategories()">🔍 Analisar Categorias</button>
                <button class="btn btn-success" onclick="handleAddSource()">Adicionar Fonte</button>
            </div>
        </div>
    </div>

    <!-- Modal: Create User -->
    <div id="createUserModal" class="modal">
        <div class="modal-content">
            <div class="modal-header"><h2>👤 Criar Usuário</h2><button class="btn btn-danger" onclick="closeModal('createUser')" style="padding: 5px 15px;">✕</button></div>
            <div class="modal-body">
                <form id="createUserForm">
                    <div class="form-group"><label>Usuário (vazio = auto)</label><input type="text" id="newUsername" placeholder="user123"></div>
                    <div class="form-group"><label>Senha (vazio = auto)</label><input type="text" id="newPassword" placeholder="senha123"></div>
                    <div class="form-group"><label>Dias de validade</label><input type="number" id="newExpiry" value="30" min="1"></div>
                    <div class="form-group"><label>Máximo de conexões</label><input type="number" id="newMaxConn" value="1" min="1"></div>
                    <div class="form-group"><label>Notas</label><input type="text" id="newNotes" placeholder="Cliente XYZ"></div>
                </form>
            </div>
            <div class="modal-footer"><button class="btn btn-primary" onclick="closeModal('createUser')">Cancelar</button><button class="btn btn-success" onclick="submitCreateUser()">Criar Usuário</button></div>
        </div>
    </div>

    <!-- Modal: Create Trial -->
    <div id="createTrialModal" class="modal">
        <div class="modal-content">
            <div class="modal-header"><h2>⚡ Criar Teste (1 Hora)</h2><button class="btn btn-danger" onclick="closeModal('createTrial')" style="padding: 5px 15px;">✕</button></div>
            <div class="modal-body">
                <form id="createTrialForm">
                    <div class="form-group"><label>Usuário (vazio = auto)</label><input type="text" id="trialUsername" placeholder="trial123"></div>
                    <div class="form-group"><label>Senha (vazio = auto)</label><input type="text" id="trialPassword" placeholder="senha"></div>
                    <div class="form-group"><label>Máximo de conexões</label><input type="number" id="trialMaxConn" value="1" min="1"></div>
                    <div class="form-group"><label>Notas</label><input type="text" id="trialNotes" placeholder="Teste cliente"></div>
                    <p style="color: var(--neon-orange); margin-top: 15px; font-size: 14px;">⚠️ Esta conta expirará automaticamente em 1 hora!</p>
                </form>
            </div>
            <div class="modal-footer"><button class="btn btn-primary" onclick="closeModal('createTrial')">Cancelar</button><button class="btn btn-warning" onclick="submitCreateTrial()">⚡ Criar Teste</button></div>
        </div>
    </div>

    <!-- Modal: Edit User -->
    <div id="editUserModal" class="modal">
        <div class="modal-content">
            <div class="modal-header"><h2>✏️ Editar Usuário</h2><button class="btn btn-danger" onclick="closeModal('editUser')" style="padding: 5px 15px;">✕</button></div>
            <div class="modal-body">
                <form id="editUserForm">
                    <input type="hidden" id="editUserId">
                    <div class="form-group"><label>Usuário</label><input type="text" id="editUsername" readonly style="opacity: 0.5;"></div>
                    <div class="form-group"><label>Nova Senha (vazio = manter)</label><input type="text" id="editPassword" placeholder="Nova senha"></div>
                    <div class="form-group"><label>Data de vencimento</label><input type="date" id="editExpiry"></div>
                    <div class="form-group"><label>Máximo de conexões</label><input type="number" id="editMaxConn" min="1"></div>
                    <div class="form-group"><label>Status</label><select id="editStatus"><option value="Active">Ativo</option><option value="Inactive">Inativo</option><option value="Banned">Banido</option></select></div>
                    <div class="form-group"><label>Notas</label><input type="text" id="editNotes"></div>
                </form>
            </div>
            <div class="modal-footer"><button class="btn btn-primary" onclick="closeModal('editUser')">Cancelar</button><button class="btn btn-success" onclick="submitEditUser()">Salvar</button></div>
        </div>
    </div>

    <script>
        let currentSection = 'dashboard', users = [], sources = [], tempCategories = [], selectedCategories = new Set();
        
        if (!localStorage.getItem('adminToken')) window.location.href = '/admin';
        
        document.addEventListener('DOMContentLoaded', () => {
            loadDashboard(); loadUsers(); loadSources();
            updateDate(); setInterval(updateDate, 60000);
        });
        
        function updateDate() {
            const date = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const el = document.getElementById('currentDate');
            if (el) el.textContent = date;
        }
        
        function showSection(section) {
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            event.currentTarget.classList.add('active');
            ['dashboard', 'users', 'sources', 'content', 'settings'].forEach(s => document.getElementById(s + '-section').classList.add('hidden'));
            document.getElementById(section + '-section').classList.remove('hidden');
            currentSection = section;
            if (section === 'dashboard') loadDashboard();
            if (section === 'users') loadUsers();
            if (section === 'sources') loadSources();
            if (section === 'content') loadContent();
        }
        
        function openModal(modal) { document.getElementById(modal + 'Modal').style.display = 'flex'; }
        function closeModal(modal) { document.getElementById(modal + 'Modal').style.display = 'none'; }
        
        async function loadDashboard() {
            try {
                const res = await fetch('/admin/api/stats', { headers: { 'Authorization': localStorage.getItem('adminToken') } });
                if (res.status === 401) { logout(); return; }
                const data = await res.json();
                document.getElementById('totalUsers').textContent = data.totalUsers;
                document.getElementById('activeUsers').textContent = data.activeUsers;
                document.getElementById('trialUsers').textContent = data.trialUsers;
                document.getElementById('expiredUsers').textContent = data.expiredUsers;
                document.getElementById('totalContent').textContent = `${data.content.live}/${data.content.vod}/${data.content.series}`;
                document.getElementById('totalSources').textContent = data.totalSources;
                
                const tbody = document.querySelector('#recentUsersTable tbody');
                tbody.innerHTML = data.recentUsers.map(u => {
                    const isExpired = new Date(u.expiresAt) < new Date() && u.expiresAt !== 'never';
                    const statusClass = isExpired ? 'status-expired' : 'status-active';
                    const statusText = isExpired ? 'EXPIRADO' : 'ATIVO';
                    const badge = u.isTrial ? '<span class="badge badge-trial">TESTE</span>' : u.isAdmin ? '<span class="badge badge-admin">ADMIN</span>' : '<span class="badge badge-user">USER</span>';
                    return `<tr><td><strong>${u.username}</strong></td><td>${badge}</td><td>${new Date(u.createdAt).toLocaleDateString('pt-BR')}</td><td>${u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')}</td><td class="${statusClass}">${statusText}</td></tr>`;
                }).join('');
            } catch (e) { console.error('Erro:', e); }
        }
        
        async function loadUsers() {
            try {
                const res = await fetch('/admin/api/users', { headers: { 'Authorization': localStorage.getItem('adminToken') } });
                if (res.status === 401) { logout(); return; }
                users = await res.json();
                renderUsers(users);
            } catch (e) { console.error('Erro:', e); }
        }
        
        function renderUsers(list) {
            const tbody = document.querySelector('#usersTable tbody');
            tbody.innerHTML = list.map(u => {
                const isExpired = new Date(u.expiresAt) < new Date() && u.expiresAt !== 'never';
                const statusClass = isExpired ? 'status-expired' : (u.status === 'Active' ? 'status-active' : 'status-expired');
                const statusText = isExpired ? 'EXPIRADO' : u.status.toUpperCase();
                const badge = u.isTrial ? '<span class="badge badge-trial">TESTE</span>' : u.isAdmin ? '<span class="badge badge-admin">ADMIN</span>' : '<span class="badge badge-user">USER</span>';
                return `<tr><td><strong>${u.username}</strong></td><td><span style="cursor: pointer;" onclick="copyToClipboard('${u.password}')" title="Copiar">${u.password.substring(0, 8)}...</span></td><td>${badge}</td><td>${new Date(u.createdAt).toLocaleDateString('pt-BR')}</td><td>${u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')}</td><td>${u.activeConnections}/${u.maxConnections}</td><td class="${statusClass}">${statusText}</td><td><button class="btn btn-success" onclick="copyLink('${u.username}', '${u.password}')" style="padding: 5px 10px; font-size: 12px;">🔗</button><button class="btn btn-primary" onclick="editUser('${u.id}')" style="padding: 5px 10px; font-size: 12px;">✏️</button>${!u.isAdmin ? `<button class="btn btn-danger" onclick="deleteUser('${u.id}')" style="padding: 5px 10px; font-size: 12px;">🗑️</button>` : ''}</td></tr>`;
            }).join('');
        }
        
        function searchUsers() {
            const term = document.getElementById('searchUsers').value.toLowerCase();
            renderUsers(users.filter(u => u.username.toLowerCase().includes(term) || (u.notes && u.notes.toLowerCase().includes(term))));
        }
        
        async function submitCreateUser() {
            const data = {
                username: document.getElementById('newUsername').value,
                password: document.getElementById('newPassword').value,
                expiryDays: parseInt(document.getElementById('newExpiry').value),
                maxConnections: parseInt(document.getElementById('newMaxConn').value),
                notes: document.getElementById('newNotes').value
            };
            const res = await fetch('/admin/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
                alert(`✅ Usuário criado!\\nUsuário: ${result.user.username}\\nSenha: ${result.user.password}`);
                closeModal('createUser'); loadUsers(); loadDashboard();
                document.getElementById('createUserForm').reset();
            } else alert('❌ Erro: ' + result.error);
        }
        
        async function submitCreateTrial() {
            const data = {
                username: document.getElementById('trialUsername').value,
                password: document.getElementById('trialPassword').value,
                maxConnections: parseInt(document.getElementById('trialMaxConn').value),
                notes: document.getElementById('trialNotes').value
            };
            const res = await fetch('/admin/api/users/trial', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
                alert(`⚡ Teste criado!\\nUsuário: ${result.user.username}\\nSenha: ${result.user.password}\\n\\n⏰ Expira em 1 hora!`);
                closeModal('createTrial'); loadUsers(); loadDashboard();
                document.getElementById('createTrialForm').reset();
            } else alert('❌ Erro: ' + result.error);
        }
        
        function editUser(id) {
            const user = users.find(u => u.id === id);
            if (!user) return;
            document.getElementById('editUserId').value = user.id;
            document.getElementById('editUsername').value = user.username;
            document.getElementById('editPassword').value = '';
            document.getElementById('editExpiry').value = user.expiresAt === 'never' ? '' : user.expiresAt;
            document.getElementById('editMaxConn').value = user.maxConnections;
            document.getElementById('editStatus').value = user.status;
            document.getElementById('editNotes').value = user.notes || '';
            openModal('editUser');
        }
        
        async function submitEditUser() {
            const id = document.getElementById('editUserId').value;
            const data = {
                password: document.getElementById('editPassword').value,
                expiresAt: document.getElementById('editExpiry').value || 'never',
                maxConnections: parseInt(document.getElementById('editMaxConn').value),
                status: document.getElementById('editStatus').value,
                notes: document.getElementById('editNotes').value
            };
            const res = await fetch('/admin/api/users/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) { closeModal('editUser'); loadUsers(); loadDashboard(); }
            else alert('❌ Erro: ' + result.error);
        }
        
        async function deleteUser(id) {
            if (!confirm('Tem certeza que deseja excluir este usuário?')) return;
            const res = await fetch('/admin/api/users/' + id, { method: 'DELETE', headers: { 'Authorization': localStorage.getItem('adminToken') } });
            const result = await res.json();
            if (result.success) { loadUsers(); loadDashboard(); }
            else alert('❌ Erro: ' + result.error);
        }
        
        async function loadSources() {
            const res = await fetch('/admin/api/sources', { headers: { 'Authorization': localStorage.getItem('adminToken') } });
            if (res.status === 401) { logout(); return; }
            sources = await res.json();
            const container = document.getElementById('sourcesList');
            if (sources.length === 0) { container.innerHTML = '<p style="color: rgba(255,255,255,0.5);">Nenhuma fonte configurada</p>'; return; }
            container.innerHTML = sources.map(s => {
                const statusClass = s.status === 'active' ? 'success' : 'error';
                const statusText = s.status === 'active' ? 'ATIVO' : 'ERRO';
                return `<div class="source-card ${statusClass}"><div class="source-header"><span class="source-name">${s.name}</span><span class="source-status ${s.status}">${statusText}</span></div><div class="source-url">${s.url.substring(0, 60)}...</div><div class="source-meta"><span>📺 ${s.contentTypes?.join(', ') || 'Todos'}</span><span>🕐 ${s.lastUpdate ? new Date(s.lastUpdate).toLocaleString('pt-BR') : 'Nunca'}</span></div><div style="margin-top: 15px;"><button class="btn btn-danger" onclick="deleteSource('${s.id}')" style="padding: 5px 15px; font-size: 12px;">🗑️ Remover</button></div></div>`;
            }).join('');
        }
        
        async function previewCategories() {
            const url = document.getElementById('sourceUrl').value;
            if (!url) { alert('Digite uma URL primeiro!'); return; }
            const previewDiv = document.getElementById('categoryPreview');
            const contentDiv = document.getElementById('previewContent');
            const countSpan = document.getElementById('categoryCount');
            previewDiv.style.display = 'block';
            contentDiv.innerHTML = '<div class="loading"></div> Analisando...';
            
            try {
                const res = await fetch('/admin/api/preview-m3u', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                    body: JSON.stringify({ url })
                });
                const data = await res.json();
                if (data.success) {
                    tempCategories = data.categories;
                    countSpan.textContent = `${data.total} categorias`;
                    contentDiv.innerHTML = data.categories.map((c, idx) => `
                        <div class="category-item ${selectedCategories.has(idx) ? 'selected' : ''}" onclick="toggleCategory(${idx})" data-idx="${idx}">
                            <div class="custom-checkbox ${selectedCategories.has(idx) ? 'checked' : ''}"></div>
                            <div class="category-info">
                                <h4>${c.name}</h4>
                                <p>${c.count} itens • ${c.type.toUpperCase()}</p>
                            </div>
                        </div>
                    `).join('');
                } else contentDiv.innerHTML = '<span style="color: var(--neon-pink);">Erro: ' + data.error + '</span>';
            } catch (e) { contentDiv.innerHTML = '<span style="color: var(--neon-pink);">Erro ao analisar</span>'; }
        }
        
        function toggleCategory(idx) {
            const item = document.querySelector(`.category-item[data-idx="${idx}"]`);
            if (selectedCategories.has(idx)) {
                selectedCategories.delete(idx);
                item.classList.remove('selected');
                item.querySelector('.custom-checkbox').classList.remove('checked');
            } else {
                selectedCategories.add(idx);
                item.classList.add('selected');
                item.querySelector('.custom-checkbox').classList.add('checked');
            }
        }
        
        async function handleAddSource() {
            const data = {
                name: document.getElementById('sourceName').value,
                url: document.getElementById('sourceUrl').value,
                contentTypes: [],
                selectedCategories: Array.from(selectedCategories).map(idx => tempCategories[idx]?.name).filter(Boolean)
            };
            if (document.getElementById('importLive').checked) data.contentTypes.push('live');
            if (document.getElementById('importVod').checked) data.contentTypes.push('vod');
            if (document.getElementById('importSeries').checked) data.contentTypes.push('series');
            if (!data.name || !data.url) { alert('Preencha nome e URL!'); return; }
            if (data.contentTypes.length === 0) { alert('Selecione pelo menos um tipo!'); return; }
            
            const res = await fetch('/admin/api/sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
                alert('✅ Fonte adicionada! Recarregando conteúdo...');
                closeModal('addSource'); loadSources(); loadDashboard();
                document.getElementById('addSourceForm').reset();
                document.getElementById('categoryPreview').style.display = 'none';
                selectedCategories.clear();
                reloadAllSources();
            } else alert('❌ Erro: ' + result.error);
        }
        
        async function deleteSource(id) {
            if (!confirm('Remover esta fonte?')) return;
            const res = await fetch('/admin/api/sources/' + id, { method: 'DELETE', headers: { 'Authorization': localStorage.getItem('adminToken') } });
            const result = await res.json();
            if (result.success) { loadSources(); loadDashboard(); reloadAllSources(); }
        }
        
        async function reloadAllSources() {
            const res = await fetch('/admin/api/reload-m3u', { method: 'POST', headers: { 'Authorization': localStorage.getItem('adminToken') } });
            const result = await res.json();
            if (result.success) {
                alert(`✅ Recarregado!\\n📺 ${result.stats.live} Canais\\n🎬 ${result.stats.vod} Filmes\\n📺 ${result.stats.series} Séries`);
                loadDashboard(); loadContent();
            } else alert('❌ Erro: ' + result.error);
        }
        
        async function loadContent() {
            const res = await fetch('/admin/api/stats', { headers: { 'Authorization': localStorage.getItem('adminToken') } });
            const data = await res.json();
            document.getElementById('liveCount').textContent = data.content.live;
            document.getElementById('vodCount').textContent = data.content.vod;
            document.getElementById('seriesCount').textContent = data.content.series;
        }
        
        async function saveSettings() {
            const data = {
                serverName: document.getElementById('serverName').value,
                defaultExpiryDays: parseInt(document.getElementById('defaultExpiry').value),
                defaultMaxConnections: parseInt(document.getElementById('defaultConnections').value)
            };
            const res = await fetch('/admin/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) alert('✅ Configurações salvas!');
        }
        
        async function triggerDeploy() {
            const res = await fetch('/admin/api/deploy', { method: 'POST', headers: { 'Authorization': localStorage.getItem('adminToken') } });
            const result = await res.json();
            if (result.success) alert('🚀 Deploy acionado!'); else alert('❌ Erro no deploy');
        }
        
        function copyToClipboard(text) { navigator.clipboard.writeText(text); alert('📋 Copiado: ' + text); }
        function copyLink(username, password) { copyToClipboard(`${window.location.origin}/get.php?username=${username}&password=${password}&type=m3u_plus`); }
        function logout() { localStorage.removeItem('adminToken'); window.location.href = '/admin'; }
        window.onclick = function(event) { if (event.target.classList.contains('modal')) event.target.style.display = 'none'; }
    </script>
</body>
</html>`);
});

// ==================== APIs ADMIN ====================

app.get("/admin/api/stats", verifyToken, (req, res) => {
    const totalUsers = db.users.length;
    const activeUsers = db.users.filter(u => !isExpired(u) && u.status === "Active" && !u.isTrial).length;
    const trialUsers = db.users.filter(u => u.isTrial && !isExpired(u)).length;
    const expiredUsers = db.users.filter(u => isExpired(u)).length;
    const recentUsers = [...db.users].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    res.json({ totalUsers, activeUsers, trialUsers, expiredUsers, totalSources: m3uSources.length, content: { live: live.length, vod: vod.length, series: Object.keys(series).length }, recentUsers });
});

app.get("/admin/api/users", verifyToken, (req, res) => res.json(db.users.map(u => ({ ...u, isExpired: isExpired(u) }))));

app.post("/admin/api/users", verifyToken, async (req, res) => {
    const { username, password, expiryDays, maxConnections, notes } = req.body;
    const finalUsername = username || "user" + Math.floor(Math.random() * 10000);
    const finalPassword = password || generatePassword();
    if (db.users.find(u => u.username === finalUsername)) return res.json({ success: false, error: "Usuário já existe" });
    const newUser = { id: generateId(), username: finalUsername, password: finalPassword, isAdmin: false, isTrial: false, createdAt: new Date().toISOString(), expiresAt: expiryDays ? calculateExpiryDate(expiryDays) : "never", maxConnections: maxConnections || db.settings.defaultMaxConnections, activeConnections: 0, status: "Active", notes: notes || "" };
    db.users.push(newUser);
    saveDatabase();
    await triggerRenderDeploy();
    res.json({ success: true, user: newUser });
});

app.post("/admin/api/users/trial", verifyToken, async (req, res) => {
    const { username, password, maxConnections, notes } = req.body;
    const finalUsername = username || "trial" + Math.floor(Math.random() * 10000);
    const finalPassword = password || generatePassword(6);
    if (db.users.find(u => u.username === finalUsername)) return res.json({ success: false, error: "Usuário já existe" });
    const trialUser = { id: generateId(), username: finalUsername, password: finalPassword, isAdmin: false, isTrial: true, createdAt: new Date().toISOString(), expiresAt: calculateTrialExpiry(), maxConnections: maxConnections || 1, activeConnections: 0, status: "Active", notes: notes || "Conta de teste 1 hora" };
    db.users.push(trialUser);
    saveDatabase();
    await triggerRenderDeploy();
    res.json({ success: true, user: trialUser });
});

app.put("/admin/api/users/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const userIndex = db.users.findIndex(u => u.id === id);
    if (userIndex === -1) return res.json({ success: false, error: "Usuário não encontrado" });
    const { password, expiresAt, maxConnections, status, notes } = req.body;
    if (password) db.users[userIndex].password = password;
    if (expiresAt) db.users[userIndex].expiresAt = expiresAt;
    if (maxConnections) db.users[userIndex].maxConnections = maxConnections;
    if (status) db.users[userIndex].status = status;
    if (notes !== undefined) db.users[userIndex].notes = notes;
    saveDatabase();
    await triggerRenderDeploy();
    res.json({ success: true, user: db.users[userIndex] });
});

app.delete("/admin/api/users/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const userIndex = db.users.findIndex(u => u.id === id);
    if (userIndex === -1) return res.json({ success: false, error: "Usuário não encontrado" });
    if (db.users[userIndex].isAdmin) return res.json({ success: false, error: "Não pode deletar admin" });
    db.users.splice(userIndex, 1);
    saveDatabase();
    await triggerRenderDeploy();
    res.json({ success: true });
});

app.get("/admin/api/sources", verifyToken, (req, res) => res.json(m3uSources));

app.post("/admin/api/preview-m3u", verifyToken, async (req, res) => {
    const { url } = req.body;
    try {
        const content = await downloadM3U(url);
        const items = parseM3UToItems(content, 'preview');
        const categories = {};
        items.forEach(item => {
            if (!categories[item.originalGroup]) categories[item.originalGroup] = { count: 0, type: item.type };
            categories[item.originalGroup].count++;
        });
        const cats = Object.entries(categories).map(([name, data]) => ({ name, count: data.count, type: data.type }));
        res.json({ success: true, categories: cats, total: cats.length });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

app.post("/admin/api/sources", verifyToken, async (req, res) => {
    const { name, url, contentTypes, selectedCategories } = req.body;
    try {
        await downloadM3U(url);
        const source = { id: generateId(), name, url, contentTypes: contentTypes || ['live', 'vod', 'series'], selectedCategories: selectedCategories || [], enabled: true, lastUpdate: null, status: 'active' };
        m3uSources.push(source);
        saveM3USources();
        res.json({ success: true, source });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

app.delete("/admin/api/sources/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const index = m3uSources.findIndex(s => s.id === id);
    if (index !== -1) {
        m3uSources.splice(index, 1);
        saveM3USources();
        await reloadAllSources();
        await triggerRenderDeploy();
        return res.json({ success: true });
    }
    res.json({ success: false, error: "Fonte não encontrada" });
});

app.post("/admin/api/reload-m3u", verifyToken, async (req, res) => {
    try { const stats = await reloadAllSources(); res.json({ success: true, stats }); }
    catch (error) { res.json({ success: false, error: error.message }); }
});

app.post("/admin/api/deploy", verifyToken, async (req, res) => { const result = await triggerRenderDeploy(); res.json(result); });

app.put("/admin/api/settings", verifyToken, (req, res) => {
    const { serverName, defaultExpiryDays, defaultMaxConnections } = req.body;
    db.settings.serverName = serverName || db.settings.serverName;
    db.settings.defaultExpiryDays = defaultExpiryDays || db.settings.defaultExpiryDays;
    db.settings.defaultMaxConnections = defaultMaxConnections || db.settings.defaultMaxConnections;
    saveDatabase();
    res.json({ success: true, settings: db.settings });
});

// ==================== INICIALIZAÇÃO ====================

async function initialize() {
    loadDatabase();
    loadM3USources();
    await reloadAllSources();
    app.listen(PORT, () => {
        console.log("========================================");
        console.log("🚀 SERVIDOR IPTV PRO RODANDO");
        console.log(`📡 Porta: ${PORT}`);
        console.log(`💾 Banco: ${DB_FILE}`);
        console.log(`🔗 Fontes: ${m3uSources.length}`);
        console.log("========================================");
        console.log(`➜ Painel: http://localhost:${PORT}/admin`);
        console.log("========================================");
    });
}

initialize();
