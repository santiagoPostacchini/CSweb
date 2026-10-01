// Salas entre navegadores.
// - Trystero (relays públicos de Nostr) sólo sirve para que anfitrión e invitados se encuentren y
//   se pasen los mensajes de señalización.
// - Por cada invitado, el anfitrión abre una conexión WebRTC propia (independiente de las que
//   Trystero maneja por dentro) con dos canales:
//     "game":  no confiable y desordenado, se comporta como UDP → tráfico del juego
//     "files": confiable → paquete de archivos del juego
import { joinRoom, type MessageAction, type Room } from 'trystero';
import { candidateType, describePath, diag, rtcConfig, selectedPath, turnServers, type TurnSettings } from './netdiag';

const APP_ID = 'csweb-cs16-santiagopostacchini-v1';
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

type CandidateJson = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
type Sig =
    | { sid: string; type: 'hello' }
    | { sid: string; type: 'offer' | 'answer'; sdp: string }
    | { sid: string; type: 'candidate'; candidate: CandidateJson };

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newRoomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function normalizeCode(code: string) {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function joinTrystero(code: string, turn: TurnSettings | null) {
    return joinRoom({ appId: APP_ID, turnConfig: turnServers(turn) as never }, code, {
        onJoinError: (d) => diag.log(`trystero: ${d.error} (peer ${d.peerId})`),
    });
}

// ---------------------------------------------------------------- conexión propia

class Link {
    readonly pc: RTCPeerConnection;
    game: RTCDataChannel | null = null;
    files: RTCDataChannel | null = null;
    private pending: CandidateJson[] = [];
    private localTypes = new Set<string>();
    private remoteTypes = new Set<string>();
    private channelWaiters: (() => void)[] = [];

    constructor(readonly sid: string, turn: TurnSettings | null, private send: (s: Sig) => void, offerer: boolean) {
        this.pc = new RTCPeerConnection(rtcConfig(turn));
        this.pc.onicecandidate = (e) => {
            if (!e.candidate?.candidate) return;
            this.localTypes.add(candidateType(e.candidate.candidate));
            const c = e.candidate;
            this.send({ sid, type: 'candidate', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } });
        };
        this.pc.oniceconnectionstatechange = () => diag.log(`ICE ${this.pc.iceConnectionState}`);
        this.pc.onicegatheringstatechange = () => {
            if (this.pc.iceGatheringState === 'complete') diag.log(`candidatos locales: ${[...this.localTypes].join(', ') || 'ninguno'}`);
        };
        if (offerer) {
            this.setChannel(this.pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 }));
            this.setChannel(this.pc.createDataChannel('files', { ordered: true }));
        } else {
            this.pc.ondatachannel = (e) => this.setChannel(e.channel);
        }
    }

    private setChannel(ch: RTCDataChannel) {
        ch.binaryType = 'arraybuffer';
        if (ch.label === 'game') this.game = ch;
        if (ch.label === 'files') this.files = ch;
        ch.addEventListener('open', () => this.channelWaiters.splice(0).forEach(f => f()));
        this.channelWaiters.splice(0).forEach(f => f());
    }

    get open() {
        return this.game?.readyState === 'open' && this.files?.readyState === 'open';
    }

    async offer() {
        await this.pc.setLocalDescription(await this.pc.createOffer());
        this.send({ sid: this.sid, type: 'offer', sdp: this.pc.localDescription!.sdp });
    }

    async handle(sig: Sig) {
        if (sig.type === 'offer') {
            await this.pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
            await this.pc.setLocalDescription(await this.pc.createAnswer());
            this.send({ sid: this.sid, type: 'answer', sdp: this.pc.localDescription!.sdp });
        } else if (sig.type === 'answer') {
            await this.pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
        } else if (sig.type === 'candidate') {
            if (sig.candidate.candidate) this.remoteTypes.add(candidateType(sig.candidate.candidate));
            if (!this.pc.remoteDescription) {
                this.pending.push(sig.candidate);
                return;
            }
            await this.pc.addIceCandidate(sig.candidate).catch(() => undefined);
            return;
        }
        for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c).catch(() => undefined);
    }

    // Espera que los dos canales estén abiertos
    async ready(timeoutMs: number) {
        const deadline = performance.now() + timeoutMs;
        while (!this.open) {
            if (performance.now() > deadline || this.pc.connectionState === 'failed') {
                diag.log(`no conectó: estado ${this.pc.connectionState}/${this.pc.iceConnectionState}; `
                    + `local [${[...this.localTypes].join(', ')}] remoto [${[...this.remoteTypes].join(', ')}]`);
                throw new Error('Se encontró la partida pero no se pudo abrir una conexión directa con el anfitrión. '
                    + 'La red probablemente bloquea las conexiones entre equipos (ver diagnóstico).');
            }
            await Promise.race([new Promise<void>(r => this.channelWaiters.push(r)), sleep(250)]);
        }
        const path = await selectedPath(this.pc);
        diag.log(`conectado (${path})`);
        return describePath(path);
    }

    close() {
        try { this.pc.close(); } catch { /* ya cerrado */ }
    }
}

async function drain(ch: RTCDataChannel) {
    while (ch.bufferedAmount > BUFFER_LOW && ch.readyState === 'open') {
        await Promise.race([
            new Promise(r => ch.addEventListener('bufferedamountlow', r, { once: true })),
            sleep(50),
        ]);
    }
}

async function sendBlob(ch: RTCDataChannel, blob: Blob, onProgress: (sent: number, total: number) => void) {
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
    private links = new Map<string, Link>();
    private timer: number;

    constructor(readonly code: string, private cb: HostCallbacks, private turn: TurnSettings | null) {
        this.room = joinTrystero(code, turn);
        const info = this.room.makeAction<GameInfo>('info');
        const sig = this.room.makeAction<Sig>('sig');

        this.room.onPeerJoin = (peerId) => {
            diag.log(`se encontró un jugador (${peerId.slice(0, 6)})`);
            info.send(cb.info(), { target: peerId });
        };
        this.room.onPeerLeave = (peerId) => {
            // si la conexión del juego sigue viva, el jugador sigue jugando
            const link = this.links.get(peerId);
            if (link && link.pc.connectionState === 'connected') return;
            this.drop(peerId);
        };
        sig.onMessage = async (s, { peerId }) => {
            try {
                if (s.type === 'hello') {
                    this.links.get(peerId)?.close();
                    const link = new Link(s.sid, this.turn, (out) => sig.send(out, { target: peerId }), true);
                    this.links.set(peerId, link);
                    this.watch(peerId, link);
                    await link.offer();
                    return;
                }
                const link = this.links.get(peerId);
                if (link?.sid === s.sid) await link.handle(s);
            } catch (e) {
                diag.log(`señalización con ${peerId.slice(0, 6)}: ${(e as Error).message}`);
            }
        };
        // la cantidad de jugadores cambia: se avisa a todos de vez en cuando
        this.timer = window.setInterval(() => info.send(cb.info()), 5000);
    }

    private watch(peerId: string, link: Link) {
        link.ready(30000).then((how) => {
            diag.log(`jugador ${peerId.slice(0, 6)} conectado ${how}`);
            this.cb.onPlayer(peerId, link.game!);
            link.files!.onmessage = async (ev) => {
                if (ev.data !== 'get') return;
                try {
                    await sendBlob(link.files!, await this.cb.pack(), (sent, total) => this.cb.onTransfer?.(peerId, sent, total));
                } catch (e) {
                    diag.log(`envío de archivos a ${peerId.slice(0, 6)}: ${(e as Error).message}`);
                }
            };
        }).catch((e) => diag.log(`jugador ${peerId.slice(0, 6)}: ${(e as Error).message}`));
        link.pc.addEventListener('connectionstatechange', () => {
            if (['failed', 'closed'].includes(link.pc.connectionState) && this.links.get(peerId) === link) this.drop(peerId);
        });
    }

    private drop(peerId: string) {
        this.links.get(peerId)?.close();
        this.links.delete(peerId);
        this.cb.onLeave(peerId);
    }

    leave() {
        clearInterval(this.timer);
        this.room.leave();
        for (const id of [...this.links.keys()]) this.drop(id);
    }
}

// ---------------------------------------------------------------- invitado

export class GuestRoom {
    private room!: Room;
    private sig!: MessageAction<Sig>;
    private hostId: string | null = null;
    private link: Link | null = null;
    info: GameInfo | null = null;
    onInfo?: (info: GameInfo) => void;
    onHostLeft?: () => void;

    constructor(readonly code: string, private turn: TurnSettings | null) {
        this.join();
    }

    private join() {
        this.room = joinTrystero(this.code, this.turn);
        const info = this.room.makeAction<GameInfo>('info');
        this.sig = this.room.makeAction<Sig>('sig');
        info.onMessage = (data, { peerId }) => {
            if (this.hostId && peerId !== this.hostId) return;
            if (!this.hostId) diag.log(`anfitrión encontrado (${peerId.slice(0, 6)})`);
            this.hostId = peerId;
            this.info = data;
            this.onInfo?.(data);
        };
        this.sig.onMessage = (s, { peerId }) => {
            if (peerId !== this.hostId || !this.link || s.sid !== this.link.sid) return;
            this.link.handle(s).catch(e => diag.log(`señalización: ${(e as Error).message}`));
        };
        this.room.onPeerLeave = (peerId) => {
            if (peerId !== this.hostId) return;
            if (this.link?.pc.connectionState === 'connected') return;
            this.onHostLeft?.();
        };
    }

    // Vuelve a entrar a la sala (por ejemplo después de conseguir el permiso de micrófono)
    async rejoin() {
        if (this.info) return;
        diag.log('reintentando la búsqueda del anfitrión');
        await this.room.leave();
        this.join();
    }

    waitHost(timeoutMs: number): Promise<GameInfo> {
        if (this.info) return Promise.resolve(this.info);
        return new Promise((resolve, reject) => {
            const prev = this.onInfo;
            const t = setTimeout(() => {
                this.onInfo = prev;
                diag.log('no apareció el anfitrión');
                reject(new Error('No se encontró la partida. Revisá el código y que el anfitrión tenga la página abierta. '
                    + 'Si están en redes distintas (o la red bloquea conexiones entre equipos), el anfitrión necesita un servidor TURN.'));
            }, timeoutMs);
            this.onInfo = (info) => {
                clearTimeout(t);
                this.onInfo = prev;
                prev?.(info);
                resolve(info);
            };
        });
    }

    // Abre la conexión propia con el anfitrión; devuelve una descripción del camino
    async connect(timeoutMs: number) {
        if (!this.hostId) throw new Error('No hay anfitrión');
        this.link?.close();
        const sid = crypto.randomUUID();
        const host = this.hostId;
        this.link = new Link(sid, this.turn, (s) => this.sig.send(s, { target: host }), false);
        diag.log('pidiendo conexión al anfitrión');
        await this.sig.send({ sid, type: 'hello' }, { target: host });
        const how = await this.link.ready(timeoutMs);
        this.link.pc.addEventListener('connectionstatechange', () => {
            if (this.link?.pc.connectionState === 'failed') this.onHostLeft?.();
        });
        return how;
    }

    get game() {
        return this.link?.game ?? null;
    }

    // Pide el paquete al anfitrión y lo va entregando a `onChunk`
    async download(size: number, onChunk: (chunk: Uint8Array, received: number) => Promise<void> | void) {
        const ch = this.link?.files;
        if (!ch || ch.readyState !== 'open') throw new Error('No hay conexión con el anfitrión');
        let received = 0;
        let lastData = performance.now();
        let chain = Promise.resolve();
        await new Promise<void>((resolve, reject) => {
            const stall = setInterval(() => {
                if (performance.now() - lastData > 20000) {
                    clearInterval(stall);
                    diag.log(`la descarga se frenó en ${received} bytes`);
                    reject(new Error('La transferencia de archivos desde el anfitrión se cortó'));
                }
            }, 1000);
            ch.onmessage = (ev) => {
                if (typeof ev.data === 'string') return;
                lastData = performance.now();
                const chunk = new Uint8Array(ev.data as ArrayBuffer);
                received += chunk.length;
                const r = received;
                chain = chain.then(() => onChunk(chunk, r));
                if (received >= size) {
                    clearInterval(stall);
                    chain.then(resolve, reject);
                }
            };
            ch.onclose = () => {
                clearInterval(stall);
                reject(new Error('Se cortó la conexión con el anfitrión durante la descarga'));
            };
            ch.send('get');
        });
        ch.onmessage = null;
        ch.onclose = null;
    }

    leave() {
        this.link?.close();
        this.room.leave();
    }
}
