// Descarga del paquete de archivos del juego (valve.zip) con:
//  - descompresión en streaming mientras llega (no se guarda el zip entero en memoria)
//  - caché en IndexedDB por versión, para que las próximas veces no se descargue de nuevo
import { Unzip, UnzipInflate } from 'fflate';

const DB_NAME = 'csweb';
const STORE = 'assets';
const PART_SIZE = 8 * 1024 * 1024;

export type Progress = (phase: 'cache' | 'download', done: number, total: number) => void;
export type FileSink = (name: string, data: Uint8Array) => void;

function req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!('indexedDB' in window)) return null;
    try {
        const open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        return await req(open);
    } catch {
        return null;
    }
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
    return db.transaction(STORE, mode).objectStore(STORE);
}

async function dropOtherVersions(db: IDBDatabase, version: string) {
    const keys = await req(tx(db, 'readonly').getAllKeys());
    const stale = keys.filter(k => !String(k).startsWith(`${version}:`));
    if (!stale.length) return;
    const store = tx(db, 'readwrite');
    await Promise.all(stale.map(k => req(store.delete(k))));
}

function createUnzip(sink: FileSink) {
    const unzip = new Unzip((file) => {
        const chunks: Uint8Array[] = [];
        file.ondata = (err, chunk, final) => {
            if (err) throw err;
            if (chunk.length) chunks.push(chunk);
            if (!final) return;
            let data: Uint8Array;
            if (chunks.length === 1) {
                // copia si es una vista dentro de un buffer más grande (archivos sin comprimir)
                const c = chunks[0];
                data = c.byteLength === c.buffer.byteLength ? c : c.slice();
            } else {
                data = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
                let off = 0;
                for (const c of chunks) {
                    data.set(c, off);
                    off += c.length;
                }
            }
            if (!file.name.endsWith('/')) sink(file.name, data);
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    return unzip;
}

const tick = () => new Promise(r => setTimeout(r, 0));

export async function loadAssets(url: string, version: string, size: number, sink: FileSink, progress: Progress) {
    const db = await openDb();
    const unzip = createUnzip(sink);

    // 1) ¿Ya está guardado en este navegador?
    if (db) {
        try {
            const meta = await req(tx(db, 'readonly').get(`${version}:meta`)) as { parts: number; size: number } | undefined;
            if (meta) {
                let done = 0;
                for (let i = 0; i < meta.parts; i++) {
                    const part = await req(tx(db, 'readonly').get(`${version}:${i}`)) as ArrayBuffer | undefined;
                    if (!part) throw new Error('caché incompleta');
                    unzip.push(new Uint8Array(part), i === meta.parts - 1);
                    done += part.byteLength;
                    progress('cache', done, meta.size);
                    await tick();
                }
                return;
            }
        } catch (e) {
            console.warn('No se pudo usar la caché local, se descarga de nuevo', e);
            return loadAssetsFromNetwork(url, version, size, createUnzip(sink), progress, null);
        }
    }
    return loadAssetsFromNetwork(url, version, size, unzip, progress, db);
}

async function loadAssetsFromNetwork(url: string, version: string, size: number, unzip: Unzip, progress: Progress, db: IDBDatabase | null) {
    if (db) {
        await dropOtherVersions(db, version).catch(() => undefined);
    }
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${url} (${res.status})`);
    const total = Number(res.headers.get('Content-Length')) || size;
    const reader = res.body.getReader();

    let cacheOk = Boolean(db);
    let parts = 0;
    let partChunks: Uint8Array[] = [];
    let partSize = 0;
    const flushPart = async () => {
        if (!partSize) return;
        const buf = new Uint8Array(partSize);
        let off = 0;
        for (const c of partChunks) {
            buf.set(c, off);
            off += c.length;
        }
        partChunks = [];
        partSize = 0;
        if (cacheOk && db) {
            try {
                await req(tx(db, 'readwrite').put(buf.buffer, `${version}:${parts}`));
            } catch (e) {
                console.warn('No hay espacio para guardar los archivos en el navegador', e);
                cacheOk = false;
            }
        }
        parts++;
    };

    let done = 0;
    let pending: Uint8Array | null = null;
    for (;;) {
        const { done: eof, value } = await reader.read();
        if (pending) {
            unzip.push(pending, eof && !value);
            pending = null;
        }
        if (eof) break;
        // se retiene un chunk para poder marcar el último como "final"
        pending = value;
        partChunks.push(value);
        partSize += value.length;
        done += value.length;
        progress('download', done, total);
        if (partSize >= PART_SIZE) await flushPart();
    }
    if (pending) unzip.push(pending, true);
    await flushPart();

    if (cacheOk && db) {
        await req(tx(db, 'readwrite').put({ parts, size: done }, `${version}:meta`)).catch(() => undefined);
    }
}
