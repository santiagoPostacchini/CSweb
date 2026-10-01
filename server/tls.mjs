// Certificado autofirmado para servir la web por HTTPS en la LAN.
// HTTPS hace que el navegador trate la página como "contexto seguro", requisito para
// la Keyboard Lock API (bloquear Ctrl+W) y para el micrófono.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { RUNTIME } from '../scripts/lib/config.mjs';

const DIR = path.join(RUNTIME, 'https');

export async function ensureCertificate(ips) {
    const names = ['localhost', os.hostname().toLowerCase()];
    const addresses = ['127.0.0.1', ...ips];
    const id = JSON.stringify({ names, addresses });
    const files = {
        key: path.join(DIR, 'key.pem'),
        cert: path.join(DIR, 'cert.pem'),
        meta: path.join(DIR, 'meta.json'),
    };
    try {
        const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
        if (meta.id === id && new Date(meta.expires) > new Date(Date.now() + 7 * 864e5)) {
            return { key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert), fingerprint: meta.fingerprint };
        }
    } catch { /* hay que generarlo */ }

    const notBeforeDate = new Date(Date.now() - 864e5);
    const notAfterDate = new Date(notBeforeDate);
    notAfterDate.setFullYear(notAfterDate.getFullYear() + 5);
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'CS 1.6 LAN' }], {
        keyType: 'ec',
        algorithm: 'sha256',
        notBeforeDate,
        notAfterDate,
        extensions: [
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            {
                name: 'subjectAltName',
                altNames: [
                    ...names.map(value => ({ type: 2, value })),
                    ...addresses.map(ip => ({ type: 7, ip })),
                ],
            },
        ],
    });
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(files.key, pems.private);
    fs.writeFileSync(files.cert, pems.cert);
    fs.writeFileSync(files.meta, JSON.stringify({ id, expires: notAfterDate.toISOString(), fingerprint: pems.fingerprint }, null, 2));
    return { key: pems.private, cert: pems.cert, fingerprint: pems.fingerprint };
}
