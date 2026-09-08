-- Archivo Nexos — esquema completo y IDEMPOTENTE.
--
-- Este archivo deja la base en el estado correcto sin importar en qué estado
-- esté: se puede pegar entero en el SQL Editor las veces que haga falta, y no
-- falla ni con la base vacía ni con la base ya cargada. Equivale a las
-- migraciones 0001 y 0002 juntas.
--
-- NO borra datos: todo es `if not exists` / `or replace`.
--
-- Ver CLAUDE.md sección 5 (esquema) y sección 6 (seguridad).

-- pgvector: necesaria para halfvec/hnsw en `chunks` (fase 2).
create extension if not exists vector with schema extensions;

-- Postgres marca array_to_string() como STABLE, no IMMUTABLE, y una columna
-- generada solo acepta expresiones inmutables: sin este envoltorio, la columna
-- `ts` falla con "ERROR 42P17: generation expression is not immutable".
-- (to_tsvector con regconfig explícito sí es inmutable; ese no era el problema.)
create or replace function autores_a_texto(text[])
  returns text
  language sql
  immutable
  parallel safe
as $$ select array_to_string($1, ' ') $$;

create table if not exists articulos (
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
      coalesce(autores_a_texto(autores),'') || ' ' ||
      coalesce(cuerpo,''))
  ) stored,
  constraint autor_confianza_valida check (autor_confianza in ('wp', 'extraido', 'ausente'))
);

-- Índices con nombre explícito: `if not exists` no funciona con los anónimos.
create index if not exists articulos_ts_idx              on articulos using gin (ts);
create index if not exists articulos_anios_referidos_idx on articulos using gin (anios_referidos);
create index if not exists articulos_temas_idx           on articulos using gin (temas);
create index if not exists articulos_autores_idx         on articulos using gin (autores);
create index if not exists articulos_anio_pub_idx        on articulos (anio_pub);
create index if not exists articulos_fecha_pub_idx       on articulos (fecha_pub desc);

-- Vista materializada del sidebar. Contar 19k filas en vivo es lo que congela
-- la app hoy: debe cargar en < 1s desde aquí.
create materialized view if not exists autores_conteo as
  select unnest(autores) as autor, count(*) as n
  from articulos group by 1 order by n desc;

create unique index if not exists autores_conteo_autor_idx on autores_conteo (autor);

create table if not exists chunks (            -- fase 2
  id          bigserial primary key,
  articulo_id bigint not null references articulos(id) on delete cascade,
  orden       smallint not null,
  texto       text not null,
  embedding   halfvec(1024),     -- 4x mas ligero que vector(1536)
  ts tsvector generated always as (to_tsvector('spanish', texto)) stored
);

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding halfvec_cosine_ops);
create index if not exists chunks_ts_idx        on chunks using gin (ts);

create table if not exists sync_estado (
  id                   int primary key default 1,
  ultima_pagina        int not null default 0,
  total_paginas        int,
  total_sincronizados  int not null default 0,
  total_remoto         int,              -- X-WP-Total, para reconciliar
  actualizado_en       timestamptz not null default now(),
  constraint sync_estado_singleton check (id = 1)
);

create table if not exists consultas (   -- bitácora: es el roadmap, no telemetría
  id           bigserial primary key,
  usuario      uuid references auth.users(id),
  pregunta     text not null,
  modo         text not null,
  n_resultados int,
  ms           int,
  util         boolean,          -- pulgar arriba/abajo
  creada_en    timestamptz not null default now()
);

-- La vista materializada no se refresca sola: si la ingesta corre después de
-- crearla, el sidebar carga vacío para siempre. PostgREST no puede ejecutar
-- REFRESH, así que se expone como función para que la ingesta la llame.
create or replace function refrescar_autores_conteo()
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  refresh materialized view autores_conteo;
end;
$$;

-- === Seguridad (sección 6) ===
-- RLS en todas las tablas, sin ninguna policy de SELECT para anon ni
-- authenticated. Toda lectura pasa por Edge Functions con service role, que
-- ignora RLS. Sin policies, RLS deniega todo por defecto: eso es lo que hace
-- que la llave pública contra /rest/v1/articulos devuelva 0 filas.
alter table articulos    enable row level security;
alter table chunks       enable row level security;
alter table sync_estado  enable row level security;
alter table consultas    enable row level security;

-- Las vistas materializadas no soportan RLS: hay que revocar explícitamente.
-- Supabase otorga SELECT por defecto a anon/authenticated en objetos nuevos
-- del esquema public, así que sin esto quedaría expuesta pese al RLS.
revoke all on autores_conteo from anon, authenticated;

-- Solo el service role puede refrescar: la vista lista a todos los autores.
revoke all on function refrescar_autores_conteo() from public, anon, authenticated;
grant execute on function refrescar_autores_conteo() to service_role;

insert into sync_estado (id) values (1) on conflict (id) do nothing;

-- Deja la vista poblada con lo que haya cargado ahora mismo.
refresh materialized view autores_conteo;
