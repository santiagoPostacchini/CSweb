// El motor dibuja y procesa la red dentro de requestAnimationFrame. Si el navegador deja de
// entregar frames (pestaña en segundo plano, ventana tapada o minimizada) el cliente deja de
// responder y el servidor termina desconectando al jugador. Acá, si un frame no llega en
// 100 ms, un Web Worker (cuyos timers no se congelan en segundo plano) lo dispara igual.
const nativeRAF = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);

type Pending = { cb: FrameRequestCallback; since: number; done: boolean; id: number };

const STALL_MS = 100;
const pending = new Map<number, Pending>();

const worker = new Worker(URL.createObjectURL(new Blob(
    ['setInterval(() => postMessage(0), 50);'],
    { type: 'text/javascript' },
)));

worker.onmessage = () => {
    const now = performance.now();
    for (const p of [...pending.values()]) {
        if (now - p.since < STALL_MS) continue;
        pending.delete(p.id);
        nativeCancel(p.id);
        if (!p.done) {
            p.done = true;
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
