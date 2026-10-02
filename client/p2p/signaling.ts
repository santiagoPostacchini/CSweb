// Señalización redundante: la misma sala se abre por varias estrategias de Trystero a la vez
// (relays Nostr y trackers de torrent, servicios públicos independientes). Si una está caída o
// bloqueada en la red del jugador, la otra alcanza para que los navegadores se encuentren.
//
// Cada estrategia arma sus propias conexiones entre los mismos pares; acá se las junta en una
// sola sala: un par "entra" cuando aparece por la primera estrategia y "sale" cuando desapareció
// de todas, y cada mensaje se manda por una sola estrategia (la primera donde el par esté
// conectado), así nunca llega duplicado.
import { joinRoom as joinNostr, selfId, type DataPayload, type JoinRoomCallbacks, type MessageAction, type Room, type TurnServerConfig } from '@trystero-p2p/nostr';
import { joinRoom as joinTorrent } from '@trystero-p2p/torrent';
import { diag } from './netdiag';

export { selfId };

type SendOptions = NonNullable<Parameters<MessageAction['send']>[1]>;

export type RoomLike = {
    makeAction<T extends DataPayload = DataPayload>(namespace: string): MessageAction<T>;
    leave(): Promise<void>;
    onPeerJoin: ((peerId: string) => void) | null;
    onPeerLeave: ((peerId: string) => void) | null;
};

type Strategy = { name: string; room: Room };

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
                if (set.size === 1) this.onPeerJoin?.(peerId);
                else diag.log(`${peerId.slice(0, 6)} también conectado por ${s.name}`);
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
                // agrupa los destinatarios por la estrategia que se usa para cada uno
                const byStrategy = new Map<number, string[]>();
                for (const id of ids) {
                    const via = this.present.get(id);
                    const index = via?.size ? Math.min(...via) : -1;
                    byStrategy.set(index, [...(byStrategy.get(index) ?? []), id]);
                }
                await Promise.all([...byStrategy.entries()].map(async ([index, peers]) => {
                    // par desconocido: se intenta por todas las estrategias
                    const targets = index < 0 ? actions : [actions[index]];
                    await Promise.allSettled(targets.map(a => a.send(data, { ...options, target: peers })));
                }));
            },
        };
        actions.forEach((a) => {
            a.onMessage = (data, context) => out.onMessage?.(data, context);
            a.onReceiveProgress = (progress, context) => out.onReceiveProgress?.(progress, context);
        });
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
            strategies.push({ name, room: join(config, roomId, callbacks) });
        } catch (e) {
            diag.log(`señalización ${name} no disponible: ${(e as Error).message}`);
        }
    }
    if (!strategies.length) throw new Error('No se pudo iniciar ningún canal de señalización');
    diag.log(`señalización por: ${strategies.map(s => s.name).join(' + ')}`);
    return new MultiRoom(strategies);
}
