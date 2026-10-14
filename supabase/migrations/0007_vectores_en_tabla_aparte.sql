-- Los vectores se mudan a su propia tabla (corrige la 0006).
--
-- Medido en producción (2026-10-14, primera carga por GitHub Actions): el
-- primer lote de 100 vectores se guardó, el segundo murió con "canceling
-- statement due to statement timeout". Guardar el vector como columna de
-- `articulos` reescribe la fila COMPLETA, y con ella sus índices GIN — el de
-- `ts` es enorme porque indexa el cuerpo de los subdominios. Cada lote acaba
-- vaciando la lista pendiente del GIN y rebasa los ~8 s que PostgREST le da a
-- una sentencia. En una tabla aparte, guardar un vector solo toca su índice.
--
-- Idempotente: se puede correr completa las veces que sea, con o sin la 0006.

create table if not exists articulos_vectores (
  id         bigint primary key references articulos(id) on delete cascade,
  embedding  extensions.halfvec(768) not null,
  creado_en  timestamptz not null default now()
);

comment on table articulos_vectores is
  'Un vector por artículo (gemini-embedding-001, 768) de título + autores + sección + temas + '
  'resumen_linea. Sin fila = pendiente: lo llena `npm run embeber`. Se borra solo si cambia el texto.';

-- Mismas reglas que el resto del archivo (CLAUDE.md sección 6): RLS sin
-- ninguna policy, solo service role.
alter table articulos_vectores enable row level security;
revoke all on articulos_vectores from anon, authenticated;

create index if not exists articulos_vectores_hnsw
  on articulos_vectores using hnsw (embedding extensions.halfvec_cosine_ops);

-- Lo que ya se hubiera guardado con la 0006 no se pierde.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'articulos' and column_name = 'embedding'
  ) then
    execute $q$
      insert into articulos_vectores (id, embedding, creado_en)
      select id, embedding, coalesce(embedding_en, now())
        from articulos
       where embedding is not null
      on conflict (id) do nothing
    $q$;
  end if;
end;
$$;

-- Fuera lo de la 0006 que vivía en `articulos`.
drop trigger if exists articulos_invalidar_embedding on articulos;
drop function if exists articulos_invalidar_embedding();
drop index if exists articulos_embedding_idx;
alter table articulos drop column if exists embedding;
alter table articulos drop column if exists embedding_en;

-- Si cambia el texto del que salió el vector, el vector se borra y la
-- siguiente corrida de `npm run embeber` lo rehace.
create or replace function articulos_invalidar_vector()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if new.titulo is distinct from old.titulo
     or new.resumen_linea is distinct from old.resumen_linea
     or new.temas is distinct from old.temas
     or new.autores is distinct from old.autores
     or new.seccion is distinct from old.seccion then
    delete from articulos_vectores where id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists articulos_invalidar_vector on articulos;
create trigger articulos_invalidar_vector
  after update of titulo, resumen_linea, temas, autores, seccion on articulos
  for each row execute function articulos_invalidar_vector();

-- --- Lo que usa `npm run embeber` ------------------------------------------

create or replace function contar_sin_vector()
  returns bigint
  language sql
  stable
  security definer
  set search_path = public
as $$
  select count(*) from articulos a
   where not exists (select 1 from articulos_vectores v where v.id = a.id);
$$;

create or replace function articulos_sin_vector(p_despues bigint, p_limite integer)
  returns table (
    id            bigint,
    titulo        text,
    autores       text[],
    seccion       text,
    temas         text[],
    resumen_linea text
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  select a.id, a.titulo, a.autores, a.seccion, a.temas, a.resumen_linea
    from articulos a
   where a.id > p_despues
     and not exists (select 1 from articulos_vectores v where v.id = a.id)
   order by a.id
   limit p_limite;
$$;

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
  select f.id, f.v::halfvec(768), now()
    from jsonb_to_recordset(p_filas) as f(id bigint, v text)
    join articulos a on a.id = f.id
  on conflict (id) do update
    set embedding = excluded.embedding,
        creado_en = excluded.creado_en;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- --- La búsqueda: misma firma y misma lógica que la 0006 ------------------
-- Solo cambia de dónde sale el vector. Ver la 0006 para el porqué de cada
-- decisión (RRF, filtros antes del ranking, distancia como filtro de todo
-- candidato por el choque "comida"/"cómo" del stemmer).
create or replace function buscar_articulos_hibrido(
  p_texto           text     default null,
  p_embedding       extensions.halfvec default null,
  p_autores         text[]   default null,
  p_anio_desde      integer  default null,
  p_anio_hasta      integer  default null,
  p_anios_referidos smallint[] default null,
  p_limite          integer  default 40,
  p_distancia_max   real     default 0.5
)
  returns table (
    id           bigint,
    puntaje      double precision,
    rango_vector integer,
    rango_texto  integer,
    distancia    real
  )
  language plpgsql
  stable
  security definer
  set search_path = public, extensions
as $$
declare
  v_q        tsquery;
  v_t        tsquery;
  v_pal      text;
  v_filtrado boolean;
  v_k        integer := greatest(p_limite, 1) * 3;
begin
  if p_texto is not null and btrim(p_texto) <> '' then
    foreach v_pal in array regexp_split_to_array(btrim(p_texto), '\s+') loop
      v_t := plainto_tsquery('spanish', v_pal);
      if numnode(v_t) > 0 then
        v_q := case when v_q is null then v_t else v_q || v_t end;
      end if;
    end loop;
  end if;

  v_filtrado := coalesce(cardinality(p_autores), 0) > 0
             or p_anio_desde is not null
             or p_anio_hasta is not null
             or coalesce(cardinality(p_anios_referidos), 0) > 0;

  perform set_config('hnsw.ef_search', greatest(v_k, 40)::text, true);

  return query
  with
  base as materialized (
    select a.id, v.embedding, a.ts
      from articulos a
      left join articulos_vectores v on v.id = a.id
     where v_filtrado
       and (coalesce(cardinality(p_autores), 0) = 0 or a.autores && p_autores)
       and (p_anio_desde is null or a.anio_pub >= p_anio_desde)
       and (p_anio_hasta is null or a.anio_pub <= p_anio_hasta)
       and (coalesce(cardinality(p_anios_referidos), 0) = 0
            or a.anios_referidos && p_anios_referidos)
  ),
  vec as (
    select x.id, x.d,
           row_number() over (order by x.d)::integer as r
      from (
        -- Con filtro: exacto sobre el subconjunto.
        (select b.id, (b.embedding <=> p_embedding)::real as d
           from base b
          where v_filtrado and p_embedding is not null and b.embedding is not null
          order by b.embedding <=> p_embedding
          limit v_k)
        union all
        -- Sin filtro: índice HNSW de articulos_vectores.
        (select vv.id, (vv.embedding <=> p_embedding)::real as d
           from articulos_vectores vv
          where not v_filtrado and p_embedding is not null
          order by vv.embedding <=> p_embedding
          limit v_k)
      ) x
  ),
  txt as (
    select y.id, y.d,
           row_number() over (order by y.rk desc, y.id desc)::integer as r
      from (
        (select b.id, ts_rank_cd(b.ts, v_q) as rk,
                case when p_embedding is not null then (b.embedding <=> p_embedding)::real end as d
           from base b
          where v_filtrado and v_q is not null and b.ts @@ v_q
          order by ts_rank_cd(b.ts, v_q) desc
          limit v_k)
        union all
        (select a.id, ts_rank_cd(a.ts, v_q) as rk,
                case when p_embedding is not null then
                  (select (vv.embedding <=> p_embedding)::real from articulos_vectores vv where vv.id = a.id)
                end as d
           from articulos a
          where not v_filtrado and v_q is not null and a.ts @@ v_q
          order by ts_rank_cd(a.ts, v_q) desc
          limit v_k)
      ) y
  ),
  fusion as (
    select coalesce(v.id, t.id) as id,
           coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + t.r), 0) as puntaje,
           v.r as rango_vector,
           t.r as rango_texto,
           coalesce(v.d, t.d) as distancia
      from vec v
      full outer join txt t on t.id = v.id
  )
  select f.id, f.puntaje::double precision, f.rango_vector, f.rango_texto, f.distancia
    from fusion f
   where f.distancia is null  -- sin vector de la pregunta, o artículo aún sin vector
      or f.distancia <= case when f.rango_texto is not null then p_distancia_max * 1.3
                             else p_distancia_max end
   order by f.puntaje desc, f.id desc
   limit p_limite;
end;
$$;

revoke all on function contar_sin_vector() from public, anon, authenticated;
revoke all on function articulos_sin_vector(bigint, integer) from public, anon, authenticated;
revoke all on function guardar_embeddings(jsonb) from public, anon, authenticated;
revoke all on function buscar_articulos_hibrido(text, extensions.halfvec, text[], integer, integer, smallint[], integer, real)
  from public, anon, authenticated;
grant execute on function contar_sin_vector() to service_role;
grant execute on function articulos_sin_vector(bigint, integer) to service_role;
grant execute on function guardar_embeddings(jsonb) to service_role;
grant execute on function buscar_articulos_hibrido(text, extensions.halfvec, text[], integer, integer, smallint[], integer, real)
  to service_role;
