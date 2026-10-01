// Lanza el servidor dedicado Xash3D (XashDS) con ReGameDLL_CS y lo controla por RCON.
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { SERVER_DIR, ROOT } from '../scripts/lib/config.mjs';

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function cfgString(v) {
    return `"${String(v).replace(/["\r\n;]/g, '')}"`;
}

export class GameServer extends EventEmitter {
    constructor(cfg) {
        super();
        this.cfg = cfg;
        this.proc = null;
        this.map = cfg.map;
        this.players = 0;
        this.stopping = false;
        this.logPath = path.join(SERVER_DIR, 'engine.log');
        this.logOffset = 0;
        this.logRest = '';
        this.rcon = null;
        this.rconBuffer = [];
        this.restarts = 0;
    }

    writeServerCfg() {
        const c = this.cfg;
        const template = fs.readFileSync(path.join(ROOT, 'server-config', 'server.cfg'), 'utf8');
        const generated = [
            '// ARCHIVO GENERADO por server/gameserver.mjs en cada inicio.',
            '// Editá server-config/server.cfg (base) o server-config/custom.cfg (tus cambios).',
            `hostname ${cfgString(c.hostname)}`,
            `rcon_password ${cfgString(c.rconPassword)}`,
            `sv_password ${cfgString(c.password)}`,
            template,
            'exec custom.cfg',
            '',
        ].join('\n');
        const dir = path.join(SERVER_DIR, 'cstrike');
        fs.writeFileSync(path.join(dir, 'server.cfg'), generated);
        fs.copyFileSync(path.join(ROOT, 'server-config', 'custom.cfg'), path.join(dir, 'custom.cfg'));
        fs.copyFileSync(path.join(ROOT, 'server-config', 'mapcycle.txt'), path.join(dir, 'mapcycle.txt'));
        this.writeYapbCfg();
    }

    // Un archivo suelto en runtime/server/cstrike tiene prioridad sobre el de extras.pk3
    writeYapbCfg() {
        const base = path.join(SERVER_DIR, 'yapb.default.cfg');
        if (!fs.existsSync(base)) return;
        const set = {
            yb_quota: Math.max(0, Math.floor(this.cfg.bots)),
            yb_difficulty: Math.min(4, Math.max(0, Math.floor(this.cfg.botDifficulty))),
        };
        let text = fs.readFileSync(base, 'utf8');
        for (const [k, v] of Object.entries(set)) {
            text = text.replace(new RegExp(`^${k} ".*"`, 'm'), `${k} "${v}"`);
        }
        const dir = path.join(SERVER_DIR, 'cstrike', 'addons', 'yapb', 'conf');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'yapb.cfg'), text);
    }

    start() {
        const c = this.cfg;
        const exe = path.join(SERVER_DIR, 'xash3d.exe');
        if (!fs.existsSync(exe)) {
            throw new Error('No existe runtime/server/xash3d.exe. Ejecutá primero: npm run setup');
        }
        this.writeServerCfg();
        try { fs.rmSync(this.logPath); } catch { /* no existía */ }
        this.logOffset = 0;
        this.logRest = '';

        const argv = [
            '-dedicated',
            '-game', 'cstrike',
            // YaPB se carga como "proxy" del game DLL y a su vez carga ReGameDLL (dlls/mp.dll)
            '-dll', 'dlls/yapb.dll',
            '-rodir', c.gamePathAbs,
            '-port', String(c.gamePort),
            '-log',
            '-dev', '1', // necesario para que el log informe los cambios de mapa ("Spawn Server")
            ...(c.exposeGamePort ? [] : ['-noip6']),
            '+ip', c.exposeGamePort ? '0.0.0.0' : '127.0.0.1',
            '+sv_lan', '1',
            '+maxplayers', String(c.maxPlayers),
            '+map', c.map,
        ];
        this.stopping = false;
        this.proc = spawn(exe, argv, {
            cwd: SERVER_DIR,
            stdio: 'ignore',
            windowsHide: true,
        });
        this.emit('status', `servidor dedicado iniciado (pid ${this.proc.pid})`);
        this.proc.on('exit', (code) => {
            this.proc = null;
            this.flushLog();
            if (this.stopping) return;
            this.restarts += 1;
            this.emit('status', `el servidor dedicado terminó (código ${code}); reiniciando...`);
            if (this.restarts > 5) {
                this.emit('status', 'demasiados reinicios seguidos; revisá runtime/server/engine.log');
                return;
            }
            setTimeout(() => this.start(), 2000);
        });
        clearInterval(this.logTimer);
        this.logTimer = setInterval(() => this.flushLog(), 250);
        clearTimeout(this.restartsTimer);
        this.restartsTimer = setTimeout(() => { this.restarts = 0; }, 60000);
    }

    flushLog() {
        let fd;
        try {
            fd = fs.openSync(this.logPath, 'r');
        } catch {
            return;
        }
        try {
            const size = fs.fstatSync(fd).size;
            if (size < this.logOffset) this.logOffset = 0;
            if (size === this.logOffset) return;
            const buf = Buffer.alloc(size - this.logOffset);
            fs.readSync(fd, buf, 0, buf.length, this.logOffset);
            this.logOffset = size;
            const text = this.logRest + buf.toString('utf8');
            const lines = text.split(/\r?\n/);
            this.logRest = lines.pop();
            for (const line of lines) this.onLogLine(line);
        } finally {
            fs.closeSync(fd);
        }
    }

    onLogLine(line) {
        const spawn = line.match(/^Spawn Server: (\S+)/);
        if (spawn) {
            this.map = spawn[1];
            this.emit('map', this.map);
        }
        this.emit('log', line);
    }

    stop() {
        this.stopping = true;
        clearInterval(this.logTimer);
        if (this.proc) {
            this.proc.kill();
            this.proc = null;
        }
        if (this.rcon) {
            this.rcon.close();
            this.rcon = null;
        }
    }

    // Envía un comando de consola al servidor (RCON por UDP local).
    command(cmd) {
        return new Promise((resolve) => {
            if (!this.rcon) {
                this.rcon = dgram.createSocket('udp4');
                this.rcon.bind(0, '127.0.0.1');
                this.rcon.on('message', (msg) => {
                    if (msg.length > 4 && msg.readInt32LE(0) === -1) {
                        // respuestas "l\n<texto>" (A2C_PRINT)
                        this.rconBuffer.push(msg.subarray(4).toString('utf8').replace(/^(print|l)\n?/, ''));
                    }
                });
            }
            this.rconBuffer = [];
            const payload = Buffer.concat([OOB, Buffer.from(`rcon ${this.cfg.rconPassword} ${cmd}\n`, 'utf8')]);
            this.rcon.send(payload, this.cfg.gamePort, '127.0.0.1');
            setTimeout(() => resolve(this.rconBuffer.join('')), 400);
        });
    }
}
