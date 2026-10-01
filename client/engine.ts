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
