// Salas entre navegadores.
// - Trystero (relays públicos de Nostr) sólo sirve para que anfitrión e invitados se encuentren y
//   se pasen los mensajes de señalización.
// - Por cada invitado, el anfitrión abre una conexión WebRTC propia (independiente de las que
//   Trystero maneja por dentro) con dos canales:
//     "game":  no confiable y desordenado, se comporta como UDP → tráfico del juego
//     "files": confiable → paquete de archivos del juego
import type { MessageAction } from '@trystero-p2p/nostr';
import { joinSignalingRoom, selfId, type RoomLike } from './signaling';
import { candidateType, describePath, diag, measureRtt, rtcConfig, selectedPath, turnServers, type TurnSettings } from './netdiag';
import { hostScore, pingAll, sanitizePings, type Pings } from './quality';

const APP_ID = 'csweb-cs16-santiagopostacchini-v1';
// 64 KB por mensaje: con mensajes más grandes Chrome llega a trabar el canal
const CHUNK = 64 * 1024;
const READ_SLICE = 4 * 1024 * 1024;
const BUFFER_HIGH = 8 << 20;
const BUFFER_LOW = 1 << 20;
// Envíos completos del paquete por la descarga directa que se le hacen como mucho a un jugador
const MAX_TRANSFERS = 2;

// Jugador conectado al anfitrión, en orden de llegada. Si el anfitrión cae, todos eligen al
// sucesor a partir de la última copia de esta lista (ver migration.ts).
// score: qué tan buen anfitrión sería (su peor ping con todos los demás, en ms; null si no midió);
// scoreNoHost: lo mismo sin contar al anfitrión actual (lo que importa si el anfitrión se cae)
export type RosterEntry = {
    peerId: string;
    name: string;
    seq: number;
    canHost: boolean;
    score: number | null;
    scoreNoHost: number | null;
};

// Lo que cada invitado le cuenta al anfitrión sobre sí mismo (pings: con cada jugador de la sala)
export type Caps = { name: string; canHost: boolean; pings?: Pings };

// El anfitrión le pasa la partida a otro jugador
type Handoff = { to: string; epoch: number };

// Cada cuánto se mide el ping entre jugadores
const PING_EVERY_MS = 10_000;

export type GameInfo = {
    host: string;
    hostname: string;
    map: string;
    maxPlayers: number;
    players: number;
    pack: { version: string; size: number; files: number; unpacked: number; maps: string[] };
    // número de "reinicio" de la partida: cada migración de anfitrión lo incrementa
    epoch: number;
    roster: RosterEntry[];
    // la pestaña del anfitrión está en segundo plano (los demás pueden notar lag)
    away?: boolean;
};

export { selfId };

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
    return joinSignalingRoom({ appId: APP_ID, turnConfig: turnServers(turn) as never }, code, {
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

    private restartTimer = 0;
    private restarts = 0;

    constructor(readonly sid: string, turn: TurnSettings | null, private send: (s: Sig) => void, offerer: boolean) {
        this.pc = new RTCPeerConnection(rtcConfig(turn));
        // Cortes breves de red (cambio de Wi-Fi, suspensión): el anfitrión (quien ofrece) reinicia ICE
        // para buscar un camino nuevo sin tumbar la conexión ni expulsar al jugador
        if (offerer) {
            this.pc.addEventListener('connectionstatechange', () => {
                clearTimeout(this.restartTimer);
                const state = this.pc.connectionState;
                if (state === 'connected') this.restarts = 0;
                else if (state === 'disconnected' || state === 'failed') {
                    this.restartTimer = window.setTimeout(() => this.restartIce(), state === 'failed' ? 0 : 3000);
                }
            });
        }
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

    private async restartIce() {
        if (this.pc.connectionState === 'closed' || !this.pc.remoteDescription || this.restarts >= 5) return;
        this.restarts++;
        diag.log(`reiniciando ICE (intento ${this.restarts})`);
        try {
            this.pc.restartIce();
            await this.offer();
        } catch (e) {
            diag.log(`no se pudo reiniciar ICE: ${(e as Error).message}`);
        }
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
        const rtt = await measureRtt(this.pc);
        diag.log(`conectado (${path}${rtt != null ? `, RTT ${rtt} ms` : ''})`);
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
    // datos de la partida; el epoch y la lista de jugadores los agrega HostRoom
    info: () => Omit<GameInfo, 'epoch' | 'roster'>;
    pack: () => Promise<Blob>;
    onPlayer: (peerId: string, game: RTCDataChannel) => void;
    onLeave: (peerId: string) => void;
    onTransfer?: (peerId: string, sent: number, total: number) => void;
    // otro anfitrión con más prioridad apareció en la misma sala: este tiene que dejar su lugar
    onSuperseded: (epoch: number) => void;
};

// Prioridad entre dos anfitriones: gana el epoch más alto; con el mismo epoch, el peerId menor
export function outranks(a: { epoch: number; peerId: string }, b: { epoch: number; peerId: string }) {
    return a.epoch !== b.epoch ? a.epoch > b.epoch : a.peerId < b.peerId;
}

export class HostRoom {
    private room: RoomLike;
    private links = new Map<string, Link>();
    private seqs = new Map<string, number>();
    private caps = new Map<string, Caps>();
    private nextSeq = 1;
    private infoAction: MessageAction<GameInfo>;
    private handoffAction: MessageAction<Handoff>;
    private timers: number[];
    // ping de cada invitado con los demás jugadores, y el de este anfitrión con cada invitado
    private pings = new Map<string, Pings>();
    private ownPings: Pings = {};
    private away = false;
    // envíos completos del paquete por la descarga directa, por jugador
    private transfers = new Map<string, number>();

    constructor(readonly code: string, private cb: HostCallbacks, private turn: TurnSettings | null, readonly epoch = 1) {
        this.room = joinTrystero(code, turn);
        const info = this.infoAction = this.room.makeAction<GameInfo>('info');
        const sig = this.room.makeAction<Sig>('sig');
        const capsAction = this.room.makeAction<Caps>('caps');
        this.handoffAction = this.room.makeAction<Handoff>('handoff');

        this.room.onPeerJoin = (peerId) => {
            diag.log(`se encontró un jugador (${peerId.slice(0, 6)})`);
            info.send(this.fullInfo(), { target: peerId }).catch(() => undefined); // le llega con el próximo aviso
        };
        capsAction.onMessage = (c, { peerId }) => {
            if (!c || typeof c !== 'object') return;
            const first = !this.caps.has(peerId);
            this.caps.set(peerId, { name: String(c.name ?? '').slice(0, 31), canHost: c.canHost === true });
            this.pings.set(peerId, sanitizePings(c.pings, new Set([selfId, ...this.links.keys()])));
            // los pings llegan cada pocos segundos: se difunden con el aviso periódico
            if (first) this.announce();
        };
        // Otro anfitrión en la misma sala (por ejemplo, el grupo migró mientras este seguía vivo).
        // Una migración sube el epoch de a uno: un salto mayor no viene de una migración real. Y un
        // jugador que sigue conectado a este anfitrión no puede estar sirviendo otra partida.
        info.onMessage = (data, { peerId }) => {
            const other = { epoch: Number(data?.epoch) || 0, peerId };
            if (this.links.get(peerId)?.pc.connectionState === 'connected') return;
            if (other.epoch <= this.epoch + 1 && outranks(other, { epoch: this.epoch, peerId: selfId })) {
                diag.log(`otro anfitrión tiene prioridad (epoch ${other.epoch}, ${peerId.slice(0, 6)})`);
                cb.onSuperseded(other.epoch);
            }
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
                    const link = new Link(s.sid, this.turn, (out) => {
                        sig.send(out, { target: peerId }).catch(() => undefined); // ICE reintenta o vence el plazo
                    }, true);
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
        this.timers = [
            // la cantidad de jugadores cambia: se avisa a todos de vez en cuando
            window.setInterval(() => this.announce(), 5000),
            window.setInterval(() => this.measure(), PING_EVERY_MS),
        ];
    }

    private async measure() {
        const pcs = Object.fromEntries([...this.links].map(([id, link]) => [id, link.pc]));
        this.ownPings = await pingAll(pcs);
    }

    // Qué tan buen anfitrión es este jugador (su peor ping con los invitados; null si falta medir)
    get ownScore() {
        return hostScore(this.ownPings, this.roster().map(p => p.peerId));
    }

    // la sala de señalización (para el enjambre de archivos)
    get signaling(): RoomLike {
        return this.room;
    }

    roster(): RosterEntry[] {
        const ids = [...this.seqs.keys()].filter(id => this.links.has(id));
        return ids
            .map((peerId) => {
                const rest = ids.filter(id => id !== peerId);
                const pings = this.pings.get(peerId) ?? {};
                const caps = this.caps.get(peerId);
                return {
                    peerId,
                    seq: this.seqs.get(peerId)!,
                    name: caps?.name ?? '',
                    canHost: caps?.canHost ?? false,
                    score: hostScore(pings, [selfId, ...rest]),
                    scoreNoHost: hostScore(pings, rest),
                };
            })
            .sort((a, b) => a.seq - b.seq);
    }

    private fullInfo(): GameInfo {
        return { ...this.cb.info(), epoch: this.epoch, roster: this.roster(), away: this.away };
    }

    // La pestaña del anfitrión pasó a (o volvió de) segundo plano: se avisa a los invitados
    setAway(away: boolean) {
        this.away = away;
        this.announce();
    }

    // Le pasa la partida a otro jugador: todos recargan y ese jugador levanta el servidor
    async handoff(to: string) {
        diag.log(`pasando la partida a ${to.slice(0, 6)}`);
        await this.handoffAction.send({ to, epoch: this.epoch });
    }

    // Avisa a todos el estado de la partida (se llama también cuando entra o sale alguien)
    announce() {
        this.infoAction.send(this.fullInfo()).catch(() => undefined); // la sala puede estar cerrándose
    }

    private watch(peerId: string, link: Link) {
        link.ready(30000).then((how) => {
            diag.log(`jugador ${peerId.slice(0, 6)} conectado ${how}`);
            if (!this.seqs.has(peerId)) this.seqs.set(peerId, this.nextSeq++);
            this.cb.onPlayer(peerId, link.game!);
            this.announce();
            // de a una transferencia por conexión y con un máximo por jugador (aunque reconecte): un
            // invitado no puede hacer subir el paquete una y otra vez (sobre todo por el relay TURN)
            let sending = false;
            link.files!.onmessage = async (ev) => {
                const sent = this.transfers.get(peerId) ?? 0;
                if (ev.data !== 'get' || sending || sent >= MAX_TRANSFERS) return;
                sending = true;
                this.transfers.set(peerId, sent + 1);
                try {
                    await sendBlob(link.files!, await this.cb.pack(), (sent, total) => this.cb.onTransfer?.(peerId, sent, total));
                } catch (e) {
                    diag.log(`envío de archivos a ${peerId.slice(0, 6)}: ${(e as Error).message}`);
                } finally {
                    sending = false;
                }
            };
        }).catch((e) => diag.log(`jugador ${peerId.slice(0, 6)}: ${(e as Error).message}`));
        let failTimer = 0;
        link.pc.addEventListener('connectionstatechange', () => {
            clearTimeout(failTimer);
            if (this.links.get(peerId) !== link) return;
            const state = link.pc.connectionState;
            if (state === 'closed') this.drop(peerId);
            // "failed": se da tiempo a que el reinicio de ICE recupere la conexión antes de expulsar al jugador
            else if (state === 'failed') {
                failTimer = window.setTimeout(() => {
                    if (this.links.get(peerId) === link && link.pc.connectionState === 'failed') this.drop(peerId);
                }, 12000);
            }
        });
    }

    private drop(peerId: string) {
        this.links.get(peerId)?.close();
        this.links.delete(peerId);
        this.seqs.delete(peerId);
        this.caps.delete(peerId);
        this.pings.delete(peerId);
        this.cb.onLeave(peerId);
        this.announce();
    }

    leave() {
        this.timers.forEach(t => clearInterval(t));
        this.room.leave();
        for (const id of [...this.links.keys()]) this.drop(id);
    }
}

// ---------------------------------------------------------------- invitado

export class GuestRoom {
    private room!: RoomLike;
    private sig!: MessageAction<Sig>;
    private hostId: string | null = null;
    private link: Link | null = null;
    private capsAction!: MessageAction<Caps>;
    private established = false;
    private lostFired = false;
    private leaving = false;
    private disconnectTimer = 0;
    private joinedAt = 0;
    info: GameInfo | null = null;
    onInfo?: (info: GameInfo) => void;
    // se perdió al anfitrión antes de haber entrado a jugar (búsqueda o conexión inicial)
    onHostLeft?: () => void;
    // se perdió al anfitrión estando conectado: hay que migrar la partida
    onHostLost?: () => void;
    // el anfitrión le pasa la partida al jugador `to`
    onHandoff?: (to: string) => void;
    private reportTimer = 0;

    // minEpoch / maxEpoch / exclude: tras una migración sólo se aceptan anfitriones nuevos (epoch
    // entre el del anterior y uno más, y que no sean el anfitrión que se perdió)
    constructor(
        readonly code: string,
        private turn: TurnSettings | null,
        private accept: { minEpoch?: number; maxEpoch?: number; exclude?: string[] } = {},
    ) {
        this.join();
    }

    get hostPeerId() {
        return this.hostId;
    }

    // la sala de señalización (para el enjambre de archivos)
    get signaling(): RoomLike {
        return this.room;
    }

    private join() {
        const room = this.room = joinTrystero(this.code, this.turn);
        this.joinedAt = performance.now();
        const info = room.makeAction<GameInfo>('info');
        this.sig = room.makeAction<Sig>('sig');
        this.capsAction = room.makeAction<Caps>('caps');
        // los eventos de una sala que ya se dejó (rejoin) se ignoran
        info.onMessage = (data, { peerId }) => {
            if (this.room !== room || (this.hostId && peerId !== this.hostId)) return;
            if (!data || typeof data !== 'object' || !Array.isArray(data.roster) || !data.pack || typeof data.pack !== 'object'
                || typeof data.pack.version !== 'string' || !Number.isFinite(data.pack.size)) return;
            const epoch = Number(data.epoch) || 0;
            if (this.accept.exclude?.includes(peerId) || epoch < (this.accept.minEpoch ?? 0)
                || epoch > (this.accept.maxEpoch ?? Infinity)) return;
            if (!this.hostId) diag.log(`anfitrión encontrado (${peerId.slice(0, 6)}, epoch ${epoch})`);
            this.hostId = peerId;
            this.info = data;
            this.onInfo?.(data);
        };
        this.sig.onMessage = (s, { peerId }) => {
            if (this.room !== room || peerId !== this.hostId || !this.link || s.sid !== this.link.sid) return;
            this.link.handle(s).catch(e => diag.log(`señalización: ${(e as Error).message}`));
        };
        room.onPeerLeave = (peerId) => {
            if (this.room !== room || peerId !== this.hostId) return;
            if (this.link?.pc.connectionState === 'connected') return;
            this.lost(this.link);
        };
        // sólo vale si viene del anfitrión de esta partida y este jugador ya está jugando
        room.makeAction<Handoff>('handoff').onMessage = (data, { peerId }) => {
            if (this.room !== room || peerId !== this.hostId || !this.established || this.leaving) return;
            if (typeof data?.to !== 'string' || Number(data.epoch) !== Number(this.info?.epoch)) return;
            diag.log(`el anfitrión pasa la partida a ${data.to.slice(0, 6)}`);
            this.onHandoff?.(data.to);
        };
    }

    // Cuenta al anfitrión qué puede hacer este jugador (lo usa para armar la lista de sucesores) y,
    // de ahí en más, cada pocos segundos, su ping con cada jugador de la sala
    startReporting(caps: Omit<Caps, 'pings'>) {
        const report = async () => {
            if (!this.hostId || this.leaving) return;
            const pings = await pingAll(this.room.getPeers());
            if (this.hostId) this.capsAction.send({ ...caps, pings }, { target: this.hostId }).catch(() => undefined);
        };
        clearInterval(this.reportTimer);
        this.reportTimer = window.setInterval(report, PING_EVERY_MS);
        report();
    }

    private lost(link: Link | null) {
        if (this.leaving || this.lostFired || link !== this.link) return;
        diag.log(this.established ? 'se perdió la conexión con el anfitrión' : 'el anfitrión no está disponible');
        if (this.established) {
            this.lostFired = true;
            this.onHostLost?.();
            return;
        }
        // todavía no se había entrado a jugar: se lo olvida, así se puede tomar al anfitrión que
        // aparezca después (por ejemplo, el que tomó la partida tras una migración)
        this.hostId = null;
        this.info = null;
        this.onHostLeft?.();
    }

    // Vigila que la conexión del juego siga viva
    private watchLink(link: Link) {
        let downSince = 0;
        link.pc.addEventListener('connectionstatechange', () => {
            const state = link.pc.connectionState;
            if (state === 'connected') {
                downSince = 0;
                clearTimeout(this.disconnectTimer);
            } else if (state === 'closed') {
                this.lost(link);
            } else if (!downSince) {
                // "disconnected" / "failed" suelen ser un corte breve: el anfitrión reinicia ICE y se le da
                // tiempo antes de darlo por perdido. El plazo corre desde el primer corte, aunque en el
                // medio la conexión pase por "connecting" mientras se reintenta.
                if (state !== 'disconnected' && state !== 'failed') return;
                downSince = performance.now();
                this.disconnectTimer = window.setTimeout(() => this.lost(link), 9000);
            }
        });
        link.game?.addEventListener('close', () => this.lost(link));
    }

    // Si pasados unos segundos desde que se entró a la sala todavía no apareció el anfitrión, vuelve a
    // entrar (por ejemplo después de conseguir el permiso de micrófono, para que las conexiones nuevas
    // usen las IPs reales). Antes no: cortaría a la mitad las conexiones que se estaban armando.
    async rejoinIfSilent(graceMs = 8000) {
        const wait = this.joinedAt + graceMs - performance.now();
        if (!this.info && wait > 0) await this.waitHost(wait, false).catch(() => undefined);
        if (this.info) return;
        diag.log('reintentando la búsqueda del anfitrión');
        await this.room.leave();
        this.join();
    }

    waitHost(timeoutMs: number, log = true): Promise<GameInfo> {
        if (this.info) return Promise.resolve(this.info);
        return new Promise((resolve, reject) => {
            const prev = this.onInfo;
            const t = setTimeout(() => {
                this.onInfo = prev;
                if (log) diag.log('no apareció el anfitrión');
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
        this.link = new Link(sid, this.turn, (s) => {
            this.sig.send(s, { target: host }).catch(() => undefined); // ICE reintenta o vence el plazo
        }, false);
        diag.log('pidiendo conexión al anfitrión');
        try {
            await this.sig.send({ sid, type: 'hello' }, { target: host });
        } catch {
            throw new Error('Se encontró la partida pero no se pudo contactar al anfitrión. Probá de nuevo en unos segundos.');
        }
        const link = this.link;
        const how = await link.ready(timeoutMs);
        this.established = true;
        this.lostFired = false;
        this.watchLink(link);
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
        this.leaving = true;
        clearTimeout(this.disconnectTimer);
        clearInterval(this.reportTimer);
        this.link?.close();
        return this.room.leave();
    }
}
