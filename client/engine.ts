// Configuración común del motor: Xash3D-FWGS (wasm) + CS16Client (wasm).
// La usan el modo LAN (servidor Node) y el modo navegador (GitHub Pages).
import type { Xash3D, Xash3DOptions } from 'xash3d-fwgs';
import xashURL from 'xash3d-fwgs/xash.wasm?url';
import webgl2URL from 'xash3d-fwgs/libref_webgl2.wasm?url';
import filesystemURL from 'xash3d-fwgs/filesystem_stdio.wasm?url';
import valveExtrasURL from 'xash3d-fwgs/extras.pk3?url';
import clientURL from '@cs16/cl_dlls/client_emscripten_wasm32.wasm?url';
import menuURL from '@cs16/cl_dlls/menu_emscripten_wasm32.wasm?url';
import serverURL from '@cs16/dlls/cs_emscripten_wasm32.wasm?url';
import csExtrasURL from '@cs16/extras.pk3?url';

// Dirección ficticia del servidor dentro del motor de un cliente (todo lo que va ahí sale por WebRTC)
export const SERVER_ADDRESS = '127.0.0.1:8080';
export const SERVER_IP: [number, number, number, number] = [127, 0, 0, 1];
export const SERVER_PORT = 8080;

type FS = NonNullable<Xash3D['em']>['FS'];

export function engineOptions(canvas: HTMLCanvasElement): Xash3DOptions {
    return {
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
    };
}

// extras.pk3 del motor (fuentes TTF del menú, etc.) y de CS16Client (bots, menús táctiles...)
export function fetchExtras(): Promise<[ArrayBuffer, ArrayBuffer]> {
    return Promise.all([
        fetch(valveExtrasURL).then(r => r.arrayBuffer()),
        fetch(csExtrasURL).then(r => r.arrayBuffer()),
    ]);
}

// Escribe archivos del juego en el sistema de archivos en memoria del motor (/rodir)
export function createFsSink(fs: FS) {
    const dirs = new Set<string>();
    const stats = { files: 0, bytes: 0 };
    const sink = (name: string, data: Uint8Array) => {
        const path = `/rodir/${name}`;
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (!dirs.has(dir)) {
            fs.mkdirTree(dir, 0o777);
            dirs.add(dir);
        }
        fs.writeFile(path, data, { canOwn: true });
        stats.files++;
        stats.bytes += data.length;
    };
    return { sink, stats };
}

export function mountExtras(fs: FS, [valveExtras, csExtras]: [ArrayBuffer, ArrayBuffer]) {
    fs.mkdirTree('/rodir/valve', 0o777);
    fs.mkdirTree('/rodir/cstrike', 0o777);
    fs.writeFile('/rodir/valve/extras.pk3', new Uint8Array(valveExtras), { canOwn: true });
    fs.writeFile('/rodir/cstrike/extras.pk3', new Uint8Array(csExtras), { canOwn: true });
    fs.chdir('/rodir');
}

// Arranca el motor y espera a que termine de inicializarse.
// Las librerías del juego (servidor, cliente, menú, render) se descargan en segundo plano; si
// todavía no llegaron, emscripten posterga el arranque y cualquier comando enviado antes
// rompe el motor ("_Mem_Alloc: pool == NULL").
export async function startEngine(x: Xash3D, onWait?: () => void, timeoutMs = 120000) {
    restoreUserConfig(x.em!.FS);
    x.main();
    const mod = x.em!.Module as { calledRun?: boolean };
    const t0 = performance.now();
    while (!mod.calledRun) {
        if (performance.now() - t0 > timeoutMs) throw new Error('El motor no terminó de arrancar (¿se cortó la descarga de sus archivos?)');
        onWait?.();
        await new Promise(r => setTimeout(r, 50));
    }
    keepUserConfig(x);
}

// ---- configuración del jugador ----
// El motor guarda teclas, sensibilidad, hud_fastswitch, etc. en cstrike/config.cfg, dentro de su
// sistema de archivos en memoria: se pierde al recargar, y el que viene en el paquete es el de la
// instalación de quien lo armó (el anfitrión). Se guarda en el navegador y se repone al arrancar,
// así cada jugador conserva la suya; la del paquete sólo se usa la primera vez.
const CONFIG_FILE = '/rodir/cstrike/config.cfg';
const PROFILE = new URLSearchParams(location.search).get('perfil')?.replace(/[^a-z0-9_-]/gi, '');
const CONFIG_KEY = PROFILE ? `csweb:config:${PROFILE}` : 'csweb:config';
const SAVE_CONFIG_EVERY_MS = 30_000;

function restoreUserConfig(fs: FS) {
    try {
        const saved = localStorage.getItem(CONFIG_KEY);
        if (!saved) return;
        fs.mkdirTree('/rodir/cstrike', 0o777);
        fs.writeFile(CONFIG_FILE, saved);
    } catch (e) {
        console.warn('No se pudo reponer la configuración guardada', e);
    }
}

// Cada tanto y al cerrar u ocultar la pestaña: el motor escribe su config.cfg y se guarda si cambió
function keepUserConfig(x: Xash3D) {
    const save = () => {
        try {
            x.Cmd_ExecuteString('host_writeconfig');
            const text = new TextDecoder().decode(x.em!.FS.readFile(CONFIG_FILE));
            if (text && text !== localStorage.getItem(CONFIG_KEY)) localStorage.setItem(CONFIG_KEY, text);
        } catch { /* motor cerrándose o sin espacio: se intenta la próxima vez */ }
    };
    setInterval(save, SAVE_CONFIG_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') save();
    });
    window.addEventListener('pagehide', save);
}

export function quoteCvar(s: string) {
    return `"${s.replace(/["\\;\n\r]/g, '')}"`;
}

// Ajustes del jugador que se aplican apenas arranca el motor
export function playerCommands(x: Xash3D, { name, touch, password = '' }: { name: string; touch: boolean; password?: string }) {
    x.Cmd_ExecuteString('_vgui_menus 0');
    x.Cmd_ExecuteString(`touch_enable ${touch ? 1 : 0}`);
    x.Cmd_ExecuteString(`name ${quoteCvar(name)}`);
    x.Cmd_ExecuteString(`password ${quoteCvar(password)}`);
    x.Cmd_ExecuteString('rate 100000');
    x.Cmd_ExecuteString('cl_cmdrate 100');
    x.Cmd_ExecuteString('cl_updaterate 100');
}
