// Guarda los paquetes de archivos del juego en IndexedDB (en partes de ~8 MB, como Blobs en disco),
// así no hay que volver a elegir la carpeta ni volver a recibirlos del anfitrión.

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
    private releaseLock: (() => void) | null = null;

    constructor(private version: string) {
        // se suelta al terminar (o al cerrar la pestaña si la descarga quedó a medias)
        navigator.locks?.request(writeLock(version), () => new Promise<void>((release) => {
            this.releaseLock = release;
        })).catch(() => undefined);
    }

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
        await usePack(meta);
        this.releaseLock?.();
        return meta;
    }
}

// Se guardan varios paquetes (cada anfitrión puede tener el suyo: la versión sale de su
// instalación), así alternar de anfitrión no obliga a bajar todo de nuevo. Lista "packs", el
// último usado primero; el más viejo se borra cuando no entra.
const MAX_PACKS = 3;

// Lanza si no se puede leer: quien después reescribe la lista no debe tomarla por vacía (borraría todo)
async function readPacks(): Promise<PackMeta[]> {
    const s = await store('readonly');
    const list = await req(s.get('packs')) as PackMeta[] | undefined;
    if (list) return list;
    const old = await req(s.get('meta')) as PackMeta | undefined; // formato anterior: un solo paquete
    return old ? [old] : [];
}

export async function listPacks(): Promise<PackMeta[]> {
    try {
        return await readPacks();
    } catch {
        return [];
    }
}

// El paquete en uso (el último cargado, recibido o jugado)
export async function getMeta(): Promise<PackMeta | null> {
    return (await listPacks())[0] ?? null;
}

export async function findPack(version: string): Promise<PackMeta | null> {
    return (await listPacks()).find(p => p.version === version) ?? null;
}

// Marca el paquete como el último usado y borra los que quedan fuera de la lista
export async function usePack(meta: PackMeta) {
    const list = [meta, ...(await readPacks()).filter(p => p.version !== meta.version)];
    await savePacks(list.slice(0, MAX_PACKS));
}

// Borra un paquete guardado (por ejemplo, uno dañado o con archivos no permitidos)
export async function forgetPack(version: string) {
    await savePacks((await readPacks()).filter(p => p.version !== version));
}

// Mientras se escribe un paquete, su versión queda marcada con un Web Lock: así otra pestaña del
// mismo perfil no borra las partes de una descarga en curso al limpiar
const writeLock = (version: string) => `${DB_NAME}:escribiendo:${version}`;

async function versionsBeingWritten(): Promise<Set<string>> {
    try {
        const state = await navigator.locks?.query();
        const names = [...(state?.held ?? []), ...(state?.pending ?? [])].map(l => l.name ?? '');
        return new Set(names.filter(n => n.startsWith(writeLock(''))).map(n => n.slice(writeLock('').length)));
    } catch {
        return new Set();
    }
}

async function savePacks(list: PackMeta[]) {
    const s = await store('readwrite');
    await req(s.put(list, 'packs'));
    await req(s.delete('meta'));
    // partes de paquetes que ya no están en la lista (incluidas descargas a medias abandonadas)
    const keep = new Set([...list.map(p => p.version), ...(await versionsBeingWritten())]);
    const keys = await req((await store('readonly')).getAllKeys());
    const stale = keys.filter(k => k !== 'packs' && !keep.has(String(k).split(':')[0]));
    if (!stale.length) return;
    const w = await store('readwrite');
    await Promise.all(stale.map(k => req(w.delete(k))));
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
