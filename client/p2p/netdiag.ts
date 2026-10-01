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

export function turnServers(turn: TurnSettings | null): RTCIceServer[] {
    if (!turn) return [];
    return [{ urls: turn.url.split(/[\s,]+/).filter(Boolean), username: turn.username, credential: turn.credential }];
}

export function rtcConfig(turn: TurnSettings | null): RTCConfiguration {
    return {
        iceServers: [
            { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
            { urls: 'stun:stun.cloudflare.com:3478' },
            ...turnServers(turn),
        ],
    };
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
