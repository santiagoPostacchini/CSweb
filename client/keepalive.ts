// El motor dibuja y procesa la red dentro de requestAnimationFrame. Si el navegador deja de
// entregar frames (pestaña en segundo plano, ventana tapada o minimizada) el cliente deja de
// responder y el servidor termina desconectando al jugador. Y en un listen server el ritmo de
// frames del anfitrión es el ritmo del servidor para todos. Acá, si el navegador deja de dar
// frames, un Web Worker (cuyos timers no se congelan en segundo plano) los sigue dando a ~60 por
// segundo.
const nativeRAF = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);

type Pending = { cb: FrameRequestCallback; since: number; done: boolean; id: number };

// Ritmo del worker (~60 frames por segundo cuando los da él)
const TICK_MS = 16;
// Sin frames del navegador por más que esto, los da el worker
const STALL_MS = 100;
const pending = new Map<number, Pending>();

// Último frame entregado (para detectar si el motor dejó de pedir frames)
let lastFrame = performance.now();
export const lastFrameAt = () => lastFrame;
// El navegador dejó de dar frames: hasta que vuelva a dar uno, los da el worker
let stalled = false;

const worker = new Worker(URL.createObjectURL(new Blob(
    [`setInterval(() => postMessage(0), ${TICK_MS});`],
    { type: 'text/javascript' },
)));

worker.onmessage = () => {
    const now = performance.now();
    // una vez que el navegador dejó de dar frames, cada tick del worker da uno (esperar STALL_MS
    // por cada frame daba ~7 por segundo)
    stalled ||= [...pending.values()].some(p => now - p.since >= STALL_MS);
    for (const p of [...pending.values()]) {
        if (!stalled && now - p.since < STALL_MS) continue;
        pending.delete(p.id);
        nativeCancel(p.id);
        if (!p.done) {
            p.done = true;
            lastFrame = now;
            p.cb(now);
        }
    }
};

window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const p: Pending = { cb, since: performance.now(), done: false, id: 0 };
    p.id = nativeRAF((t) => {
        pending.delete(p.id);
        if (p.done) return;
        p.done = true;
        stalled = false;
        lastFrame = performance.now();
        cb(t);
    });
    pending.set(p.id, p);
    return p.id;
};

window.cancelAnimationFrame = (id: number) => {
    const p = pending.get(id);
    if (p) {
        p.done = true;
        pending.delete(id);
    }
    nativeCancel(id);
};
