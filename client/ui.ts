// Helpers de interfaz compartidos por la página LAN y la de GitHub Pages.
import { enterFullscreen, guardShortcuts, keyboardLockSupport } from './shortcuts';

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

export function esc(s: string) {
    return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function setLoading(text: string, detail = '', fraction?: number) {
    $('loading').hidden = false;
    $('loading-text').textContent = text;
    $('loading-detail').textContent = detail;
    const bar = $('bar');
    if (fraction === undefined) {
        bar.classList.add('indeterminate');
    } else {
        bar.classList.remove('indeterminate');
        bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    }
}

let toastTimer = 0;
export function showToast(msg: string, ms = 4000) {
    const toast = $('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
}

export const isPlaying = () => document.body.classList.contains('playing');

// Oculta paneles y muestra el canvas del juego
export function enterGame(canvas: HTMLCanvasElement) {
    for (const el of document.querySelectorAll<HTMLElement>('.panel')) el.hidden = true;
    document.body.classList.add('playing');
    showToast('Hacé click en el juego para capturar el mouse · ESC menú · ` consola', 7000);
    canvas.focus();
}

// La página se recarga a propósito (por ejemplo al migrar de anfitrión): sin pedir confirmación
let unloadAllowed = false;
export function allowUnload() {
    unloadAllowed = true;
}

// Bloqueo de atajos del navegador + pantalla completa (Ctrl+W deja de cerrar la pestaña)
export function setupGameGuards(canvas: HTMLCanvasElement, fullscreenInput: HTMLInputElement) {
    const lockSupport = keyboardLockSupport();
    guardShortcuts(() => isPlaying() && !unloadAllowed);
    canvas.addEventListener('mousedown', () => {
        // el click en el juego es un gesto del usuario: sirve para volver a pantalla completa
        if (isPlaying() && fullscreenInput.checked && !document.fullscreenElement) enterFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
        if (!isPlaying() || !fullscreenInput.checked || document.fullscreenElement) return;
        showToast(lockSupport === 'ok'
            ? 'Saliste de pantalla completa: Ctrl+W vuelve a cerrar la pestaña. Click en el juego para volver.'
            : 'Saliste de pantalla completa. Click en el juego para volver.', 6000);
    });
    fullscreenInput.checked = localStorage.getItem('csweb:fullscreen') !== 'false';
    fullscreenInput.addEventListener('change', () => {
        localStorage.setItem('csweb:fullscreen', String(fullscreenInput.checked));
    });
    return {
        lockSupport,
        // llamar dentro del click que inicia el juego (gesto del usuario)
        requestFullscreen: () => {
            if (fullscreenInput.checked) enterFullscreen();
        },
    };
}

export function lockHintHtml(lockSupport: ReturnType<typeof keyboardLockSupport>) {
    if (lockSupport === 'ok') return '';
    if (lockSupport === 'insecure') {
        const url = `https://${location.host}${location.pathname}`;
        return `Para que <kbd>Ctrl</kbd>+<kbd>W</kbd> no cierre la pestaña entrá por <a href="${esc(url)}">${esc(url)}</a> `
            + '(la primera vez el navegador avisa del certificado: "Configuración avanzada" → "Continuar").';
    }
    return 'Este navegador no permite bloquear <kbd>Ctrl</kbd>+<kbd>W</kbd>: si lo apretás te va a pedir confirmación '
        + 'antes de cerrar. Con Chrome o Edge se bloquea del todo.';
}

export function savedName() {
    return localStorage.getItem('csweb:name') || `Jugador${Math.floor(Math.random() * 900 + 100)}`;
}

export function defaultTouch() {
    const saved = localStorage.getItem('csweb:touch');
    return saved === null ? !matchMedia('(hover: hover)').matches : saved === 'true';
}
