# Counter-Strike 1.6 en el navegador

Jugá CS 1.6 con tus compañeros desde el navegador, **sin instalar nada**. Hay dos formas:

| | **En el navegador** (GitHub Pages) | **Servidor dedicado LAN** (Node + Windows) |
|---|---|---|
| Dónde corre el servidor | En la pestaña del anfitrión | En una PC con `INICIAR-SERVIDOR.bat` |
| Qué instala el anfitrión | Nada (sólo tener CS 1.6 de Steam) | Node.js |
| Si el anfitrión cierra | Otro jugador toma la partida (se reinicia la ronda) | El servidor sigue (es dedicado) |
| Bots | No | Sí (YaPB) |

**De la instalación original sólo se usan los assets** (mapas, modelos, sonidos, texturas) y nunca se
publican: los aporta el anfitrión desde su PC. Ningún binario de Valve se ejecuta: el motor es
[Xash3D-FWGS](https://github.com/FWGS/xash3d-fwgs), la lógica del servidor es
[ReGameDLL_CS](https://github.com/rehlds/ReGameDLL_CS) y el cliente es [CS16Client](https://github.com/Velaron/cs16-client),
todos open source.

## En el navegador (GitHub Pages)

👉 **https://santiagopostacchini.github.io/CSweb/**

**Crear partida (anfitrión)**
1. Abrí la página y tocá **"Elegir carpeta Half-Life…"**: elegí la carpeta de tu instalación de Steam
   (normalmente `C:Program Files (x86)SteamsteamappscommonHalf-Life`). El navegador puede preguntar si querés
   "subir" los archivos: no se sube nada a internet, sólo se leen en tu navegador (~20 s) y quedan guardados para la próxima.
2. Elegí mapa y cantidad de jugadores → **Crear partida**.
3. Arriba aparece el **link para invitar** (y un código). Pasáselo a tus compañeros.
   El servidor corre en tu pestaña: dejala abierta (y al frente) mientras juegan. Si la cerrás, otro jugador toma la partida.

**Unirse (invitados)**
1. Abrí el link (o poné el código en la página) → **Unirse**.
2. La primera vez se reciben ~240 MB de archivos del juego **entre todos los jugadores que ya los tienen** (el anfitrión y
   los invitados anteriores; cada trozo se verifica con su hash, y si el enjambre no está disponible se baja directo del
   anfitrión). Unos 20-60 s en la misma red;
   después quedan guardados en el navegador. Quien ya recibió los archivos también puede crear partidas.

Cómo funciona por dentro:

```
 Anfitrión (pestaña)                                    Invitado (pestaña)
┌──────────────────────────────┐   señalización   ┌──────────────────────────────┐
│ Xash3D wasm + ReGameDLL wasm │ ◀── relays ────▶ │ Xash3D wasm (sólo cliente)   │
│  listen server + jugador     │   Nostr (Trystero)│                              │
│                              │                  │                              │
│ DataChannel "cs-game" (UDP) ◀┼──── WebRTC ─────▶┼ juego                        │
│ DataChannel "cs-files"      ─┼──── directo ────▶┼ archivos del juego (1 vez)   │
└──────────────────────────────┘                  └──────────────────────────────┘
```

- Los relays públicos sólo se usan para que los navegadores se encuentren y se pasen la señalización; después
  el anfitrión abre una conexión WebRTC propia con cada invitado y el juego y los archivos van directo entre PCs.

**Problemas de conexión**
- Dejá marcada **"Mejorar la conexión en la red local"**: pide permiso de micrófono porque, con ese permiso, el navegador
  usa la IP local real en vez de un nombre `.local` (mDNS) que muchas redes corporativas y hotspots no dejan resolver.
  Conviene que lo acepten anfitrión e invitados. (El micrófono también sirve para el chat de voz del juego.)
- **Redes distintas** (otra oficina, datos móviles, entre un hotspot y la red de la empresa): cuando la conexión directa
  no es posible el tráfico pasa por un servidor **TURN** automático (Cloudflare, gratis). Quien publica la página tiene que
  desplegar una vez el Worker de `worker/` (ver [worker/README.md](worker/README.md)); los jugadores no configuran nada.
  La página muestra arriba "Tu red: …" con el tipo de NAT y si hay relay disponible. `?relay=1` en la URL fuerza el uso
  del relay (para probarlo). Si preferís tu propio TURN, *Crear partida → Opciones de red (avanzado)* sigue funcionando.
- **Si el anfitrión se desconecta, la partida sigue**: los jugadores que ya tienen los archivos guardados (y no están en
  celular) pueden tomar el servidor. El que entró primero lo levanta solo en la misma sala y los demás se reconectan solos
  (unos 5-10 s). Se reinicia la ronda y el marcador, no el grupo ni el mapa inicial. Se vuelve a pedir un click para
  capturar el mouse (y volver a pantalla completa).
- Si algo falla aparece **"Diagnóstico de conexión"** con el detalle de cada paso (candidatos ICE, tipo de camino, etc.):
  tocá *Copiar diagnóstico* y mandalo.
- Si la red directamente no deja conectar equipos entre sí (Wi-Fi con aislamiento de clientes), usá el servidor dedicado LAN.
- `?perfil=nombre` en la URL usa otro espacio de almacenamiento (sirve para probar anfitrión e invitado en la misma PC).

Para desarrollar: `npm run dev:pages` (o `npm run build:pages` → `dist-pages/`). Cada push a `main` publica la página
con GitHub Actions (`.github/workflows/pages.yml`).

## Servidor dedicado LAN

Una PC levanta un **servidor dedicado de CS 1.6** y una página web; los demás abren un link.

```
 Navegador del jugador                      PC anfitrión (Windows)
┌──────────────────────────┐   HTTP :27016  ┌───────────────────────────────────────────────┐
│ Xash3D-FWGS (WebAssembly)│ ─────────────▶ │ Node.js  server/index.mjs                     │
│ + CS16Client (wasm)      │   página +     │  ├─ web estática + valve.zip (tus assets)     │
│                          │   señalización │  ├─ señalización WebRTC (WebSocket /signal)   │
│ red del motor ──────────────── WebRTC ───▶│  └─ puente DataChannel ⇄ UDP 127.0.x.y        │
│ (DataChannel tipo UDP)   │   UDP :27018   │              │                                │
└──────────────────────────┘                │              ▼ UDP 127.0.0.1:27015            │
                                            │  xash3d.exe -dedicated (Xash3D-FWGS nativo)   │
                                            │   └─ YaPB (bots) → ReGameDLL_CS (lógica CS)   │
                                            └───────────────────────────────────────────────┘
```

### Inicio rápido

1. Tener **Node.js 20+** y **Counter-Strike 1.6 instalado por Steam** en la PC anfitrión
   (se detecta solo; también sirve copiar la carpeta `Half-Life` a `steamapps/Half-Life` dentro del proyecto).
2. Doble click en **`INICIAR-SERVIDOR.bat`**.
   La primera vez instala dependencias, prepara el servidor y empaqueta los assets (~30 s).
3. La consola muestra el link para compartir, por ejemplo `https://10.3.3.3:27016`.
   Pasáselo a tus compañeros (tienen que estar en **la misma red**).
   La primera vez el navegador avisa que el certificado no es de confianza (es autofirmado):
   **"Configuración avanzada" → "Continuar a 10.3.3.3"**. También anda por `http://` sin ese aviso,
   pero entonces el navegador no deja bloquear Ctrl+W (ver abajo).
4. Si Windows pregunta por el firewall al iniciar, **permitir** el acceso. Si no aparece el aviso
   o tus compañeros no pueden conectarse, ejecutá **`ABRIR-FIREWALL.bat`** (pide permisos de administrador).

Para jugar vos también desde la misma PC, abrí `http://localhost:27016`.

### Desde otra PC

- **Para jugar** no hace falta nada: sólo el link.
- **Para ser anfitrión desde otra PC**: instalá Node.js y CS 1.6 (Steam) y cloná el repo:

```bash
git clone https://github.com/santiagoPostacchini/CSweb.git
```

  Después doble click en `INICIAR-SERVIDOR.bat`. Los archivos de Valve no están en el repo (ni deben estarlo):
  se toman de la instalación de Steam de esa PC.

Sin el `.bat`:

```bash
npm install
```
```bash
npm run setup
```
```bash
npm start
```

### Jugando

- Click en el juego para capturar el mouse, **Esc** abre el menú.
- **Ctrl+W no cierra la pestaña**: al apretar *Jugar* se entra en pantalla completa con el teclado bloqueado
  (Keyboard Lock API), así Ctrl+W, Ctrl+T, Ctrl+R, F5, etc. van al juego y no al navegador.
  Para salir de pantalla completa **mantené apretado Esc**; para volver, click en el juego.
  Requisitos del navegador: Chrome o Edge, entrando por `https://` (o `localhost`). En Firefox o por `http://`
  el navegador no lo permite: si se aprieta Ctrl+W pide confirmación antes de cerrar.
- **M** equipo · **B** comprar · **1–9** opciones de menú · **Y** chat · **Tab** puntajes · **`** consola.
  (Los binds salen del `config.cfg` de tu instalación).
- La primera vez cada navegador descarga ~240 MB; después quedan guardados (IndexedDB) y cargan sin descargar.
- Si cambiás de pestaña el juego sigue respondiendo en segundo plano, así que el servidor no te desconecta.

### Consola del servidor

En la ventana del servidor podés escribir comandos de consola de CS, por ejemplo:

| Comando | Qué hace |
|---|---|
| `changelevel de_inferno` | cambia el mapa para todos |
| `yb add` / `yb kick` | agrega / saca un bot |
| `yb_quota 6` | mantiene 6 bots |
| `yb_difficulty 1` | dificultad de bots (0 novato … 4 experto) |
| `mp_restartgame 1` | reinicia la partida |
| `status` | lista jugadores |
| `kick "nombre"` | expulsa a un jugador |
| `salir` | cierra todo |

### Configuración (`config.json`)

Se crea solo la primera vez. Se aplica al reiniciar el servidor.

| Clave | Default | Descripción |
|---|---|---|
| `gamePath` | `auto` | carpeta con `valve/` y `cstrike/`; `auto` busca `steamapps/Half-Life` en el proyecto y después Steam |
| `hostname` | `CS 1.6 LAN` | nombre del servidor |
| `map` | `de_dust2` | mapa inicial |
| `maxPlayers` | `16` | jugadores máximos |
| `bots` / `botDifficulty` | `0` / `2` | bots YaPB al iniciar y su dificultad |
| `password` | vacío | contraseña para entrar (la página la pide) |
| `httpPort` | `27016` | puerto TCP de la página (http y https en el mismo puerto) |
| `webrtcPort` | `27018` | puerto UDP del tráfico de juego (WebRTC) |
| `gamePort` | `27015` | puerto UDP interno del dedicado (sólo 127.0.0.1) |
| `exposeGamePort` | `false` | `true` = el dedicado también acepta clientes CS nativos por la red |
| `rconPassword` | aleatoria | contraseña RCON (se genera sola) |

También se puede sobreescribir al iniciar: `npm start -- --map de_nuke --bots 4`.

Reglas de juego (tiempo de ronda, dinero, friendly fire…): editá `server-config/custom.cfg`.
Rotación de mapas: `server-config/mapcycle.txt`.

**Mapas custom:** copiá el `.bsp` (y sus `.wad` si tiene) dentro de `steamapps/Half-Life/cstrike/...`
y volvé a ejecutar `INICIAR-SERVIDOR.bat`: el paquete web se regenera solo si cambió algo.

### Problemas comunes

- **"No se pudo establecer la conexión WebRTC"**: el firewall está bloqueando UDP 27018 → `ABRIR-FIREWALL.bat`.
  Si antes se canceló el aviso del firewall, Windows crea reglas que *bloquean* `node.exe`; el script te avisa si las encuentra.
- **La página no abre desde otra PC**: firewall (TCP 27016) o redes distintas. Wi-Fi de invitados / con aislamiento
  de clientes no deja que las PCs se vean entre sí.
- **"el servidor está corriendo"** al ejecutar el setup: cerrá primero el servidor (`salir`).
- **El navegador dice "La conexión no es privada"**: es el certificado autofirmado del servidor (se genera solo en
  `runtime/https`). "Configuración avanzada" → "Continuar". Si la política de la empresa no deja continuar, usá `http://`.
- **Carga lenta la primera vez**: son ~240 MB por jugador desde la PC anfitrión; por cable es mucho más rápido que por Wi-Fi.

### Limitaciones

- El chat de voz del juego necesita micrófono, que los navegadores sólo habilitan en `https://` o `localhost`
  (por `https://` el navegador pide permiso al entrar; no está probado a fondo).
- Funciona dentro de la misma red (o una VPN tipo Tailscale/WireGuard). Por internet haría falta abrir/forwardear
  TCP 27016 y UDP 27018.
- El anfitrión necesita Windows (el dedicado es la build win32 de Xash3D-FWGS).

## Estructura

```
INICIAR-SERVIDOR.bat     lanzador (instala, prepara y arranca)
ABRIR-FIREWALL.bat       reglas de firewall (admin)
config.json              configuración (se crea sola)
server/                  Node: HTTP, señalización, puente WebRTC⇄UDP, control del dedicado
client/                  página del modo LAN (Vite + TypeScript) y módulos compartidos (motor, UI)
client/p2p/              página de GitHub Pages: crear/unirse, listen server en el navegador, paquete de archivos
.github/workflows/       publicación automática en GitHub Pages
server-config/           server.cfg base, custom.cfg, mapcycle.txt
scripts/setup.mjs        prepara runtime/ y el paquete de assets
vendor/                  binarios probados: motor wasm, cliente CS wasm, dedicado win32, ReGameDLL+YaPB
runtime/                 generado: servidor dedicado (server/) y valve.zip para la web (web/)
steamapps/Half-Life/     (opcional) copia de la instalación; si no está se usa la de Steam. Nunca se modifica.
```

`npm run setup -- --force` rehace todo. `npm run setup -- --update` baja las últimas builds *continuous* del motor
y de CS16Client (las de `vendor/` son una combinación probada; actualizar puede romper la compatibilidad
con el cliente web).

## Créditos y licencias

- [Xash3D-FWGS](https://github.com/FWGS/xash3d-fwgs) — motor (GPL).
- Port WebAssembly del motor y del cliente: paquetes `xash3d-fwgs` / `cs16-client` de webxash3d-fwgs (yohimik, MIT),
  guardados en `vendor/` porque fueron retirados de npm.
- [CS16Client](https://github.com/Velaron/cs16-client), [ReGameDLL_CS](https://github.com/rehlds/ReGameDLL_CS), [YaPB](https://github.com/yapb/yapb).
- [node-datachannel](https://github.com/murat-dogan/node-datachannel) (libdatachannel), [fflate](https://github.com/101arrowz/fflate), [Trystero](https://github.com/dmotz/trystero).
- Counter-Strike y sus assets son propiedad de Valve: se usan los de tu propia instalación.
