// Calidad de conexión entre jugadores, para elegir al mejor anfitrión.
// Trystero conecta a todos los jugadores de la sala entre sí (para la señalización), así que cada
// uno puede medir su ping con todos los demás aunque el juego sólo pase por el anfitrión.
import { measureRtt, selectedPath } from './netdiag';

export type Ping = { rtt: number; relay: boolean };
export type Pings = Record<string, Ping>;

// Recargo para las conexiones por relay: además de sumar latencia, gastan el cupo de TURN
const RELAY_PENALTY_MS = 40;
// Las diferencias menores a esto no cambian el orden de los sucesores (así una medición que
// oscila no hace que cada jugador calcule un sucesor distinto)
export const SCORE_STEP_MS = 50;
// Cuánto mejor tiene que ser otro jugador para sugerirle al anfitrión que le pase la partida
export const SUGGEST_MARGIN_MS = 30;

// Ping y tipo de camino de una conexión (null si todavía no hay camino elegido)
export async function pingOf(pc: RTCPeerConnection): Promise<Ping | null> {
    if (pc.connectionState !== 'connected') return null;
    const [rtt, path] = await Promise.all([measureRtt(pc), selectedPath(pc)]);
    return rtt == null ? null : { rtt, relay: path.includes('relay') };
}

export async function pingAll(pcs: Record<string, RTCPeerConnection>): Promise<Pings> {
    const out: Pings = {};
    await Promise.all(Object.entries(pcs).map(async ([id, pc]) => {
        const p = await pingOf(pc);
        if (p) out[id] = p;
    }));
    return out;
}

// Pings que manda otro jugador: se descarta lo que no tenga forma de ping o sea de alguien ajeno
export function sanitizePings(raw: unknown, known: Set<string>): Pings {
    const out: Pings = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
        if (!known.has(id) || !p || typeof p !== 'object') continue;
        const { rtt, relay } = p as { rtt?: unknown; relay?: unknown };
        if (typeof rtt !== 'number' || !Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) continue;
        out[id] = { rtt: Math.round(rtt), relay: relay === true };
    }
    return out;
}

// Qué tan buen anfitrión sería un jugador: su peor ping hacia el resto (ms, menor es mejor).
// Los que todavía no midió (por ejemplo, alguien que acaba de entrar) no cuentan hasta el
// próximo reporte; null si no midió a ninguno.
export function hostScore(pings: Pings, others: string[]): number | null {
    let worst: number | null = null;
    for (const id of others) {
        const p = pings[id];
        if (p) worst = Math.max(worst ?? 0, p.rtt + (p.relay ? RELAY_PENALTY_MS : 0));
    }
    return worst;
}
