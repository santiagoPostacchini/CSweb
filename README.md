# Counter-Strike 1.6 en el navegador — LAN con servidor dedicado

Una PC (el anfitrión) levanta un **servidor dedicado de CS 1.6** y una página web.
Tus compañeros abren un link en Chrome/Edge/Firefox y juegan: **no instalan nada**.

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

**De la instalación original sólo se usan los assets** (mapas, modelos, sonidos, texturas).
Ningún binario de Valve se ejecuta: el motor es [Xash3D-FWGS](https://github.com/FWGS/xash3d-fwgs),
la lógica del servidor es [ReGameDLL_CS](https://github.com/rehlds/ReGameDLL_CS) y el cliente es
[CS16Client](https://github.com/Velaron/cs16-client), todos open source.

## Inicio rápido

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

## Jugando

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

## Consola del servidor

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

## Configuración (`config.json`)

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

## Problemas comunes

- **"No se pudo establecer la conexión WebRTC"**: el firewall está bloqueando UDP 27018 → `ABRIR-FIREWALL.bat`.
  Si antes se canceló el aviso del firewall, Windows crea reglas que *bloquean* `node.exe`; el script te avisa si las encuentra.
- **La página no abre desde otra PC**: firewall (TCP 27016) o redes distintas. Wi-Fi de invitados / con aislamiento
  de clientes no deja que las PCs se vean entre sí.
- **"el servidor está corriendo"** al ejecutar el setup: cerrá primero el servidor (`salir`).
- **El navegador dice "La conexión no es privada"**: es el certificado autofirmado del servidor (se genera solo en
  `runtime/https`). "Configuración avanzada" → "Continuar". Si la política de la empresa no deja continuar, usá `http://`.
- **Carga lenta la primera vez**: son ~240 MB por jugador desde la PC anfitrión; por cable es mucho más rápido que por Wi-Fi.

## Limitaciones

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
client/                  página web (Vite + TypeScript): transporte WebRTC, carga/caché de assets
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
- [node-datachannel](https://github.com/murat-dogan/node-datachannel) (libdatachannel), [fflate](https://github.com/101arrowz/fflate).
- Counter-Strike y sus assets son propiedad de Valve: se usan los de tu propia instalación.
