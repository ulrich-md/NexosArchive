-- Los vectores pasan de Gemini (768) a Voyage AI (`voyage-4`, 1024).
--
-- Por qué (2026-10-27): el cupo gratuito de Gemini es de 1,000 textos al día y
-- lo comparten la carga y las preguntas en vivo; a 850 diarios faltaban ~3½
-- semanas para cubrir el archivo. Voyage da 200M tokens gratis por cuenta (el
-- archivo entero son ~5M) y, con método de pago registrado, 8M tokens por
-- minuto: la carga completa es una corrida de minutos.
--
-- Vectores de modelos distintos no se pueden comparar: el de la pregunta y el
-- de cada artículo tienen que salir del mismo. Por eso esto NO se aplica sola
-- en cada despliegue: se aplica una vez, junto con el secreto VOYAGE_API_KEY,
-- y la función y `npm run embeber` cambian de proveedor al ver esa llave.
--
-- Los de Gemini no se borran: la tabla se renombra a
-- `articulos_vectores_gemini` (con su índice). Para volver atrás: borrar la
-- nueva, renombrar la vieja a `articulos_vectores`, restaurar
-- `guardar_embeddings` con halfvec(768) y quitar el secreto VOYAGE_API_KEY.
--
-- Todo lo demás (`buscar_articulos_hibrido`, `contar_sin_vector`,
-- `articulos_sin_vector`, el trigger que invalida vectores) busca la tabla
-- por nombre al ejecutarse, así que pasa a usar la nueva sin cambios.
--
-- Idempotente: si ya se aplicó, no hace nada.

do $$
begin
  if exists (
    select 1
      from pg_attribute att
      join pg_class c on c.oid = att.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'articulos_vectores'
       and att.attname = 'embedding' and att.atttypmod = 768
  ) and not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'articulos_vectores_gemini'
  ) then
    alter table articulos_vectores rename to articulos_vectores_gemini;
    alter index if exists articulos_vectores_hnsw rename to articulos_vectores_gemini_hnsw;
    alter index if exists articulos_vectores_pkey rename to articulos_vectores_gemini_pkey;
  end if;
end;
$$;

create table if not exists articulos_vectores (
  id         bigint primary key references articulos(id) on delete cascade,
  embedding  extensions.halfvec(1024) not null,
  creado_en  timestamptz not null default now()
);

comment on table articulos_vectores is
  'Un vector por artículo (Voyage voyage-4, 1024) de título + autores + sección + temas + '
  'resumen_linea. Sin fila = pendiente: lo llena `npm run embeber`. Se borra solo si cambia el texto.';

alter table articulos_vectores enable row level security;
revoke all on articulos_vectores from anon, authenticated;

create index if not exists articulos_vectores_hnsw
  on articulos_vectores using hnsw (embedding extensions.halfvec_cosine_ops);

create or replace function guardar_embeddings(p_filas jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
declare
  n integer := 0;
begin
  insert into articulos_vectores (id, embedding, creado_en)
  select f.id, f.v::halfvec(1024), now()
    from jsonb_to_recordset(p_filas) as f(id bigint, v text)
    join articulos a on a.id = f.id
  on conflict (id) do update
    set embedding = excluded.embedding,
        creado_en = excluded.creado_en;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function guardar_embeddings(jsonb) from public, anon, authenticated;
grant execute on function guardar_embeddings(jsonb) to service_role;
