// Enjambre de archivos: el paquete del juego (~240 MB) se reparte entre todos los jugadores que
// ya lo tienen completo, no sólo el anfitrión. Funciona sobre las conexiones de la sala (Trystero).
//
// - El paquete se divide en trozos de 2 MiB. El anfitrión (de confianza) da el manifiesto con el
//   SHA-256 de cada trozo; los trozos pueden venir de cualquiera y se verifican uno por uno.
// - Quien termina de descargar pasa a servir a los que entren después.
// - Si el enjambre no está disponible (anfitrión de una versión vieja, sin fuentes, se frena), el
//   que llama vuelve a la descarga directa del anfitrión.
import { diag } from './netdiag';
import type { RoomLike } from './signaling';
import { getPackBlob, type PackMeta, type PackWriter } from './store';

export const SWARM_CHUNK = 2 * 1024 * 1024;
const WINDOW = 12;            // trozos por delante de lo ya escrito
const PER_PEER = 2;           // pedidos simultáneos por fuente
const REQUEST_TIMEOUT = 20_000;
const STALL_TIMEOUT = 40_000; // sin avances: se da por fallido el enjambre
const MAX_SERVE = 3;          // trozos que se sirven a la vez (para no ahogar la conexión del juego)
// Cuánto se le sirve como mucho a un mismo jugador, en paquetes completos: alcanza para reintentos,
// pero nadie puede hacer subir datos sin fin (sobre todo si la conexión pasa por el relay TURN)
const MAX_SERVED_PACKS = 2;

type Ctl =
    | { t: 'who'; v: string }
    | { t: 'seed'; v: string }
    | { t: 'man'; v: string }
    | { t: 'mani'; v: string; chunk: number; size: number; hashes: string[] }
    | { t: 'get'; v: string; i: number }
    | { t: 'nope'; v: string; i: number };

type Manifest = { chunk: number; size: number; hashes: string[] };

export class SwarmUnavailable extends Error {}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: BufferSource) => hex(await crypto.subtle.digest('SHA-256', data));
const toBytes = (d: unknown): Uint8Array => d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer);

type Download = {
    v: string;
    seeds: Set<string>;
    banned: Set<string>;
    cooldown: Map<string, number>;
    strikes: Map<string, number>;
    inflight: Map<number, { peer: string; at: number; verifying?: boolean }>;
    got: Map<number, Uint8Array>;
    manifest: Manifest | null;
    manifestFrom: string;
    onManifest: ((m: Manifest) => void) | null;
    fromPeer: Map<string, number>;
};

export class Swarm {
    private ctl;
    private data;
    private blobs = new Map<string, Promise<Blob>>();
    private manifests = new Map<string, Promise<Manifest>>();
    private serving = 0;
    private served = new Map<string, number>();
    private dl: Download | null = null;
    private wakeUp: (() => void) | null = null;
    private woken = false;

    // local(): el paquete completo que este jugador tiene guardado (null si todavía no lo tiene)
    constructor(room: RoomLike, private local: () => PackMeta | null) {
        this.ctl = room.makeAction<Ctl>('sw');
        this.data = room.makeAction<Uint8Array>('swd');
        this.ctl.onMessage = (m, { peerId }) => this.onControl(m, peerId).catch(e => diag.log(`enjambre: ${(e as Error).message}`));
        this.data.onMessage = (d, ctx) => this.onChunk(toBytes(d), ctx.peerId, ctx.metadata as { v?: string; i?: number } | undefined)
            .catch(e => diag.log(`enjambre: ${(e as Error).message}`));
    }

    // ------------------------------------------------------------ servir

    private blobFor(meta: PackMeta) {
        let b = this.blobs.get(meta.version);
        if (!b) this.blobs.set(meta.version, b = getPackBlob(meta));
        return b;
    }

    private manifestFor(meta: PackMeta): Promise<Manifest> {
        let m = this.manifests.get(meta.version);
        if (!m) {
            m = (async () => {
                const blob = await this.blobFor(meta);
                const hashes: string[] = [];
                for (let off = 0; off < blob.size; off += SWARM_CHUNK) {
                    hashes.push(await sha256(await blob.slice(off, off + SWARM_CHUNK).arrayBuffer()));
                }
                return { chunk: SWARM_CHUNK, size: blob.size, hashes };
            })();
            this.manifests.set(meta.version, m);
            m.catch(() => this.manifests.delete(meta.version));
        }
        return m;
    }

    private async onControl(m: Ctl, peerId: string) {
        const meta = this.local();
        switch (m.t) {
            case 'who':
                if (meta?.version === m.v) await this.ctl.send({ t: 'seed', v: m.v }, { target: peerId });
                break;
            case 'man':
                if (meta?.version === m.v) {
                    const man = await this.manifestFor(meta);
                    await this.ctl.send({ t: 'mani', v: m.v, ...man }, { target: peerId });
                }
                break;
            case 'get': {
                const count = meta ? Math.ceil(meta.size / SWARM_CHUNK) : 0;
                const served = this.served.get(peerId) ?? 0;
                if (!meta || meta.version !== m.v || !Number.isInteger(m.i) || m.i < 0 || m.i >= count
                    || this.serving >= MAX_SERVE || served > meta.size * MAX_SERVED_PACKS) {
                    await this.ctl.send({ t: 'nope', v: m.v, i: m.i }, { target: peerId });
                    break;
                }
                this.serving++;
                try {
                    const blob = await this.blobFor(meta);
                    const buf = await blob.slice(m.i * SWARM_CHUNK, (m.i + 1) * SWARM_CHUNK).arrayBuffer();
                    // se relee: mientras se leía el trozo pudo terminar otro envío al mismo jugador
                    this.served.set(peerId, (this.served.get(peerId) ?? 0) + buf.byteLength);
                    await this.data.send(new Uint8Array(buf), { target: peerId, metadata: { v: m.v, i: m.i } });
                } finally {
                    this.serving--;
                }
                break;
            }
            // ---- respuestas para la descarga en curso
            case 'seed': {
                const dl = this.dl;
                if (dl?.v === m.v && !dl.banned.has(peerId)) {
                    dl.seeds.add(peerId);
                    this.wake();
                }
                break;
            }
            case 'mani': {
                const dl = this.dl;
                if (dl?.v === m.v && peerId === dl.manifestFrom && dl.onManifest) {
                    dl.onManifest({ chunk: m.chunk, size: m.size, hashes: m.hashes });
                }
                break;
            }
            case 'nope': {
                const dl = this.dl;
                const req = dl?.inflight.get(m.i);
                if (dl && dl.v === m.v && req?.peer === peerId) {
                    dl.inflight.delete(m.i);
                    dl.cooldown.set(peerId, performance.now() + 2000);
                    this.wake();
                }
                break;
            }
        }
    }

    // ------------------------------------------------------------ descargar

    // Despierta al bucle de descarga; si no estaba esperando, la próxima espera vuelve enseguida
    private wake() {
        this.woken = true;
        this.wakeUp?.();
    }

    private async nextEvent(ms = 400) {
        if (!this.woken) {
            let timer = 0;
            await new Promise<void>((r) => {
                this.wakeUp = r;
                timer = window.setTimeout(r, ms);
            });
            clearTimeout(timer);
            this.wakeUp = null;
        }
        this.woken = false;
    }

    private strike(dl: Download, peer: string, ban = false) {
        const n = (dl.strikes.get(peer) ?? 0) + 1;
        dl.strikes.set(peer, n);
        if (ban || n >= 3) {
            dl.banned.add(peer);
            dl.seeds.delete(peer);
            diag.log(`enjambre: se descarta la fuente ${peer.slice(0, 6)}`);
        }
    }

    private pickSource(dl: Download): string | null {
        const now = performance.now();
        const load = new Map<string, number>();
        for (const r of dl.inflight.values()) load.set(r.peer, (load.get(r.peer) ?? 0) + 1);
        let best: string | null = null;
        for (const peer of dl.seeds) {
            if (dl.banned.has(peer) || (dl.cooldown.get(peer) ?? 0) > now) continue;
            const l = load.get(peer) ?? 0;
            if (l >= PER_PEER) continue;
            if (best === null || l < (load.get(best) ?? 0)) best = peer;
        }
        return best;
    }

    private async onChunk(bytes: Uint8Array, peerId: string, meta: { v?: string; i?: number } | undefined) {
        const dl = this.dl;
        if (!dl?.manifest || meta?.v !== dl.v || typeof meta.i !== 'number') return;
        const i = meta.i;
        const req = dl.inflight.get(i);
        // nadie lo pidió a esa fuente, o es un duplicado del que ya se está verificando
        if (!req || req.peer !== peerId || req.verifying) return;
        req.verifying = true;
        const { chunk, size, hashes } = dl.manifest;
        const expected = Math.min(chunk, size - i * chunk);
        const ok = bytes.length === expected && await sha256(bytes as BufferSource) === hashes[i];
        // recién ahora deja de estar "en camino": mientras se verificaba, el bucle no lo vuelve a pedir
        if (dl.inflight.get(i) === req) dl.inflight.delete(i);
        if (!ok) {
            diag.log(`enjambre: el trozo ${i} de ${peerId.slice(0, 6)} no coincide con el manifiesto`);
            this.strike(dl, peerId, true);
        } else if (this.dl === dl) {
            dl.got.set(i, bytes);
            dl.fromPeer.set(peerId, (dl.fromPeer.get(peerId) ?? 0) + 1);
        }
        this.wake();
    }

    private async fetchManifest(dl: Download, host: string, size: number): Promise<Manifest> {
        dl.manifestFrom = host;
        const man = await new Promise<Manifest>((resolve, reject) => {
            const t = setTimeout(() => reject(new SwarmUnavailable('el anfitrión no entregó el manifiesto')), 30_000);
            dl.onManifest = (m) => {
                clearTimeout(t);
                resolve(m);
            };
            this.ctl.send({ t: 'man', v: dl.v }, { target: host })
                .catch(e => reject(new SwarmUnavailable(`no se pudo pedir el manifiesto: ${(e as Error).message}`)));
        });
        dl.onManifest = null;
        const count = Math.ceil(size / man.chunk);
        // quien sirve siempre corta en trozos de SWARM_CHUNK: otro tamaño haría fallar todos los trozos
        if (man.size !== size || man.chunk !== SWARM_CHUNK || !Array.isArray(man.hashes) || man.hashes.length !== count) {
            throw new SwarmUnavailable('el manifiesto no coincide con el paquete anunciado');
        }
        return man;
    }

    // Descarga el paquete `version` entre todas las fuentes y lo va escribiendo en `writer`.
    // `host` es el único de quien se acepta el manifiesto. Lanza SwarmUnavailable si no hay enjambre.
    async download(version: string, size: number, host: string, writer: PackWriter, onProgress: (bytes: number, sources: number) => void) {
        const dl: Download = {
            v: version, seeds: new Set(), banned: new Set(), cooldown: new Map(), strikes: new Map(),
            inflight: new Map(), got: new Map(), manifest: null, manifestFrom: host, onManifest: null, fromPeer: new Map(),
        };
        this.dl = dl;
        this.woken = false;
        try {
            const askWho = () => this.ctl.send({ t: 'who', v: version }).catch(() => undefined);
            await askWho();
            const t0 = performance.now();
            while (!dl.seeds.has(host) && performance.now() - t0 < 6000) await this.nextEvent(300);
            if (!dl.seeds.has(host)) throw new SwarmUnavailable('el anfitrión no participa del enjambre');

            const manifest = dl.manifest = await this.fetchManifest(dl, host, size);
            const count = manifest.hashes.length;
            diag.log(`enjambre: ${count} trozos, fuentes iniciales ${dl.seeds.size}`);

            let next = 0;
            let written = 0;
            let lastWho = performance.now();
            let lastProgress = performance.now();
            while (next < count) {
                const now = performance.now();
                for (const [i, r] of dl.inflight) {
                    if (now - r.at > REQUEST_TIMEOUT) {
                        dl.inflight.delete(i);
                        this.strike(dl, r.peer);
                    }
                }
                for (let i = next; i < Math.min(next + WINDOW, count); i++) {
                    if (dl.got.has(i) || dl.inflight.has(i)) continue;
                    const peer = this.pickSource(dl);
                    if (!peer) break;
                    dl.inflight.set(i, { peer, at: now });
                    this.ctl.send({ t: 'get', v: version, i }, { target: peer }).catch(() => {
                        dl.inflight.delete(i);
                        this.strike(dl, peer);
                    });
                }
                while (dl.got.has(next)) {
                    const chunk = dl.got.get(next)!;
                    dl.got.delete(next);
                    writer.push(chunk);
                    next++;
                    written += chunk.length;
                    await writer.drain();
                    lastProgress = performance.now();
                }
                onProgress(written, dl.fromPeer.size);
                if (next >= count) break;
                if (now - lastWho > 3000) {
                    lastWho = now;
                    await askWho(); // aparecen fuentes nuevas a medida que otros terminan
                }
                if (performance.now() - lastProgress > STALL_TIMEOUT) throw new SwarmUnavailable('el enjambre se frenó');
                await this.nextEvent();
            }
            const summary = [...dl.fromPeer.entries()].map(([p, n]) => `${p.slice(0, 6)}: ${n}`).join(', ');
            diag.log(`enjambre: descarga completa (trozos por fuente → ${summary})`);
            // ya se tiene el manifiesto verificado: se puede servir sin recalcularlo
            this.manifests.set(version, Promise.resolve(manifest));
        } finally {
            this.dl = null;
            this.blobs.delete(version); // el paquete guardado recién se escribió: se vuelve a abrir al servir
        }
    }
}
