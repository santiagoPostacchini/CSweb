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

// ---- estado del motor ----
// Una vez que el motor se apaga (quit, Sys_Error) no se le puede volver a hablar: su intérprete de
// comandos ya no existe y cualquier Cmd_ExecuteString termina en "Mem_FreeBlock ... double freed".
let engineAlive = false;
export const isEngineAlive = () => engineAlive;

function engineDied(reason: string) {
    const wasAlive = engineAlive;
    engineAlive = false;
    logEngine(`[página] motor detenido: ${reason}`);
    if (wasAlive) abortHandler?.(reason);
}

// En el navegador, "quit" apagaba el motor entero (pantalla negra/trabada). Se reemplaza con un
// alias que sólo imprime esta marca; la página la ve y pregunta si de verdad querés salir.
const QUIT_MARKER = 'csweb_pide_salir';
let quitHandler: (() => void) | null = null;
export function onEngineQuit(fn: () => void) {
    quitHandler = fn;
}

function watchEngineOutput(line: string) {
    // las líneas pueden venir con hora adelante: "[11:39:18] texto"
    const text = line.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').trim();
    if (text === QUIT_MARKER) {
        // fuera del frame del motor
        setTimeout(() => quitHandler?.(), 0);
    } else if (line.includes('Issuing host shutdown')) {
        engineDied(line.trim());
    }
}

// Los errores del motor llegan como alert("Xash Error ..."): se muestran en el panel de error
// (con diagnóstico) en vez de un cartel del navegador que traba la página.
const nativeAlert = window.alert.bind(window);
window.alert = (message?: unknown) => {
    const text = String(message ?? '');
    if (/^(Xash|Host) Error/.test(text)) {
        engineDied(text.replace(/\s+/g, ' ').trim());
        return;
    }
    nativeAlert(text);
};

// longjmp del motor que escapó hasta la página (Sys_Quit/Host_Error fuera del frame): estado dudoso
window.addEventListener('error', (e) => {
    if (e.error === Infinity) engineDied('salto interno del motor sin atrapar (Uncaught Infinity)');
});
window.addEventListener('unhandledrejection', (e) => {
    if (e.reason === Infinity) engineDied('salto interno del motor sin atrapar (Uncaught Infinity)');
});

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
            print: (s: string) => {
                logEngine(s);
                watchEngineOutput(s);
                console.log(s);
            },
            printErr: (s: string) => {
                logEngine(s);
                watchEngineOutput(s);
                console.warn(s);
            },
            onAbort: (what: unknown) => {
                const reason = String(what);
                logEngine(`ABORT: ${reason}`);
                engineDied(reason);
            },
            // Este build del motor no tiene Asyncify: si llama a emscripten_sleep (para esperar o no
            // gastar CPU), en vez de dormir aborta, y el juego queda congelado con el último sonido en
            // loop. Se reemplaza por una función que no hace nada: el ritmo de los frames ya lo pone el
            // navegador.
            instantiateWasm: (imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
                (imports.env as Record<string, unknown>).emscripten_sleep = () => undefined;
                logEngine('[página] emscripten_sleep reemplazado (no aborta)');
                WebAssembly.instantiateStreaming(fetch(xashURL), imports)
                    .catch(() => fetch(xashURL).then(r => r.arrayBuffer()).then(b => WebAssembly.instantiate(b, imports)))
                    .then(({ instance, module }) => receive(instance, module))
                    .catch((e) => {
                        logEngine(`no se pudo cargar el motor: ${(e as Error).message}`);
                        abortHandler?.(`no se pudo cargar el motor: ${(e as Error).message}`);
                    });
                return {};
            },
        } as never,
    };
}

// Últimas líneas de la consola del motor, para el diagnóstico si algo falla
const engineLines: string[] = [];
function logEngine(line: string) {
    engineLines.push(line);
    if (engineLines.length > 80) engineLines.shift();
}
export const engineLogTail = () => engineLines.join('\n');

// El motor se detuvo (abort): la página avisa en vez de quedar congelada
let abortHandler: ((reason: string) => void) | null = null;
export function onEngineAbort(fn: (reason: string) => void) {
    abortHandler = fn;
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
    engineAlive = true;
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

// Ejecuta comandos dentro del próximo frame del motor en vez de en el evento del navegador.
// Cmd_ExecuteString llamado desde JavaScript corre fuera del frame: si el comando produce un
// Host_Error, el longjmp no tiene adónde volver ("Uncaught Infinity") y el intérprete de comandos
// queda a medio camino (después: "Mem_FreeBlock: ... double freed (cmd.c)"). Con `exec`, el motor
// sólo lee el archivo y encola su contenido; los comandos corren en el frame, donde un error se
// maneja bien.
const QUEUE_FILE = '_web_cmd.cfg';
export function queueCommands(x: Xash3D, cmds: string[]) {
    if (!engineAlive) return;
    x.em!.FS.writeFile(`/rodir/cstrike/${QUEUE_FILE}`, `${cmds.join('\n')}\n`);
    x.Cmd_ExecuteString(`exec ${QUEUE_FILE}`);
}

// Cada tanto y al cerrar u ocultar la pestaña: el motor escribe su config.cfg y se guarda si cambió
function keepUserConfig(x: Xash3D) {
    const persist = () => {
        try {
            const text = new TextDecoder().decode(x.em!.FS.readFile(CONFIG_FILE));
            if (text && text !== localStorage.getItem(CONFIG_KEY)) localStorage.setItem(CONFIG_KEY, text);
        } catch { /* motor cerrándose o sin espacio: se intenta la próxima vez */ }
    };
    const save = () => {
        // con el motor apagado sólo se guarda lo último que escribió (al apagarse escribe la config)
        if (!engineAlive) {
            persist();
            return;
        }
        try {
            queueCommands(x, ['host_writeconfig']);
        } catch { /* motor cerrándose */ }
        // el comando corre en el próximo frame (keepalive.ts mueve el motor aunque la pestaña esté oculta)
        setTimeout(persist, 500);
    };
    setInterval(save, SAVE_CONFIG_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') save();
    });
    // al cerrar no hay próximo frame: se guarda lo último que el motor escribió
    window.addEventListener('pagehide', persist);
}

export function quoteCvar(s: string) {
    return `"${s.replace(/["\\;\n\r]/g, '')}"`;
}

// Ajustes del jugador que se aplican apenas arranca el motor (usar con queueCommands)
export function playerCommands({ name, touch, password = '' }: { name: string; touch: boolean; password?: string }) {
    return [
        `alias quit "echo ${QUIT_MARKER}"`,
        `alias exit "echo ${QUIT_MARKER}"`,
        '_vgui_menus 0',
        `touch_enable ${touch ? 1 : 0}`,
        `name ${quoteCvar(name)}`,
        `password ${quoteCvar(password)}`,
        'rate 100000',
        'cl_cmdrate 100',
        'cl_updaterate 100',
    ];
}
