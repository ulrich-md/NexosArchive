# Archivo Nexos

Buscador conversacional interno sobre el archivo completo de la revista Nexos (1978–2026).
Ver `CLAUDE.md` para el spec completo del producto, el esquema, el diseño y las reglas
anti-alucinación.

## Estado

Fase 1 en construcción (orden de trabajo, sección 9 de `CLAUDE.md`):

- [x] Esquema de base de datos aplicado (`supabase/migrations/0001_init.sql`)
- [x] Mapa de autores (`scripts/autores.ts`)
- [x] Script de ingesta de metadata (`scripts/ingesta.ts`)
- [x] Script de verificación (`scripts/verificar.ts`)
- [ ] Carga inicial ejecutada y verificada contra la API
- [ ] Enriquecimiento (Haiku), Edge Functions, frontend

## Requisitos

- Node.js 20+
- Un proyecto de [Supabase](https://supabase.com) (Postgres 15+, extensión `vector` para
  la fase 2)

## Puesta en marcha

1. Instala dependencias:

   ```bash
   npm install
   ```

2. Crea un proyecto en Supabase y aplica la migración `supabase/migrations/0001_init.sql`
   (con el SQL Editor del dashboard, o con la CLI de Supabase: `supabase db push` después
   de enlazar el proyecto).

3. Copia `.env.example` a `.env` y completa `SUPABASE_URL` y
   `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API en el dashboard de Supabase).
   **Nunca** el `anon key` en este archivo — el service role es solo para scripts
   locales y Edge Functions.

4. Construye el mapa de autores (tarda ~17 minutos, son ~3,450 autores a 300ms):

   ```bash
   npm run autores
   ```

   La API devuelve los autores en forma slug y sin acentos (`carlos-monsivais`);
   el nombre real solo está en la página pública del autor. Este script lo
   recupera de ahí y lo cachea en `datos/autores.json`. Es reanudable, y la
   ingesta lo exige: sin él, `coauthors` son IDs numéricos y ningún artículo
   tendría autor.

5. Corre la ingesta (tarda ~15 minutos, son ~192 páginas a 300ms entre requests):

   ```bash
   npm run ingesta
   ```

   Es reanudable: si se corta a la mitad, córrela de nuevo y sigue desde
   `sync_estado.ultima_pagina`. Al final imprime una reconciliación contra
   `X-WP-Total`. Las fechas anteriores a 1978 se excluyen de `articulos` y quedan
   registradas en `logs/fechas-sospechosas.jsonl` para revisión manual.

6. Verifica que la ingesta cuadra con la API:

   ```bash
   npm run verificar
   ```

   Compara el total y los conteos por año contra la API en vivo, revisa que no queden
   entidades HTML sin decodificar en los títulos y que no haya fechas anteriores a 1978.
   Sale con código distinto de cero si algo no cuadra.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run autores` | Construye `datos/autores.json` (id de coautor → nombre real con acentos) |
| `npm run ingesta` | Carga/actualiza metadata de los 19,145 artículos desde WordPress |
| `npm run verificar` | Compara la base local contra la API y falla si no cuadra |
| `npm run typecheck` | `tsc --noEmit` sobre `scripts/` |

Los tres primeros pegan a `nexos.com.mx`, así que necesitan salida de red hacia ese
dominio. Ojo con una trampa: el `fetch` de Node no lee `HTTPS_PROXY` (curl sí), por
lo que detrás de un proxy obligatorio todo falla con 403 sin explicación.
`scripts/lib/red.ts` lo resuelve y no estorba cuando no hay proxy.
