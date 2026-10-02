// Evita que los atajos del navegador interrumpan el juego (Ctrl+W al agacharse y avanzar,
// Ctrl+R, Ctrl+S, Ctrl+D, F5...).
//
// Ctrl+W / Ctrl+T / Ctrl+N / Ctrl+Tab son atajos reservados: el navegador sólo se los entrega a la
// página (que los cancela con preventDefault en guardShortcuts) en estos casos:
// - Chrome/Edge en pantalla completa pedida por la página, con la Keyboard Lock API
//   (navigator.keyboard.lock). Necesita conexión segura (https o localhost).
// - Firefox 151+ (y Safari 26.4+) en pantalla completa pedida con `keyboardLock: "browser"`.
// - Chrome/Edge con la página instalada como app (ventana propia): ahí no hay teclas reservadas,
//   ni siquiera fuera de pantalla completa.
// El resto de los atajos se puede cancelar siempre.

type KeyboardLockApi = { lock(keys?: string[]): Promise<void>; unlock(): void };

const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLockApi> }).keyboard;

const firefoxVersion = Number(navigator.userAgent.match(/Firefox\/(\d+)/)?.[1] ?? 0);

// La Keyboard Lock API sólo existe en Chromium (Chrome, Edge...)
export const isChromium = Boolean(keyboard);

// La página corre en una ventana de app instalada (Chrome/Edge)
const isAppWindow = isChromium
    && ['standalone', 'minimal-ui', 'window-controls-overlay'].some(m => matchMedia(`(display-mode: ${m})`).matches);

// ok: se bloquea en pantalla completa · app: se bloquea siempre (app instalada) ·
// old-firefox: Firefox anterior al 151 · insecure: falta https · unsupported: no se puede
export type LockSupport = 'ok' | 'app' | 'old-firefox' | 'insecure' | 'unsupported';

export function keyboardLockSupport(): LockSupport {
    if (!window.isSecureContext) return 'insecure';
    if (isAppWindow) return 'app';
    if (keyboard?.lock || firefoxVersion >= 151) return 'ok';
    return firefoxVersion ? 'old-firefox' : 'unsupported';
}

export async function enterFullscreen(): Promise<boolean> {
    try {
        if (!document.fullscreenElement) {
            // keyboardLock: Firefox 151+ / Safari 26.4+; los demás ignoran la opción
            const options = { navigationUI: 'hide', keyboardLock: 'browser' };
            await document.documentElement.requestFullscreen(options as FullscreenOptions);
        }
        await keyboard?.lock?.();
        return true;
    } catch (e) {
        console.warn('No se pudo activar pantalla completa / bloqueo de teclado', e);
        return false;
    }
}

const BLOCK_KEYS = new Set(['F1', 'F3', 'F5', 'F6', 'F7', 'BrowserBack', 'BrowserForward', 'BrowserRefresh']);

// Mientras se juega: cancela la acción por defecto del navegador pero deja que el evento
// siga hasta el motor (no se usa stopPropagation), así Ctrl+W sigue siendo "agacharse y avanzar".
export function guardShortcuts(isPlaying: () => boolean) {
    window.addEventListener('keydown', (e) => {
        if (!isPlaying()) return;
        // Para salir de pantalla completa con el bloqueo de teclado hay que MANTENER Esc: el sistema
        // repite la tecla ~30 veces por segundo y el motor abría y cerraba el menú en ráfaga hasta
        // trabarse. El motor sólo ve el primer Esc; las repeticiones no le llegan.
        if (e.key === 'Escape' && e.repeat) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
        // copiar/pegar se deja pasar (sirve en la consola del juego)
        const clipboard = /^[cvx]$/i.test(e.key);
        const combo = ((e.ctrlKey || e.metaKey) && !clipboard) || (e.altKey && e.key.startsWith('Arrow'));
        // con el bloqueo de teclado, Esc abre el menú del juego en vez de salir de pantalla completa
        // (para salir hay que mantenerlo apretado)
        const esc = e.key === 'Escape' && Boolean(document.fullscreenElement);
        if (combo || esc || BLOCK_KEYS.has(e.key)) e.preventDefault();
    }, true);
    // última red de seguridad: si igual se intenta cerrar/recargar, el navegador pide confirmación
    window.addEventListener('beforeunload', (e) => {
        if (!isPlaying()) return;
        e.preventDefault();
        e.returnValue = '';
    });
}
