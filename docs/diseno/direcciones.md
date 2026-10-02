# Direcciones visuales para CSweb

Etapa 2 de [`docs/agente-diseno-ui.md`](../agente-diseno-ui.md). Se apoya en [`inspiracion.md`](inspiracion.md).

**Qué hay para mirar.** Cada dirección tiene una maqueta HTML autocontenida (se abre con doble clic, no pide
internet) y capturas a 1440 px y a 390 px de ancho:

| Dirección | Maqueta | Captura 1440 px | Captura 390 px |
|---|---|---|---|
| **A · Steam 2003 / VGUI** | [`maqueta-vgui.html`](maqueta-vgui.html) | [`vgui-1440.png`](capturas/vgui-1440.png) | [`vgui-390.png`](capturas/vgui-390.png) |
| **B · Flyer de LAN party** | [`maqueta-flyer-lan.html`](maqueta-flyer-lan.html) | [`flyer-lan-1440.png`](capturas/flyer-lan-1440.png) | [`flyer-lan-390.png`](capturas/flyer-lan-390.png) |
| **C · Terminal táctica** | [`maqueta-terminal.html`](maqueta-terminal.html) | [`terminal-1440.png`](capturas/terminal-1440.png) | [`terminal-390.png`](capturas/terminal-390.png) |

Las tres maquetas muestran las mismas seis cosas, con el mismo marcado que `client/p2p/index.html`: **inicio**,
**unirse desde un link**, **carga** (determinada e indeterminada), **cartel de invitación y toast sobre el juego**,
**estados** (opciones abiertas, archivos listos, error, aviso y diagnóstico) y los **tokens con su contraste**.
El juego de la maqueta es un degradé y una mira dibujados con CSS: no hay arte ni archivos de Valve.

**Lo que cumplen las tres pieles** (restricciones de la sección 4 del encargo, tal como están diseñadas; se vuelven
a comprobar en la implementación): botones, campos y filas de casilla de 40 px o más de alto (44 px con puntero
táctil), foco visible con teclado, estados que no dependen solo del color (el punto de "anfitrión conectado" lleva
la palabra "en línea"; el error lleva "ERROR"; los archivos listos, ✓), sin animaciones detrás del canvas (en la
terminal solo parpadea el cursor del título, que está dentro de un panel que se oculta al jugar), y durante el
juego no se ve nada de esto salvo el cartel de invitación y los toasts. **Medido:** a 390 px de ancho la página
tiene `scrollWidth` = 390 px en las tres, es decir, sin scroll horizontal.

**Dos arreglos de estructura que valen para cualquier dirección.** Al armar las maquetas encontré que en 390 px el
cartel de invitación y el toast se parten en varias líneas, porque con `left: 50%` el navegador les da solo la mitad
del ancho. Esto pasa también en la página actual. La solución es `width: max-content` con el tope
`max-width: calc(100vw - 32px)` que ya tienen, más `flex-wrap: wrap` en el cartel para pantallas de 480 px o
menos. Está en la estructura común de las tres maquetas y se va a llevar a `client/style.css`.

---

## A · Steam 2003 / VGUI

> **Ventanas biseladas de verde oliva, como el menú de Counter-Strike 1.6 y el Steam de 2003, pero con contraste
> moderno.**

Es la que más se parece a lo que recuerda el público: a quien jugó CS 1.6 hace veinte años le suena a la primera
mirada. Cada panel es una "ventana" con barra de título, los campos están hundidos y los botones, en relieve. El
botón principal es amarillo apagado; el resto es oliva. Las líneas divisorias son grabadas (una oscura y una clara
pegadas), como en VGUI.

**Peso:** cero fuentes (usa Tahoma → Verdana → Segoe UI, instaladas en Windows). Es la más liviana de las tres.

| Token | Valor | Contraste |
|---|---|---|
| `--bg` fondo de página | `#232a1f` | texto 11,91:1 |
| `--panel` ventana | `#4a5942` | texto 6,05:1 · secundario 4,73:1 |
| `--inset` campo / caja hundida | `#2f372a` | texto 9,96:1 · acento 7,22:1 |
| `--text` / `--muted` | `#e6e8dc` / `#c9d0bd` | AA / AA sobre la ventana |
| `--accent` / `--accent-ink` | `#e4d768` / `#1b1d0e` | 5,08:1 sobre la ventana · tinta sobre acento 11,57:1 |
| `--hi` / `--lo` bisel | `#b4bba4` / `#1c2118` | borde de control 3,78:1 |
| `--ok` / `--err` | `#9be08a` / `#ff9a82` | 7,89:1 / 6,00:1 sobre el campo |
| foco | punteado blanco de 2 px | 7,50:1 |

Tipografías: pila del sistema. Radios: 0. Sombras: `0 0 0 1px #000, 8px 8px 0 #0009` (dura, sin desenfoque).
Espaciado: relleno de ventana 18 px (14 px en pantallas de 480 px o menos), separación de 12 px, texto de 14 px
(15 px con puntero táctil).

**Lo que es distinto de la plantilla actual:** nada de naranja y panel flotante; ahora hay barra de título, bisel
y la barra de carga es de bloques amarillos, como la de Steam.

**Riesgos:** se ve "retro" de verdad; si a alguien le parece anticuado, no hay forma de suavizarlo sin perder la
gracia. Con 14 px el texto es chico (es lo auténtico), pero sube a 15 px en celulares.

## B · Flyer de LAN party

> **Un afiche fotocopiado pegado en la pared del cyber: cinta de peligro, titular enorme y sombras duras.**

La más ruidosa y la que más personalidad tiene. Cada panel lleva arriba una banda de rayas amarillas y negras, el
título es un titular condensado y enorme con sombra naranja, el subtítulo es un sello naranja inclinado y las
separaciones son cortes de tijera punteados. Los datos de la partida son una "entrada" con borde punteado y el
estado "en línea" va como un sello. Los botones tienen sombra dura y se hunden al apretarlos.

**Peso:** una fuente de títulos, **Anton** (OFL; estimo unos 20 KB en woff2, a confirmar al bajarla), y la pila del
sistema para el texto. En la maqueta los titulares se ven con Impact porque no tengo Anton instalada.

| Token | Valor | Contraste |
|---|---|---|
| `--bg` fondo de página | `#0c0c0a` | — |
| `--panel` | `#15150f` | texto 16,20:1 · secundario 8,90:1 |
| `--text` / `--muted` | `#f4f1e6` / `#b9b5a3` | AAA / AAA |
| `--accent` / `--accent-ink` | `#ffd60a` / `#0c0c0a` | 12,98:1 · tinta sobre acento 13,87:1 |
| `--accent-2` sello | `#ff5a2b` | 5,89:1 sobre el panel · tinta sobre sello 6,29:1 |
| `--ctl` borde de control | `#8d8a78` | 5,27:1 |
| `--ok` / `--err` | `#62e88e` / `#ff7a66` | 11,74:1 / 7,18:1 |
| foco | anillo amarillo de 3 px | 12,98:1 |

Tipografías: Anton (títulos, en mayúsculas) + sistema. Radios: 0. Sombras: `8px 8px 0 #ffd60a` en el panel,
`4px 4px 0 #ff5a2b` en los botones. Espaciado: relleno 22 px (16 px en celular), texto de 15 px.

**Lo que es distinto de la plantilla actual:** todo. Es el cambio más grande y el más fácil de reconocer.

**Riesgos:** cansa si se usa mucho tiempo; como la página se ve unos segundos antes de jugar, no parece un
problema. La cinta de peligro puede leerse como "advertencia" y no como "bienvenida". Las mayúsculas del título
dificultan leer los nombres de servidor si son largos (en la entrada con borde punteado se ve cómo quedan).

## C · Terminal táctica

> **Una consola de operaciones: monoespaciada, ámbar sobre negro, con esquinas de mira y datos en tabla.**

La más sobria y la más cercana a una pantalla de "briefing". Todo el texto es monoespaciado; los títulos llevan un
prompt (`>`) y un cursor que parpadea, los subtítulos son comentarios (`//`), las etiquetas van en mayúsculas
chicas con espaciado, y cada panel tiene cuatro esquinas ámbar de mira. Los botones secundarios se ven como
`[ Elegir carpeta… ]`. El fondo tiene líneas de barrido muy tenues.

**Peso:** una familia monoespaciada, **JetBrains Mono** (OFL; estimo unos 50 KB en woff2 para dos pesos, a
confirmar al bajarla). En la maqueta se ve con Cascadia Mono/Consolas.

| Token | Valor | Contraste |
|---|---|---|
| `--bg` fondo de página | `#070a08` | — |
| `--panel` | `#0c110e` | texto 12,64:1 · secundario 6,86:1 |
| `--text` / `--muted` | `#c9d6c7` / `#8da08f` | AAA / AA |
| `--accent` / `--accent-ink` | `#ffb224` / `#140d00` | 10,57:1 · tinta sobre acento 10,71:1 |
| `--ctl` borde de control | `#5c8a6b` | 4,81:1 |
| `--line` borde decorativo | `#2f4a38` | 1,96:1 (solo decoración) |
| `--ok` / `--err` | `#62e88a` / `#ff6a5a` | 12,18:1 / 6,77:1 |
| foco | anillo ámbar de 2 px | 10,57:1 |

Tipografías: JetBrains Mono. Radios: 0. Sombras: `0 24px 60px #000c` solo en los paneles (estática, y no se ve
al jugar); el cartel y el toast llevan solo un contorno negro de 1 px, sin desenfoque, porque van sobre el canvas.
Espaciado: relleno 22 px (16 px en celular), texto de 14 px. En 390 px el cartel de invitación ocupa dos filas
(los botones en mayúsculas monoespaciadas son más anchos).

**Lo que es distinto de la plantilla actual:** mantiene el ámbar, pero cambia la forma entera (cuadrada, mono,
esquinas). Es la más parecida a la actual y, por eso, la más fácil de que se sienta "una mejora" y no "otro sitio".

**Riesgos:** las tipografías monoespaciadas ocupan más ancho (los textos largos de las casillas se parten más en
celular). El cursor parpadeante es lo único que se anima y se apaga con `prefers-reduced-motion`; se puede quitar.

---

## Comparación rápida

| | A · VGUI | B · Flyer | C · Terminal |
|---|---|---|---|
| Se parece a… | el menú de CS 1.6 | un afiche de LAN | una consola de operaciones |
| Nostalgia para el público | muy alta | alta | media |
| Personalidad | alta | muy alta | media |
| Cambio respecto de hoy | grande | enorme | moderado |
| Fuentes a servir | ninguna | 1 (Anton) | 1 (JetBrains Mono) |
| Texto cómodo en celular | bueno | bueno | justo |
| Riesgo de cansar | bajo | medio | bajo |

## Mi recomendación (opinión, no es la decisión)

Partir de **A** como base: es la que mejor conecta con quien jugó CS 1.6, no pesa nada y pasa todos los
contrastes. Hay dos mezclas que funcionan bien:

- **A + B**: ventanas VGUI, pero con el titular condensado de Anton y la barra de carga de rayas amarillas.
- **A + C**: ventanas VGUI, pero con la tabla de datos de la partida en monoespaciada (como el contador de
  jugadores de GameTracker) y las esquinas de mira solo en el cartel de invitación.

La decisión es tuya; hasta que elijas no toco `client/style.css` ni los `index.html`.

---

## Prueba de A y B en las páginas reales (etapa 3, a medias)

Pediste probar **A y B** para ver cuál gusta más, así que las dos están implementadas en la rama `diseno-ui` y se
eligen con un parámetro de la URL. Todavía no se descartó ninguna.

**Cómo verlas**

```bash
npm run dev:pages
```

- <http://localhost:5173/?tema=a> → Steam 2003 / VGUI (la que se ve por defecto)
- <http://localhost:5173/?tema=b> → Flyer de LAN party

El tema elegido se recuerda en ese navegador (`localStorage`, clave `csweb:tema`). Funciona también con un link de
partida: `…/?tema=b#K7Q2MX`. La página LAN (`client/index.html`) usa los mismos dos temas. `?perfil=nombre` sigue
separando el almacenamiento entre pestañas.

**Qué cambió en el código**

| Archivo | Cambio |
|---|---|
| `client/style.css` | Ahora es solo la **estructura** (tamaños, posiciones, estados) y usa variables. Importa las dos pieles. |
| `client/skin-a.css`, `client/skin-b.css` | Una piel cada una, anidadas bajo `html:not([data-tema="b"])` y `html[data-tema="b"]` (CSS anidado; Vite lo aplana al construir). |
| `client/fonts/anton-latin.woff2` y `anton-OFL.txt` | Anton, subconjunto latino, 18,6 KB, licencia OFL 1.1, bajada de Google Fonts y servida desde el repo. Va en `client/fonts/` y no en `client/p2p/public/` porque la hoja la comparten las dos páginas. |
| `client/index.html`, `client/p2p/index.html` | Un `<script>` en el `<head>` que lee `?tema=`, fija `data-tema` en `<html>` y ajusta `theme-color` y el favicon al acento de cada piel. Los `id`, las clases y los `hidden` que usa TypeScript no se tocaron. |
| TypeScript | **Ningún cambio.** `main.ts` sigue importando `style.css`. |

**Qué verifiqué**

- `npx tsc -p tsconfig.json`, `npm run build:pages` y `npm run build` terminan sin errores.
- En `npm run dev:pages` y en el bundle de producción (`preview:pages`): carga la piel A y la B, Anton se descarga y se
  aplica, y no hay errores en consola.
- Forcé cada estado desde la consola (inicio, unirse desde un link, carga determinada e indeterminada, error con
  aviso y diagnóstico, opciones abiertas, y juego con cartel de invitación y toast) en las dos pieles. La página LAN
  la miré en las dos pieles.
- A 360 px de ancho, en las dos pieles y en los cinco estados: `scrollWidth` = ancho de la ventana (sin scroll
  horizontal), ningún elemento se sale de pantalla, y botones, campos, filas de casilla y `<summary>` miden 40 px o más.

**Qué NO verifiqué** (hace falta que lo hagas vos)

- **Un recorrido real de crear una partida o unirse.** No tengo los archivos del juego (no existe la carpeta
  `steamapps/`) ni un segundo jugador. Lo que sí confirmé es que no se tocó ningún `id`, clase ni atributo `hidden`
  que use el código.
- Firefox y Safari. Probé en el navegador de la app (Chromium). El CSS anidado se aplana al construir para
  `build:pages`, pero en `dev:pages` lo interpreta el navegador tal cual.
- Una partida con el canvas del juego a pantalla completa: el cartel y el toast se ven bien sobre un fondo negro,
  pero no sobre imagen real del juego.

**Cuando elijas**, hay que borrar la piel descartada, desanidar la elegida, sacar el script de `?tema=` de los dos
`<head>` y actualizar `theme_color`/`background_color` de `client/p2p/public/manifest.webmanifest` y el
`icon.svg` (hoy sigue con el naranja anterior) al acento ganador.
