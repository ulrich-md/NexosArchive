-- Archivo Nexos — esquema inicial (fase 1: metadata; fase 2: cuerpo + vectores).
-- Ver CLAUDE.md sección 5 (esquema) y sección 6 (seguridad).

-- pgvector: necesaria para halfvec/hnsw en `chunks` (fase 2). Se habilita ya
-- para no tener que migrar de nuevo cuando llegue esa fase.
create extension if not exists vector with schema extensions;

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
  resumen_linea   text,                      -- habilita el modo panorama (fase 3)
  temas           text[] not null default '{}',
  anios_referidos smallint[] not null default '{}',
  tipo_texto      text,
  cuerpo          text,                      -- fase 2
  ts tsvector generated always as (
    to_tsvector('spanish',
      coalesce(titulo,'') || ' ' ||
      coalesce(array_to_string(autores,' '),'') || ' ' ||
      coalesce(cuerpo,''))
  ) stored,
  constraint autor_confianza_valida check (autor_confianza in ('wp', 'extraido', 'ausente'))
);

create index on articulos using gin (ts);
create index on articulos using gin (anios_referidos);
create index on articulos using gin (temas);
create index on articulos using gin (autores);
create index on articulos (anio_pub);
create index on articulos (fecha_pub desc);

-- Vista materializada para el sidebar. Contar 19k filas en vivo es lo que
-- congela la app hoy: debe cargar en < 1s desde aquí, no con un count() en vivo.
create materialized view autores_conteo as
  select unnest(autores) as autor, count(*) as n
  from articulos group by 1 order by n desc;

create unique index on autores_conteo (autor);

create table chunks (            -- fase 2
  id          bigserial primary key,
  articulo_id bigint not null references articulos(id) on delete cascade,
  orden       smallint not null,
  texto       text not null,
  embedding   halfvec(1024),     -- 4x mas ligero que vector(1536)
  ts tsvector generated always as (to_tsvector('spanish', texto)) stored
);

create index on chunks using hnsw (embedding halfvec_cosine_ops);
create index on chunks using gin (ts);

create table sync_estado (
  id                   int primary key default 1,
  ultima_pagina        int not null default 0,
  total_paginas        int,
  total_sincronizados  int not null default 0,
  total_remoto         int,              -- X-WP-Total, para reconciliar
  actualizado_en       timestamptz not null default now(),
  constraint sync_estado_singleton check (id = 1)
);

create table consultas (         -- bitácora: es el roadmap, no telemetría decorativa
  id           bigserial primary key,
  usuario      uuid references auth.users(id),
  pregunta     text not null,
  modo         text not null,
  n_resultados int,
  ms           int,
  util         boolean,          -- pulgar arriba/abajo
  creada_en    timestamptz not null default now()
);

-- === Seguridad (sección 6) ===
-- RLS activado en todas las tablas, sin ninguna policy de SELECT para anon ni
-- authenticated. Toda lectura pasa por Edge Functions con service role, que
-- ignora RLS. Sin policies, RLS deniega todo por defecto: esto es lo que hace
-- que `curl` con la anon key contra /rest/v1/articulos devuelva 0 filas.
alter table articulos enable row level security;
alter table chunks enable row level security;
alter table sync_estado enable row level security;
alter table consultas enable row level security;

-- Las vistas materializadas no soportan RLS: hay que revocar el acceso
-- explícitamente. Supabase otorga SELECT por defecto a anon/authenticated
-- en objetos nuevos del esquema public, así que sin este revoke quedaría
-- expuesta pese al RLS de la tabla base.
revoke all on autores_conteo from anon, authenticated;

insert into sync_estado (id) values (1) on conflict (id) do nothing;
