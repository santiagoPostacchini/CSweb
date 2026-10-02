# Plan: partidas online entre cualquier red, desde GitHub Pages, sin port forwarding

Documento para quien implemente (Opus). Leer entero antes de tocar código. Idioma del código/comentarios/UI: **español rioplatense**, igual que el resto del repo.

## 1. Punto de partida (ya existe, no rehacer)

La versión "en el navegador" (`client/p2p/*`, publicada con `.github/workflows/pages.yml`) ya hace:

- El **anfitrión corre el servidor en su pestaña** (Xash3D + ReGameDLL en wasm, listen server). `client/p2p/p2pnet.ts` (`Xash3DP2P`) mete cada DataChannel como un cliente UDP con IP ficticia `10.77.x.y`.
- **Señalización** con Trystero sobre relays públicos de Nostr (`client/p2p/room.ts`, `joinTrystero`). Luego el anfitrión abre una `RTCPeerConnection` propia (`Link`) por invitado con canales `game` (no confiable, tipo UDP) y `files` (confiable, ~240 MB de assets una sola vez).
- STUN público (Google/Cloudflare) + **TURN opcional cargado a mano por el anfitrión** (`netdiag.ts`: `loadTurn/saveTurn/rtcConfig`).
- Diagnóstico de conexión (`diag`, `selectedPath`, `describePath`), `keepalive.ts` (rAF vía Worker para que la pestaña no se congele).

## 2. Qué falta realmente (diagnóstico honesto)

GitHub Pages sólo sirve archivos estáticos: **nunca va a ejecutar un servidor de juego**. "El servidor desde la página" = una pestaña. Lo que sí podemos lograr es que ese modelo sea confiable. Los problemas que quedan:

| # | Problema | Efecto |
|---|----------|--------|
| P1 | El TURN lo tiene que conseguir y pegar el anfitrión | Entre redes distintas (CGNAT, NAT simétrico, redes corporativas, datos móviles ≈ 10-25 % de los pares) la conexión falla para casi todos los usuarios reales |
| P2 | Señalización depende de relays Nostr públicos de un solo tipo | Si los relays están lentos/caídos "no se encontró la partida" |
| P3 | Si el anfitrión cierra/pierde internet, **se acaba la partida** | Es "el problema de quien hostee" |
| P4 | El anfitrión es el que crea la sala, no el que tiene mejor conexión/PC | Mal ping para todos |
| P5 | No hay forma de saber de antemano si una red va a poder conectar | Frustración sin causa clara |

Un servidor TURN/STUN **no se puede evitar** para cubrir todas las redes; sin port forwarding es la única forma. Lo que sí podemos evitar es que el usuario lo configure: lo hace un backend mínimo y gratuito.

## 3. Arquitectura objetivo

```
        GitHub Pages (estático)                 Cloudflare Worker (gratis, mínimo)
   ┌──────────────────────────────┐          ┌────────────────────────────────────┐
   │ Página: crear / unirse       │ ──GET──▶ │ /turn  → credenciales TURN efímeras │
   │ Xash3D wasm (host o cliente) │          │ (Cloudflare Realtime TURN, 1 TB/mes)│
   └──────────────┬───────────────┘          │ /signal (fase 2b, opcional)         │
                  │ señalización (Trystero    └────────────────────────────────────┘
                  │ multi-estrategia + Worker)
                  ▼
   Anfitrión ◀══ WebRTC (directo; si no, vía TURN 443) ══▶ Invitados
        ▲                                                    │
        └──── migración de anfitrión: si cae, otro peer ◀────┘
              levanta el servidor y los demás se reconectan
```

Decisiones tomadas (no re-discutir):

1. **TURN: Cloudflare Realtime (Calls) TURN**, credenciales cortas generadas por un Worker. Motivo: gratis hasta ~1 TB/mes, sirve TURN sobre UDP/TCP/TLS 443 (atraviesa redes corporativas), y el secreto no puede vivir en un repo público (cualquier credencial estática en una página de Pages es pública). Verificar términos y cuota vigentes antes de implementar; plan B: metered.ca con su API de credenciales detrás del mismo Worker.
2. **Migración de anfitrión** en vez de "servidor eterno": todos los jugadores ya tienen el paquete de assets en IndexedDB, así que cualquiera puede ser anfitrión. Se pierde el marcador de la ronda al migrar (aceptado), no el grupo ni el mapa.
3. El servidor 24/7 (host headless en una VM gratuita) queda como **fase opcional final**.

## 4. Fases (cada una = un commit, build verde, `npm run build:pages` sin errores de tipos)

### Fase 0 — Herramienta de medición (rápida, hacerla primero)

Objetivo: poder verificar cada fase con datos.

- En `netdiag.ts` agregar `checkNetwork()`: abre una `RTCPeerConnection` con STUN, junta candidatos y devuelve `{ ipv6, srflxCount, natType: 'abierto'|'cono'|'simétrico'|'desconocido', mdns }`. Detectar simétrico comparando los puertos `srflx` obtenidos contra 2 STUN distintos (puertos distintos ⇒ NAT simétrico ⇒ necesita TURN).
- Mostrarlo en la UI de "Crear partida" y "Unirse" como una línea ("Tu red: NAT simétrico → se usará relay") y agregarlo al texto de `diag.text()`.
- Agregar al diagnóstico el RTT y pérdida medidos con `getStats()` (candidate-pair `currentRoundTripTime`).

Aceptación: en una red doméstica normal informa "cono/abierto"; con el hotspot del celular informa lo que corresponda; no rompe nada si falla.

### Fase 1 — TURN automático (resuelve P1, la más importante)

1. Crear `worker/` (carpeta nueva, **fuera** del bundle de Vite) con un Cloudflare Worker (`wrangler.toml`, `src/index.ts`):
   - `GET /turn` → llama a `POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers` (o `/generate`, ver docs vigentes) con `Authorization: Bearer <TOKEN>` y `{ "ttl": 86400 }`; devuelve el JSON `iceServers` tal cual (sin el token).
   - CORS: sólo `https://santiagopostacchini.github.io` y `http://localhost:*` (dev). Responder `Cache-Control: no-store`.
   - Rate limit por IP (binding de rate limiting de Workers o contador en KV) ~30 req/min/IP.
   - Secrets `TURN_KEY_ID`, `TURN_API_TOKEN` por `wrangler secret put`. **Nunca** en el repo.
2. Cliente (`client/p2p/netdiag.ts`): `async function fetchIceServers(): Promise<RTCIceServer[]>` con timeout de 4 s, caché en memoria, y fallback silencioso a `[]`. La URL del Worker sale de una constante `TURN_ENDPOINT` (vía `import.meta.env.VITE_TURN_ENDPOINT`, definida en el workflow). `rtcConfig` pasa a combinar: STUN públicos + ICE del Worker + TURN manual del usuario (el manual sigue funcionando y tiene prioridad si existe).
3. Llamar a `fetchIceServers()` al abrir la página (precalentar) y pasarlo a `HostRoom`, `GuestRoom` y `Link`. Ojo: `rtcConfig` hoy es síncrono y se usa en `Link` y en `turnConfig` de Trystero; resolver el ICE **antes** de construir la sala.
4. Asegurar que se ofrezca `turns:…:443?transport=tcp` además de UDP (viene en la respuesta de Cloudflare; no filtrarlo).
5. **Transferencia de assets por relay**: el pack son ~240 MB; si `describePath` dice relay, mostrar aviso ("conexión por relay: la primera descarga consume ~240 MB del cupo compartido"). Si la cuota preocupa, mejora: que un invitado que ya tiene el pack pueda servirlo a otros (fase 5b), o que el anfitrión priorice directos.
6. `.github/workflows/pages.yml`: pasar `VITE_TURN_ENDPOINT` al build. Agregar `.github/workflows/worker.yml` que haga `wrangler deploy` sólo cuando cambie `worker/**` (secret `CLOUDFLARE_API_TOKEN` del repo; documentar en README que el usuario debe crearlo).
7. UI: mover el formulario TURN manual a "Opciones avanzadas" ya existente y dejar de pedirlo por defecto. Si `fetchIceServers` falla, mostrar un aviso discreto.

Aceptación: anfitrión en Wi-Fi de casa e invitado en datos móviles (otro operador) conectan **sin configurar nada**, y `diag` muestra `relay/udp` o `relay/tcp` si no hubo camino directo. Probar también forzando `iceTransportPolicy: 'relay'` (flag `?relay=1` sólo para pruebas) para validar que el TURN funciona de punta a punta.

### Fase 2 — Señalización robusta (P2)

- 2a. **Multi-estrategia**: Trystero soporta varias (`nostr`, `mqtt`, `torrent`; ver la API de la versión instalada, `trystero ^0.25`). Unir la sala por 2 estrategias en paralelo (p. ej. Nostr + MQTT) y aceptar al primer anfitrión que aparezca por cualquiera; el anfitrión anuncia en ambas. Deduplicar por `peerId`/`sid`.
- 2b. (opcional, sólo si 2a no alcanza en pruebas) **señalización propia en el mismo Worker** con un Durable Object por sala (WebSocket hibernable, plan gratuito con SQLite): mensajes `join/leave/sig` + lista de peers. Mantener la interfaz `Room` de `room.ts` casi igual para no reescribir `HostRoom`/`GuestRoom`.
- 2c. En `Link`: **reinicio de ICE** (`pc.restartIce()` + nueva oferta) cuando el estado pasa a `disconnected` más de ~3 s, antes de dar por perdido al jugador (cambios de Wi-Fi, suspensiones breves).
- 2d. Ampliar timeouts/mensajes: distinguir "no se encontró la sala" (señalización) de "se encontró pero no conecta" (ICE) en la UI.

Aceptación: con un relay Nostr bloqueado por devtools, los invitados igual encuentran la sala; cortar la red 5 s en un invitado no lo expulsa.

### Fase 3 — Migración de anfitrión (P3, "sin problemas de quien hostee")

Diseño (reutiliza todo lo existente):

1. **Roster compartido**: el anfitrión difunde por Trystero (acción `roster`) la lista ordenada de jugadores `{peerId, joinedAt, canHost, score}` y los ajustes de la partida (`map`, `maxPlayers`, `hostname`, `epoch`). Cada invitado guarda la última copia. `canHost` = tiene el pack completo en IndexedDB (`store.ts`) y no es móvil/táctil.
2. **Detección de caída**: invitado considera perdido al anfitrión cuando el canal `game` se cierra o `connectionState` queda `failed`/`disconnected` > 5 s (ya hay `onHostLeft`; hoy sólo muestra error).
3. **Elección determinista sin coordinación**: todos calculan el mismo sucesor = primer elemento de `roster` con `canHost`, ordenado por `score` desc y `joinedAt` asc (desempate por `peerId`). Si el sucesor soy yo → paso a anfitrión; si no → espero.
4. **Cambio de rol**: la forma más robusta de reiniciar el motor es **recargar la página con el rol nuevo** conservando estado en `sessionStorage`/query: `?room=CODE&epoch=N&role=host&map=...`. La pestaña arranca como `HostRoom` con el **mismo código de sala** y el `epoch` incrementado; los demás recargan como invitados con `epoch` ≥ N (ignoran anfitriones con `epoch` menor para no volver al zombi). No hace falta volver a descargar nada: el pack ya está en IndexedDB.
5. **UI**: overlay "El anfitrión se desconectó — migrando partida (X)…", con cuenta regresiva y botón "Salir". Si el sucesor no aparece en 20 s, pasar al siguiente del orden (timeout escalonado: cada candidato espera `15 s × posición`).
6. Anti-split-brain: si aparecen dos anfitriones para el mismo `epoch`, gana el de menor `peerId`; el otro se degrada a invitado.
7. Limitaciones aceptadas y documentadas: se reinicia la ronda y el marcador; los jugadores móviles no pueden ser anfitriones.

Aceptación (manual con `?perfil=a|b|c` en una PC): 3 pestañas, cerrar la del anfitrión → en ≤ 20 s las otras 2 vuelven a estar jugando en el mismo mapa. Cerrar luego al nuevo anfitrión → vuelve a migrar. Probar también con apagado abrupto (devtools → Offline), no sólo cierre limpio.

### Fase 4 — Calidad del anfitrión (P4)

- Medir por par: RTT y pérdida (`getStats`) y publicar `score` en el roster (peor RTT al resto + tipo de camino: directo > relay).
- En el lobby, sugerir el mejor anfitrión y permitir "Pasar anfitrión a X" (usa el mismo mecanismo de la fase 3 con migración voluntaria, sin esperar timeouts).
- Anfitrión: pedir `navigator.wakeLock.request('screen')`, un `navigator.locks.request` mantenido y un `AudioContext` silencioso para evitar el throttling de pestañas ocultas (complementa `keepalive.ts`); advertir si `document.visibilityState === 'hidden'` por más de X s ("tu pestaña está en segundo plano: los demás pueden notar lag").
- Contrapresión del canal `game`: si `bufferedAmount` > umbral, descartar paquetes antiguos en vez de acumular (ya hay cola de 2048/4096 en `p2pnet.ts`; revisar que `sendto` no encole sin límite).

### Fase 5 — Opcionales

- **5a. Servidor 24/7 sin PC propia**: un "anfitrión headless" = la misma página de Pages abierta en Chromium headless (Playwright) en una VM gratuita con IP pública (Oracle Always Free / Fly.io), con los assets de Valve cargados en privado. Se une a la sala como un anfitrión más (primero en el orden de elección, `score` máximo). Alternativa más simple si hay VM: usar el servidor Node existente (`server/`) con UDP 27018 abierto en la VM (la VM tiene IP pública, no hace falta forwardear nada en casa) + dominio y TLS (Caddy). Evaluar costo/beneficio recién con las fases 1-4 funcionando.
- **5b. Enjambre de assets**: invitados con el pack lo sirven a otros nuevos (reduce carga/relay del anfitrión).
- **5c. Lista de salas públicas** (necesita el Worker/DO de 2b).

## 5. Qué NO hacer

- No poner credenciales TURN ni tokens en el repo, el bundle ni el workflow en claro.
- No publicar ni commitear assets de Valve (el repo ya los evita; mantenerlo).
- No reescribir el motor de red (`p2pnet.ts`) ni cambiar el formato del paquete (`packformat.ts`) salvo lo estrictamente necesario.
- No agregar dependencias pesadas; el Worker en TypeScript puro.
- No tocar el modo "servidor dedicado LAN" (`server/`) salvo la fase 5a.

## 6. Verificación global antes de dar por terminado

Matriz mínima (anotar resultado de `diag` de cada una en el PR):

| Anfitrión | Invitado | Esperado |
|-----------|----------|----------|
| Misma LAN | Misma LAN | directo `host→host` |
| Wi-Fi casa | Datos móviles | conecta (directo o `relay`) sin configurar nada |
| Datos móviles | Datos móviles (otro operador, CGNAT) | `relay` |
| Red corporativa/UDP bloqueado | Wi-Fi casa | `relay/tcp` por 443 |
| 3 jugadores, anfitrión se cae | — | migración ≤ 20 s |

Además: `npm run build:pages` sin errores, la partida sigue funcionando con el Worker caído (fallback a STUN + TURN manual), y el README actualizado (sección "En el navegador": quitar la instrucción de buscar un TURN a mano, documentar el deploy del Worker y la migración de anfitrión).

## 7. Orden recomendado

Fase 0 → 1 (con eso ya se juega entre cualquier red) → 3 (migración) → 2 → 4 → 5. Si hay poco presupuesto, **0+1+3 cubren el pedido** completo.

## 8. Ampliación: enjambre de assets y alternativas sin servidor

### 8.1 Fase 5b detallada — enjambre de assets entre invitados (estilo BitTorrent, sin servidor)

Hoy sólo el anfitrión sirve el pack (~240 MB) por el canal `files`. Cambio:

1. **Manifiesto**: el anfitrión (o quien tenga el pack) calcula una vez `manifest = { version, size, chunkSize: 4 MiB, hashes: SHA-256[] }` y lo guarda junto al pack en IndexedDB (`store.ts`). El hash del manifiesto completo viaja en `GameInfo.pack` para que nadie pueda inyectar datos falsos.
2. **Malla de datos**: Trystero ya conecta a todos los miembros de la sala entre sí. Usar esas conexiones (acciones `chunk-req` / `chunk-have` / canal binario) para pedir trozos a cualquier par que los tenga. No abrir `Link`s propios entre invitados salvo que haga falta más control.
3. **Descarga**: el nuevo pide el manifiesto, anuncia qué trozos tiene (`bitfield`) y baja trozos de a varios pares en paralelo (prioridad al más raro, máx. 3-4 pedidos en vuelo por par, reintento con otro par si hay timeout). Cada trozo se verifica con su hash antes de guardarse; trozo inválido: se descarta y se penaliza al par.
4. **Siembra**: quien termina anuncia `bitfield` completo y pasa a servir. Prioridad de subida baja mientras está jugando (el juego va por el canal `game`; los trozos deben ir por otro canal con límite de `bufferedAmount` para no meter lag).
5. **Resultado**: el anfitrión deja de ser cuello de botella, la descarga sobrevive si el anfitrión se va, y se reparte el consumo de TURN (un par con camino directo siembra a quien sólo tiene relay).
6. Aceptación: con 1 anfitrión y 3 invitados nuevos entrando a la vez, la subida del anfitrión baja a ~1× el pack (no 3×) y un trozo corrupto inyectado a mano es rechazado.

Alternativa más rápida de construir: WebTorrent (WebRTC + trackers WebSocket públicos). Contra: depende de trackers públicos y anuncia el infohash; para assets privados conviene el diseño propio de arriba.

### 8.2 Qué se puede y qué no con "cero servidores"

- **Se puede sin servidores propios**: señalización (Nostr/MQTT/trackers de torrent públicos, ya soportados por Trystero), enjambre de assets, migración de anfitrión, STUN público, IPv6 directo (sin NAT, sin TURN).
- **No se puede 100 % sin infraestructura ajena**: el tráfico de juego es cliente-servidor autoritativo (un par debe ser el servidor; una malla P2P pura no sirve para CS) y los pares tras NAT simétrico/CGNAT necesitan un relay TURN. Se cubre con un TURN gratuito de terceros, no con un servidor propio.

### 8.3 Alternativas gratuitas a evaluar (de menor a mayor esfuerzo)

| Necesidad | Opción gratuita | Nota |
|-----------|-----------------|------|
| Señalización extra | Trystero con `mqtt` o `torrent` junto a `nostr` (fase 2a) | sin cuentas |
| Señalización sin ningún servicio | **Modo manual**: copiar/pegar la oferta y la respuesta SDP (o QR) | último recurso para redes raras; no necesita relays |
| TURN | Cloudflare Realtime TURN (plan principal), metered.ca (cupo chico), Open Relay | siempre detrás del Worker |
| Anfitrión 24/7 | VM Oracle Always Free o Fly.io con el servidor `server/` o el host headless (fase 5a) | IP pública: no hay NAT ni port forwarding |
| Anfitrión 24/7 desde tu casa sin abrir puertos | **Cloudflare Tunnel** o Tailscale Funnel hacia `server/` | el túnel es TCP: habría que llevar el juego por WebSocket en vez de UDP/WebRTC (más latencia), plan B |
| Lista de salas públicas | Eventos Nostr o Durable Object del Worker | fase 5c |

### 8.4 Orden sugerido con esto incorporado

0 → 1 → 3 → 2a → 5b (enjambre) → 4 → modo manual de señalización → 5a/5c si hace falta.
