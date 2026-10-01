// Prepara todo lo necesario para correr el servidor:
//  1. Motor Xash3D-FWGS nativo (servidor dedicado) en runtime/server
//  2. Lógica de servidor CS 1.6 open-source (ReGameDLL_CS de CS16Client) + bots YaPB
//  3. Paquete de assets para el navegador (runtime/web/valve.zip) a partir de tu instalación
//  4. Build del cliente web (dist/)
//
// Uso: npm run setup [-- --force] [-- --update] [-- --no-build]
//   --force   rehace todo (extracción y paquete de assets)
//   --update  descarga las últimas builds "continuous" del motor y de CS16Client
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ZipWriter } from './lib/zip.mjs';
import { loadConfig, ROOT, RUNTIME, SERVER_DIR, WEB_DIR, VENDOR } from './lib/config.mjs';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const UPDATE = args.has('--update');
const NO_BUILD = args.has('--no-build');

const DOWNLOADS = {
    engine: {
        file: 'xash3d-fwgs-win32-i386.7z',
        url: 'https://github.com/FWGS/xash3d-fwgs/releases/download/continuous/xash3d-fwgs-win32-i386.7z',
    },
    cs: {
        file: 'CS16Client-Windows-X86.zip',
        url: 'https://github.com/Velaron/cs16-client/releases/download/continuous/CS16Client-Windows-X86.zip',
    },
};

// Formato del paquete web: cambiar este número invalida la caché de los navegadores
const PACK_FORMAT = 1;

// Lo que NO viaja al navegador (no lo usa CS 1.6 o es código nativo)
const EXCLUDED_DIRS = {
    valve: ['maps', 'media', 'overviews', 'cl_dlls', 'dlls', 'save', 'logs', 'controller_configs', 'downloads'],
    cstrike: ['cl_dlls', 'dlls', 'overviews', 'manual', 'save', 'logs', 'downloads'],
};
const EXCLUDED_EXT = new Set(['.dll', '.so', '.dylib', '.exe', '.icns', '.ico', '.dem', '.pdb', '.lib', '.vdf', '.fgd']);

const log = (...m) => console.log('[setup]', ...m);

function fail(msg) {
    console.error(`\n[setup] ERROR: ${msg}\n`);
    process.exit(1);
}

function fmtMB(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TAR = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'bsdtar';

function tar(argv, cwd) {
    const r = spawnSync(TAR, argv, { cwd, stdio: 'inherit' });
    if (r.error) fail(`no se pudo ejecutar ${TAR}: ${r.error.message}`);
    if (r.status !== 0) fail(`falló la extracción (${TAR} ${argv.join(' ')})`);
}

async function ensureDownload({ file, url }) {
    const dest = path.join(VENDOR, 'downloads', file);
    if (fs.existsSync(dest) && !UPDATE) return dest;
    log(`Descargando ${url}`);
    const res = await fetch(url);
    if (!res.ok) fail(`descarga fallida (${res.status}) ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    log(`  ${fmtMB(buf.length)} guardado en ${path.relative(ROOT, dest)}`);
    return dest;
}

function checkGame(cfg) {
    const valve = path.join(cfg.gamePathAbs, 'valve');
    const cstrike = path.join(cfg.gamePathAbs, 'cstrike');
    if (!fs.existsSync(valve) || !fs.existsSync(cstrike)) {
        fail(`no encuentro valve/ y cstrike/ dentro de "${cfg.gamePathAbs}". Ajustá "gamePath" en config.json`);
    }
    if (!fs.existsSync(path.join(cstrike, 'maps', `${cfg.map}.bsp`))) {
        log(`AVISO: el mapa inicial ${cfg.map} no existe en cstrike/maps`);
    }
}

async function setupServer() {
    if (process.platform !== 'win32') {
        fail('por ahora el servidor dedicado está preparado para Windows (xash3d-fwgs win32)');
    }
    const marker = path.join(SERVER_DIR, '.setup.json');
    const engineArchive = await ensureDownload(DOWNLOADS.engine);
    const csArchive = await ensureDownload(DOWNLOADS.cs);
    const stamp = JSON.stringify({
        layout: 2,
        engine: fs.statSync(engineArchive).size,
        cs: fs.statSync(csArchive).size,
    });
    if (!FORCE && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp
        && fs.existsSync(path.join(SERVER_DIR, 'xash3d.exe'))) {
        log('Servidor dedicado ya preparado (usá --force para rehacerlo)');
        return;
    }
    const exe = path.join(SERVER_DIR, 'xash3d.exe');
    if (fs.existsSync(exe)) {
        // si el servidor está corriendo, el .exe está bloqueado y no se puede reemplazar
        try {
            fs.closeSync(fs.openSync(exe, 'r+'));
        } catch {
            fail('el servidor está corriendo. Cerralo (escribí "salir" en su consola) y volvé a ejecutar el setup');
        }
    }
    log('Extrayendo motor Xash3D-FWGS (servidor dedicado)...');
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    tar(['-xf', engineArchive, '--exclude', '*.pdb', '-C', SERVER_DIR]);

    log('Extrayendo ReGameDLL_CS + YaPB (CS16Client)...');
    tar(['-xf', csArchive, '-C', SERVER_DIR,
        'cstrike/dlls/mp.dll', 'cstrike/dlls/yapb.dll', 'cstrike/extras.pk3']);

    // config por defecto de YaPB: el servidor genera su propia versión con la cantidad de bots elegida
    const yapbCfg = spawnSync(TAR, ['-xOf', path.join(SERVER_DIR, 'cstrike', 'extras.pk3'), 'addons/yapb/conf/yapb.cfg'], { maxBuffer: 16 << 20 });
    if (yapbCfg.status !== 0) fail('no se pudo leer addons/yapb/conf/yapb.cfg de extras.pk3');
    fs.writeFileSync(path.join(SERVER_DIR, 'yapb.default.cfg'), yapbCfg.stdout);

    for (const f of ['listip.cfg', 'banned.cfg']) {
        const p = path.join(SERVER_DIR, 'cstrike', f);
        if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    }
    fs.writeFileSync(marker, stamp);
    log('Servidor dedicado listo en runtime/server');
}

function walk(dir, rel, out) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
            walk(abs, r, out);
        } else if (ent.isFile()) {
            out.push({ abs, rel: r });
        }
    }
}

function collectAssets(cfg) {
    const files = [];
    for (const game of ['valve', 'cstrike']) {
        const base = path.join(cfg.gamePathAbs, game);
        for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
            if (ent.isDirectory() && EXCLUDED_DIRS[game].includes(ent.name.toLowerCase())) continue;
            const abs = path.join(base, ent.name);
            if (ent.isDirectory()) {
                walk(abs, `${game}/${ent.name}`, files);
            } else if (ent.isFile()) {
                files.push({ abs, rel: `${game}/${ent.name}` });
            }
        }
    }
    return files
        .filter(f => !EXCLUDED_EXT.has(path.extname(f.rel).toLowerCase()))
        .map(f => ({ ...f, stat: fs.statSync(f.abs) }))
        .sort((a, b) => a.rel.localeCompare(b.rel));
}

function buildAssetPack(cfg) {
    const files = collectAssets(cfg);
    const hash = crypto.createHash('sha1');
    hash.update(`format:${PACK_FORMAT}\n`);
    for (const f of files) hash.update(`${f.rel}|${f.stat.size}|${Math.floor(f.stat.mtimeMs)}\n`);
    const version = hash.digest('hex').slice(0, 16);

    const zipPath = path.join(WEB_DIR, 'valve.zip');
    const metaPath = path.join(WEB_DIR, 'assets.json');
    if (!FORCE && fs.existsSync(zipPath) && fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.version === version) {
            log(`Paquete de assets al día (${meta.files} archivos, ${fmtMB(meta.size)})`);
            return;
        }
    }

    const total = files.reduce((s, f) => s + f.stat.size, 0);
    log(`Empaquetando ${files.length} archivos (${fmtMB(total)}) para el navegador...`);
    fs.mkdirSync(WEB_DIR, { recursive: true });
    const tmp = `${zipPath}.tmp`;
    const zip = new ZipWriter(tmp);
    let done = 0;
    let lastPct = -1;
    for (const f of files) {
        zip.addFile(f.rel, fs.readFileSync(f.abs), f.stat.mtime);
        done += f.stat.size;
        const pct = Math.floor(done * 100 / total);
        if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            log(`  ${pct}%`);
        }
    }
    zip.close();
    fs.renameSync(tmp, zipPath);
    const size = fs.statSync(zipPath).size;
    fs.writeFileSync(metaPath, JSON.stringify({ version, files: files.length, size, unpacked: total }, null, 2));
    log(`Paquete listo: runtime/web/valve.zip (${fmtMB(size)})`);
}

function newestMtime(target) {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return st.mtimeMs;
    let max = st.mtimeMs;
    for (const ent of fs.readdirSync(target)) max = Math.max(max, newestMtime(path.join(target, ent)));
    return max;
}

function buildClient() {
    const index = path.join(ROOT, 'dist', 'index.html');
    if (!FORCE && fs.existsSync(index)) {
        const sources = ['client', 'vendor', 'vite.config.ts', 'package.json'].map(p => newestMtime(path.join(ROOT, p)));
        if (fs.statSync(index).mtimeMs > Math.max(...sources)) {
            log('Cliente web al día');
            return;
        }
    }
    log('Compilando cliente web (vite build)...');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
        cwd: ROOT,
        stdio: 'inherit',
    });
    if (r.status !== 0) fail('falló vite build');
}

async function main() {
    const cfg = loadConfig();
    log(`Instalación original: ${cfg.gamePathAbs}`);
    checkGame(cfg);
    fs.mkdirSync(RUNTIME, { recursive: true });
    await setupServer();
    buildAssetPack(cfg);
    if (!NO_BUILD) buildClient();
    log('Listo. Ejecutá "npm start" (o INICIAR-SERVIDOR.bat) para levantar el servidor.');
}

main().catch(e => fail(e.stack || e.message));
