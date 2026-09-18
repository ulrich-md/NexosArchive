# Archivo Nexos
Buscador conversacional interno sobre el archivo completo de la revista mexicana **Nexos** (1970–2026).
Usuarios: editores y redacción de Nexos. No es un producto para público general.
Todo el producto —interfaz, copy, mensajes de error— en **español de México**.
---
## 0. Estado del proyecto y por qué existe este repo
Existe una versión previa hecha con Lovable, desplegada en `https://archivonexos.online/`.
**El diseño de esa versión es correcto y se conserva.** Lo que falló es la capa de datos:
la ingesta desde WordPress quedó incompleta y corrupta, y las consultas no responden.
Este repo es la reconstrucción. Dos reglas que ordenan todo lo demás:
1. **El diseño no se rediseña.** Se replica y se pule. La sección 3 lo especifica al pixel.
2. **La ingesta es el producto.** El 80% del esfuerzo real está en traer TODOS LOS ARTICULOS DE NEXOS
   completos, limpios y con su metadata correcta. El chatbot es la capa fácil.
### Qué falló en la versión de Lovable (no lo repitas)
| Síntoma verificado | Causa probable | Qué exige de esta versión |
|---|---|---|
| Dice "19,142 textos" — el total real de la API es **19,145** | La paginación perdió filas en el camino | Reconciliación explícita contra `X-WP-Total` al final de cada sync |
| Dice "1970–2026" pero Nexos se fundó en **1978** | Hay fechas basura (posts con `date` mal migrado) que arrastran el mínimo | Validar rango de fechas y marcar outliers, no dejarlos definir el rango visible |
| Autores: "Ricardo Bada 500", "La Redaccion 440" sin acento | Sin normalización de nombres ni decodificación de entidades | Normalizar y deduplicar autores; decodificar entidades HTML |
| Al enviar una consulta el input se vacía y **no pasa nada**; la pestaña se congela ~30s | La query no tiene índice y/o trae miles de filas al cliente | Toda consulta paginada y con índice; timeout y estado de error visible |
| Sin errores en consola | Falla silenciosa en el backend | Toda Edge Function devuelve error tipado que la UI muestra |
---
## 1. Objetivo
`/goal` — Que un editor de Nexos pueda interrogar 56 años de la revista y obtener,
en menos de cinco segundos, artículos **reales** con su ficha completa y su liga,
sin que el sistema invente jamás un título, un autor o una fecha.
### Criterios de aceptación (esto es lo que "terminado" significa)
- `SELECT count(*) FROM articulos` = **19,145** ± 5, reconciliado contra `X-WP-Total`.
- Los conteos por año coinciden con la API dentro de ±2, **los 49 años, no una muestra**.
  ⚠️ Los números que traía este spec (1988 → 246, 1994 → 283, 2006 → 307) **estaban mal**:
  salieron de consultar `after=YYYY-01-01T00:00:00`, y como `after` es EXCLUSIVO, descarta
  todo artículo fechado exactamente a medianoche del 1 de enero — que es justo como quedó
  migrado el archivo impreso viejo (45 artículos solo en 1988). Los valores reales son
  **1988 → 291, 1994 → 305, 2006 → 335**; 2016 → 568 y 2024 → 463 sí eran correctos, porque
  los posts modernos traen hora real y no medianoche exacta. Ajustar los datos para que
  cuadraran con los números viejos habría **borrado 95 artículos reales**. `npm run verificar`
  ya no usa constantes: le pregunta a la API año por año con la ventana correcta
  (`after=<Y-1>-12-31T23:59:59` … `before=<Y+1>-01-01T00:00:00`).
- Ningún título contiene `&#8211;`, `&amp;`, `&#8220;` ni ninguna otra entidad HTML.
- Ningún artículo con `fecha_pub` anterior a 1978-01-01 salvo que se verifique a mano.
- Las tres consultas de ejemplo de la home devuelven resultados en < 5 s.
- Ningún artículo mostrado con autor inventado. Sin autor ⇒ literal `autor no consignado`.
- `curl` con la anon key contra `/rest/v1/articulos` devuelve **0 filas**.
---
## 2. Fuente de datos — WordPress de Nexos
Base: `https://www.nexos.com.mx/wp-json/wp/v2/`
**Verificado el 2026-09-07:**
- `GET /posts?per_page=1` → header `X-WP-Total: 19145`
- Campos útiles y públicos: `id, date, link, title, coauthors, categories`
- **El cuerpo del artículo está tras el paywall.** Sin autenticar, `content` y `excerpt` vienen **vacíos** y `class_list` incluye `access-restricted` / `membership-content`.
- `/wp/v2/users` → **401**, y `_embed=author` devuelve `rest_user_invalid_id`.

### ⚠️ EL ARCHIVO NO ESTÁ EN UN SOLO SITIO: son 27 WordPress (2026-09-08)

`www.nexos.com.mx` tiene 19,145 artículos, pero **Nexos publica además en 26
subdominios**, cada uno con su propio WordPress y su propia API. Verificado:

| | artículos |
|---|---|
| www.nexos.com.mx | 19,145 |
| **26 subdominios** | **14,479** |
| **TOTAL** | **33,624** |

Los más grandes: `cultura` (4,216), `redaccion` (2,129), `eljuegodelacorte`
(2,098), `poemas` (996), `educacion` (617), `jorgegcastaneda` (563),
`angelesmastretta` (557), `economia` (522), `seguridad` (455), `josewoldenberg`
(449), `anticorrupcion` (426), `aguilarcamin` (342), `federalismo` (331).

**Y esto resuelve el problema del contenido:** la API de los subdominios
devuelve `content.rendered` COMPLETO, sin paywall y sin credenciales (medido:
entre 718 y 15,748 caracteres). El paywall solo cubre el archivo viejo del
sitio principal.

Dos cosas que hay que resolver antes de ingerirlos:

1. **Los ids chocan.** Cada WordPress tiene su propio espacio de ids, así que
   `id` de WordPress ya no identifica un artículo: la identidad real es
   `(sitio, id_wp)`. La regla del spec "nunca generar un id propio" se escribió
   suponiendo un solo sitio.
2. **Hay duplicación parcial y desigual.** Medido sobre 12 títulos de cada uno:
   `angelesmastretta` 10/12 ya estaban en la base, pero `aguilarcamin` y
   `redaccion` 0/12. Hay que deduplicar por título o por slug, nunca por id.

### ⚠️ EL PAYWALL DE www NO CUBRE TODO EL ARCHIVO (2026-09-09)

El spec afirma arriba que en www "el cuerpo del artículo está tras el paywall",
sin matices, y por eso el enriquecimiento con cuerpo excluía el sitio principal.
Medido sobre una muestra de 1,945 artículos repartida por las 192 páginas del
archivo, el paywall cubre lo impreso y se abre en lo reciente:

| década | con cuerpo público |
|---|---|
| 1980s | 0% |
| 1990s | 1% |
| 2000s | 3% |
| 2010s | 25% |
| 2020s | 54% |

No es una frontera por año —2009 sale entero, 2011 nada, 2015 y 2020 abiertos—,
así que no se puede decidir por fecha: hay que pedir el cuerpo y ver.
`npm run enriquecer -- --con-cuerpo --solo-con-cuerpo` hace justo eso, y saltar
los tapados deja la cuota para los que sí traen texto.

Resultado: 2,641 artículos de www catalogados leyendo el artículo, que se
estaban resolviendo solo por su título por una suposición que nadie comprobó.

### Cómo sale gratis el enriquecimiento (2026-09-09)

El 429 de la cuota de Gemini dice
`GenerateRequestsPerDayPerProjectPerModel-FreeTier`: la cuota es por proyecto Y
POR MODELO, y cuenta PETICIONES, no tokens. De ahí dos palancas que se
multiplican y vuelven gratis una corrida que costaba ~$10:

- **Lotes grandes.** 150 artículos con su cuerpo caben de sobra (medido: 120k
  tokens de entrada y 17k de salida, contra límites de 1M y 65k). Los 13,797
  subdominios pasaron de ~1,380 peticiones a 99.
- **Varios modelos.** Siete modelos flash responden con la misma llave, cada uno
  con su propio cupo.

Tres trampas medidas, no supuestas:
1. `maxTokens` estaba clavado en 16,000, así que cualquier lote de más de ~45
   artículos llegaba truncado y se partía en dos, gastando justo las peticiones
   que se querían ahorrar.
2. Tres de los siete modelos rechazan `thinkingConfig` con un 400 sin explicar.
   Se detecta al primer rechazo y se reintenta sin él.
3. Hay un techo de TOKENS POR MINUTO además del de peticiones: dos lotes de 150
   en paralelo lo rebasan y provocan 429 constantes. Concurrencia 1.

Con lotes de 150 el modelo omite ~7% de los artículos —deja de escribir antes de
cerrar el arreglo, sin que sea truncamiento por max_tokens—. No se pierden: no
quedan marcados en la bitácora y una segunda pasada con lotes de 50 los recoge.

### Corrección del spec — reconocimiento contra la API en vivo (2026-09-07)

Varias afirmaciones del spec original resultaron falsas al contrastarlas con la API.
Lo que sigue está verificado y es lo que implementa el código; **no volver a la
versión anterior de estos supuestos.**

| Supuesto del spec | Realidad verificada |
|---|---|
| Los `coauthors` numéricos no se pueden resolver sin credenciales | **`/wp/v2/coauthors` responde 200** y es una taxonomía pública con **3,447 términos**. Resuelve los IDs sin autenticar. |
| El archivo impreso (1978–2005) no trae autor | **Sí trae `coauthors`.** Los posts de enero de 1978 ya tienen autor (ids 45, 3236, 3237). |
| Hay ~600 categorías | **752 categorías.** |
| Los números de revista tienen forma `"AAAA Mes"` | Existen en **dos** formas: `"1978 Enero"` (id 4) y **también solo el año**, `"1978"` (id 3). Las dos son número de revista; tratar la segunda como sección contamina el campo `seccion`. |
| Hay fechas basura que arrastran el rango a 1970 | Son **exactamente 2 posts** (ids 12920 y 12921, ambos `1970-01-01`). Los dos pertenecen al número **"2009 Febrero"**, así que su fecha real se recupera del número. |
| Los títulos traen entidades HTML (`&#8211;`) | En la muestra revisada, **0% entidades pero 14% etiquetas HTML** (`<em>` en títulos de obras). Hay que quitar etiquetas además de decodificar entidades. |

**La API oculta más de la mitad de los autores; la página del artículo sí los trae.**
`/wp/v2/posts` deja `coauthors` vacío en el 51% del archivo, y en otra parte lo llena
con firmas que no son personas: `nexos` y `Nexos` (la misma firma institucional
duplicada por mayúscula) y `4dm1n`, que es un usuario del CMS. Pero la página pública
del artículo trae la firma real en `<div class="el-autor">`. Verificado:
`nexos.com.mx/fox-y-otras-percepciones/` sale sin autor en la API y firmado por Ulises
Beltrán en la página. `npm run recuperar-autores` la extrae y marca
`autor_confianza='extraido'`.

Resultado medido: la cobertura de autoría pasó de **49% a 92%** (7,426 de WordPress +
10,143 extraídos). Por década, 1988-1997 pasó de 9% a 94%.

Dos reglas que salieron de conflictos reales entre las dos fuentes:
1. **La página nunca sobrescribe un nombre que ya venía de WordPress.** En un artículo
   WP dice "Luz Esperanza Yarsa" y la página dice "Yasna": no hay forma de saber cuál
   es la buena sin que alguien lo revise, así que se conserva la de WP.
2. Los títulos y las firmas se reproducen **fieles aunque traigan errores** de Nexos
   (una página firma "Franco Basaglia Ongaro" donde la persona es Franca). Corregirlos
   sería inventar.

⚠️ Ojo al construir perfiles de autor: antes de esta recuperación, tanto Aguilar Camín
como Mastretta mostraban un "silencio" de once años (1978→1989). Era el hueco de
metadata de los ochenta, no biografía. Un perfil debe hablar **del registro del
archivo**, nunca de la vida del autor.

**Los subdominios firman de tres maneras distintas, y suponer la de www inventa
autores** (2026-09-08). La primera pasada de recuperación sobre los subdominios
escribió 675 filas con autores que no existen y hubo que revertirlas. Las tres:

1. **Enlaces `/author/{slug}/`** dentro de `.el-autor`, en 12 subdominios. Hay
   que leer cada `<a>` por separado: el tema une dos firmas con `" and "` —en
   inglés— y decodificar el bloque entero produce una persona inexistente
   llamada `"Sofia Marquez and Cultura Nexos"`.
2. **Texto plano** en `.el-autor`: es lo de www y lo de los blogs de autor.
3. **`<span class="el--autor-header-nexos">`** dentro del `h1`: es lo de
   `poemas`, donde `.el-autor` viene **vacío**. Sin este caso los 996 poemas del
   archivo se quedan sin autor. `"Anónimo"` se conserva: es como el archivo
   atribuye el poema, no un hueco que estemos rellenando.

**`cultura` y `eljuegodelacorte` cuelgan la cuenta del propio blog junto al autor
real** (`"Cultura Nexos"`, `"Juego de La Nueva Suprema Corte"`). Guardarlas
inventaría personas con miles de artículos en el índice del sidebar.
`npm run firmas-sitio` las deduce en vez de escribirlas a mano, por dos reglas:
que el slug sea el del sitio, o que el nombre sea el que el blog se da en
`/wp-json/`. El resultado se versiona en `datos/firmas-institucionales.json`
porque es una decisión sobre quién es persona, no un caché.

⚠️ **La frecuencia NO sirve para detectarlas**, aunque lo parezca: medido,
`justicia` firma 7 de 30 en `eljuegodelacorte` y `cultura` 16 de 30, así que un
umbral de presencia las deja pasar; y bajarlo borraría a Octavio Gómez Dantés,
que firma los 25 artículos de `salud` porque es su blog.

**Los nombres de autor no vienen con acentos en la API.** `/wp/v2/coauthors` devuelve
`name` en forma slug (`"carlos-monsivais"`). El nombre real solo existe en la página
pública del autor, `https://www.nexos.com.mx/author/{slug}/`, cuyo `<h1>` viene como
`"Nexos • Carlos Monsiváis"`. Reponer los acentos a mano sería inventar datos
(sección 7), así que se recuperan de ahí. `npm run autores` construye ese mapa y lo
cachea en `datos/autores.json`; es reanudable y tarda ~17 min.

**Segunda trampa: el WordPress de Nexos emite JSON inválido.** No siempre, pero
pasa: en `cultura.nexos.com.mx`, los artículos en las posiciones 3965 y 3996 traen
en el cuerpo una comilla sin escapar (`la práctica de "reseñar"`) que rompe la
respuesta entera. Se ve como una respuesta cortada y **no es un fallo de red**:
reintentar devuelve byte por byte lo mismo. La señal para distinguirlas es el
tamaño —dos cuerpos idénticos no son un corte de transporte—, y `fetchJson` marca
ese caso como `jsonInvalido`. La ingesta de subdominios parte el lote a la mitad
hasta aislar al artículo culpable y a ese le pide la metadata sin `content`: se
conserva el artículo, se pierde solo su indexación por cuerpo, y queda contado en
`sin_indexar`. Pedir la página completa de 25 y rendirse habría costado 25
artículos por cada uno roto.

**Trampa de entorno:** el `fetch` global de Node **no lee `HTTPS_PROXY`** (curl sí).
Detrás de un proxy de salida obligatorio, todas las peticiones fallan con 403 sin
explicación. `scripts/lib/red.ts` instala el `EnvHttpProxyAgent` de undici y debe
importarse antes de cualquier fetch; en local, donde no hay proxy, no hace nada.

**Conteos por año confirmados contra la API**, exactos, sin desviación:
1988 → 246, 1994 → 283, 2006 → 307, 2016 → 568, 2024 → 463.
### Las dos fases
**Fase 1 (ahora, sin credenciales).** Metadata pública de los 19,145 artículos:
título, fecha, liga, número, autor cuando exista. Con esto ya funcionan los modos
Catálogo y Panorama sobre el archivo real completo.
**Fase 2 (requiere Application Password de Nexos).** Cuerpo del artículo, chunking,
embeddings y búsqueda semántica. Prueba que decide si la fase 2 es viable:
```bash
curl -u "usuario:app_password" \
  "https://www.nexos.com.mx/wp-json/wp/v2/posts?include=5029&_fields=content"
```
Si devuelve el cuerpo, la fase 2 procede. Si sigue vacío, hay que pedir un dump de `wp_posts`.
**No bloquees la fase 1 esperando esto.** El código de fase 2 se escribe detrás de una bandera.

Nota (2026-09-07): el usuario del proyecto tiene una cuenta **Nexos Plus** (suscripción de
lector, evita el paywall al navegar el sitio). Eso **no** es lo mismo que un Application
Password de WordPress para la REST API — habría que verificar con Nexos si esa cuenta
puede generarse un Application Password, o si hace falta pedir credenciales de API aparte.
No asumir que la suscripción por sí sola desbloquea `content` en `/wp-json`.
### `resumen_linea IS NULL` no significa "pendiente" (2026-09-16)

Un reporte de avance contó cuántos artículos de `www` tenían `resumen_linea` vacío
y lo llamó "faltan 1,480". Es falso: la cifra real de artículos que **nunca han
pasado por el enriquecimiento** era **87**. La diferencia, 1,393 artículos, ya
fueron procesados por el modelo —tienen `temas` y a veces `tipo_texto`— pero son
poemas, aforismos o notas cortas donde no hay materia para un resumen de una
línea, y el código los deja así **a propósito**, por la regla anti-alucinación
de la sección 7 (nunca inventar un resumen que no existe). `estaVacio()` en
`scripts/lib/enriquecimiento.ts` solo marca un artículo como `'vacio'` en la
bitácora si **los cuatro campos** (resumen, temas, años, tipo) salen vacíos; si
el modelo llenó aunque sea uno, queda `'ok'` con `resumen_linea` en null a
propósito.

Consecuencia práctica que costó tiempo: subir más exports XML de esos años no
ayuda si el verdadero cuello de botella no es falta de cuerpo, sino artículos ya
catalogados sin resumen. Antes de pedir más datos de entrada, hay que confirmar
contra la bitácora (`datos/enriquecidos.jsonl`), no contra la columna.

**La única fuente de verdad sobre qué falta procesar es la bitácora, nunca la
columna `resumen_linea` por sí sola.** `npm run cobertura` calcula el backlog
real (por sitio y por año) cruzando `articulos` contra `datos/enriquecidos.jsonl`,
y es lo que hay que correr en vez de armar un script desechable cada vez.

### Reglas de ingesta (aquí es donde falló Lovable)
- Paginar `?per_page=100&page=N`. Son ~192 páginas. Guardar `X-WP-TotalPages` al inicio.
- **Reanudable**: persistir `ultima_pagina` después de *cada* página, no al final.
- 300 ms entre requests. Nunca golpear en paralelo el servidor de Nexos.
- `upsert` por `id` de WordPress. Nunca generar un id propio.
- **Decodificar entidades HTML** en `title.rendered`. Los títulos de Nexos usan comillas
  tipográficas y guiones largos; si salen `&#8211;` la ingesta está mal.
- Reintento con backoff exponencial en 5xx y 429. Un fallo no puede matar el sync.
- `rest_post_invalid_page_number` (400) significa que terminaste, no que fallaste.
- **Al terminar, reconciliar**: comparar el count local contra `X-WP-Total` y reportar
  la diferencia. Si no cuadra, decirlo fuerte en `/admin`, no esconderlo.
- Preferir un **script de Node ejecutado localmente** para la carga inicial completa,
  no una Edge Function. Las Edge Functions tienen timeout y esto tarda ~15 minutos.
  La Edge Function queda para el sync incremental diario (`?modified_after=`).
---
## 3. Diseño — replicar exacto, luego pulir
Referencia viva: `https://archivonexos.online/`. Tokens extraídos del CSS de producción.
### Tokens (usar estos valores literales)
```css
:root {
  --background: #f6f8f9;
  --surface: #ffffff;
  --foreground: #0c1a20;
  --muted-foreground: #3b4e56;
  --muted: #eef2f4;
  --border: #dce4e7;
  --primary: #018fbd;
  --primary-foreground: #ffffff;
  --primary-soft: #018fbd1a;
  --destructive: #a33127;
  --sidebar: #f1f4f6;
}
.dark {
  --background: #0b1418;
  --surface: #111e23;
  --foreground: #e6eef1;
  --muted-foreground: #94a8b1;
  --muted: #16262c;
  --border: #22343b;
  --primary: #3cb6dc;
}
```
### Tipografía
- **Newsreader** (serif) — títulos y el texto de las respuestas. El h1 va en **weight 400**, ~38px. Es serif con peso normal: no lo pongas en bold.
- **IBM Plex Sans** — interfaz, cuerpo, botones.
- **IBM Plex Mono** — metadatos, cifras, IDs, contadores, la línea de ayuda bajo el input. Siempre `font-variant-numeric: tabular-nums`.
### Layout
**Sidebar izquierda (~315px, colapsable con un botón en la esquina superior derecha del sidebar):**
- Logo `nexos` arriba: **el archivo real de Nexos** (`web/public/logo-nexos-blue.jpeg`, cuadrado, 375×375, azul de marca ya incluido en el jpeg), no una recreación en CSS — corregido 2026-09-16 tras pedido explícito del dueño ("usa el logo exacto, esta imagen"). `border-radius: 3px` aplicado por fuera de la imagen. Nunca otro logo, nunca animado.
- Botón `+ Chat nuevo`, ancho completo, borde 1px, fondo surface.
- Label en mono con tracking amplio: `EXPLORAR EL ARCHIVO`
- Input de filtro con icono de lupa: `Filtrar autores y secciones`
- Tres pestañas: `Autores` · `Secciones` · `Décadas`. La activa con fondo `--primary` y texto blanco; las inactivas en texto plano.
- Lista scrolleable de resultados: nombre a la izquierda, conteo en mono a la derecha.
- Label `CONVERSACIONES` y, si no hay sesión: "Inicia sesión para conservar tus conversaciones." + nota en mono: "Se guardan solo en este navegador y se eliminan a los 7 días por costo de almacenamiento."
- Al fondo: botón `Guardar conversaciones / Inicia sesión con Google`, y ligas `nexos.com.mx ↗` y `Administración`.
**Panel principal (centrado, máx ~760px):**
- Logo `nexos` grande, centrado.
- h1 en Newsreader 400: saludo según la hora — `Buenos días,` / `Buenas tardes,` / `Buenas noches, ¿qué te gustaría consultar hoy?`
- Subtítulo en mono: `1978–2026 · 19,145 textos` (corregir el rango y el conteo).
- Input grande abajo, borde 1px, radius 8px, placeholder `Pregúntame`, botón circular `--primary` con flecha arriba a la derecha, deshabilitado si está vacío.
- Bajo el input, dentro de la misma caja, línea en mono: `Solo responde con lo que existe en el archivo de la revista, 1978–2026`
- Toggle de tema claro/oscuro arriba a la derecha (icono luna).
### Mejoras sobre la versión de Lovable
1. **Estados visibles.** Skeletons sobrios mientras carga, y si la consulta falla o tarda más de 10 s, un mensaje que dice qué pasó y ofrece reintentar. Nunca vaciar el input sin dar respuesta — ese es el bug más grave que tiene hoy.
2. **La lista de autores del sidebar hoy carga vacía** (esqueletos permanentes). Debe cargar en menos de 1 s desde una vista materializada, no contando 19 mil filas en vivo.
3. **Traza de recuperación** colapsable sobre cada respuesta: "Consultó el archivo · 3 pasos", con los pasos unidos por una línea vertical de 1px, iconos de `lucide-react`, y detalle expandible en mono. Un editor no confía en una caja negra; sí confía en algo que le enseña de dónde salió cada resultado.
4. **Tres chips de modo** bajo el input: `Panorama` · `Buscar` · `Catálogo`, uno activo a la vez. Ver sección 4.
5. **Ficha de artículo** como componente único y reutilizable: título en Newsreader que liga a nexos.com.mx (`target="_blank" rel="noopener"`), y debajo en mono pequeño `autor · fecha · número`. Sin sombras, sin radios grandes: es una lista editorial, no un dashboard.
6. **Tres ejemplos clicables** en el estado de reposo:
   - `¿Qué se ha escrito en Nexos sobre el 2006?`
   - `Artículos de 1988 sobre fraude electoral`
   - `Todo lo que publicó Ángeles Mastretta en los noventa`

### Sin chips de modo, sidebar sin login para guardar, ritmo del "pensando" (2026-09-18)

Dos correcciones a lo de arriba, pedidas explícitamente tras verlo en vivo:

- **La mejora 4 ("tres chips de modo") ya no existe.** El dueño pidió "que no
  haya diferentes modos de búsqueda": el router de la sección 4 sigue
  clasificando internamente (`panorama`/`hibrida`/`catalogo`), pero eso nunca
  se expone al editor — ni como chip, ni como etiqueta en la traza, ni en el
  texto de la respuesta. Un editor hace una pregunta; el carril es un detalle
  de implementación.
- **Los filtros desplegables bajo la lista de artículos** (`Autor…` /
  `Sección…` / `Década…`, un componente aparte de las pestañas del sidebar)
  se quitaron: duplicaban exactamente lo que ya hacen las pestañas
  `Autores` · `Secciones` · `Décadas` de la sección 3, y con dos caminos para
  lo mismo el visualmente más débil (el `<select>` nativo, bajo contraste)
  perdía sentido en vez de arreglarse.
- **Las conversaciones ya no dependen de iniciar sesión.** Se guardan solas
  en `localStorage` de ese navegador (mismos 7 días de retención que ya
  describía el spec, ahora aplicados siempre, no solo prometidos si había
  sesión) y se restauran al volver a abrir la pestaña. El bloque
  `CONVERSACIONES` / "Inicia sesión para conservar tus conversaciones" y el
  botón grande "Guardar conversaciones / Inicia sesión con Google" se
  quitaron del todo: Google queda como una liga chica junto a
  `nexos.com.mx ↗`, al fondo del sidebar — una opción menor, no la puerta de
  entrada (coherente con la decisión de ACCESO_ANONIMO de la sección 6: la
  sesión nunca fue la llave del archivo).
- **El "pensando" y la traza colapsada van más lento y gradual** (pedido
  explícito: "que no te lleve hasta abajo... que vaya bajando de forma
  natural" ya se había resuelto antes; esta vuelta fue sobre el ritmo de la
  animación en sí). Antes cambiaban de frase cada 480 ms/2.2 s con un salto
  seco; ahora cada swap funde con `animar-aparecer-lenta` (~0.9 s) sobre un
  ritmo de ~3 s por paso — se lee como el "pensando" gradual de un chat, no
  como una notificación parpadeando.
- **`CATALOGO_POR_PAGINA` bajó de 10 a 4** (`supabase/functions/buscar/config.ts`):
  la lista de artículos abre mostrando 4 y pagina el resto, en vez de una
  primera pantalla larga.
---
## 4. Los tres modos de consulta
El error de arquitectura más caro sería mandar todo al mismo pipeline de RAG.
Un router clasifica la intención y elige el carril.
**`panorama`** — "¿Qué se ha escrito sobre el 2006?"
No busca fragmentos. Consulta metadata en SQL, trae 200–400 filas
(título, autor, fecha, `resumen_linea`), y **un solo** llamado al LLM las agrupa
en 3–6 temáticas concretas y redacta la síntesis. Cabe de sobra en contexto (~16k tokens).
**`hibrida`** — "Artículos de 1988 sobre fraude electoral"
Vectorial (entiende que "fraude" ≈ "caída del sistema") + texto completo en español,
fusionados con **Reciprocal Rank Fusion**, no con suma ponderada a mano.
Filtros duros de año y autor **antes** del ranking. Rerank de top 40 a top 8.
Requiere fase 2.
**`catalogo`** — "Todo lo de Aguilar Camín en los noventa"
Es una consulta SQL, no una pregunta. **Cero LLM.** Debe responder en < 100 ms.
Mandar esto al RAG es pagar latencia por un `WHERE`.
### Dos nociones de año que NO son lo mismo
- `anio_pub` — cuándo se **publicó** el texto.
- `anios_referidos` — de qué época **habla** el texto.
"Qué se escribió sobre el 2006" usa `anios_referidos`. Lo mejor que Nexos publicó
sobre 2006 salió en 2016 y en 2021. Filtrar por `anio_pub` se comería exactamente
los textos que el editor quiere. Ante la duda, no acotar la publicación.

### El escalón 3 del router (Gemini) fallaba siempre, en silencio (2026-09-17)

`ESQUEMA_ROUTER` declara `anio_pub_desde`/`anio_pub_hasta` como
`type: ['integer', 'null']` — válido en JSON Schema, y así es como se escribe
un campo nulable en el `input_schema` que antes usaba Anthropic. Pero
`responseSchema` de Gemini no acepta `type` como arreglo: la petición
truena con 400, `"Proto field is not repeating, cannot start list"`
(confirmado llamando a la API real con el esquema exacto, no una hipótesis).

Consecuencia: cada vez que la heurística (escalón 2) no resolvía la consulta
y le tocaba a Gemini clasificarla, la llamada fallaba, el router degradaba a
reglas simples y lo avisaba en la traza ("El clasificador falló") — pero
nadie leyó esa traza como sistémica hasta verlo repetirse en vivo. El escalón
3 probablemente **nunca funcionó** desde que se escribió.

Se arregla en `aEsquemaGemini()` (`gemini.ts`), el transformador genérico que
ya podaba palabras clave que Gemini no soporta: ahora además convierte
`type: [X, 'null']` en `type: X, nullable: true` para cualquier esquema, no
solo el del router. Prueba de regresión en `pruebas.test.ts`.

Lección: un aviso en la traza que dice "degradó a reglas" es correcto pero no
es suficiente para notar un fallo sistémico — hay que mirar el `detalle` real
del error, no solo el mensaje genérico. `router.ts` también perdía ese detalle
(guardaba `error.message`, no `error.detalle`) y quedó corregido en el mismo
cambio.

### Rotación de modelos en vivo, no solo en el enriquecimiento (2026-09-17)

Con el bug de arriba corregido, el router en producción seguía degradando:
la cuota gratuita de Gemini es de **20 peticiones al día por modelo**, y con
un solo modelo (`gemini-2.5-flash`) eso se agota rápido en uso real, mucho
antes de que termine el día. `scripts/enriquecer.ts` ya resolvía esto para el
enriquecimiento masivo rotando entre siete modelos flash; `gemini.ts`
(`supabase/functions/buscar/`) ahora hace lo mismo para el router, panorama y
el rerank de fase 2, que antes llamaban cada uno a un solo `MODELO_*` fijo.

`llamarConHerramienta` recibe `modelos: string[]` (antes `modelo: string`) y
prueba la lista en orden: si un modelo devuelve 429 de cuota DIARIA, se marca
agotado para el resto de la vida del isolate y se prueba el siguiente; un 429
por MINUTO no marca el modelo, porque se pasa solo. Ningún otro tipo de error
(esquema roto, respuesta inválida, llave mala) mueve al siguiente modelo: se
repetiría igual, así que se corta ahí y se avisa de una vez, en vez de gastar
cuota de seis modelos más en un error que no es de cuota.

Verificado en vivo, no solo por tipos: con `gemini-2.5-flash` ya agotado por
las pruebas del día, una llamada real a `llamarConHerramienta` saltó sola a
`gemini-3-flash-preview` y respondió bien.

`MODELOS_GEMINI` (`config.ts`) reemplaza a `MODELO_ROUTER`/`MODELO_SINTESIS`/
`MODELO_RERANK`, que apuntaban los tres al mismo modelo de todos modos.

### Seguimiento de conversación: solo el turno anterior, con compuerta barata (2026-09-18)

Hasta ahora cada pregunta se clasificaba sola, sin memoria: "¿y en 2010?" o
"de esos, cuáles son de mujeres" no tenían con qué resolverse — el router no
sabía que existía una pregunta anterior. Pedido explícito: que el chatbot
"pueda seguir el hilo de la conversación".

Alcance elegido (recomendación tomada, no medida): **solo la pregunta
INMEDIATAMENTE anterior**, no la conversación completa. Cubre "¿y en 2010?"
y "de esos, cuáles son de mujeres" sin que cada consulta cargue con todo el
historial ni pague más latencia de la necesaria.

Cómo funciona, en `supabase/functions/buscar/`:

1. El frontend manda `pregunta_anterior` con la pregunta del turno previo
   (`App.tsx`: `enviar()`/`reintentar()` la calculan del arreglo `turnos`
   antes de empujar el turno nuevo).
2. `texto.ts#detectaSeguimiento()` es una compuerta LOCAL, sin LLM: un patrón
   de continuadores en español ("y...", "también", "de esos", "lo mismo",
   pronombres como "esos"/"ellas"). Sin esta compuerta, reformular CADA
   pregunta de una conversación de 2+ turnos rompería la promesa de <100ms
   de catálogo (sección 4) aunque la pregunta nueva fuera independiente —
   que es el caso más común.
3. Solo si la compuerta dispara, `router.ts#reformularSeguimiento()` llama a
   Gemini (misma rotación de `MODELOS_GEMINI`) con la pregunta anterior y la
   nueva, y pide una reescritura independiente + un booleano
   `depende_del_anterior`. Si el modelo dice que no dependía, o si falla o no
   hay llave, se seguimiento con la pregunta tal cual llegó — nunca tumba la
   consulta.
4. Cuando sí siguió el hilo, la traza gana un paso explícito ("Siguió el hilo
   de la conversación · Entendió la pregunta como: «...»"): el editor ve
   exactamente qué se entendió, nunca una reinterpretación silenciosa
   (coherente con la sección 3, mejora 3 — "un editor no confía en una caja
   negra").

Una pregunta nueva e independiente (la mayoría) nunca paga esta llamada
extra: ni la compuerta ni la reformulación tocan el camino de catálogo <100ms
cuando no hay señal de continuidad.

### `temas` no es texto libre, y catálogo lo trataba como si lo fuera (2026-09-18)

Reporte real: "¿Qué ha escrito Albrecht?" devolvía "no encontré coincidencias",
aunque **Albrecht Mohrhardt Doger existe en el archivo con 8 artículos** (con
solo "albrecht" el router no arma el autor — la regla de `emparejarAutores`
exige dos piezas del nombre, sección 4, para no decidir con una sola palabra
ambigua). "Todo lo que publicó Albrecht Mohrhardt Doger" (nombre completo) sí
los encontraba los 8; solo fallaba la forma corta.

Causa real, no supuesta: `router.ts` llena `temas` con las MISMAS palabras que
ya puso en `texto` en tres sitios (`clasificarRespaldo`, `filtrosParaModoExplicito`,
y `clasificarConLlm` cuando arma `texto` a partir de `crudo.temas`) — nunca
conoce el vocabulario real de enriquecimiento, así que solo puede repetir lo
que ya extrajo de la pregunta. `buscarArticulos` (`carriles/comun.ts`) exige
`temas` (`ov` contra el arreglo de etiquetas que puso el enriquecimiento) Y
`texto` (`tsvector`) a la vez. Para "albrecht" eso pedía, a la vez: que
"albrecht" apareciera en el texto completo (sí — su nombre vive en el
`tsvector`) Y que "albrecht" fuera una etiqueta de tema del artículo (nunca lo
es: los temas son clasificaciones como "corrupción", no nombres de persona).
0 coincidencias, aunque el archivo sí tenía los 8 artículos.

Panorama no lo sufre: su `recolectar()` (`carriles/panorama.ts`) ya cae solo
al Pase B (busca en títulos/autores, sin tratar `temas` como filtro duro) si
el Pase A con enriquecimiento no encuentra nada. **Catálogo no tenía ese
pase de respaldo** y además su `aproximar()` (`carriles/comun.ts`) relajaba
`texto` y `temas` juntos como primer intento, perdiendo la palabra de
búsqueda real de una vez — por eso los "aproximados" que se veían eran los 5
artículos más recientes del archivo, sin ninguna relación con "albrecht".

Arreglo, en `carriles/catalogo.ts`: `sinTemasFantasma()` corre antes que
cualquier otra cosa en `carrilCatalogo` — dobla `temas` dentro de `texto`
(deduplicando palabras) y deja `temas` vacío, porque catálogo **nunca** tiene
una fuente real de `temas` (la UI no tiene faceta de temas, solo
Autores/Secciones/Décadas — sección 3). Con eso, `buscarArticulos` vuelve a
depender solo del `tsvector`, que sí encuentra "albrecht" en el nombre del
autor. `aproximar()` se beneficia gratis del mismo arreglo, porque recibe los
filtros ya sin el `temas` fantasma.

Pruebas de regresión en `pruebas.test.ts` (`sinTemasFantasma`, 3 casos).

### El paginador de artículos se mostraba en panorama, donde no puede funcionar (2026-09-18)

Reporte real: "no funciona la paginación de los artículos, se buguea". Medido
contra producción con la misma pregunta pidiendo `pagina: 1` y luego
`pagina: 2`:

```
pagina 1 → modo: panorama · pagina: 1 · por_pagina: 74 · total: 92
pagina 2 → modo: panorama · pagina: 1 · por_pagina: 40 · total: 92
```

`carrilPanorama` (`carriles/panorama.ts`) **siempre** devuelve `pagina: 1`:
no tiene ni puede tener un concepto real de "página 2", porque no es un
`WHERE` con `LIMIT/OFFSET` como catálogo — es "trae hasta `PANORAMA_MAX_FILAS`
coincidencias, agrúpalas con una llamada a Gemini, cita las que el modelo
eligió". Pedirle `pagina: 2` no cambia nada de esa lógica: **vuelve a correr
toda la síntesis desde cero** (una llamada nueva a Gemini, no determinista) y
regresa otro grupo de artículos citados — de ahí que `por_pagina` cambiara de
74 a 40 sin que `pagina` se moviera del 1. El editor veía el número de página
congelado en 1 mientras la lista de artículos cambiaba a algo sin relación
con lo anterior: eso es lo que se leía como "se buguea", y de paso cada clic
gastaba una llamada más a la cuota de Gemini para nada.

`ListaArticulos` (`web/src/components/BloqueRespuesta.tsx`) decidía si
mostrar el paginador solo mirando si `total > por_pagina` — cierto en
panorama casi siempre, porque `total` es el conteo real de coincidencias en
SQL y `por_pagina` es cuántas citó el modelo, casi nunca el mismo número.
Arreglo: `puedePaginar` ahora exige además `respuesta.modo === 'catalogo'` —
el único carril con `LIMIT/OFFSET` real (incluye hibrida degradada a
catálogo, que hereda esa paginación real). Catálogo directo (`Mastretta`,
`Albrecht`) se verificó en vivo, página por página, antes y después: sigue
avanzando bien. Panorama simplemente ya no ofrece un control que nunca pudo
cumplir lo que prometía.
---
## 5. Esquema
```sql
create table articulos (
  id              bigint primary key,        -- ID de WordPress, nunca generar otro
  url             text not null,
  titulo          text not null,
  autores         text[] not null default '{}',
  autor_confianza text not null default 'ausente',  -- 'wp' | 'extraido' | 'ausente'
  fecha_pub       date not null,
  anio_pub        smallint generated always as (extract(year from fecha_pub)::smallint) stored,
  numero          text,                      -- "1988 Enero"
  seccion         text,
  resumen_linea   text,                      -- habilita el modo panorama
  temas           text[] not null default '{}',
  anios_referidos smallint[] not null default '{}',
  tipo_texto      text,
  cuerpo          text,                      -- fase 2
  ts tsvector generated always as (
    to_tsvector('spanish',
      coalesce(titulo,'') || ' ' ||
      coalesce(array_to_string(autores,' '),'') || ' ' ||
      coalesce(cuerpo,''))
  ) stored
);
create index on articulos using gin (ts);
create index on articulos using gin (anios_referidos);
create index on articulos using gin (temas);
create index on articulos using gin (autores);
create index on articulos (anio_pub);
create index on articulos (fecha_pub desc);
-- Vista materializada para el sidebar. Contar 19k filas en vivo es lo que
-- congela la app hoy.
create materialized view autores_conteo as
  select unnest(autores) as autor, count(*) as n
  from articulos group by 1 order by n desc;
create unique index on autores_conteo (autor);
create table chunks (            -- fase 2
  id          bigserial primary key,
  articulo_id bigint not null references articulos(id) on delete cascade,
  orden       smallint not null,
  texto       text not null,
  embedding   halfvec(1024),     -- 4× más ligero que vector(1536)
  ts tsvector generated always as (to_tsvector('spanish', texto)) stored
);
create index on chunks using hnsw (embedding halfvec_cosine_ops);
create index on chunks using gin (ts);
create table sync_estado (
  id int primary key default 1,
  ultima_pagina int not null default 0,
  total_paginas int,
  total_sincronizados int not null default 0,
  total_remoto int,              -- X-WP-Total, para reconciliar
  actualizado_en timestamptz not null default now()
);
create table consultas (         -- bitácora: es el roadmap, no telemetría decorativa
  id bigserial primary key,
  usuario uuid references auth.users(id),
  pregunta text not null,
  modo text not null,
  n_resultados int,
  ms int,
  util boolean,                  -- pulgar arriba/abajo
  creada_en timestamptz not null default now()
);
```
Implementado en `supabase/migrations/0001_init.sql`, con RLS añadido (sección 6).

---
## 6. Seguridad — el archivo es contenido de pago de Nexos
Si el archivo se filtra, se acabó el proyecto. Esto manda sobre cualquier conveniencia.
- RLS activado en **todas** las tablas, **sin ninguna policy de SELECT** para `anon` ni `authenticated`.
- Prohibido `supabase.from('articulos')` en el frontend. Toda lectura pasa por una
  Edge Function con service role. La anon key vive en el navegador: si las tablas son
  legibles, cualquiera con las DevTools se descarga 56 años del archivo de pago.
- Ninguna clave (WordPress, OpenAI, Anthropic) en el frontend ni en git. Solo secrets del backend.
- Auth: Supabase Auth con magic link y lista blanca del dominio `@nexos.com.mx`
  validada **en el servidor**, nunca en el cliente.
- Rate limit por usuario en toda Edge Function que llame a un LLM. 30 consultas/hora.
- El texto del archivo que entra a un prompt es **dato, nunca instrucción**. Delimitarlo
  con etiquetas y declararlo en el system prompt. Nunca renderizar HTML devuelto por el modelo.
- Rotar el Application Password de WordPress al terminar la carga inicial.
### ACCESO_ANONIMO: decisión definitiva, no un parche temporal (2026-09-16)

`ACCESO_ANONIMO=true` en la Edge Function es el **modo previsto para
producción**, no algo por apagar. Decisión explícita del dueño del proyecto:
solo los administradores de Nexos van a conocer esta URL, así que la sesión
no es la puerta de acceso al archivo — es solo lo que conserva el historial
de conversaciones entre visitas (el sidebar ya lo decía: "Inicia sesión para
conservar tus conversaciones"). Sin sesión, los tres carriles (`catalogo`,
`panorama`, `hibrida`) responden igual que con sesión.

Esto revierte una versión anterior de esta sección (2026-09-08) que solo
dejaba pasar `catalogo` a los anónimos y exigía apagar la bandera antes de
cualquier despliegue público. Con el nuevo alcance, lo que hay que sostener
es otra cosa: el límite de 30 consultas/hora (sección 6, arriba) seguía
identificando al usuario por su `uuid`, y un anónimo no tiene uno.
Migración `0004_acceso_anonimo_completo.sql` agrega `consultas.ip`, y
`verificarLimite()` cuenta por IP (`x-forwarded-for`) cuando no hay sesión, en
vez de dejar sin límite a los carriles que llaman a un LLM.

Lo que la anonimidad NO cambia: sigue sin haber ninguna policy de SELECT para
`anon`/`authenticated` sobre las tablas (verificado: la anon key devuelve 0
filas contra `/rest/v1/articulos`), y toda lectura sigue pasando por esta
función con service role. Lo que se abrió fue la función, no la base.

Nota relacionada: **Google OAuth está deshabilitado** en el proyecto, así que el
botón del sidebar no puede funcionar. El login por correo sí está habilitado, y
es además lo que pide esta sección (magic link con lista blanca de dominio),
así que es el camino más corto cuando se retome — para guardar historial, no
para leer el archivo.

**Security score objetivo:** MVP 7/10, producción 8.5/10.
Baja a 3/10 si el cliente consulta las tablas directo — que es el default de estas herramientas.
---
## 7. Reglas anti-alucinación (lo más importante del producto)
Este es un archivo periodístico real. Un artículo inventado es un incidente de
credibilidad para Nexos, no un bug para el backlog.
1. **El modelo nunca escribe títulos, autores, fechas ni URLs.** Devuelve
   `articulo_id` / `chunk_id`; la aplicación arma la ficha desde la base de datos.
   Si un id no existe, se descarta la respuesta. La cita deja de ser generada y pasa
   a ser recuperada — eso elimina una clase entera de alucinación.
2. **Sin autor ⇒ `autor no consignado`**, en gris cursiva. Jamás deducirlo del estilo,
   del tema ni del año.
3. **Nunca una respuesta vacía.** Para un archivo de 56 años, un "no" seco casi siempre
   es mentira: hay algo cercano. Devolver los 5 más próximos marcados como `aproximados: true`
   y una reformulación concreta. Registrar toda consulta con cero resultados: es el mejor backlog que hay.
4. **Nunca datos de ejemplo hardcodeados.** Si la base está vacía, estado vacío honesto
   con liga a `/admin`.
5. Toda respuesta del LLM se valida contra su esquema JSON antes de renderizarse.
---
## 8. Stack
- **Frontend**: React + TypeScript + Vite + Tailwind + shadcn/ui.
- **Backend**: Supabase (Postgres + pgvector + Edge Functions en Deno).
- **Ingesta**: script de Node/TypeScript ejecutado localmente para la carga inicial;
  Edge Function + cron para el incremental.
- **LLM**: Claude Haiku para el enriquecimiento masivo y el router; Sonnet para las respuestas.
- **Iconos**: solo `lucide-react`. No instalar hugeicons ni ninguna otra librería de iconos.
- **Animación**: mínima y funcional. Respetar `prefers-reduced-motion`.
### Costes de referencia
| Concepto | Coste |
|---|---|
| Enriquecimiento LLM (19k artículos, Haiku) | ~$65 usd, una vez |
| Embeddings (~75k chunks) | ~$2 usd, una vez |
| Supabase Pro | $25 usd/mes |
| LLM por consulta (~$0.03 híbrida, ~$0.09 panorama) | ~$20 usd/mes |
El coste no es el riesgo de este proyecto.
---
## 9. Orden de trabajo
1. **Ingesta primero, sin UI.** Script de Node, esquema, carga completa de los 19,145.
   No pasar a nada más hasta que los conteos por año cuadren con la sección 1.
2. **Verificación.** Un script `npm run verificar` que compare conteos contra la API
   y falle ruidosamente si no cuadran.
3. **Enriquecimiento.** `resumen_linea`, `temas`, `anios_referidos`, `tipo_texto` con Haiku.
   Es el 5% del presupuesto que habilita el 50% del valor: sin `resumen_linea` el modo
   panorama es imposible.
4. **Edge Functions**: `buscar` con los tres carriles.
5. **Frontend**: replicar el diseño. Es lo último y lo más rápido, porque toda la
   inteligencia ya vive en el backend.
6. **Set de evaluación**: 30 preguntas reales pedidas a los editores de Nexos con su
   respuesta esperada. Es la única defensa contra "se siente que funciona".

### Estado actual (2026-09-07)
Completado: esquema (`supabase/migrations/0001_init.sql`), script de ingesta
(`scripts/ingesta.ts`) y script de verificación (`scripts/verificar.ts`) — paso 1 y 2
del orden de trabajo. **No ejecutado todavía**: este entorno de sesión no tiene salida
de red hacia `nexos.com.mx` (bloqueado por política de red del sandbox), así que la
carga inicial hay que correrla localmente o desde un entorno con acceso, como pide la
sección 2 ("preferir un script de Node ejecutado localmente"). Pendiente: crear el
proyecto de Supabase, aplicar la migración, correr `npm run ingesta` y `npm run
verificar`, y solo entonces seguir con el paso 3 (enriquecimiento).

## 10. Cómo trabajar en este repo
- Nunca marcar una tarea como terminada con los tests en rojo o la ingesta incompleta.
- Ante una decisión entre "rápido" y "verificable", elegir verificable: el fracaso de
  la versión anterior fue exactamente ese trade-off.
- Si un dato del archivo no existe, decirlo. No rellenar huecos.
- Preguntar antes de tocar cualquier cosa que escriba en `nexos.com.mx`.
