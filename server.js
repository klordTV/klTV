const fs = require("fs");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURAÇÃO GITHUB E RENDER ====================
const CONFIG = {
    // GitHub Config
    GITHUB_TOKEN: "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",
    GITHUB_OWNER: "klordTV",
    GITHUB_REPO: "klTV",
    GITHUB_FILE_PATH: "database.json",
    GITHUB_BRANCH: "main", // ou "master", dependendo da branch padrão
    
    // Render Deploy
    RENDER_DEPLOY_URL: "https://api.render.com/deploy/srv-d6o4ric50q8c73ddcucg?key=GZ3X3EIsQTY"
};

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
const M3U_SOURCES_FILE = path.join(__dirname, "m3u_sources.json");

// Estrutura inicial do banco
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

// Gerenciar tokens ativos (sessões)
let activeTokens = new Set();

// ==================== FUNÇÕES GITHUB API ====================

/**
 * Atualiza o arquivo database.json no GitHub
 * Fluxo: Edita arquivo -> Commit -> Deploy Render
 */
async function updateGitHubFile(content, message) {
    return new Promise(async (resolve, reject) => {
        try {
            // 1. Primeiro, pegar o SHA atual do arquivo (necessário para update)
            const currentFile = await getGitHubFileSha();
            
            if (!currentFile.success && currentFile.error !== 'File not found') {
                throw new Error(`Erro ao obter SHA: ${currentFile.error}`);
            }

            const contentEncoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
            
            const postData = JSON.stringify({
                message: message || "Update database.json via IPTV Panel",
                content: contentEncoded,
                sha: currentFile.sha, // SHA atual do arquivo (obrigatório para update)
                branch: CONFIG.GITHUB_BRANCH,
                committer: {
                    name: "IPTV Panel",
                    email: "panel@iptv.local"
                },
                author: {
                    name: "IPTV Panel",
                    email: "panel@iptv.local"
                }
            });

            const options = {
                hostname: 'api.github.com',
                port: 443,
                path: `/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/contents/${CONFIG.GITHUB_FILE_PATH}`,
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${CONFIG.GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'IPTV-Panel/1.0',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            console.log(`📝 Atualizando arquivo no GitHub: ${CONFIG.GITHUB_FILE_PATH}`);
            console.log(`   Branch: ${CONFIG.GITHUB_BRANCH}`);
            console.log(`   Mensagem: ${message}`);

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        
                        if (res.statusCode === 200 || res.statusCode === 201) {
                            console.log(`✅ Arquivo atualizado no GitHub!`);
                            console.log(`   Commit SHA: ${response.commit?.sha?.substring(0, 7)}`);
                            console.log(`   HTML URL: ${response.content?.html_url}`);
                            
                            resolve({
                                success: true,
                                commitSha: response.commit?.sha,
                                contentSha: response.content?.sha,
                                htmlUrl: response.content?.html_url,
                                message: "Arquivo atualizado com sucesso no GitHub"
                            });
                        } else {
                            console.error(`❌ Erro GitHub API: ${res.statusCode}`, response);
                            resolve({
                                success: false,
                                error: response.message || `HTTP ${res.statusCode}`,
                                details: response
                            });
                        }
                    } catch (e) {
                        resolve({ success: false, error: "Erro ao parsear resposta: " + e.message });
                    }
                });
            });

            req.on('error', (err) => {
                console.error('❌ Erro na requisição GitHub:', err);
                resolve({ success: false, error: err.message });
            });

            req.write(postData);
            req.end();

        } catch (error) {
            console.error('❌ Erro em updateGitHubFile:', error);
            resolve({ success: false, error: error.message });
        }
    });
}

/**
 * Obtém o SHA atual do arquivo no GitHub (necessário para updates)
 */
function getGitHubFileSha() {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            port: 443,
            path: `/repos/${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}/contents/${CONFIG.GITHUB_FILE_PATH}?ref=${CONFIG.GITHUB_BRANCH}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${CONFIG.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'IPTV-Panel/1.0'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 404) {
                        resolve({ success: false, error: 'File not found', sha: null });
                        return;
                    }
                    
                    const response = JSON.parse(data);
                    if (res.statusCode === 200 && response.sha) {
                        resolve({ success: true, sha: response.sha, content: response });
                    } else {
                        resolve({ success: false, error: response.message || 'Unknown error', sha: null });
                    }
                } catch (e) {
                    resolve({ success: false, error: e.message, sha: null });
                }
            });
        });

        req.on('error', (err) => {
            resolve({ success: false, error: err.message, sha: null });
        });

        req.end();
    });
}

// ==================== FUNÇÃO DEPLOY RENDER ====================

function triggerRenderDeploy() {
    return new Promise((resolve, reject) => {
        console.log("🚀 Acionando deploy no Render...");
        
        https.get(CONFIG.RENDER_DEPLOY_URL, (res) => {
            if (res.statusCode === 200) {
                console.log("✅ Deploy do Render acionado com sucesso!");
                resolve({ success: true, message: "Deploy acionado" });
            } else {
                console.warn(`⚠️  Deploy retornou status ${res.statusCode}`);
                resolve({ success: false, status: res.statusCode });
            }
        }).on('error', (err) => {
            console.error("❌ Erro ao acionar deploy:", err.message);
            resolve({ success: false, error: err.message });
        });
    });
}

/**
 * FLUXO COMPLETO: Salvar no GitHub -> Deploy Render
 * Esta função é chamada após qualquer modificação no banco de dados
 */
async function syncToGitHubAndDeploy(actionDescription) {
    console.log(`\n🔄 Iniciando sincronização: ${actionDescription}`);
    console.log("========================================");
    
    // 1. Salvar localmente primeiro (backup)
    saveDatabase();
    
    // 2. Atualizar no GitHub
    const gitResult = await updateGitHubFile(db, actionDescription);
    
    if (!gitResult.success) {
        console.error("❌ Falha ao atualizar GitHub:", gitResult.error);
        return { 
            success: false, 
            stage: 'github', 
            error: gitResult.error,
            message: "Dados salvos localmente, mas falha ao sincronizar com GitHub"
        };
    }
    
    console.log("✅ GitHub atualizado com sucesso!");
    
    // 3. Acionar deploy no Render (aguarda um pouco para o GitHub processar)
    console.log("⏳ Aguardando 3 segundos para GitHub processar commit...");
    await new Promise(r => setTimeout(r, 3000));
    
    const deployResult = await triggerRenderDeploy();
    
    console.log("========================================");
    console.log("✅ Sincronização concluída!");
    
    return {
        success: true,
        github: gitResult,
        deploy: deployResult,
        message: "Dados sincronizados com GitHub e deploy acionado no Render"
    };
}

// ==================== GERENCIAMENTO DE FONTES M3U ====================

let m3uSources = [];
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

// Carregar fontes M3U
function loadM3USources() {
    try {
        if (fs.existsSync(M3U_SOURCES_FILE)) {
            const data = fs.readFileSync(M3U_SOURCES_FILE, "utf8");
            m3uSources = JSON.parse(data);
            console.log(`📋 ${m3uSources.length} fontes M3U carregadas`);
        } else {
            m3uSources = [];
            saveM3USources();
        }
    } catch (error) {
        console.error("Erro ao carregar fontes M3U:", error);
        m3uSources = [];
    }
}

// Salvar fontes M3U
function saveM3USources() {
    try {
        fs.writeFileSync(M3U_SOURCES_FILE, JSON.stringify(m3uSources, null, 2));
    } catch (error) {
        console.error("Erro ao salvar fontes M3U:", error);
    }
}

// Função para fazer download de URL M3U
function downloadM3U(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        console.log(`⬇️  Baixando M3U: ${url.substring(0, 60)}...`);
        
        const request = client.get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        }, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                return downloadM3U(response.headers.location).then(resolve).catch(reject);
            }
            
            if (response.statusCode !== 200) {
                reject(new Error(`Status code: ${response.statusCode}`));
                return;
            }

            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                console.log(`✅ Download concluído: ${(data.length / 1024).toFixed(2)} KB`);
                resolve(data);
            });
        });

        request.on('error', (err) => {
            console.error(`❌ Erro no download: ${err.message}`);
            reject(err);
        });
        
        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// Adicionar nova fonte M3U
async function addM3USource(name, url, type = 'all') {
    try {
        await downloadM3U(url);
        
        const source = {
            id: generateId(),
            name: name,
            url: url,
            type: type,
            enabled: true,
            lastUpdate: new Date().toISOString(),
            status: 'active'
        };
        
        m3uSources = m3uSources.filter(s => s.name !== name);
        m3uSources.push(source);
        saveM3USources();
        
        console.log(`✅ Fonte adicionada: ${name}`);
        return { success: true, source };
    } catch (error) {
        console.error(`❌ Erro ao adicionar fonte ${name}:`, error.message);
        return { success: false, error: error.message };
    }
}

// Remover fonte M3U
function removeM3USource(id) {
    const index = m3uSources.findIndex(s => s.id === id);
    if (index !== -1) {
        const name = m3uSources[index].name;
        m3uSources.splice(index, 1);
        saveM3USources();
        console.log(`🗑️  Fonte removida: ${name}`);
        return true;
    }
    return false;
}

// ==================== PARSE M3U MELHORADO ====================

async function parseAllM3USources() {
    console.log("\n🔄 Iniciando parse de todas as fontes M3U...");
    
    live = [];
    vod = [];
    series = {};
    categories = { live: [], vod: [], series: [] };
    groupToId = {};
    catIdCounters = { live: 1, vod: 1, series: 1 };
    
    let totalSources = 0;
    let successSources = 0;
    
    if (fs.existsSync(path.join(__dirname, "playlist.m3u"))) {
        console.log("📁 Processando playlist.m3u local...");
        parseM3UContent(fs.readFileSync(path.join(__dirname, "playlist.m3u"), "utf8"), "Local");
        totalSources++;
        successSources++;
    }
    
    for (const source of m3uSources.filter(s => s.enabled)) {
        totalSources++;
        try {
            const content = await downloadM3U(source.url);
            parseM3UContent(content, source.name, source.type);
            source.lastUpdate = new Date().toISOString();
            source.status = 'active';
            source.lastError = null;
            successSources++;
            console.log(`✅ Fonte processada: ${source.name}`);
        } catch (error) {
            source.status = 'error';
            source.lastError = error.message;
            console.error(`❌ Erro na fonte ${source.name}:`, error.message);
        }
    }
    
    saveM3USources();
    console.log(`\n📊 Resumo do parse:`);
    console.log(`   Fontes: ${successSources}/${totalSources} OK`);
    console.log(`   Canais: ${live.length}`);
    console.log(`   Filmes: ${vod.length}`);
    console.log(`   Séries: ${Object.keys(series).length}`);
    console.log(`   Categorias: ${categories.live.length + categories.vod.length + categories.series.length}`);
}

function parseM3UContent(content, sourceName, filterType = 'all') {
    const lines = content.split(/\r?\n/);
    let current = null;
    let id = Date.now() + Math.random();

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
                id: (id++).toString(),
                name: name,
                group: `[${sourceName}] ${group}`,
                icon: icon,
                rawLine: line,
                source: sourceName
            };
        }
        else if (line.startsWith("http") && current) {
            current.url = line;
            const groupUpper = current.group.toUpperCase();
            
            if (filterType !== 'all') {
                if (filterType === 'live' && !isLiveContent(groupUpper, current.name)) continue;
                if (filterType === 'vod' && !isVodContent(groupUpper, current.name)) continue;
                if (filterType === 'series' && !isSeriesContent(groupUpper, current.name)) continue;
            }
            
            if (isVodContent(groupUpper, current.name)) {
                parseMovie(current);
            }
            else if (isSeriesContent(groupUpper, current.name)) {
                parseSeries(current);
            }
            else {
                parseLive(current);
            }
            current = null;
        }
    }
}

function isLiveContent(groupUpper, name) {
    return groupUpper.includes('CANAL') || groupUpper.includes('TV') || 
           groupUpper.includes('LIVE') || !name.match(/S\d+E\d+/i);
}

function isVodContent(groupUpper, name) {
    return groupUpper.includes('FILME') || groupUpper.includes('MOVIE') || 
           groupUpper.includes('VOD');
}

function isSeriesContent(groupUpper, name) {
    return groupUpper.includes('SERIE') || groupUpper.includes('SÉRIE') || 
           name.match(/S\d+E\d+/i);
}

function getOrCreateCategory(group, type) {
    const catKey = `${type}_${group}`;
    if (!groupToId[catKey]) {
        const catId = catIdCounters[type].toString();
        groupToId[catKey] = catId;
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
    return groupToId[catKey];
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
    if (exists) return;

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

// ==================== BANCO DE DADOS ====================

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, "utf8");
            db = JSON.parse(data);
            console.log("💾 Banco de dados carregado");
            
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

function createDefaultAdmin() {
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

function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (error) {
        console.error("Erro ao salvar banco:", error);
    }
}

function generateId() {
    return crypto.randomBytes(8).toString("hex");
}

function generatePassword(length = 8) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let password = "";
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
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
                message: user.isTrial ? "Seu teste de 1 hora expirou" : "Sua assinatura expirou"
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
                message: user.isTrial ? "⚡ Conta de teste - 1 hora" : "",
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
        </form>
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

// API de login do painel
app.post("/admin/api/login", (req, res) => {
    const { username, password } = req.body;
    const user = db.users.find(u => u.username === username && u.password === password);
    
    if (user && user.isAdmin === true) {
        const token = generateId();
        activeTokens.add(token);
        return res.json({ success: true, token, user: { username: user.username, isAdmin: true } });
    } else {
        return res.json({ success: false });
    }
});

// Middleware para verificar token válido
function verifyToken(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !activeTokens.has(token)) {
        return res.status(401).json({ error: "Não autorizado" });
    }
    next();
}

// Dashboard do painel (HTML completo)
app.get("/admin/dashboard", (req, res) => {
    // Retorna o HTML do dashboard (mantido igual ao original, mas com funções de sync)
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dashboard - Painel IPTV</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f6fa; }
        .sidebar { position: fixed; left: 0; top: 0; width: 250px; height: 100vh; background: #1e3c72; color: white; padding: 20px; overflow-y: auto; }
        .sidebar h2 { margin-bottom: 30px; text-align: center; border-bottom: 2px solid rgba(255,255,255,0.2); padding-bottom: 20px; }
        .nav-item { padding: 15px; margin: 5px 0; cursor: pointer; border-radius: 5px; transition: background 0.3s; display: flex; align-items: center; gap: 10px; }
        .nav-item:hover, .nav-item.active { background: rgba(255,255,255,0.1); }
        .main-content { margin-left: 250px; padding: 30px; }
        .header { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .stat-card h3 { color: #666; font-size: 14px; margin-bottom: 10px; text-transform: uppercase; }
        .stat-card .number { font-size: 32px; font-weight: bold; color: #1e3c72; }
        .section { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .section h2 { margin-bottom: 20px; color: #1e3c72; display: flex; justify-content: space-between; align-items: center; }
        .btn-primary { background: #1e3c72; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-size: 14px; }
        .btn-primary:hover { background: #2a5298; }
        .btn-danger { background: #e74c3c; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        .btn-success { background: #27ae60; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        .btn-warning { background: #f39c12; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        .btn-info { background: #3498db; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; font-weight: 600; color: #555; }
        tr:hover { background: #f8f9fa; }
        .status-active { color: #27ae60; font-weight: bold; }
        .status-expired { color: #e74c3c; font-weight: bold; }
        .status-trial { color: #f39c12; font-weight: bold; }
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
        .badge-trial { background: #f39c12; color: white; }
        .copy-link { cursor: pointer; color: #1e3c72; text-decoration: underline; }
        .source-card { background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #1e3c72; }
        .source-card.error { border-left-color: #e74c3c; }
        .source-card.success { border-left-color: #27ae60; }
        .source-status { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; }
        .source-status.active { background: #27ae60; color: white; }
        .source-status.error { background: #e74c3c; color: white; }
        .trial-badge { background: linear-gradient(45deg, #f39c12, #e74c3c); color: white; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; }
        .sync-status { position: fixed; bottom: 20px; right: 20px; padding: 15px 25px; border-radius: 8px; color: white; font-weight: bold; display: none; z-index: 2000; }
        .sync-status.success { background: #27ae60; }
        .sync-status.error { background: #e74c3c; }
        .sync-status.loading { background: #3498db; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2>📺 IPTV Manager</h2>
        <div class="nav-item active" onclick="showSection('dashboard')"><span>📊</span> Dashboard</div>
        <div class="nav-item" onclick="showSection('users')"><span>👥</span> Usuários</div>
        <div class="nav-item" onclick="showSection('sources')"><span>🔗</span> Fontes M3U</div>
        <div class="nav-item" onclick="showSection('content')"><span>🎬</span> Conteúdo</div>
        <div class="nav-item" onclick="showSection('settings')"><span>⚙️</span> Configurações</div>
        <div class="nav-item" onclick="logout()"><span>🚪</span> Sair</div>
    </div>

    <div class="main-content">
        <div id="dashboard-section">
            <div class="header">
                <h1>Dashboard</h1>
                <div>
                    <button class="btn-success" onclick="syncNow()">🔄 Sincronizar Agora</button>
                    <span id="currentUser"></span> | <span id="currentDate"></span>
                </div>
            </div>
            <div class="stats">
                <div class="stat-card"><h3>Total de Usuários</h3><div class="number" id="totalUsers">0</div></div>
                <div class="stat-card"><h3>Usuários Ativos</h3><div class="number" id="activeUsers">0</div></div>
                <div class="stat-card"><h3>Testes Ativos</h3><div class="number" id="trialUsers">0</div></div>
                <div class="stat-card"><h3>Expirados</h3><div class="number" id="expiredUsers">0</div></div>
                <div class="stat-card"><h3>Canais / Filmes / Séries</h3><div class="number" id="totalContent">0 / 0 / 0</div></div>
                <div class="stat-card"><h3>Fontes M3U</h3><div class="number" id="totalSources">0</div></div>
            </div>
            <div class="section">
                <h2>📈 Atividade Recente</h2>
                <p>Últimos usuários criados:</p>
                <table id="recentUsers"><thead><tr><th>Usuário</th><th>Tipo</th><th>Criado em</th><th>Expira em</th><th>Status</th></tr></thead><tbody></tbody></table>
            </div>
            <div class="section">
                <h2>☁️ Status da Sincronização</h2>
                <p id="syncStatus">Última sincronização: <span id="lastSync">Nunca</span></p>
                <p style="color: #666; font-size: 14px;">O sistema sincroniza automaticamente com GitHub e aciona deploy no Render a cada alteração.</p>
            </div>
        </div>

        <div id="users-section" class="hidden">
            <div class="header">
                <h1>Gerenciar Usuários</h1>
                <div>
                    <button class="btn-warning" onclick="openModal('createTrial')">⚡ Criar Teste (1h)</button>
                    <button class="btn-primary" onclick="openModal('createUser')">+ Novo Usuário</button>
                </div>
            </div>
            <div class="section">
                <input type="text" class="search-box" id="searchUsers" placeholder="🔍 Buscar usuários..." onkeyup="searchUsers()">
                <table id="usersTable"><thead><tr><th>Usuário</th><th>Senha</th><th>Tipo</th><th>Criado em</th><th>Expira em</th><th>Conexões</th><th>Status</th><th>Ações</th></tr></thead><tbody></tbody></table>
            </div>
        </div>

        <div id="sources-section" class="hidden">
            <div class="header">
                <h1>Fontes M3U</h1>
                <button class="btn-primary" onclick="openModal('addSource')">+ Adicionar Fonte</button>
            </div>
            <div class="section">
                <h2>🔗 Fontes Configuradas</h2>
                <div id="sourcesList"></div>
            </div>
            <div class="section">
                <h2>🔄 Ações</h2>
                <button class="btn-success" onclick="reloadAllSources()">🔄 Recarregar Todas as Fontes</button>
                <p style="margin-top: 10px; color: #666;">Isso irá baixar e processar todas as URLs M3U configuradas.</p>
            </div>
        </div>

        <div id="content-section" class="hidden">
            <div class="header"><h1>Conteúdo do Servidor</h1><button class="btn-primary" onclick="reloadAllSources()">🔄 Recarregar M3U</button></div>
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
            <div class="section">
                <h2>🚀 Deploy</h2>
                <p>URL de Deploy do Render configurada.</p>
                <button class="btn-success" onclick="triggerDeploy()">🚀 Acionar Deploy Manual</button>
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

    <div id="createTrialModal" class="modal">
        <div class="modal-content">
            <h2>⚡ Criar Conta de Teste (1 Hora)</h2>
            <form id="createTrialForm">
                <div class="form-group"><label>Usuário (deixe em branco para gerar automático)</label><input type="text" id="trialUsername" placeholder="trial123"></div>
                <div class="form-group"><label>Senha (deixe em branco para gerar automático)</label><input type="text" id="trialPassword" placeholder="senha123"></div>
                <div class="form-group"><label>Máximo de conexões</label><input type="number" id="trialMaxConn" value="1" min="1"></div>
                <div class="form-group"><label>Notas (opcional)</label><input type="text" id="trialNotes" placeholder="Teste cliente XYZ"></div>
                <p style="color: #f39c12; font-size: 14px; margin-bottom: 15px;">⚠️ Esta conta expirará automaticamente em 1 hora!</p>
                <div class="form-actions">
                    <button type="button" class="btn-primary" onclick="closeModal('createTrial')">Cancelar</button>
                    <button type="submit" class="btn-warning">⚡ Criar Teste</button>
                </div>
            </form>
        </div>
    </div>

    <div id="addSourceModal" class="modal">
        <div class="modal-content">
            <h2>Adicionar Fonte M3U</h2>
            <form id="addSourceForm">
                <div class="form-group"><label>Nome da Fonte</label><input type="text" id="sourceName" placeholder="Minha Lista IPTV" required></div>
                <div class="form-group"><label>URL da Lista M3U</label><input type="url" id="sourceUrl" placeholder="http://exemplo.com/lista.m3u" required></div>
                <div class="form-group"><label>Tipo de Conteúdo</label>
                    <select id="sourceType">
                        <option value="all">Todos (Canais + VOD + Séries)</option>
                        <option value="live">Apenas Canais Ao Vivo</option>
                        <option value="vod">Apenas Filmes (VOD)</option>
                        <option value="series">Apenas Séries</option>
                    </select>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn-primary" onclick="closeModal('addSource')">Cancelar</button>
                    <button type="submit" class="btn-success">Adicionar Fonte</button>
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

    <div id="syncStatusDiv" class="sync-status"></div>

    <script>
        let users = [];
        let currentSection = 'dashboard';

        if (!localStorage.getItem('adminToken')) {
            window.location.href = '/admin';
        }

        document.addEventListener('DOMContentLoaded', () => {
            loadDashboard();
            loadUsers();
            loadSources();
            document.getElementById('createUserForm').addEventListener('submit', handleCreateUser);
            document.getElementById('createTrialForm').addEventListener('submit', handleCreateTrial);
            document.getElementById('addSourceForm').addEventListener('submit', handleAddSource);
            document.getElementById('editUserForm').addEventListener('submit', handleEditUser);
        });

        function showSyncStatus(message, type) {
            const div = document.getElementById('syncStatusDiv');
            div.textContent = message;
            div.className = 'sync-status ' + type;
            div.style.display = 'block';
            setTimeout(() => { div.style.display = 'none'; }, 5000);
        }

        function showSection(section) {
            document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
            event.target.closest('.nav-item').classList.add('active');
            document.getElementById('dashboard-section').classList.add('hidden');
            document.getElementById('users-section').classList.add('hidden');
            document.getElementById('sources-section').classList.add('hidden');
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
            document.getElementById('trialUsers').textContent = data.trialUsers;
            document.getElementById('expiredUsers').textContent = data.expiredUsers;
            document.getElementById('totalContent').textContent = data.content.live + ' / ' + data.content.vod + ' / ' + data.content.series;
            document.getElementById('totalSources').textContent = data.totalSources;
            const tbody = document.querySelector('#recentUsers tbody');
            tbody.innerHTML = data.recentUsers.map(u => \`<tr><td><strong>\${u.username}</strong> \${u.isTrial ? '<span class="trial-badge">TESTE</span>' : ''}</td><td>\${u.isTrial ? 'Teste' : (u.isAdmin ? 'Admin' : 'User')}</td><td>\${new Date(u.createdAt).toLocaleDateString('pt-BR')}</td><td>\${u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')}</td><td class="\${u.status === 'Active' ? 'status-active' : 'status-expired'}">\${u.status}</td></tr>\`).join('');
            document.getElementById('currentDate').textContent = new Date().toLocaleDateString('pt-BR');
            document.getElementById('currentUser').textContent = 'Admin';
        }

        async function loadUsers() {
            const res = await fetch('/admin/api/users', { headers: { 'Authorization': localStorage.getItem('adminToken') }});
            if (res.status === 401) { logout(); return; }
            users = await res.json();
            renderUsers(users);
        }

        async function loadSources() {
            const res = await fetch('/admin/api/sources', { headers: { 'Authorization': localStorage.getItem('adminToken') }});
            if (res.status === 401) { logout(); return; }
            const sources = await res.json();
            const container = document.getElementById('sourcesList');
            if (sources.length === 0) {
                container.innerHTML = '<p style="color: #666;">Nenhuma fonte M3U configurada. Adicione uma fonte para começar.</p>';
                return;
            }
            container.innerHTML = sources.map(s => {
                const statusClass = s.status === 'active' ? 'success' : 'error';
                const statusText = s.status === 'active' ? 'Ativo' : 'Erro';
                return \`<div class="source-card \${statusClass}">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <strong>\${s.name}</strong>
                        <span class="source-status \${s.status}">\${statusText}</span>
                    </div>
                    <div style="font-size: 12px; color: #666; margin-bottom: 10px;">
                        URL: \${s.url.substring(0, 50)}...<br>
                        Tipo: \${s.type} | Última atualização: \${s.lastUpdate ? new Date(s.lastUpdate).toLocaleString('pt-BR') : 'Nunca'}
                        \${s.lastError ? '<br><span style="color: #e74c3c;">Erro: ' + s.lastError + '</span>' : ''}
                    </div>
                    <div>
                        <button class="btn-danger" onclick="deleteSource('\${s.id}')">🗑️ Remover</button>
                    </div>
                </div>\`;
            }).join('');
        }

        function renderUsers(userList) {
            const tbody = document.querySelector('#usersTable tbody');
            tbody.innerHTML = userList.map(u => {
                const isExpired = new Date(u.expiresAt) < new Date() && u.expiresAt !== 'never';
                let statusClass = isExpired ? 'status-expired' : (u.status === 'Active' ? 'status-active' : 'status-expired');
                let statusText = isExpired ? 'EXPIRADO' : u.status;
                if (u.isTrial && !isExpired) {
                    statusClass = 'status-trial';
                    statusText = 'TESTE';
                }
                return \`<tr><td><strong>\${u.username}</strong> \${u.isTrial ? '<span class="trial-badge">TESTE</span>' : ''}</td><td><span class="copy-link" onclick="copyToClipboard('\${u.password}')" title="Copiar senha">\${u.password.substring(0, 8)}...</span></td><td><span class="badge \${u.isAdmin ? 'badge-admin' : (u.isTrial ? 'badge-trial' : 'badge-user')}">\${u.isAdmin ? 'Admin' : (u.isTrial ? 'Teste' : 'User')}</span></td><td>\${new Date(u.createdAt).toLocaleDateString('pt-BR')}</td><td>\${u.expiresAt === 'never' ? 'Nunca' : new Date(u.expiresAt).toLocaleDateString('pt-BR')}</td><td>\${u.activeConnections} / \${u.maxConnections}</td><td class="\${statusClass}">\${statusText}</td><td><button class="btn-success" onclick="copyLink('\${u.username}', '\${u.password}')">🔗 Link</button><button class="btn-warning" onclick="editUser('\${u.id}')">✏️</button><button class="btn-danger" onclick="deleteUser('\${u.id}')" \${u.isAdmin ? 'disabled' : ''}>🗑️</button></td></tr>\`;
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
            showSyncStatus('⏳ Criando usuário e sincronizando com GitHub...', 'loading');
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
                showSyncStatus('✅ Usuário criado e sincronizado!', 'success');
                alert(\`Usuário criado!\\nUsuário: \${result.user.username}\\nSenha: \${result.user.password}\`);
                closeModal('createUser');
                loadUsers();
                loadDashboard();
                document.getElementById('createUserForm').reset();
                updateLastSync();
            } else {
                showSyncStatus('❌ Erro: ' + result.error, 'error');
                alert('Erro: ' + result.error);
            }
        }

        async function handleCreateTrial(e) {
            e.preventDefault();
            showSyncStatus('⏳ Criando teste e sincronizando...', 'loading');
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
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                showSyncStatus('✅ Teste criado e sincronizado!', 'success');
                alert(\`⚡ Conta de teste criada!\\nUsuário: \${result.user.username}\\nSenha: \${result.user.password}\\n\\n⏰ Expira em: 1 hora\`);
                closeModal('createTrial');
                loadUsers();
                loadDashboard();
                document.getElementById('createTrialForm').reset();
                updateLastSync();
            } else {
                showSyncStatus('❌ Erro: ' + result.error, 'error');
                alert('Erro: ' + result.error);
            }
        }

        async function handleAddSource(e) {
            e.preventDefault();
            showSyncStatus('⏳ Adicionando fonte...', 'loading');
            const data = {
                name: document.getElementById('sourceName').value,
                url: document.getElementById('sourceUrl').value,
                type: document.getElementById('sourceType').value
            };
            const res = await fetch('/admin/api/sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': localStorage.getItem('adminToken') },
                body: JSON.stringify(data)
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                showSyncStatus('✅ Fonte adicionada!', 'success');
                alert('✅ Fonte M3U adicionada com sucesso!');
                closeModal('addSource');
                loadSources();
                loadDashboard();
                document.getElementById('addSourceForm').reset();
                reloadAllSources();
            } else {
                showSyncStatus('❌ Erro: ' + result.error, 'error');
                alert('❌ Erro: ' + result.error);
            }
        }

        async function deleteSource(id) {
            if (!confirm('Tem certeza que deseja remover esta fonte M3U?')) return;
            showSyncStatus('⏳ Removendo fonte...', 'loading');
            const res = await fetch('/admin/api/sources/' + id, {
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('adminToken') }
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                showSyncStatus('✅ Fonte removida!', 'success');
                loadSources();
                loadDashboard();
                reloadAllSources();
            }
        }

        async function reloadAllSources() {
            showSyncStatus('⏳ Recarregando M3U...', 'loading');
            const res = await fetch('/admin/api/reload-m3u', {
                method: 'POST',
                headers: { 'Authorization': localStorage.getItem('adminToken') }
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                showSyncStatus('✅ M3U recarregado!', 'success');
                alert(\`✅ M3U recarregado!\\nCanais: \${result.stats.live}\\nFilmes: \${result.stats.vod}\\nSéries: \${result.stats.series}\`);
                loadDashboard();
            } else {
                showSyncStatus('❌ Erro ao recarregar', 'error');
                alert('❌ Erro ao recarregar: ' + result.error);
            }
        }

        async function triggerDeploy() {
            showSyncStatus('⏳ Acionando deploy...', 'loading');
            const res = await fetch('/admin/api/deploy', {
                method: 'POST',
                headers: { 'Authorization': localStorage.getItem('adminToken') }
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                showSyncStatus('🚀 Deploy acionado!', 'success');
                alert('🚀 Deploy acionado com sucesso no Render!');
            } else {
                showSyncStatus('⚠️ Erro no deploy', 'error');
                alert('⚠️ Erro no deploy: ' + result.error);
            }
        }

        async function syncNow() {
            showSyncStatus('⏳ Sincronizando com GitHub...', 'loading');
            const res = await fetch('/admin/api/sync', {
                method: 'POST',
                headers: { 'Authorization': localStorage.getItem('adminToken') }
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                showSyncStatus('✅ Sincronizado!', 'success');
                alert('✅ Sincronização concluída!\\nCommit: ' + result.github.commitSha.substring(0, 7));
                updateLastSync();
            } else {
                showSyncStatus('❌ Erro: ' + result.error, 'error');
                alert('❌ Erro na sincronização: ' + result.error);
            }
        }

        function updateLastSync() {
            document.getElementById('lastSync').textContent = new Date().toLocaleString('pt-BR');
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
            showSyncStatus('⏳ Salvando alterações...', 'loading');
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
                showSyncStatus('✅ Alterações salvas!', 'success');
                closeModal('editUser');
                loadUsers();
                loadDashboard();
                updateLastSync();
            } else {
                showSyncStatus('❌ Erro: ' + result.error, 'error');
                alert('Erro: ' + result.error);
            }
        }

        async function deleteUser(id) {
            if (!confirm('Tem certeza que deseja excluir este usuário?')) return;
            showSyncStatus('⏳ Excluindo usuário...', 'loading');
            const res = await fetch('/admin/api/users/' + id, {
                method: 'DELETE',
                headers: { 'Authorization': localStorage.getItem('adminToken') }
            });
            if (res.status === 401) { logout(); return; }
            const result = await res.json();
            if (result.success) {
                showSyncStatus('✅ Usuário excluído!', 'success');
                loadUsers();
                loadDashboard();
                updateLastSync();
            }
        }

        function copyLink(username, password) {
            const url = \`\${window.location.origin}/get.php?username=\${username}&password=\${password}&type=m3u_plus\`;
            copyToClipboard(url);
            alert('Link M3U copiado para a área de transferência!');
        }

        function copyToClipboard(text) { navigator.clipboard.writeText(text); }

        async function saveSettings() {
            showSyncStatus('⏳ Salvando configurações...', 'loading');
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
            if (result.success) {
                showSyncStatus('✅ Configurações salvas!', 'success');
                alert('Configurações salvas!');
                updateLastSync();
            }
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

// ==================== APIs ADMINISTRATIVAS ====================

// Estatísticas
app.get("/admin/api/stats", verifyToken, (req, res) => {
    const totalUsers = db.users.length;
    const activeUsers = db.users.filter(u => !isExpired(u) && u.status === "Active" && !u.isTrial).length;
    const trialUsers = db.users.filter(u => u.isTrial && !isExpired(u)).length;
    const expiredUsers = db.users.filter(u => isExpired(u)).length;
    const recentUsers = [...db.users].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);

    res.json({
        totalUsers,
        activeUsers,
        trialUsers,
        expiredUsers,
        totalSources: m3uSources.length,
        content: { live: live.length, vod: vod.length, series: Object.keys(series).length },
        recentUsers
    });
});

// Listar fontes M3U
app.get("/admin/api/sources", verifyToken, (req, res) => {
    res.json(m3uSources);
});

// Adicionar fonte M3U
app.post("/admin/api/sources", verifyToken, async (req, res) => {
    const { name, url, type } = req.body;
    const result = await addM3USource(name, url, type || 'all');
    
    if (result.success) {
        await parseAllM3USources();
        // Sincroniza com GitHub e aciona deploy
        const syncResult = await syncToGitHubAndDeploy(`Adicionada fonte M3U: ${name}`);
        return res.json({ ...result, sync: syncResult });
    }
    
    res.json(result);
});

// Deletar fonte M3U
app.delete("/admin/api/sources/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const source = m3uSources.find(s => s.id === id);
    const success = removeM3USource(id);
    
    if (success) {
        await parseAllM3USources();
        const syncResult = await syncToGitHubAndDeploy(`Removida fonte M3U: ${source?.name || id}`);
        return res.json({ success, sync: syncResult });
    }
    
    res.json({ success });
});

// Recarregar M3U
app.post("/admin/api/reload-m3u", verifyToken, async (req, res) => {
    try {
        await parseAllM3USources();
        res.json({ 
            success: true, 
            stats: { live: live.length, vod: vod.length, series: Object.keys(series).length }
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Trigger deploy manual
app.post("/admin/api/deploy", verifyToken, async (req, res) => {
    const result = await triggerRenderDeploy();
    res.json(result);
});

// Sincronização manual com GitHub
app.post("/admin/api/sync", verifyToken, async (req, res) => {
    const result = await syncToGitHubAndDeploy("Sincronização manual via painel");
    res.json(result);
});

// Listar usuários
app.get("/admin/api/users", verifyToken, (req, res) => {
    res.json(db.users.map(u => ({ ...u, isExpired: isExpired(u) })));
});

// Criar usuário - AGORA COM SINCRONIZAÇÃO GITHUB
app.post("/admin/api/users", verifyToken, async (req, res) => {
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
        isTrial: false,
        createdAt: new Date().toISOString(),
        expiresAt: expiryDays ? calculateExpiryDate(expiryDays) : "never",
        maxConnections: maxConnections || db.settings.defaultMaxConnections,
        activeConnections: 0,
        status: "Active",
        notes: notes || ""
    };

    db.users.push(newUser);
    
    // SINCRONIZA COM GITHUB E ACIONA DEPLOY
    const syncResult = await syncToGitHubAndDeploy(`Criado usuário: ${finalUsername}`);
    
    res.json({ 
        success: true, 
        user: newUser,
        sync: syncResult
    });
});

// Criar conta de teste (1 hora) - AGORA COM SINCRONIZAÇÃO GITHUB
app.post("/admin/api/users/trial", verifyToken, async (req, res) => {
    const { username, password, maxConnections, notes } = req.body;
    const finalUsername = username || "trial" + Math.floor(Math.random() * 10000);
    const finalPassword = password || generatePassword(6);
    
    if (db.users.find(u => u.username === finalUsername)) {
        return res.json({ success: false, error: "Usuário já existe" });
    }

    const trialUser = {
        id: generateId(),
        username: finalUsername,
        password: finalPassword,
        isAdmin: false,
        isTrial: true,
        createdAt: new Date().toISOString(),
        expiresAt: calculateTrialExpiry(),
        maxConnections: maxConnections || 1,
        activeConnections: 0,
        status: "Active",
        notes: notes || "Conta de teste 1 hora"
    };

    db.users.push(trialUser);
    
    // SINCRONIZA COM GITHUB E ACIONA DEPLOY
    const syncResult = await syncToGitHubAndDeploy(`Criado teste: ${finalUsername}`);
    
    res.json({ 
        success: true, 
        user: trialUser,
        sync: syncResult
    });
});

// Editar usuário - AGORA COM SINCRONIZAÇÃO GITHUB
app.put("/admin/api/users/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const userIndex = db.users.findIndex(u => u.id === id);
    if (userIndex === -1) return res.json({ success: false, error: "Usuário não encontrado" });

    const { password, expiresAt, maxConnections, status, notes } = req.body;
    const oldUsername = db.users[userIndex].username;
    
    if (password) db.users[userIndex].password = password;
    if (expiresAt) db.users[userIndex].expiresAt = expiresAt;
    if (maxConnections) db.users[userIndex].maxConnections = maxConnections;
    if (status) db.users[userIndex].status = status;
    if (notes !== undefined) db.users[userIndex].notes = notes;

    // SINCRONIZA COM GITHUB E ACIONA DEPLOY
    const syncResult = await syncToGitHubAndDeploy(`Editado usuário: ${oldUsername}`);
    
    res.json({ 
        success: true, 
        user: db.users[userIndex],
        sync: syncResult
    });
});

// Deletar usuário - AGORA COM SINCRONIZAÇÃO GITHUB
app.delete("/admin/api/users/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const userIndex = db.users.findIndex(u => u.id === id);
    if (userIndex === -1) return res.json({ success: false, error: "Usuário não encontrado" });
    if (db.users[userIndex].isAdmin) return res.json({ success: false, error: "Não pode deletar admin" });

    const username = db.users[userIndex].username;
    db.users.splice(userIndex, 1);
    
    // SINCRONIZA COM GITHUB E ACIONA DEPLOY
    const syncResult = await syncToGitHubAndDeploy(`Removido usuário: ${username}`);
    
    res.json({ 
        success: true,
        sync: syncResult
    });
});

// Configurações - AGORA COM SINCRONIZAÇÃO GITHUB
app.put("/admin/api/settings", verifyToken, async (req, res) => {
    const { serverName, defaultExpiryDays, defaultMaxConnections } = req.body;
    db.settings.serverName = serverName || db.settings.serverName;
    db.settings.defaultExpiryDays = defaultExpiryDays || db.settings.defaultExpiryDays;
    db.settings.defaultMaxConnections = defaultMaxConnections || db.settings.defaultMaxConnections;
    
    // SINCRONIZA COM GITHUB E ACIONA DEPLOY
    const syncResult = await syncToGitHubAndDeploy("Atualizadas configurações do servidor");
    
    res.json({ 
        success: true, 
        settings: db.settings,
        sync: syncResult
    });
});

// ==================== INICIALIZAÇÃO ====================

async function initialize() {
    loadDatabase();
    loadM3USources();
    await parseAllM3USources();
    
    app.listen(PORT, () => {
        console.log("========================================");
        console.log("🚀 SERVIDOR IPTV + PAINEL ADMIN RODANDO");
        console.log(`📡 Porta: ${PORT}`);
        console.log(`💾 Banco de dados: ${DB_FILE}`);
        console.log(`🔗 Fontes M3U: ${m3uSources.length}`);
        console.log("========================================");
        console.log("Endpoints:");
        console.log(`➜ IPTV API: http://localhost:${PORT}/player_api.php`);
        console.log(`➜ Painel Admin: http://localhost:${PORT}/admin`);
        console.log("========================================");
        console.log("Login padrão do painel:");
        console.log("Usuário: klord");
        console.log("Senha: Kl0rd777");
        console.log("========================================");
        console.log("🆕 NOVAS FUNCIONALIDADES:");
        console.log("   ✅ Suporte a URLs M3U externas");
        console.log("   ✅ Contas de teste (1 hora)");
        console.log("   ✅ INTEGRAÇÃO GITHUB - Auto sync");
        console.log("   ✅ Auto-deploy no Render");
        console.log("========================================");
        console.log("Config GitHub:");
        console.log(`   Repo: ${CONFIG.GITHUB_OWNER}/${CONFIG.GITHUB_REPO}`);
        console.log(`   Arquivo: ${CONFIG.GITHUB_FILE_PATH}`);
        console.log(`   Branch: ${CONFIG.GITHUB_BRANCH}`);
        console.log("========================================");
    });
}

initialize();


