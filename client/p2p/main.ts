// Página para GitHub Pages: crear una partida (el servidor corre en la pestaña del anfitrión)
// o unirse a una con un link/código. Los archivos del juego los aporta el anfitrión desde su
// instalación local y se los pasa directo a cada invitado por WebRTC.
import '../style.css';
import '../keepalive';
import { SERVER_ADDRESS, createFsSink, engineOptions, fetchExtras, mountExtras, playerCommands, quoteCvar, startEngine } from '../engine';
import { $, allowUnload, defaultTouch, enterGame, esc, isPlaying, lockHintHtml, mb, savedName, setLoading, setupGameGuards, showToast } from '../ui';
import { Xash3DP2P } from './p2pnet';
import { buildPack, mapsOf, packVersion, readPack, selectGameFiles, type SourceFile } from './packformat';
import { PackWriter, getMeta, getPackBlob, persistStorage, writeStream, type PackMeta } from './store';
import { GuestRoom, HostRoom, newRoomCode, normalizeCode, selfId, type GameInfo } from './room';
import { giveUpAfter, planMigration, saveMigration, takeMigration, takeoverDelay, type Migration } from './migration';
import { checkNetwork, diag, hasAutoRelay, loadTurn, prepareIce, releaseMic, saveTurn, unlockLocalAddresses, type TurnSettings } from './netdiag';

const canvas = $<HTMLCanvasElement>('canvas');
const lobby = $('lobby');
const nameInput = $<HTMLInputElement>('name');
const touchInput = $<HTMLInputElement>('touch');
const fullscreenInput = $<HTMLInputElement>('fullscreen');
const betterNetInput = $<HTMLInputElement>('better-net');
const errorBox = $('error');

const guards = setupGameGuards(canvas, fullscreenInput);
nameInput.value = savedName();
touchInput.checked = defaultTouch();
betterNetInput.checked = localStorage.getItem('csweb:betterNet') !== 'false';
betterNetInput.addEventListener('change', () => localStorage.setItem('csweb:betterNet', String(betterNetInput.checked)));
const lockHint = lockHintHtml(guards.lockSupport);
$('lock-hint').hidden = !lockHint;
$('lock-hint').innerHTML = lockHint;

let meta: PackMeta | null = null;
// Credenciales de relay (TURN): se piden apenas abre la página y se esperan antes de crear/unir una sala
const iceReady = prepareIce();

// Línea informativa con el tipo de red y si hay relay disponible
function showNetCheck() {
    const el = $('net-check');
    Promise.all([checkNetwork(), iceReady]).then(([net]) => {
        const relay = hasAutoRelay() ? 'relay automático disponible' : 'sin relay automático';
        el.textContent = `Tu red: ${net.summary} · ${relay}`;
        el.hidden = false;
    }).catch(() => undefined);
}

function showError(msg: string) {
    $('loading').hidden = true;
    lobby.hidden = false;
    errorBox.hidden = false;
    errorBox.innerHTML = esc(msg).replace(/\n/g, '<br>');
    $('diag').hidden = false;
    $('diag-text').textContent = diag.text();
}

function clearError() {
    errorBox.hidden = true;
    $('diag').hidden = true;
}

$('diag-copy').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(diag.text());
        showToast('Diagnóstico copiado');
    } catch {
        showToast('No se pudo copiar: seleccioná el texto a mano');
    }
});

function playerSettings() {
    const name = nameInput.value.trim() || 'Jugador';
    localStorage.setItem('csweb:name', name);
    localStorage.setItem('csweb:touch', String(touchInput.checked));
    return { name, touch: touchInput.checked };
}

function fail(err: unknown) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    diag.log(`error: ${msg}`);
    if (isPlaying()) showToast(`Error: ${msg}`, 10000);
    else showError(msg);
}

// Pedir el micrófono hace que el navegador use IPs locales reales (ver netdiag.ts)
async function prepareNetwork() {
    if (betterNetInput.checked) await unlockLocalAddresses();
}

// Cuenta bytes a medida que pasan (para la barra de progreso)
function counting(stream: ReadableStream<Uint8Array>, onBytes: (n: number) => void) {
    let n = 0;
    return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            n += chunk.length;
            onBytes(n);
            controller.enqueue(chunk);
        },
    }));
}

// Inicializa el motor y le carga los archivos del juego guardados
async function loadEngine(x: Xash3DP2P, pack: PackMeta) {
    setLoading('Cargando el motor…');
    const [extras] = await Promise.all([fetchExtras(), x.init()]);
    const FS = x.em!.FS;
    const { sink, stats } = createFsSink(FS);
    const blob = await getPackBlob(pack);
    let last = 0;
    await readPack(counting(blob.stream(), (n) => {
        const now = performance.now();
        if (now - last < 100) return;
        last = now;
        setLoading('Preparando archivos del juego…', `${stats.files} de ${pack.files} archivos`, n / blob.size);
    }), sink);
    mountExtras(FS, extras);
}

// ------------------------------------------------------------------ crear partida

function renderFiles() {
    const status = $('files-status');
    const mapSelect = $<HTMLSelectElement>('map');
    const hostBtn = $<HTMLButtonElement>('host-btn');
    if (!meta) {
        status.textContent = 'no cargados';
        status.classList.remove('ok');
        hostBtn.disabled = true;
        mapSelect.innerHTML = '<option>de_dust2</option>';
        return;
    }
    status.textContent = `listos · ${meta.files} archivos · ${mb(meta.size)}`;
    status.classList.add('ok');
    hostBtn.disabled = false;
    const saved = localStorage.getItem('csweb:map') || 'de_dust2';
    const maps = meta.maps.length ? meta.maps : ['de_dust2'];
    mapSelect.innerHTML = maps.map(m => `<option${m === saved ? ' selected' : ''}>${esc(m)}</option>`).join('');
}

async function loadFolder(fileList: FileList) {
    clearError();
    const files: SourceFile[] = [...fileList].map(f => ({
        relPath: (f as File & { webkitRelativePath: string }).webkitRelativePath || f.name,
        file: f,
        mtime: f.lastModified,
    }));
    const entries = selectGameFiles(files);
    if (!entries?.length) {
        throw new Error('En esa carpeta no encontré las carpetas valve y cstrike de Counter-Strike 1.6. '
            + 'Elegí la carpeta Half-Life (steamapps\\common\\Half-Life).');
    }
    const version = await packVersion(entries);
    if (meta?.version === version) {
        showToast('Esos archivos ya estaban cargados');
        return;
    }
    lobby.hidden = true;
    const totalBytes = entries.reduce((s, e) => s + e.size, 0);
    let read = { files: 0, bytes: 0 };
    const stream = buildPack(entries, (f, _tf, b) => { read = { files: f, bytes: b }; });
    const writer = await writeStream(version, stream, () => {
        setLoading('Leyendo tus archivos del juego…', `${read.files} de ${entries.length} archivos`, read.bytes / totalBytes);
    });
    setLoading('Guardando…');
    meta = await writer.finish({ files: entries.length, unpacked: totalBytes, maps: mapsOf(entries) });
    await persistStorage();
    $('loading').hidden = true;
    lobby.hidden = false;
    renderFiles();
    showToast('Archivos del juego listos');
}

function readTurnInputs(): TurnSettings | null {
    const url = $<HTMLInputElement>('turn-url').value.trim();
    if (!url) return null;
    return { url, username: $<HTMLInputElement>('turn-user').value.trim(), credential: $<HTMLInputElement>('turn-pass').value };
}

type HostOptions = {
    pack: PackMeta;
    name: string;
    touch: boolean;
    map: string;
    maxPlayers: number;
    hostname: string;
    turn: TurnSettings | null;
    code: string;
    epoch: number;
};

async function hostGame() {
    if (!meta) return;
    const { name, touch } = playerSettings();
    const map = $<HTMLSelectElement>('map').value;
    const maxPlayers = Number($<HTMLSelectElement>('max-players').value);
    const hostname = $<HTMLInputElement>('hostname').value.trim() || 'CS 1.6';
    const turn = readTurnInputs();
    localStorage.setItem('csweb:map', map);
    localStorage.setItem('csweb:maxPlayers', String(maxPlayers));
    localStorage.setItem('csweb:hostname', hostname);
    saveTurn(turn);
    await runHost({ pack: meta, name, touch, map, maxPlayers, hostname, turn, code: newRoomCode(), epoch: 1 });
}

// Levanta el servidor en esta pestaña y abre la sala. También lo usa la migración de anfitrión
// (misma sala, epoch más alto).
async function runHost({ pack, name, touch, map, maxPlayers, hostname, turn, code, epoch }: HostOptions) {
    clearError();
    lobby.hidden = true;
    setLoading('Preparando la conexión…');
    // el micrófono queda abierto mientras dura la partida: cada invitado nuevo usa una conexión nueva
    await prepareNetwork();
    await iceReady;

    const x = new Xash3DP2P(engineOptions(canvas), true);
    (window as unknown as { xash: Xash3DP2P }).xash = x;
    await loadEngine(x, pack);

    setLoading('Iniciando el motor…');
    await startEngine(x);
    enterGame(canvas);
    playerCommands(x, { name, touch });
    for (const cmd of [
        'sv_lan 1',
        `hostname ${quoteCvar(hostname)}`,
        `maxplayers ${maxPlayers}`,
        'mp_timelimit 30', 'mp_roundtime 2.5', 'mp_freezetime 3', 'mp_buytime 0.75',
        'mp_autoteambalance 1', 'mp_friendlyfire 0', 'sv_timeout 120', 'sv_allowdownload 0',
        `map ${map}`,
    ]) x.Cmd_ExecuteString(cmd);

    const link = `${location.origin}${location.pathname}#${code}`;
    const info = (): Omit<GameInfo, 'epoch' | 'roster'> => ({
        host: name,
        hostname,
        map,
        maxPlayers,
        players: 1 + x.remotePlayers,
        pack: { version: pack.version, size: pack.size, files: pack.files, unpacked: pack.unpacked, maps: pack.maps },
    });
    const transfers = new Map<string, number>();
    diag.log(`partida creada, código ${code}, epoch ${epoch}${turn ? ' (con TURN)' : ''}`);
    new HostRoom(code, {
        info,
        pack: () => getPackBlob(pack),
        onPlayer: (id, channel) => x.addPeer(id, channel),
        onLeave: (id) => x.removePeer(id),
        onTransfer: (id, sent, total) => {
            const pct = Math.floor(sent * 10 / total);
            if (transfers.get(id) === pct) return;
            transfers.set(id, pct);
            if (sent >= total) showToast('Un jugador terminó de recibir los archivos y está entrando');
        },
        // otro jugador ya tomó la partida (el grupo migró mientras este anfitrión seguía vivo)
        onSuperseded: (winnerEpoch) => {
            showToast('Otro jugador tomó la partida: te reconectás a él…', 8000);
            rejoinAsGuest(code, winnerEpoch);
        },
    }, turn, epoch);

    $('invite-link').textContent = link;
    $('invite-copy').onclick = async () => {
        try {
            await navigator.clipboard.writeText(link);
            showToast('Link copiado: pasáselo a tus compañeros');
        } catch {
            showToast(link, 10000);
        }
    };
    const refreshInvite = () => {
        const n = info().players;
        $('invite-players').textContent = `${n} jugador${n === 1 ? '' : 'es'} · código ${code}`;
        $('invite').hidden = Boolean(document.pointerLockElement);
    };
    document.addEventListener('pointerlockchange', refreshInvite);
    setInterval(refreshInvite, 2000);
    refreshInvite();
    showToast(epoch > 1
        ? 'Tomaste la partida: el anfitrión anterior se desconectó. Los demás se reconectan solos.'
        : `Partida creada. Invitá con el link (código ${code}). Si cerrás esta pestaña, otro jugador toma la partida (se reinicia la ronda).`, 9000);
}

function showHome() {
    $('home-view').hidden = false;
    const maxSelect = $<HTMLSelectElement>('max-players');
    const savedMax = Number(localStorage.getItem('csweb:maxPlayers') || 10);
    maxSelect.innerHTML = Array.from({ length: 15 }, (_, i) => i + 2)
        .map(n => `<option value="${n}"${n === savedMax ? ' selected' : ''}>${n}</option>`).join('');
    const savedHostname = localStorage.getItem('csweb:hostname');
    if (savedHostname) $<HTMLInputElement>('hostname').value = savedHostname;
    const turn = loadTurn();
    if (turn) {
        $<HTMLInputElement>('turn-url').value = turn.url;
        $<HTMLInputElement>('turn-user').value = turn.username;
        $<HTMLInputElement>('turn-pass').value = turn.credential;
        ($('turn-url').closest('details') as HTMLDetailsElement).open = true;
    }
    renderFiles();

    const folder = $<HTMLInputElement>('folder');
    folder.addEventListener('change', () => {
        if (!folder.files?.length) return;
        loadFolder(folder.files).catch(fail).finally(() => { folder.value = ''; });
    });
    $('host-btn').addEventListener('click', () => {
        guards.requestFullscreen();
        hostGame().catch(fail);
    });
    $<HTMLFormElement>('code-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const code = normalizeCode($<HTMLInputElement>('code').value);
        if (code) location.hash = code;
    });
}

// ------------------------------------------------------------------ unirse

function showJoin(code: string, migration: Migration | null = null) {
    $('join-view').hidden = false;
    $('join-code').textContent = code;
    const guest = new GuestRoom(code, loadTurn(), migration
        ? { minEpoch: migration.lostEpoch, exclude: migration.excludePeer ? [migration.excludePeer] : [] }
        : {});
    const hint = $('join-hint');
    const searching = setTimeout(() => {
        if (!guest.info) {
            hint.textContent = 'Todavía no aparece el anfitrión. Tocá "Unirse" igual: se vuelve a intentar con la conexión mejorada.';
        }
    }, 15000);
    guest.onInfo = (info) => {
        clearTimeout(searching);
        $('host-online').classList.add('on');
        $('join-hostname').textContent = `${info.hostname} (anfitrión: ${info.host})`;
        $('join-map').textContent = info.map;
        $('join-players').textContent = `${info.players} / ${info.maxPlayers}`;
        const cached = meta?.version === info.pack.version;
        hint.textContent = cached
            ? 'Ya tenés los archivos del juego guardados: entrás al toque.'
            : `La primera vez se reciben ~${mb(info.pack.size)} de archivos del juego desde el anfitrión.`;
    };
    guest.onHostLeft = () => {
        $('host-online').classList.remove('on');
        hint.textContent = 'El anfitrión se desconectó.';
    };

    const btn = $<HTMLButtonElement>('join-btn');
    const join = (waitMs?: number) => {
        btn.disabled = true;
        return joinGame(guest, waitMs).catch((e) => {
            btn.disabled = false;
            fail(e);
        });
    };
    btn.addEventListener('click', () => {
        guards.requestFullscreen();
        join();
    });
    $('go-home').addEventListener('click', (e) => {
        e.preventDefault();
        history.replaceState(null, '', location.pathname);
        location.reload();
    });
    if (migration) resumeMigration(guest, migration, join).catch(fail);
}

// ------------------------------------------------------------------ migración de anfitrión

// Recarga la página dentro de la misma sala; el estado de la migración viaja en sessionStorage
function reloadInto(code: string) {
    history.replaceState(null, '', `${location.pathname}${location.search}#${code}`);
    allowUnload();
    setTimeout(() => location.reload(), 600);
}

let migrating = false;

// Se perdió al anfitrión en plena partida: se elige al sucesor y todos recargan la página
function beginMigration(guest: GuestRoom) {
    if (migrating || !guest.info) return;
    const plan = planMigration(guest.code, guest.info, guest.hostPeerId, selfId);
    if (!plan.candidates) {
        diag.log('migración imposible: ningún jugador puede tomar la partida');
        showToast('El anfitrión se desconectó y ningún otro jugador puede tomar la partida', 20000);
        return;
    }
    migrating = true;
    diag.log(`migrando la partida (epoch ${plan.lostEpoch}, lugar ${plan.slot} de ${plan.candidates})`);
    setLoading('El anfitrión se desconectó', 'Migrando la partida a otro jugador…');
    saveMigration(plan);
    reloadInto(plan.code);
}

// Otro anfitrión con más prioridad apareció mientras este seguía vivo: pasa a ser un jugador más
function rejoinAsGuest(code: string, winnerEpoch: number) {
    if (migrating) return;
    migrating = true;
    saveMigration({
        code,
        lostEpoch: winnerEpoch,
        excludePeer: null,
        slot: -1,
        candidates: 0,
        settings: { map: '', maxPlayers: 0, hostname: '' },
        at: Date.now(),
    });
    setLoading('Reconectando', 'Otro jugador tomó la partida…');
    reloadInto(code);
}

// Página recién recargada por una migración: el sucesor levanta el servidor si nadie lo hizo
// antes de su turno; los demás se unen solos al anfitrión nuevo.
async function resumeMigration(guest: GuestRoom, m: Migration, join: (waitMs?: number) => Promise<void>) {
    lobby.hidden = true;
    setLoading('Recuperando la partida…', 'Esperando al nuevo anfitrión');
    const delay = takeoverDelay(m.slot);
    if (delay !== null && meta) {
        try {
            await guest.waitHost(delay);
        } catch {
            diag.log(`nadie tomó la partida: este jugador pasa a ser el anfitrión (epoch ${m.lostEpoch + 1})`);
            await guest.leave();
            const { name, touch } = playerSettings();
            await runHost({ pack: meta, name, touch, ...m.settings, turn: loadTurn(), code: m.code, epoch: m.lostEpoch + 1 });
            return;
        }
    }
    await join(giveUpAfter(m.candidates));
}

async function joinGame(guest: GuestRoom, waitMs = 30000) {
    const { name, touch } = playerSettings();
    clearError();
    lobby.hidden = true;
    setLoading('Preparando la conexión…');
    await prepareNetwork();
    // si todavía no apareció el anfitrión, se vuelve a buscar ahora que (quizás) hay IPs reales
    await guest.rejoin();
    setLoading('Buscando la partida…');
    guest.onHostLost = () => {
        if (isPlaying()) beginMigration(guest);
    };
    const info = await guest.waitHost(waitMs);
    setLoading('Conectando con el anfitrión…');
    const how = await guest.connect(30000);
    showToast(`Conectado con el anfitrión (${how})`, 5000);

    if (meta?.version !== info.pack.version) {
        if (how.includes('TURN')) {
            showToast(`Conexión por relay: la primera descarga (~${mb(info.pack.size)}) usa el cupo compartido y puede tardar más`, 9000);
        }
        const writer = new PackWriter(info.pack.version);
        const t0 = performance.now();
        let last = 0;
        setLoading('Recibiendo archivos del juego del anfitrión…', '', 0);
        await guest.download(info.pack.size, async (chunk, received) => {
            writer.push(chunk);
            await writer.drain();
            const now = performance.now();
            if (now - last < 200 && received < info.pack.size) return;
            last = now;
            const speed = received / 1048576 / Math.max(0.001, (now - t0) / 1000);
            setLoading('Recibiendo archivos del juego del anfitrión…',
                `${mb(received)} de ${mb(info.pack.size)} · ${speed.toFixed(1)} MB/s`, received / info.pack.size);
        });
        diag.log(`archivos recibidos en ${((performance.now() - t0) / 1000).toFixed(0)} s`);
        meta = await writer.finish({ files: info.pack.files, unpacked: info.pack.unpacked, maps: info.pack.maps });
        await persistStorage();
    }

    // con los archivos guardados este jugador puede tomar la partida si el anfitrión se cae
    // (no desde celulares ni con controles táctiles)
    guest.sendCaps({ name, canHost: !touch && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) });

    const x = new Xash3DP2P(engineOptions(canvas), false);
    (window as unknown as { xash: Xash3DP2P }).xash = x;
    x.setHostChannel(guest.game!);
    await loadEngine(x, meta);
    releaseMic();

    setLoading('Iniciando el motor…');
    await startEngine(x);
    enterGame(canvas);
    playerCommands(x, { name, touch });
    x.Cmd_ExecuteString(`connect ${SERVER_ADDRESS}`);
}

// ------------------------------------------------------------------ inicio

// Para pruebas / instalaciones sin carpeta: importar un paquete desde una URL
(window as unknown as { csweb: object }).csweb = {
    async importPack(url: string, info: Omit<PackMeta, 'size' | 'parts'>) {
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`No se pudo bajar ${url}`);
        const writer = await writeStream(info.version, res.body);
        meta = await writer.finish({ files: info.files, unpacked: info.unpacked, maps: info.maps });
        renderFiles();
        return meta;
    },
    diag: () => diag.text(),
};

async function init() {
    if (!('RTCPeerConnection' in window) || !('DecompressionStream' in window) || !('indexedDB' in window)) {
        showError('Este navegador no soporta lo necesario (WebRTC, IndexedDB, DecompressionStream). Usá Chrome, Edge o Firefox actualizados.');
        return;
    }
    meta = await getMeta();
    window.addEventListener('hashchange', () => location.reload());
    showNetCheck();
    const code = normalizeCode(decodeURIComponent(location.hash.slice(1)));
    if (code) {
        await iceReady; // la sala de Trystero necesita los servidores ICE desde el primer momento
        showJoin(code, takeMigration(code));
    } else showHome();
}

init().catch(fail);
