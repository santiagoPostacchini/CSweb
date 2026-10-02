// Página del modo LAN: la sirve el servidor Node (server/index.mjs) junto al servidor dedicado.
import './style.css';
import './keepalive';
import { Xash3DWebRTC } from './net';
import { loadAssets } from './assets';
import { SERVER_ADDRESS, createFsSink, engineOptions, fetchExtras, mountExtras, onEngineQuit, playerCommands, queueCommands, startEngine } from './engine';
import {
    $, allowUnload, bindFastRender, defaultTouch, enterGame, esc, isPlaying, lockHintHtml, mb, savedName, setLoading, setupGameGuards, showToast,
} from './ui';

type Status = {
    hostname: string;
    map: string;
    maxPlayers: number;
    webPlayers: number;
    needsPassword: boolean;
    assets: { version: string; size: number; files: number; unpacked: number } | null;
};

const lobby = $('lobby');
const form = $<HTMLFormElement>('form');
const nameInput = $<HTMLInputElement>('name');
const passwordRow = $('password-row');
const passwordInput = $<HTMLInputElement>('password');
const touchInput = $<HTMLInputElement>('touch');
const fullscreenInput = $<HTMLInputElement>('fullscreen');
const playButton = $<HTMLButtonElement>('play');
const errorBox = $('error');
const canvas = $<HTMLCanvasElement>('canvas');

let status: Status | null = null;

async function refreshStatus() {
    try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        status = await res.json() as Status;
        $('server-name').textContent = status.hostname;
        $('server-map').textContent = status.map;
        $('server-players').textContent = `${status.webPlayers} / ${status.maxPlayers}`;
        passwordRow.hidden = !status.needsPassword;
        if (status.assets) {
            $('download-hint').textContent =
                `La primera vez se descargan ~${mb(status.assets.size)} de archivos del juego; después quedan guardados en este navegador.`;
        }
        $('server-online').classList.add('on');
    } catch {
        $('server-online').classList.remove('on');
    }
}

let failed = false;

function showError(msg: string) {
    $('loading').hidden = true;
    lobby.hidden = false;
    playButton.disabled = false;
    if (failed) playButton.textContent = 'Reintentar';
    errorBox.hidden = false;
    errorBox.innerHTML = esc(msg).replace(/\n/g, '<br>');
}

async function start(name: string, password: string, touch: boolean) {
    if (!status?.assets) throw new Error('El servidor no tiene el paquete de archivos del juego. Ejecutá "npm run setup" en la PC del servidor.');
    const assets = status.assets;

    setLoading('Conectando con el servidor…');
    const x = new Xash3DWebRTC(engineOptions(canvas));
    (window as unknown as { xash: Xash3DWebRTC }).xash = x;
    x.onTransportState = (state) => {
        if (state === 'lost') showToast('Se perdió la conexión con el servidor. Reintentando…', 8000);
        if (state === 'connected' && x.running) showToast('Reconectado');
    };

    await x.connectTransport();

    setLoading('Cargando el motor…');
    const [extras] = await Promise.all([fetchExtras(), x.init()]);
    const FS = x.em!.FS;
    const { sink, stats } = createFsSink(FS);

    const t0 = performance.now();
    await loadAssets('/game/valve.zip', assets.version, assets.size, sink, (phase, done, total) => {
        const pct = done / total;
        const unpacked = `${stats.files} de ${assets.files} archivos`;
        if (phase === 'cache') {
            setLoading('Cargando archivos guardados…', unpacked, pct);
        } else {
            setLoading('Descargando archivos del juego…', `${mb(done)} de ${mb(total)} · ${unpacked}`, pct);
        }
    });
    console.log(`Assets: ${stats.files} archivos, ${mb(stats.bytes)} en ${((performance.now() - t0) / 1000).toFixed(1)} s`);

    mountExtras(FS, extras);
    setLoading('Iniciando el motor…');
    await startEngine(x);
    enterGame(canvas);
    queueCommands(x, [...playerCommands({ name, touch, password }), `connect ${SERVER_ADDRESS}`]);
}

// "Salir" del menú del juego: el motor ya no se apaga (ver engine.ts), la página confirma y recarga
onEngineQuit(() => {
    if (!confirm('¿Salir de la partida?')) return;
    allowUnload();
    location.reload();
});

// ---- lobby ----
const guards = setupGameGuards(canvas, fullscreenInput);
nameInput.value = savedName();
touchInput.checked = defaultTouch();
bindFastRender($<HTMLInputElement>('fast-render'));
const hint = lockHintHtml(guards.lockSupport);
$('lock-hint').hidden = !hint;
$('lock-hint').innerHTML = hint;

if (!('RTCPeerConnection' in window) || !('WebAssembly' in window)) {
    showError('Este navegador no soporta WebRTC/WebAssembly. Usá Chrome, Edge o Firefox actualizados.');
    playButton.disabled = true;
}

refreshStatus();
const statusTimer = setInterval(refreshStatus, 5000);

form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (failed) {
        location.reload();
        return;
    }
    const name = nameInput.value.trim() || 'Jugador';
    localStorage.setItem('csweb:name', name);
    localStorage.setItem('csweb:touch', String(touchInput.checked));
    guards.requestFullscreen();
    errorBox.hidden = true;
    playButton.disabled = true;
    lobby.hidden = true;
    clearInterval(statusTimer);
    start(name, passwordInput.value, touchInput.checked).catch((err: Error) => {
        console.error(err);
        if (isPlaying()) {
            showToast(`Error: ${err.message}`, 10000);
            return;
        }
        failed = true;
        showError(err.message);
    });
});
