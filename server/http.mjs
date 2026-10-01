// Servidor HTTP estático: cliente web compilado (dist/) + paquete de assets del juego.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT, WEB_DIR } from '../scripts/lib/config.mjs';

const DIST = path.join(ROOT, 'dist');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.zip': 'application/zip',
    '.pk3': 'application/octet-stream',
    '.txt': 'text/plain; charset=utf-8',
};

function sendFile(req, res, file, cacheControl, etag) {
    let stat;
    try {
        stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error('no es archivo');
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No encontrado');
        return;
    }
    const headers = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
        'Last-Modified': stat.mtime.toUTCString(),
    };
    if (etag) {
        headers.ETag = `"${etag}"`;
        if (req.headers['if-none-match'] === headers.ETag) {
            res.writeHead(304, headers);
            res.end();
            return;
        }
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    fs.createReadStream(file).pipe(res);
}

export function readAssetsMeta() {
    try {
        return JSON.parse(fs.readFileSync(path.join(WEB_DIR, 'assets.json'), 'utf8'));
    } catch {
        return null;
    }
}

export function createHttpServer(getStatus) {
    const assets = readAssetsMeta();
    return http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            res.end();
            return;
        }

        if (pathname === '/api/status') {
            const body = JSON.stringify({ ...getStatus(), assets });
            res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
            res.end(body);
            return;
        }

        if (pathname === '/game/valve.zip') {
            // El cliente lo guarda en IndexedDB: no hace falta duplicarlo en la caché HTTP.
            sendFile(req, res, path.join(WEB_DIR, 'valve.zip'), 'no-store', assets?.version);
            return;
        }

        const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const file = path.resolve(DIST, rel);
        if (!file.startsWith(DIST + path.sep)) {
            res.writeHead(403);
            res.end();
            return;
        }
        // Los archivos de dist/assets llevan hash en el nombre: se pueden cachear para siempre.
        const immutable = rel.startsWith('assets/');
        sendFile(req, res, file, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    });
}
