// Salas entre navegadores con Trystero: el primer contacto (señalización) pasa por relays
// públicos de Nostr y después cada navegador se conecta directo con el del anfitrión por WebRTC.
// Sobre esa conexión se abren dos canales propios:
//   - "cs-game"  (id 77): no confiable y desordenado, se comporta como UDP → tráfico del juego
//   - "cs-files" (id 78): confiable → transferencia del paquete de archivos del juego
import { joinRoom, type MessageAction, type Room } from 'trystero';

const APP_ID = 'csweb-cs16-santiagopostacchini-v1';
const GAME_CHANNEL = { label: 'cs-game', id: 77 };
const FILES_CHANNEL = { label: 'cs-files', id: 78 };
// 64 KB por mensaje: con mensajes más grandes Chrome llega a trabar el canal
const CHUNK = 64 * 1024;
const READ_SLICE = 4 * 1024 * 1024;
const BUFFER_HIGH = 8 << 20;
const BUFFER_LOW = 1 << 20;

export type GameInfo = {
    host: string;
    hostname: string;
    map: string;
    maxPlayers: number;
    players: number;
    pack: { version: string; size: number; files: number; unpacked: number; maps: string[] };
};

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newRoomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function normalizeCode(code: string) {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function channel(pc: RTCPeerConnection, spec: { label: string; id: number }, unreliable: boolean) {
    return pc.createDataChannel(spec.label, unreliable
        ? { negotiated: true, id: spec.id, ordered: false, maxRetransmits: 0 }
        : { negotiated: true, id: spec.id, ordered: true });
}

function waitOpen(ch: RTCDataChannel, timeoutMs = 15000) {
    if (ch.readyState === 'open') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('El canal con el otro navegador no se abrió')), timeoutMs);
        ch.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
        ch.addEventListener('close', () => { clearTimeout(t); reject(new Error('Se cerró la conexión')); }, { once: true });
    });
}

function rtcConfig(): RTCConfiguration {
    return {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
        ],
    };
}

// ---------------------------------------------------------------- anfitrión

export type HostCallbacks = {
    info: () => GameInfo;
    pack: () => Promise<Blob>;
    onPlayer: (peerId: string, game: RTCDataChannel) => void;
    onLeave: (peerId: string) => void;
    onTransfer?: (peerId: string, sent: number, total: number) => void;
};

export class HostRoom {
    private room: Room;
    private files = new Map<string, RTCDataChannel>();
    private timer: number;

    constructor(readonly code: string, cb: HostCallbacks) {
        this.room = joinRoom({ appId: APP_ID, rtcConfig: rtcConfig() }, code);
        const info = this.room.makeAction<GameInfo>('info');
        const get = this.room.makeAction<null>('get');

        this.room.onPeerJoin = (peerId) => {
            const pc = this.room.getPeers()[peerId];
            if (!pc) return;
            const game = channel(pc, GAME_CHANNEL, true);
            this.files.set(peerId, channel(pc, FILES_CHANNEL, false));
            cb.onPlayer(peerId, game);
            info.send(cb.info(), { target: peerId });
        };
        this.room.onPeerLeave = (peerId) => {
            this.files.get(peerId)?.close();
            this.files.delete(peerId);
            cb.onLeave(peerId);
        };
        get.onMessage = async (_, { peerId }) => {
            const ch = this.files.get(peerId);
            if (!ch) return;
            try {
                await sendBlob(ch, await cb.pack(), (sent, total) => cb.onTransfer?.(peerId, sent, total));
            } catch (e) {
                console.warn('Falló el envío de archivos a', peerId, e);
            }
        };
        // la cantidad de jugadores cambia: se avisa a todos de vez en cuando
        this.timer = window.setInterval(() => info.send(cb.info()), 5000);
    }

    leave() {
        clearInterval(this.timer);
        this.room.leave();
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// espera a que se vacíe el buffer de envío (evento + consulta periódica, por si el evento se pierde)
async function drain(ch: RTCDataChannel) {
    while (ch.bufferedAmount > BUFFER_LOW && ch.readyState === 'open') {
        await Promise.race([
            new Promise(r => ch.addEventListener('bufferedamountlow', r, { once: true })),
            sleep(50),
        ]);
    }
}

async function sendBlob(ch: RTCDataChannel, blob: Blob, onProgress: (sent: number, total: number) => void) {
    await waitOpen(ch);
    ch.bufferedAmountLowThreshold = BUFFER_LOW;
    let sent = 0;
    for (let off = 0; off < blob.size; off += READ_SLICE) {
        const slice = new Uint8Array(await blob.slice(off, off + READ_SLICE).arrayBuffer());
        for (let i = 0; i < slice.length; i += CHUNK) {
            if (ch.readyState !== 'open') throw new Error('canal cerrado');
            if (ch.bufferedAmount > BUFFER_HIGH) await drain(ch);
            ch.send(slice.subarray(i, i + CHUNK));
        }
        sent += slice.length;
        onProgress(sent, blob.size);
    }
}

// ---------------------------------------------------------------- invitado

export class GuestRoom {
    private room: Room;
    private hostId: string | null = null;
    private files: RTCDataChannel | null = null;
    game: RTCDataChannel | null = null;
    info: GameInfo | null = null;
    onInfo?: (info: GameInfo) => void;
    onHostLeft?: () => void;
    private get: MessageAction<null>;

    constructor(readonly code: string) {
        this.room = joinRoom({ appId: APP_ID, rtcConfig: rtcConfig() }, code);
        const info = this.room.makeAction<GameInfo>('info');
        this.get = this.room.makeAction<null>('get');
        info.onMessage = (data, { peerId }) => {
            if (!this.hostId) {
                const pc = this.room.getPeers()[peerId];
                if (!pc) return;
                this.hostId = peerId;
                this.game = channel(pc, GAME_CHANNEL, true);
                this.files = channel(pc, FILES_CHANNEL, false);
            }
            if (peerId !== this.hostId) return;
            this.info = data;
            this.onInfo?.(data);
        };
        this.room.onPeerLeave = (peerId) => {
            if (peerId === this.hostId) this.onHostLeft?.();
        };
    }

    waitHost(timeoutMs: number): Promise<GameInfo> {
        if (this.info) return Promise.resolve(this.info);
        return new Promise((resolve, reject) => {
            const prev = this.onInfo;
            const t = setTimeout(() => reject(new Error('No se encontró la partida. Revisá el código y que el anfitrión tenga la página abierta.')), timeoutMs);
            this.onInfo = (info) => {
                clearTimeout(t);
                this.onInfo = prev;
                prev?.(info);
                resolve(info);
            };
        });
    }

    // Pide el paquete al anfitrión y lo va entregando a `onChunk`
    async download(size: number, onChunk: (chunk: Uint8Array, received: number) => Promise<void> | void) {
        const ch = this.files;
        if (!ch || !this.hostId) throw new Error('No hay conexión con el anfitrión');
        ch.binaryType = 'arraybuffer';
        await waitOpen(ch);
        let received = 0;
        let chain = Promise.resolve();
        const done = new Promise<void>((resolve, reject) => {
            ch.onmessage = (ev) => {
                const chunk = new Uint8Array(ev.data as ArrayBuffer);
                received += chunk.length;
                const r = received;
                chain = chain.then(() => onChunk(chunk, r));
                if (received >= size) chain.then(resolve, reject);
            };
            ch.onclose = () => reject(new Error('Se cortó la conexión con el anfitrión durante la descarga'));
        });
        await this.get.send(null, { target: this.hostId });
        await done;
        ch.onmessage = null;
        ch.onclose = null;
    }

    async waitGameChannel() {
        if (!this.game) throw new Error('No hay conexión con el anfitrión');
        await waitOpen(this.game);
        return this.game;
    }

    leave() {
        this.room.leave();
    }
}
