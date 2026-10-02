// Señalización redundante: la misma sala se abre por varias estrategias de Trystero a la vez
// (relays Nostr y trackers de torrent, servicios públicos independientes). Si una está caída o
// bloqueada en la red del jugador, la otra alcanza para que los navegadores se encuentren.
//
// Cada estrategia arma sus propias conexiones entre los mismos pares; acá se las junta en una
// sola sala: un par "sale" cuando desapareció de todas, y cada mensaje se manda por una sola
// estrategia (la primera donde el par esté conectado; si falla, la siguiente), así nunca llega
// duplicado. `onPeerJoin` se avisa cada vez que el par aparece por una estrategia: puede repetirse
// (por ejemplo, si la conexión vieja todavía no se dio por cerrada cuando llega la nueva).
import { joinRoom as joinNostr, selfId, type DataPayload, type JoinRoomCallbacks, type MessageAction, type Room, type TurnServerConfig } from '@trystero-p2p/nostr';
import { joinRoom as joinTorrent } from '@trystero-p2p/torrent';
import { diag, forceRelay } from './netdiag';

export { selfId };

type SendOptions = NonNullable<Parameters<MessageAction['send']>[1]>;

export type RoomLike = {
    makeAction<T extends DataPayload = DataPayload>(namespace: string): MessageAction<T>;
    leave(): Promise<void>;
    // conexión con cada par de la sala (para medir el ping)
    getPeers(): Record<string, RTCPeerConnection>;
    onPeerJoin: ((peerId: string) => void) | null;
    onPeerLeave: ((peerId: string) => void) | null;
};

type Strategy = { name: string; room: Room };

// Conexiones de Trystero con registro de fallas. Su aviso ("could not connect … after exchanging
// SDP") no dice por qué no abrió; acá, si una conexión ya negoció (tiene la descripción remota)
// y a los 20 s sigue sin abrir, queda en el diagnóstico en qué quedó ICE y qué pares de candidatos
// probó. Las conexiones precalentadas que nunca se usan no se registran.
const STUCK_MS = 20_000;

class LoggedPeerConnection extends RTCPeerConnection {
    constructor(config?: RTCConfiguration) {
        // con ?relay=1 también estas conexiones van por TURN (así se prueba en una sola PC lo que
        // pasa entre dos redes que no se ven)
        super(forceRelay ? { ...config, iceTransportPolicy: 'relay' } : config);
        let watching = false;
        this.addEventListener('signalingstatechange', () => {
            if (watching || !this.remoteDescription) return;
            watching = true;
            setTimeout(() => {
                if (this.connectionState !== 'connected' && this.connectionState !== 'closed') describeStuck(this);
            }, STUCK_MS);
        });
    }
}

async function describeStuck(pc: RTCPeerConnection) {
    const pairs: string[] = [];
    const count = { local: 0, remote: 0 };
    try {
        const stats = await pc.getStats();
        const kind = (id: string) => {
            const c = stats.get(id) as { candidateType?: string; address?: string } | undefined;
            return `${c?.candidateType ?? '?'}${c?.address?.endsWith('.local') ? '(mDNS)' : ''}`;
        };
        stats.forEach((s) => {
            if (s.type === 'local-candidate') count.local++;
            else if (s.type === 'remote-candidate') count.remote++;
            else if (s.type === 'candidate-pair') {
                const p = s as RTCIceCandidatePairStats;
                pairs.push(`${kind(p.localCandidateId)}→${kind(p.remoteCandidateId)} ${p.state}`);
            }
        });
    } catch { /* sin estadísticas: queda el estado */ }
    diag.log(`trystero: conexión sin abrir a los ${STUCK_MS / 1000} s (ICE ${pc.iceConnectionState}, `
        + `conexión ${pc.connectionState}, candidatos locales ${count.local}, remotos ${count.remote}; `
        + `pares: ${pairs.slice(0, 6).join(', ') || 'ninguno'})`);
}

class MultiRoom implements RoomLike {
    onPeerJoin: ((peerId: string) => void) | null = null;
    onPeerLeave: ((peerId: string) => void) | null = null;
    // par → estrategias (índices) por las que está conectado
    private present = new Map<string, Set<number>>();

    constructor(private strategies: Strategy[]) {
        strategies.forEach((s, i) => {
            s.room.onPeerJoin = (peerId) => {
                const set = this.present.get(peerId) ?? new Set<number>();
                this.present.set(peerId, set);
                set.add(i);
                if (set.size > 1) diag.log(`${peerId.slice(0, 6)} también conectado por ${s.name}`);
                this.onPeerJoin?.(peerId);
            };
            s.room.onPeerLeave = (peerId) => {
                const set = this.present.get(peerId);
                if (!set) return;
                set.delete(i);
                if (!set.size) {
                    this.present.delete(peerId);
                    this.onPeerLeave?.(peerId);
                }
            };
        });
    }

    makeAction<T extends DataPayload = DataPayload>(namespace: string): MessageAction<T> {
        const actions = this.strategies.map(s => s.room.makeAction<T>(namespace));
        const out: MessageAction<T> = {
            onMessage: null,
            onReceiveProgress: null,
            send: async (data: T, options?: SendOptions) => {
                const target = options?.target;
                const ids = target == null ? [...this.present.keys()] : Array.isArray(target) ? target : [target];
                // agrupa los destinatarios según las estrategias por las que se los puede alcanzar
                const byRoute = new Map<string, { order: number[]; peers: string[] }>();
                for (const id of ids) {
                    const via = this.present.get(id);
                    const order = via?.size ? [...via].sort((a, b) => a - b) : [];
                    const key = order.join(',');
                    const group = byRoute.get(key) ?? { order, peers: [] };
                    group.peers.push(id);
                    byRoute.set(key, group);
                }
                const results = await Promise.all([...byRoute.values()].map(async ({ order, peers }) => {
                    // par desconocido: se intenta por todas las estrategias a la vez
                    if (!order.length) {
                        const all = await Promise.allSettled(actions.map(a => a.send(data, { ...options, target: peers })));
                        return all.some(r => r.status === 'fulfilled');
                    }
                    for (const index of order) {
                        try {
                            await actions[index].send(data, { ...options, target: peers });
                            return true;
                        } catch (e) {
                            diag.log(`envío por ${this.strategies[index].name} falló (${(e as Error).message}); se prueba otra vía`);
                        }
                    }
                    return false;
                }));
                if (results.includes(false)) throw new Error('no se pudo enviar el mensaje por ninguna vía');
            },
        };
        actions.forEach((a) => {
            a.onMessage = (data, context) => out.onMessage?.(data, context);
            a.onReceiveProgress = (progress, context) => out.onReceiveProgress?.(progress, context);
        });
        return out;
    }

    getPeers() {
        const out: Record<string, RTCPeerConnection> = {};
        // la misma estrategia por la que salen los mensajes: la de menor índice
        for (let i = this.strategies.length - 1; i >= 0; i--) {
            for (const [id, pc] of Object.entries(this.strategies[i].room.getPeers())) {
                if (this.present.get(id)?.has(i)) out[id] = pc;
            }
        }
        return out;
    }

    async leave() {
        await Promise.allSettled(this.strategies.map(s => s.room.leave()));
    }
}

export type SignalingConfig = {
    appId: string;
    turnConfig?: TurnServerConfig[];
};

export function joinSignalingRoom(config: SignalingConfig, roomId: string, callbacks: JoinRoomCallbacks): RoomLike {
    const strategies: Strategy[] = [];
    for (const [name, join] of [['nostr', joinNostr], ['torrent', joinTorrent]] as const) {
        try {
            strategies.push({ name, room: join({ ...config, rtcPolyfill: LoggedPeerConnection }, roomId, callbacks) });
        } catch (e) {
            diag.log(`señalización ${name} no disponible: ${(e as Error).message}`);
        }
    }
    if (!strategies.length) throw new Error('No se pudo iniciar ningún canal de señalización');
    diag.log(`señalización por: ${strategies.map(s => s.name).join(' + ')}`);
    return new MultiRoom(strategies);
}
