import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNTIME = path.join(ROOT, 'runtime');
export const SERVER_DIR = path.join(RUNTIME, 'server');
export const WEB_DIR = path.join(RUNTIME, 'web');
export const VENDOR = path.join(ROOT, 'vendor');
export const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
    // Carpeta de la instalación original (debe contener valve/ y cstrike/)
    gamePath: 'steamapps/Half-Life',
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
    cfg.gamePathAbs = path.resolve(ROOT, cfg.gamePath);
    return cfg;
}
