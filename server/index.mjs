// Punto de entrada: levanta el servidor dedicado de CS 1.6 + la web para jugar desde el navegador.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';
import { loadConfig, ROOT, WEB_DIR } from '../scripts/lib/config.mjs';
import { GameServer } from './gameserver.mjs';
import { RtcBridge } from './rtc.mjs';
import { createRequestHandler } from './http.mjs';
import { ensureCertificate } from './tls.mjs';

const C = {
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const cfg = loadConfig();
// Permite sobreescribir desde la línea de comandos: npm start -- --map de_inferno --bots 4
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(map|bots|botDifficulty|maxPlayers|hostname|password)$/);
    if (m && argv[i + 1] !== undefined) {
        cfg[m[1]] = typeof cfg[m[1]] === 'number' ? Number(argv[++i]) : argv[++i];
    }
}

if (!cfg.gamePathAbs) {
    console.error('No encontré Counter-Strike 1.6 (valve/ y cstrike/). Revisá "gamePath" en config.json o ejecutá: npm run setup');
    process.exit(1);
}

for (const [p, hint] of [
    [path.join(ROOT, 'dist', 'index.html'), 'npm run setup'],
    [path.join(WEB_DIR, 'valve.zip'), 'npm run setup'],
]) {
    if (!fs.existsSync(p)) {
        console.error(`Falta ${path.relative(ROOT, p)}. Ejecutá primero: ${hint}`);
        process.exit(1);
    }
}

function lanAddresses() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
                out.push({ name, address: a.address });
            }
        }
    }
    return out;
}

const game = new GameServer(cfg);
const bridge = new RtcBridge(cfg);

// ruido del arranque / nivel debug que no le sirve al anfitrión
const HIDDEN = [
    /^Rcon from /, /^rcon /, /^\s*$/, /^Adding directory/, /^FS_AddGameHierarchy/, /^FS_LoadProgs/,
    /SV_CvarGetPointer/, /Unknown command "yb_quota_(adding|maintain)_interval"/, /^Program args:/,
    /^Developer level/, /is working directory now$/, /^EXT: /, /Cmd_AddServerCommand: game already defined/,
];
let hideNext = false;
game.on('log', (line) => {
    // no mostrar los comandos RCON (incluyen la contraseña)
    if (hideNext) {
        hideNext = false;
        return;
    }
    if (/^Rcon from /.test(line)) {
        hideNext = true;
        return;
    }
    if (HIDDEN.some(r => r.test(line))) return;
    console.log(C.dim('[cs] ') + line);
});
game.on('status', (msg) => console.log(C.yellow(`[servidor] ${msg}`)));

game.on('map', (map) => console.log(C.green(`[servidor] mapa cargado: ${map}`)));

bridge.on('join', (p) => console.log(C.green(`[web] jugador conectado desde ${p.remote} (${bridge.count} en línea)`)));
bridge.on('leave', (p, why) => console.log(C.yellow(`[web] jugador desconectado ${p.remote}: ${why} (${bridge.count} en línea)`)));

const handler = createRequestHandler(() => ({
    hostname: cfg.hostname,
    map: game.map,
    maxPlayers: cfg.maxPlayers,
    webPlayers: bridge.count,
    needsPassword: Boolean(cfg.password),
}));

const ips = lanAddresses();
const tlsCreds = await ensureCertificate(ips.map(i => i.address));
const httpServer = http.createServer(handler);
const httpsServer = https.createServer({ key: tlsCreds.key, cert: tlsCreds.cert }, handler);
httpsServer.on('tlsClientError', () => { /* navegador que todavía no aceptó el certificado */ });

// Un solo puerto para http:// y https://: el primer byte de un handshake TLS es 0x16.
const front = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(30000, () => socket.destroy());
    socket.once('data', (buf) => {
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(buf);
        (buf[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
        process.nextTick(() => socket.resume());
    });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const onUpgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/signal') {
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        bridge.handle(ws, remote);
    });
};
httpServer.on('upgrade', onUpgrade);
httpsServer.on('upgrade', onUpgrade);

front.on('error', (err) => {
    console.error(`No se pudo abrir el puerto ${cfg.httpPort}: ${err.message}`);
    shutdown(1);
});

front.listen(cfg.httpPort, '0.0.0.0', () => {
    console.log('');
    console.log(C.bold('  Counter-Strike 1.6 — servidor web LAN'));
    console.log('');
    console.log(`  Compartí este link con tus compañeros (misma red):`);
    for (const ip of ips) {
        console.log(`    ${C.cyan(`https://${ip.address}:${cfg.httpPort}`)}   ${C.dim(ip.name)}`);
    }
    console.log(C.dim('    La primera vez el navegador avisa que el certificado no es de confianza:'));
    console.log(C.dim('    "Configuración avanzada" → "Continuar". Con https el juego bloquea Ctrl+W en pantalla completa.'));
    console.log(C.dim(`    Sin aviso (pero sin bloqueo de Ctrl+W): http://${ips[0]?.address ?? 'localhost'}:${cfg.httpPort}`));
    console.log(`    ${C.cyan(`http://localhost:${cfg.httpPort}`)}   ${C.dim('(esta PC)')}`);
    console.log('');
    console.log(`  Mapa: ${cfg.map}   Jugadores máx: ${cfg.maxPlayers}   Bots: ${cfg.bots}`);
    console.log(`  Puertos: TCP ${cfg.httpPort} (web) y UDP ${cfg.webrtcPort} (juego) — permitilos en el firewall.`);
    console.log(C.dim('  Escribí comandos de consola del servidor acá (ej: changelevel de_inferno, yb add, status).'));
    console.log(C.dim('  "salir" o Ctrl+C para cerrar.'));
    console.log('');
    try {
        game.start();
    } catch (e) {
        console.error(e.message);
        shutdown(1);
    }
});

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
    const cmd = line.trim();
    if (!cmd) return;
    if (['salir', 'exit', 'quit'].includes(cmd.toLowerCase())) {
        shutdown(0);
        return;
    }
    // la salida del comando aparece en el log del servidor
    game.command(cmd);
});

let shuttingDown = false;
function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(C.yellow('[servidor] cerrando...'));
    game.stop();
    bridge.closeAll();
    front.close();
    setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
process.on('exit', () => game.stop());
