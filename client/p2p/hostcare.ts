// Cuidados de la pestaña del anfitrión: su servidor es el de todos, así que se le pide al
// navegador que no la duerma y se avisa cuando queda en segundo plano.
// - Wake lock de pantalla: la PC no apaga la pantalla ni se suspende mientras se juega.
// - Un Web Lock tomado: Chrome no congela ni descarta pestañas que tienen uno.
// - No hace falta un AudioContext silencioso: Chrome no aplica el throttling intensivo de timers a
//   páginas con conexiones WebRTC abiertas, y keepalive.ts ya mueve el motor desde un Worker.
import { showToast } from '../ui';
import { diag } from './netdiag';

// A partir de cuánto tiempo en segundo plano se avisa (a los invitados y, al volver, al anfitrión)
const HIDDEN_WARN_MS = 5000;

export function careForHost(onAway: (away: boolean) => void) {
    let wake: WakeLockSentinel | null = null;
    const requestWake = async () => {
        if (wake || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
        try {
            wake = await navigator.wakeLock.request('screen');
            wake.addEventListener('release', () => { wake = null; });
        } catch (e) {
            diag.log(`sin wake lock: ${(e as Error).message}`);
        }
    };
    requestWake();

    // nunca se suelta: dura lo que dura la pestaña (nombre único por si hay varias pestañas abiertas)
    navigator.locks?.request(`csweb:anfitrion:${crypto.randomUUID()}`, () => new Promise<void>(() => undefined))
        .catch(() => undefined);

    const title = document.title;
    let hiddenAt = 0;
    let warnTimer = 0;
    let away = false;
    const onVisibility = () => {
        clearTimeout(warnTimer);
        if (document.visibilityState === 'hidden') {
            hiddenAt = performance.now();
            warnTimer = window.setTimeout(() => {
                away = true;
                document.title = '⚠ Sos el anfitrión: volvé a esta pestaña';
                diag.log('pestaña del anfitrión en segundo plano');
                onAway(true);
            }, HIDDEN_WARN_MS);
            return;
        }
        requestWake();
        if (!away) return;
        away = false;
        document.title = title;
        const s = Math.round((performance.now() - hiddenAt) / 1000);
        diag.log(`pestaña del anfitrión visible otra vez (${s} s en segundo plano)`);
        onAway(false);
        showToast(`Tu pestaña estuvo ${s} s en segundo plano: los demás pudieron notar lag. `
            + 'Mientras seas el anfitrión, dejala visible.', 9000);
    };
    document.addEventListener('visibilitychange', onVisibility);
    // la pestaña puede arrancar ya oculta (por ejemplo, si tomó la partida en una migración)
    if (document.visibilityState === 'hidden') onVisibility();
}
