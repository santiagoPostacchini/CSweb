// Paquete con los archivos del juego que arma el anfitrión a partir de su instalación local.
// Formato: secuencia de [u16 largo del nombre][nombre UTF-8][u32 tamaño][datos], terminada con
// un nombre de largo 0, todo comprimido con deflate-raw (CompressionStream nativo del navegador).
// Sin dependencias: también se puede usar desde Node para pruebas.

export const PACK_FORMAT = 1;

// Lo que no hace falta para jugar CS 1.6 (mismas reglas que scripts/setup.mjs)
const EXCLUDED_DIRS: Record<string, string[]> = {
    valve: ['maps', 'media', 'overviews', 'cl_dlls', 'dlls', 'save', 'logs', 'controller_configs', 'downloads'],
    cstrike: ['cl_dlls', 'dlls', 'overviews', 'manual', 'save', 'logs', 'downloads'],
};
const EXCLUDED_EXT = new Set(['.dll', '.so', '.dylib', '.exe', '.icns', '.ico', '.dem', '.pdb', '.lib', '.vdf', '.fgd']);

export type SourceFile = { relPath: string; file: Blob; mtime: number };
export type PackEntry = { path: string; file: Blob; size: number; mtime: number };

// Busca, dentro de lo que eligió el usuario, la carpeta que contiene valve/ y cstrike/
// (puede haber elegido Half-Life, common, steamapps...) y devuelve los archivos útiles.
export function selectGameFiles(files: SourceFile[]): PackEntry[] | null {
    const norm = (p: string) => p.replace(/\\/g, '/');
    const lower = new Set(files.map(f => norm(f.relPath).toLowerCase()));
    let root: string | null = null;
    for (const f of files) {
        const p = norm(f.relPath).toLowerCase();
        if (!p.endsWith('cstrike/liblist.gam')) continue;
        const prefix = p.slice(0, -'cstrike/liblist.gam'.length);
        if (lower.has(`${prefix}valve/liblist.gam`)) {
            root = prefix;
            break;
        }
    }
    if (root === null) return null;

    const out: PackEntry[] = [];
    for (const f of files) {
        const full = norm(f.relPath);
        if (!full.toLowerCase().startsWith(root)) continue;
        const rel = full.slice(root.length);
        const [game, first, ...rest] = rel.split('/');
        const gameKey = game.toLowerCase();
        if (!(gameKey in EXCLUDED_DIRS) || !first) continue;
        if (rest.length && EXCLUDED_DIRS[gameKey].includes(first.toLowerCase())) continue;
        const dot = rel.lastIndexOf('.');
        if (dot > rel.lastIndexOf('/') && EXCLUDED_EXT.has(rel.slice(dot).toLowerCase())) continue;
        out.push({ path: `${gameKey}/${[first, ...rest].join('/')}`, file: f.file, size: f.file.size, mtime: f.mtime });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function packVersion(entries: PackEntry[]): Promise<string> {
    const text = `format:${PACK_FORMAT}\n` + entries.map(e => `${e.path}|${e.size}|${Math.floor(e.mtime)}`).join('\n');
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function mapsOf(entries: PackEntry[]): string[] {
    return entries
        .map(e => e.path.match(/^cstrike\/maps\/([^/]+)\.bsp$/i)?.[1])
        .filter((m): m is string => Boolean(m))
        .sort();
}

export type BuildProgress = (files: number, totalFiles: number, bytes: number, totalBytes: number) => void;

export function buildPack(entries: PackEntry[], onProgress?: BuildProgress): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const totalBytes = entries.reduce((s, e) => s + e.size, 0);
    let i = 0;
    let bytes = 0;
    const source = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (i >= entries.length) {
                controller.enqueue(new Uint8Array(2)); // fin
                controller.close();
                return;
            }
            const e = entries[i++];
            const data = new Uint8Array(await e.file.arrayBuffer());
            const name = enc.encode(e.path);
            const header = new Uint8Array(2 + name.length + 4);
            const view = new DataView(header.buffer);
            view.setUint16(0, name.length, true);
            header.set(name, 2);
            view.setUint32(2 + name.length, data.length, true);
            controller.enqueue(header);
            controller.enqueue(data);
            bytes += data.length;
            onProgress?.(i, entries.length, bytes, totalBytes);
        },
    });
    return source.pipeThrough(new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
}

// Descomprime y recorre el paquete, entregando cada archivo a `sink`
export async function readPack(stream: ReadableStream<Uint8Array>, sink: (name: string, data: Uint8Array) => void) {
    const reader = stream
        .pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>)
        .getReader();
    const dec = new TextDecoder();
    let chunk: Uint8Array = new Uint8Array(0);
    let pos = 0;

    const read = async (n: number) => {
        const out = new Uint8Array(n);
        let off = 0;
        while (off < n) {
            if (pos >= chunk.length) {
                const r = await reader.read();
                if (r.done) throw new Error('El paquete de archivos está incompleto o dañado');
                chunk = r.value;
                pos = 0;
            }
            const take = Math.min(n - off, chunk.length - pos);
            out.set(chunk.subarray(pos, pos + take), off);
            off += take;
            pos += take;
        }
        return out;
    };

    for (;;) {
        const h = await read(2);
        const nameLen = h[0] | (h[1] << 8);
        if (nameLen === 0) break;
        const name = dec.decode(await read(nameLen));
        const s = await read(4);
        const size = new DataView(s.buffer).getUint32(0, true);
        sink(name, await read(size));
    }
    reader.cancel().catch(() => undefined);
}
