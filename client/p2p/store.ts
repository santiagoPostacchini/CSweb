// Guarda el paquete de archivos del juego en IndexedDB (en partes de ~8 MB, como Blobs en disco),
// así no hay que volver a elegir la carpeta ni volver a recibirlo del anfitrión.

// ?perfil=xxx usa otro espacio de almacenamiento (para probar anfitrión e invitado en la misma PC)
const PROFILE = new URLSearchParams(location.search).get('perfil')?.replace(/[^a-z0-9_-]/gi, '');
const DB_NAME = PROFILE ? `csweb-pack-${PROFILE}` : 'csweb-pack';
const STORE = 'pack';
const PART_SIZE = 8 * 1024 * 1024;

export type PackMeta = {
    version: string;
    size: number;      // bytes comprimidos
    parts: number;
    files: number;
    unpacked: number;  // bytes descomprimidos
    maps: string[];
};

function req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db() {
    if (!dbPromise) {
        const open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        dbPromise = req(open);
    }
    return dbPromise;
}

async function store(mode: IDBTransactionMode) {
    return (await db()).transaction(STORE, mode).objectStore(STORE);
}

export async function getMeta(): Promise<PackMeta | null> {
    try {
        return (await req((await store('readonly')).get('meta'))) as PackMeta ?? null;
    } catch {
        return null;
    }
}

// Todo el paquete como un único Blob (respaldado por disco: no ocupa RAM)
export async function getPackBlob(meta: PackMeta): Promise<Blob> {
    const parts: Blob[] = [];
    for (let i = 0; i < meta.parts; i++) {
        const part = await req((await store('readonly')).get(`${meta.version}:${i}`)) as Blob | undefined;
        if (!part) throw new Error('Los archivos guardados están incompletos: volvé a cargarlos');
        parts.push(part);
    }
    return new Blob(parts);
}

// Escribe un paquete nuevo de a partes; al terminar lo marca como el actual y borra el anterior.
export class PackWriter {
    private chunks: Uint8Array[] = [];
    private pending = 0;
    private parts = 0;
    private written = 0;
    private flushing: Promise<void> = Promise.resolve();

    constructor(private version: string) {}

    get bytes() {
        return this.written + this.pending;
    }

    push(chunk: Uint8Array) {
        this.chunks.push(chunk);
        this.pending += chunk.length;
        if (this.pending >= PART_SIZE) this.flush();
    }

    private flush() {
        if (!this.pending) return this.flushing;
        const blob = new Blob(this.chunks as BlobPart[]);
        const key = `${this.version}:${this.parts++}`;
        this.written += this.pending;
        this.chunks = [];
        this.pending = 0;
        this.flushing = this.flushing.then(async () => {
            await req((await store('readwrite')).put(blob, key));
        });
        return this.flushing;
    }

    // espera a que lo escrito llegue a disco (para no acumular demasiado en memoria)
    async drain() {
        await this.flushing;
    }

    async finish(info: Omit<PackMeta, 'version' | 'size' | 'parts'>): Promise<PackMeta> {
        await this.flush();
        const meta: PackMeta = { ...info, version: this.version, size: this.written, parts: this.parts };
        await req((await store('readwrite')).put(meta, 'meta'));
        await removeOtherVersions(this.version);
        return meta;
    }
}

async function removeOtherVersions(version: string) {
    const keys = await req((await store('readonly')).getAllKeys());
    const stale = keys.filter(k => k !== 'meta' && !String(k).startsWith(`${version}:`));
    if (!stale.length) return;
    const s = await store('readwrite');
    await Promise.all(stale.map(k => req(s.delete(k))));
}

export async function writeStream(version: string, stream: ReadableStream<Uint8Array>, onBytes?: (n: number) => void) {
    const w = new PackWriter(version);
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        w.push(value);
        onBytes?.(w.bytes);
        await w.drain();
    }
    return w;
}

export async function persistStorage() {
    try {
        await navigator.storage?.persist?.();
    } catch { /* opcional */ }
}
