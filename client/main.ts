import './style.css';
import './keepalive';
import xashURL from 'xash3d-fwgs/xash.wasm?url';
import webgl2URL from 'xash3d-fwgs/libref_webgl2.wasm?url';
import filesystemURL from 'xash3d-fwgs/filesystem_stdio.wasm?url';
import valveExtrasURL from 'xash3d-fwgs/extras.pk3?url';
import clientURL from '@cs16/cl_dlls/client_emscripten_wasm32.wasm?url';
import menuURL from '@cs16/cl_dlls/menu_emscripten_wasm32.wasm?url';
import serverURL from '@cs16/dlls/cs_emscripten_wasm32.wasm?url';
import csExtrasURL from '@cs16/extras.pk3?url';
import { Xash3DWebRTC, SERVER_ADDRESS } from './net';
import { loadAssets } from './assets';

type Status = {
    hostname: string;
    map: string;
    maxPlayers: number;
    webPlayers: number;
    needsPassword: boolean;
    assets: { version: string; size: number; files: number; unpacked: number } | null;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const lobby = $('lobby');
const form = $<HTMLFormElement>('form');
const nameInput = $<HTMLInputElement>('name');
const passwordRow = $('password-row');
const passwordInput = $<HTMLInputElement>('password');
const touchInput = $<HTMLInputElement>('touch');
const playButton = $<HTMLButtonElement>('play');
const loading = $('loading');
const loadingText = $('loading-text');
const loadingDetail = $('loading-detail');
const bar = $('bar');
const errorBox = $('error');
const toast = $('toast');
const canvas = $<HTMLCanvasElement>('canvas');

let status: Status | null = null;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

function esc(s: string) {
    return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

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

function setLoading(text: string, detail = '', fraction?: number) {
    loadingText.textContent = text;
    loadingDetail.textContent = detail;
    if (fraction === undefined) {
        bar.classList.add('indeterminate');
    } else {
        bar.classList.remove('indeterminate');
        bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    }
}

let failed = false;

function showError(msg: string) {
    loading.hidden = true;
    lobby.hidden = false;
    playButton.disabled = false;
    if (failed) playButton.textContent = 'Reintentar';
    errorBox.hidden = false;
    errorBox.innerHTML = esc(msg).replace(/\n/g, '<br>');
}

function showToast(msg: string, ms = 4000) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout((showToast as unknown as { t?: number }).t);
    (showToast as unknown as { t?: number }).t = window.setTimeout(() => toast.classList.remove('show'), ms);
}

function quoteCvar(s: string) {
    return `"${s.replace(/["\\;\n\r]/g, '')}"`;
}

async function start(name: string, password: string, touch: boolean) {
    if (!status?.assets) throw new Error('El servidor no tiene el paquete de archivos del juego. Ejecutá "npm run setup" en la PC del servidor.');
    const assets = status.assets;

    setLoading('Conectando con el servidor…');
    const x = new Xash3DWebRTC({
        canvas,
        arguments: ['-windowed', '-game', 'cstrike'],
        libraries: {
            filesystem: filesystemURL,
            xash: xashURL,
            menu: menuURL,
            server: serverURL,
            client: clientURL,
            render: { gl4es: webgl2URL },
        },
        dynamicLibraries: ['dlls/cs_emscripten_wasm32.wasm', '/rodir/filesystem_stdio.wasm'],
        filesMap: {
            'dlls/cs_emscripten_wasm32.wasm': serverURL,
            '/rodir/filesystem_stdio.wasm': filesystemURL,
        },
        module: {
            print: (s: string) => console.log(s),
            printErr: (s: string) => console.warn(s),
        } as never,
    });
    (window as unknown as { xash: Xash3DWebRTC }).xash = x;
    x.onTransportState = (state) => {
        if (state === 'lost') showToast('Se perdió la conexión con el servidor. Reintentando…', 8000);
        if (state === 'connected' && x.running) showToast('Reconectado');
    };

    await x.connectTransport();

    setLoading('Cargando el motor…');
    const [valveExtras, csExtras] = await Promise.all([
        fetch(valveExtrasURL).then(r => r.arrayBuffer()),
        fetch(csExtrasURL).then(r => r.arrayBuffer()),
        x.init(),
    ]);
    const FS = x.em!.FS;

    const dirs = new Set<string>();
    let files = 0;
    let bytes = 0;
    const sink = (name: string, data: Uint8Array) => {
        const path = `/rodir/${name}`;
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (!dirs.has(dir)) {
            FS.mkdirTree(dir, 0o777);
            dirs.add(dir);
        }
        FS.writeFile(path, data, { canOwn: true });
        files++;
        bytes += data.length;
    };

    const t0 = performance.now();
    await loadAssets('/game/valve.zip', assets.version, assets.size, sink, (phase, done, total) => {
        const pct = done / total;
        const unpacked = `${files} de ${assets.files} archivos`;
        if (phase === 'cache') {
            setLoading('Cargando archivos guardados…', unpacked, pct);
        } else {
            setLoading('Descargando archivos del juego…', `${mb(done)} de ${mb(total)} · ${unpacked}`, pct);
        }
    });
    console.log(`Assets: ${files} archivos, ${mb(bytes)} en ${((performance.now() - t0) / 1000).toFixed(1)} s`);

    FS.mkdirTree('/rodir/valve', 0o777);
    FS.writeFile('/rodir/valve/extras.pk3', new Uint8Array(valveExtras), { canOwn: true });
    FS.writeFile('/rodir/cstrike/extras.pk3', new Uint8Array(csExtras), { canOwn: true });
    FS.chdir('/rodir');

    setLoading('Iniciando…');
    loading.hidden = true;
    lobby.hidden = true;
    document.body.classList.add('playing');

    x.main();
    x.Cmd_ExecuteString('_vgui_menus 0');
    x.Cmd_ExecuteString(`touch_enable ${touch ? 1 : 0}`);
    x.Cmd_ExecuteString(`name ${quoteCvar(name)}`);
    x.Cmd_ExecuteString(`password ${quoteCvar(password)}`);
    x.Cmd_ExecuteString('rate 100000');
    x.Cmd_ExecuteString('cl_cmdrate 100');
    x.Cmd_ExecuteString('cl_updaterate 100');
    x.Cmd_ExecuteString(`connect ${SERVER_ADDRESS}`);

    showToast('Hacé click en el juego para capturar el mouse · ESC lo libera · ` abre la consola', 7000);
    canvas.focus();

    window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
    });
}

// ---- lobby ----
const savedName = localStorage.getItem('csweb:name');
nameInput.value = savedName || `Jugador${Math.floor(Math.random() * 900 + 100)}`;
const savedTouch = localStorage.getItem('csweb:touch');
touchInput.checked = savedTouch === null ? !matchMedia('(hover: hover)').matches : savedTouch === 'true';

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
    errorBox.hidden = true;
    playButton.disabled = true;
    lobby.hidden = true;
    loading.hidden = false;
    clearInterval(statusTimer);
    start(name, passwordInput.value, touchInput.checked).catch((err: Error) => {
        console.error(err);
        if (document.body.classList.contains('playing')) {
            showToast(`Error: ${err.message}`, 10000);
            return;
        }
        failed = true;
        showError(err.message);
    });
});
