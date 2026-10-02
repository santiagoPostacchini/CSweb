# Inspiración para la interfaz de CSweb

Etapa 1 de [`docs/agente-diseno-ui.md`](../agente-diseno-ui.md). Fecha de la investigación: 2 de octubre de 2026.

**Cómo leer este documento.** Las referencias están agrupadas por idea. Los valores de color y tipografía marcados
como *medido* los leí yo en el navegador, con `getComputedStyle`, el 2/10/2026: son los valores reales del sitio ese
día. Lo marcado como *leído* viene del README o de una nota de prensa, sin haberlo visto renderizado. Los contrastes
son WCAG 2.x, calculados con un script.

**Capturas.** No guardé capturas de terceros en `docs/diseno/referencias/`: ninguna de estas páginas ofrece una
licencia que lo permita (ni siquiera las librerías CSS, que licencian el código pero no su página de demostración).
En su lugar describo lo que se ve y dejo el link para abrirlo.

**Lo que no pude evaluar.** `venge.io` me muestra un muro de consentimiento de cookies que tapa toda la página y no
lo acepté; lo único que vi es un fondo violeta con degradé, así que no sirve como referencia. La página de Escape
from Tarkov me la bloqueó el navegador. Las dos quedan afuera.

---

## 1. La época: VGUI, Steam 2003 y el verde oliva

La estética que el público de CSweb recuerda: ventanas planas con bisel, verde militar apagado, texto chico y
amarillo apagado para lo importante.

### cs16.css (samke) — <https://cs16.samke.me> · MIT

*Medido.* Es una librería CSS que recrea el menú de Counter-Strike 1.6. Paleta real:

| Token | Valor | Para qué |
|---|---|---|
| `--bg` | `#4a5942` | superficie de la ventana |
| `--secondary-bg` | `#3e4637` | zonas hundidas |
| `--accent` | `#c4b550` | texto y títulos destacados |
| `--secondary-accent` | `#958831` | acento oscuro |
| `--text` / `--text-3` | `#dedfd6` / `#a0aa95` | texto / texto atenuado |
| `--border-light` / `--border-dark` | `#8c9284` / `#292c21` | bisel claro / oscuro |

Fuente `ArialPixel`, radio 0, botones de `4px 5px 3px` de relleno, sombra ninguna: todo el relieve sale de los
bordes.

- **Qué tomar:** la paleta completa (es la más fiel que encontré), los radios en cero, el relieve hecho solo con
  bordes de dos tonos y el amarillo apagado como único acento.
- **Qué evitar:** los contrastes no pasan. El acento `#c4b550` sobre la ventana da **3,60:1**, el texto atenuado
  **3,10:1**, el texto deshabilitado **1,90:1** y el bisel claro **2,34:1**; todo por debajo del AA para texto
  chico. De la fuente `ArialPixel` no verifiqué la licencia, así que no la voy a redistribuir desde el repo.

### vgui.css (AlpyneDreams y leonill007) y OG-Steam — <https://github.com/AlpyneDreams/vgui.css> · <https://github.com/ungstein/OG-Steam>

*Leído.* `vgui.css` es una hoja CSS (licencia MIT) con tres pieles: `greensteam` (verde clásico de Steam y
Goldsource), `blacksteam` (variante oscura) y `greysteam` (gris de Source). OG-Steam es un tema para el cliente de
Steam que reproduce la versión de 2004; usa **Tahoma** y, de forma opcional, la tipografía bitmap WineTahomaBit
(LGPL). El repositorio está archivado desde mayo de 2023.

- **Qué tomar:** que exista una variante *negra* del mismo diseño confirma que el oliva se puede oscurecer sin
  perder el carácter. Tahoma como fuente de época: está instalada en Windows y no pesa nada.
- **Qué evitar:** el README no publica valores de color, así que sirven de mapa de estructura (widgets, jerarquía),
  no de paleta. No copiar sus archivos de imagen.

### 98.css (jdan) — <https://jdan.github.io/98.css/> · MIT

*Medido.* Recrea Windows 98. El relieve de un botón es una pila de cuatro sombras interiores, sin imágenes:
`inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf`. Fondo `#c0c0c0` y
fuente bitmap `Pixelated MS Sans Serif`.

- **Qué tomar:** la técnica. Un bisel de dos o cuatro tonos con `box-shadow: inset` o con `border-color` de cuatro
  valores es liviano y se repinta sin costo.
- **Qué evitar:** el gris de Windows 98, que es de otra década y de otro mundo; y las fuentes bitmap.

## 2. Valve hoy: cómo presenta la marca

### Página de Counter-Strike 2 — <https://www.counter-strike.net/cs2>

*Medido.* Fondo `#15171b`. Familia de fuentes `Stratum2`, `Stratum2 Condensed` y `Stratum2 Mono` (más Noto Sans
como respaldo). La portada tiene un gris claro con **rayas diagonales** y un botón azul de Steam con texto en
mayúsculas espaciadas.

- **Qué tomar:** el sistema de tres voces tipográficas (normal, condensada, mono) y la textura de rayas diagonales
  hecha de repeticiones simples. Es la forma más barata de decir "esto es de la familia".
- **Qué evitar:** el logo, la silueta del soldado y la familia Stratum (propietaria y de Valve). Aquí solo se
  aprende el *método*; nada de esto se copia.

### Steam (tienda) — <https://store.steampowered.com>

*Medido.* Fondo `#1f2a35`, encabezado `#171d25`, texto `#c6d4df` (**9,64:1** sobre el fondo), fuente `Motiva Sans`
(propietaria). El botón de comprar usa texto verde claro `#d2efa9`.

- **Qué tomar:** una sola acción primaria por pantalla, con un color propio (el verde claro del "Agregar al
  carrito"), para que se encuentre a la primera.
- **Qué evitar:** el azul pizarra y la tipografía: son del Steam *moderno*, no de la época del juego.

## 3. Cultura LAN y listas de servidores

### GameTracker — <https://www.gametracker.com>

*Medido.* Fondo `#000`, texto `#f0f0f0`, fuente `Trebuchet MS, Tahoma` de 12 px, enlaces naranjas `#ff9900`
(**9,81:1** sobre negro). Las tablas usan celdas marrón-rojizas `#3f0600` con texto `#d7b180` en negrita de 11 px
(**8,48:1**) y borde `#4f2b25`. Es la lista de servidores de la época, densa y llena de banners.

- **Qué tomar:** los datos de una partida (servidor, mapa, jugadores) como una **tabla clave–valor** y no como
  párrafos. Y un acento *cálido* (naranja) sobre fondo casi negro, que se lee mucho mejor que cualquier verde.
- **Qué evitar:** la publicidad, los 11–12 px y el apelmazamiento. La densidad de GameTracker es un defecto de
  accesibilidad; acá la tabla tiene que respirar.

### Fotos de LAN parties de los 2000 — <https://rarehistoricalphotos.com/lan-parties-photos-2000s/>

*Leído.* Describe espacios apretados, monitores gordos, cables enredados, envoltorios de comida y bolsas de dormir
bajo las mesas. Para el origen de la escena: DreamHack nació en un colegio de Malung (Suecia) a comienzos de los 90
y desde 2002 se hacía dos veces por año ([Wikipedia](https://en.wikipedia.org/wiki/DreamHack)).

- **Qué tomar:** el *ambiente*: algo hecho a mano, pegado con cinta, fotocopiado; carteles de "Se juega CS acá"
  más que una interfaz pulida. De acá sale la dirección B (flyer de LAN).
- **Qué evitar:** el desorden literal. Ese caos tiene que ser una decoración, no una carga de lectura.

## 4. Juegos .io y entrar a una partida en un paso

### Krunker.io — <https://krunker.io>

*Medido* (texto de la página; la captura se me agotó por tiempo, así que no vi el render). El menú principal ofrece
una lista corta de **verbos**: `QUICK MATCH`, `RANKED`, `HOST GAME`, `FIND GAME`, `CUSTOM GAMES`, y arriba un par
`INVITE` / `JOIN` para entrar con un código. Debajo, "POPULAR NOW" con cada mapa y su contador en vivo (por ejemplo
"46 playing") y un botón de jugar por fila. Usa íconos Material.

- **Qué tomar:** que **unirse** y **crear** sean verbos grandes y cortos, no formularios; y que haya un número vivo
  ("3 jugando") que dé ganas de entrar. Es lo más parecido a lo que CSweb necesita: entrar sin pensar.
- **Qué evitar:** el aviso de consentimiento de privacidad de más de mil socios que tapa la pantalla, los anuncios
  y el peso de una fuente de íconos. CSweb no necesita nada de eso.

## 5. Comunidades y mods

### GameBanana, hub de CS 1.6 — <https://gamebanana.com/games/4254>

*Medido.* Fondo `#131a20`, texto `#e2e2e2`, fuente `Open Sans`; los controles usan `IBM Plex Mono` y radios chicos
(unos 3,6 px).

- **Qué tomar:** la **fuente monoespaciada para los metadatos** (conteos, versiones, códigos). Da un aire técnico y
  comunitario sin pasarse. Apoya la dirección C.
- **Qué evitar:** la grilla de tarjetas: sirve para explorar miles de mods, no para una pantalla con dos acciones.

### Black Mesa (Crowbar Collective) — <https://www.crowbarcollective.com/games/black-mesa>

*Medido.* Fondo `#171717`, títulos en naranja `#e37226` (**5,72:1**), fuente `futura-pt` (de Adobe, propietaria).
Los botones son píldoras de 12 px en mayúsculas con 0,48 px de separación entre letras y texto blanco sobre el
naranja. El banner de cookies tiene un "OK" relleno, un "Decline all" con borde y un "Manage cookies" como texto.
Las fotos del fondo van teñidas de verde azulado oscuro.

- **Qué tomar:** el naranja sobre carbón combina con el mundo de Half-Life y se lee bien (5,72:1). Y el banner pone
  "Decline all" a la vista, sin esconderlo: un buen gesto.
- **Qué evitar:** el texto blanco sobre ese naranja da **3,13:1**, que no pasa AA a 12 px. La forma de píldora y
  la tipografía Futura. Y nada de la lambda: es marca registrada.

## 6. Interfaces pensadas para distancia y mando

### Steam Big Picture y la interfaz de Steam Deck — [GameSpot](https://www.gamespot.com/articles/steams-big-picture-mode-finally-gets-steam-deck-inspired-update/1100-6511094/)

*Leído.* Un modo de pantalla completa pensado para leerse de lejos y manejarse sin mouse: objetivos grandes, foco
visible y navegación ordenada.

- **Qué tomar:** objetivos grandes y un foco que se ve desde lejos. CSweb se usa a menudo en pantalla completa y en
  celulares: ya exige 40 px mínimos y esto confirma la idea.
- **Qué evitar:** la navegación por mando: acá no hay.

### Rediseño de Battle.net — [Engadget](https://www.engadget.com/battle-net-client-blizzard-front-end-upgrade-redesign-101045426.html)

*Leído.* Blizzard rehízo su lanzador y destaca "mejoras importantes de accesibilidad con navegación por teclado y
mejor contraste de color".

- **Qué tomar:** la accesibilidad es parte del rediseño y no un parche posterior.
- **Qué evitar:** el diseño genérico de lanzador (lo que hoy ya tenemos).

---

## Principios de diseño que salen de la investigación

1. **Se siente como un menú de 2003 visto por alguien de hoy.** Relieve de bordes, radios en cero, texto chico y
   firme; pero con los contrastes que el original no cumplía. *Nunca* copiar los 2,3:1 del bisel de cs16.css.
2. **Un solo acento cálido por pantalla.** Amarillo apagado u ámbar sobre fondos oscuros: se lee mejor que el verde
   (GameTracker y Black Mesa lo confirman) y el verde queda como fondo, no como señal.
3. **Entrar es un verbo, no un formulario.** "Unirse" y "Crear partida" son lo más grande de la pantalla, como en
   Krunker. El resto (mapa, opciones, TURN) queda a un clic de distancia.
4. **Los datos de la partida son una tabla.** Código, servidor, mapa y jugadores van en filas clave–valor con
   espacio, como GameTracker pero sin la maraña.
5. **Dos voces tipográficas, como mucho.** Una para títulos y otra para datos (la lección de Stratum2). Una de las
   dos puede ser la fuente del sistema, que no pesa nada.
6. **Textura barata y quieta.** Rayas, puntos, líneas de barrido y esquinas hechas con degradés de CSS, estáticas.
   *Nunca* algo animado ni con desenfoques detrás del canvas: el juego necesita toda la CPU y la GPU.
7. **El estado nunca depende solo del color.** El punto verde de "anfitrión conectado" lleva la palabra "en línea";
   el error lleva la palabra "ERROR"; los archivos listos llevan una marca ✓.
8. **Nada de Valve.** Ni logo, ni fuentes, ni lambda, ni arte. La identidad sale de la época y de la LAN, no de la
   marca.
