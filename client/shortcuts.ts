// Evita que los atajos del navegador interrumpan el juego (Ctrl+W al agacharse y avanzar,
// Ctrl+R, Ctrl+S, Ctrl+D, F5...).
//
// Ctrl+W / Ctrl+T / Ctrl+N / Ctrl+Tab son atajos reservados: el navegador sólo se los entrega
// a la página con la Keyboard Lock API, que requiere pantalla completa y conexión segura
// (https o localhost) y existe sólo en Chrome/Edge. El resto se puede cancelar siempre.

type KeyboardLockApi = { lock(keys?: string[]): Promise<void>; unlock(): void };

const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLockApi> }).keyboard;

export type LockSupport = 'ok' | 'insecure' | 'unsupported';

export function keyboardLockSupport(): LockSupport {
    if (!keyboard?.lock) {
        return window.isSecureContext ? 'unsupported' : 'insecure';
    }
    return 'ok';
}

export async function enterFullscreen(): Promise<boolean> {
    try {
        if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
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
        // copiar/pegar se deja pasar (sirve en la consola del juego)
        const clipboard = /^[cvx]$/i.test(e.key);
        const combo = ((e.ctrlKey || e.metaKey) && !clipboard) || (e.altKey && e.key.startsWith('Arrow'));
        if (combo || BLOCK_KEYS.has(e.key)) e.preventDefault();
    }, true);
    // última red de seguridad: si igual se intenta cerrar/recargar, el navegador pide confirmación
    window.addEventListener('beforeunload', (e) => {
        if (!isPlaying()) return;
        e.preventDefault();
        e.returnValue = '';
    });
}
