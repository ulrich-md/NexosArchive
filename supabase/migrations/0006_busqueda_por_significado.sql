-- Búsqueda por significado, a nivel de artículo (CLAUDE.md sección 4, carril
-- `hibrida`).
--
-- Por qué existe: "¿Qué ha escrito Ángeles Mastretta sobre comida?" devolvía
-- artículos sin relación o nada. La búsqueda de texto (`ts`) exige la palabra
-- literal "comida", y Mastretta escribe de "cocina", "mole", "chiles en
-- nogada", "la mesa". Con 0 coincidencias, `aproximar()` quitaba el tema y
-- enseñaba sus 5 artículos más recientes.
--
-- El carril `hibrida` original dependía de la fase 2 (cuerpo + chunks), que
-- nunca existió. Pero el enriquecimiento YA dejó en cada artículo lo que hace
-- falta para entender de qué trata: título, `resumen_linea` y `temas`. Un
-- vector por artículo sobre eso cubre el caso sin almacenar el cuerpo (que por
-- decisión del dueño no vive en esta base, migración 0003) y sin chunks.
--
-- Un vector no es texto legible: si la base se filtrara, esto no reconstruye
-- ningún artículo.

-- gemini-embedding-001 con outputDimensionality=768 (Matryoshka). halfvec la
-- deja en 1.5 KB por fila: ~50 MB para los ~33k artículos.
alter table articulos add column if not exists embedding extensions.halfvec(768);
alter table articulos add column if not exists embedding_en timestamptz;

comment on column articulos.embedding is
  'Vector de título + autores + sección + temas + resumen_linea (gemini-embedding-001, 768). '
  'NULL = pendiente: lo llena `npm run embeber`, y se vacía solo si cambia el texto del que salió.';

-- Solo se usa en consultas SIN filtros duros. Con filtro (autor, años) la
-- función de abajo calcula la distancia exacta sobre el subconjunto, porque un
-- índice HNSW con WHERE filtra DESPUÉS de elegir vecinos y pierde resultados.
create index if not exists articulos_embedding_idx
  on articulos using hnsw (embedding extensions.halfvec_cosine_ops);

-- Si cambia el texto del que salió el vector, el vector ya no lo representa:
-- se vacía y `npm run embeber` lo rehace. Así un re-enriquecimiento nunca deja
-- vectores viejos sin que nadie se entere.
create or replace function articulos_invalidar_embedding()
  returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if new.titulo is distinct from old.titulo
     or new.resumen_linea is distinct from old.resumen_linea
     or new.temas is distinct from old.temas
     or new.autores is distinct from old.autores
     or new.seccion is distinct from old.seccion then
    new.embedding := null;
    new.embedding_en := null;
  end if;
  return new;
end;
$$;

drop trigger if exists articulos_invalidar_embedding on articulos;
create trigger articulos_invalidar_embedding
  before update of titulo, resumen_linea, temas, autores, seccion on articulos
  for each row execute function articulos_invalidar_embedding();

-- Guarda vectores por lotes: un solo viaje para 100 artículos.
-- `v` llega como texto '[0.1,0.2,...]', que es la entrada nativa de halfvec.
create or replace function guardar_embeddings(p_filas jsonb)
  returns integer
  language plpgsql
  security definer
  set search_path = public, extensions
as $$
declare
  n integer := 0;
begin
  update articulos a
     set embedding = f.v::halfvec(768),
         embedding_en = now()
    from jsonb_to_recordset(p_filas) as f(id bigint, v text)
   where a.id = f.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- La búsqueda. Una sola consulta, dos rankings fusionados con Reciprocal Rank
-- Fusion (no suma ponderada a mano), y los filtros duros ANTES del ranking:
--
--   1. Vector: distancia coseno contra `p_embedding`. Si hay filtro duro, sobre
--      el subconjunto filtrado (exacto, ~600 filas para un autor); si no, con
--      el índice HNSW.
--   2. Texto: `ts` contra un OR de las palabras de `p_texto`. OR y no AND: el
--      ranking ya premia a quien trae más palabras, y un AND devolvía 0.
--
-- Un artículo que solo llega por el vector tiene que estar a menos de
-- `p_distancia_max`: el vector SIEMPRE devuelve vecinos, aunque ninguno trate
-- el tema, y esos son justo los "artículos sin relación" de las quejas.
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

  -- ef_search por defecto es 40: con menos candidatos que el límite pedido,
  -- el HNSW se quedaría corto.
  perform set_config('hnsw.ef_search', greatest(v_k, 40)::text, true);

  return query
  with
  base as materialized (
    select a.id, a.embedding, a.ts
      from articulos a
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
        -- Sin filtro: índice HNSW.
        (select a.id, (a.embedding <=> p_embedding)::real as d
           from articulos a
          where not v_filtrado and p_embedding is not null and a.embedding is not null
          order by a.embedding <=> p_embedding
          limit v_k)
      ) x
  ),
  txt as (
    select y.id,
           row_number() over (order by y.rk desc, y.id desc)::integer as r
      from (
        (select b.id, ts_rank_cd(b.ts, v_q) as rk
           from base b
          where v_filtrado and v_q is not null and b.ts @@ v_q
          order by ts_rank_cd(b.ts, v_q) desc
          limit v_k)
        union all
        (select a.id, ts_rank_cd(a.ts, v_q) as rk
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
           v.d as distancia
      from vec v
      full outer join txt t on t.id = v.id
  )
  select f.id, f.puntaje::double precision, f.rango_vector, f.rango_texto, f.distancia
    from fusion f
   -- Lo que llega solo por el vector tiene que estar cerca de verdad.
   where f.rango_texto is not null or f.distancia <= p_distancia_max
   order by f.puntaje desc, f.id desc
   limit p_limite;
end;
$$;

revoke all on function guardar_embeddings(jsonb) from public, anon, authenticated;
grant execute on function guardar_embeddings(jsonb) to service_role;

revoke all on function buscar_articulos_hibrido(text, extensions.halfvec, text[], integer, integer, smallint[], integer, real)
  from public, anon, authenticated;
grant execute on function buscar_articulos_hibrido(text, extensions.halfvec, text[], integer, integer, smallint[], integer, real)
  to service_role;
