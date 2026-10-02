// Configuración de red WebRTC y diagnóstico de conexión.

// ---- servidores ICE ----

export type TurnSettings = { url: string; username: string; credential: string };

export function loadTurn(): TurnSettings | null {
    try {
        const t = JSON.parse(localStorage.getItem('csweb:turn') || 'null') as TurnSettings | null;
        return t?.url ? t : null;
    } catch {
        return null;
    }
}

export function saveTurn(t: TurnSettings | null) {
    if (t?.url) localStorage.setItem('csweb:turn', JSON.stringify(t));
    else localStorage.removeItem('csweb:turn');
}

// ICE automático: un Worker de Cloudflare entrega credenciales TURN efímeras (el secreto nunca
// está en la página). Si no hay Worker configurado o falla, se sigue con STUN + el TURN manual.
const TURN_ENDPOINT = (import.meta.env.VITE_TURN_ENDPOINT as string | undefined)?.trim() || '';
const ICE_TIMEOUT_MS = 3000;
let workerIce: RTCIceServer[] = [];
let icePromise: Promise<RTCIceServer[]> | null = null;

// `?relay=1` fuerza a pasar siempre por TURN (sólo para probar que el relay anda de punta a punta)
export const forceRelay = new URLSearchParams(location.search).get('relay') === '1';

export function prepareIce(): Promise<RTCIceServer[]> {
    icePromise ??= (async () => {
        if (!TURN_ENDPOINT) {
            diag.log('relay automático no configurado (sin VITE_TURN_ENDPOINT)');
            return workerIce;
        }
        try {
            const res = await fetch(TURN_ENDPOINT, { cache: 'no-store', signal: AbortSignal.timeout(ICE_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as { iceServers?: RTCIceServer[] } | RTCIceServer[];
            const list = Array.isArray(data) ? data : data.iceServers;
            workerIce = (list ?? []).filter(s => s?.urls);
            const relays = workerIce.filter(s => s.username).length;
            diag.log(`relay automático: ${relays ? 'disponible' : 'sin servidores TURN'}`);
        } catch (e) {
            diag.log(`relay automático no disponible (${(e as Error).message})`);
        }
        return workerIce;
    })();
    return icePromise;
}

export function hasAutoRelay() {
    return workerIce.some(s => s.username);
}

// Servidores TURN: primero el manual del usuario (si lo cargó), después el automático
export function turnServers(turn: TurnSettings | null): RTCIceServer[] {
    const manual: RTCIceServer[] = turn
        ? [{ urls: turn.url.split(/[\s,]+/).filter(Boolean), username: turn.username, credential: turn.credential }]
        : [];
    return [...manual, ...workerIce.filter(s => s.username)];
}

export function rtcConfig(turn: TurnSettings | null): RTCConfiguration {
    return {
        iceServers: [
            { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
            { urls: 'stun:stun.cloudflare.com:3478' },
            ...turnServers(turn),
        ],
        ...(forceRelay ? { iceTransportPolicy: 'relay' as const } : {}),
    };
}

// ---- diagnóstico del tipo de red ----

export type NetCheck = {
    natType: 'abierto' | 'simétrico' | 'sin-stun';
    ipv6: boolean;
    mdns: boolean;
    summary: string;
};

// Junta candidatos con dos servidores STUN distintos desde el mismo socket: si el NAT asigna un
// puerto público distinto según el destino (NAT simétrico) la conexión directa suele fallar y
// hace falta relay.
export async function checkNetwork(timeoutMs = 4000): Promise<NetCheck> {
    const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
        ],
    });
    const mappings = new Map<string, Set<string>>(); // base (raddr:rport) → direcciones públicas
    let ipv6 = false;
    let mdns = false;
    try {
        pc.createDataChannel('probe');
        const done = new Promise<void>((resolve) => {
            pc.onicecandidate = (e) => {
                if (!e.candidate?.candidate) {
                    resolve();
                    return;
                }
                const parts = e.candidate.candidate.split(' ');
                const typ = parts[7];
                const addr = parts[4] ?? '';
                if (typ === 'host') {
                    if (addr.endsWith('.local')) mdns = true;
                    else if (addr.includes(':') && !/^fe80/i.test(addr)) ipv6 = true;
                } else if (typ === 'srflx') {
                    const base = `${parts[9]}:${parts[11]}`;
                    (mappings.get(base) ?? mappings.set(base, new Set()).get(base)!).add(`${addr}:${parts[5]}`);
                }
            };
        });
        await pc.setLocalDescription(await pc.createOffer());
        await Promise.race([done, new Promise<void>(r => setTimeout(r, timeoutMs))]);
    } finally {
        pc.close();
    }
    const found = [...mappings.values()];
    const natType = !found.length ? 'sin-stun' : found.some(s => s.size > 1) ? 'simétrico' : 'abierto';
    const summary = natType === 'simétrico'
        ? 'NAT simétrico: la conexión directa suele fallar, se usará relay'
        : natType === 'sin-stun'
            ? 'No se pudo contactar a los servidores STUN (¿UDP bloqueado?): hará falta relay'
            : ipv6 ? 'NAT permisivo + IPv6: conexión directa probable' : 'NAT permisivo: conexión directa probable';
    const result = { natType, ipv6, mdns, summary } satisfies NetCheck;
    diag.log(`red: ${summary}${mdns ? ' (IP local oculta por mDNS)' : ''}`);
    return result;
}

// Latencia (ms) del camino elegido, o null si todavía no se puede medir
export async function measureRtt(pc: RTCPeerConnection): Promise<number | null> {
    try {
        const stats = await pc.getStats();
        let rtt: number | null = null;
        stats.forEach((s) => {
            const pair = s as RTCIceCandidatePairStats;
            if (s.type === 'candidate-pair' && pair.nominated && pair.state === 'succeeded' && pair.currentRoundTripTime != null) {
                rtt = Math.round(pair.currentRoundTripTime * 1000);
            }
        });
        return rtt;
    } catch {
        return null;
    }
}

// ---- IPs locales reales ----
// Sin permiso de cámara/micrófono, el navegador oculta la IP local detrás de un nombre ".local"
// (mDNS) que muchas redes (corporativas, hotspots) no dejan resolver, y la conexión directa
// entre dos PCs de la misma red falla. Con el permiso de micrófono concedido usa la IP real.

let micStream: MediaStream | null = null;

export async function unlockLocalAddresses(): Promise<boolean> {
    if (micStream) return true;
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        diag.log('permiso de micrófono concedido: se usan IPs locales reales');
        return true;
    } catch (e) {
        diag.log(`sin permiso de micrófono (${(e as Error).name}): IPs locales ocultas (mDNS)`);
        return false;
    }
}

export const hasLocalAddresses = () => micStream !== null;

export function releaseMic() {
    micStream?.getTracks().forEach(t => t.stop());
    micStream = null;
}

// ---- registro de diagnóstico ----

const lines: string[] = [];
const t0 = performance.now();

export const diag = {
    log(msg: string) {
        const line = `[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`;
        lines.push(line);
        if (lines.length > 300) lines.shift();
        console.info('[red]', msg);
    },
    text() {
        return [
            `navegador: ${navigator.userAgent}`,
            `página: ${location.href}`,
            ...lines,
        ].join('\n');
    },
};

export function candidateType(candidate: string) {
    const typ = candidate.match(/ typ (\w+)/)?.[1] ?? '?';
    const addr = candidate.split(' ')[4] ?? '';
    const proto = candidate.split(' ')[2]?.toLowerCase() ?? '';
    const where = addr.endsWith('.local') ? 'mDNS' : addr.includes(':') ? 'IPv6' : addr;
    return `${typ}/${proto}${where ? ` ${where}` : ''}`;
}

// Qué tipo de camino terminó usando la conexión (directo en la LAN, por internet o por TURN)
export async function selectedPath(pc: RTCPeerConnection): Promise<string> {
    try {
        const stats = await pc.getStats();
        let pair: RTCIceCandidatePairStats | undefined;
        stats.forEach((s) => {
            if (s.type === 'transport' && (s as RTCTransportStats).selectedCandidatePairId) {
                pair = stats.get((s as RTCTransportStats).selectedCandidatePairId!) as RTCIceCandidatePairStats;
            }
        });
        if (!pair) {
            stats.forEach((s) => {
                if (s.type === 'candidate-pair' && (s as RTCIceCandidatePairStats).nominated && s.state === 'succeeded') {
                    pair = s as RTCIceCandidatePairStats;
                }
            });
        }
        if (!pair) return 'desconocido';
        const local = stats.get(pair.localCandidateId) as { candidateType?: string; protocol?: string } | undefined;
        const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
        return `${local?.candidateType ?? '?'}/${local?.protocol ?? '?'} → ${remote?.candidateType ?? '?'}`;
    } catch {
        return 'desconocido';
    }
}

export function describePath(path: string) {
    if (path.includes('relay')) return 'a través del servidor TURN';
    if (/^host.*→ (host|prflx)/.test(path)) return 'directo en la red local';
    if (path.includes('srflx') || path.includes('prflx')) return 'directo a través de internet';
    return path;
}
