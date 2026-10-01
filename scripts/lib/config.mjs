import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNTIME = path.join(ROOT, 'runtime');
export const SERVER_DIR = path.join(RUNTIME, 'server');
export const WEB_DIR = path.join(RUNTIME, 'web');
export const VENDOR = path.join(ROOT, 'vendor');
export const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
    // Carpeta de la instalación original (con valve/ y cstrike/).
    // "auto" = busca steamapps/Half-Life en el proyecto y después la instalación de Steam.
    gamePath: 'auto',
    hostname: 'CS 1.6 LAN',
    map: 'de_dust2',
    maxPlayers: 16,
    // Puerto HTTP: página del juego + señalización WebRTC (TCP)
    httpPort: 27016,
    // Puerto UDP por el que viaja el tráfico WebRTC de todos los jugadores
    webrtcPort: 27018,
    // Puerto UDP interno del servidor dedicado (solo escucha en 127.0.0.1)
    gamePort: 27015,
    // true = el servidor dedicado también escucha en la red (clientes CS nativos)
    exposeGamePort: false,
    // Bots YaPB al iniciar (0 = ninguno). Dificultad: 0 novato … 4 experto
    bots: 0,
    botDifficulty: 2,
    // Contraseña para entrar al servidor (vacío = sin contraseña)
    password: '',
    rconPassword: '',
};

export function loadConfig() {
    let user = {};
    if (fs.existsSync(CONFIG_PATH)) {
        user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
    const cfg = { ...DEFAULTS, ...user };
    if (!cfg.rconPassword) {
        cfg.rconPassword = crypto.randomBytes(9).toString('base64url');
    }
    // reescribe el archivo si falta o si hay opciones nuevas que el usuario todavía no tiene
    if (!fs.existsSync(CONFIG_PATH) || Object.keys(cfg).some(k => !(k in user))) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4) + '\n');
    }
    const found = findGamePath(cfg.gamePath);
    cfg.gamePathAbs = found?.path ?? null;
    cfg.gamePathSource = found?.source ?? null;
    return cfg;
}

const isGameDir = (p) => fs.existsSync(path.join(p, 'valve')) && fs.existsSync(path.join(p, 'cstrike'));

// Bibliotecas de Steam: ruta de instalación (registro) + las listadas en libraryfolders.vdf
function steamLibraries() {
    const roots = new Set();
    if (process.platform === 'win32') {
        for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
            const r = spawnSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
            for (const m of (r.stdout || '').matchAll(/(?:SteamPath|InstallPath)\s+REG_SZ\s+(.+)/gi)) {
                roots.add(path.normalize(m[1].trim()));
            }
        }
        roots.add('C:\\Program Files (x86)\\Steam');
        roots.add('C:\\Program Files\\Steam');
    } else {
        roots.add(path.join(os.homedir(), '.steam', 'steam'));
        roots.add(path.join(os.homedir(), '.local', 'share', 'Steam'));
    }
    const libs = new Set(roots);
    for (const root of roots) {
        try {
            const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
            // en el .vdf las barras vienen escapadas: "C:\\Program Files (x86)\\Steam"
            for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
        } catch { /* sin Steam en esa ruta */ }
    }
    return [...libs];
}

export function findGamePath(gamePath) {
    if (gamePath && gamePath !== 'auto') {
        const p = path.resolve(ROOT, gamePath);
        if (isGameDir(p)) return { path: p, source: 'config.json' };
    }
    const local = path.join(ROOT, 'steamapps', 'Half-Life');
    if (isGameDir(local)) return { path: local, source: 'carpeta del proyecto' };
    for (const lib of steamLibraries()) {
        const p = path.join(lib, 'steamapps', 'common', 'Half-Life');
        if (isGameDir(p)) return { path: p, source: 'Steam' };
    }
    return null;
}
