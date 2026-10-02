// Parche del menú de CS16Client (vendor/.../menu_emscripten_wasm32.wasm).
//
// El menú y el cliente (client_emscripten_wasm32.wasm) definen los dos una variable global
// `gpGlobals`. En Emscripten todos los módulos comparten una sola tabla de símbolos (GOT), así que
// los dos terminaban usando la misma: cuando el cliente la apuntaba a su globalvars_t de predicción
// de armas (casi todo en cero), el menú leía un ancho de pantalla 0. Al cambiar el tamaño de la
// ventana (por ejemplo al salir de pantalla completa) el menú recalculaba su escala con eso, sus
// fuentes quedaban con altura 0 y el primer texto de ayuda que dibujaba dividía por cero
// ("integer divide by zero" / "remainder by zero"): el juego se congelaba con el sonido en loop.
//
// El parche renombra el símbolo del menú a `uiGlobals` (mismo largo: sólo cambian los bytes del
// nombre en la importación GOT.mem y en la exportación), así cada módulo usa su propia variable.
//
// Uso: node scripts/patch-menu-wasm.mjs (idempotente)
import fs from 'node:fs';
import path from 'node:path';
import { VENDOR } from './lib/config.mjs';

const FILE = path.join(VENDOR, 'cs16-client', 'cstrike', 'cl_dlls', 'menu_emscripten_wasm32.wasm');
const FROM = 'gpGlobals';
const TO = 'uiGlobals';

const buf = fs.readFileSync(FILE);
let pos = 8;
const leb = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
        byte = buf[pos++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
    } while (byte & 0x80);
    return value;
};
const name = () => {
    const len = leb();
    const at = pos;
    pos += len;
    return { at, text: buf.toString('latin1', at, pos) };
};

const found = { [FROM]: [], [TO]: [] };
while (pos < buf.length) {
    const id = buf[pos++];
    const size = leb();
    const end = pos + size;
    if (id === 2) { // importaciones
        for (let n = leb(); n > 0; n--) {
            const mod = name().text;
            const field = name();
            const kind = buf[pos++];
            if (kind === 0) leb();
            else if (kind === 1) { pos++; if (buf[pos++] & 1) { leb(); leb(); } else leb(); }
            else if (kind === 2) { if (buf[pos++] & 1) { leb(); leb(); } else leb(); }
            else if (kind === 3) pos += 2;
            if (mod === 'GOT.mem' && field.text in found) found[field.text].push(field.at);
        }
    } else if (id === 7) { // exportaciones
        for (let n = leb(); n > 0; n--) {
            const field = name();
            const kind = buf[pos++];
            leb();
            if (kind === 3 && field.text in found) found[field.text].push(field.at);
        }
    }
    pos = end;
}

if (found[TO].length === 2 && found[FROM].length === 0) {
    console.log(`${path.basename(FILE)}: ya parcheado`);
} else if (found[FROM].length === 2 && found[TO].length === 0) {
    for (const at of found[FROM]) buf.write(TO, at, 'latin1');
    fs.writeFileSync(FILE, buf);
    console.log(`${path.basename(FILE)}: ${FROM} → ${TO} (importación GOT.mem y exportación)`);
} else {
    console.error(`${path.basename(FILE)}: no se reconoce el archivo (${FROM}: ${found[FROM].length}, ${TO}: ${found[TO].length})`);
    process.exit(1);
}
