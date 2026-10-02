// Migración de anfitrión.
// Si el anfitrión se cae, todos los jugadores (que ya tienen los archivos del juego guardados)
// calculan el mismo sucesor a partir de la última lista de jugadores que recibieron, recargan la
// página y el sucesor levanta el servidor en la misma sala. Los demás se vuelven a conectar solos.
// Se pierde la ronda y el marcador, no el grupo ni el mapa.
import type { GameInfo, RosterEntry } from './room';
import { SCORE_STEP_MS } from './quality';

const KEY = 'csweb:migration';
const MAX_AGE_MS = 2 * 60_000;

// Cada candidato espera su turno antes de tomar la partida, por si el anterior no llegó a hacerlo
export const SLOT_MS = 12_000;
// El primer sucesor sólo espera un instante por si otro jugador ya levantó la partida
export const FIRST_WAIT_MS = 3_000;

export type Migration = {
    code: string;
    // epoch del anfitrión perdido: los anfitriones nuevos tienen que tener al menos este epoch
    lostEpoch: number;
    // peerId del anfitrión perdido (no se lo vuelve a aceptar aunque siga apareciendo en la sala)
    excludePeer: string | null;
    // lugar de este jugador en la lista de sucesores (-1: no puede ser anfitrión)
    slot: number;
    // cuántos sucesores posibles hay
    candidates: number;
    settings: { map: string; maxPlayers: number; hostname: string };
    at: number;
};

// Quiénes pueden tomar la partida, en orden de prioridad: el de mejor conexión con los demás
// invitados (sin contar al anfitrión que se va; por franjas de ping, así una medición que oscila
// no reordena la lista) y, a la par, el que entró antes.
// `prefer`: el jugador al que el anfitrión le pasó la partida va primero.
export function successors(roster: RosterEntry[], lostPeer: string | null, prefer: string | null = null): RosterEntry[] {
    const band = (p: RosterEntry) => {
        if (p.peerId === prefer) return -1;
        return Number.isFinite(p.scoreNoHost) ? Math.floor(Number(p.scoreNoHost) / SCORE_STEP_MS) : 1e9;
    };
    return roster
        .filter(p => p.canHost && p.peerId !== lostPeer)
        .sort((a, b) => band(a) - band(b) || a.seq - b.seq || (a.peerId < b.peerId ? -1 : 1));
}

export function planMigration(code: string, info: GameInfo, lostPeer: string | null, me: string, prefer: string | null = null): Migration {
    const list = successors(info.roster ?? [], lostPeer, prefer);
    return {
        code,
        lostEpoch: info.epoch ?? 1,
        excludePeer: lostPeer,
        slot: list.findIndex(p => p.peerId === me),
        candidates: list.length,
        settings: safeSettings(info),
        at: Date.now(),
    };
}

// Los ajustes vienen del anfitrión anterior y terminan en comandos de consola del motor
function safeSettings(info: GameInfo): Migration['settings'] {
    const map = String(info.map ?? '');
    return {
        map: /^[\w.-]{1,64}$/.test(map) ? map : 'de_dust2',
        maxPlayers: Math.min(32, Math.max(2, Math.round(Number(info.maxPlayers)) || 10)),
        hostname: String(info.hostname ?? '').slice(0, 63) || 'CS 1.6',
    };
}

// Cuánto espera este jugador antes de tomar la partida (null: no es candidato, sólo se une)
export function takeoverDelay(slot: number): number | null {
    if (slot < 0) return null;
    return slot === 0 ? FIRST_WAIT_MS : slot * SLOT_MS;
}

// Cuánto tiempo hay que esperar a que aparezca un anfitrión nuevo antes de rendirse
export function giveUpAfter(candidates: number): number {
    return Math.max(1, candidates) * SLOT_MS + 20_000;
}

export function saveMigration(m: Migration) {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(m));
    } catch { /* sin sessionStorage: la página igual se recarga y el jugador entra a mano */ }
}

// Devuelve (y borra) la migración pendiente de esta pestaña si es reciente y es de esta sala
export function takeMigration(code: string): Migration | null {
    try {
        const raw = sessionStorage.getItem(KEY);
        sessionStorage.removeItem(KEY);
        const m = JSON.parse(raw || 'null') as Migration | null;
        if (!m || m.code !== code || Date.now() - m.at > MAX_AGE_MS) return null;
        return m;
    } catch {
        return null;
    }
}
