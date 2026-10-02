// Worker de Cloudflare: entrega credenciales TURN efímeras a la página de GitHub Pages.
// El token de Cloudflare vive sólo como secreto del Worker; la página nunca lo ve.
//
//   GET /turn  →  { "iceServers": [ { urls: [stun…] }, { urls: [turn…], username, credential } ] }

interface Env {
    TURN_KEY_ID: string;
    TURN_API_TOKEN: string;
    // orígenes permitidos, separados por coma (por ejemplo "https://usuario.github.io")
    ALLOWED_ORIGINS: string;
    // vida de las credenciales en segundos (por defecto 1 día)
    TURN_TTL?: string;
}

const MAX_PER_MINUTE = 30;
// Límite por IP por instancia del Worker: es un freno barato contra abuso, no una garantía
const hits = new Map<string, { count: number; reset: number }>();

function rateLimited(ip: string, now: number) {
    const entry = hits.get(ip);
    if (!entry || now > entry.reset) {
        if (hits.size > 5000) hits.clear();
        hits.set(ip, { count: 1, reset: now + 60_000 });
        return false;
    }
    entry.count++;
    return entry.count > MAX_PER_MINUTE;
}

function allowedOrigin(request: Request, env: Env): string | null {
    const origin = request.headers.get('Origin');
    if (!origin) return null;
    const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.includes(origin)) return origin;
    // desarrollo local (npm run dev:pages)
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Vary': 'Origin' };
    if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    }
    return headers;
}

function json(body: unknown, status: number, origin: string | null): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const origin = allowedOrigin(request, env);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
        if (url.pathname !== '/turn' || request.method !== 'GET') return json({ error: 'no encontrado' }, 404, origin);
        // Las páginas de otros sitios no deben poder gastar el cupo desde el navegador de un tercero
        if (request.headers.has('Origin') && !origin) return json({ error: 'origen no permitido' }, 403, null);

        const ip = request.headers.get('CF-Connecting-IP') ?? 'desconocida';
        if (rateLimited(ip, Date.now())) return json({ error: 'demasiadas solicitudes' }, 429, origin);

        if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return json({ error: 'Worker sin configurar' }, 500, origin);

        const ttl = Math.min(Math.max(Number(env.TURN_TTL) || 86400, 600), 172800);
        const res = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ttl }),
            },
        );
        if (!res.ok) return json({ error: `Cloudflare respondió ${res.status}` }, 502, origin);
        return json(await res.json(), 200, origin);
    },
};
