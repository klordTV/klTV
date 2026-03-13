const fs = require("fs");
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

// Middleware essenciais
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PUT");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === "OPTIONS") {
        return res.sendStatus(200);
    }
    next();
});

// Banco de dados simples (JSON)
const DB_FILE = path.join(__dirname, "database.json");

// Estrutura inicial do banco
let db = {
    users: [],
    settings: {
        serverName: "Meu Servidor IPTV",
        maxConcurrentConnections: 1000,
        defaultExpiryDays: 30,
        defaultMaxConnections: 1
    }
};

// Gerenciar tokens ativos (sessões)
let activeTokens = new Set();

// Carregar banco de dados
function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, "utf8");
            db = JSON.parse(data);
            console.log("💾 Banco de dados carregado");
            
            // Verificar se admin existe, se não criar
            const adminExists = db.users.find(u => u.isAdmin === true);
            if (!adminExists) {
                console.log("⚠️ Admin não encontrado, criando novo...");
                createDefaultAdmin();
            } else {
                console.log("✅ Admin encontrado:", adminExists.username);
            }
        } else {
            console.log("⚠️ Banco de dados não existe, criando novo...");
            createDefaultAdmin();
        }
    } catch (error) {
        console.error("Erro ao carregar banco:", error);
        createDefaultAdmin();
    }
}

// Criar admin padrão
function createDefaultAdmin() {
    // Remover qualquer admin existente para garantir
    db.users = db.users.filter(u => !u.isAdmin);
    
    const adminUser = {
        id: "admin",
        username: "klord",
        password: "Kl0rd777",
        isAdmin: true,
        createdAt: new Date().toISOString(),
        expiresAt: "never",
        maxConnections: 999,
        activeConnections: 0,
        status: "Active",
        notes: "Administrador do sistema"
    };
    
    db.users.push(adminUser);
    saveDatabase();
    console.log("✅ Admin criado: klord / Kl0rd777");
}

// Salvar banco de dados
function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("Erro ao salvar banco:", error);
    }
}

// Gerar ID único
function generateId() {
    return crypto.randomBytes(8).toString("hex");
}

// Gerar senha aleatória
function generatePassword(length = 8) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let password = "";
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

// Calcular data de vencimento
function calculateExpiryDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + parseInt(days));
    return date.toISOString().split("T")[0];
}

// Verificar se usuário expirou
function isExpired(user) {
    if (user.expiresAt === "never") return false;
    return new Date(user.expiresAt) < new Date();
}

// ==================== DADOS IPTV ====================

let live = [];
let vod = [];
let series = {};
let categories = {
    live: [],
    vod: [],
    series: []
};

let groupToId = {};
let catIdCounters = {
    live: 1,
    vod: 1,
    series: 1
};

function parseM3U() {
    try {
        const filePath = path.join(__dirname, "playlist.m3u");
        
        if (!fs.existsSync(filePath)) {
            console.error("⚠️  Arquivo playlist.m3u não encontrado!");
            return;
        }

        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        
        let current = null;
        let id = 1;

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
                let group = groupMatch ? groupMatch[1] : "OUTROS";
                
                const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
                let icon = logoMatch ? logoMatch[1] : "";

                current = {
                    id: id++,
                    name: name,
                    group: group,
                    icon: icon,
                    rawLine: line
                };
            }
            else if (line.startsWith("http") && current) {
                current.url = line;
                const groupUpper = current.group.toUpperCase();
                
                if (groupUpper.startsWith("FILMES") || groupUpper.startsWith("FILME")) {
                    parseMovie(current);
                }
                else if (groupUpper.startsWith("-SERIES") || groupUpper.startsWith("SERIES") || groupUpper.startsWith("SÉRIES")) {
                    parseSeries(current);
                }
                else if (groupUpper.startsWith("CANAIS") || groupUpper.startsWith("CANAL")) {
                    parseLive(current);
                }
                else {
                    if (current.name.match(/S\d+E\d+/i)) {
                        parseSeries(current);
                    } else {
                        parseLive(current);
                    }
                }
                current = null;
            }
        }

        console.log("✅ Parser concluído:");
        console.log(`   Canais: ${live.length} (categorias: ${categories.live.length})`);
        console.log(`   Filmes: ${vod.length} (categorias: ${categories.vod.length})`);
        console.log(`   Séries: ${Object.keys(series).length} (categorias: ${categories.series.length})`);
        
    } catch (error) {
        console.error("ERRO ao parsear M3U:", error.message);
    }
}

function getOrCreateCategory(group, type) {
    if (!groupToId[group]) {
        const catId = catIdCounters[type].toString();
        groupToId[group] = catId;
        catIdCounters[type]++;
        
        const parts = group.split("|");
        const catName = parts[1] ? parts[1].trim() : group;
        
        const catObj = {
            category_id: catId,
            category_name: catName,
            parent_id: 0
        };
        
        if (type === "live") categories.live.push(catObj);
        else if (type === "vod") categories.vod.push(catObj);
        else if (type === "series") categories.series.push(catObj);
    }
    return groupToId[group];
}

function parseLive(item) {
    const categoryId = getOrCreateCategory(item.group, "live");
    
    live.push({
        num: live.length + 1,
        name: item.name,
        stream_type: "live",
        stream_id: item.id.toString(),
        stream_icon: item.icon,
        epg_channel_id: "",
        added: Math.floor(Date.now() / 1000).toString(),
        category_id: categoryId,
        custom_sid: "",
        tv_archive: 0,
        direct_source: item.url,
        tv_archive_duration: 0
    });
}

function parseMovie(item) {
    const categoryId = getOrCreateCategory(item.group, "vod");
    const yearMatch = item.name.match(/\((\d{4})\)$/);
    const year = yearMatch ? yearMatch[1] : "";
    const cleanName = item.name.replace(/\s*\(\d{4}\)$/, "").trim();
    
    vod.push({
        num: vod.length + 1,
        name: cleanName,
        stream_type: "movie",
        stream_id: item.id.toString(),
        stream_icon: item.icon,
        added: Math.floor(Date.now() / 1000).toString(),
        category_id: categoryId,
        container_extension: "mp4",
        custom_sid: "",
        direct_source: item.url,
        releaseDate: year
    });
}

function parseSeries(item) {
    const categoryId = getOrCreateCategory(item.group, "series");
    const match = item.name.match(/S(\d+)E(\d+)/i);
    if (!match) {
        console.log(`⚠️  Episódio não reconhecido: ${item.name}`);
        return;
    }
    
    const season = parseInt(match[1]);
    const episode = parseInt(match[2]);
    let serieName = item.name.substring(0, match.index).trim();
    serieName = serieName.replace(/[\s\-|]+$/, "").trim();

    if (!series[serieName]) {
        series[serieName] = {
            series_id: (Object.keys(series).length + 1).toString(),
            name: serieName,
            cover: item.icon || "",
            plot: "",
            cast: "",
            director: "",
            genre: "",
            releaseDate: "",
            last_modified: Math.floor(Date.now() / 1000),
            category_id: categoryId,
            seasons: {}
        };
    }

    if (!series[serieName].seasons[season]) {
        series[serieName].seasons[season] = [];
    }

    const exists = series[serieName].seasons[season].some(e => e.episode_num === episode);
    if (exists) {
        console.log(`⚠️  Episódio duplicado ignorado: ${item.name}`);
        return;
    }

    series[serieName].seasons[season].push({
        id: item.id.toString(),
        episode_num: episode,
        title: `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`,
        container_extension: "mp4",
        info: {
            movie_image: item.icon,
            plot: "",
            releasedate: "",
            duration_secs: 0,
            duration: ""
        },
        url: item.url
    });
}

// ==================== API IPTV (Xtream Codes) ====================

app.get("/player_api.php", (req, res) => {
    const { username, password, action } = req.query;
    const user = db.users.find(u => u.username === username && u.password === password);
    
    if (!user) {
        return res.json({ user_info: { auth: 0, status: "Invalid" } });
    }

    if (isExpired(user)) {
        return res.json({ 
            user_info: { 
                auth: 0, 
                status: "Expired",
                message: "Sua assinatura expirou"
            } 
        });
    }

    if (!action) {
        user.activeConnections++;
        saveDatabase();
        
        return res.json({
            user_info: {
                username: user.username,
                password: user.password,
                message: "",
                auth: 1,
                status: user.status,
                exp_date: user.expiresAt === "never" ? "1758143248" : Math.floor(new Date(user.expiresAt).getTime() / 1000).toString(),
                is_trial: "0",
                active_cons: user.activeConnections.toString(),
                created_at: Math.floor(new Date(user.createdAt).getTime() / 1000).toString(),
                max_connections: user.maxConnections.toString(),
                allowed_output_formats: ["m3u8", "ts", "mp4"]
            },
            server_info: {
                url: req.hostname,
                port: PORT.toString(),
                https_port: "",
                server_protocol: "http",
                rtmp_port: "0",
                timezone: "America/Sao_Paulo",
                timestamp_now: Math.floor(Date.now() / 1000),
                time_now: new Date().toISOString().replace('T', ' ').substring(0, 19),
                process: true
            }
        });
    }

    if (action === "get_live_categories") return res.json(categories.live);
    if (action === "get_vod_categories") return res.json(categories.vod);
    if (action === "get_series_categories") return res.json(categories.series);
    if (action === "get_live_streams") {
        const { category_id } = req.query;
        let result = category_id ? live.filter(s => s.category_id === category_id) : live;
        return res.json(result);
    }
    if (action === "get_vod_streams") {
        const { category_id } = req.query;
        let result = category_id ? vod.filter(s => s.category_id === category_id) : vod;
        return res.json(result);
    }
    if (action === "get_series") {
        const { category_id } = req.query;
        let list = Object.values(series).map(s => ({
            series_id: s.series_id,
            name: s.name,
            cover: s.cover,
            plot: s.plot,
            cast: s.cast,
            director: s.director,
            genre: s.genre,
            releaseDate: s.releaseDate,
            last_modified: s.last_modified,
            category_id: s.category_id
        }));
        if (category_id) list = list.filter(s => s.category_id === category_id);
        return res.json(list);
    }
    if (action === "get_series_info") {
        const { series_id } = req.query;
        const serie = Object.values(series).find(s => s.series_id === series_id);
        if (!serie) return res.json({ seasons: [] });
        const seasons = Object.keys(serie.seasons).map(seasonNum => ({
            season_number: parseInt(seasonNum),
            episodes: serie.seasons[seasonNum].map(ep => ({
                id: ep.id,
                episode_num: ep.episode_num,
                title: ep.title,
                container_extension: ep.container_extension,
                info: ep.info
            }))
        }));
        return res.json({ seasons: seasons });
    }
    if (action === "get_vod_info") {
        const { vod_id } = req.query;
        const movie = vod.find(v => v.stream_id === vod_id);
        if (!movie) return res.json({});
        return res.json({
            info: {
                name: movie.name,
                stream_id: movie.stream_id,
                container_extension: movie.container_extension,
                stream_icon: movie.stream_icon,
                plot: "",
                cast: "",
                director: "",
                genre: "",
                releasedate: movie.releaseDate,
                duration_secs: 0,
                duration: ""
            },
            movie_data: {
                stream_id: movie.stream_id,
                name: movie.name,
                container_extension: movie.container_extension,
                stream_icon: movie.stream_icon,
                added: movie.added,
                direct_source: movie.direct_source
            }
        });
    }
    if (action === "get_short_epg") return res.json({ epg_listings: [] });
    res.json({ error: "Ação não suportada", action });
});

// Endpoints de streaming
app.get("/live/:username/:password/:stream_id.ts", (req, res) => {
    const { username, password, stream_id } = req.params;
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user || isExpired(user)) return res.status(403).send("Acesso negado");
    const channel = live.find(c => c.stream_id === stream_id);
    if (channel && channel.direct_source) return res.redirect(channel.direct_source);
    res.status(404).send("Stream não encontrado");
});

app.get("/movie/:username/:password/:stream_id.mp4", (req, res) => {
    const { username, password, stream_id } = req.params;
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user || isExpired(user)) return res.status(403).send("Acesso negado");
    const movie = vod.find(v => v.stream_id === stream_id);
    if (movie && movie.direct_source) return res.redirect(movie.direct_source);
    res.status(404).send("Filme não encontrado");
});

app.get("/series/:username/:password/:stream_id.mp4", (req, res) => {
    const { username, password, stream_id } = req.params;
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user || isExpired(user)) return res.status(403).send("Acesso negado");
    for (let serieName in series) {
        const serie = series[serieName];
        for (let seasonNum in serie.seasons) {
            const ep = serie.seasons[seasonNum].find(e => e.id === stream_id);
            if (ep) return res.redirect(ep.url);
        }
    }
    res.status(404).send("Episódio não encontrado");
});

// ==================== PAINEL ADMINISTRATIVO ====================

app.get("/admin", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Painel Administrativo - IPTV</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .login-box {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 15px 35px rgba(0,0,0,0.2);
            width: 100%;
            max-width: 400px;
        }
        .login-box h1 {
            color: #1e3c72;
            text-align: center;
            margin-bottom: 30px;
            font-size: 28px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            margin-bottom: 5px;
            color: #555;
            font-weight: 600;
        }
        .form-group input {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 5px;
            font-size: 16px;
            transition: border-color 0.3s;
        }
        .form-group input:focus {
            outline: none;
            border-color: #1e3c72;
        }
        .btn {
            width: 100%;
            padding: 12px;
            background: #1e3c72;
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.3s;
        }
        .btn:hover {
            background: #2a5298;
        }
        .error {
            color: #e74c3c;
            text-align: center;
            margin-top: 15px;
            display: none;
        }
        .debug-info {
            margin-top: 20px;
            padding: 10px;
            background: #f0f0f0;
            border-radius: 5px;
            font-size: 12px;
            color: #666;
            display: none;
        }
    </style>
</head>
<body>
    <div class="login-box">
        <h1>🔐 Painel IPTV</h1>
        <form id="loginForm">
            <div class="form-group">
                <label>Usuário</label>
                <input type="text" id="username" required placeholder="klord" value="klord">
            </div>
            <div class="form-group">
                <label>Senha</label>
                <input type="password" id="password" required placeholder="Kl0rd777">
            </div>
            <button type="submit" class="btn">Entrar</button>
            <div id="error" class="error">Usuário ou senha incorretos</div>
            <div id="debug" class="debug-info"></div>
        </form>
    </div>

    <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            console.log('Tentando login com:', username);
            
            try {
                const res = await fetch('/admin/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                const data = await res.json();
                console.log('Resposta:', data);
                
                if (data.success) {
                    localStorage.setItem('adminToken', data.token);
                    window.location.href = '/admin/dashboard';
                } else {
                    document.getElementById('error').style.display = 'block';
                    if (data.debug) {
                        document.getElementById('debug').style.display = 'block';
                        document.getElementById('debug').textContent = 'Debug: ' + data.debug;
                    }
                }
            } catch (err) {
                console.error('Erro:', err);
                document.getElementById('error').textContent = 'Erro de conexão';
                document.getElementById('error').style.display = 'block';
            }
        });
    </script>
</body>
</html>`);
});

// API de login do painel - COM DEBUG
app.post("/admin/api/login", (req, res) => {
    const { username, password } = req.body;
    
    console.log("Tentativa de login:", username, "Senha recebida:", password);
    console.log("Usuários no banco:", db.users.map(u => ({ user: u.username, isAdmin: u.isAdmin })));
    
    // Buscar usuário
    const user = db.users.find(u => u.username === username && u.password === password);
    
    console.log("Usuário encontrado:", user ? "SIM" : "NÃO");
    
    if (user) {
        console.log("isAdmin:", user.isAdmin);
    }
    
    // Verificar se é admin
    if (user && user.isAdmin === true) {
        const token = generateId();
        activeTokens.add(token);
        console.log("Login bem-sucedido, token gerado:", token.substring(0, 8) + "...");
        return res.json({ success: true, token, user: { username: user.username, isAdmin: true } });
    } else {
        let debugMsg = "";
        if (!user) debugMsg = "Usuário/senha não encontrado";
        else if (!user.isAdmin) debugMsg = "Usuário não é admin";
        
        console.log("Login falhou:", debugMsg);
        return res.json({ success: false, debug: debugMsg });
    }
});

// Middleware para verificar token válido
function verifyToken(req, res, next) {
    const token = req.headers.authorization;
    console.log("Verificando token:", token ? token.substring(0, 8) + "..." : "nenhum");
    
    if (!token || !activeTokens.has(token)) {
        console.log("Token inválido ou não encontrado");
        return res.status(401).json({ error: "Não autorizado" });
    }
    next();
}

// Dashboard do painel
app.get("/admin/dashboard", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Painel IPTV</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f6fa; }
        .sidebar { position: fixed; left: 0; top: 0; width: 250px; height: 100vh; background: #1e3c72; color: white; padding: 20px; }
        .sidebar h2 { margin-bottom: 30px; text-align: center; border-bottom: 2px solid rgba(255,255,255,0.2); padding-bottom: 20px; }
        .nav-item { padding: 15px; margin: 5px 0; cursor: pointer; border-radius: 5px; transition: background 0.3s; display: flex; align-items: center; gap: 10px; }
        .nav-item:hover, .nav-item.active { background: rgba(255,255,255,0.1); }
        .main-content { margin-left: 250px; padding: 30px; }
        .header { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .stat-card h3 { color: #666; font-size: 14px; margin-bottom: 10px; text-transform: uppercase; }
        .stat-card .number { font-size: 36px; font-weight: bold; color: #1e3c72; }
        .section { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .section h2 { margin-bottom: 20px; color: #1e3c72; display: flex; justify-content: space-between; align-items: center; }
        .btn-primary { background: #1e3c72; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 14px; }
        .btn-primary:hover { background: #2a5298; }
        .btn-danger { background: #e74c3c; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        .btn-success { background: #27ae60; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        .btn-warning { background: #f39c12; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; color: #555; }
        tr:hover { background: #f8f9fa; }
        .status-active { color: #27ae60; font-weight: bold; }
        .status-expired { color: #e74c3c; font-weight: bold; }
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: white; padding: 30px; border-radius: 10px; width: 90%; max-width: 500px; max-height: 90vh; overflow-y: auto; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: 600; color: #555; }
        .form-group input, .form-group select { width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 5px; font-size: 14px; }
        .form-group input:focus, .form-group select:focus { outline: none; border-color: #1e3c72; }
        .form-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
        .hidden { display: none; }
        .search-box { padding: 10px; border: 2px solid #ddd; border-radius: 5px; width: 300px; margin-bottom: 20px; }
        .badge { padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: bold; }
        .badge-admin { background: #9b59b6; color: white; }
        .badge-user { background: #3498db; color: white; }
        .copy-link { cursor: pointer; color: #1e3c72; text-decoration: underline; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>📺 IPTV Manager</h2>
        <div class="nav-item active" onclick="showSection('dashboard')"><span>📊</span> Dashboard</div>
        <div class="nav-item" onclick="showSection('users')"><span>👥</span> Usuários</div>
        <div class="nav-item" onclick="showSection('content')"><span>🎬</span> Conteúdo</div>
        <div class="nav-item" onclick="showSection('settings')"><span>⚙️</span> Configurações</div>
        <div class="nav-item" onclick="logout()"><span>🚪</span> Sair</div>
    </div>

    <div class="main-content">
        <div id="dashboard-section">
            <div class="header">
                <h1>Dashboard</h1>
                <div><span id="currentUser"></span> | <span id="currentDate"></span></div>
            </div>
            <div class="stats">
                <div class="stat-card"><h3>Total de Usuários</h3><div class="number" id="totalUsers">0</div></div>
                <div class="stat-card"><h3>Usuários Ativos</h3><div class="number" id="activeUsers">0</div></div>
                <div class="stat-card"><h3>Expirados</h3><div class="number" id="expiredUsers">0</div></div>
                <div class="stat-card"><h3>Canais / Filmes / Séries</h3><div class="number" id="totalContent">0 / 0 / 0</div></div>
            </div>
            <div class="section">
                <h2>📈 Atividade Recente</h2>
                <p>Últimos usuários criados:</p>
                <table id="recentUsers"><thead><tr><th>Usuário</th><th>Criado em</th><th>Expira em</th><th>Status</th></tr></thead><tbody></tbody></table>
            </div>
        </div>

        <div id="users-section" class="hidden">
            <div class="header">
                <h1>Gerenciar Usuários</h1>
                <button class="btn-primary" onclick="openModal('createUser')">+ Novo Usuário</button>
            </div>
            <div class="section">
                <input type="text" class="search-box" id="searchUsers" placeholder="🔍 Buscar usuários..." onkeyup="searchUsers()">
                <table id="usersTable"><thead><tr><th>Usuário</th><th>Senha</th><th>Tipo</th><th>Criado em</th><th>Expira em</th><th>Conexões</th><th>Status</th><th>Ações</th></tr></thead><tbody></tbody></table>
            </div>
        </div>

        <div id="content-section" class="hidden">
            <div class="header"><h1>Conteúdo do Servidor</h1><button class="btn-primary" onclick="location.reload()">🔄 Recarregar M3U</button></div>
            <div class="section"><h2>📺 Canais (${live.length})</h2><p>${categories.live.length} categorias</p></div>
            <div class="section"><h2>🎬 Filmes (${vod.length})</h2><p>${categories.vod.length} categorias</p></div>
            <div class="section"><h2>📺 Séries (${Object.keys(series).length})</h2><p>${categories.series.length} categorias</p></div>
        </div>

        <div id="settings-section" class="hidden">
            <div class="header"><h1>Configurações</h1></div>
            <div class="section">
                <h2>⚙️ Configurações do Servidor</h2>
                <div class="form-group"><label>Nome do Servidor</label><input type="text" id="serverName" value="${db.settings.serverName}"></div>
                <div class="form-group"><label>Dias padrão de expiração</label><input type="number" id="defaultExpiry" value="${db.settings.defaultExpiryDays}"></div>
                <div class="form-group"><label>Conexões simultâneas padrão</label><input type="number" id="defaultConnections" value="${db.settings.defaultMaxConnections}"></div>
                <button class="btn-primary" onclick="saveSettings()">Salvar Configurações</button>
            </div>
        </div>
    </div>

    <div id="createUserModal" class="modal">
        <div class="modal-content">
            <h2>Criar Novo Usuário</h2>
            <form id="createUserForm">
                <div class="form-group"><label>Usuário (deixe em branco para gerar automático)</label><input type="text" id="newUsername" placeholder="user123"></div>
                <div class="form-group"><label>Senha (deixe em branco para gerar automático)</label><input type="text" id="newPassword" placeholder="senha123"></div>
                <div class="form-group"><label>Dias de validade</label><input type="number" id="newExpiry" value="30" min="1"></div>
                <div class="form-group"><label>Máximo de conexões</label><input type="number" id="newMaxConn" value="1" min="1"></div>
                <div class="form-group"><label>Notas (opcional)</label><input type="text" id="newNotes" placeholder="Cliente XYZ"></div>
                <div class="form-actions">
                    <button type="button" class="btn-primary" onclick="closeModal('createUser')">Cancelar</button>
                    <button type="submit" class="btn-success">Criar Usuário</button>
                </div>
            </form>
        </div>
    </div>

    <div id="editUserModal" class="modal">
        <div class="modal-content">
            <h2>Editar Usuário</h2>
            <form id="editUserForm">
                <input type="hidden" id="editUserId">
                <div class="form-group"><label>Usuário</label><input type="text" id="editUsername" readonly></div>
                <div class="form-group"><label>Nova Senha (deixe em branco para manter)</label><input type="text" id="editPassword" placeholder="Nova senha"></div>
                <div class="form-group"><label>Data de vencimento</label><input type="date" id="editExpiry"></div>
                <div class="form-group"><label>Máximo de conexões</label><input type="number" id="editMaxConn" min="1"></div>
                <div class="form-group"><label>Status</label><select id="editStatus"><option value="Active">Ativo</option><option value="Inactive">Inativo</option><option value="Banned">Banido</option></select></div>
                <div class="form-group"><label>Notas</label><input type="text" id="editNotes"></div>
                <div class="form-actions">
                    <button type="button" class="btn-primary" onclick="closeModal('editUser')">Cancelar</button>
                    <button type="submit" class="btn-success">Salvar Alterações</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        let users = [];
        let currentSection = 'dashboard';

        if (!localStorage.getItem('adminToken')) {
            window.location.href = '/admin';
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadDashboard();
            loadUsers();
            document.getElementById('createUserForm').addEventListener('submit', handleCreateUser);
            document.getElementById('editUserForm').addEventListener('submit', handleEditUser);
        });

        function showSection(section) {
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            event.target.closest('.nav-item').classList.add('active');
            document.getElementById('dashboard-section').classList.add('hidden');
            document.getElementById('users-section').classList.add('hidden');
            document.getElementById('content-section').classList.add('hidden');
            document.getElementById('settings-section').classList.add('hidden');
            document.getElementById(section + '-section').classList.remove('hidden');
            currentSection = section;
        }

        async function loadDashboard() {
            const res = await fetch('/admin/api/stats', { headers: { 'Authorization': localStorage.getItem('adminToken') }});
            if (res.status === 401) { logout(); return; }
            const data = await res.json();
            document.getElementById('totalUsers').textContent = data.totalUsers;
            document.getElementById('activeUsers').textContent = data.activeUsers;
            document.getElementById('expiredUsers').textContent = data.expiredUsers;
            document.getElementById('totalContent').textContent = data.content.live + ' / ' + data.content.vod + ' / ' + data.content.series;
            const tbody = document.querySelector('#recentUsers tbody');
            tbody.innerHTML = data.recentUsers.map(u => \`<tr><td>\${u.username}</td><td>\${new Date(u.createdAt).toLocaleDateString('pt-BR')}</td><td>\${u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')}</td><td class="\${u.status === 'Active' ? 'status-active' : 'status-expired'}">\${u.status}</td></tr>\`).join('');
            document.getElementById('currentDate').textContent = new Date().toLocaleDateString('pt-BR');
            document.getElementById('currentUser').textContent = 'Admin';
        }

        async function loadUsers() {
            const res = await fetch('/admin/api/users', { headers: { 'Authorization': localStorage.getItem('adminToken') }});
            if (res.status === 401) { logout(); return; }
            users = await res.json();
            renderUsers(users);
        }

        function renderUsers(userList) {
            const tbody = document.querySelector('#usersTable tbody');
            tbody.innerHTML = userList.map(u => {
                const isExpired = new Date(u.expiresAt) < new Date() && u.expiresAt !== 'never';
                const statusClass = isExpired ? 'status-expired' : (u.status === 'Active' ? 'status-active' : 'status-expired');
                const statusText = isExpired ? 'EXPIRADO' : u.status;
                return \`<tr><td><strong>\${u.username}</strong></td><td><span class="copy-link" onclick="copyToClipboard('\${u.password}')" title="Copiar senha">\${u.password.substring(0, 8)}...</span></td><td><span class="badge \${u.isAdmin ? 'badge-admin' : 'badge-user'}">\${u.isAdmin ? 'Admin' : 'User'}</span></td><td>\${new Date(u.createdAt).toLocaleDateString('pt-BR')}</td><td>\${u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')}</td><td>\${u.activeConnections} / \${u.maxConnections}</td><td class="\${statusClass}">\${statusText}</td><td><button class="btn-success" onclick="copyLink('\${u.username}', '\${u.password}')">🔗 Link</button><button class="btn-warning" onclick="editUser('\${u.id}')">✏️</button><button class="btn-danger" onclick="deleteUser('\${u.id}')" \${u.isAdmin ? 'disabled' : ''}>🗑️</button></td></tr>\`;
            }).join('');
        }

        function searchUsers() {
            const term = document.getElementById('searchUsers').value.toLowerCase();
            renderUsers(users.filter(u => u.username.toLowerCase().includes(term) || u.notes?.toLowerCase().includes(term)));
        }

        function openModal(modal) { document.getElementById(modal + 'Modal').style.display = 'flex'; }
        function closeModal(modal) { document.getElementById(modal + 'Modal').style.display = 'none'; }

        async function handleCreateUser(e) {
            e.preventDefault();
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
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                alert(\`Usuário criado!\\nUsuário: \${result.user.username}\\nSenha: \${result.user.password}\`);
                closeModal('createUser');
                loadUsers();
                loadDashboard();
                document.getElementById('createUserForm').reset();
            } else {
                alert('Erro: ' + result.error);
            }
        }

        async function editUser(id) {
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

        async function handleEditUser(e) {
            e.preventDefault();
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
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                closeModal('editUser');
                loadUsers();
                loadDashboard();
            } else {
                alert('Erro: ' + result.error);
            }
        }

        async function deleteUser(id) {
            if (!confirm('Tem certeza que deseja excluir este usuário?')) return;
            const res = await fetch('/admin/api/users/' + id, {
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('adminToken') }
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                loadUsers();
                loadDashboard();
            }
        }

        function copyLink(username, password) {
            const url = \`\${window.location.origin}/get.php?username=\${username}&password=\${password}&type=m3u_plus\`;
            copyToClipboard(url);
            alert('Link M3U copiado para a área de transferência!');
        }

        function copyToClipboard(text) { navigator.clipboard.writeText(text); }

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
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) alert('Configurações salvas!');
        }

        function logout() {
            localStorage.removeItem('adminToken');
            window.location.href = '/admin';
        }

        window.onclick = function(event) {
            if (event.target.classList.contains('modal')) {
                event.target.style.display = 'none';
            }
        }
    </script>
</body>
</html>`);
});

// API Admin - Estatísticas
app.get("/admin/api/stats", verifyToken, (req, res) => {
    const totalUsers = db.users.length;
    const activeUsers = db.users.filter(u => !isExpired(u) && u.status === "Active").length;
    const expiredUsers = db.users.filter(u => isExpired(u)).length;
    const recentUsers = [...db.users].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);

    res.json({
        totalUsers,
        activeUsers,
        expiredUsers,
        content: { live: live.length, vod: vod.length, series: Object.keys(series).length },
        recentUsers
    });
});

// API Admin - Listar usuários
app.get("/admin/api/users", verifyToken, (req, res) => {
    res.json(db.users.map(u => ({ ...u, isExpired: isExpired(u) })));
});

// API Admin - Criar usuário
app.post("/admin/api/users", verifyToken, (req, res) => {
    const { username, password, expiryDays, maxConnections, notes } = req.body;
    const finalUsername = username || "user" + Math.floor(Math.random() * 10000);
    const finalPassword = password || generatePassword();
    
    if (db.users.find(u => u.username === finalUsername)) {
        return res.json({ success: false, error: "Usuário já existe" });
    }

    const newUser = {
        id: generateId(),
        username: finalUsername,
        password: finalPassword,
        isAdmin: false,
        createdAt: new Date().toISOString(),
        expiresAt: expiryDays ? calculateExpiryDate(expiryDays) : "never",
        maxConnections: maxConnections || db.settings.defaultMaxConnections,
        activeConnections: 0,
        status: "Active",
        notes: notes || ""
    };

    db.users.push(newUser);
    saveDatabase();
    res.json({ success: true, user: newUser });
});

// API Admin - Editar usuário
app.put("/admin/api/users/:id", verifyToken, (req, res) => {
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
    res.json({ success: true, user: db.users[userIndex] });
});

// API Admin - Deletar usuário
app.delete("/admin/api/users/:id", verifyToken, (req, res) => {
    const { id } = req.params;
    const userIndex = db.users.findIndex(u => u.id === id);
    if (userIndex === -1) return res.json({ success: false, error: "Usuário não encontrado" });
    if (db.users[userIndex].isAdmin) return res.json({ success: false, error: "Não pode deletar admin" });

    db.users.splice(userIndex, 1);
    saveDatabase();
    res.json({ success: true });
});

// API Admin - Configurações
app.put("/admin/api/settings", verifyToken, (req, res) => {
    const { serverName, defaultExpiryDays, defaultMaxConnections } = req.body;
    db.settings.serverName = serverName || db.settings.serverName;
    db.settings.defaultExpiryDays = defaultExpiryDays || db.settings.defaultExpiryDays;
    db.settings.defaultMaxConnections = defaultMaxConnections || db.settings.defaultMaxConnections;
    saveDatabase();
    res.json({ success: true, settings: db.settings });
});

// Inicializar
loadDatabase();
parseM3U();

app.listen(PORT, () => {
    console.log("========================================");
    console.log("🚀 SERVIDOR IPTV + PAINEL ADMIN RODANDO");
    console.log(`📡 Porta: ${PORT}`);
    console.log(`📁 Arquivo: playlist.m3u`);
    console.log(`💾 Banco de dados: ${DB_FILE}`);
    console.log("========================================");
    console.log("Endpoints:");
    console.log(`➜ IPTV API: http://localhost:${PORT}/player_api.php`);
    console.log(`➜ Painel Admin: http://localhost:${PORT}/admin`);
    console.log("========================================");
    console.log("Login padrão do painel:");
    console.log("Usuário: klord");
    console.log("Senha: Kl0rd777");
    console.log("========================================");
});
