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
- Los conteos por año coinciden con la API dentro de ±2. Verificados: **1988 → 246, 1994 → 283, 2006 → 307, 2016 → 568, 2024 → 463**.
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
- Las categorías con forma `"AAAA Mes"` (ej. `"1988 Enero"`, id 2854) son los **números de la revista**. Hay ~600 categorías; las demás son secciones temáticas.
- **El cuerpo del artículo está tras el paywall.** Sin autenticar, `content` y `excerpt` vienen **vacíos** y `class_list` incluye `access-restricted` / `membership-content`.
- `/wp/v2/users` → **401**. Los `coauthors` a veces son IDs numéricos que no se pueden resolver sin credenciales.
- El archivo impreso (1978 – ~2005) **no trae autor** en `coauthors`. Es un hecho conocido del archivo, no un bug que se tape inventando datos.
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
- Logo `nexos` arriba: palabra en minúsculas, blanca, semibold, `letter-spacing: -0.03em`, sobre rectángulo `#018FBD` con `border-radius: 3px`. Nunca otro logo, nunca animado.
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
